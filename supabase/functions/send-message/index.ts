import { createClient } from "npm:@supabase/supabase-js@2";
import { getProvider, type OutboundMessage, type InstanceCreds } from "../_shared/wa/index.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ─── HARDENING (v8) ──────────────────────────────────────────────────────────
// Recomendacao do conselho de LLMs (sessao 01/05/2026): defense-in-depth.
// MCP ja tem gate confirmed=true client-side; aqui dobra com server-side check
// + rate limit + audit log estruturado.

// Rate limits — ajustar via env vars sem redeploy
const RATE_LIMIT_PER_CHAT_PER_MIN  = Number(Deno.env.get("RATE_LIMIT_PER_CHAT_PER_MIN")  ?? "5");
const RATE_LIMIT_GLOBAL_PER_MIN    = Number(Deno.env.get("RATE_LIMIT_GLOBAL_PER_MIN")    ?? "30");
const RATE_LIMIT_GLOBAL_PER_DAY    = Number(Deno.env.get("RATE_LIMIT_GLOBAL_PER_DAY")    ?? "200");

// Server-side guard: requer confirmed=true no body. Pode ser desativado via env
// pra debug. Default: ON.
const REQUIRE_CONFIRMED = Deno.env.get("REQUIRE_CONFIRMED") !== "false";

async function checkRateLimit(instanceId: string, chat_id: string): Promise<{ ok: boolean; reason?: string; meta?: any }> {
  const now = new Date();
  const oneMinAgo = new Date(now.getTime() - 60_000).toISOString();
  const oneDayAgo = new Date(now.getTime() - 86_400_000).toISOString();

  // OTIMIZACAO 09/05/2026: 2 mudancas combinadas:
  // 1. COUNT(*) -> SELECT id LIMIT (limite+1): early termination
  // 2. Filtro por message_ts (indexado) em vez de created_at (nao indexado):
  //    o LIMIT sozinho nao bastou — Postgres ainda precisava ler ~325k linhas
  //    sequencialmente pra achar N+1 que combinassem (from_me=true AND created_at >= ?)
  //    sem indice composto. Trocando pra message_ts (idx_messages_message_ts existe),
  //    queries caem de ~8s para ~250ms. Total rate limit: 22s -> 700ms.
  //
  //    Semantica: para rate limit, message_ts (timestamp da msg) e o created_at
  //    (timestamp do INSERT) sao virtualmente identicos pra outbounds — nos
  //    setamos message_ts: new Date().toISOString() ao inserir.
  //
  // Loss: meta agora reporta count_at_least em vez de count exato — aceitavel.

  // Por chat / minuto (isolado por instância)
  const { data: perChatRows } = await supabase
    .from("messages")
    .select("id")
    .eq("instance_id", instanceId)
    .eq("chat_id", chat_id)
    .eq("from_me", true)
    .gte("message_ts", oneMinAgo)
    .limit(RATE_LIMIT_PER_CHAT_PER_MIN + 1);
  if ((perChatRows?.length ?? 0) >= RATE_LIMIT_PER_CHAT_PER_MIN) {
    return { ok: false, reason: "rate_limit_per_chat_per_min",
             meta: { instance_id: instanceId, chat_id, count_at_least: perChatRows?.length, limit: RATE_LIMIT_PER_CHAT_PER_MIN } };
  }

  // Global / minuto (por instância — cada número tem cota própria)
  const { data: globalMinRows } = await supabase
    .from("messages")
    .select("id")
    .eq("instance_id", instanceId)
    .eq("from_me", true)
    .gte("message_ts", oneMinAgo)
    .limit(RATE_LIMIT_GLOBAL_PER_MIN + 1);
  if ((globalMinRows?.length ?? 0) >= RATE_LIMIT_GLOBAL_PER_MIN) {
    return { ok: false, reason: "rate_limit_global_per_min",
             meta: { instance_id: instanceId, count_at_least: globalMinRows?.length, limit: RATE_LIMIT_GLOBAL_PER_MIN } };
  }

  // Global / dia (por instância)
  const { data: globalDayRows } = await supabase
    .from("messages")
    .select("id")
    .eq("instance_id", instanceId)
    .eq("from_me", true)
    .gte("message_ts", oneDayAgo)
    .limit(RATE_LIMIT_GLOBAL_PER_DAY + 1);
  if ((globalDayRows?.length ?? 0) >= RATE_LIMIT_GLOBAL_PER_DAY) {
    return { ok: false, reason: "rate_limit_global_per_day",
             meta: { instance_id: instanceId, count_at_least: globalDayRows?.length, limit: RATE_LIMIT_GLOBAL_PER_DAY } };
  }

  return { ok: true };
}


Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  let body: any;
  try { body = await req.json(); }
  catch { return json({ error: "invalid json" }, 400); }

  const {
    chat_id, content, message_type, media_url, file_name, quoted_msg_id,
    agent_request_id, agent_name, confirmed,
    delay_typing, delay_message,  // simulacao humana — repassa pra Z-API se presentes
    mentions, mentions_everyone,  // mencoes em grupos
    instance: instanceKey,        // alias ('pessoal'/'profissional') ou instance_id; default se ausente
  } = body;

  if (!chat_id || !message_type) return json({ error: "chat_id e message_type sao obrigatorios" }, 400);

  // Validacao de payload ANTES de inserir/chamar o provider: content vazio era a
  // causa nº1 de envio failed (Z-API 400 "The field 'message' is empty") — a msg
  // ja tinha virado linha em messages e o erro so aparecia no send_error.
  if (message_type === "text" && (typeof content !== "string" || content.trim().length === 0)) {
    return json({ error: "content vazio: envio de texto exige content nao-vazio" }, 400);
  }
  if (["image", "document", "video", "audio", "ptt"].includes(message_type) && !media_url) {
    return json({ error: `media_url obrigatorio para message_type=${message_type}` }, 400);
  }

  // Server-side guard: requer confirmed=true (defense-in-depth do gate do MCP)
  if (REQUIRE_CONFIRMED && confirmed !== true) {
    return json({
      error: "confirmed=true e obrigatorio no body. Edge Function valida defense-in-depth do gate client-side.",
      hint: "Se chamando direto sem MCP, garanta UI/CLI mostrou destinatario+conteudo ao usuario antes.",
    }, 403);
  }

  // Resolve instância (alias/instance_id) → credenciais; fallback default.
  // Sanitiza instanceKey pra evitar injeção no filtro .or() do PostgREST.
  if (instanceKey !== undefined && (typeof instanceKey !== "string" || !/^[A-Za-z0-9_-]+$/.test(instanceKey))) {
    return json({ error: "instance invalido" }, 400);
  }
  const instSel = supabase.from("wa_instance").select("provider, instance_id, base_url, auth_token, client_token, alias");
  const { data: instanceRow } = (typeof instanceKey === "string" && instanceKey.length > 0)
    ? await instSel.or(`alias.eq.${instanceKey},instance_id.eq.${instanceKey}`).limit(1).maybeSingle()
    : await instSel.eq("is_default", true).maybeSingle();
  if (!instanceRow) return json({ error: "instancia nao encontrada" }, 500);
  const instance: InstanceCreds = {
    provider: instanceRow.provider,
    instance_id: instanceRow.instance_id,
    base_url: instanceRow.base_url ?? null,
    auth_token: instanceRow.auth_token,
    client_token: instanceRow.client_token ?? null,
    alias: instanceRow.alias ?? null,
  };

  // Lookup do chat ESCOPADO por instância (senão colide entre números)
  const { data: chat } = await supabase.from("chats").select("chat_id, phone, is_group")
    .eq("instance_id", instance.instance_id).eq("chat_id", chat_id).single();
  if (!chat) return json({ error: "chat nao encontrado nesta instancia" }, 404);

  // Rate limit (por instância)
  const rl = await checkRateLimit(instance.instance_id, chat_id);
  if (!rl.ok) {
    return json({ error: "rate_limit", reason: rl.reason, meta: rl.meta }, 429);
  }

  const tempId = crypto.randomUUID();
  const { data: msg, error: insertErr } = await supabase.from("messages").insert({
    instance_id: instance.instance_id,
    provider_msg_id: `pending-${tempId}`,
    chat_id, direction: "sent", from_me: true,
    message_type, content: content ?? null,
    quoted_msg_id: quoted_msg_id ?? null,
    send_status: "pending", sent_by_agent: true,
    sent_by_agent_name: agent_name ?? "unknown",
    agent_request_id: agent_request_id ?? null,
    message_ts: new Date().toISOString(), raw_payload: body,
  }).select("id").single();

  if (insertErr) return json({ error: insertErr.message }, 500);

  const phone = chat.phone ?? chat_id.replace("@c.us", "").replace("@g.us", "");

  // Resolve quoted_msg_id: aceita UUID interno (lookup → provider_msg_id) ou provider_msg_id direto.
  // Se UUID nao existir/estiver pending, vira null e msg vai SEM reply (sem regressao vs comportamento anterior).
  let resolvedQuotedId: string | null = quoted_msg_id ?? null;
  if (resolvedQuotedId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(resolvedQuotedId)) {
    const { data: msgRow } = await supabase
      .from("messages")
      .select("provider_msg_id")
      .eq("id", resolvedQuotedId)
      .maybeSingle();
    if (msgRow?.provider_msg_id && !msgRow.provider_msg_id.startsWith("pending-") && !msgRow.provider_msg_id.startsWith("sent-")) {
      resolvedQuotedId = msgRow.provider_msg_id;
    } else {
      resolvedQuotedId = null;
    }
  }

  // Monta lista de mencoes explicitas; expansao @todos e responsabilidade do adapter buildSend.
  const mentionedList: string[] = Array.isArray(mentions) ? mentions.filter((m: any): m is string => typeof m === "string") : [];

  try {
    const provider = getProvider(instance.provider);
    const outbound: OutboundMessage = {
      chatId: chat_id,
      phone,
      type: message_type,
      content: content ?? undefined,
      media: media_url ? { url: media_url, fileName: file_name } : undefined,
      caption: content ?? undefined,
      quotedProviderId: resolvedQuotedId,
      mentions: mentionedList,
      mentionsEveryone: !!mentions_everyone,
      isGroup: !!chat.is_group,
      delayTyping: delay_typing,
      delayMessage: delay_message,
    };
    const built = await provider.buildSend(instance, outbound);
    const r = await fetch(built.url, { method: built.method, headers: built.headers, body: built.body });
    if (!r.ok) throw new Error(`${instance.provider} ${r.status}: ${await r.text()}`);
    const realId = provider.parseSendResult(await r.json()).providerMsgId || `sent-${tempId}`;
    await supabase.from("messages").update({ provider_msg_id: realId, send_status: "sent" }).eq("id", msg!.id);
    return json({ ok: true, message_id: msg!.id, provider_msg_id: realId, agent: agent_name ?? "unknown" });
  } catch (e) {
    await supabase.from("messages").update({ send_status: "failed", send_error: String(e) }).eq("id", msg!.id);
    return json({ error: String(e) }, 500);
  }
});

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
