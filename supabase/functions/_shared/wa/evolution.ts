import { registerProvider, type WaProvider } from "./provider.ts";
import type { InstanceCreds, OutboundMessage, BuiltRequest, SendResult, MsgType, InboundEvent, SendStatus } from "./types.ts";
import { digitsFromJid, isGroupJid } from "./jid.ts";

const MEDIA_TYPE: Partial<Record<MsgType, "image"|"video"|"document">> = {
  image: "image", video: "video", document: "document",
};

function mapAck(status: string): SendStatus {
  switch (status) {
    case "READ":
    case "PLAYED":
      return "read";
    case "DELIVERY_ACK":
      return "delivered";
    case "SERVER_ACK":
    case "PENDING":
    default:
      return "sent";
  }
}

function mapGroupAction(action: string): "add" | "remove" | "promote" | "demote" | null {
  switch (action) {
    case "add": return "add";
    case "remove": return "remove";
    case "promote": return "promote";
    case "demote": return "demote";
    default: return null;
  }
}

export class EvolutionProvider implements WaProvider {
  readonly id = "evolution" as const;

  private h(creds: InstanceCreds) {
    return { "Content-Type": "application/json", "apikey": creds.auth_token };
  }
  private u(creds: InstanceCreds, path: string) {
    return `${creds.base_url}/${path}/${creds.instance_id}`;
  }
  private opts(msg: OutboundMessage) {
    const o: Record<string, unknown> = {};
    if (msg.quotedProviderId) o.quoted = { key: { id: msg.quotedProviderId } };
    if (msg.mentions?.length) o.mentioned = msg.mentions;
    if (msg.mentionsEveryone) o.mentionsEveryOne = true;
    if (msg.delayMessage) o.delay = Math.min(15000, Math.max(0, Math.floor(msg.delayMessage * 1000)));
    return o;
  }

  buildSend(creds: InstanceCreds, msg: OutboundMessage): Promise<BuiltRequest> {
    const headers = this.h(creds);
    const number = msg.phone;
    let path: string, body: Record<string, unknown>;
    if (msg.type === "image" || msg.type === "video" || msg.type === "document") {
      path = "message/sendMedia";
      body = { number, mediatype: MEDIA_TYPE[msg.type], mimetype: msg.media?.mime,
               media: msg.media?.url ?? msg.media?.bytes, ...(msg.content ? { caption: msg.content } : {}),
               ...(msg.media?.fileName ? { fileName: msg.media.fileName } : {}), ...this.opts(msg) };
    } else if (msg.type === "audio" || msg.type === "ptt") {
      path = "message/sendWhatsAppAudio";
      body = { number, audio: msg.media?.url ?? msg.media?.bytes, ...this.opts(msg) };
    } else if (msg.type === "sticker") {
      path = "message/sendSticker";
      body = { number, sticker: msg.media?.url ?? msg.media?.bytes, ...this.opts(msg) };
    } else {
      path = "message/sendText";
      body = { number, text: msg.content ?? "", ...this.opts(msg) };
    }
    return Promise.resolve({ url: this.u(creds, path), method: "POST", headers, body: JSON.stringify(body) });
  }

  parseSendResult(json: any): SendResult {
    return { providerMsgId: json?.key?.id ?? json?.messageId ?? json?.id ?? "" };
  }

  // Tasks 9-11: remaining interface methods

  matchesWebhook(raw: any): boolean {
    return typeof raw?.event === "string";
  }

  webhookInstanceKey(raw: any): string | null {
    return raw?.instance ?? null;
  }

  verifyWebhookAuth(raw: any, headers: Headers, creds: InstanceCreds | null): boolean {
    if (Deno.env.get("WEBHOOK_REQUIRE_AUTH") !== "true") return true;
    const token = (creds as any)?.webhook_token;
    if (!token) return false;
    const authHeader = headers.get("authorization");
    return authHeader === token;
  }

  async normalizeInbound(raw: any, _creds: InstanceCreds): Promise<InboundEvent[]> {
    const event: string = raw?.event ?? "";
    const d = raw?.data ?? {};

    if (event === "messages.upsert") {
      const k = d.key ?? {};
      // Resolve effective JID: prefer remoteJidAlt when addressingMode=lid
      const jid: string = (k.addressingMode === "lid" && k.remoteJidAlt)
        ? k.remoteJidAlt
        : (k.remoteJid ?? "");

      const isGroup = isGroupJid(jid);
      const chatId = isGroup ? jid : digitsFromJid(jid);
      const senderPhone = isGroup
        ? (digitsFromJid(k.participant || "") || null)
        : chatId;

      // Unwrap ephemeralMessage
      const m: any = d.message?.ephemeralMessage?.message ?? d.message ?? {};

      // Reaction handling
      if (m.reactionMessage) {
        const rm = m.reactionMessage;
        const ev: InboundEvent = {
          kind: "reaction",
          chatId,
          targetProviderMsgId: rm.key?.id ?? "",
          reactorPhone: senderPhone,
          reactorName: d.pushName ?? null,
          emoji: rm.text ?? null,
          fromMe: k.fromMe ?? false,
          timestamp: new Date(Number(d.messageTimestamp) * 1000).toISOString(),
          raw,
        };
        return [ev];
      }

      // Determine message type and media
      let messageType: MsgType = "unknown";
      let media = null;
      let content: string | null = null;
      let caption: string | null = null;
      let quotedProviderId: string | null = null;

      if (m.conversation !== undefined || m.extendedTextMessage !== undefined) {
        messageType = "text";
        content = m.conversation ?? m.extendedTextMessage?.text ?? null;
        quotedProviderId = m.extendedTextMessage?.contextInfo?.stanzaId ?? null;
      } else if (m.imageMessage) {
        messageType = "image";
        caption = m.imageMessage.caption ?? null;
        quotedProviderId = m.imageMessage.contextInfo?.stanzaId ?? null;
        media = {
          strategy: "fetch" as const,
          providerMsgId: k.id,
          mime: m.imageMessage.mimetype ?? null,
          bucket: "whatsapp-images",
          ext: "jpg",
        };
      } else if (m.audioMessage) {
        messageType = m.audioMessage.ptt ? "ptt" : "audio";
        media = {
          strategy: "fetch" as const,
          providerMsgId: k.id,
          mime: m.audioMessage.mimetype ?? null,
          bucket: "whatsapp-audio",
          ext: "ogg",
        };
      } else if (m.videoMessage) {
        messageType = "video";
        caption = m.videoMessage.caption ?? null;
        quotedProviderId = m.videoMessage.contextInfo?.stanzaId ?? null;
        media = {
          strategy: "fetch" as const,
          providerMsgId: k.id,
          mime: m.videoMessage.mimetype ?? null,
          bucket: "whatsapp-video",
          ext: "mp4",
        };
      } else if (m.documentMessage) {
        messageType = "document";
        caption = m.documentMessage.caption ?? null;
        quotedProviderId = m.documentMessage.contextInfo?.stanzaId ?? null;
        media = {
          strategy: "fetch" as const,
          providerMsgId: k.id,
          mime: m.documentMessage.mimetype ?? null,
          bucket: "whatsapp-documents",
          ext: "bin",
        };
      } else if (m.stickerMessage) {
        messageType = "sticker";
        media = {
          strategy: "fetch" as const,
          providerMsgId: k.id,
          mime: m.stickerMessage.mimetype ?? null,
          bucket: "whatsapp-stickers",
          ext: "webp",
        };
      } else if (m.locationMessage) {
        messageType = "location";
      } else if (m.contactMessage) {
        messageType = "contact";
      }

      const ev: InboundEvent = {
        kind: "message",
        chatId,
        chatName: d.pushName ?? null,
        isGroup,
        fromMe: k.fromMe ?? false,
        senderPhone,
        senderName: d.pushName ?? null,
        providerMsgId: k.id ?? "",
        messageType,
        content,
        caption,
        quotedProviderId,
        isForwarded: false,
        timestamp: new Date(Number(d.messageTimestamp) * 1000).toISOString(),
        media,
        raw,
      };
      return [ev];
    }

    if (event === "messages.update") {
      const status = mapAck(d.status ?? d.update?.status ?? "");
      const ev: InboundEvent = {
        kind: "status",
        providerMsgIds: [d.key?.id ?? ""],
        status,
      };
      return [ev];
    }

    if (event === "connection.update") {
      return [{ kind: "connection", connected: d.state === "open" }];
    }

    if (event === "group-participants.update") {
      const action = mapGroupAction(d.action ?? "");
      if (!action) return [];
      const phones: string[] = (d.participants ?? []).map((p: string) => digitsFromJid(p));
      return [{ kind: "group_participant", chatId: d.id ?? "", action, phones }];
    }

    if (event === "groups.update") {
      // groups.update carries array of group updates; emit group_participant for each
      const updates: InboundEvent[] = [];
      const items = Array.isArray(d) ? d : [d];
      for (const item of items) {
        if (item?.id) {
          updates.push({ kind: "group_participant", chatId: item.id, action: "add", phones: [] });
        }
      }
      return updates;
    }

    return [];
  }
  fetchMedia(creds: InstanceCreds, ref: any): Promise<any> {
    throw new Error("not impl");
  }
  buildAction(creds: InstanceCreds, action: any, params: any): any {
    throw new Error("not impl");
  }
  parseConnection(json: any): { connected: boolean; phone?: string } {
    throw new Error("not impl");
  }
  fetchGroups(creds: InstanceCreds): Promise<any[]> {
    throw new Error("not impl");
  }
}

registerProvider(new EvolutionProvider());
