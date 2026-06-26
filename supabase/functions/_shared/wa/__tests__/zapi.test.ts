// __tests__/zapi.test.ts
import { assertEquals } from "jsr:@std/assert";
import { ZapiProvider } from "../zapi.ts";
import type { InstanceCreds } from "../types.ts";

const z = new ZapiProvider();
const creds: InstanceCreds = {
  provider: "zapi", instance_id: "INST", base_url: null,
  auth_token: "TKN", client_token: "CT", alias: "pessoal",
};

Deno.test("zapi.buildSend texto monta /send-text com phone+message", async () => {
  const r = await z.buildSend(creds, { chatId: "5511", phone: "5511", type: "text", content: "oi" });
  assertEquals(r.url, "https://api.z-api.io/instances/INST/token/TKN/send-text");
  assertEquals(r.method, "POST");
  assertEquals(r.headers["Client-Token"], "CT");
  assertEquals(JSON.parse(r.body!), { phone: "5511", message: "oi" });
});

Deno.test("zapi.buildSend imagem com caption e reply", async () => {
  const r = await z.buildSend(creds, {
    chatId: "5511", phone: "5511", type: "image", content: "legenda",
    media: { url: "https://x/img.jpg" }, quotedProviderId: "MID",
  });
  assertEquals(r.url.endsWith("/send-image"), true);
  assertEquals(JSON.parse(r.body!), { phone: "5511", image: "https://x/img.jpg", caption: "legenda", messageId: "MID" });
});

Deno.test("zapi.buildSend ptt usa /send-audio com waveform", async () => {
  const r = await z.buildSend(creds, { chatId: "5511", phone: "5511", type: "ptt", media: { url: "https://x/a.ogg" } });
  assertEquals(r.url.endsWith("/send-audio"), true);
  assertEquals(JSON.parse(r.body!), { phone: "5511", audio: "https://x/a.ogg", waveform: true });
});

Deno.test("zapi.parseSendResult prioriza messageId", () => {
  assertEquals(z.parseSendResult({ messageId: "M1", id: "X" }), { providerMsgId: "M1" });
  assertEquals(z.parseSendResult({ id: "X" }), { providerMsgId: "X" });
});

// Testa mentionsEveryone via stub de globalThis.fetch
Deno.test("zapi.buildSend mentionsEveryone expande participantes do grupo", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = ((_url: string | URL | Request, _init?: RequestInit) => {
    return Promise.resolve(new Response(JSON.stringify({
      participants: [
        { phone: "5511999990001" },
        { phone: "5511999990002" },
      ],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
  }) as typeof fetch;

  try {
    const r = await z.buildSend(creds, {
      chatId: "5511group@g.us", phone: "5511group",
      type: "text", content: "oi a todos",
      mentionsEveryone: true, isGroup: true,
    });
    const body = JSON.parse(r.body!);
    assertEquals(body.mentioned, ["5511999990001", "5511999990002"]);
  } finally {
    globalThis.fetch = original;
  }
});
