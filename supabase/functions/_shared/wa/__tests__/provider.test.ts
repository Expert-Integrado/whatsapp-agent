// __tests__/provider.test.ts
import { assertEquals, assertThrows } from "jsr:@std/assert";
import { registerProvider, getProvider, type WaProvider } from "../provider.ts";

const stub: WaProvider = {
  id: "zapi",
  matchesWebhook: () => true,
  webhookInstanceKey: () => "x",
  verifyWebhookAuth: () => true,
  normalizeInbound: () => Promise.resolve([]),
  fetchMedia: () => Promise.resolve({ bytes: new Uint8Array(), mime: "x" }),
  buildSend: () => Promise.resolve({ url: "u", method: "POST", headers: {} }),
  parseSendResult: () => ({ providerMsgId: "id" }),
  buildAction: () => null,
  parseConnection: () => ({ connected: true }),
  fetchGroups: () => Promise.resolve([]),
};

Deno.test("registerProvider + getProvider devolve o adapter", () => {
  registerProvider(stub);
  assertEquals(getProvider("zapi").id, "zapi");
});

Deno.test("getProvider lança em provider não registrado", () => {
  assertThrows(() => getProvider("evolution"), Error, "não registrado");
});
