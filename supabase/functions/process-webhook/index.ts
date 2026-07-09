import { createClient } from "npm:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Valida o header `z-api-token` contra o secret ZAPI_WEBHOOK_TOKEN.
//
// Z-API envia o webhook-token (configurado no painel da instancia, separado do
// Client-Token usado em chamadas API) no header `z-api-token`. Capturado em
// 2026-05-02 via debug temporario — exemplo: "1F80DD47AE40B88186F0D417".
//
// IMPORTANTE: o Client-Token da `zapi_instance.client_token` (usado em send-*)
// NAO e o mesmo token enviado em webhooks. Sao dois tokens distintos, ambos
// gerenciados pela Z-API.
const REQUIRE_AUTH = Deno.env.get("WEBHOOK_REQUIRE_AUTH") === "true";
const ZAPI_WEBHOOK_TOKEN = Deno.env.get("ZAPI_WEBHOOK_TOKEN") ?? "";

// DEBUG TEMPORARIO: quando true, anexa todos os headers da requisicao em
// webhook_events_raw.payload._debug_headers pra investigar o que Z-API
// realmente envia. Desligar (false) apos identificar o header de auth correto.
const DEBUG_HEADERS = Deno.env.get("WEBHOOK_DEBUG_HEADERS") === "true";

// Credenciais Z-API vêm da tabela zapi_instance (centralizado no item 8.1).
// Env vars ZAPI_INSTANCE_ID/TOKEN/CLIENT_TOKEN foram removidas de todas as máquinas.

// ─── Resolução de instância (multi-instância) ────────────────────────────────
// O payload Z-API traz p.instanceId em todo evento. Mapeamos pro instance_id
// canônico da tabela zapi_instance (cache em memória do isolate). Fallback
// 'unknown' (não-nulo) pra nunca perder mensagem nem furar UNIQUE composto.
const _instCache = new Map<string, string>();
const FALLBACK_INSTANCE = "unknown";

async function resolveInstance(p: any): Promise<string> {
  const raw = typeof p?.instanceId === "string" ? p.instanceId : null;
  if (!raw) return FALLBACK_INSTANCE;
  if (_instCache.has(raw)) return _instCache.get(raw)!;
  const { data } = await supabase
    .from("zapi_instance")
    .select("instance_id")
    .eq("instance_id", raw)
    .maybeSingle();
  const resolved = data?.instance_id ?? FALLBACK_INSTANCE;
  if (resolved === FALLBACK_INSTANCE) {
    console.warn("WEBHOOK: instanceId desconhecido", raw, "type", p?.type);
    // TODO Fase 7: disparar alerta Telegram em instância desconhecida.
  }
  _instCache.set(raw, resolved);
  return resolved;
}

function isLid(s: unknown): s is string {
  return typeof s === "string" && s.endsWith("@lid");
}

/**
 * Tenta resolver um LID @lid pro phone numerico real, em 3 camadas:
 *   1. Cache em lid_mapping (resolved_via='cache' apos 1a resolucao)
 *   2. Match por chat_name -> chat numerico mais recente (resolved_via='chat_name')
 *   3. Z-API GET /contacts/<lid> (resolved_via='zapi')
 * Retorna {phone:null, via:'unresolved'} se as 3 camadas falham.
 */
async function resolveLidToPhone(
  lid: string,
  chatName: string | null,
  instanceId: string,
): Promise<{ phone: string | null; via: string }> {
  // 1. Cache (escopado por instância — o espaço de LID é por número do dono)
  const { data: cached } = await supabase
    .from("lid_mapping")
    .select("phone")
    .eq("instance_id", instanceId)
    .eq("lid", lid)
    .maybeSingle();
  if (cached?.phone) return { phone: cached.phone, via: "cache" };

  // 2. Match pelo chat_name -> chat numerico mais recente (DA MESMA instância)
  if (chatName) {
    const { data: existing } = await supabase
      .from("chats")
      .select("chat_id")
      .eq("instance_id", instanceId)
      .eq("chat_name", chatName)
      .not("chat_id", "like", "%@lid")
      .not("chat_id", "like", "%-group")
      .not("chat_id", "like", "%@g.us")
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(1);
    const cid = existing?.[0]?.chat_id;
    if (cid && /^\d+$/.test(cid)) {
      await supabase
        .from("lid_mapping")
        .upsert({ instance_id: instanceId, lid, phone: cid, chat_name: chatName, resolved_via: "chat_name" });
      return { phone: cid, via: "chat_name" };
    }
  }

  // 3. Z-API contacts endpoint — credenciais da instância CORRETA
  try {
    const { data: inst } = await supabase
      .from("zapi_instance")
      .select("instance_id, token, client_token")
      .eq("instance_id", instanceId)
      .maybeSingle();
    if (inst) {
      const r = await fetch(
        `https://api.z-api.io/instances/${inst.instance_id}/token/${inst.token}/contacts/${encodeURIComponent(lid)}`,
        { headers: { "Client-Token": inst.client_token } },
      );
      if (r.ok) {
        const j = await r.json();
        const resolved = j?.phone ?? j?.contact?.phone ?? null;
        if (resolved && /^\d+$/.test(String(resolved))) {
          await supabase.from("lid_mapping").upsert({
            instance_id: instanceId,
            lid,
            phone: String(resolved),
            chat_name: chatName,
            resolved_via: "zapi",
          });
          return { phone: String(resolved), via: "zapi" };
        }
      }
    }
  } catch (e) {
    console.warn("zapi resolve fail", lid, e);
  }

  return { phone: null, via: "unresolved" };
}

/**
 * Resolve o chat_id efetivo de um payload Z-API.
 * Caso comum: retorna p.phone direto. Caso fromMe=true && phone=@lid (msg
 * enviada de dispositivo linked): tenta resolver via cache/chat_name/Z-API.
 * Se as 3 camadas falham, retorna o LID original (fallback) — chat fica
 * marcado com raw_payload._lid_unresolved=true pra retry posterior.
 */
async function resolveChatIdFromPayload(p: any, instanceId: string): Promise<{ chatId: string; resolved: boolean }> {
  if (!isLid(p.phone)) return { chatId: p.phone, resolved: true };
  if (!p.fromMe)       return { chatId: p.phone, resolved: true }; // recebida @lid (raro)
  if (p.isGroup)       return { chatId: p.phone, resolved: true }; // grupo @lid

  const { phone } = await resolveLidToPhone(p.phone, p.chatName ?? null, instanceId);
  return phone ? { chatId: phone, resolved: true } : { chatId: p.phone, resolved: false };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return new Response("invalid json", { status: 400, headers: cors });
  }

  // Auth do webhook — SENHA POR INSTANCIA (multi-instancia). Cada instancia Z-API
  // tem seu PROPRIO webhook-token (mandado no header `z-api-token`). Validamos a
  // senha recebida contra zapi_instance.webhook_token DA INSTANCIA do payload.
  // Caminhos aceitos:
  //   (a) supplied == ZAPI_WEBHOOK_TOKEN (env) — compat da instancia pessoal;
  //   (b) supplied == webhook_token salvo da instancia (payload.instanceId);
  //   (c) TOFU: instancia REGISTRADA mas ainda sem webhook_token salvo -> aprende
  //       a senha desta 1a requisicao e passa a exigi-la dai em diante.
  if (REQUIRE_AUTH) {
    const supplied = req.headers.get("z-api-token") ?? "";
    let authed = !!ZAPI_WEBHOOK_TOKEN && supplied === ZAPI_WEBHOOK_TOKEN;
    if (!authed) {
      const rawInst = typeof payload?.instanceId === "string" ? payload.instanceId : null;
      if (rawInst && supplied) {
        const { data: inst } = await supabase
          .from("zapi_instance").select("webhook_token").eq("instance_id", rawInst).maybeSingle();
        if (inst) {
          if (inst.webhook_token === supplied) {
            authed = true;
          } else if (!inst.webhook_token) {
            // TOFU: aprende o webhook-token desta instancia registrada
            await supabase.from("zapi_instance").update({ webhook_token: supplied }).eq("instance_id", rawInst);
            console.warn("WEBHOOK_AUTH: TOFU aprendeu webhook_token da instancia", rawInst);
            authed = true;
          }
        }
      }
    }
    if (!authed) {
      console.warn("WEBHOOK_AUTH: rejeitado", payload?.instanceId);
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401, headers: { ...cors, "Content-Type": "application/json" },
      });
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
      event_type: payload.type ?? "unknown",
      payload,
      was_waiting: payload?.waitingMessage === true,
    })
    .select("id")
    .single();

  try {
    await routeEvent(payload);
    if (rawRow?.id) {
      await supabase
        .from("webhook_events_raw")
        .update({ processed: true, processed_at: new Date().toISOString() })
        .eq("id", rawRow.id);
    }
    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("process-webhook error", err);
    if (rawRow?.id) {
      await supabase.from("webhook_events_raw").update({ error: String(err) }).eq("id", rawRow.id);
    }
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});

async function routeEvent(p: any) {
  switch (p.type) {
    case "ReceivedCallback":        return handleReceived(p);
    case "DeliveryCallback":        return handleReceived({ ...p, fromMe: true });
    case "MessageStatusCallback":   return handleStatus(p);
    case "MessageReactionCallback": return handleReaction(p);
    case "EditedMessageCallback":   return handleEdited(p);
    case "RevokedMessageCallback":  return handleRevoked(p);
    case "PresenceChatCallback":    return; // presence_events descontinuada (migration 0022)
    case "ConnectedCallback":       return handleConnection(p, true);
    case "DisconnectedCallback":    return handleConnection(p, false);
    case "NotificationCallback":    return handleGroupNotif(p);
    default: console.log("Unhandled event type:", p.type);
  }
}


async function handleReceived(p: any) {
  // Z-API as vezes manda webhook antes de decriptar/baixar o conteudo.
  // Vem so com metadados (phone, messageId, senderName, waitingMessage:true)
  // e SEM payload de mensagem (text/audio/image/etc). Em segundos ela manda
  // outro webhook com o mesmo messageId e o conteudo real. Se inserirmos esse
  // evento como message_type=unknown, o follow-up bate no unique constraint
  // de provider_msg_id e e descartado silenciosamente — msg fica unknown
  // pra sempre, sem midia. webhook_events_raw ja registra o evento.
  if (p.waitingMessage === true) {
    console.log("skip waitingMessage", p.messageId);
    return;
  }

  // Z-API empacota eventos nao-de-mensagem dentro de type=ReceivedCallback,
  // identificando o conteudo real via flags do payload (verificado 12/05/2026:
  // em 24h, 0 MessageReactionCallback/NotificationCallback foram entregues
  // como type proprio — TUDO vem como ReceivedCallback). routeEvent so olha
  // p.type, entao reactions/notifs/edits caiam em handleReceived virando
  // message_type=unknown e poluindo a tabela messages (issue #5).
  // Redirecionamento defense-in-depth pros handlers corretos.
  if (p.notification) return handleGroupNotif(p);
  if (p.reaction)     return handleReaction(p);
  if (p.isEdit)       return handleEdited(p);
  if (p.pinMessage) {
    // Z-API nao tem schema pra pin/unpin no banco. Log e skip por enquanto.
    console.log("skip pinMessage", p.messageId, p.pinMessage?.action);
    return;
  }

  const ts = new Date(p.momment ?? Date.now()).toISOString();
  const instanceId = await resolveInstance(p);
  const { chatId, resolved } = await resolveChatIdFromPayload(p, instanceId);
  // phone só é populado para chat_id puro digit (privados 1-1).
  // Grupos (-group), LIDs (@lid), newsletters e broadcasts não têm phone real.
  const phone = typeof chatId === "string" && /^[0-9]+$/.test(chatId) ? chatId : null;
  await supabase.from("chats").upsert({
    instance_id: instanceId,
    chat_id: chatId,
    phone,
    chat_name: p.chatName ?? null,
    is_group: !!p.isGroup,
    is_community: !!p.isCommunity,
    profile_thumbnail: p.photo ?? null,
    last_message_at: ts,
    ...(p.fromMe ? { last_sent_at: ts } : { last_received_at: ts }),
  }, { onConflict: "instance_id,chat_id" });

  const { messageType, content, caption, mediaInfo } = extractMediaInfo(p);

  const SKIP_KEYS = new Set([
    "type", "instanceId", "messageId", "phone", "chatName", "senderName",
    "isGroup", "isCommunity", "fromMe", "momment", "photo", "participantPhone",
    "forwarded", "referencedMessage", "broadcast", "fromApi", "waitingMessage",
    "name", "senderPhoto", "status", "ack",
  ]);
  const rawTypeHint = messageType === "unknown"
    ? Object.keys(p).find(k => !SKIP_KEYS.has(k) && p[k] !== null && p[k] !== undefined && p[k] !== false) ?? null
    : null;

  // sender_phone: quando fromMe=true, remetente real é o dono (connectedPhone),
  // não o destinatário. Antes do fix, salvava p.phone (que ia vir como @lid).
  const senderPhone = p.fromMe
    ? (p.connectedPhone ?? p.participantPhone ?? null)
    : (p.participantPhone ?? p.phone);

  const rawPayload = resolved ? p : { ...p, _lid_unresolved: true };

  const { data: msg, error } = await supabase.from("messages").insert({
    instance_id: instanceId,
    provider_msg_id: p.messageId,
    chat_id: chatId,
    direction: p.fromMe ? "sent" : "received",
    from_me: !!p.fromMe,
    sender_phone: senderPhone,
    sender_name: p.senderName ?? null,
    message_type: messageType,
    content,
    caption,
    raw_type_hint: rawTypeHint,
    // Z-API manda a referência do reply como referenceMessageId (string no topo);
    // o shape antigo referencedMessage.messageId nunca apareceu em prod (1,19M
    // msgs, 0 hits — verificado 09/07/2026), fica como fallback defensivo.
    quoted_msg_id: p.referenceMessageId ?? p.referencedMessage?.messageId ?? null,
    is_forwarded: !!p.forwarded,
    message_ts: new Date(p.momment ?? Date.now()).toISOString(),
    raw_payload: rawPayload,
  }).select("id").single();

  if (error?.code === "23505") return; // duplicado
  if (error) throw error;

  if (mediaInfo) {
    await downloadMediaToStorage(msg!.id, instanceId, chatId, p.messageId, mediaInfo);
  }
}

function extractMediaInfo(p: any) {
  if (p.text)     return { messageType: "text",     content: p.text.message,        caption: null,                    mediaInfo: null };
  if (p.image)    return { messageType: "image",    content: null,                   caption: p.image.caption ?? null, mediaInfo: { url: p.image.imageUrl,       mime: p.image.mimeType,    bucket: "whatsapp-images",    ext: "jpg",  width: p.image.width, height: p.image.height, thumb: p.image.thumbnailUrl } };
  if (p.audio)    return { messageType: p.audio.ptt ? "ptt" : "audio", content: null, caption: null,                 mediaInfo: { url: p.audio.audioUrl,       mime: p.audio.mimeType,    bucket: "whatsapp-audio",     ext: "ogg",  duration: p.audio.seconds } };
  if (p.video)    return { messageType: "video",    content: null,                   caption: p.video.caption ?? null, mediaInfo: { url: p.video.videoUrl,       mime: p.video.mimeType,    bucket: "whatsapp-video",     ext: "mp4",  duration: p.video.seconds } };
  if (p.document) return { messageType: "document", content: p.document.fileName,   caption: null,                    mediaInfo: { url: p.document.documentUrl, mime: p.document.mimeType, bucket: "whatsapp-documents", ext: "bin",  filename: p.document.fileName } };
  if (p.sticker)  return { messageType: "sticker",  content: null,                   caption: null,                    mediaInfo: { url: p.sticker.stickerUrl,   mime: p.sticker.mimeType,  bucket: "whatsapp-stickers",  ext: "webp" } };
  if (p.location) return { messageType: "location", content: JSON.stringify(p.location), caption: null,               mediaInfo: null };
  if (p.contact)  return { messageType: "contact",  content: p.contact.displayName, caption: null,                    mediaInfo: null };
  if (p.poll)     return { messageType: "poll",     content: p.poll.name,            caption: null,                    mediaInfo: null };
  return { messageType: "unknown", content: null, caption: null, mediaInfo: null };
}

async function handleStatus(p: any) {
  // Apos remocao de presence_events (migration 0022_2026-05-27), so atualizamos
  // send_status na tabela messages. Sem mais log de presence/delivery rastreado.
  const sendMap: Record<string, string> = { SENT: "sent", RECEIVED: "delivered", READ: "read", PLAYED: "read" };
  const instanceId = await resolveInstance(p);
  for (const id of (p.ids ?? [])) {
    const ns = sendMap[p.status];
    if (ns) await supabase.from("messages").update({ send_status: ns })
      .eq("instance_id", instanceId).eq("provider_msg_id", id).eq("sent_by_agent", true);
  }
}

async function handleReaction(p: any) {
  // Z-API entrega reactions como type=ReceivedCallback com p.reaction.referencedMessage
  // (verificado 12/05/2026). Caso teorico de MessageReactionCallback teria
  // p.referencedMessage no top — mantemos fallback. Se nenhum, ignora.
  const targetId = p.reaction?.referencedMessage?.messageId ?? p.referencedMessage?.messageId;
  if (!targetId) return;
  const emoji = p.reaction?.value || null;
  const instanceId = await resolveInstance(p);
  const { chatId } = await resolveChatIdFromPayload(p, instanceId);
  // reactor_phone: quando fromMe=true, é o dono (connectedPhone), não o LID
  const reactorPhone = p.fromMe
    ? (p.connectedPhone ?? p.participantPhone ?? chatId)
    : (p.participantPhone ?? chatId);
  if (!emoji) {
    await supabase.from("message_reactions").delete()
      .eq("instance_id", instanceId).eq("target_msg_id", targetId).eq("reactor_phone", reactorPhone);
    return;
  }
  const t = p.reaction?.time ?? Date.now();
  await supabase.from("message_reactions").upsert({
    instance_id: instanceId,
    target_msg_id: targetId, chat_id: chatId,
    reactor_phone: reactorPhone,
    reactor_name: p.senderName ?? null, emoji, from_me: !!p.fromMe,
    reacted_at: new Date(t < 1e12 ? t * 1000 : t).toISOString(), raw_payload: p,
  }, { onConflict: "instance_id,target_msg_id,reactor_phone" });
}

async function handleEdited(p: any) {
  const newContent = p.text?.message ?? null;
  const instanceId = await resolveInstance(p);
  const { data: existing } = await supabase.from("messages").select("id, content")
    .eq("instance_id", instanceId).eq("provider_msg_id", p.messageId).maybeSingle();
  if (!existing) return;
  await supabase.from("messages").update({ is_edited: true, content: newContent }).eq("id", existing.id);
  await supabase.from("message_edits").insert({ message_id: existing.id, previous_content: existing.content, new_content: newContent });
}

async function handleRevoked(p: any) {
  const instanceId = await resolveInstance(p);
  await supabase.from("messages").update({ is_deleted: true })
    .eq("instance_id", instanceId).eq("provider_msg_id", p.messageId);
}

// handlePresence removido — tabela presence_events foi descontinuada
// (migration 0022_2026-05-27). Eventos de presence inbound sao ignorados.

async function handleConnection(p: any, connected: boolean) {
  const field = connected ? "last_connected_at" : "last_disconnected_at";
  await supabase.from("zapi_instance").update({ [field]: new Date().toISOString(), is_active: connected }).eq("instance_id", p.instanceId);
}

async function handleGroupNotif(p: any) {
  const phones: string[] = p.notificationParameters ?? [];
  const instanceId = await resolveInstance(p);
  for (const phone of phones) {
    if (p.notification === "GROUP_PARTICIPANT_ADD") {
      await supabase.from("group_participants").upsert({ instance_id: instanceId, chat_id: p.phone, phone, joined_at: new Date().toISOString(), left_at: null }, { onConflict: "instance_id,chat_id,phone" });
    } else if (p.notification === "GROUP_PARTICIPANT_REMOVE") {
      await supabase.from("group_participants").update({ left_at: new Date().toISOString() }).eq("instance_id", instanceId).eq("chat_id", p.phone).eq("phone", phone);
    } else if (p.notification === "GROUP_PARTICIPANT_PROMOTE") {
      await supabase.from("group_participants").update({ is_admin: true }).eq("instance_id", instanceId).eq("chat_id", p.phone).eq("phone", phone);
    } else if (p.notification === "GROUP_PARTICIPANT_DEMOTE") {
      await supabase.from("group_participants").update({ is_admin: false }).eq("instance_id", instanceId).eq("chat_id", p.phone).eq("phone", phone);
    }
  }
}

// Timeout por tipo — Backblaze temp URLs expiram rapido, entao audios/videos/docs tem prioridade
const DL_TIMEOUT_MS: Record<string, number> = {
  "whatsapp-audio":     30000,
  "whatsapp-video":     45000,
  "whatsapp-documents": 30000,
  "whatsapp-images":    15000,
  "whatsapp-stickers":  10000,
};

async function fetchWithRetry(url: string, timeoutMs: number, attempts = 2): Promise<Uint8Array> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      const res = await fetch(url, {
        signal: ac.signal,
        headers: { "User-Agent": "whatsapp-agent/1.0" },
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`fetch ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 500));
    }
  }
  throw lastErr;
}

async function downloadMediaToStorage(messageId: string, instanceId: string, chatId: string, msgId: string, info: any) {
  const path = `${instanceId}/${chatId}/${msgId}.${info.ext}`;
  const { data: mediaRow } = await supabase.from("message_media").insert({
    message_id: messageId, mime_type: info.mime, storage_bucket: info.bucket,
    storage_path: path, original_url: info.url,
    duration_seconds: info.duration ?? null, width: info.width ?? null, height: info.height ?? null,
    download_status: "pending",
  }).select("id").single();

  try {
    const timeoutMs = DL_TIMEOUT_MS[info.bucket] ?? 15000;
    const bytes = await fetchWithRetry(info.url, timeoutMs);
    const { error: upErr } = await supabase.storage.from(info.bucket).upload(path, bytes, { contentType: info.mime, upsert: true });
    if (upErr) throw upErr;
    if (info.thumb) {
      try {
        const tb = await fetchWithRetry(info.thumb, 8000, 1);
        const tp = `${instanceId}/${chatId}/${msgId}.jpg`;
        await supabase.storage.from("whatsapp-thumbnails").upload(tp, tb, { contentType: "image/jpeg", upsert: true });
        await supabase.from("message_media").update({ thumbnail_path: tp }).eq("id", mediaRow!.id);
      } catch { /* thumb nao bloqueia */ }
    }
    await supabase.from("message_media").update({ download_status: "done", file_size_bytes: bytes.length }).eq("id", mediaRow!.id);
  } catch (e) {
    await supabase.from("message_media").update({ download_status: "pending", download_error: String(e) }).eq("id", mediaRow!.id);
  }
}
