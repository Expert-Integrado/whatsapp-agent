import { registerProvider, type WaProvider } from "./provider.ts";
import type { InstanceCreds, OutboundMessage, BuiltRequest, SendResult, MsgType } from "./types.ts";

const MEDIA_TYPE: Partial<Record<MsgType, "image"|"video"|"document">> = {
  image: "image", video: "video", document: "document",
};

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
    throw new Error("not impl");
  }
  webhookInstanceKey(raw: any): string | null {
    throw new Error("not impl");
  }
  verifyWebhookAuth(raw: any, headers: Headers, creds: InstanceCreds | null): boolean {
    throw new Error("not impl");
  }
  normalizeInbound(raw: any, creds: InstanceCreds): Promise<any[]> {
    throw new Error("not impl");
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
