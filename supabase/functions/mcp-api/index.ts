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
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-mcp-key",
};
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

// ─── Handler ──────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!MCP_API_KEY) return json({ error: "server_misconfigured: MCP_API_KEY ausente" }, 500);
  if (!timingSafeEqual(req.headers.get("x-mcp-key") ?? "", MCP_API_KEY)) return json({ error: "unauthorized" }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const { action, params = {} } = body;
  if (typeof action !== "string") return json({ error: "action obrigatorio" }, 400);

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
        const { limit = 15, since, waiting_on: waitingFilter, exclude_groups = false, category_slugs, exclude_categories, instance } = params;
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
        let chats = (rawChats || []).filter((c: any) => {
          if (waitingFilter) {
            const recv = c.last_received_at ? new Date(c.last_received_at).getTime() : 0;
            const sent = c.last_sent_at ? new Date(c.last_sent_at).getTime() : 0;
            const w = recv > sent ? "me" : (sent > recv ? "lead" : "none");
            if (w !== waitingFilter) return false;
          }
          if (exclude_categories?.length && c.category_slugs && c.category_slugs.some((s: string) => exclude_categories.includes(s))) return false;
          return true;
        }).slice(0, limit);

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
          const { data } = supabase.storage.from(media.storage_bucket).getPublicUrl(media.storage_path);
          public_url = data?.publicUrl ?? null;
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
          delay_typing, delay_message, mentions, mentions_everyone, force_send_after_inbound = false, instance, agent_name } = params;
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
          ...(delay_typing !== undefined && { delay_typing }), ...(delay_message !== undefined && { delay_message }),
          ...(mentions?.length && { mentions }), ...(mentions_everyone && { mentions_everyone: true }) };
        const { status, data } = await callEdge("send-message", sendBody);
        if (status >= 400) return json({ ok: false, error: data?.error || `send-message ${status}`, detail: data }, status);
        return json({ ok: true, ...data, to: resolved.chat_name, instance: targetInstance });
      }

      case "send_voice": {
        const { to, text, voice_id, model_id, stability, similarity_boost, style, speed, instance, agent_name } = params;
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
        const { message_id, new_content } = params;
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
        const { message_id } = params;
        const { data: msg, error } = await supabase.from("messages").select("provider_msg_id,chat_id,from_me,instance_id").eq("id", message_id).single();
        if (error || !msg) return json({ error: error?.message || "mensagem nao encontrada" }, 404);
        const phone = String(msg.chat_id).replace(/@.*$/, "");
        const { status, data } = await callEdge("zapi-proxy", { action: "delete-message", params: { phone, messageId: msg.provider_msg_id, owner: !!msg.from_me }, confirmed: true, agent_name: "mcp-api", agent_request_id: crypto.randomUUID(), instance: msg.instance_id });
        if (status >= 400) return json({ ok: false, error: data?.error || `zapi ${status}` }, status);
        await supabase.from("messages").update({ is_deleted: true }).eq("id", message_id);
        return json({ ok: true, deleted: true, message_id });
      }

      case "zapi_action": {
        const { action: zaction, params: zparams = {}, confirmed, instance } = params;
        const { status, data } = await callEdge("zapi-proxy", { action: zaction, params: zparams, confirmed, agent_name: "mcp-api", agent_request_id: crypto.randomUUID(), instance });
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

      default: return json({ error: "action_not_implemented", action }, 400);
    }
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
