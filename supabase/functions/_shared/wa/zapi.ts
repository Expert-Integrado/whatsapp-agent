import type {
  ProviderId, InstanceCreds, InboundEvent, OutboundMessage, SendResult,
  MediaRef, MediaPayload, BuiltRequest, NeutralGroup, WaAction,
} from "./types.ts";
import type { WaProvider } from "./provider.ts";
import { registerProvider } from "./provider.ts";
import { isLidJid } from "./jid.ts";

// ─── helpers ────────────────────────────────────────────────────────────────

// Port of fetchGroupParticipants from send-message/index.ts:91-99
async function fetchGroupParticipants(
  base: string,
  headers: Record<string, string>,
  groupId: string,
): Promise<string[]> {
  try {
    const r = await fetch(`${base}/group-metadata/${encodeURIComponent(groupId)}`, { headers });
    if (!r.ok) return [];
    const m = await r.json();
    const parts = Array.isArray(m?.participants) ? m.participants : [];
    return parts
      .map((p: unknown) => (p as { phone?: string })?.phone)
      .filter((p: unknown): p is string => typeof p === "string" && p.length > 0);
  } catch {
    return [];
  }
}

// ─── fetchMedia helpers ──────────────────────────────────────────────────────

/** Timeout per bucket — ported from process-webhook/index.ts:447-454 */
const DL_TIMEOUT_MS: Record<string, number> = {
  "whatsapp-audio":     30000,
  "whatsapp-video":     45000,
  "whatsapp-documents": 30000,
  "whatsapp-images":    15000,
  "whatsapp-stickers":  10000,
};

/**
 * GET with retry — ported from process-webhook/index.ts:456-475.
 * Tries `attempts` times with 500ms delay between failures.
 */
async function zapieFetchWithRetry(url: string, timeoutMs: number, attempts = 2): Promise<Uint8Array> {
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
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw lastErr;
}

// ─── resolveChatIds helpers ──────────────────────────────────────────────────

/**
 * 3-layer @lid → phone resolution — ported from process-webhook/index.ts:69-136.
 *   1. Cache lookup in lid_mapping (scoped by instance_id)
 *   2. Match by chat_name → most recent numeric chat in chats table
 *   3. Z-API GET /contacts/<lid> using creds, writing to lid_mapping on success
 */
async function zapiResolveLidToPhone(
  lid: string,
  chatName: string | null,
  instanceId: string,
  creds: InstanceCreds,
  supabase: any,
): Promise<{ phone: string | null; via: string }> {
  // Layer 1: cache
  const { data: cached } = await supabase
    .from("lid_mapping")
    .select("phone")
    .eq("instance_id", instanceId)
    .eq("lid", lid)
    .maybeSingle();
  if (cached?.phone) return { phone: cached.phone, via: "cache" };

  // Layer 2: chat_name → most recent numeric chat_id (same instance)
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

  // Layer 3: Z-API contacts endpoint
  try {
    const base = `https://api.z-api.io/instances/${creds.instance_id}/token/${creds.auth_token}`;
    const r = await fetch(
      `${base}/contacts/${encodeURIComponent(lid)}`,
      { headers: { "Client-Token": creds.client_token! } },
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
  } catch (e) {
    console.warn("ZapiProvider: @lid resolve fail", lid, e);
  }

  return { phone: null, via: "unresolved" };
}

// ─── ZapiProvider ───────────────────────────────────────────────────────────

export class ZapiProvider implements WaProvider {
  readonly id: ProviderId = "zapi";

  // ── send ──────────────────────────────────────────────────────────────────

  async buildSend(creds: InstanceCreds, msg: OutboundMessage): Promise<BuiltRequest> {
    const base = `https://api.z-api.io/instances/${creds.instance_id}/token/${creds.auth_token}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Client-Token": creds.client_token!,
    };

    const phone = msg.phone;
    const resolvedQuotedId = msg.quotedProviderId ?? null;

    // Build explicit mention list
    let mentionedList: string[] = Array.isArray(msg.mentions)
      ? msg.mentions.filter((m): m is string => typeof m === "string")
      : [];

    // mentionsEveryone: expand to all group participants (port of :186-188)
    if (msg.mentionsEveryone && msg.isGroup) {
      const all = await fetchGroupParticipants(base, headers, phone);
      if (all.length) mentionedList = all;
    }

    // withMentions: append @phone tokens for any mention not already in text (port of :192-193)
    const mentionTokens = mentionedList
      .filter((p) => !(msg.content ?? "").includes(`@${p}`))
      .map((p) => `@${p}`);
    const withMentions = (txt: string) =>
      mentionTokens.length
        ? `${txt}${txt ? " " : ""}${mentionTokens.join(" ")}`.trim()
        : txt;

    // Build endpoint + body per type (port of send-message/index.ts:195-209)
    let endpoint: string;
    let zapiBody: Record<string, unknown>;
    const mediaUrl = msg.media?.url;

    switch (msg.type) {
      case "text":
        endpoint = `${base}/send-text`;
        zapiBody = {
          phone,
          message: withMentions(msg.content ?? ""),
          ...(resolvedQuotedId && { messageId: resolvedQuotedId }),
          ...(mentionedList.length && { mentioned: mentionedList }),
        };
        break;
      case "image":
        endpoint = `${base}/send-image`;
        zapiBody = {
          phone,
          image: mediaUrl,
          caption: withMentions(msg.content ?? ""),
          ...(resolvedQuotedId && { messageId: resolvedQuotedId }),
          ...(mentionedList.length && { mentioned: mentionedList }),
        };
        break;
      case "audio":
        endpoint = `${base}/send-audio`;
        zapiBody = {
          phone,
          audio: mediaUrl,
          ...(resolvedQuotedId && { messageId: resolvedQuotedId }),
        };
        break;
      case "ptt":
        endpoint = `${base}/send-audio`;
        zapiBody = {
          phone,
          audio: mediaUrl,
          waveform: true,
          ...(resolvedQuotedId && { messageId: resolvedQuotedId }),
        };
        break;
      case "video":
        endpoint = `${base}/send-video`;
        zapiBody = {
          phone,
          video: mediaUrl,
          caption: withMentions(msg.content ?? ""),
          ...(resolvedQuotedId && { messageId: resolvedQuotedId }),
          ...(mentionedList.length && { mentioned: mentionedList }),
        };
        break;
      case "document": {
        const fileName = msg.media?.fileName ?? msg.content ?? "document.pdf";
        endpoint = `${base}/send-document/pdf`;
        zapiBody = {
          phone,
          document: mediaUrl,
          fileName,
          ...(msg.media?.fileName && msg.content ? { caption: msg.content } : {}),
          ...(resolvedQuotedId && { messageId: resolvedQuotedId }),
        };
        break;
      }
      default:
        endpoint = `${base}/send-text`;
        zapiBody = {
          phone,
          message: msg.content ?? "",
          ...(resolvedQuotedId && { messageId: resolvedQuotedId }),
        };
    }

    // Delay caps — port of send-message/index.ts:211-218
    if (typeof msg.delayTyping === "number" && msg.delayTyping > 0) {
      zapiBody.delayTyping = Math.min(15, Math.max(1, Math.floor(msg.delayTyping)));
    }
    if (typeof msg.delayMessage === "number" && msg.delayMessage > 0) {
      zapiBody.delayMessage = Math.min(15, Math.max(1, Math.floor(msg.delayMessage)));
    }

    return {
      url: endpoint,
      method: "POST",
      headers,
      body: JSON.stringify(zapiBody),
    };
  }

  parseSendResult(json: Record<string, unknown>): SendResult {
    const id = (json.messageId ?? json.id ?? "") as string;
    return { providerMsgId: id };
  }

  // ── webhook identification & auth ─────────────────────────────────────────

  /** Z-API payloads always have a string `type` field. */
  matchesWebhook(raw: unknown): boolean {
    return typeof (raw as Record<string, unknown> | null)?.type === "string";
  }

  /** Z-API payloads carry `instanceId` as a top-level string. */
  webhookInstanceKey(raw: unknown): string | null {
    const r = raw as Record<string, unknown> | null;
    return typeof r?.instanceId === "string" ? r.instanceId : null;
  }

  /**
   * Pure boolean check: compares the `z-api-token` request header against
   * `creds.webhook_token`. TOFU learning (writing the token to the DB on
   * first request) is intentionally kept in the orchestrator (Task 15/16).
   */
  verifyWebhookAuth(
    _raw: unknown,
    headers: Headers,
    creds: InstanceCreds | null,
  ): boolean {
    const supplied = headers.get("z-api-token") ?? "";
    if (!creds) return false;
    const stored = (creds as InstanceCreds & { webhook_token?: string | null }).webhook_token;
    if (!stored) return false;
    return supplied === stored;
  }

  // ── inbound normalisation ─────────────────────────────────────────────────

  async normalizeInbound(raw: unknown, _creds: InstanceCreds): Promise<InboundEvent[]> {
    const p = raw as Record<string, unknown>;

    switch (p.type) {
      case "ReceivedCallback":
        return zapiHandleReceived(p);
      case "DeliveryCallback":
        return zapiHandleReceived({ ...p, fromMe: true });
      case "MessageStatusCallback":
        return zapiHandleStatus(p);
      case "MessageReactionCallback":
        return zapiHandleReaction(p);
      case "EditedMessageCallback":
        return zapiHandleEdited(p);
      case "RevokedMessageCallback":
        return zapiHandleRevoked(p);
      case "PresenceChatCallback":
        return []; // presence_events discontinued (migration 0022)
      case "ConnectedCallback":
        return [{ kind: "connection", connected: true }];
      case "DisconnectedCallback":
        return [{ kind: "connection", connected: false }];
      case "NotificationCallback":
        return zapiHandleGroupNotif(p);
      default:
        return [];
    }
  }

  async fetchMedia(_creds: InstanceCreds, ref: MediaRef): Promise<MediaPayload> {
    if (!ref.url) throw new Error("ZapiProvider.fetchMedia: ref.url is required for strategy=url");
    const timeoutMs = DL_TIMEOUT_MS[ref.bucket] ?? 15000;
    const bytes = await zapieFetchWithRetry(ref.url, timeoutMs);
    return {
      bytes,
      mime: ref.mime ?? "application/octet-stream",
      fileName: ref.fileName,
    };
  }

  async resolveChatIds(
    events: InboundEvent[],
    creds: InstanceCreds,
    deps: { supabase: any },
  ): Promise<InboundEvent[]> {
    const result: InboundEvent[] = [];
    for (const ev of events) {
      if (
        (ev.kind === "message" || ev.kind === "reaction") &&
        isLidJid(ev.chatId) &&
        ev.fromMe === true &&
        !("isGroup" in ev && (ev as { isGroup?: boolean }).isGroup)
      ) {
        const chatName = ev.kind === "message" ? ev.chatName : null;
        const { phone } = await zapiResolveLidToPhone(
          ev.chatId,
          chatName ?? null,
          creds.instance_id,
          creds,
          deps.supabase,
        );
        if (phone) {
          result.push({ ...ev, chatId: phone });
        } else {
          result.push(ev);
        }
      } else {
        result.push(ev);
      }
    }
    return result;
  }

  buildAction(creds: InstanceCreds, action: WaAction, params: unknown): BuiltRequest | null {
    const base = `https://api.z-api.io/instances/${creds.instance_id}/token/${creds.auth_token}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Client-Token": creds.client_token!,
    };
    const p = params as Record<string, unknown>;

    // Special case: get-contact-info → GET /contacts/{phone}, no body
    if (action === "get-contact-info") {
      const phone = encodeURIComponent(String(p.phone ?? ""));
      return {
        url: `${base}/contacts/${phone}`,
        method: "GET",
        headers,
      };
    }

    // Read-only Z-API endpoints are GET with no body (POST returns 405)
    const GET_ACTIONS = new Set<WaAction>(["status", "chats", "contacts"]);
    if (GET_ACTIONS.has(action)) {
      return { url: `${base}/${action}`, method: "GET", headers };
    }

    // Generic case: POST /{action} with full params as body
    return {
      url: `${base}/${action}`,
      method: "POST",
      headers,
      body: JSON.stringify(params),
    };
  }

  parseConnection(json: unknown): { connected: boolean; phone?: string } {
    const j = json as Record<string, unknown> | null | undefined;
    const connected = (j?.connected ?? j?.smartphoneConnected ?? false) as boolean;
    const phone = j?.phone as string | undefined;
    return phone !== undefined ? { connected, phone } : { connected };
  }

  async fetchGroups(creds: InstanceCreds): Promise<NeutralGroup[]> {
    const base = `https://api.z-api.io/instances/${creds.instance_id}/token/${creds.auth_token}`;
    const headers: Record<string, string> = {
      "Client-Token": creds.client_token!,
    };
    const r = await fetch(`${base}/chats`, { headers });
    if (!r.ok) return [];
    const raw = await r.json();
    const allChats: Record<string, unknown>[] = Array.isArray(raw)
      ? raw
      : (raw?.value ?? raw?.chats ?? raw?.data ?? []);
    return allChats
      .filter((c) => c.isGroup === true || c.is_group === true || c.type === "group")
      .map((c) => {
        const rawId = String(c.phone ?? c.id ?? c.chatId ?? "");
        const name = (c.name ?? c.chatName ?? c.subject ?? c.groupName ?? null) as string | null;
        const result: NeutralGroup = { chatId: rawId, name };
        if (typeof c.participantCount === "number") result.participantCount = c.participantCount;
        return result;
      });
  }
}

// Register in the factory
registerProvider(new ZapiProvider());

// ─── Pure mappers (ported from process-webhook/index.ts) ────────────────────

/**
 * Port of extractMediaInfo (process-webhook:354-365).
 * Returns messageType, content, caption, and optional MediaRef.
 */
function zapiExtractMediaInfo(p: Record<string, unknown>): {
  messageType: string;
  content: string | null;
  caption: string | null;
  media: MediaRef | null;
} {
  type AnyObj = Record<string, unknown>;
  if (p.text)     return { messageType: "text",     content: (p.text as AnyObj).message as string ?? null, caption: null,                                          media: null };
  if (p.image)    return { messageType: "image",    content: null,                                                        caption: (p.image as AnyObj).caption as string ?? null,  media: { strategy: "url", url: (p.image as AnyObj).imageUrl as string, mime: (p.image as AnyObj).mimeType as string ?? null, bucket: "whatsapp-images", ext: "jpg", width: (p.image as AnyObj).width as number | undefined, height: (p.image as AnyObj).height as number | undefined, thumbUrl: (p.image as AnyObj).thumbnailUrl as string | undefined } };
  if (p.audio)    return { messageType: (p.audio as AnyObj).ptt ? "ptt" : "audio", content: null,          caption: null,                                          media: { strategy: "url", url: (p.audio as AnyObj).audioUrl as string, mime: (p.audio as AnyObj).mimeType as string ?? null, bucket: "whatsapp-audio", ext: "ogg", duration: (p.audio as AnyObj).seconds as number | undefined } };
  if (p.video)    return { messageType: "video",    content: null,                                                        caption: (p.video as AnyObj).caption as string ?? null,  media: { strategy: "url", url: (p.video as AnyObj).videoUrl as string, mime: (p.video as AnyObj).mimeType as string ?? null, bucket: "whatsapp-video", ext: "mp4", duration: (p.video as AnyObj).seconds as number | undefined } };
  if (p.document) return { messageType: "document", content: (p.document as AnyObj).fileName as string ?? null,           caption: null,                                          media: { strategy: "url", url: (p.document as AnyObj).documentUrl as string, mime: (p.document as AnyObj).mimeType as string ?? null, bucket: "whatsapp-documents", ext: "bin", fileName: (p.document as AnyObj).fileName as string | undefined } };
  if (p.sticker)  return { messageType: "sticker",  content: null,                                                        caption: null,                                          media: { strategy: "url", url: (p.sticker as AnyObj).stickerUrl as string, mime: (p.sticker as AnyObj).mimeType as string ?? null, bucket: "whatsapp-stickers", ext: "webp" } };
  if (p.location) return { messageType: "location", content: JSON.stringify(p.location),                                  caption: null,                                          media: null };
  if (p.contact)  return { messageType: "contact",  content: (p.contact as AnyObj).displayName as string ?? null,         caption: null,                                          media: null };
  if (p.poll)     return { messageType: "poll",     content: (p.poll as AnyObj).name as string ?? null,                   caption: null,                                          media: null };
  return { messageType: "unknown", content: null, caption: null, media: null };
}

/**
 * Port of handleReceived (process-webhook:261-352).
 * Defensive redirects then builds InboundEvent for messages.
 */
function zapiHandleReceived(p: Record<string, unknown>): InboundEvent[] {
  // waitingMessage: Z-API delivers webhook before decrypting content — skip
  if (p.waitingMessage === true) return [];

  // Defensive redirects: Z-API sometimes wraps non-message events in ReceivedCallback
  if (p.notification) return zapiHandleGroupNotif(p);
  if (p.reaction)     return zapiHandleReaction(p);
  if (p.isEdit)       return zapiHandleEdited(p);
  if (p.pinMessage)   return []; // no schema for pin/unpin, skip

  const ts = new Date((p.momment as number) ?? Date.now()).toISOString();
  const chatId = p.phone as string;

  // senderPhone port of process-webhook:322-324
  const senderPhone = p.fromMe
    ? ((p.connectedPhone ?? p.participantPhone ?? null) as string | null)
    : ((p.participantPhone ?? p.phone ?? null) as string | null);

  const { messageType, content, caption, media } = zapiExtractMediaInfo(p);

  const ev: InboundEvent = {
    kind: "message",
    chatId,
    chatName: (p.chatName as string | null) ?? null,
    isGroup: !!p.isGroup,
    fromMe: !!p.fromMe,
    senderPhone,
    senderName: (p.senderName as string | null) ?? null,
    providerMsgId: p.messageId as string,
    messageType: messageType as import("./types.ts").MsgType,
    content,
    caption,
    quotedProviderId: ((p.referencedMessage as Record<string, unknown> | undefined)?.messageId as string | null) ?? null,
    isForwarded: !!p.forwarded,
    timestamp: ts,
    media,
    raw: p,
  };
  return [ev];
}

/** Port of handleStatus (process-webhook:367-377). */
function zapiHandleStatus(p: Record<string, unknown>): InboundEvent[] {
  const sendMap: Record<string, import("./types.ts").SendStatus> = {
    SENT: "sent", RECEIVED: "delivered", READ: "read", PLAYED: "read",
  };
  const status = sendMap[p.status as string];
  if (!status) return [];
  const ids = Array.isArray(p.ids) ? (p.ids as string[]) : [];
  return [{ kind: "status", providerMsgIds: ids, status }];
}

/** Port of handleReaction (process-webhook:379-405). */
function zapiHandleReaction(p: Record<string, unknown>): InboundEvent[] {
  type AnyObj = Record<string, unknown>;
  const reaction = p.reaction as AnyObj | undefined;
  const targetId =
    (reaction?.referencedMessage as AnyObj | undefined)?.messageId as string | undefined
    ?? (p.referencedMessage as AnyObj | undefined)?.messageId as string | undefined;
  if (!targetId) return [];

  const emoji = (reaction?.value as string | undefined) ?? null;
  const chatId = p.phone as string;

  const reactorPhone = p.fromMe
    ? ((p.connectedPhone ?? p.participantPhone ?? chatId) as string | null)
    : ((p.participantPhone ?? chatId) as string | null);

  const rawTime = (reaction?.time as number | undefined) ?? Date.now();
  const ts = new Date(rawTime < 1e12 ? rawTime * 1000 : rawTime).toISOString();

  return [{
    kind: "reaction",
    chatId,
    targetProviderMsgId: targetId,
    reactorPhone,
    reactorName: (p.senderName as string | null) ?? null,
    emoji,
    fromMe: !!p.fromMe,
    timestamp: ts,
    raw: p,
  }];
}

/** Port of handleEdited (process-webhook:407-415). */
function zapiHandleEdited(p: Record<string, unknown>): InboundEvent[] {
  const newContent = ((p.text as Record<string, unknown> | undefined)?.message as string | null) ?? null;
  return [{ kind: "edit", providerMsgId: p.messageId as string, newContent }];
}

/** Port of handleRevoked (process-webhook:417-421). */
function zapiHandleRevoked(p: Record<string, unknown>): InboundEvent[] {
  return [{ kind: "revoke", providerMsgId: p.messageId as string }];
}

/** Port of handleGroupNotif (process-webhook:431-445). */
function zapiHandleGroupNotif(p: Record<string, unknown>): InboundEvent[] {
  const notifMap: Record<string, "add" | "remove" | "promote" | "demote"> = {
    GROUP_PARTICIPANT_ADD:     "add",
    GROUP_PARTICIPANT_REMOVE:  "remove",
    GROUP_PARTICIPANT_PROMOTE: "promote",
    GROUP_PARTICIPANT_DEMOTE:  "demote",
  };
  const action = notifMap[p.notification as string];
  if (!action) return [];
  const phones: string[] = Array.isArray(p.notificationParameters)
    ? (p.notificationParameters as string[])
    : [];
  return [{
    kind: "group_participant",
    chatId: p.phone as string,
    action,
    phones,
  }];
}
