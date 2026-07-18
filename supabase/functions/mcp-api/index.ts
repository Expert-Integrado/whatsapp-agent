// mcp-api — Gateway de API pro MCP whatsapp-agent (principio do menor privilegio).
//
// O MCP NAO acessa o banco direto: fala SO com esta edge, que expoe operacoes de
// alto nivel e usa SERVICE_ROLE_KEY INTERNAMENTE. Auth: header `x-mcp-key` vs
// secret MCP_API_KEY (comparacao de tempo constante). Deploy com --no-verify-jwt.
//
// Roteado por { action, params }. Acoes portadas do mcp/index.js mantendo paridade.
// FASE: ping, status, list_categories, read (core: resolveChat + helpers).
// Proximas: inbox, search, categorize/uncategorize/annotate, download_attachment,
// check_message, sync_groups, transcribe, send*.

import { createClient } from "npm:@supabase/supabase-js@2";
import { normalizePhoneBR, expandChatIdCandidates, pickPhoneChat } from "../_shared/wa/phone.ts";
import { evaluateVoiceGate, type VoiceGateMode, type VoiceViolation } from "../_shared/wa/voice-gate.ts";
import { ZAPI_SEND_ACTIONS, zapiGateTexts, scheduleGateTexts, defaultGateInstance } from "../_shared/wa/gate-inputs.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const supabase = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const MCP_API_KEY = Deno.env.get("MCP_API_KEY") ?? "";
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";

const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// JWT legado (passa no verify_jwt das edges de envio). A SUPABASE_SERVICE_ROLE_KEY
// auto-injetada pode estar em formato novo (nao-JWT) e ser rejeitada pelo gateway.
const INTERNAL_JWT = Deno.env.get("INTERNAL_EDGE_JWT") || SERVICE_KEY;
// Chamada interna edge->edge pras edges de envio existentes (send-message/voice/wa-proxy).
async function callEdge(name: string, body: unknown): Promise<{ status: number; data: any }> {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${INTERNAL_JWT}`, "apikey": INTERNAL_JWT, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data: any; const t = await r.text();
  try { data = JSON.parse(t); } catch { data = { raw: t }; }
  return { status: r.status, data };
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-mcp-key, mcp-protocol-version, mcp-session-id",
  "Access-Control-Expose-Headers": "WWW-Authenticate",
};

// ─── OAuth 2.1 (esta edge e o proprio Authorization Server) ───────────────────
// Auth dupla: (1) x-mcp-key/Bearer == MCP_API_KEY (Claude Code, sem fluxo OAuth);
// (2) Bearer = access_token JWT emitido por nos (Claude Desktop/Web via Connectors).
//
// Single-tenant: a mcp-api e AS + Resource Server. O fluxo Authorization Code roda
// SEM tela de consent — o /authorize AUTO-APROVA (302 com code), porque o Supabase
// bloqueia HTML no dominio (nao da pra hospedar consent). A seguranca vem do
// confidential client: o /token exige client_secret (OAUTH_CLIENT_*), que o dono
// configura nas "Advanced settings" do connector. code e access_token sao JWT
// HS256 assinados com a MCP_API_KEY — stateless, sem tabela.
const RESOURCE_URL = `${SUPABASE_URL}/functions/v1/mcp-api`;
const PRM_URL = `${RESOURCE_URL}/.well-known/oauth-protected-resource`;
const OAUTH_CLIENT_ID = Deno.env.get("OAUTH_CLIENT_ID") ?? "";
const OAUTH_CLIENT_SECRET = Deno.env.get("OAUTH_CLIENT_SECRET") ?? "";

// ─── JWT HS256 (chave = MCP_API_KEY) + PKCE S256, via Web Crypto ──────────────
const enc = new TextEncoder();
function b64url(bytes: Uint8Array): string {
  let s = ""; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlStr(s: string): string { return b64url(enc.encode(s)); }
function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function hmacKey(secret: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function jwtSign(payload: Record<string, unknown>, secret: string): Promise<string> {
  const data = `${b64urlStr(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64urlStr(JSON.stringify(payload))}`;
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(data)));
  return `${data}.${b64url(sig)}`;
}
async function jwtVerify(token: string, secret: string): Promise<Record<string, any> | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), b64urlToBytes(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`));
  if (!ok) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
    if (p.exp && Date.now() / 1000 > p.exp) return null;
    return p;
  } catch { return null; }
}
async function sha256b64url(s: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s))));
}
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ─── Instancias (cache) ───────────────────────────────────────────────────────
let _instCache: any[] | null = null;
async function loadInstances() {
  if (_instCache) return _instCache;
  const { data } = await supabase.from("wa_instance").select("instance_id, alias, phone_connected, is_default, is_active, provider, voice_gate");
  _instCache = data || [];
  return _instCache;
}
async function resolveInstanceKey(key: string | null | undefined): Promise<string | null> {
  if (!key) return null;
  const rows = await loadInstances();
  return rows.find((r: any) => r.alias === key || r.instance_id === key)?.instance_id ?? null;
}

// ─── Contact profile cache (recado + perfil business) ─────────────────────────
// Refresh lazy no read com TTL: recado ('about') e perfil business do contato
// vem do wa-proxy (get-contact-info / get-business-profile) e ficam em chats
// (0042). O inbox le so o cache — nunca chama provider por linha. Best-effort:
// provider fora nao bloqueia o read e nao grava profile_refreshed_at (retenta
// no proximo read).
const PROFILE_TTL_MS = 7 * 86400000;
async function refreshContactProfile(chatId: string, instanceId: string | null, meta: any):
  Promise<{ contact_about: string | null; business_profile: any } | null> {
  if (!meta || meta.is_group) return null;
  if (meta.profile_refreshed_at && Date.now() - new Date(meta.profile_refreshed_at).getTime() < PROFILE_TTL_MS) return null;
  const phone = String(meta.phone || chatId);
  if (!/^\d{8,15}$/.test(phone)) return null; // lid/broadcast/status nao tem perfil
  const call = async (action: string) => {
    try {
      const { data } = await callEdge("wa-proxy", {
        action, params: { phone }, agent_name: "mcp-api-profile-refresh",
        ...(instanceId && { instance: instanceId }),
      });
      return data?.ok ? data.result : null;
    } catch { return null; }
  };
  const [info, biz] = await Promise.all([call("get-contact-info"), call("get-business-profile")]);
  if (info === null && biz === null) return null;
  const about = typeof info?.about === "string" && info.about.trim() ? info.about.trim() : null;
  // Aproveita o round-trip pra curar chat_name lixo (LID cru / numero puro):
  // o get-contact-info devolve o nome real (name/vname/short) do contato.
  const isJunkName = (n: unknown) => !n || /@lid$/.test(String(n)) || /^[0-9]+$/.test(String(n));
  const provName = [info?.name, info?.vname, info?.short]
    .find((x: any) => typeof x === "string" && x.trim() && !isJunkName(x.trim()));
  const nameFix = isJunkName(meta.chat_name) && provName ? { chat_name: String(provName).trim() } : {};
  const hasBiz = biz && typeof biz === "object" &&
    (biz.description || biz.email || biz.address || biz.websites?.length || biz.categories?.length);
  const business_profile = hasBiz ? {
    description: biz.description ?? null,
    email: biz.email ?? null,
    address: biz.address ?? null,
    websites: biz.websites ?? [],
    categories: (biz.categories ?? []).map((c: any) => c?.displayName ?? c),
  } : null;
  let upd = supabase.from("chats")
    .update({ contact_about: about, business_profile, profile_refreshed_at: new Date().toISOString(), ...nameFix })
    .eq("chat_id", chatId);
  if (instanceId) upd = upd.eq("instance_id", instanceId);
  await upd;
  return { contact_about: about, business_profile };
}

// ─── BRT helpers ──────────────────────────────────────────────────────────────
function toBRT(iso: string | null): string | null {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    const brt = new Date(d.getTime() - 3 * 60 * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${brt.getUTCFullYear()}-${pad(brt.getUTCMonth() + 1)}-${pad(brt.getUTCDate())} ${pad(brt.getUTCHours())}:${pad(brt.getUTCMinutes())}:${pad(brt.getUTCSeconds())} BRT`;
  } catch { return null; }
}
function withBRT(messages: any[]) {
  return (messages || []).map(m => ({
    ...m,
    ...(m.message_ts ? { message_ts_brt: toBRT(m.message_ts) } : {}),
    ...(m.created_at ? { created_at_brt: toBRT(m.created_at) } : {}),
  }));
}

// ─── Scoring (paridade com mcp/index.js) ──────────────────────────────────────
const SCORE_EXACT = 100, SCORE_STARTS_WITH = 80, SCORE_WORD = 70, SCORE_SUBSTRING = 50, SCORE_FUZZY = 25;
const BOOST_NOT_GROUP = 4, BOOST_NOT_LID = 3, BOOST_RECENT_7D = 4, BOOST_RECENT_30D = 2;
const FUZZY_THRESHOLD_RATIO = 0.25;
const MIN_CONFIDENT_SCORE = 80, MIN_WINNING_GAP = 15;
const AUDIO_TYPES = new Set(["audio", "voice", "ptt"]);

function normalize(str: string): string {
  return (str || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}
// normalizePhoneBR / expandChatIdCandidates / pickPhoneChat vivem em
// ../_shared/wa/phone.ts (extraidos pra teste unitario — auditoria 07/2026).
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  return dp[m][n];
}
function fuzzyMatch(input: string, name: string): boolean {
  const inputParts = input.split(/\s+/).filter(Boolean);
  const nameParts = name.split(/\s+/).filter(Boolean);
  if (!nameParts.length) return false;
  return inputParts.every((ip) => {
    const threshold = Math.max(1, Math.floor(ip.length * FUZZY_THRESHOLD_RATIO));
    return nameParts.some((np) => levenshtein(ip, np) <= threshold);
  });
}
function scoreNameMatch(input: string, chat: any): { score: number; kind: string } {
  const name = normalize(chat.chat_name || "");
  const contact = normalize(chat.contact_name || "");
  if (!name && !contact) return { score: 0, kind: "miss" };
  if (name === input || contact === input) return { score: SCORE_EXACT, kind: "exact" };
  if (name.startsWith(input) || contact.startsWith(input)) return { score: SCORE_STARTS_WITH, kind: "starts" };
  const allWords = (name + " " + contact).split(/\s+/).filter(Boolean);
  if (allWords.includes(input)) return { score: SCORE_WORD, kind: "word" };
  if (name.includes(input) || contact.includes(input)) return { score: SCORE_SUBSTRING, kind: "substring" };
  if (fuzzyMatch(input, name) || fuzzyMatch(input, contact)) return { score: SCORE_FUZZY, kind: "fuzzy" };
  return { score: 0, kind: "miss" };
}
function applyChatBoost(score: number, chat: any): number {
  let boost = 0;
  if (!chat.is_group) boost += BOOST_NOT_GROUP;
  if (chat.chat_id && !String(chat.chat_id).includes("@lid")) boost += BOOST_NOT_LID;
  if (chat.last_message_at) {
    const days = (Date.now() - new Date(chat.last_message_at).getTime()) / 86400000;
    if (days < 7) boost += BOOST_RECENT_7D; else if (days < 30) boost += BOOST_RECENT_30D;
  }
  return score + boost;
}

// ─── Transcricao (paridade com mcp/index.js) ──────────────────────────────────
const MIME_BY_EXT: Record<string, string> = {
  ogg: "audio/ogg", oga: "audio/ogg", mp3: "audio/mpeg", mpeg: "audio/mpeg",
  mp4: "audio/mp4", m4a: "audio/mp4", wav: "audio/wav", webm: "audio/webm", opus: "audio/ogg; codecs=opus",
};
async function transcribeAudio(mediaUrl: string, mimeHint?: string): Promise<string> {
  if (!OPENAI_API_KEY) return "Transcricao indisponivel: OPENAI_API_KEY nao configurada";
  try {
    const dh: Record<string, string> = {};
    if (mediaUrl.includes(".supabase.co/storage")) dh["Authorization"] = `Bearer ${INTERNAL_JWT}`;
    const audioRes = await fetch(mediaUrl, { headers: dh });
    if (!audioRes.ok) return `Erro ao transcrever: download falhou (HTTP ${audioRes.status})`;
    const audioBuffer = await audioRes.arrayBuffer();
    if (!audioBuffer.byteLength) return "Erro ao transcrever: arquivo de audio vazio";
    const baseMime = mimeHint ? mimeHint.split(";")[0].trim() : null;
    const ext = (mediaUrl.match(/\.(ogg|oga|mp3|mp4|m4a|wav|webm|mpeg|opus)(\?|$)/i)?.[1] || "ogg").toLowerCase();
    const mimeType = baseMime || MIME_BY_EXT[ext] || "audio/ogg";
    const formData = new FormData();
    formData.append("file", new Blob([audioBuffer], { type: mimeType }), `audio.${ext}`);
    formData.append("model", "whisper-1");
    formData.append("language", "pt");
    formData.append("response_format", "text");
    const wr = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }, body: formData });
    if (!wr.ok) return `Erro ao transcrever: OpenAI ${wr.status} — ${(await wr.text()).slice(0, 120)}`;
    return (await wr.text()).trim() || "(audio sem fala detectada)";
  } catch (e) { return `Erro ao transcrever: ${(e as Error).message}`; }
}
async function enrichWithTranscriptions(messages: any[]): Promise<any[]> {
  const audioMessages = messages.filter(m => AUDIO_TYPES.has(m.message_type));
  if (!audioMessages.length) return messages;
  const cacheMisses = audioMessages.filter(m => !m.content || (typeof m.content === "string" && m.content.startsWith("http")));
  const mediaById: Record<string, any> = {};
  const missIds = cacheMisses.map(m => m.id).filter(Boolean);
  if (missIds.length) {
    const { data: mediaRows } = await supabase.from("message_media")
      .select("message_id,original_url,storage_bucket,storage_path,mime_type,download_status").in("message_id", missIds);
    for (const row of mediaRows || []) {
      if (row.download_status !== "done") continue;
      const storageUrl = row.storage_path && row.storage_bucket ? `${SUPABASE_URL}/storage/v1/object/${row.storage_bucket}/${row.storage_path}` : null;
      mediaById[row.message_id] = { url: storageUrl || row.original_url, mimeType: row.mime_type };
    }
  }
  const newT = await Promise.all(cacheMisses.map(async m => {
    const media = mediaById[m.id]; const mediaUrl = media?.url;
    if (!mediaUrl) return { id: m.id, transcription: "Erro ao transcrever: midia nao encontrada no banco" };
    const transcription = await transcribeAudio(mediaUrl, media?.mimeType);
    if (m.id && !transcription.startsWith("Erro ao transcrever")) {
      supabase.from("messages").update({ content: transcription }).eq("id", m.id).then(({ error }: any) => { if (error) console.error("cache save fail", m.id, error.message); });
    }
    return { id: m.id, transcription };
  }));
  const tById: Record<string, string> = {};
  for (const m of audioMessages.filter(m => m.content && typeof m.content === "string" && !m.content.startsWith("http"))) tById[m.id] = m.content;
  for (const t of newT) tById[t.id] = t.transcription;
  return messages.map(m => AUDIO_TYPES.has(m.message_type) ? { ...m, transcription: tById[m.id] ?? "Erro ao transcrever audio" } : m);
}

// ─── expandChatIdsViaLidMapping (escopado por instancia) ──────────────────────
async function expandChatIdsViaLidMapping(chat_id: string, instanceId: string | null): Promise<string[]> {
  if (!chat_id) return [];
  const ids = new Set<string>([chat_id]);
  try {
    if (String(chat_id).endsWith("@lid")) {
      let q = supabase.from("lid_mapping").select("phone").eq("lid", chat_id).limit(1);
      if (instanceId) q = q.eq("instance_id", instanceId);
      const { data } = await q;
      if (data?.[0]?.phone) ids.add(data[0].phone);
    } else if (/^\d+$/.test(String(chat_id))) {
      let q = supabase.from("lid_mapping").select("lid").eq("phone", chat_id);
      if (instanceId) q = q.eq("instance_id", instanceId);
      const { data } = await q;
      if (data?.length) for (const r of data) ids.add(r.lid);
    }
  } catch { /* fail open */ }
  return Array.from(ids);
}

// ─── resolveChat (paridade com mcp/index.js, multi-instancia) ─────────────────
async function resolveChat(to: string, instance?: string): Promise<any> {
  if (!to || !String(to).trim()) return { error: "Input vazio" };
  to = String(to).trim();
  const instKey = instance ? await resolveInstanceKey(instance) : null;
  const instEq = (q: any) => (instKey ? q.eq("instance_id", instKey) : q);

  if (/^[0-9]+(@[a-z.]+|-group)$/i.test(to)) {
    const { data } = await instEq(supabase.from("v_chats_with_contact")
      .select("instance_id,chat_id,chat_name,contact_name,is_group").eq("chat_id", to)).limit(1);
    if (data?.length) return { chat_id: data[0].chat_id, chat_name: data[0].chat_name || data[0].contact_name || to, instance_id: data[0].instance_id };
    return { chat_id: to, chat_name: to, instance_id: instKey };
  }

  const digits = to.replace(/\D/g, "");
  const looksLikePhone = digits.length >= 8 && /^[\d\s+()\-.]+$/.test(to);

  if (looksLikePhone) {
    const phoneVariants = normalizePhoneBR(digits);
    const idCandidates = expandChatIdCandidates(phoneVariants);
    try {
      const { data: mappedLids } = await instEq(supabase.from("lid_mapping").select("lid").in("phone", phoneVariants));
      if (mappedLids?.length) for (const m of mappedLids) if (m.lid && !idCandidates.includes(m.lid)) idCandidates.push(m.lid);
    } catch { /* fail open */ }

    const { data: exact } = await instEq(supabase.from("v_chats_with_contact")
      .select("instance_id,chat_id,chat_name,contact_name,is_group,last_message_at").in("chat_id", idCandidates))
      .order("last_message_at", { ascending: false, nullsFirst: false }).order("chat_id", { ascending: true }).limit(10);

    // Decisao pura em pickPhoneChat (testada em _shared/wa/__tests__/phone.test.ts):
    // so colapsos deterministicos de mesmo-contato escolhem sozinhos; 2+ chats
    // genuinamente distintos SEMPRE viram candidates (auditoria 07/2026 — o
    // ranking por boost ja mandou mensagem pro numero errado).
    const pick = pickPhoneChat(exact ?? [], phoneVariants);
    if (pick && "chat" in pick) return { chat_id: pick.chat.chat_id, chat_name: pick.chat.chat_name || pick.chat.contact_name, instance_id: pick.chat.instance_id };
    if (pick && "candidates" in pick) {
      return { candidates: pick.candidates.slice(0, 5).map((c: any) => ({ chat_id: c.chat_id, name: c.chat_name || c.contact_name, is_group: c.is_group, instance: c.instance_id })) };
    }

    const longest = phoneVariants.slice().sort((a, b) => b.length - a.length)[0];
    if (longest && longest.length >= 8) {
      const { data: prefix } = await instEq(supabase.from("v_chats_with_contact")
        .select("instance_id,chat_id,chat_name,contact_name,is_group,last_message_at").like("chat_id", `${longest}%`))
        .order("last_message_at", { ascending: false, nullsFirst: false }).order("chat_id", { ascending: true }).limit(5);
      if (prefix?.length === 1) return { chat_id: prefix[0].chat_id, chat_name: prefix[0].chat_name || prefix[0].contact_name, instance_id: prefix[0].instance_id };
      if (prefix && prefix.length > 1) {
        // Prefixo casando 2+ chats = numeros DIFERENTES (pessoas diferentes).
        // Nunca escolher por boost/recencia — sempre pedir desambiguacao.
        return { candidates: prefix.slice(0, 5).map((c: any) => ({ chat_id: c.chat_id, name: c.chat_name || c.contact_name, is_group: c.is_group, instance: c.instance_id })) };
      }
    }
  }

  const toNorm = normalize(to);
  if (!toNorm) return { error: `Nenhum chat encontrado para "${to}"` };
  const SELECT_COLS = "instance_id,chat_id,chat_name,contact_name,is_group,last_message_at";
  const scoreAll = (rows: any[]) => rows.map((c: any) => {
    const { score, kind } = scoreNameMatch(toNorm, c);
    return { ...c, _score: score > 0 ? applyChatBoost(score, c) : 0, _kind: kind };
  }).filter((c: any) => c._score > 0).sort((a: any, b: any) => b._score - a._score || String(a.chat_id).localeCompare(String(b.chat_id)));
  // Prefiltro SQL por substring (caso comum: nome digitado certo) — nao carrega a
  // janela de 1500 e acha chats ALEM dela. Fallback pro scan em memoria cobre
  // typo/acento divergente (ilike nao e accent-insensitive; o scorer normaliza).
  let scored: any[] = [];
  const likeSafe = to.replace(/[%_,()"\\]/g, "").trim();
  if (likeSafe.length >= 2) {
    const { data: pre } = await instEq(supabase.from("v_chats_with_contact")
      .select(SELECT_COLS)
      .or(`chat_name.ilike.%${likeSafe}%,contact_name.ilike.%${likeSafe}%`))
      .order("last_message_at", { ascending: false, nullsFirst: false }).order("chat_id", { ascending: true }).limit(200);
    if (pre?.length) scored = scoreAll(pre);
  }
  if (!scored.length) {
    const { data: all } = await instEq(supabase.from("v_chats_with_contact")
      .select(SELECT_COLS))
      .order("last_message_at", { ascending: false, nullsFirst: false }).order("chat_id", { ascending: true }).limit(1500);
    if (!all?.length) return { error: "Tabela de chats vazia" };
    scored = scoreAll(all);
  }
  if (!scored.length) return { error: `Nenhum chat encontrado para "${to}"` };
  // Colapsa duplicata lid/phone do MESMO contato (mesmo nome normalizado, mesma
  // instancia): o lid e o espelho tecnico — read expande via lid_mapping e envio
  // vai pro numero. Sem isso a dupla empata o ranking e vira ambiguidade falsa.
  const dedup = scored.filter((c: any) => {
    if (!String(c.chat_id).endsWith("@lid")) return true;
    const cn = normalize(c.chat_name || c.contact_name || "");
    if (!cn) return true;
    return !scored.some((o: any) => !String(o.chat_id).endsWith("@lid")
      && o.instance_id === c.instance_id
      && normalize(o.chat_name || o.contact_name || "") === cn);
  });
  if (dedup.length) scored = dedup;
  if (scored.length === 1) return { chat_id: scored[0].chat_id, chat_name: scored[0].chat_name || scored[0].contact_name, instance_id: scored[0].instance_id };
  const top = scored[0], runner = scored[1];
  const topIsLid = String(top.chat_id || "").includes("@lid"), runnerIsLid = String(runner.chat_id || "").includes("@lid");
  if (scored.length === 2) {
    const tn = normalize(top.chat_name || top.contact_name || ""), rn = normalize(runner.chat_name || runner.contact_name || "");
    if (tn && tn === rn && topIsLid !== runnerIsLid) {
      const phoneOne = topIsLid ? runner : top;
      return { chat_id: phoneOne.chat_id, chat_name: phoneOne.chat_name || phoneOne.contact_name, instance_id: phoneOne.instance_id };
    }
  }
  if (top._score >= MIN_CONFIDENT_SCORE && top._score - runner._score >= MIN_WINNING_GAP)
    return { chat_id: top.chat_id, chat_name: top.chat_name || top.contact_name, instance_id: top.instance_id };
  return { candidates: scored.slice(0, 10).map((c: any) => ({ chat_id: c.chat_id, name: c.chat_name || c.contact_name, is_group: c.is_group, last_message_at: c.last_message_at, instance: c.instance_id })) };
}

// ─── resolveTargetMessage: chat + alvo posicional -> mensagem concreta ────────
// Compartilhado por react / edit_message / delete_message / send(reply_to) /
// zapi_action(forward): resolve o chat e acha a mensagem alvo em 1 passo, sem
// exigir um read previo so pra descobrir o message_id.
// target: last (default) | last_received (ultima DELES) | last_sent (ultima MINHA).
async function resolveTargetMessage(chat: string, target: string, instance?: string):
  Promise<{ msg?: any; error?: string; status?: number; candidates?: any[] }> {
  const resolved = await resolveChat(chat, instance);
  if (resolved.error) return { error: resolved.error, status: 400 };
  if (resolved.candidates) return { candidates: resolved.candidates };
  const chatIdSet = await expandChatIdsViaLidMapping(resolved.chat_id, resolved.instance_id);
  let q = supabase.from("messages")
    .select("id,provider_msg_id,chat_id,instance_id,content,caption,message_type,from_me,message_ts")
    .in("chat_id", chatIdSet)
    .not("provider_msg_id", "is", null)
    .not("provider_msg_id", "ilike", "pending-%")
    .order("message_ts", { ascending: false, nullsFirst: false })
    .limit(1);
  if (resolved.instance_id) q = q.eq("instance_id", resolved.instance_id);
  if (target === "last_received") q = q.eq("from_me", false);
  else if (target === "last_sent") q = q.eq("from_me", true);
  const { data, error } = await q;
  if (error) return { error: error.message, status: 500 };
  if (!data?.length) return { error: `nenhuma mensagem (${target}) em ${resolved.chat_name ?? resolved.chat_id}`, status: 404 };
  return { msg: { ...data[0], _chat_name: resolved.chat_name } };
}
function messagePreview(msg: any) {
  return {
    from_me: msg.from_me, type: msg.message_type,
    content: typeof msg.content === "string" ? msg.content.slice(0, 160) : null,
    ...(typeof msg.caption === "string" && { caption: msg.caption.slice(0, 160) }),
    message_ts_brt: toBRT(msg.message_ts),
  };
}
// Grupo (@g.us / -group) passa cru — strip do sufixo faria o adapter reconstruir como 1:1 (@s.whatsapp.net).
function phoneForAction(chatId: unknown): string {
  const s = String(chatId ?? "");
  return s.endsWith("@g.us") || s.endsWith("-group") ? s : s.replace(/@.*$/, "");
}

// ─── Canonicalizacao do 9o digito (bug do chat fantasma — ClickUp 86ajby187) ──
// Contas BR antigas sao registradas SEM o 9o digito. Enviar pro numero com 9
// quando a conta e sem-9 cria um chat fantasma na Z-API: a 1a msg chega (remap
// do WhatsApp), as seguintes morrem no orfao e a API segue respondendo 200.
// GET /phone-exists/{phone} devolve o numero canonico registrado + lid.
async function canonicalizePhone(digits: string, instanceId: string): Promise<{ exists: boolean; phone?: string; lid?: string; error?: string }> {
  const { status, data } = await callEdge("wa-proxy", {
    action: "phone-exists", params: { phone: digits },
    agent_name: "mcp-api", agent_request_id: crypto.randomUUID(), instance: instanceId,
  });
  if (status >= 400) return { exists: false, error: data?.error || `wa-proxy ${status}` };
  const raw = data?.result;
  const r = Array.isArray(raw) ? raw[0] : raw;
  if (!r || typeof r.exists !== "boolean") return { exists: false, error: "resposta inesperada do phone-exists" };
  // phone (Z-API) | number/jid (Evolution chat/whatsappNumbers) — parsing tolerante aos dois shapes
  const canonical = String(r.phone ?? r.number ?? (r.jid ?? "").split("@")[0]).replace(/\D/g, "");
  return { exists: r.exists, ...(canonical && { phone: canonical }), ...(r.lid && { lid: String(r.lid) }) };
}

// delay de digitacao humanizado (portado do mcp/index.js — antes era client-side)
// Cap em 5s (nao 15s): evita acumulo de atraso em sends paralelos que causava
// duplicata de envio (task 376drb5eilif, incidente 01/07/2026).
function humanizedTypingSeconds(type: string, content: string): number {
  const len = (content || "").length;
  if (type === "text") return Math.min(5, Math.max(1, Math.ceil(len / 30)));
  if (type === "audio" || type === "ptt") return 3;
  if (type === "image" || type === "video") return 2;
  return 1; // document
}

// ─── Voice guide — regras hard universais (portado do mcp/index.js) ───────────
const HARD_RULES: { id: string; pattern: RegExp; severity: string; message: string }[] = [
  // NOTA: pronome (tu/você) NÃO entra aqui. É traço PESSOAL/REGIONAL de cada dono,
  // não um fingerprint universal de IA — quem usa "tu" e quem usa "você" estão ambos certos.
  // A escolha de pronome fica a cargo do voice_guide de cada instância (public.voice_guide),
  // nunca hardcoded como regra global. (Regra "tu-pronome" removida em v3.0.2.)
  { id: "em-dash", pattern: /—/, severity: "high", message: "Detectado em-dash (—) — fingerprint de IA. Voice guide manda virgula, dois-pontos, parenteses ou '..'." },
  { id: "saudacao-generica", pattern: /(?:^|[\s,!?;:.])(ol[áa]|prezad[oa]|cordialmente|atenciosamente|esp[ée]ro que esteja bem)(?=$|[\s,!?;:.])/iu, severity: "high", message: "Detectada saudacao generica/formal. Voice guide manda 'Fala [Nome], beleza?' ou direto no assunto." },
  { id: "hype", pattern: /(?:^|[\s,!?;:.])(revolucion[áa]ri[oa]|transformador|disruptivo|game[- ]?changer|mindset|f[óo]rmula m[áa]gica)(?=$|[\s,!?;:.])/iu, severity: "high", message: "Detectado vocabulario de hype. Voice guide proibe — user posiciona com contencao." },
  { id: "urgencia-manufaturada", pattern: /(?:^|[\s,!?;:.])([úu]ltima chance|s[óo] hoje|corre que|aproveita j[áa])(?=$|[\s,!?;:.])/iu, severity: "high", message: "Detectada urgencia manufaturada. Voice guide so aceita escassez REAL." },
  { id: "softener-equipe", pattern: /\b(quando puder, por favor|se for poss[íi]vel|quando der um tempinho|com todo respeito)\b/iu, severity: "medium", message: "Detectado softener. Em equipe o dono usa ordem direta. Em discordancia, frontalidade direta." },
  { id: "validacao-afetiva", pattern: /\b(te entendo|imagino como (voc[êe]|vc) (est[áa]|t[áa])|faz sentido (sua|tua) preocupa[çc][ãa]o|fica tranquil[oa] (que|q) vamos)\b/iu, severity: "high", message: "Detectada validacao afetiva. Voice guide regra hard: frontalidade nao inclui validar emocao — devolve pergunta de plano." },
  { id: "rsrs", pattern: /\brsrs\w*\b/iu, severity: "medium", message: "Detectado 'rsrs'. Voice guide aceita 'kkk' ou 'rs' solto fim-de-frase, mas nao 'rsrs'." },
];
// Regras hard PESSOAIS do dono vem do banco (voice_guide.checks.hard_rules) como
// regex serializada. Regex invalida e ignorada silenciosamente (nao derruba o check).
function compileCustomRules(checks: any): { id: string; pattern: RegExp; severity: string; message: string }[] {
  if (!Array.isArray(checks?.hard_rules)) return [];
  const out: { id: string; pattern: RegExp; severity: string; message: string }[] = [];
  for (const r of checks.hard_rules) {
    if (!r?.id || !r?.pattern || !r?.message) continue;
    try { out.push({ id: r.id, pattern: new RegExp(r.pattern, r.flags ?? "iu"), severity: r.severity ?? "medium", message: r.message }); } catch { /* regex invalida */ }
  }
  return out;
}
function checkVoiceViolations(content: string, customRules: { id: string; pattern: RegExp; severity: string; message: string }[] = []) {
  if (!content || typeof content !== "string") return [];
  const out: any[] = [];
  for (const rule of [...HARD_RULES, ...customRules]) {
    const m = content.match(rule.pattern);
    if (m) out.push({ id: rule.id, severity: rule.severity, message: rule.message, match: m[0] });
  }
  return out;
}

// ─── Soft signals — fingerprints ESTRUTURAIS de simulacao (portado do mcp/voice-check.js v2.11) ───
// Diferente das regras hard: nao aponta um match binario, mas um padrao estatistico
// (msg-monolito, reticencias uniformes, cadeia de setas, caixa 100% minuscula, burst
// inflado, assinaturas empilhadas). O MOTOR e generico e universal — a mensagem-chave
// do blind test que originou isso: UNIFORMIDADE E FINGERPRINT (voz humana e distribuicao,
// voz simulada e ponto fixo). Thresholds, assinaturas e mensagens calibradas com o corpus
// do dono vem de voice_guide.checks.soft; defaults neutros abaixo. Sempre warning-only.
const SOFT_DEFAULTS = {
  signatures: [] as string[],
  max_prose_chars: 250,
  multiline_lines: 3,
  multiline_chars: 200,
  ellipsis_min_runs: 3,
  arrows_min: 2,
  lowercase_min_units: 3,
  burst_max: 4,
  messages: {} as Record<string, string>,
};
// URLs nao sao prosa: nao contam pra comprimento nem pra deteccao de setas.
function stripUrls(s: string): string { return s.replace(/https?:\/\/\S+/g, ""); }
function checkSoftSignals(content: string | string[], softCfg: any = null) {
  const cfg = { ...SOFT_DEFAULTS, ...(softCfg ?? {}) };
  const msg = (id: string, fallback: string) => cfg.messages?.[id] ?? fallback;
  const warnings: any[] = [];
  const isArray = Array.isArray(content);
  const messages: any[] = isArray ? content : [content];

  // Assinaturas fortes empilhadas (max 1 por resposta)
  const joined = messages.filter((m) => typeof m === "string").join(" ").toLowerCase();
  if (joined && Array.isArray(cfg.signatures) && cfg.signatures.length) {
    const found = cfg.signatures.filter((sig: string) => joined.includes(String(sig).toLowerCase()));
    if (found.length > 1) warnings.push({ id: "assinaturas-empilhadas", severity: "soft",
      message: msg("assinaturas-empilhadas", `Detectadas ${found.length} assinaturas fortes empilhadas na mesma msg (${found.join(", ")}). Maximo 1 assinatura forte por resposta.`) });
  }

  for (const m of messages) {
    if (typeof m !== "string") continue;
    const semUrl = stripUrls(m);

    // Msg-monolito: prosa real de chat e curta; conteudo longo vira burst de sends.
    if (semUrl.length > cfg.max_prose_chars) warnings.push({ id: "msg-longa", severity: "soft",
      message: msg("msg-longa", `Mensagem unica com ${semUrl.length} chars de prosa (fora URLs). Chat real fragmenta em sends separados — memo-monolito e fingerprint.`) });

    const lines = m.split("\n").map((l: string) => l.trim()).filter(Boolean);
    if (lines.length >= cfg.multiline_lines && semUrl.length > cfg.multiline_chars) warnings.push({ id: "bolha-multilinha", severity: "soft",
      message: msg("bolha-multilinha", `Bolha unica com ${lines.length} linhas e ${semUrl.length} chars de prosa. Chat real prefere sends separados — considere fragmentar em burst.`) });

    // Uniformidade de reticencias: humano MISTURA '..' e '...'; ponto fixo e simulacao.
    // '…' unicode (autocorrect/IA) normalizado pra '...' — tambem conta como run.
    const runs = m.replace(/…/g, "...").match(/\.{2,}/g) || [];
    if (runs.length >= cfg.ellipsis_min_runs && new Set(runs.map((r: string) => r.length)).size === 1) {
      warnings.push({ id: "uniformidade-reticencias", severity: "soft",
        message: msg("uniformidade-reticencias", `${runs.length} reticencias todas do mesmo tamanho ('${runs[0]}'). Voz humana varia o tamanho das runs na mesma msg — uniformidade e fingerprint.`) });
    }

    // Cadeia de setas 'X > Y > Z' (estilo documentacao, ninguem digita assim em chat).
    // Matching por linha (nao atravessa \n), ignora quote-reply ('>' no inicio),
    // comparacao numerica ('> 5', '> R$') e setas dentro de URL (ja stripadas).
    let setas = 0;
    for (const line of semUrl.split("\n")) {
      if (/^\s*>/.test(line)) continue;
      setas += (line.match(/\S[ \t]*[>→»](?![ \t]*(?:\d|R\$|%))[ \t]*\S/g) || []).length;
    }
    if (setas >= cfg.arrows_min) warnings.push({ id: "cadeia-setas", severity: "soft",
      message: msg("cadeia-setas", "Cadeia de setas 'X > Y > Z' detectada — estilo de documentacao. Passo-a-passo em chat se escreve corrido, ou vira audio/print.") });
  }

  // Caixa uniforme minuscula: vale pra linhas de uma bolha multi-linha E pra msgs de um burst.
  const units: string[] = [];
  for (const m of messages) {
    if (typeof m !== "string") continue;
    for (const line of m.split("\n")) { const t = line.trim(); if (t) units.push(t); }
  }
  const letterStarts = units.map((u) => (u.match(/^[A-Za-zÀ-ÖØ-öø-ÿ]/) || [null])[0]).filter(Boolean) as string[];
  if (letterStarts.length >= cfg.lowercase_min_units && letterStarts.every((ch) => ch === ch.toLowerCase())) {
    warnings.push({ id: "caixa-uniforme-minuscula", severity: "soft",
      message: msg("caixa-uniforme-minuscula", `${letterStarts.length} linhas/msgs TODAS comecando minusculas. Alternar a caixa — 100% minusculo e tao fingerprint quanto 100% capitalizado.`) });
  }

  // Burst inflado — conta so mensagens reais (string nao-vazia).
  const msgsReais = messages.filter((mm) => typeof mm === "string" && mm.trim().length > 0).length;
  if (isArray && msgsReais > cfg.burst_max) warnings.push({ id: "burst-inflado", severity: "soft",
    message: msg("burst-inflado", `Burst com ${msgsReais} mensagens. Chat real fragmenta em 2-${cfg.burst_max} — acima disso e inflado.`) });

  return warnings;
}

// Score 0-10: 10 - 3*high - 1.5*medium - 0.5*low - 0.5*soft, floor em 0. Score < 7 = regenerar.
function computeVoiceScore(violations: any[], softWarnings: any[]): number {
  const weights: Record<string, number> = { high: 3, medium: 1.5, low: 0.5 };
  let score = 10;
  for (const v of violations) score -= weights[v.severity] ?? 0;
  score -= 0.5 * softWarnings.length;
  return Math.max(0, Math.round(score * 10) / 10);
}

async function loadVoiceGuide(instanceId?: string | null): Promise<any | null> {
  // Erro de banco NAO pode passar em silencio: sem o log, falha de query fica
  // indistinguivel de "guide nao configurado" (achado da cirurgica 18/07). O
  // fallback continua null (gate degrada pras regras universais, envio nao quebra).
  if (instanceId) {
    const { data, error } = await supabase.from("voice_guide").select("content,checks,instance_id,updated_at").eq("instance_id", instanceId).maybeSingle();
    if (error) console.error("[voice_guide] query por instancia falhou:", error.message ?? error);
    if (data) return data;
  }
  const { data, error } = await supabase.from("voice_guide").select("content,checks,instance_id,updated_at").is("instance_id", null).maybeSingle();
  if (error) console.error("[voice_guide] query global falhou:", error.message ?? error);
  return data ?? null;
}

// ─── Voice gate server-side (0055) ─────────────────────────────────────────────
// Ultima linha de defesa da voz: superficies SEM hook local (claude.ai celular/
// Desktop/Web) chegam direto aqui. Modo por instancia (wa_instance.voice_gate):
// 'off' ignora, 'warn' (default) anexa voice_warnings sem barrar, 'block' recusa
// violacao severity=high a menos que confirmed_voice:true (aprovacao explicita do
// dono). Decisao pura em _shared/wa/voice-gate.ts (testada). loadInstances tem
// cache por isolate — mudanca de modo pega em minutos, nao precisa redeploy.
async function runVoiceGate(texts: (string | null | undefined)[], instanceId: string | null | undefined, params: any, tool = "send"):
  Promise<{ block?: Response; warnings?: VoiceViolation[] }> {
  if (!texts.some((t) => typeof t === "string" && t.trim())) return {};
  const rows = await loadInstances();
  const gate = (rows.find((r: any) => r.instance_id === instanceId)?.voice_gate ?? "warn") as VoiceGateMode;
  if (gate === "off") return {};
  const g = await loadVoiceGuide(instanceId ?? null);
  const customRules = compileCustomRules(g?.checks);
  const r = evaluateVoiceGate({ texts, gate, confirmedVoice: params?.confirmed_voice === true,
    violationsFor: (t) => checkVoiceViolations(t, customRules) });
  if (r.blocked) {
    return { block: json({ ok: false, blocked: true, reason: "voice_gate", violations: r.violations,
      instruction: "Envio recusado (voice_gate=block): o texto viola regra HARD do voice guide da instancia. Corrija o texto e reenvie. Se o dono ja aprovou o texto exatamente como esta, reenvie com confirmed_voice:true." }) };
  }
  if (r.bypassed) {
    // Trilha SILENCIOSA (0056): confirmed_voice soltou violacao high em gate block.
    // Falha no log nunca derruba o envio ja aprovado pelo dono.
    const preview = texts.filter((t): t is string => typeof t === "string" && t.trim().length > 0).join(" | ").slice(0, 1000);
    const { error } = await supabase.from("voice_bypass_log").insert({
      instance_id: instanceId ?? null, tool, rule_ids: r.violations.map((v) => v.id), text_preview: preview });
    if (error) console.error("[voice_bypass_log] insert falhou:", error.message ?? error);
  }
  return r.violations.length ? { warnings: r.violations } : {};
}

// ─── Executor de actions (reusado pelo legado {action,params} e pelo MCP tools/call) ───
async function dispatchAction(action: string, params: any = {}): Promise<Response> {
  try {
    switch (action) {
      case "ping": return json({ ok: true, pong: true });

      case "status": {
        const dayAgo = new Date(Date.now() - 86400000).toISOString();
        const instances = await loadInstances();
        // Instancias em paralelo, e dentro de cada uma provider + contagens tambem.
        // total_messages usa count estimado (estatistica do planner): a contagem
        // exata varria o indice inteiro a cada status; a das 24h segue exata (pequena).
        const perInstance: any[] = await Promise.all(instances.map(async (inst: any) => {
          const [waData, totalRes, todayRes] = await Promise.all([
            callEdge("wa-proxy", { action: "status", method: "GET", agent_name: "mcp-api", instance: inst.alias ?? inst.instance_id })
              .then(({ data }) => data?.result)
              .catch((e) => ({ error: String((e as Error)?.message ?? e) })),
            supabase.from("messages").select("*", { count: "estimated", head: true }).eq("instance_id", inst.instance_id),
            supabase.from("messages").select("*", { count: "exact", head: true }).eq("instance_id", inst.instance_id).gte("created_at", dayAgo),
          ]);
          return {
            instance: inst.alias ?? inst.instance_id,
            phone_connected: inst.phone_connected,
            connected: waData?.connected ?? false,
            webhook_active: inst.is_active,
            provider_status: waData,
            stats: { total_messages_approx: totalRes.count, messages_last_24h: todayRes.count },
          };
        }));
        return json({ ok: true, transcription_enabled: !!OPENAI_API_KEY, instances: perInstance });
      }

      case "list_categories": {
        const { data, error } = await supabase.from("categories").select("id,slug,label,color,description,parent_id,created_at").order("label", { ascending: true });
        if (error) return json({ error: error.message }, 500);
        const byId: Record<number, string> = Object.fromEntries((data || []).map((c: any) => [c.id, c.slug]));
        return json({
          ok: true,
          categories: (data || []).map((c: any) => ({ slug: c.slug, label: c.label, color: c.color, description: c.description, parent_slug: c.parent_id ? byId[c.parent_id] || null : null })),
          total: data?.length || 0,
        });
      }

      case "resolve_chat": {
        const r = await resolveChat(params.to, params.instance);
        return json({ ok: !r.error, ...r });
      }

      case "read": {
        const { chat, limit = 30, before, instance } = params;
        const resolved = await resolveChat(chat, instance);
        if (resolved.error) return json({ ok: false, error: resolved.error });
        if (resolved.candidates) return json({ ok: true, ambiguous: true, candidates: resolved.candidates });
        const chatIdSet = await expandChatIdsViaLidMapping(resolved.chat_id, resolved.instance_id);
        let q = supabase.from("v_messages_with_sender")
          .select("id,instance_id,message_type,content,direction,from_me,sender_contact_name,sender_phone,message_ts,created_at")
          .in("chat_id", chatIdSet)
          .order("message_ts", { ascending: false, nullsFirst: false })
          .limit(limit);
        if (resolved.instance_id) q = q.eq("instance_id", resolved.instance_id);
        if (before) q = q.lt("message_ts", before);
        const { data, error } = await q;
        if (error) return json({ error: error.message }, 500);

        let catQ = supabase.from("v_chats_with_categories").select("category_slugs,category_labels,linked_pipedrive_person_id").eq("chat_id", resolved.chat_id);
        let metaQ = supabase.from("chats").select("chat_name,observations,links,voice_profile,brain_contact_id,is_group,phone,contact_about,business_profile,profile_refreshed_at,waiting_on,last_received_at,resolved_at,snooze_until").eq("chat_id", resolved.chat_id);
        if (resolved.instance_id) { catQ = catQ.eq("instance_id", resolved.instance_id); metaQ = metaQ.eq("instance_id", resolved.instance_id); }
        const [catRes, metaRes] = await Promise.all([catQ.maybeSingle(), metaQ.maybeSingle()]);
        const catRow: any = catRes.data, chatMeta: any = metaRes.data;
        // Stale-while-revalidate: o refresh sincrono custava ~800ms de provider por
        // chat com cache vencido, DENTRO do read. Agora responde com o cache e
        // revalida em background (EdgeRuntime.waitUntil segura a function viva).
        // So espera quando o chat nunca foi enriquecido (senao 1o read sai sem perfil).
        let prof: any = chatMeta;
        if (chatMeta && !chatMeta.is_group) {
          const neverRefreshed = !chatMeta.profile_refreshed_at && !chatMeta.contact_about && !chatMeta.business_profile;
          if (neverRefreshed) {
            prof = (await refreshContactProfile(resolved.chat_id, resolved.instance_id, chatMeta)) ?? chatMeta;
          } else {
            const bg = refreshContactProfile(resolved.chat_id, resolved.instance_id, chatMeta).catch(() => null);
            (globalThis as any).EdgeRuntime?.waitUntil?.(bg);
          }
        }
        // Mesma regra do waiting_on_effective das views (0045), espelhada em TS.
        const wEff = chatMeta?.waiting_on === "me" && chatMeta?.resolved_at
          && (!chatMeta.last_received_at || new Date(chatMeta.last_received_at).getTime() <= new Date(chatMeta.resolved_at).getTime())
          && (!chatMeta.snooze_until || Date.now() < new Date(chatMeta.snooze_until).getTime())
          ? "resolved" : chatMeta?.waiting_on;

        return json({
          ok: true,
          chat_id: resolved.chat_id,
          chat_name: resolved.chat_name,
          instance: resolved.instance_id,
          ...(chatMeta?.observations && { observations: chatMeta.observations }),
          ...(chatMeta?.links?.length && { links: chatMeta.links }),
          ...(chatMeta?.voice_profile && { voice_profile: chatMeta.voice_profile }),
          ...(chatMeta?.brain_contact_id && { brain_contact_id: chatMeta.brain_contact_id }),
          ...(prof?.contact_about && { contact_about: prof.contact_about }),
          ...(prof?.business_profile && { business_profile: prof.business_profile }),
          ...(wEff && { waiting_on: wEff }),
          ...(chatMeta?.resolved_at && { resolved_at: chatMeta.resolved_at }),
          ...(chatMeta?.snooze_until && { snooze_until: chatMeta.snooze_until }),
          categories: catRow?.category_slugs || [],
          category_labels: catRow?.category_labels || [],
          ...(catRow?.linked_pipedrive_person_id && { linked_pipedrive_person_id: catRow.linked_pipedrive_person_id }),
          messages: withBRT(await enrichWithTranscriptions((data || []).reverse())),
          count: (data || []).length,
        });
      }

      case "inbox": {
        const { limit = 15, since, waiting_on: waitingFilter, exclude_groups = false, category_slugs, exclude_categories, min_idle_days, include_dormant = false, instance } = params;
        const instKey = instance ? await resolveInstanceKey(instance) : null;
        const instEq = (q: any) => (instKey ? q.eq("instance_id", instKey) : q);
        const ck = (m: any) => `${m.instance_id}|${m.chat_id}`;
        const instRows = await loadInstances();
        const labelOf = (id: string) => instRows.find((r: any) => r.instance_id === id)?.alias ?? id;
        const useCategoryView = !!(category_slugs?.length || exclude_categories?.length);
        // Todos os filtros descem pro SQL (waiting_on e coluna gerada em chats
        // desde a 0041) — a versao antiga filtrava em memoria sobre uma janela dos
        // N chats mais recentes e PERDIA chats esperando alem da janela.
        // min_idle_days compara last_message_at: pra 'me' a ultima msg e a recebida,
        // pra 'lead' a enviada — last_message_at coincide com o refTs da logica antiga.
        // Ordenacao "mais parado primeiro" (idle asc) quando min_idle_days ou
        // waiting_on:me — absorve a antiga skill 'estou-devendo' direto na tool.
        const idleFirst = min_idle_days != null || waitingFilter === "me";
        // Dormente (0045): 'esperando eu responder' parado ha 90+ dias e conversa
        // morta, nao divida — sai da lista padrao. Pedir min_idle_days ou
        // include_dormant traz de volta.
        const dormantCutoff = waitingFilter === "me" && min_idle_days == null && !include_dormant;
        let q = supabase.from(useCategoryView ? "v_chats_with_categories" : "v_chats_with_contact")
          .select(useCategoryView
            ? "instance_id,chat_id,chat_name,is_group,last_message_at,last_received_at,last_sent_at,waiting_on_effective,category_slugs"
            : "instance_id,chat_id,chat_name,contact_name,is_group,last_message_at,last_received_at,last_sent_at,waiting_on_effective,contact_about,business_description")
          .order("last_message_at", { ascending: idleFirst, nullsFirst: false })
          .order("chat_id", { ascending: true })
          .limit(limit);
        q = instEq(q);
        if (since) q = q.gt("last_message_at", since);
        if (exclude_groups) q = q.eq("is_group", false);
        if (waitingFilter) q = q.eq("waiting_on_effective", waitingFilter);
        if (min_idle_days != null) q = q.lte("last_message_at", new Date(Date.now() - min_idle_days * 86400000).toISOString());
        if (dormantCutoff) q = q.gte("last_message_at", new Date(Date.now() - 90 * 86400000).toISOString());
        if (category_slugs?.length) q = q.overlaps("category_slugs", category_slugs);
        if (exclude_categories?.length) q = q.not("category_slugs", "ov", `{${exclude_categories.join(",")}}`);
        const { data: rawChats, error } = await q;
        if (error) return json({ error: error.message }, 500);
        const nowMs = Date.now();
        const idleByKey: Record<string, number | null> = {};
        for (const c of (rawChats || []) as any[]) {
          const refTs = c.last_message_at ? new Date(c.last_message_at).getTime() : 0;
          idleByKey[ck(c)] = refTs ? Math.floor((nowMs - refTs) / 86400000) : null;
        }
        let chats: any[] = rawChats || [];

        let contactById: Record<string, any> = {};
        if (useCategoryView && chats.length) {
          const ids = chats.map((c: any) => c.chat_id);
          const { data: enriched } = await instEq(supabase.from("v_chats_with_contact").select("instance_id,chat_id,contact_name,contact_about,business_description").in("chat_id", ids));
          contactById = Object.fromEntries((enriched || []).map((e: any) => [ck(e), e]));
        }
        let categoriesByChat: Record<string, any> = {};
        if (!useCategoryView && chats.length) {
          const ids = chats.map((c: any) => c.chat_id);
          const { data: catRows } = await instEq(supabase.from("v_chats_with_categories").select("instance_id,chat_id,category_slugs").in("chat_id", ids));
          categoriesByChat = Object.fromEntries((catRows || []).map((r: any) => [ck(r), r.category_slugs || []]));
        } else {
          categoriesByChat = Object.fromEntries(chats.map((c: any) => [ck(c), c.category_slugs || []]));
        }
        const chatIds = chats.map((c: any) => c.chat_id);
        const { data: lastMsgs } = await instEq(supabase.from("messages")
          .select("id,instance_id,chat_id,content,message_type,from_me,message_ts,created_at").in("chat_id", chatIds))
          .order("message_ts", { ascending: false, nullsFirst: false });
        const lastByChat: Record<string, any> = {};
        for (const m of lastMsgs || []) if (!lastByChat[ck(m)]) lastByChat[ck(m)] = m;
        const enrichedList = await enrichWithTranscriptions(Object.values(lastByChat));
        const enrichedByChat: Record<string, any> = {};
        for (const m of enrichedList) enrichedByChat[ck(m)] = m;
        const result = chats.map((c: any) => {
          const msg = enrichedByChat[ck(c)];
          const waiting_on = c.waiting_on_effective;
          const enriched = contactById[ck(c)] || {};
          const contact_about = enriched.contact_about ?? c.contact_about;
          const business_description = enriched.business_description ?? c.business_description;
          return {
            chat_id: c.chat_id, instance: c.instance_id, instance_label: labelOf(c.instance_id),
            name: enriched.contact_name || c.contact_name || c.chat_name, is_group: c.is_group,
            ...(contact_about && { contact_about }),
            ...(business_description && { business_description }),
            categories: categoriesByChat[ck(c)] || [],
            last_message_at: c.last_message_at, ...(c.last_message_at && { last_message_at_brt: toBRT(c.last_message_at) }),
            last_received_at: c.last_received_at, last_sent_at: c.last_sent_at, waiting_on,
            idle_days: idleByKey[ck(c)] ?? null,
            last_message: msg ? { content: msg.content?.slice(0, 120), type: msg.message_type, from_me: msg.from_me, ...(AUDIO_TYPES.has(msg.message_type) && { transcription: msg.transcription }) } : null,
          };
        });
        return json({
          ok: true, chats: result, total: result.length,
          ...(dormantCutoff && { note: "Chats dormentes (90+ dias parados) ocultos por padrao — use min_idle_days ou include_dormant:true pra ve-los." }),
        });
      }

      case "search": {
        const { query, chat, search_in = "both", category_slugs, exclude_categories, limit = 20, after, before, instance } = params;
        const instKey = instance ? await resolveInstanceKey(instance) : null;
        const instEq = (q: any) => (instKey ? q.eq("instance_id", instKey) : q);
        let chat_id: string | null = null;
        if (chat) {
          const resolved = await resolveChat(chat, instance);
          if (resolved.error) return json({ error: resolved.error }, 400);
          if (resolved.candidates) return json({ ok: true, ambiguous: true, candidates: resolved.candidates });
          chat_id = resolved.chat_id;
        }
        let allowedChatIds: string[] | null = null;
        if (category_slugs?.length || exclude_categories?.length) {
          let cq = supabase.from("v_chats_with_categories").select("chat_id,category_slugs");
          if (category_slugs?.length) cq = cq.overlaps("category_slugs", category_slugs);
          const { data: catChats } = await cq;
          let ids = (catChats || []).map((c: any) => c.chat_id);
          if (exclude_categories?.length) {
            const { data: excluded } = await supabase.from("v_chats_with_categories").select("chat_id").overlaps("category_slugs", exclude_categories);
            const exSet = new Set((excluded || []).map((e: any) => e.chat_id));
            ids = ids.filter((id: string) => !exSet.has(id));
            if (!category_slugs?.length) {
              const { data: allC } = await supabase.from("v_chats_with_contact").select("chat_id");
              ids = (allC || []).map((c: any) => c.chat_id).filter((id: string) => !exSet.has(id));
            }
          }
          allowedChatIds = ids;
          if (allowedChatIds && allowedChatIds.length === 0) return json({ ok: true, query, search_in, chats: [], messages: [], message_count: 0, note: "filtro de categoria sem chats" });
        }
        const result: any = { ok: true, query, search_in };
        if (search_in === "chat_name" || search_in === "both") {
          const qNorm = normalize(query);
          let cq = supabase.from("v_chats_with_contact")
            .select("instance_id,chat_id,chat_name,contact_name,is_group,last_message_at,last_received_at")
            .order("last_message_at", { ascending: false, nullsFirst: false }).order("chat_id", { ascending: true }).limit(1500);
          cq = instEq(cq);
          if (allowedChatIds) cq = cq.in("chat_id", allowedChatIds);
          const { data: chatsD } = await cq;
          const ranked = (chatsD || []).map((c: any) => {
            const { score, kind } = scoreNameMatch(qNorm, c);
            return { ...c, _score: score > 0 ? applyChatBoost(score, c) : 0, _kind: kind };
          }).filter((c: any) => c._score > 0).sort((a: any, b: any) => b._score - a._score || String(a.chat_id).localeCompare(String(b.chat_id))).slice(0, limit);
          result.chats = ranked.map((c: any) => ({ chat_id: c.chat_id, instance: c.instance_id, name: c.contact_name || c.chat_name, is_group: c.is_group, last_message_at: c.last_message_at, last_received_at: c.last_received_at, match: c._kind }));
        }
        if (search_in === "content" || search_in === "both") {
          let mq = supabase.from("v_messages_with_sender")
            .select("id,instance_id,chat_id,chat_display_name,chat_is_group,content,message_type,from_me,sender_contact_name,message_ts,created_at,direction")
            .ilike("content", `%${query}%`).order("message_ts", { ascending: false, nullsFirst: false }).limit(limit);
          mq = instEq(mq);
          if (chat_id) mq = mq.eq("chat_id", chat_id);
          if (allowedChatIds) mq = mq.in("chat_id", allowedChatIds);
          if (after) mq = mq.gt("message_ts", after);
          if (before) mq = mq.lt("message_ts", before);
          const { data, error } = await mq;
          if (error) return json({ error: error.message }, 500);
          result.messages = withBRT(data || []);
          result.message_count = (data || []).length;
        }
        return json(result);
      }

      case "categorize": {
        const { chat, category_slugs, assigned_by = "manual", confidence, notes, instance } = params;
        if (assigned_by === "llm" && (confidence === undefined || confidence === null)) return json({ error: "confidence obrigatorio quando assigned_by=llm" }, 400);
        const resolved = await resolveChat(chat, instance);
        if (resolved.error) return json({ error: resolved.error }, 400);
        if (resolved.candidates) return json({ ok: true, ambiguous: true, candidates: resolved.candidates });
        const { data: cats } = await supabase.from("categories").select("id,slug").in("slug", category_slugs || []);
        const validSlugs = new Set((cats || []).map((c: any) => c.slug));
        const invalid = (category_slugs || []).filter((s: string) => !validSlugs.has(s));
        if (invalid.length) {
          const { data: all } = await supabase.from("categories").select("slug").order("slug");
          return json({ error: `Slug(s) invalido(s): ${invalid.join(", ")}. Validos: ${(all || []).map((c: any) => c.slug).join(", ")}.` }, 400);
        }
        let existingQ = supabase.from("chat_categories").select("category_id").eq("chat_id", resolved.chat_id).in("category_id", (cats || []).map((c: any) => c.id));
        if (resolved.instance_id) existingQ = existingQ.eq("instance_id", resolved.instance_id);
        const { data: existing } = await existingQ;
        const existingIds = new Set((existing || []).map((e: any) => e.category_id));
        const toInsert = (cats || []).filter((c: any) => !existingIds.has(c.id)).map((c: any) => ({
          instance_id: resolved.instance_id, chat_id: resolved.chat_id, category_id: c.id, assigned_by,
          ...(confidence !== undefined && { confidence }), ...(notes && { notes }),
        }));
        if (toInsert.length) {
          const { error: insErr } = await supabase.from("chat_categories").upsert(toInsert, { onConflict: "instance_id,chat_id,category_id" });
          if (insErr) return json({ error: `Falha ao inserir: ${insErr.message}` }, 500);
        }
        const slugById: Record<number, string> = Object.fromEntries((cats || []).map((c: any) => [c.id, c.slug]));
        return json({ ok: true, chat_id: resolved.chat_id, chat_name: resolved.chat_name, instance: resolved.instance_id, applied: toInsert.map((t: any) => slugById[t.category_id]), skipped: [...existingIds].map((id: any) => slugById[id]) });
      }

      case "uncategorize": {
        const { chat, category_slugs, instance } = params;
        const resolved = await resolveChat(chat, instance);
        if (resolved.error) return json({ error: resolved.error }, 400);
        if (resolved.candidates) return json({ ok: true, ambiguous: true, candidates: resolved.candidates });
        const { data: cats } = await supabase.from("categories").select("id,slug").in("slug", category_slugs || []);
        if (!cats?.length) return json({ ok: true, chat_id: resolved.chat_id, removed: [] });
        const slugById: Record<number, string> = Object.fromEntries(cats.map((c: any) => [c.id, c.slug]));
        let delQ = supabase.from("chat_categories").delete().eq("chat_id", resolved.chat_id).in("category_id", cats.map((c: any) => c.id));
        if (resolved.instance_id) delQ = delQ.eq("instance_id", resolved.instance_id);
        const { data: removed, error: delErr } = await delQ.select("category_id");
        if (delErr) return json({ error: `Falha ao remover: ${delErr.message}` }, 500);
        return json({ ok: true, chat_id: resolved.chat_id, chat_name: resolved.chat_name, instance: resolved.instance_id, removed: (removed || []).map((r: any) => slugById[r.category_id]) });
      }

      case "annotate": {
        const { chat, observations, links, voice_profile, brain_contact_id, instance } = params;
        if (observations === undefined && links === undefined && voice_profile === undefined && brain_contact_id === undefined)
          return json({ error: "Passe ao menos observations, links, voice_profile ou brain_contact_id." }, 400);
        const resolved = await resolveChat(chat, instance);
        if (resolved.error) return json({ error: resolved.error }, 400);
        if (resolved.candidates) return json({ ok: true, ambiguous: true, candidates: resolved.candidates });
        const update: any = {};
        if (observations !== undefined) update.observations = observations;
        if (links !== undefined) update.links = links;
        if (brain_contact_id !== undefined) {
          if (brain_contact_id !== null && typeof brain_contact_id !== "string")
            return json({ error: "brain_contact_id deve ser string (id do vault expert-contacts) ou null pra desvincular." }, 400);
          update.brain_contact_id = brain_contact_id;
        }
        if (voice_profile !== undefined) {
          if (voice_profile === null) {
            update.voice_profile = null; // limpar explicitamente
          } else if (typeof voice_profile !== "object" || Array.isArray(voice_profile)) {
            return json({ error: "voice_profile deve ser um objeto JSON (ou null pra limpar)." }, 400);
          } else {
            // MERGE RASO por chave de topo: atualizar so 'girias' preserva 'como_me_chama'.
            // Arrays SUBSTITUEM (sem union) — leia o perfil atual no read e mande o array
            // completo. Chave com valor null remove a chave. Read-modify-write e aceitavel
            // aqui (tool single-owner); se surgir concorrencia real, virar RPC com || jsonb.
            let curQ = supabase.from("chats").select("voice_profile").eq("chat_id", resolved.chat_id);
            if (resolved.instance_id) curQ = curQ.eq("instance_id", resolved.instance_id);
            const { data: cur } = await curQ.maybeSingle();
            const merged: any = { ...((cur as any)?.voice_profile ?? {}), ...voice_profile };
            for (const k of Object.keys(merged)) if (merged[k] === null) delete merged[k];
            if (!("analisado_em" in voice_profile)) merged.analisado_em = new Date().toISOString();
            update.voice_profile = merged;
          }
        }
        let updateQ = supabase.from("chats").update(update).eq("chat_id", resolved.chat_id);
        if (resolved.instance_id) updateQ = updateQ.eq("instance_id", resolved.instance_id);
        const { error } = await updateQ;
        if (error) return json({ error: error.message }, 500);
        return json({ ok: true, annotated: true, chat_id: resolved.chat_id, chat_name: resolved.chat_name, instance: resolved.instance_id, ...update });
      }

      case "resolve": {
        // Modelo Zendesk (0045): resolved mascara o waiting_on 'me' ATE chegar
        // mensagem nova (reabertura automatica via last_received_at > resolved_at).
        // snooze_until: some ate a data OU ate responderem. reopen: desfaz manual.
        const { chat, snooze_until, reopen = false, instance } = params;
        const resolved = await resolveChat(chat, instance);
        if (resolved.error) return json({ error: resolved.error }, 400);
        if (resolved.candidates) return json({ ok: true, ambiguous: true, candidates: resolved.candidates });
        let update: any;
        if (reopen) {
          update = { resolved_at: null, snooze_until: null };
        } else {
          let snooze: string | null = null;
          if (snooze_until != null) {
            const d = new Date(snooze_until);
            if (isNaN(d.getTime())) return json({ error: "snooze_until invalido — use ISO 8601 (ex.: 2026-07-13T12:00:00-03:00)." }, 400);
            if (d.getTime() <= Date.now()) return json({ error: "snooze_until precisa ser no futuro." }, 400);
            snooze = d.toISOString();
          }
          update = { resolved_at: new Date().toISOString(), snooze_until: snooze };
        }
        let updQ = supabase.from("chats").update(update).eq("chat_id", resolved.chat_id);
        if (resolved.instance_id) updQ = updQ.eq("instance_id", resolved.instance_id);
        const { error: resErr } = await updQ;
        if (resErr) return json({ error: resErr.message }, 500);
        return json({
          ok: true, chat_id: resolved.chat_id, chat_name: resolved.chat_name, instance: resolved.instance_id,
          resolved: !reopen,
          ...(update.snooze_until && { snooze_until: update.snooze_until, snooze_until_brt: toBRT(update.snooze_until) }),
          note: reopen ? "Chat reaberto — volta a contar como esperando resposta." :
            "Nao conta mais como 'esperando resposta'. Reabre sozinho se a pessoa mandar mensagem nova" +
            (update.snooze_until ? " ou quando o snooze vencer." : "."),
        });
      }

      case "download_attachment": {
        const { message_id } = params;
        const { data: media, error } = await supabase.from("message_media")
          .select("storage_bucket,storage_path,original_url,mime_type,file_size_bytes,download_status,download_error")
          .eq("message_id", message_id).single();
        if (error || !media) return json({ error: "Nenhuma midia associada a esta mensagem." }, 404);
        let public_url: string | null = null;
        if (media.storage_path && media.download_status === "done") {
          const { data } = await supabase.storage.from(media.storage_bucket).createSignedUrl(media.storage_path, 3600);
          public_url = data?.signedUrl ?? null;
        }
        return json({
          ok: true, public_url, original_url: media.original_url, mime_type: media.mime_type,
          file_size_bytes: media.file_size_bytes, download_status: media.download_status,
          ...(media.download_status !== "done" && { note: "Arquivo ainda nao baixado pro Storage. Usando original_url (pode expirar)." }),
          ...(media.download_error && { download_error: media.download_error }),
        });
      }

      case "send": {
        const { to, content = "", type = "text", media_url, file_name, reply_to, allow_new = false,
          delay_typing, delay_message, mentions, mentions_everyone, force_send_after_inbound = false, instance, agent_name,
          confirmed = false, humanize = true, link } = params;
        if (!confirmed) return json({ blocked: true, needs_confirmation: true, to, content: content || "(midia)", type, ...(media_url && { media_url }), instruction: "Mostre destinatario + conteudo ao usuario e so reenvie com confirmed:true apos ele confirmar." });
        const effectiveDelayTyping = delay_typing !== undefined ? delay_typing : (humanize ? humanizedTypingSeconds(type, content) : undefined);
        const wantInstance = instance ? await resolveInstanceKey(instance) : null;
        if (instance && !wantInstance) return json({ error: `Instancia "${instance}" nao encontrada.` }, 400);
        let resolved = await resolveChat(to, instance);
        if (resolved.error) {
          const digits = String(to).replace(/\D/g, "");
          const looksLikePhone = digits.length >= 10 && digits.length <= 13;
          if (!allow_new) return json({ ok: false, error: looksLikePhone ? `Numero "${to}" nao esta em chats. Passe allow_new=true pra primeiro contato.` : resolved.error });
          if (!looksLikePhone) return json({ error: `allow_new=true so com phone valido (10-13 digitos).` }, 400);
          if (!wantInstance) return json({ error: `Primeiro contato (allow_new) exige 'instance'.` }, 400);
          // Canonicaliza o 9o digito via phone-exists ANTES de criar o chat: usar o
          // numero como digitado cria chat fantasma quando a conta e registrada sem o 9.
          const typedPhone = digits.startsWith("55") ? digits : `55${digits}`;
          const check = await canonicalizePhone(typedPhone, wantInstance);
          if (!check.error && !check.exists) return json({ ok: false, error: `Numero "${to}" nao tem WhatsApp (verificado via phone-exists).` }, 400);
          const newChatId = check.phone || typedPhone;
          const { error: insErr } = await supabase.from("chats").upsert({ instance_id: wantInstance, chat_id: newChatId, phone: newChatId, chat_name: newChatId, is_group: false, last_message_at: new Date().toISOString() }, { onConflict: "instance_id,chat_id" });
          if (insErr) return json({ error: `Falha ao criar chat: ${insErr.message}` }, 500);
          if (check.lid) {
            await supabase.from("lid_mapping").upsert({ instance_id: wantInstance, lid: check.lid, phone: newChatId, resolved_via: "zapi" }, { onConflict: "instance_id,lid" });
          }
          resolved = { chat_id: newChatId, chat_name: newChatId, instance_id: wantInstance, _new: true,
            ...(check.error && { _phone_unverified: check.error }),
            ...(newChatId !== typedPhone && { _canonicalized_from: typedPhone }) };
        }
        if (resolved.candidates) return json({ ok: true, ambiguous: true, candidates: resolved.candidates, hint: "2+ chats casam com esse destinatario. NAO escolha sozinho: mostre os candidatos ao usuario e reenvie com o chat_id exato confirmado." });
        if (type !== "text" && !media_url) return json({ error: `media_url obrigatorio pra type "${type}".` }, 400);
        const targetInstance = wantInstance ?? resolved.instance_id;
        const vg = await runVoiceGate([content], targetInstance, params, "send");
        if (vg.block) return vg.block;
        if (!force_send_after_inbound && !resolved._new && !resolved.is_group) {
          const rows = await loadInstances();
          const selfPhone = rows.find((i: any) => i.instance_id === targetInstance)?.phone_connected ?? null;
          const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
          let rq = supabase.from("messages").select("id,message_ts,from_me,sent_by_agent,message_type,content")
            .eq("chat_id", resolved.chat_id).gte("message_ts", tenMinAgo).order("message_ts", { ascending: false }).limit(10);
          if (targetInstance) rq = rq.eq("instance_id", targetInstance);
          const { data: recent } = await rq;
          if (recent && recent.length) {
            let lastIn: string | null = null, lastInPrev: string | null = null, lastOut: string | null = null;
            for (const m of recent) {
              const isInbound = !m.from_me || (m.from_me && !m.sent_by_agent && resolved.chat_id === selfPhone);
              const isOut = m.from_me && m.sent_by_agent;
              if (isInbound && !lastIn) { lastIn = m.message_ts; lastInPrev = (m.content || `[${m.message_type}]`).slice(0, 80); }
              if (isOut && !lastOut) lastOut = m.message_ts;
            }
            if (lastIn && (!lastOut || lastIn > lastOut))
              return json({ ok: true, blocked: true, reason: "inbound_recente_sem_resposta", chat: resolved.chat_name, ultimo_inbound_ts: lastIn, ultimo_inbound_preview: lastInPrev, hint: "Chame com force_send_after_inbound=true pra prosseguir." });
          }
        }
        // reply_to posicional: "last" | "last_received" | "last_sent" resolve a msg
        // citada aqui — sem exigir read previo so pra pegar o id. Sem match, envia
        // sem reply (mesma semantica de UUID inexistente no send-message).
        let quotedId: string | null = reply_to ?? null;
        if (quotedId && ["last", "last_received", "last_sent"].includes(quotedId)) {
          const r = await resolveTargetMessage(resolved.chat_id, quotedId, targetInstance);
          quotedId = r.msg?.provider_msg_id ?? null;
        }
        const sendBody: any = { chat_id: resolved.chat_id, content, message_type: type, confirmed: true, agent_name: agent_name || "mcp-api", instance: targetInstance,
          ...(link && { link }),
          ...(media_url && { media_url }), ...(file_name && { file_name }), ...(quotedId && { quoted_msg_id: quotedId }),
          ...(effectiveDelayTyping !== undefined && { delay_typing: effectiveDelayTyping }), ...(delay_message !== undefined && { delay_message }),
          ...(mentions?.length && { mentions }), ...(mentions_everyone && { mentions_everyone: true }) };
        const { status, data } = await callEdge("send-message", sendBody);
        if (status >= 400) return json({ ok: false, error: data?.error || `send-message ${status}`, detail: data }, status);
        return json({ ok: true, ...data, to: resolved.chat_name, instance: targetInstance,
          ...(vg.warnings?.length && { voice_warnings: vg.warnings }),
          ...(resolved._canonicalized_from && { phone_canonicalized: { typed: resolved._canonicalized_from, canonical: resolved.chat_id } }),
          ...(resolved._phone_unverified && { warning: `phone-exists indisponivel (${resolved._phone_unverified}); numero usado como digitado — confirme entrega com check_delivery.` }),
          ...(resolved._new && { delivery_hint: "Primeiro contato: confirme a entrega com check_delivery (message_id) apos alguns segundos." }) });
      }

      case "send_voice": {
        const { to, text, profile, voice_id, model_id, stability, similarity_boost, style, speed, instance, agent_name, confirmed = false } = params;
        if (!confirmed) return json({ blocked: true, needs_confirmation: true, to, ...(profile && { profile }), voice_id, text, instruction: "Mostre destinatario + perfil/voz + texto ao usuario e so reenvie com confirmed:true apos ele confirmar." });
        const resolved = await resolveChat(to, instance);
        if (resolved.error) return json({ ok: false, error: resolved.error });
        if (resolved.candidates) return json({ ok: true, ambiguous: true, candidates: resolved.candidates, hint: "2+ chats casam com esse destinatario. NAO escolha sozinho: mostre os candidatos ao usuario e reenvie com o chat_id exato confirmado." });
        const targetInstance = (instance ? await resolveInstanceKey(instance) : null) ?? resolved.instance_id;
        const vgv = await runVoiceGate([text], targetInstance, params, "send_voice");
        if (vgv.block) return vgv.block;
        const vbody: any = { chat_id: resolved.chat_id, text, voice_id, confirmed: true, agent_name: agent_name || "mcp-api", agent_request_id: crypto.randomUUID(), instance: targetInstance,
          ...(profile && { profile }), ...(model_id && { model_id }), ...(stability !== undefined && { stability }), ...(similarity_boost !== undefined && { similarity_boost }), ...(style !== undefined && { style }), ...(speed !== undefined && { speed }) };
        const { status, data } = await callEdge("send-voice", vbody);
        if (status >= 400) return json({ ok: false, error: data?.error || `send-voice ${status}`, detail: data }, status);
        return json({ ok: true, ...data, to: resolved.chat_name, instance: targetInstance, ...(vgv.warnings?.length && { voice_warnings: vgv.warnings }) });
      }

      case "send_image": {
        // Imagem GERADA (bytes): hospeda no bucket whatsapp-images + signed URL e
        // delega pro send-message — espelho do padrao upload+sign do send-voice.
        // Imagem que ja tem URL publica segue pelo send (type=image), nao por aqui.
        const { to, image_base64, caption = "", instance, agent_name, confirmed = false } = params;
        if (!confirmed) return json({ blocked: true, needs_confirmation: true, to, caption: caption || "(sem legenda)", image_bytes_base64: (image_base64 ?? "").length, instruction: "Mostre destinatario + legenda ao usuario e so reenvie com confirmed:true apos ele confirmar." });
        const b64 = String(image_base64 ?? "").replace(/^data:image\/[a-z+]+;base64,/i, "").replace(/\s/g, "");
        if (!b64) return json({ error: "image_base64 vazio." }, 400);
        let bytes: Uint8Array;
        try {
          bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        } catch {
          return json({ error: "image_base64 invalido (nao decodifica)." }, 400);
        }
        const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
        if (bytes.length > MAX_IMAGE_BYTES) return json({ error: `Imagem com ${bytes.length} bytes excede o limite de 4MB.` }, 400);
        // Formato pelos MAGIC BYTES (nunca confiar no prefixo data:): png/jpeg/webp.
        let ext = "", mime = "";
        if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) { ext = "png"; mime = "image/png"; }
        else if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) { ext = "jpg"; mime = "image/jpeg"; }
        else if (bytes.length > 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) { ext = "webp"; mime = "image/webp"; }
        else return json({ error: "Bytes nao sao png, jpeg nem webp (magic bytes desconhecidos)." }, 400);
        const resolved = await resolveChat(to, instance);
        if (resolved.error) return json({ ok: false, error: resolved.error });
        if (resolved.candidates) return json({ ok: true, ambiguous: true, candidates: resolved.candidates, hint: "2+ chats casam com esse destinatario. NAO escolha sozinho: mostre os candidatos ao usuario e reenvie com o chat_id exato confirmado." });
        const targetInstance = (instance ? await resolveInstanceKey(instance) : null) ?? resolved.instance_id;
        const vgi = await runVoiceGate([caption], targetInstance, params, "send_image");
        if (vgi.block) return vgi.block;
        const storagePath = `outbound/${targetInstance}/${resolved.chat_id}/${crypto.randomUUID()}.${ext}`;
        const { error: upErr } = await supabase.storage.from("whatsapp-images").upload(storagePath, bytes, { contentType: mime, upsert: false });
        if (upErr) return json({ error: `Storage upload: ${upErr.message}` }, 500);
        const { data: signed, error: signErr } = await supabase.storage.from("whatsapp-images").createSignedUrl(storagePath, 3600);
        if (signErr || !signed?.signedUrl) return json({ error: `Signed URL: ${signErr?.message ?? "sem url"}` }, 500);
        const { status, data } = await callEdge("send-message", { chat_id: resolved.chat_id, content: caption, message_type: "image", media_url: signed.signedUrl, confirmed: true, agent_name: agent_name || "mcp-api", instance: targetInstance });
        if (status >= 400) return json({ ok: false, error: data?.error || `send-message ${status}`, detail: data, storage_path: storagePath }, status);
        return json({ ok: true, ...data, to: resolved.chat_name, instance: targetInstance, storage_path: storagePath, image: { format: ext, bytes: bytes.length }, ...(vgi.warnings?.length && { voice_warnings: vgi.warnings }) });
      }

      case "schedule": {
        // Agendamento de sequencia de mensagens (0049). Valida tudo AQUI na criacao;
        // o worker dispatch-scheduled so drena a fila e reusa as edges de envio.
        // Gate confirmed e satisfeito na criacao — o disparo roda confirmed=true.
        const { to, at, items, instance, agent_name, confirmed = false } = params;
        const when = new Date(at);
        if (!at || isNaN(when.getTime())) return json({ error: "Parametro 'at' invalido. Use ISO-8601 COM offset (ex: 2026-07-15T09:30:00-03:00)." }, 400);
        if (when.getTime() <= Date.now()) return json({ error: `'at' precisa ser futuro. Agora e ${toBRT(new Date().toISOString())}.` }, 400);
        if (!Array.isArray(items) || items.length < 1 || items.length > 10) return json({ error: "items: array de 1 a 10 itens." }, 400);
        const SCHED_MEDIA = new Set(["image", "audio", "ptt", "video", "document"]);
        const SCHED_TYPES = new Set(["text", ...SCHED_MEDIA, "voice", "poll"]);
        const problems: string[] = [];
        items.forEach((it: any, i: number) => {
          if (!it?.type || !SCHED_TYPES.has(it.type)) { problems.push(`item ${i}: type invalido (${it?.type})`); return; }
          if (it.type === "text" && !it.content) problems.push(`item ${i}: text exige content`);
          if (SCHED_MEDIA.has(it.type) && !/^https?:\/\//.test(String(it.media_url ?? ""))) problems.push(`item ${i}: ${it.type} exige media_url http(s)`);
          if (it.type === "voice" && (!it.content || String(it.content).length > 5000)) problems.push(`item ${i}: voice exige content (1-5000 chars)`);
          if (it.type === "poll" && (!it.question || !Array.isArray(it.options) || it.options.length < 2 || it.options.length > 12)) problems.push(`item ${i}: poll exige question + options (2-12)`);
          if (it.link && it.type !== "text") problems.push(`item ${i}: link so em type text`);
          if (it.delay_after !== undefined && (typeof it.delay_after !== "number" || it.delay_after < 0 || it.delay_after > 300)) problems.push(`item ${i}: delay_after 0-300s`);
        });
        if (problems.length) return json({ error: "items invalidos", problems }, 400);
        const resolved = await resolveChat(to, instance);
        if (resolved.error) return json({ ok: false, error: resolved.error });
        if (resolved.candidates) return json({ ok: true, ambiguous: true, candidates: resolved.candidates, hint: "2+ chats casam com esse destinatario. NAO escolha sozinho: mostre os candidatos ao usuario e reenvie com o chat_id exato confirmado." });
        const targetInstance = (instance ? await resolveInstanceKey(instance) : null) ?? resolved.instance_id;
        if (!targetInstance) return json({ error: "Instancia nao resolvida — chat nao existe no banco; passe 'instance' e um chat_id exato, ou envie o primeiro contato manualmente antes de agendar." }, 400);
        const signedUrl = items.some((it: any) => String(it.media_url ?? "").includes("/storage/v1/object/sign/"));
        const warning = signedUrl ? "media_url com signed URL do Storage — provavelmente EXPIRA antes do disparo. Use URL publica." : undefined;
        const preview = items.map((it: any, i: number) =>
          `${i + 1}. [${it.type}] ${String(it.content ?? it.question ?? it.media_url ?? "").slice(0, 80)}`);
        if (!confirmed) return json({
          blocked: true, needs_confirmation: true, to: resolved.chat_name, instance: targetInstance,
          scheduled_at: when.toISOString(), scheduled_at_brt: toBRT(when.toISOString()), items: preview,
          ...(warning && { warning }),
          instruction: "Mostre destinatario + horario (BRT) + itens ao usuario e so reenvie com confirmed:true apos ele confirmar.",
        });
        const vgs = await runVoiceGate(scheduleGateTexts(items), targetInstance, params, "schedule");
        if (vgs.block) return vgs.block;
        const { data: ins, error: insErr } = await supabase.from("scheduled_sequences").insert({
          instance_id: targetInstance, chat_id: resolved.chat_id, chat_name: resolved.chat_name,
          scheduled_at: when.toISOString(), items, created_by: agent_name || "mcp-api",
        }).select("id").single();
        if (insErr) return json({ error: insErr.message }, 500);
        return json({
          ok: true, id: ins.id, chat: resolved.chat_name, instance: targetInstance,
          scheduled_at: when.toISOString(), scheduled_at_brt: toBRT(when.toISOString()),
          items_total: items.length, ...(warning && { warning }),
          ...(vgs.warnings?.length && { voice_warnings: vgs.warnings }),
          hint: "Agendado. Use list_scheduled pra acompanhar e cancel_scheduled(id) pra cancelar enquanto pending.",
        });
      }

      case "list_scheduled": {
        const { status = "pending", chat, instance, limit = 20 } = params;
        let q = supabase.from("scheduled_sequences")
          .select("id, instance_id, chat_id, chat_name, scheduled_at, status, items, items_sent, error, created_at")
          .order("scheduled_at", { ascending: true })
          .limit(Math.min(50, Number(limit) || 20));
        if (status !== "all") q = q.eq("status", status);
        if (instance) {
          const k = await resolveInstanceKey(instance);
          if (!k) return json({ error: `Instancia "${instance}" nao encontrada.` }, 400);
          q = q.eq("instance_id", k);
        }
        if (chat) {
          const r = await resolveChat(chat, instance);
          if (r.error) return json({ error: r.error }, 400);
          if (r.candidates) return json({ ok: true, ambiguous: true, candidates: r.candidates });
          q = q.eq("chat_id", r.chat_id);
        }
        const { data, error } = await q;
        if (error) return json({ error: error.message }, 500);
        return json({
          ok: true, total: data?.length ?? 0,
          scheduled: (data ?? []).map((s: any) => ({
            id: s.id, chat: s.chat_name ?? s.chat_id, instance: s.instance_id,
            scheduled_at: s.scheduled_at, scheduled_at_brt: toBRT(s.scheduled_at),
            status: s.status, items_sent: s.items_sent,
            items_total: Array.isArray(s.items) ? s.items.length : 0,
            first_item: Array.isArray(s.items) && s.items[0]
              ? `[${s.items[0].type}] ${String(s.items[0].content ?? s.items[0].question ?? s.items[0].media_url ?? "").slice(0, 60)}` : null,
            ...(s.error && { error: s.error }),
          })),
        });
      }

      case "cancel_scheduled": {
        const { id } = params;
        if (!id) return json({ error: "id obrigatorio (UUID de list_scheduled ou do schedule)." }, 400);
        // Claim otimista: so cancela se ainda pending (processing/sent/failed nao volta).
        const { data: rows, error } = await supabase.from("scheduled_sequences")
          .update({ status: "canceled", finished_at: new Date().toISOString() })
          .eq("id", id).eq("status", "pending")
          .select("id, chat_name, scheduled_at");
        if (error) return json({ error: error.message }, 500);
        if (!rows?.length) {
          const { data: cur } = await supabase.from("scheduled_sequences").select("status").eq("id", id).maybeSingle();
          return json({ ok: false, error: cur ? `Agendamento nao esta pending (status atual: ${cur.status}).` : "Agendamento nao encontrado." }, 400);
        }
        return json({ ok: true, canceled: true, id, chat: rows[0].chat_name, scheduled_at_brt: toBRT(rows[0].scheduled_at) });
      }

      case "react": {
        const { message_id, chat, target = "last", emoji, instance } = params;
        let msg: any = null;
        if (message_id) {
          const { data, error } = await supabase.from("messages").select("provider_msg_id,chat_id,instance_id,content,message_type,from_me,message_ts").eq("id", message_id).single();
          if (error || !data) return json({ error: error?.message || "mensagem nao encontrada" }, 404);
          msg = data;
        } else if (chat) {
          const r = await resolveTargetMessage(chat, target, instance);
          if (r.error) return json({ ok: false, error: r.error }, r.status ?? 400);
          if (r.candidates) return json({ ok: true, ambiguous: true, candidates: r.candidates });
          msg = r.msg;
        } else {
          return json({ error: "Forneca message_id OU chat (com target opcional)." }, 400);
        }
        const phone = phoneForAction(msg.chat_id);
        const { status, data } = await callEdge("wa-proxy", { action: "send-reaction", params: { phone, messageId: msg.provider_msg_id, reaction: emoji }, agent_name: "mcp-api", agent_request_id: crypto.randomUUID(), instance: msg.instance_id });
        if (status >= 400) return json({ ok: false, error: data?.error || `zapi ${status}` }, status);
        // Preview da mensagem alvo: confirma que reagiu na certa sem precisar de read.
        return json({ ok: true, reacted: true, emoji, target_message: messagePreview(msg), result: data?.result });
      }

      case "edit_message": {
        const { message_id, chat, target = "last_sent", new_content, instance, confirmed = false } = params;
        // Resolve o alvo ANTES do gate de confirmacao: o blocked devolve o preview
        // + message_id concreto, e o reenvio confirmado usa o message_id (nunca
        // re-resolve posicional — msg nova no meio mudaria o alvo).
        let msg: any;
        if (message_id) {
          const { data, error } = await supabase.from("messages").select("id,provider_msg_id,chat_id,from_me,message_ts,message_type,content,caption,instance_id").eq("id", message_id).single();
          if (error || !data) return json({ error: error?.message || "mensagem nao encontrada" }, 404);
          msg = data;
        } else if (chat) {
          const r = await resolveTargetMessage(chat, target, instance);
          if (r.error) return json({ ok: false, error: r.error }, r.status ?? 400);
          if (r.candidates) return json({ ok: true, ambiguous: true, candidates: r.candidates });
          msg = r.msg;
        } else {
          return json({ error: "Forneca message_id OU chat (com target opcional)." }, 400);
        }
        if (!msg.from_me) return json({ error: "Nao da pra editar msg de outros." }, 400);
        // Tipos com legenda editavel na Z-API: cada um usa um campo edit*MessageId
        // proprio (docs developer.z-api.io, verificado 15/07/2026) — texto puro usa
        // editMessageId em /send-text; imagem/video/documento usam edit{Tipo}MessageId
        // no endpoint de envio do PROPRIO tipo. Audio/sticker/poll/location seguem sem
        // suporte (Z-API nao documenta edit pra eles).
        const EDITABLE: Record<string, { action: string; field: string; bodyKey: string; column: "content" | "caption" }> = {
          text:     { action: "send-text",     field: "editMessageId",         bodyKey: "message", column: "content" },
          chat:     { action: "send-text",     field: "editMessageId",         bodyKey: "message", column: "content" },
          image:    { action: "send-image",    field: "editImageMessageId",    bodyKey: "caption",  column: "caption" },
          video:    { action: "send-video",    field: "editVideoMessageId",    bodyKey: "caption",  column: "caption" },
          document: { action: "send-document", field: "editDocumentMessageId", bodyKey: "caption",  column: "caption" },
        };
        const rule = EDITABLE[msg.message_type as string];
        if (!rule) return json({ error: `Tipo "${msg.message_type}" nao suporta edicao (so texto/imagem/video/documento).` }, 400);
        const ageMs = Date.now() - (msg.message_ts ? new Date(msg.message_ts).getTime() : 0);
        if (ageMs > 15 * 60 * 1000) return json({ error: `Janela de 15min expirada. Use delete + send.` }, 400);
        if (!confirmed) return json({ blocked: true, needs_confirmation: true, message_id: msg.id, target_message: messagePreview(msg), new_content, instruction: "Mostre a mensagem e o novo texto ao usuario; reenvie com confirmed:true e ESTE message_id apos ele confirmar." });
        const vge = await runVoiceGate([new_content], msg.instance_id, params, "edit_message");
        if (vge.block) return vge.block;
        const phone = phoneForAction(msg.chat_id);
        const zapiParams: Record<string, unknown> = { phone, [rule.bodyKey]: new_content, [rule.field]: msg.provider_msg_id };
        const { status, data } = await callEdge("wa-proxy", { action: rule.action, params: zapiParams, confirmed: true, agent_name: "mcp-api", agent_request_id: crypto.randomUUID(), instance: msg.instance_id });
        if (status >= 400) return json({ ok: false, error: data?.error || `zapi ${status}` }, status);
        await supabase.from("messages").update({ [rule.column]: new_content, is_edited: true }).eq("id", msg.id);
        return json({ ok: true, edited: true, message_id: msg.id, new_content, type: msg.message_type, ...(vge.warnings?.length && { voice_warnings: vge.warnings }) });
      }

      case "delete_message": {
        const { message_id, chat, target = "last_sent", instance, confirmed = false } = params;
        let msg: any;
        if (message_id) {
          const { data, error } = await supabase.from("messages").select("id,provider_msg_id,chat_id,from_me,message_ts,message_type,content,instance_id").eq("id", message_id).single();
          if (error || !data) return json({ error: error?.message || "mensagem nao encontrada" }, 404);
          msg = data;
        } else if (chat) {
          const r = await resolveTargetMessage(chat, target, instance);
          if (r.error) return json({ ok: false, error: r.error }, r.status ?? 400);
          if (r.candidates) return json({ ok: true, ambiguous: true, candidates: r.candidates });
          msg = r.msg;
        } else {
          return json({ error: "Forneca message_id OU chat (com target opcional)." }, 400);
        }
        if (!confirmed) return json({ blocked: true, needs_confirmation: true, message_id: msg.id, target_message: messagePreview(msg), instruction: "Confirme com o usuario antes de apagar; reenvie com confirmed:true e ESTE message_id." });
        const phone = phoneForAction(msg.chat_id);
        const { status, data } = await callEdge("wa-proxy", { action: "delete-message", params: { phone, messageId: msg.provider_msg_id, owner: !!msg.from_me }, confirmed: true, agent_name: "mcp-api", agent_request_id: crypto.randomUUID(), instance: msg.instance_id });
        if (status >= 400) return json({ ok: false, error: data?.error || `zapi ${status}` }, status);
        await supabase.from("messages").update({ is_deleted: true }).eq("id", msg.id);
        return json({ ok: true, deleted: true, message_id: msg.id });
      }

      case "zapi_action": {
        // ZAPI_SEND_ACTIONS/extracao de texto vivem em _shared/wa/gate-inputs.ts
        // (funcoes puras com teste proprio — a fiacao daqui nao tem harness).
        const { action: zaction, params: zparams = {}, confirmed = false, instance } = params;
        // forward posicional: from_chat (+target) resolve messageId/messagePhone aqui.
        // Antes o forward era inviavel na pratica: exigia o provider_msg_id, que o
        // read nem devolve. Resolucao ANTES do gate — o blocked ecoa os params
        // concretos e o reenvio confirmado usa messageId direto (sem re-resolver).
        if ((zaction === "forward" || zaction === "forward-message") && !zparams.messageId && zparams.from_chat) {
          const r = await resolveTargetMessage(zparams.from_chat, zparams.target ?? "last", instance);
          if (r.error) return json({ ok: false, error: r.error }, r.status ?? 400);
          if (r.candidates) return json({ ok: true, ambiguous: true, candidates: r.candidates });
          zparams.messageId = r.msg.provider_msg_id;
          zparams.messagePhone = phoneForAction(r.msg.chat_id);
          zparams._target_message = messagePreview(r.msg);
          delete zparams.from_chat; delete zparams.target;
        }
        if (ZAPI_SEND_ACTIONS.has(zaction) && !confirmed) return json({ blocked: true, needs_confirmation: true, action: zaction, params: zparams, instruction: `A action "${zaction}" envia conteudo. Mostre ao usuario e reenvie com confirmed:true apos confirmacao.` });
        delete zparams._target_message;
        // Voice gate tambem no passthrough (auditoria 18/07): send-text/send-message/
        // edit-message/send-poll carregam texto livre — sem isto o zapi_action seria
        // bypass do gate das 5 tools oficiais. Sem `instance` explicita o wa-proxy
        // usa a default, entao o gate resolve pela default tambem (nunca fica sem gate).
        if (ZAPI_SEND_ACTIONS.has(zaction)) {
          const gateInstance = defaultGateInstance(await loadInstances(), instance ? await resolveInstanceKey(instance) : null);
          const vgz = await runVoiceGate(zapiGateTexts(zparams), gateInstance, params, "zapi_action:" + zaction);
          if (vgz.block) return vgz.block;
        }
        const { status, data } = await callEdge("wa-proxy", { action: zaction, params: zparams, confirmed: true, agent_name: "mcp-api", agent_request_id: crypto.randomUUID(), instance });
        if (status >= 400) return json({ ok: false, error: data?.error || `zapi ${status}`, detail: data }, status);
        return json({ ok: true, action: zaction, result: data?.result });
      }

      case "transcribe": {
        const { message_id, chat, limit = 20, instance } = params;
        if (!OPENAI_API_KEY) return json({ error: "OPENAI_API_KEY nao configurada" }, 400);
        if (!message_id && !chat) return json({ error: "Forneca message_id OU chat." }, 400);
        let candidates: any[];
        if (message_id) {
          const { data, error } = await supabase.from("messages").select("id,chat_id,message_type,content").eq("id", message_id).single();
          if (error) return json({ error: error.message }, 404);
          if (!AUDIO_TYPES.has(data.message_type)) return json({ error: `Mensagem nao e audio (tipo=${data.message_type}).` }, 400);
          candidates = [data];
        } else {
          const resolved = await resolveChat(chat, instance);
          if (resolved.error) return json({ error: resolved.error }, 400);
          if (resolved.candidates) return json({ ok: true, ambiguous: true, candidates: resolved.candidates });
          let aq = supabase.from("messages").select("id,chat_id,message_type,content").eq("chat_id", resolved.chat_id)
            .in("message_type", Array.from(AUDIO_TYPES)).or("content.is.null,content.eq.").order("message_ts", { ascending: false, nullsFirst: false }).limit(limit);
          if (resolved.instance_id) aq = aq.eq("instance_id", resolved.instance_id);
          const { data, error } = await aq;
          if (error) return json({ error: error.message }, 500);
          candidates = data || [];
        }
        if (!candidates.length) return json({ ok: true, transcribed: 0, skipped: 0, message: "Nenhum audio pendente" });
        const enriched = await enrichWithTranscriptions(candidates);
        const transcribed = enriched.filter(m => m.transcription && !String(m.transcription).startsWith("Erro")).length;
        return json({ ok: true, transcribed, failed: enriched.length - transcribed, total: enriched.length, results: enriched.map(m => ({ id: m.id, chat_id: m.chat_id, transcription: m.transcription })) });
      }

      case "sync_groups": {
        const { dry_run = false, instance } = params;
        const instRows = await loadInstances();
        const targetInst = instance ? await resolveInstanceKey(instance) : (instRows.find((i: any) => i.is_default)?.instance_id ?? instRows[0]?.instance_id);
        if (instance && !targetInst) return json({ error: `Instancia "${instance}" nao encontrada.` }, 400);
        const { status, data: zr } = await callEdge("wa-proxy", { action: "chats", method: "GET", agent_name: "mcp-api", instance: targetInst });
        if (status >= 400) return json({ ok: false, error: zr?.error || `zapi ${status}` }, status);
        const result: any[] = Array.isArray(zr?.result) ? zr.result : [];
        if (!result.length) return json({ ok: true, message: "Nenhum grupo encontrado.", total_groups: 0 });
        const updated: any[] = [], not_found: any[] = [];
        for (const g of result) {
          const rawPhone = String(g.chatId || "");
          const phone = rawPhone.replace(/[^0-9]/g, "");
          const name = g.name || null;
          if (!phone || !name) continue;
          if (dry_run) { updated.push({ phone, name, dry_run: true }); continue; }
          let matched = false;
          for (const chat_id of [`${phone}@g.us`, `${phone}-group`, phone, rawPhone]) {
            let uq = supabase.from("chats").update({ chat_name: name }).eq("chat_id", chat_id).eq("is_group", true);
            if (targetInst) uq = uq.eq("instance_id", targetInst);
            const { data: rows, error } = await uq.select("chat_id");
            if (!error && rows?.length) { updated.push({ chat_id, name }); matched = true; break; }
          }
          if (!matched) not_found.push({ phone, name });
        }
        return json({ ok: true, total_groups: result.length, updated_count: updated.length, not_found_count: not_found.length, updated, ...(not_found.length && { not_found }), dry_run });
      }

      case "get_voice_guide": {
        const g = await loadVoiceGuide(params.instance ? await resolveInstanceKey(params.instance) : null);
        if (!g) return json({ ok: true, configured: false, message: "Voice guide nao configurado. Insira o markdown em public.voice_guide (content; instance_id NULL = global).", hard_rules: HARD_RULES.map((r) => ({ id: r.id, severity: r.severity })) });
        return json({ ok: true, configured: true, scope: g.instance_id ?? "global", updated_at: g.updated_at, content: g.content });
      }

      case "check_message": {
        // content: string OU array de strings (burst) — o array habilita os sinais
        // estruturais de conjunto (burst inflado, caixa uniforme cross-msgs).
        const g = await loadVoiceGuide(params.instance ? await resolveInstanceKey(params.instance) : null);
        const customRules = compileCustomRules(g?.checks);
        const messages: any[] = Array.isArray(params.content) ? params.content : [params.content];
        const violations: any[] = [];
        const seen = new Set<string>();
        for (const m of messages) {
          for (const v of checkVoiceViolations(m, customRules)) {
            const key = v.id + "|" + v.match;
            if (!seen.has(key)) { seen.add(key); violations.push(v); }
          }
        }
        const soft_warnings = checkSoftSignals(params.content, g?.checks?.soft);
        const score = computeVoiceScore(violations, soft_warnings);
        return json({
          ok: true, score,
          has_violations: violations.length > 0, violations_count: violations.length, violations,
          soft_warnings_count: soft_warnings.length, soft_warnings,
          ...(g?.checks ? {} : { note: "Calibracao pessoal (voice_guide.checks) nao configurada — rodando so regras universais com defaults neutros." }),
          hint: score < 7
            ? "Score abaixo de 7: regenere a mensagem. Use get_voice_guide pra ler o documento e reescrever respeitando as regras."
            : (violations.length || soft_warnings.length)
              ? "Score aceitavel, mas revise os warnings antes de enviar."
              : "Nenhuma violacao. Texto compativel com o voice guide.",
        });
      }

      case "setup_voice_guide": {
        const g = await loadVoiceGuide(params.instance ? await resolveInstanceKey(params.instance) : null);
        return json({
          ok: true,
          status: g ? "active" : "not_configured",
          ...(g ? { scope: g.instance_id ?? "global", content_length: g.content.length, updated_at: g.updated_at,
                    checks_configured: !!g.checks, custom_hard_rules: compileCustomRules(g.checks).length }
                : { setup: "INSERT INTO voice_guide (content) VALUES ('<seu markdown>'); -- instance_id NULL = global. Calibracao pessoal do check: coluna checks (ver 0032_voice_checks.sql)." }),
          hard_rules: HARD_RULES.map((r) => ({ id: r.id, severity: r.severity, message: r.message })),
        });
      }

      case "check_delivery": {
        // Verificacao de entrega: o process-webhook ja grava delivered/read no
        // send_status via MessageStatusCallback; aqui esse dado vira acao. Mensagem
        // de agente presa em sent/pending e o sintoma classico de chat fantasma.
        const { message_id, chat, limit = 10, instance } = params;
        if (!message_id && !chat) return json({ error: "Forneca message_id OU chat." }, 400);
        let q = supabase.from("messages")
          .select("id,chat_id,instance_id,message_type,content,send_status,send_error,message_ts")
          .eq("from_me", true).eq("sent_by_agent", true)
          .order("message_ts", { ascending: false }).limit(Math.min(50, Number(limit) || 10));
        if (message_id) q = q.eq("id", message_id);
        else {
          const resolved = await resolveChat(chat, instance);
          if (resolved.error) return json({ error: resolved.error }, 400);
          if (resolved.candidates) return json({ ok: true, ambiguous: true, candidates: resolved.candidates });
          q = q.eq("chat_id", resolved.chat_id);
          if (resolved.instance_id) q = q.eq("instance_id", resolved.instance_id);
        }
        const { data: rows, error } = await q;
        if (error) return json({ error: error.message }, 500);
        if (!rows?.length) return json({ ok: true, messages: [], message: "Nenhuma mensagem de agente encontrada." });
        const STUCK_MS = 2 * 60 * 1000;
        const out = rows.map((m: any) => {
          const ageMs = m.message_ts ? Date.now() - new Date(m.message_ts).getTime() : 0;
          const delivered = m.send_status === "delivered" || m.send_status === "read";
          const stuck = !delivered && (m.send_status === "sent" || m.send_status === "pending") && ageMs > STUCK_MS;
          return { id: m.id, chat_id: m.chat_id, instance: m.instance_id, send_status: m.send_status,
                   ...(m.send_error && { send_error: m.send_error }), message_ts: m.message_ts, message_ts_brt: toBRT(m.message_ts),
                   preview: (m.content || `[${m.message_type}]`).slice(0, 80), delivered, stuck };
        });
        const stuckCount = out.filter((m: any) => m.stuck).length;
        return json({ ok: true, messages: out, stuck_count: stuckCount,
          ...(stuckCount ? { alert: "Mensagem(ns) sem confirmacao de entrega ha 2+ min. Possivel chat fantasma do 9o digito: rode merge_ghost_chats (dry_run) e confira o numero canonico via zapi_action phone-exists." } : {}) });
      }

      case "merge_ghost_chats": {
        // Funde pares real+fantasma do 9o digito ja existentes no banco.
        // dry_run=true (default) so lista o que seria feito.
        const { dry_run = true } = params;
        const { data, error } = await supabase.rpc("merge_ninth_digit_ghosts", { p_dry_run: dry_run !== false });
        if (error) return json({ error: error.message, hint: "Migration 0031_merge_ninth_digit_ghosts.sql aplicada?" }, 500);
        const rows = data || [];
        return json({ ok: true, dry_run: dry_run !== false, pairs: rows.length, results: rows });
      }

      default: return json({ error: "action_not_implemented", action }, 400);
    }
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
}

// ─── MCP-over-HTTP (JSON-RPC 2.0, transport HTTP stateless) ───────────────────
// Nome da tool MCP -> action interna (quando o nome diverge da action).
const TOOL_TO_ACTION: Record<string, string> = {
  transcribe_audio: "transcribe",
  categorize_chat: "categorize",
  uncategorize_chat: "uncategorize",
  annotate_chat: "annotate",
  resolve_chat: "resolve",
};

function rpc(id: any, payload: Record<string, unknown>): Response {
  return json({ jsonrpc: "2.0", id: id ?? null, ...payload });
}
const rpcResult = (id: any, result: unknown) => rpc(id, { result });
const rpcError = (id: any, code: number, message: string) => rpc(id, { error: { code, message } });

const SERVER_INFO = { name: "whatsapp-agent", version: "3.4.0" };
const PROTOCOL_VERSION = "2024-11-05";

// Schemas expostos no tools/list.
const TOOL_SCHEMAS = [
  {
    name: "status",
    description: "Verifica se o WhatsApp esta conectado e funcionando (conexao Z-API + stats por instancia).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "inbox",
    description: "Lista conversas com a ultima mensagem de cada. Use waiting_on:'me' para 'do que estou devendo / quem espera resposta' (o contato mandou por ultimo E o chat nao foi marcado resolvido) — combine com min_idle_days pra so as paradas ha N+ dias; o resultado ja vem ordenado por mais parado primeiro e traz idle_days por chat. Grupo nunca conta como esperando. Chats 90+ dias parados ficam dormentes (ocultos por padrao no filtro 'me'). Na triagem: chat que o usuario descartar ('esse ignora', 'nao vou responder') = chamar resolve_chat nele na hora. Filtra tambem por categoria e grupos.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max de chats (default 15)" },
        since: { type: "string", description: "ISO timestamp — so chats com atividade apos esta data" },
        waiting_on: { type: "string", enum: ["me", "lead", "none", "resolved"], description: "Filtra por quem deve responder agora ('me' = voce esta devendo; 'resolved' = marcados resolvidos ainda sem resposta nova)" },
        exclude_groups: { type: "boolean", description: "Se true, ignora grupos (so 1:1)" },
        category_slugs: { type: "array", items: { type: "string" }, description: "So chats com pelo menos uma destas categorias" },
        exclude_categories: { type: "array", items: { type: "string" }, description: "Exclui chats com qualquer destas categorias (ex.: descartar, comunidade)" },
        min_idle_days: { type: "number", description: "So chats parados ha N+ dias (pela ultima msg relevante). Ordena por mais parado primeiro e desliga o corte de dormentes." },
        include_dormant: { type: "boolean", description: "Inclui os dormentes (90+ dias parados) no filtro waiting_on:'me'" },
        instance: { type: "string", description: "Filtra por instancia (alias 'pessoal'/'profissional' ou instance_id)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "resolve_chat",
    description: "Marca a conversa como resolvida: sai do 'esperando resposta' mesmo que a ultima palavra tenha sido do contato (ex.: cortesia tipo 'obrigado'). CHAME PROATIVAMENTE quando o usuario sinalizar encerramento de qualquer jeito ('ignora esse', 'nao precisa responder', 'deixa', 'ja resolvi', descarte durante triagem de inbox) — nao exija a palavra 'resolve' nem peca confirmacao. REABRE SOZINHA se a pessoa mandar mensagem nova. snooze_until adia a cobranca ate uma data ('nao me lembra ate segunda') — tambem reabre antes se responderem. reopen:true desfaz manualmente. Nao e preciso apos send (responder ja zera a pendencia).",
    inputSchema: {
      type: "object",
      properties: {
        chat: { type: "string", description: "Nome, telefone ou chat_id da conversa" },
        snooze_until: { type: "string", description: "ISO 8601 futuro — esconde ate esta data em vez de resolver de vez" },
        reopen: { type: "boolean", description: "true = desfaz o resolvido/snooze (volta a contar como esperando)" },
        instance: { type: "string", description: "Instancia (alias ou instance_id)" },
      },
      required: ["chat"],
      additionalProperties: false,
    },
  },
  {
    name: "read",
    description: "Le as mensagens de uma conversa em ordem cronologica e JA transcreve os audios pendentes (Whisper) — use pra 'transcreve/resume a conversa com X' ou 'o que o fulano mandou'. 'chat' aceita nome, telefone ou chat_id; se ambiguo, retorna candidatos. Cada audio vem com o campo transcription. Se o chat tiver voice_profile, ele vem na resposta: ESPELHE ao redigir pra esse contato — chame a pessoa pelos vocativos de como_chamo (como o dono a chama), e module intimidade pelo como_me_chama/girias/registro dela (soma ao voice guide global).",
    inputSchema: {
      type: "object",
      properties: {
        chat: { type: "string", description: "Nome, telefone ou chat_id da conversa" },
        limit: { type: "number", description: "Numero de mensagens mais recentes (default 30)" },
        before: { type: "string", description: "ISO timestamp — mensagens anteriores a esta data (paginar)" },
        instance: { type: "string", description: "Instancia (alias ou instance_id)" },
      },
      required: ["chat"],
      additionalProperties: false,
    },
  },
  {
    name: "send",
    description: "Envia mensagem (texto ou midia) pra contato/grupo. FLUXO OBRIGATORIO: 1a chamada SEM confirmed (mostra destinatario+conteudo e bloqueia); 2a com confirmed:true apos o usuario confirmar. 'to' aceita nome/telefone/chat_id. Antes de redigir, leia o chat (read): se houver voice_profile, chame a pessoa pelo vocativo de como_chamo e espelhe as girias/registro dela.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Destinatario: nome, telefone ou chat_id" },
        content: { type: "string", description: "Texto ou legenda da midia" },
        type: { type: "string", enum: ["text", "image", "audio", "ptt", "video", "document"], description: "Tipo (default text)" },
        media_url: { type: "string", description: "URL publica da midia (obrigatorio se type != text)" },
        file_name: { type: "string", description: "Nome do arquivo para type=document" },
        reply_to: { type: "string", description: "Mensagem a citar (quote): 'last' | 'last_received' | 'last_sent' (posicional, dispensa read) ou UUID de read/search" },
        confirmed: { type: "boolean", description: "OBRIGATORIO true para enviar; so apos o usuario confirmar" },
        confirmed_voice: { type: "boolean", description: "Bypassa o voice gate (instancias em modo block). SO quando o dono aprovou explicitamente o texto exato apos ver as violacoes — nunca por iniciativa propria" },
        allow_new: { type: "boolean", description: "Permite enviar pra numero novo (primeiro contato); exige instance" },
        humanize: { type: "boolean", description: "Calcula delay_typing automatico por tamanho/tipo (default true)" },
        delay_typing: { type: "number", description: "Override do delay de digitacao (0-15s)" },
        delay_message: { type: "number", description: "Atraso antes de enviar (0-15s)" },
        mentions: { type: "array", items: { type: "string" }, description: "Phones pra mencionar (so em grupos)" },
        mentions_everyone: { type: "boolean", description: "Menciona @todos no grupo" },
        force_send_after_inbound: { type: "boolean", description: "Ignora o gate de inbound recente nao respondido" },
        instance: { type: "string", description: "De qual numero enviar (alias ou instance_id)" },
        link: {
          type: "object",
          description: "Card de preview de link (so type=text). Renderiza a URL como card com imagem/titulo/descricao. A URL e anexada ao content automaticamente se nao estiver nele.",
          properties: {
            url: { type: "string", description: "URL do link (obrigatoria)" },
            title: { type: "string", description: "Titulo do card (default: a URL)" },
            description: { type: "string", description: "Descricao curta do card" },
            image: { type: "string", description: "URL da imagem do card (ex: og:image da pagina)" },
            previewSize: { type: "string", enum: ["SMALL", "MEDIUM", "LARGE"], description: "Tamanho do card (default do provider)" },
          },
          required: ["url"],
          additionalProperties: false,
        },
      },
      required: ["to"],
      additionalProperties: false,
    },
  },
  {
    name: "send_voice",
    description: "Gera audio TTS (ElevenLabs) e envia como mensagem de voz (PTT). SO quando o usuario pediu audio EXPLICITAMENTE (texto e o canal default). PREFIRA `profile` (catalogo voice_profiles no banco, settings travados server-side) — chamada com perfil inexistente/bloqueado retorna erro COM A LISTA dos perfis ativos da instalacao: use essa lista como fonte, nao adivinhe nomes; rotulo vago do usuario ('voz antiga') = listar candidatos e perguntar. Convencao de catalogo: 'casual' (DEFAULT conversa em curso), 'profissional' (lead novo, decisor, 1a abordagem, B2B). HUMANIZACAO e server-side pelo perfil — envie texto LIMPO com acentuacao correta (retorno traz text_spoken). FLUXO OBRIGATORIO: 1a chamada SEM confirmed (bloqueia e mostra resumo); 2a com confirmed:true apos o usuario confirmar; EXCECAO audio pro proprio dono ja pedido explicito = confirmed:true direto. Legacy: voice_id explicito com settings manuais; sem profile e sem voice_id usa a voz default da instancia. Max ~150 palavras (~60s).",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Destinatario: chat_id ou phone" },
        text: { type: "string", description: "Texto a converter em fala (max 5000). Limpo, com acentos — a humanizacao oral e server-side" },
        profile: { type: "string", description: "Perfil do catalogo voice_profiles (ex: casual). Trava voice_id/model/settings server-side. Nao combinar com voice_id" },
        voice_id: { type: "string", description: "ElevenLabs voice ID (legado/avancado — prefira profile)" },
        model_id: { type: "string", description: "Modelo ElevenLabs (default eleven_turbo_v2_5; ignorado com profile)" },
        stability: { type: "number", description: "0-1 (default 0.45; ignorado com profile)" },
        similarity_boost: { type: "number", description: "0-1 (default 0.75; ignorado com profile)" },
        style: { type: "number", description: "0-1 (default 0.30; ignorado com profile)" },
        speed: { type: "number", description: "0.7-1.2 (default 0.95; ignorado com profile)" },
        confirmed: { type: "boolean", description: "OBRIGATORIO true; so apos confirmacao explicita" },
        confirmed_voice: { type: "boolean", description: "Bypassa o voice gate (instancias em modo block). SO quando o dono aprovou explicitamente o texto exato apos ver as violacoes — nunca por iniciativa propria" },
        instance: { type: "string", description: "De qual numero enviar (alias ou instance_id)" },
      },
      required: ["to", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "send_image",
    description: "Envia uma imagem GERADA (bytes em base64) hospedando no bucket proprio (whatsapp-images) e enviando por signed URL — pra imagem que o agente/rotina acabou de criar (grafico, card, countdown) e que nao existe em URL publica. Se a imagem JA tem URL http(s), use send com type=image. Formatos: png, jpeg, webp (detectados pelos bytes); max 4MB decodificado. FLUXO OBRIGATORIO: 1a chamada SEM confirmed (bloqueia e mostra resumo); 2a com confirmed:true apos o usuario confirmar; rotina automatizada ja autorizada pelo dono = confirmed:true direto. Retorno traz message_id (confirme com check_delivery) e storage_path.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Destinatario: nome, telefone ou chat_id (o chat precisa existir)" },
        image_base64: { type: "string", description: "Bytes da imagem em base64 (aceita com ou sem prefixo data:image/...;base64,)" },
        caption: { type: "string", description: "Legenda da imagem (opcional)" },
        confirmed: { type: "boolean", description: "OBRIGATORIO true; so apos confirmacao explicita" },
        confirmed_voice: { type: "boolean", description: "Bypassa o voice gate (instancias em modo block). SO quando o dono aprovou explicitamente a legenda exata apos ver as violacoes — nunca por iniciativa propria" },
        instance: { type: "string", description: "De qual numero enviar (alias ou instance_id)" },
      },
      required: ["to", "image_base64"],
      additionalProperties: false,
    },
  },
  {
    name: "search",
    description: "Busca texto nas mensagens. Filtra por chat, categoria (category_slugs) e periodo (after/before). Audios nos resultados vem com transcription.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Texto a buscar (min 2 chars)" },
        chat: { type: "string", description: "Limitar a um chat (nome ou chat_id)" },
        search_in: { type: "string", enum: ["content", "chat_name", "both"], description: "Onde buscar (default both)" },
        category_slugs: { type: "array", items: { type: "string" }, description: "So chats com pelo menos uma destas categorias" },
        exclude_categories: { type: "array", items: { type: "string" }, description: "Exclui chats com qualquer destas" },
        limit: { type: "number", description: "Max resultados (default 20)" },
        after: { type: "string", description: "ISO timestamp — so mensagens apos esta data" },
        before: { type: "string", description: "ISO timestamp — so mensagens antes desta data" },
        instance: { type: "string", description: "Limitar a uma instancia (alias ou instance_id)" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "transcribe_audio",
    description: "Forca transcricao de audios pendentes (grupos, antigos, ou que falharam no cron). Aceita message_id OU chat (ate 20 audios). Salva em messages.content.",
    inputSchema: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "UUID da mensagem — transcreve so essa" },
        chat: { type: "string", description: "Nome/phone/chat_id — transcreve ate 20 audios pendentes" },
        limit: { type: "number", description: "Max audios por chamada com chat (default 20)" },
        instance: { type: "string", description: "Instancia (alias ou instance_id)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "react",
    description: "Reage a uma mensagem com emoji. CAMINHO RAPIDO (preferir): passe chat + target ('last' | 'last_received' | 'last_sent') e a reacao sai em 1 chamada, sem read antes — a resposta traz preview da mensagem alvo. message_id (UUID de read/search) so quando o alvo NAO e a ultima mensagem. String vazia remove a reacao.",
    inputSchema: {
      type: "object",
      properties: {
        chat: { type: "string", description: "Nome ou telefone do chat — reage na ultima mensagem (ver target). Alternativa rapida ao message_id." },
        target: { type: "string", enum: ["last", "last_received", "last_sent"], description: "Com chat: qual mensagem. last = mais recente (default), last_received = ultima DELES, last_sent = ultima MINHA." },
        message_id: { type: "string", description: "UUID da mensagem (campo id de read/search) — so quando o alvo nao e a ultima do chat" },
        emoji: { type: "string", description: "Emoji de reacao (ex: '❤️', '👍'). Vazio remove." },
        instance: { type: "string", description: "Com chat: instancia (alias ou id) quando o chat existe nas duas" },
      },
      required: ["emoji"],
      additionalProperties: false,
    },
  },
  {
    name: "sync_groups",
    description: "Sincroniza nomes de grupos buscando da Z-API (GET /chats). Use quando nomes de grupos estiverem faltando/desatualizados no banco.",
    inputSchema: {
      type: "object",
      properties: {
        dry_run: { type: "boolean", description: "Se true, lista o que seria atualizado sem salvar" },
        instance: { type: "string", description: "De qual instancia sincronizar (alias ou instance_id)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_categories",
    description: "Lista as categorias disponiveis pra classificar chats. Use antes de categorize_chat pra saber os slugs validos.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "categorize_chat",
    description: "Atribui uma ou mais categorias a um chat (idempotente). Use list_categories pra ver slugs validos.",
    inputSchema: {
      type: "object",
      properties: {
        chat: { type: "string", description: "Nome, telefone ou chat_id" },
        category_slugs: { type: "array", items: { type: "string" }, description: "Slugs a aplicar (ex: ['cliente','saude'])" },
        assigned_by: { type: "string", enum: ["manual", "llm"], description: "Origem (default manual)" },
        confidence: { type: "number", description: "0-1, obrigatorio quando assigned_by=llm" },
        notes: { type: "string", description: "Justificativa opcional" },
        instance: { type: "string", description: "Instancia (alias ou instance_id)" },
      },
      required: ["chat", "category_slugs"],
      additionalProperties: false,
    },
  },
  {
    name: "uncategorize_chat",
    description: "Remove uma ou mais categorias de um chat (no-op se nao atribuidas).",
    inputSchema: {
      type: "object",
      properties: {
        chat: { type: "string", description: "Nome, telefone ou chat_id" },
        category_slugs: { type: "array", items: { type: "string" }, description: "Slugs a remover" },
        instance: { type: "string", description: "Instancia (alias ou instance_id)" },
      },
      required: ["chat", "category_slugs"],
      additionalProperties: false,
    },
  },
  {
    name: "annotate_chat",
    description: "Salva observacoes, links e/ou voice_profile de um contato/grupo (aparecem no read). Passe so o campo que quer atualizar. ATENCAO: observations e links SUBSTITUEM o valor inteiro; voice_profile faz MERGE RASO por chave de topo (atualizar girias preserva como_me_chama/como_chamo; arrays substituem; chave null remove; voice_profile:null limpa tudo). Ao notar vocativo ou giria nova numa conversa, atualize o voice_profile com fonte:'incremental'.",
    inputSchema: {
      type: "object",
      properties: {
        chat: { type: "string", description: "Nome, telefone ou chat_id" },
        observations: { type: "string", description: "Texto livre com contexto do contato (substitui o valor atual inteiro)" },
        links: { type: "array", items: { type: "object", properties: { label: { type: "string" }, url: { type: "string" } }, required: ["label", "url"] }, description: "Links relevantes ({label, url})" },
        voice_profile: { type: "object", description: "Perfil de voz do contato: { como_me_chama: string[] (vocativos que a pessoa usa com o dono), como_chamo: string[] (vocativos que o dono usa com ela — extrair SO de mensagem autentica do dono, nunca de msg de agente), girias: string[], registro: string (1 linha), exemplos: string[] (2-3 citacoes <=80 chars), confianca: 'alta'|'media'|'baixa', fonte: 'backfill'|'manual'|'incremental' }. Merge raso — mande so as chaves que mudam. analisado_em e carimbado automaticamente.", additionalProperties: true },
        brain_contact_id: { type: "string", description: "Id do contato no vault Expert Brain (expert-contacts) pra vinculo nativo chat<->contato. null desvincula. So vincule id verificado (get_contact_by_phone), nunca chute." },
        instance: { type: "string", description: "Instancia (alias ou instance_id)" },
      },
      required: ["chat"],
      additionalProperties: false,
    },
  },
  {
    name: "edit_message",
    description: "Edita o texto/legenda de uma mensagem enviada por voce (from_me, ate 15min). Tipos suportados: texto, imagem, video, documento (edita a legenda nesses 3 ultimos) — audio/figurinha/enquete/localizacao nao sao editaveis (limite Z-API). CAMINHO RAPIDO: chat (+target, default last_sent = sua ultima msg) dispensa read previo. FLUXO: 1a SEM confirmed (bloqueia e devolve preview + message_id); 2a com confirmed:true e ESSE message_id.",
    inputSchema: {
      type: "object",
      properties: {
        chat: { type: "string", description: "Nome ou telefone do chat — alvo posicional, dispensa message_id" },
        target: { type: "string", enum: ["last", "last_sent"], description: "Com chat: qual mensagem (default last_sent = sua ultima)" },
        message_id: { type: "string", description: "UUID da mensagem (de read/search ou do blocked)" },
        new_content: { type: "string", description: "Novo texto" },
        instance: { type: "string", description: "Com chat: instancia quando o chat existe nas duas" },
        confirmed: { type: "boolean", description: "OBRIGATORIO true; so apos confirmacao" },
        confirmed_voice: { type: "boolean", description: "Bypassa o voice gate (instancias em modo block). SO quando o dono aprovou explicitamente o novo texto exato apos ver as violacoes — nunca por iniciativa propria" },
      },
      required: ["new_content"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_message",
    description: "Deleta uma mensagem enviada por voce (apaga pra todos). CAMINHO RAPIDO: chat (+target, default last_sent = sua ultima msg) dispensa read previo. FLUXO: 1a SEM confirmed (bloqueia e devolve preview + message_id); 2a com confirmed:true e ESSE message_id.",
    inputSchema: {
      type: "object",
      properties: {
        chat: { type: "string", description: "Nome ou telefone do chat — alvo posicional, dispensa message_id" },
        target: { type: "string", enum: ["last", "last_sent"], description: "Com chat: qual mensagem (default last_sent = sua ultima)" },
        message_id: { type: "string", description: "UUID da mensagem (de read/search ou do blocked)" },
        instance: { type: "string", description: "Com chat: instancia quando o chat existe nas duas" },
        confirmed: { type: "boolean", description: "OBRIGATORIO true; so apos confirmacao" },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "download_attachment",
    description: "Retorna a URL publica de uma midia (imagem/audio/video/documento) do Storage. Precisa do message_id (de read/search).",
    inputSchema: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "UUID da mensagem (de read/search)" },
      },
      required: ["message_id"],
      additionalProperties: false,
    },
  },
  {
    name: "zapi_action",
    description: "Executa acao avancada do provider WhatsApp (Z-API ou Evolution; operacoes infrequentes nao cobertas pelas tools). Actions de envio (send-poll, forward, edit-message) exigem confirmed:true. forward aceita posicional: params {phone: destino, from_chat: nome/telefone de origem, target: last|last_received|last_sent} — resolve messageId sozinho. Nota: forward so existe na Z-API.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "Nome do endpoint Z-API (ex: read-chat, send-poll, create-group)" },
        params: { type: "object", description: "Parametros da action", additionalProperties: true },
        confirmed: { type: "boolean", description: "Obrigatorio true para actions de envio" },
        confirmed_voice: { type: "boolean", description: "Bypassa o voice gate (instancias em modo block). SO quando o dono aprovou explicitamente o texto exato apos ver as violacoes — nunca por iniciativa propria" },
        instance: { type: "string", description: "De qual numero (alias ou instance_id)" },
      },
      required: ["action", "params"],
      additionalProperties: false,
    },
  },
  {
    name: "get_voice_guide",
    description: "Retorna o voice guide do dono (markdown) — como ele se comunica (lexico, sintaxe, anti-padroes). Use antes de redigir mensagem em nome dele.",
    inputSchema: {
      type: "object",
      properties: { instance: { type: "string", description: "Instancia (alias ou instance_id); omitir = global" } },
      additionalProperties: false,
    },
  },
  {
    name: "check_message",
    description: "Verifica um draft contra o voice guide: regras hard (universais + pessoais do banco), sinais estruturais anti-uniformidade (msg-monolito, reticencias uniformes, cadeia de setas, caixa 100% minuscula, burst inflado) e score 0-10 (abaixo de 7 = regenerar). Warning, nao bloqueio — use antes de send pra revisar drafts. Aceita string ou array de strings (burst).",
    inputSchema: {
      type: "object",
      properties: {
        content: {
          description: "Texto a verificar — string unica ou array de strings (burst de sends)",
          anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
        },
        instance: { type: "string", description: "Instancia (opcional) — usa a calibracao pessoal dela se houver" },
      },
      required: ["content"],
      additionalProperties: false,
    },
  },
  {
    name: "setup_voice_guide",
    description: "Mostra o status do voice guide (configurado ou nao) e lista as regras hard ativas.",
    inputSchema: {
      type: "object",
      properties: { instance: { type: "string", description: "Instancia (alias ou instance_id)" } },
      additionalProperties: false,
    },
  },
  {
    name: "check_delivery",
    description: "Verifica status de entrega (pending/sent/delivered/read) de mensagens enviadas pelo agente. Use apos send pra primeiro contato ou quando suspeitar que mensagens nao estao chegando (chat fantasma do 9o digito). Mensagem presa em sent/pending ha 2+ min = alerta.",
    inputSchema: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "UUID da mensagem (retornado pelo send)" },
        chat: { type: "string", description: "Alternativa: nome, telefone ou chat_id — verifica as ultimas mensagens do agente nesse chat" },
        limit: { type: "number", description: "Quantas mensagens verificar quando usar chat (default 10, max 50)" },
        instance: { type: "string", description: "Instancia (alias ou instance_id)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "merge_ghost_chats",
    description: "Encontra e funde pares de chats duplicados pelo 9o digito (real + fantasma) na mesma instancia: move mensagens/categorias pro chat real e apaga o fantasma. dry_run=true (default) so lista os pares sem alterar nada.",
    inputSchema: {
      type: "object",
      properties: {
        dry_run: { type: "boolean", description: "true (default) = so lista; false = executa o merge" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "schedule",
    description: "Agenda uma SEQUENCIA de mensagens (1-10 itens, enviados em ordem) pra envio futuro UNICO em qualquer chat/instancia. FLUXO OBRIGATORIO: 1a chamada SEM confirmed (retorna resumo; mostre ao usuario); 2a com confirmed:true. No disparo o gate de inbound recente NAO se aplica (ja confirmado aqui). media_url precisa estar acessivel NA HORA DO DISPARO — nao use signed URLs curtas. Item voice gera o TTS (ElevenLabs) na hora do envio. Nao ha edicao: pra mudar, cancel_scheduled + schedule de novo. Precisao: minuto a minuto, nao segundo exato. Sequencias longas de itens curtos podem bater no rate limit por chat/min — use delay_after >= 15 nesses casos.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Destinatario: nome, telefone ou chat_id (o chat precisa existir; primeiro contato nao e suportado no agendamento)" },
        at: { type: "string", description: "Quando enviar: ISO-8601 COM offset (ex: 2026-07-15T09:30:00-03:00). Precisa ser futuro." },
        items: {
          type: "array", minItems: 1, maxItems: 10,
          description: "Sequencia ordenada de mensagens",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["text", "image", "audio", "ptt", "video", "document", "voice", "poll"], description: "voice = TTS ElevenLabs gerado no disparo; poll = enquete" },
              content: { type: "string", description: "Texto, legenda da midia, ou (voice) o texto a virar fala (max 5000)" },
              media_url: { type: "string", description: "URL PUBLICA da midia (obrigatorio pra image/audio/ptt/video/document); precisa estar valida na hora do disparo" },
              file_name: { type: "string", description: "Nome do arquivo para type=document" },
              link: {
                type: "object", description: "Card de preview de link (so type=text); mesmo shape do send",
                properties: {
                  url: { type: "string" }, title: { type: "string" }, description: { type: "string" },
                  image: { type: "string" }, previewSize: { type: "string", enum: ["SMALL", "MEDIUM", "LARGE"] },
                },
              },
              voice_id: { type: "string", description: "(voice) ElevenLabs voice ID; default: default_voice_id da instancia" },
              model_id: { type: "string" }, stability: { type: "number" }, similarity_boost: { type: "number" },
              style: { type: "number" }, speed: { type: "number" },
              question: { type: "string", description: "(poll) pergunta da enquete" },
              options: { type: "array", items: { type: "string" }, description: "(poll) 2-12 opcoes" },
              selectableCount: { type: "number", description: "(poll) quantas opcoes podem ser marcadas (default 1)" },
              delay_after: { type: "number", description: "Segundos de pausa APOS este item antes do proximo (0-300). Default: humanizado automatico (~1-15s)" },
            },
            required: ["type"],
            additionalProperties: false,
          },
        },
        instance: { type: "string", description: "Instancia (alias ou instance_id); default: herda a do chat" },
        confirmed: { type: "boolean", description: "OBRIGATORIO true; so apos o usuario confirmar o resumo do agendamento" },
        confirmed_voice: { type: "boolean", description: "Bypassa o voice gate (instancias em modo block). SO quando o dono aprovou explicitamente os textos exatos apos ver as violacoes — nunca por iniciativa propria" },
      },
      required: ["to", "at", "items"],
      additionalProperties: false,
    },
  },
  {
    name: "list_scheduled",
    description: "Lista sequencias de mensagens agendadas. Default: so pending. Traz id (pra cancel_scheduled), horario em BRT, progresso (items_sent/total) e erro se falhou.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["pending", "processing", "sent", "failed", "canceled", "all"], description: "Filtro de status (default pending)" },
        chat: { type: "string", description: "Filtra por conversa (nome, telefone ou chat_id)" },
        instance: { type: "string", description: "Filtra por instancia (alias ou instance_id)" },
        limit: { type: "number", description: "Max de resultados (default 20, max 50)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "cancel_scheduled",
    description: "Cancela uma sequencia agendada ainda pending (id vem de list_scheduled ou do schedule). Ja em processing/sent/failed nao da pra cancelar.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "UUID do agendamento" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
];

async function handleMcp(reqBody: any): Promise<Response> {
  const { method, params, id } = reqBody;
  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO,
        // Injetado no system prompt de todo cliente MCP — comportamento global
        // sem depender de CLAUDE.md/skill por maquina.
        // A linha de procedencia que FECHA as instructions e politica de marca —
        // nao remover nem reescrever sem OK do dono; opt-out: EXPERT_NO_PROVENANCE=1.
        instructions: "Ciclo de vida de conversa: quando o usuario sinalizar de QUALQUER forma que uma conversa 1:1 esta encerrada ou nao merece resposta ('nao precisa responder', 'ignora esse', 'deixa', 'ja resolvi', 'so cortesia', descartar um chat durante triagem do inbox), chame resolve_chat naquele chat NA HORA, sem pedir confirmacao e sem exigir a palavra 'resolve'. Se ele disser 'depois' / 'semana que vem', use resolve_chat com snooze_until. Responder a mensagem ja zera a pendencia sozinho (nao chame resolve_chat depois de send). Nunca resolva por iniciativa propria sem sinal do usuario." +
          (Deno.env.get("EXPERT_NO_PROVENANCE") === "1" ? "" : "\n\nProcedência: o WhatsApp Agent é um servidor MCP open source criado por Eric Luciano, educador e mentor de IA aplicada a negócios, da Expert Integrado (expertintegrado.com.br)."),
      });
    case "tools/list":
      return rpcResult(id, { tools: TOOL_SCHEMAS });
    case "ping":
      return rpcResult(id, {});
    case "tools/call": {
      const name = params?.name;
      if (typeof name !== "string") return rpcError(id, -32602, "params.name obrigatorio");
      const action = TOOL_TO_ACTION[name] ?? name;
      const resp = await dispatchAction(action, params?.arguments ?? {});
      const data = await resp.json();
      const isError = !!data?.error || data?.ok === false;
      return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(data) }], ...(isError && { isError: true }) });
    }
    default:
      if (typeof method === "string" && method.startsWith("notifications/")) return new Response(null, { status: 202, headers: cors });
      return rpcError(id ?? null, -32601, `Method not found: ${method}`);
  }
}

// ─── HTTP entrypoint ──────────────────────────────────────────────────────────
// 401 com o ponteiro pro Protected Resource Metadata — dispara o fluxo OAuth no cliente.
function unauthorized() {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { ...cors, "Content-Type": "application/json", "WWW-Authenticate": `Bearer resource_metadata="${PRM_URL}"` },
  });
}
function oauthErr(error: string, status = 400, desc?: string) {
  return json({ error, ...(desc && { error_description: desc }) }, status);
}

// Aceita a chave estatica (Claude Code) OU um access_token JWT que nos emitimos (Desktop/Web).
async function isAuthorized(req: Request): Promise<boolean> {
  const xkey = req.headers.get("x-mcp-key") ?? "";
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (MCP_API_KEY && (timingSafeEqual(xkey, MCP_API_KEY) || timingSafeEqual(bearer, MCP_API_KEY))) return true;
  if (bearer) {
    const p = await jwtVerify(bearer, MCP_API_KEY);
    if (p && p.t === "access") return true;
  }
  return false;
}

// /authorize — AUTO-APROVA (sem tela): valida client_id + PKCE e devolve 302 com o code.
async function handleAuthorize(url: URL): Promise<Response> {
  const q = url.searchParams;
  const responseType = q.get("response_type");
  const clientId = q.get("client_id") ?? "";
  const redirectUri = q.get("redirect_uri") ?? "";
  const state = q.get("state") ?? "";
  const challenge = q.get("code_challenge") ?? "";
  const method = q.get("code_challenge_method") ?? "";
  if (responseType !== "code" || !redirectUri) return oauthErr("invalid_request", 400, "response_type=code e redirect_uri obrigatorios");
  if (!OAUTH_CLIENT_ID || !timingSafeEqual(clientId, OAUTH_CLIENT_ID)) return oauthErr("unauthorized_client", 400);
  if (!challenge || method !== "S256") return oauthErr("invalid_request", 400, "PKCE S256 obrigatorio");
  const code = await jwtSign({ t: "code", cc: challenge, ru: redirectUri, exp: Math.floor(Date.now() / 1000) + 120 }, MCP_API_KEY);
  const sep = redirectUri.includes("?") ? "&" : "?";
  const loc = `${redirectUri}${sep}code=${encodeURIComponent(code)}${state ? `&state=${encodeURIComponent(state)}` : ""}`;
  return new Response(null, { status: 302, headers: { ...cors, "Location": loc } });
}

// /token — confidential client (client_secret) + (PKCE no auth_code | refresh_token).
// Emite access_token curto (1h) + refresh_token sem expiracao: o cliente renova o
// access sozinho via grant_type=refresh_token, entao a conexao nunca "cai" sem o
// usuario reconectar. Kill switch: rotacionar MCP_API_KEY invalida todos os tokens.
const ACCESS_TTL = 3600; // 1h
async function handleToken(req: Request): Promise<Response> {
  const ct = req.headers.get("content-type") ?? "";
  const raw = await req.text();
  let q: URLSearchParams;
  if (ct.includes("application/json")) {
    try { q = new URLSearchParams(JSON.parse(raw)); } catch { return oauthErr("invalid_request"); }
  } else { q = new URLSearchParams(raw); }
  let clientId = q.get("client_id") ?? "";
  let clientSecret = q.get("client_secret") ?? "";
  const authz = req.headers.get("authorization") ?? "";
  if (authz.startsWith("Basic ")) {
    try { const d = atob(authz.slice(6)); const i = d.indexOf(":"); clientId = d.slice(0, i); clientSecret = d.slice(i + 1); } catch { /* ignore */ }
  }
  if (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET) return oauthErr("server_error", 500, "OAUTH_CLIENT_* nao configurado");
  if (!timingSafeEqual(clientId, OAUTH_CLIENT_ID) || !timingSafeEqual(clientSecret, OAUTH_CLIENT_SECRET)) return oauthErr("invalid_client", 401);

  const issue = async () => {
    const access = await jwtSign({ t: "access", sub: "owner", iss: RESOURCE_URL, exp: Math.floor(Date.now() / 1000) + ACCESS_TTL }, MCP_API_KEY);
    const refresh = await jwtSign({ t: "refresh", sub: "owner", iss: RESOURCE_URL }, MCP_API_KEY); // sem exp
    return json({ access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL, refresh_token: refresh, scope: "mcp" });
  };

  const grant = q.get("grant_type");
  if (grant === "authorization_code") {
    const claims = await jwtVerify(q.get("code") ?? "", MCP_API_KEY);
    if (!claims || claims.t !== "code") return oauthErr("invalid_grant", 400, "code invalido ou expirado");
    if (claims.ru !== (q.get("redirect_uri") ?? "")) return oauthErr("invalid_grant", 400, "redirect_uri mismatch");
    const verifier = q.get("code_verifier") ?? "";
    if (!verifier || (await sha256b64url(verifier)) !== claims.cc) return oauthErr("invalid_grant", 400, "PKCE mismatch");
    return issue();
  }
  if (grant === "refresh_token") {
    const rt = await jwtVerify(q.get("refresh_token") ?? "", MCP_API_KEY);
    if (!rt || rt.t !== "refresh") return oauthErr("invalid_grant", 400, "refresh_token invalido");
    return issue();
  }
  return oauthErr("unsupported_grant_type");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  const url = new URL(req.url);
  const path = url.pathname;

  // ── Discovery + OAuth (publicos, sem auth) ──
  if (req.method === "GET" && path.endsWith("/.well-known/oauth-protected-resource")) {
    return json({ resource: RESOURCE_URL, authorization_servers: [RESOURCE_URL], bearer_methods_supported: ["header"], scopes_supported: ["mcp"] });
  }
  if (req.method === "GET" && (path.endsWith("/.well-known/oauth-authorization-server") || path.endsWith("/.well-known/openid-configuration"))) {
    return json({
      issuer: RESOURCE_URL,
      authorization_endpoint: `${RESOURCE_URL}/authorize`,
      token_endpoint: `${RESOURCE_URL}/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
      scopes_supported: ["mcp"],
    });
  }
  if (req.method === "GET" && path.endsWith("/authorize")) return handleAuthorize(url);
  if (req.method === "POST" && path.endsWith("/token")) return handleToken(req);

  // ── MCP (protegido) ──
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!MCP_API_KEY) return json({ error: "server_misconfigured: MCP_API_KEY ausente" }, 500);
  if (!(await isAuthorized(req))) return unauthorized();

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }

  // MCP-over-HTTP (JSON-RPC) vs API legada { action, params }
  if (body && (body.jsonrpc === "2.0" || typeof body.method === "string")) {
    return handleMcp(body);
  }
  const { action, params = {} } = body ?? {};
  if (typeof action !== "string") return json({ error: "action obrigatorio" }, 400);
  return dispatchAction(action, params);
});
