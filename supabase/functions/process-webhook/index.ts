import { createClient } from "npm:@supabase/supabase-js@2";
import {
  getProvider,
  type InboundEvent,
  type InstanceCreds,
  type MediaRef,
} from "../_shared/wa/index.ts";
import type { WaProvider } from "../_shared/wa/provider.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Auth do webhook — SENHA POR INSTANCIA (multi-instancia / multi-provider).
//
// Z-API envia o webhook-token (configurado no painel da instancia, separado do
// Client-Token usado em chamadas API) no header `z-api-token`. Capturado em
// 2026-05-02 via debug temporario — exemplo: "1F80DD47AE40B88186F0D417".
//
// IMPORTANTE: o Client-Token da `wa_instance.client_token` (usado em send-*)
// NAO e o mesmo token enviado em webhooks. Sao dois tokens distintos, ambos
// gerenciados pela Z-API. A verificacao em si vive no adapter
// (provider.verifyWebhookAuth, PURO); o gate WEBHOOK_REQUIRE_AUTH + o TOFU
// (aprender o token na 1a request) ficam AQUI no orquestrador pois envolvem I/O.
const REQUIRE_AUTH = Deno.env.get("WEBHOOK_REQUIRE_AUTH") === "true";
const ZAPI_WEBHOOK_TOKEN = Deno.env.get("ZAPI_WEBHOOK_TOKEN") ?? "";

// DEBUG TEMPORARIO: quando true, anexa todos os headers da requisicao em
// webhook_events_raw.payload._debug_headers pra investigar o que o provider
// realmente envia. Desligar (false) apos identificar o header de auth correto.
const DEBUG_HEADERS = Deno.env.get("WEBHOOK_DEBUG_HEADERS") === "true";

// Credenciais vêm da tabela wa_instance (migration 0031 renomeou zapi_instance).

// Colunas que o orquestrador lê de wa_instance pra montar InstanceCreds + auth.
const CREDS_COLUMNS =
  "provider, instance_id, base_url, auth_token, client_token, alias, webhook_token";

// creds carrega webhook_token alem dos campos de InstanceCreds (usado no TOFU/auth).
type CredsRow = InstanceCreds & { webhook_token?: string | null };

// Providers registrados, em ordem de tentativa de match do webhook.
const PROVIDERS: WaProvider[] = [getProvider("zapi"), getProvider("evolution")];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return new Response("invalid json", { status: 400, headers: cors });
  }

  // ── Detecta o provider tentando os adapters registrados ───────────────────
  const provider = PROVIDERS.find((p) => p.matchesWebhook(payload)) ?? null;

  // ── Resolve credenciais da instancia (se o provider souber a chave) ────────
  const instKey = provider?.webhookInstanceKey(payload) ?? null;
  let creds: CredsRow | null = null;
  if (instKey) {
    const { data } = await supabase
      .from("wa_instance")
      .select(CREDS_COLUMNS)
      .eq("instance_id", instKey)
      .maybeSingle();
    creds = (data as CredsRow | null) ?? null;
  }

  // ── Auth do webhook (gate + TOFU para Z-API) ──────────────────────────────
  // Caminhos aceitos:
  //   (a) supplied == ZAPI_WEBHOOK_TOKEN (env) — compat da instancia pessoal;
  //   (b) provider.verifyWebhookAuth(...) == true (token salvo da instancia bate);
  //   (c) TOFU (so Z-API): instancia REGISTRADA mas ainda sem webhook_token salvo
  //       -> aprende a senha desta 1a requisicao e passa a exigi-la dai em diante.
  if (REQUIRE_AUTH && provider) {
    const supplied = req.headers.get("z-api-token") ?? "";
    let authed = !!ZAPI_WEBHOOK_TOKEN && supplied === ZAPI_WEBHOOK_TOKEN;

    if (!authed) {
      authed = provider.verifyWebhookAuth(payload, req.headers, creds);
    }

    // TOFU (apenas Z-API): aprende o webhook_token de uma instancia registrada
    // que ainda nao tem um salvo. Replica o comportamento legado do orquestrador.
    if (!authed && provider.id === "zapi" && instKey && supplied && creds && !creds.webhook_token) {
      await supabase
        .from("wa_instance")
        .update({ webhook_token: supplied })
        .eq("instance_id", instKey);
      console.warn("WEBHOOK_AUTH: TOFU aprendeu webhook_token da instancia", instKey);
      creds.webhook_token = supplied;
      authed = true;
    }

    if (!authed) {
      console.warn("WEBHOOK_AUTH: rejeitado", instKey);
      return jsonResponse({ error: "unauthorized" }, 401);
    }
  }

  // DEBUG: anexa headers no payload pra inspecao posterior (flag temporaria)
  if (DEBUG_HEADERS) {
    const headersObj: Record<string, string> = {};
    req.headers.forEach((v, k) => { headersObj[k] = v; });
    payload._debug_headers = headersObj;
  }

  // Log bruto (sempre, antes de processar).
  // was_waiting: Z-API entrega ReceivedCallback com waitingMessage=true quando
  // WhatsApp Multi-Device ainda nao decriptou a mensagem. Marcado aqui pra
  // metrica via v_waiting_messages_status (resolved/pending/lost).
  const { data: rawRow } = await supabase
    .from("webhook_events_raw")
    .insert({
      event_type: payload.type ?? payload.event ?? "unknown",
      payload,
      was_waiting: payload?.waitingMessage === true,
    })
    .select("id")
    .single();

  try {
    if (!provider) {
      console.log("Unhandled webhook (nenhum provider deu match)", payload?.type);
    } else {
      let events: InboundEvent[] = await provider.normalizeInbound(payload, creds as InstanceCreds);
      if (provider.resolveChatIds) {
        events = await provider.resolveChatIds(events, creds as InstanceCreds, { supabase });
      }
      for (const ev of events) {
        await dispatch(ev, creds as InstanceCreds, provider);
      }
    }

    if (rawRow?.id) {
      await supabase
        .from("webhook_events_raw")
        .update({ processed: true, processed_at: new Date().toISOString() })
        .eq("id", rawRow.id);
    }
    return jsonResponse({ ok: true });
  } catch (err) {
    console.error("process-webhook error", err);
    if (rawRow?.id) {
      await supabase.from("webhook_events_raw").update({ error: String(err) }).eq("id", rawRow.id);
    }
    return jsonResponse({ error: String(err) }, 500);
  }
});

// ─── dispatch: persiste um InboundEvent neutro ───────────────────────────────
// Porta a metade de PERSISTENCIA dos antigos handlers (a metade de PARSING
// migrou pros adapters via normalizeInbound). instance_id vem de creds.
async function dispatch(ev: InboundEvent, creds: InstanceCreds, provider: WaProvider): Promise<void> {
  const instanceId = creds.instance_id;
  switch (ev.kind) {
    case "message":      return persistMessage(ev, instanceId, creds, provider);
    case "status":       return persistStatus(ev, instanceId);
    case "reaction":     return persistReaction(ev, instanceId);
    case "edit":         return persistEdit(ev, instanceId);
    case "revoke":       return persistRevoke(ev, instanceId);
    case "group_participant": return persistGroupParticipant(ev, instanceId);
    case "connection":   return persistConnection(ev, instanceId);
  }
}

// kind:"message" — porta handleReceived (process-webhook legado :261-352).
async function persistMessage(
  ev: Extract<InboundEvent, { kind: "message" }>,
  instanceId: string,
  creds: InstanceCreds,
  provider: WaProvider,
): Promise<void> {
  const ts = ev.timestamp;
  const chatId = ev.chatId;
  // phone só é populado para chat_id puro digit (privados 1-1).
  // Grupos (-group / @g.us), LIDs (@lid), newsletters e broadcasts não têm phone real.
  const phone = typeof chatId === "string" && /^[0-9]+$/.test(chatId) ? chatId : null;

  // is_community / profile_thumbnail nao fazem parte do InboundEvent neutro mas
  // existem no payload Z-API cru (ev.raw). Lidos defensivamente pra preservar o
  // comportamento legado sem acoplar o orquestrador a um provider especifico:
  // ausentes (Evolution) viram false/null, que e o default da coluna.
  const raw = (ev.raw ?? {}) as Record<string, unknown>;
  const isCommunity = raw.isCommunity === true;
  const profileThumbnail = (typeof raw.photo === "string" ? raw.photo : null);

  await supabase.from("chats").upsert({
    instance_id: instanceId,
    chat_id: chatId,
    phone,
    chat_name: ev.chatName,
    is_group: ev.isGroup,
    is_community: isCommunity,
    profile_thumbnail: profileThumbnail,
    last_message_at: ts,
    ...(ev.fromMe ? { last_sent_at: ts } : { last_received_at: ts }),
  }, { onConflict: "instance_id,chat_id" });

  const { data: msg, error } = await supabase.from("messages").insert({
    instance_id: instanceId,
    provider_msg_id: ev.providerMsgId,
    chat_id: chatId,
    direction: ev.fromMe ? "sent" : "received",
    from_me: ev.fromMe,
    sender_phone: ev.senderPhone,
    sender_name: ev.senderName,
    message_type: ev.messageType,
    content: ev.content,
    caption: ev.caption,
    raw_type_hint: null, // logica Z-API-especifica descontinuada na neutralizacao
    quoted_msg_id: ev.quotedProviderId,
    is_forwarded: ev.isForwarded,
    message_ts: ts,
    raw_payload: ev.raw,
  }).select("id").single();

  if (error?.code === "23505") return; // duplicado (provider_msg_id ja existe)
  if (error) throw error;

  if (ev.media) {
    await downloadMediaToStorage(msg!.id, instanceId, chatId, ev.providerMsgId, ev.media, creds, provider);
  }
}

// kind:"status" — porta handleStatus (:367-377). ev.status ja mapeado (sent/delivered/read).
async function persistStatus(
  ev: Extract<InboundEvent, { kind: "status" }>,
  instanceId: string,
): Promise<void> {
  for (const id of ev.providerMsgIds) {
    await supabase.from("messages").update({ send_status: ev.status })
      .eq("instance_id", instanceId)
      .eq("provider_msg_id", id)
      .eq("sent_by_agent", true);
  }
}

// kind:"reaction" — porta handleReaction (:379-405). emoji vazio/null => delete.
async function persistReaction(
  ev: Extract<InboundEvent, { kind: "reaction" }>,
  instanceId: string,
): Promise<void> {
  if (!ev.emoji) {
    await supabase.from("message_reactions").delete()
      .eq("instance_id", instanceId)
      .eq("target_msg_id", ev.targetProviderMsgId)
      .eq("reactor_phone", ev.reactorPhone);
    return;
  }
  await supabase.from("message_reactions").upsert({
    instance_id: instanceId,
    target_msg_id: ev.targetProviderMsgId,
    chat_id: ev.chatId,
    reactor_phone: ev.reactorPhone,
    reactor_name: ev.reactorName,
    emoji: ev.emoji,
    from_me: ev.fromMe,
    reacted_at: ev.timestamp,
    raw_payload: ev.raw,
  }, { onConflict: "instance_id,target_msg_id,reactor_phone" });
}

// kind:"edit" — porta handleEdited (:407-415).
async function persistEdit(
  ev: Extract<InboundEvent, { kind: "edit" }>,
  instanceId: string,
): Promise<void> {
  const { data: existing } = await supabase.from("messages").select("id, content")
    .eq("instance_id", instanceId)
    .eq("provider_msg_id", ev.providerMsgId)
    .maybeSingle();
  if (!existing) return;
  await supabase.from("messages")
    .update({ is_edited: true, content: ev.newContent })
    .eq("id", existing.id);
  await supabase.from("message_edits").insert({
    message_id: existing.id,
    previous_content: existing.content,
    new_content: ev.newContent,
  });
}

// kind:"revoke" — porta handleRevoked (:417-421).
async function persistRevoke(
  ev: Extract<InboundEvent, { kind: "revoke" }>,
  instanceId: string,
): Promise<void> {
  await supabase.from("messages").update({ is_deleted: true })
    .eq("instance_id", instanceId)
    .eq("provider_msg_id", ev.providerMsgId);
}

// kind:"group_participant" — porta handleGroupNotif (:431-445).
async function persistGroupParticipant(
  ev: Extract<InboundEvent, { kind: "group_participant" }>,
  instanceId: string,
): Promise<void> {
  for (const phone of ev.phones) {
    if (ev.action === "add") {
      await supabase.from("group_participants").upsert({
        instance_id: instanceId,
        chat_id: ev.chatId,
        phone,
        joined_at: new Date().toISOString(),
        left_at: null,
      }, { onConflict: "instance_id,chat_id,phone" });
    } else if (ev.action === "remove") {
      await supabase.from("group_participants")
        .update({ left_at: new Date().toISOString() })
        .eq("instance_id", instanceId).eq("chat_id", ev.chatId).eq("phone", phone);
    } else if (ev.action === "promote") {
      await supabase.from("group_participants")
        .update({ is_admin: true })
        .eq("instance_id", instanceId).eq("chat_id", ev.chatId).eq("phone", phone);
    } else if (ev.action === "demote") {
      await supabase.from("group_participants")
        .update({ is_admin: false })
        .eq("instance_id", instanceId).eq("chat_id", ev.chatId).eq("phone", phone);
    }
  }
}

// kind:"connection" — porta handleConnection (:426-428). Tabela agora e wa_instance,
// keyed por creds.instance_id.
async function persistConnection(
  ev: Extract<InboundEvent, { kind: "connection" }>,
  instanceId: string,
): Promise<void> {
  const field = ev.connected ? "last_connected_at" : "last_disconnected_at";
  await supabase.from("wa_instance")
    .update({ [field]: new Date().toISOString(), is_active: ev.connected })
    .eq("instance_id", instanceId);
}

// ─── Mídia: busca bytes via provider + sobe pro Storage ──────────────────────
// Porta downloadMediaToStorage (:477-503), mas os bytes agora vêm de
// provider.fetchMedia(creds, ref) em vez de um GET direto na URL aqui.
async function downloadMediaToStorage(
  messageId: string,
  instanceId: string,
  chatId: string,
  msgId: string,
  ref: MediaRef,
  creds: InstanceCreds,
  provider: WaProvider,
): Promise<void> {
  const path = `${instanceId}/${chatId}/${msgId}.${ref.ext}`;
  const { data: mediaRow } = await supabase.from("message_media").insert({
    message_id: messageId,
    mime_type: ref.mime,
    storage_bucket: ref.bucket,
    storage_path: path,
    original_url: ref.url ?? null,
    duration_seconds: ref.duration ?? null,
    width: ref.width ?? null,
    height: ref.height ?? null,
    download_status: "pending",
  }).select("id").single();

  try {
    const { bytes, mime } = await provider.fetchMedia(creds, ref);
    const { error: upErr } = await supabase.storage.from(ref.bucket)
      .upload(path, bytes, { contentType: mime, upsert: true });
    if (upErr) throw upErr;

    // Thumbnail: so quando o provider expõe thumbUrl no MediaRef (Z-API).
    if (ref.thumbUrl) {
      try {
        const tb = await fetchThumbnail(ref.thumbUrl);
        const tp = `${instanceId}/${chatId}/${msgId}.jpg`;
        await supabase.storage.from("whatsapp-thumbnails")
          .upload(tp, tb, { contentType: "image/jpeg", upsert: true });
        await supabase.from("message_media").update({ thumbnail_path: tp }).eq("id", mediaRow!.id);
      } catch { /* thumb nao bloqueia */ }
    }

    await supabase.from("message_media")
      .update({ download_status: "done", file_size_bytes: bytes.length })
      .eq("id", mediaRow!.id);
  } catch (e) {
    await supabase.from("message_media")
      .update({ download_status: "pending", download_error: String(e) })
      .eq("id", mediaRow!.id);
  }
}

// GET direto de um thumbnail (URL publica/temporaria). Mantido no orquestrador
// pois o thumbnail e secundario e nao passa pelo fluxo de fetchMedia do provider.
async function fetchThumbnail(url: string): Promise<Uint8Array> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { "User-Agent": "whatsapp-agent/1.0" },
    });
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}
