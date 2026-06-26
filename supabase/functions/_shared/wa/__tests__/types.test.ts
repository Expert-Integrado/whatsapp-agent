import { assertEquals } from "jsr:@std/assert";
import type { InboundEvent, OutboundMessage, InstanceCreds } from "../types.ts";

Deno.test("InboundEvent discrimina por kind", () => {
  const ev: InboundEvent = {
    kind: "message", chatId: "5511999998888", chatName: "João", isGroup: false,
    fromMe: false, senderPhone: "5511999998888", senderName: "João",
    providerMsgId: "ABC", messageType: "text", content: "oi", caption: null,
    quotedProviderId: null, isForwarded: false, timestamp: "2026-06-26T00:00:00Z",
    media: null, raw: {},
  };
  assertEquals(ev.kind, "message");
});

Deno.test("OutboundMessage e InstanceCreds compilam com campos neutros", () => {
  const creds: InstanceCreds = {
    provider: "evolution", instance_id: "you_casa", base_url: "https://evo.x",
    auth_token: "key", client_token: null, alias: "youcasa",
  };
  const msg: OutboundMessage = { chatId: "x", phone: "5511", type: "text", content: "oi" };
  assertEquals(creds.provider, "evolution");
  assertEquals(msg.type, "text");
});
