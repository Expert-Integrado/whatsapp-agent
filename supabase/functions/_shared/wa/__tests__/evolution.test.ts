import { assertEquals } from "jsr:@std/assert";
import { EvolutionProvider } from "../evolution.ts";
import type { InstanceCreds } from "../types.ts";

const e = new EvolutionProvider();
const creds: InstanceCreds = {
  provider: "evolution", instance_id: "you_casa", base_url: "https://evo.x",
  auth_token: "APIKEY", client_token: null, alias: "youcasa",
};

Deno.test("evo.buildSend texto → /message/sendText/{inst} com apikey", async () => {
  const r = await e.buildSend(creds, { chatId: "5511", phone: "5511", type: "text", content: "oi" });
  assertEquals(r.url, "https://evo.x/message/sendText/you_casa");
  assertEquals(r.method, "POST");
  assertEquals(r.headers["apikey"], "APIKEY");
  assertEquals(JSON.parse(r.body!), { number: "5511", text: "oi" });
});

Deno.test("evo.buildSend texto com reply+menções", async () => {
  const r = await e.buildSend(creds, {
    chatId: "5511", phone: "5511", type: "text", content: "oi",
    quotedProviderId: "MID", mentions: ["5599"], mentionsEveryone: true,
  });
  assertEquals(JSON.parse(r.body!), {
    number: "5511", text: "oi",
    quoted: { key: { id: "MID" } }, mentioned: ["5599"], mentionsEveryOne: true,
  });
});

Deno.test("evo.buildSend imagem por URL → /message/sendMedia", async () => {
  const r = await e.buildSend(creds, {
    chatId: "5511", phone: "5511", type: "image", content: "leg",
    media: { url: "https://x/i.png", mime: "image/png", fileName: "i.png" },
  });
  assertEquals(r.url.endsWith("/message/sendMedia/you_casa"), true);
  assertEquals(JSON.parse(r.body!), {
    number: "5511", mediatype: "image", mimetype: "image/png",
    media: "https://x/i.png", caption: "leg", fileName: "i.png",
  });
});

Deno.test("evo.buildSend ptt/audio → /message/sendWhatsAppAudio", async () => {
  const r = await e.buildSend(creds, { chatId: "5511", phone: "5511", type: "ptt", media: { url: "https://x/a.ogg" } });
  assertEquals(r.url.endsWith("/message/sendWhatsAppAudio/you_casa"), true);
  assertEquals(JSON.parse(r.body!), { number: "5511", audio: "https://x/a.ogg" });
});

Deno.test("evo.parseSendResult lê data.key.id", () => {
  assertEquals(e.parseSendResult({ key: { id: "EVO1" } }), { providerMsgId: "EVO1" });
});
