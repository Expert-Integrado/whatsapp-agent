import type {
  ProviderId, InstanceCreds, InboundEvent, OutboundMessage, SendResult,
  MediaRef, MediaPayload, BuiltRequest, NeutralGroup, WaAction,
} from "./types.ts";
import type { WaProvider } from "./provider.ts";
import { registerProvider } from "./provider.ts";

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

  // ── stubs for methods implemented in later tasks ─────────────────────────

  matchesWebhook(_raw: unknown): boolean {
    throw new Error("not impl");
  }

  webhookInstanceKey(_raw: unknown): string | null {
    throw new Error("not impl");
  }

  verifyWebhookAuth(_raw: unknown, _headers: Headers, _creds: InstanceCreds | null): boolean {
    throw new Error("not impl");
  }

  normalizeInbound(_raw: unknown, _creds: InstanceCreds): Promise<InboundEvent[]> {
    throw new Error("not impl");
  }

  fetchMedia(_creds: InstanceCreds, _ref: MediaRef): Promise<MediaPayload> {
    throw new Error("not impl");
  }

  buildAction(_creds: InstanceCreds, _action: WaAction, _params: unknown): BuiltRequest | null {
    throw new Error("not impl");
  }

  parseConnection(_json: unknown): { connected: boolean; phone?: string } {
    throw new Error("not impl");
  }

  fetchGroups(_creds: InstanceCreds): Promise<NeutralGroup[]> {
    throw new Error("not impl");
  }
}

// Register in the factory
registerProvider(new ZapiProvider());
