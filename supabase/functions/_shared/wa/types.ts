export type ProviderId = "zapi" | "evolution";

export type MsgType =
  | "text" | "image" | "audio" | "ptt" | "video"
  | "document" | "sticker" | "location" | "contact" | "poll" | "unknown";

export type SendStatus = "pending" | "sent" | "delivered" | "read" | "failed";

export type WaAction =
  | "status" | "chats" | "contacts" | "get-contact-info"
  | "read-chat" | "read-message" | "send-reaction"
  | "send-text" | "send-poll" | "forward"
  | "delete-message" | "block-contact"
  | "create-group" | "add-participant" | "remove-participant"
  | "add-admin" | "remove-admin";

export interface InstanceCreds {
  provider: ProviderId;
  instance_id: string;          // Z-API: instance id | Evolution: nome da instância
  base_url: string | null;      // Evolution: URL do servidor | Z-API: null
  auth_token: string;           // Z-API: token | Evolution: apikey
  client_token: string | null;  // só Z-API
  alias: string | null;
}

// Referência de mídia a ser materializada DEPOIS da normalização.
//  - Z-API:     { strategy: "url", url, ... }       → fetchMedia faz GET da url
//  - Evolution: { strategy: "fetch", providerMsgId } → fetchMedia chama getBase64FromMediaMessage
export interface MediaRef {
  strategy: "url" | "fetch";
  bucket: string;               // ex. "whatsapp-images"
  ext: string;                  // ex. "jpg"
  mime: string | null;
  url?: string;                 // strategy "url"
  providerMsgId?: string;       // strategy "fetch"
  duration?: number;
  width?: number;
  height?: number;
  thumbUrl?: string;
  fileName?: string;
}

export type InboundEvent =
  | {
      kind: "message"; chatId: string; chatName: string | null; isGroup: boolean;
      fromMe: boolean; senderPhone: string | null; senderName: string | null;
      providerMsgId: string; messageType: MsgType; content: string | null;
      caption: string | null; quotedProviderId: string | null; isForwarded: boolean;
      timestamp: string; media: MediaRef | null; raw: unknown;
    }
  | { kind: "status"; providerMsgIds: string[]; status: SendStatus }
  | {
      kind: "reaction"; chatId: string; targetProviderMsgId: string;
      reactorPhone: string | null; reactorName: string | null; emoji: string | null;
      fromMe: boolean; timestamp: string; raw: unknown;
    }
  | { kind: "edit"; providerMsgId: string; newContent: string | null }
  | { kind: "revoke"; providerMsgId: string }
  | { kind: "group_participant"; chatId: string; action: "add" | "remove" | "promote" | "demote"; phones: string[] }
  | { kind: "connection"; connected: boolean };

export interface OutboundMessage {
  chatId: string;
  phone: string;
  type: MsgType;
  content?: string;
  media?: { url?: string; bytes?: Uint8Array; mime?: string; fileName?: string };
  caption?: string;
  quotedProviderId?: string | null;
  mentions?: string[];
  mentionsEveryone?: boolean;
  isGroup?: boolean;
  delayTyping?: number;   // segundos (neutro; adapter converte)
  delayMessage?: number;  // segundos (neutro; adapter converte)
}

export interface SendResult { providerMsgId: string }
export interface MediaPayload { bytes: Uint8Array; mime: string; fileName?: string }
export interface BuiltRequest {
  url: string; method: "GET" | "POST" | "DELETE"; headers: Record<string, string>; body?: string;
}
export interface NeutralGroup { chatId: string; name: string | null; participantCount?: number }
