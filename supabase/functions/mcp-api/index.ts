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

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const supabase = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const MCP_API_KEY = Deno.env.get("MCP_API_KEY") ?? "";
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";

const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// JWT legado (passa no verify_jwt das edges de envio). A SUPABASE_SERVICE_ROLE_KEY
// auto-injetada pode estar em formato novo (nao-JWT) e ser rejeitada pelo gateway.
const INTERNAL_JWT = Deno.env.get("INTERNAL_EDGE_JWT") || SERVICE_KEY;
// Chamada interna edge->edge pras edges de envio existentes (send-message/voice/zapi-proxy).
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
function b64urlToBytes(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
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
  const { data } = await supabase.from("zapi_instance").select("instance_id, alias, phone_connected, is_default, is_active");
  _instCache = data || [];
  return _instCache;
}
async function resolveInstanceKey(key: string | null | undefined): Promise<string | null> {
  if (!key) return null;
  const rows = await loadInstances();
  return rows.find((r: any) => r.alias === key || r.instance_id === key)?.instance_id ?? null;
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
function normalizePhoneBR(digits: string): string[] {
  const out = new Set<string>();
  if (!digits) return [];
  out.add(digits);
  const flipNine = (d: string) => {
    if (d.length === 13 && d.startsWith("55") && d[4] === "9") out.add(d.slice(0, 4) + d.slice(5));
    else if (d.length === 12 && d.startsWith("55")) out.add(d.slice(0, 4) + "9" + d.slice(4));
  };
  flipNine(digits);
  if (!digits.startsWith("55") && (digits.length === 10 || digits.length === 11)) {
    const with55 = "55" + digits; out.add(with55); flipNine(with55);
  }
  return Array.from(out);
}
function expandChatIdCandidates(phoneVariants: string[]): string[] {
  const suffixes = ["", "@s.whatsapp.net", "@c.us", "@lid", "-group", "@g.us"];
  const out = new Set<string>();
  for (const v of phoneVariants) for (const s of suffixes) out.add(v + s);
  return Array.from(out);
}
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

    if (exact?.length === 1) return { chat_id: exact[0].chat_id, chat_name: exact[0].chat_name || exact[0].contact_name, instance_id: exact[0].instance_id };
    if (exact && exact.length > 1) {
      const numericos = exact.filter((c: any) => /^\d+$/.test(String(c.chat_id)));
      const lids = exact.filter((c: any) => String(c.chat_id).endsWith("@lid"));
      if (numericos.length === 1 && lids.length >= 1) {
        const phoneCanonical = numericos[0].chat_id;
        if (lids.every(() => phoneVariants.includes(phoneCanonical)))
          return { chat_id: phoneCanonical, chat_name: numericos[0].chat_name || numericos[0].contact_name, instance_id: numericos[0].instance_id };
      }
      const ranked = exact.map((c: any) => ({ ...c, _score: applyChatBoost(50, c) })).sort((a: any, b: any) => b._score - a._score);
      if (ranked[0]._score - ranked[1]._score >= 5) return { chat_id: ranked[0].chat_id, chat_name: ranked[0].chat_name || ranked[0].contact_name, instance_id: ranked[0].instance_id };
      return { candidates: ranked.slice(0, 5).map((c: any) => ({ chat_id: c.chat_id, name: c.chat_name || c.contact_name, is_group: c.is_group, instance: c.instance_id })) };
    }

    const longest = phoneVariants.slice().sort((a, b) => b.length - a.length)[0];
    if (longest && longest.length >= 8) {
      const { data: prefix } = await instEq(supabase.from("v_chats_with_contact")
        .select("instance_id,chat_id,chat_name,contact_name,is_group,last_message_at").like("chat_id", `${longest}%`))
        .order("last_message_at", { ascending: false, nullsFirst: false }).order("chat_id", { ascending: true }).limit(5);
      if (prefix?.length === 1) return { chat_id: prefix[0].chat_id, chat_name: prefix[0].chat_name || prefix[0].contact_name, instance_id: prefix[0].instance_id };
      if (prefix && prefix.length > 1) {
        const ranked = prefix.map((c: any) => ({ ...c, _score: applyChatBoost(40, c) })).sort((a: any, b: any) => b._score - a._score);
        if (ranked[0]._score - ranked[1]._score >= 5) return { chat_id: ranked[0].chat_id, chat_name: ranked[0].chat_name || ranked[0].contact_name, instance_id: ranked[0].instance_id };
        return { candidates: ranked.slice(0, 5).map((c: any) => ({ chat_id: c.chat_id, name: c.chat_name || c.contact_name, is_group: c.is_group, instance: c.instance_id })) };
      }
    }
  }

  const toNorm = normalize(to);
  if (!toNorm) return { error: `Nenhum chat encontrado para "${to}"` };
  const { data: all } = await instEq(supabase.from("v_chats_with_contact")
    .select("instance_id,chat_id,chat_name,contact_name,is_group,last_message_at"))
    .order("last_message_at", { ascending: false, nullsFirst: false }).order("chat_id", { ascending: true }).limit(1500);
  if (!all?.length) return { error: "Tabela de chats vazia" };
  const scored = all.map((c: any) => {
    const { score, kind } = scoreNameMatch(toNorm, c);
    return { ...c, _score: score > 0 ? applyChatBoost(score, c) : 0, _kind: kind };
  }).filter((c: any) => c._score > 0).sort((a: any, b: any) => b._score - a._score || String(a.chat_id).localeCompare(String(b.chat_id)));
  if (!scored.length) return { error: `Nenhum chat encontrado para "${to}"` };
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

// delay de digitacao humanizado (portado do mcp/index.js — antes era client-side)
function humanizedTypingSeconds(type: string, content: string): number {
  const len = (content || "").length;
  if (type === "text") return Math.min(15, Math.max(1, Math.ceil(len / 30)));
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
function checkVoiceViolations(content: string) {
  if (!content || typeof content !== "string") return [];
  const out: any[] = [];
  for (const rule of HARD_RULES) {
    const m = content.match(rule.pattern);
    if (m) out.push({ id: rule.id, severity: rule.severity, message: rule.message, match: m[0] });
  }
  return out;
}
async function loadVoiceGuide(instanceId?: string | null): Promise<any | null> {
  if (instanceId) {
    const { data } = await supabase.from("voice_guide").select("content,instance_id,updated_at").eq("instance_id", instanceId).maybeSingle();
    if (data) return data;
  }
  const { data } = await supabase.from("voice_guide").select("content,instance_id,updated_at").is("instance_id", null).maybeSingle();
  return data ?? null;
}

// ─── Executor de actions (reusado pelo legado {action,params} e pelo MCP tools/call) ───
async function dispatchAction(action: string, params: any = {}): Promise<Response> {
  try {
    switch (action) {
      case "ping": return json({ ok: true, pong: true });

      case "status": {
        const dayAgo = new Date(Date.now() - 86400000).toISOString();
        const instances = await loadInstances();
        const perInstance: any[] = [];
        for (const inst of instances) {
          let zapiData: any;
          try {
            const { data } = await callEdge("zapi-proxy", { action: "status", method: "GET", agent_name: "mcp-api", instance: inst.alias ?? inst.instance_id });
            zapiData = data?.result;
          } catch (e) { zapiData = { error: String((e as Error)?.message ?? e) }; }
          const { count: total } = await supabase.from("messages").select("*", { count: "exact", head: true }).eq("instance_id", inst.instance_id);
          const { count: today } = await supabase.from("messages").select("*", { count: "exact", head: true }).eq("instance_id", inst.instance_id).gte("created_at", dayAgo);
          perInstance.push({
            instance: inst.alias ?? inst.instance_id,
            phone_connected: inst.phone_connected,
            connected: zapiData?.connected || zapiData?.smartphoneConnected || false,
            webhook_active: inst.is_active,
            zapi: zapiData,
            stats: { total_messages: total, messages_last_24h: today },
          });
        }
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
        let metaQ = supabase.from("chats").select("observations,links").eq("chat_id", resolved.chat_id);
        if (resolved.instance_id) { catQ = catQ.eq("instance_id", resolved.instance_id); metaQ = metaQ.eq("instance_id", resolved.instance_id); }
        const [catRes, metaRes] = await Promise.all([catQ.maybeSingle(), metaQ.maybeSingle()]);
        const catRow: any = catRes.data, chatMeta: any = metaRes.data;

        return json({
          ok: true,
          chat_id: resolved.chat_id,
          chat_name: resolved.chat_name,
          instance: resolved.instance_id,
          ...(chatMeta?.observations && { observations: chatMeta.observations }),
          ...(chatMeta?.links?.length && { links: chatMeta.links }),
          categories: catRow?.category_slugs || [],
          category_labels: catRow?.category_labels || [],
          ...(catRow?.linked_pipedrive_person_id && { linked_pipedrive_person_id: catRow.linked_pipedrive_person_id }),
          messages: withBRT(await enrichWithTranscriptions((data || []).reverse())),
          count: (data || []).length,
        });
      }

      case "inbox": {
        const { limit = 15, since, waiting_on: waitingFilter, exclude_groups = false, category_slugs, exclude_categories, min_idle_days, instance } = params;
        const instKey = instance ? await resolveInstanceKey(instance) : null;
        const instEq = (q: any) => (instKey ? q.eq("instance_id", instKey) : q);
        const ck = (m: any) => `${m.instance_id}|${m.chat_id}`;
        const instRows = await loadInstances();
        const labelOf = (id: string) => instRows.find((r: any) => r.instance_id === id)?.alias ?? id;
        const useCategoryView = !!(category_slugs?.length || exclude_categories?.length);
        let q = supabase.from(useCategoryView ? "v_chats_with_categories" : "v_chats_with_contact")
          .select(useCategoryView
            ? "instance_id,chat_id,chat_name,is_group,last_message_at,last_received_at,last_sent_at,category_slugs"
            : "instance_id,chat_id,chat_name,contact_name,is_group,last_message_at,last_received_at,last_sent_at")
          .order("last_message_at", { ascending: false, nullsFirst: false })
          .order("chat_id", { ascending: true })
          .limit(useCategoryView ? Math.max(limit * 5, 100) : limit);
        q = instEq(q);
        if (since) q = q.gt("last_message_at", since);
        if (exclude_groups) q = q.eq("is_group", false);
        if (category_slugs?.length) q = q.overlaps("category_slugs", category_slugs);
        const { data: rawChats, error } = await q;
        if (error) return json({ error: error.message }, 500);
        // Anota waiting_on + idle_days (dias parado desde a ultima msg relevante),
        // filtra e — quando min_idle_days ou waiting_on:me — ordena por mais parado
        // primeiro. Isso absorve a antiga skill 'estou-devendo' direto na tool.
        const nowMs = Date.now();
        const annotated = (rawChats || []).map((c: any) => {
          const recv = c.last_received_at ? new Date(c.last_received_at).getTime() : 0;
          const sent = c.last_sent_at ? new Date(c.last_sent_at).getTime() : 0;
          const w = recv > sent ? "me" : (sent > recv ? "lead" : "none");
          const refTs = w === "me" ? recv : (w === "lead" ? sent : Math.max(recv, sent));
          return { c, w, idle_days: refTs ? Math.floor((nowMs - refTs) / 86400000) : null };
        }).filter((x: any) => {
          if (waitingFilter && x.w !== waitingFilter) return false;
          if (min_idle_days != null && (x.idle_days ?? -1) < min_idle_days) return false;
          if (exclude_categories?.length && x.c.category_slugs && x.c.category_slugs.some((s: string) => exclude_categories.includes(s))) return false;
          return true;
        });
        if (min_idle_days != null || waitingFilter === "me") annotated.sort((a: any, b: any) => (b.idle_days ?? -1) - (a.idle_days ?? -1));
        const idleByKey: Record<string, number | null> = {};
        for (const x of annotated) idleByKey[`${x.c.instance_id}|${x.c.chat_id}`] = x.idle_days;
        let chats = annotated.slice(0, limit).map((x: any) => x.c);

        let contactById: Record<string, any> = {};
        if (useCategoryView && chats.length) {
          const ids = chats.map((c: any) => c.chat_id);
          const { data: enriched } = await instEq(supabase.from("v_chats_with_contact").select("instance_id,chat_id,contact_name").in("chat_id", ids));
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
          const recv = c.last_received_at ? new Date(c.last_received_at).getTime() : 0;
          const sent = c.last_sent_at ? new Date(c.last_sent_at).getTime() : 0;
          const waiting_on = recv > sent ? "me" : (sent > recv ? "lead" : "none");
          const enriched = contactById[ck(c)] || {};
          return {
            chat_id: c.chat_id, instance: c.instance_id, instance_label: labelOf(c.instance_id),
            name: enriched.contact_name || c.contact_name || c.chat_name, is_group: c.is_group,
            categories: categoriesByChat[ck(c)] || [],
            last_message_at: c.last_message_at, ...(c.last_message_at && { last_message_at_brt: toBRT(c.last_message_at) }),
            last_received_at: c.last_received_at, last_sent_at: c.last_sent_at, waiting_on,
            idle_days: idleByKey[ck(c)] ?? null,
            last_message: msg ? { content: msg.content?.slice(0, 120), type: msg.message_type, from_me: msg.from_me, ...(AUDIO_TYPES.has(msg.message_type) && { transcription: msg.transcription }) } : null,
          };
        });
        return json({ ok: true, chats: result, total: result.length });
        // NOTA: transcricao de audio na last_message ainda nao portada (proximo incremento).
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
        const { chat, observations, links, instance } = params;
        if (!observations && !links) return json({ error: "Passe ao menos observations ou links." }, 400);
        const resolved = await resolveChat(chat, instance);
        if (resolved.error) return json({ error: resolved.error }, 400);
        if (resolved.candidates) return json({ ok: true, ambiguous: true, candidates: resolved.candidates });
        const update: any = {};
        if (observations !== undefined) update.observations = observations;
        if (links !== undefined) update.links = links;
        let updateQ = supabase.from("chats").update(update).eq("chat_id", resolved.chat_id);
        if (resolved.instance_id) updateQ = updateQ.eq("instance_id", resolved.instance_id);
        const { error } = await updateQ;
        if (error) return json({ error: error.message }, 500);
        return json({ ok: true, annotated: true, chat_id: resolved.chat_id, chat_name: resolved.chat_name, instance: resolved.instance_id, ...update });
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
          confirmed = false, humanize = true } = params;
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
          const newChatId = digits.startsWith("55") ? digits : `55${digits}`;
          const { error: insErr } = await supabase.from("chats").upsert({ instance_id: wantInstance, chat_id: newChatId, phone: newChatId, chat_name: newChatId, is_group: false, last_message_at: new Date().toISOString() }, { onConflict: "instance_id,chat_id" });
          if (insErr) return json({ error: `Falha ao criar chat: ${insErr.message}` }, 500);
          resolved = { chat_id: newChatId, chat_name: newChatId, instance_id: wantInstance, _new: true };
        }
        if (resolved.candidates) return json({ ok: true, ambiguous: true, candidates: resolved.candidates });
        if (type !== "text" && !media_url) return json({ error: `media_url obrigatorio pra type "${type}".` }, 400);
        const targetInstance = wantInstance ?? resolved.instance_id;
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
        const sendBody: any = { chat_id: resolved.chat_id, content, message_type: type, confirmed: true, agent_name: agent_name || "mcp-api", instance: targetInstance,
          ...(media_url && { media_url }), ...(file_name && { file_name }), ...(reply_to && { quoted_msg_id: reply_to }),
          ...(effectiveDelayTyping !== undefined && { delay_typing: effectiveDelayTyping }), ...(delay_message !== undefined && { delay_message }),
          ...(mentions?.length && { mentions }), ...(mentions_everyone && { mentions_everyone: true }) };
        const { status, data } = await callEdge("send-message", sendBody);
        if (status >= 400) return json({ ok: false, error: data?.error || `send-message ${status}`, detail: data }, status);
        return json({ ok: true, ...data, to: resolved.chat_name, instance: targetInstance });
      }

      case "send_voice": {
        const { to, text, voice_id, model_id, stability, similarity_boost, style, speed, instance, agent_name, confirmed = false } = params;
        if (!confirmed) return json({ blocked: true, needs_confirmation: true, to, voice_id, text, instruction: "Mostre destinatario + texto + voice_id ao usuario e so reenvie com confirmed:true apos ele confirmar." });
        const resolved = await resolveChat(to, instance);
        if (resolved.error) return json({ ok: false, error: resolved.error });
        if (resolved.candidates) return json({ ok: true, ambiguous: true, candidates: resolved.candidates });
        const targetInstance = (instance ? await resolveInstanceKey(instance) : null) ?? resolved.instance_id;
        const vbody: any = { chat_id: resolved.chat_id, text, voice_id, confirmed: true, agent_name: agent_name || "mcp-api", agent_request_id: crypto.randomUUID(), instance: targetInstance,
          ...(model_id && { model_id }), ...(stability !== undefined && { stability }), ...(similarity_boost !== undefined && { similarity_boost }), ...(style !== undefined && { style }), ...(speed !== undefined && { speed }) };
        const { status, data } = await callEdge("send-voice", vbody);
        if (status >= 400) return json({ ok: false, error: data?.error || `send-voice ${status}`, detail: data }, status);
        return json({ ok: true, ...data, to: resolved.chat_name, instance: targetInstance });
      }

      case "react": {
        const { message_id, emoji } = params;
        const { data: msg, error } = await supabase.from("messages").select("provider_msg_id,chat_id,instance_id").eq("id", message_id).single();
        if (error || !msg) return json({ error: error?.message || "mensagem nao encontrada" }, 404);
        const phone = String(msg.chat_id).replace(/@.*$/, "");
        const { status, data } = await callEdge("zapi-proxy", { action: "send-reaction", params: { phone, messageId: msg.provider_msg_id, reaction: emoji }, agent_name: "mcp-api", agent_request_id: crypto.randomUUID(), instance: msg.instance_id });
        if (status >= 400) return json({ ok: false, error: data?.error || `zapi ${status}` }, status);
        return json({ ok: true, reacted: true, emoji, result: data?.result });
      }

      case "edit_message": {
        const { message_id, new_content, confirmed = false } = params;
        if (!confirmed) return json({ blocked: true, needs_confirmation: true, message_id, new_content, instruction: "Mostre a mensagem e o novo texto ao usuario; reenvie com confirmed:true apos ele confirmar." });
        const { data: msg, error } = await supabase.from("messages").select("provider_msg_id,chat_id,from_me,message_ts,message_type,instance_id").eq("id", message_id).single();
        if (error || !msg) return json({ error: error?.message || "mensagem nao encontrada" }, 404);
        if (!msg.from_me) return json({ error: "Nao da pra editar msg de outros." }, 400);
        if (msg.message_type && msg.message_type !== "text" && msg.message_type !== "chat") return json({ error: `So texto. Tipo: ${msg.message_type}.` }, 400);
        const ageMs = Date.now() - (msg.message_ts ? new Date(msg.message_ts).getTime() : 0);
        if (ageMs > 15 * 60 * 1000) return json({ error: `Janela de 15min expirada. Use delete + send.` }, 400);
        const phone = String(msg.chat_id).replace(/@.*$/, "");
        const { status, data } = await callEdge("zapi-proxy", { action: "send-text", params: { phone, message: new_content, editMessageId: msg.provider_msg_id }, confirmed: true, agent_name: "mcp-api", agent_request_id: crypto.randomUUID(), instance: msg.instance_id });
        if (status >= 400) return json({ ok: false, error: data?.error || `zapi ${status}` }, status);
        await supabase.from("messages").update({ content: new_content, is_edited: true }).eq("id", message_id);
        return json({ ok: true, edited: true, message_id, new_content });
      }

      case "delete_message": {
        const { message_id, confirmed = false } = params;
        if (!confirmed) return json({ blocked: true, needs_confirmation: true, message_id, instruction: "Confirme com o usuario antes de apagar; reenvie com confirmed:true." });
        const { data: msg, error } = await supabase.from("messages").select("provider_msg_id,chat_id,from_me,instance_id").eq("id", message_id).single();
        if (error || !msg) return json({ error: error?.message || "mensagem nao encontrada" }, 404);
        const phone = String(msg.chat_id).replace(/@.*$/, "");
        const { status, data } = await callEdge("zapi-proxy", { action: "delete-message", params: { phone, messageId: msg.provider_msg_id, owner: !!msg.from_me }, confirmed: true, agent_name: "mcp-api", agent_request_id: crypto.randomUUID(), instance: msg.instance_id });
        if (status >= 400) return json({ ok: false, error: data?.error || `zapi ${status}` }, status);
        await supabase.from("messages").update({ is_deleted: true }).eq("id", message_id);
        return json({ ok: true, deleted: true, message_id });
      }

      case "zapi_action": {
        const ZAPI_SEND_ACTIONS = new Set(["send-poll", "forward-message", "forward", "edit-message", "send-text", "send-message"]);
        const { action: zaction, params: zparams = {}, confirmed = false, instance } = params;
        if (ZAPI_SEND_ACTIONS.has(zaction) && !confirmed) return json({ blocked: true, needs_confirmation: true, action: zaction, params: zparams, instruction: `A action "${zaction}" envia conteudo. Mostre ao usuario e reenvie com confirmed:true apos confirmacao.` });
        const { status, data } = await callEdge("zapi-proxy", { action: zaction, params: zparams, confirmed: true, agent_name: "mcp-api", agent_request_id: crypto.randomUUID(), instance });
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
        const { status, data: zr } = await callEdge("zapi-proxy", { action: "chats", method: "GET", agent_name: "mcp-api", instance: targetInst });
        if (status >= 400) return json({ ok: false, error: zr?.error || `zapi ${status}` }, status);
        const raw = zr?.result;
        const allChats = Array.isArray(raw) ? raw : (raw?.value || raw?.chats || raw?.data || []);
        const groups = allChats.filter((c: any) => c.isGroup === true || c.is_group === true || c.type === "group");
        if (!groups.length) return json({ ok: true, message: "Nenhum grupo na Z-API.", total_chats: allChats.length, total_groups: 0 });
        const updated: any[] = [], not_found: any[] = [];
        for (const group of groups) {
          const rawPhone = String(group.phone || group.id || group.chatId || "");
          const phone = rawPhone.replace(/[^0-9]/g, "");
          const name = group.name || group.chatName || group.subject || group.groupName || null;
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
        return json({ ok: true, total_groups_in_zapi: groups.length, updated_count: updated.length, not_found_count: not_found.length, updated, ...(not_found.length && { not_found }), dry_run });
      }

      case "get_voice_guide": {
        const g = await loadVoiceGuide(params.instance ? await resolveInstanceKey(params.instance) : null);
        if (!g) return json({ ok: true, configured: false, message: "Voice guide nao configurado. Insira o markdown em public.voice_guide (content; instance_id NULL = global).", hard_rules: HARD_RULES.map((r) => ({ id: r.id, severity: r.severity })) });
        return json({ ok: true, configured: true, scope: g.instance_id ?? "global", updated_at: g.updated_at, content: g.content });
      }

      case "check_message": {
        const violations = checkVoiceViolations(params.content);
        return json({ ok: true, has_violations: violations.length > 0, violations_count: violations.length, violations, ...(violations.length ? { hint: "Use get_voice_guide pra ler o documento e reescrever respeitando as regras hard." } : { message: "Nenhuma violacao hard. Texto compativel com o voice guide." }) });
      }

      case "setup_voice_guide": {
        const g = await loadVoiceGuide(params.instance ? await resolveInstanceKey(params.instance) : null);
        return json({
          ok: true,
          status: g ? "active" : "not_configured",
          ...(g ? { scope: g.instance_id ?? "global", content_length: g.content.length, updated_at: g.updated_at } : { setup: "INSERT INTO voice_guide (content) VALUES ('<seu markdown>'); -- instance_id NULL = global" }),
          hard_rules: HARD_RULES.map((r) => ({ id: r.id, severity: r.severity, message: r.message })),
        });
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
};

function rpc(id: any, payload: Record<string, unknown>): Response {
  return json({ jsonrpc: "2.0", id: id ?? null, ...payload });
}
const rpcResult = (id: any, result: unknown) => rpc(id, { result });
const rpcError = (id: any, code: number, message: string) => rpc(id, { error: { code, message } });

const SERVER_INFO = { name: "whatsapp-agent", version: "3.0.1" };
const PROTOCOL_VERSION = "2024-11-05";

// Schemas expostos no tools/list — MVP: status, inbox, read.
// (as 17 actions restantes ja rodam via dispatchAction; entram no tools/list nos proximos passos)
const TOOL_SCHEMAS = [
  {
    name: "status",
    description: "Verifica se o WhatsApp esta conectado e funcionando (conexao Z-API + stats por instancia).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "inbox",
    description: "Lista conversas com a ultima mensagem de cada. Use waiting_on:'me' para 'do que estou devendo / quem espera resposta' (o contato mandou por ultimo) — combine com min_idle_days pra so as paradas ha N+ dias; o resultado ja vem ordenado por mais parado primeiro e traz idle_days por chat. Filtra tambem por categoria e grupos.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max de chats (default 15)" },
        since: { type: "string", description: "ISO timestamp — so chats com atividade apos esta data" },
        waiting_on: { type: "string", enum: ["me", "lead", "none"], description: "Filtra por quem deve responder agora ('me' = voce esta devendo)" },
        exclude_groups: { type: "boolean", description: "Se true, ignora grupos (so 1:1) — recomendado pra 'estou devendo'" },
        category_slugs: { type: "array", items: { type: "string" }, description: "So chats com pelo menos uma destas categorias" },
        exclude_categories: { type: "array", items: { type: "string" }, description: "Exclui chats com qualquer destas categorias (ex.: descartar, comunidade)" },
        min_idle_days: { type: "number", description: "So chats parados ha N+ dias (pela ultima msg relevante). Ordena por mais parado primeiro." },
        instance: { type: "string", description: "Filtra por instancia (alias 'pessoal'/'profissional' ou instance_id)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "read",
    description: "Le as mensagens de uma conversa em ordem cronologica e JA transcreve os audios pendentes (Whisper) — use pra 'transcreve/resume a conversa com X' ou 'o que o fulano mandou'. 'chat' aceita nome, telefone ou chat_id; se ambiguo, retorna candidatos. Cada audio vem com o campo transcription.",
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
    description: "Envia mensagem (texto ou midia) pra contato/grupo. FLUXO OBRIGATORIO: 1a chamada SEM confirmed (mostra destinatario+conteudo e bloqueia); 2a com confirmed:true apos o usuario confirmar. 'to' aceita nome/telefone/chat_id.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Destinatario: nome, telefone ou chat_id" },
        content: { type: "string", description: "Texto ou legenda da midia" },
        type: { type: "string", enum: ["text", "image", "audio", "ptt", "video", "document"], description: "Tipo (default text)" },
        media_url: { type: "string", description: "URL publica da midia (obrigatorio se type != text)" },
        file_name: { type: "string", description: "Nome do arquivo para type=document" },
        reply_to: { type: "string", description: "UUID da mensagem para responder (quote)" },
        confirmed: { type: "boolean", description: "OBRIGATORIO true para enviar; so apos o usuario confirmar" },
        allow_new: { type: "boolean", description: "Permite enviar pra numero novo (primeiro contato); exige instance" },
        humanize: { type: "boolean", description: "Calcula delay_typing automatico por tamanho/tipo (default true)" },
        delay_typing: { type: "number", description: "Override do delay de digitacao (0-15s)" },
        delay_message: { type: "number", description: "Atraso antes de enviar (0-15s)" },
        mentions: { type: "array", items: { type: "string" }, description: "Phones pra mencionar (so em grupos)" },
        mentions_everyone: { type: "boolean", description: "Menciona @todos no grupo" },
        force_send_after_inbound: { type: "boolean", description: "Ignora o gate de inbound recente nao respondido" },
        instance: { type: "string", description: "De qual numero enviar (alias ou instance_id)" },
      },
      required: ["to"],
      additionalProperties: false,
    },
  },
  {
    name: "send_voice",
    description: "Gera audio TTS (ElevenLabs) e envia como mensagem de voz (PTT). FLUXO OBRIGATORIO: 1a chamada SEM confirmed (bloqueia); 2a com confirmed:true apos o usuario confirmar. voice_id vem da skill 'voz'.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Destinatario: chat_id ou phone" },
        text: { type: "string", description: "Texto a converter em fala (max 5000)" },
        voice_id: { type: "string", description: "ElevenLabs voice ID (skill voz fornece)" },
        model_id: { type: "string", description: "Modelo ElevenLabs (default eleven_turbo_v2_5)" },
        stability: { type: "number", description: "0-1 (default 0.45)" },
        similarity_boost: { type: "number", description: "0-1 (default 0.75)" },
        style: { type: "number", description: "0-1 (default 0.30)" },
        speed: { type: "number", description: "0.7-1.2 (default 0.95)" },
        confirmed: { type: "boolean", description: "OBRIGATORIO true; so apos confirmacao explicita" },
        instance: { type: "string", description: "De qual numero enviar (alias ou instance_id)" },
      },
      required: ["to", "text", "voice_id"],
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
    description: "Reage a uma mensagem com emoji. Precisa do message_id (UUID de read/search). String vazia remove a reacao.",
    inputSchema: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "UUID da mensagem (campo id de read/search)" },
        emoji: { type: "string", description: "Emoji de reacao (ex: '❤️', '👍'). Vazio remove." },
      },
      required: ["message_id", "emoji"],
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
    description: "Salva observacoes e/ou links sobre um contato/grupo (aparecem em read e inbox). Passe so o campo que quer atualizar.",
    inputSchema: {
      type: "object",
      properties: {
        chat: { type: "string", description: "Nome, telefone ou chat_id" },
        observations: { type: "string", description: "Texto livre com contexto do contato" },
        links: { type: "array", items: { type: "object", properties: { label: { type: "string" }, url: { type: "string" } }, required: ["label", "url"] }, description: "Links relevantes ({label, url})" },
        instance: { type: "string", description: "Instancia (alias ou instance_id)" },
      },
      required: ["chat"],
      additionalProperties: false,
    },
  },
  {
    name: "edit_message",
    description: "Edita o texto de uma mensagem enviada por voce (from_me, texto, ate 15min). FLUXO: 1a SEM confirmed (bloqueia); 2a com confirmed:true.",
    inputSchema: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "UUID da mensagem (de read/search)" },
        new_content: { type: "string", description: "Novo texto" },
        confirmed: { type: "boolean", description: "OBRIGATORIO true; so apos confirmacao" },
      },
      required: ["message_id", "new_content"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_message",
    description: "Deleta uma mensagem enviada por voce (apaga pra todos). FLUXO: 1a SEM confirmed (bloqueia); 2a com confirmed:true.",
    inputSchema: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "UUID da mensagem (de read/search)" },
        confirmed: { type: "boolean", description: "OBRIGATORIO true; so apos confirmacao" },
      },
      required: ["message_id"],
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
    description: "Executa qualquer acao avancada da Z-API (operacoes infrequentes nao cobertas pelas tools). Actions de envio (send-poll, forward, edit-message) exigem confirmed:true.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "Nome do endpoint Z-API (ex: read-chat, send-poll, create-group)" },
        params: { type: "object", description: "Parametros da action", additionalProperties: true },
        confirmed: { type: "boolean", description: "Obrigatorio true para actions de envio" },
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
    description: "Verifica se um texto viola alguma regra hard do voice guide (tu/teu, em-dash, hype, saudacoes genericas, validacao afetiva, etc). Warning, nao bloqueio — use antes de send pra revisar drafts.",
    inputSchema: {
      type: "object",
      properties: { content: { type: "string", description: "Texto a verificar" } },
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
];

async function handleMcp(reqBody: any): Promise<Response> {
  const { method, params, id } = reqBody;
  switch (method) {
    case "initialize":
      return rpcResult(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
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
