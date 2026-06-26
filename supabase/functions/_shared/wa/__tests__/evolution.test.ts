import { assertEquals } from "jsr:@std/assert";
import { EvolutionProvider } from "../evolution.ts";
import type { InstanceCreds } from "../types.ts";
import upsertText from "./fixtures/evo-messages-upsert-text.json" with { type: "json" };
import upsertImage from "./fixtures/evo-messages-upsert-image.json" with { type: "json" };
import statusPayload from "./fixtures/evo-status.json" with { type: "json" };

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

// ── matchesWebhook / webhookInstanceKey / verifyWebhookAuth ──────────────────

Deno.test("evo.matchesWebhook usa `event`", () => {
  assertEquals(e.matchesWebhook({ event: "messages.upsert" }), true);
  assertEquals(e.matchesWebhook({ event: "connection.update" }), true);
  assertEquals(e.matchesWebhook({ type: "ReceivedCallback" }), false);
  assertEquals(e.matchesWebhook(null), false);
  assertEquals(e.matchesWebhook({}), false);
});

Deno.test("evo.webhookInstanceKey lê `instance`", () => {
  assertEquals(e.webhookInstanceKey({ instance: "you_casa" }), "you_casa");
  assertEquals(e.webhookInstanceKey({ event: "messages.upsert" }), null);
  assertEquals(e.webhookInstanceKey(null), null);
});

Deno.test("evo.verifyWebhookAuth: WEBHOOK_REQUIRE_AUTH desligado → true", () => {
  // Env not set → should return true
  const origGet = Deno.env.get;
  (Deno.env as any).get = (k: string) => k === "WEBHOOK_REQUIRE_AUTH" ? undefined : origGet.call(Deno.env, k);
  try {
    assertEquals(e.verifyWebhookAuth({}, new Headers(), null), true);
    assertEquals(e.verifyWebhookAuth({}, new Headers(), creds), true);
  } finally {
    (Deno.env as any).get = origGet;
  }
});

Deno.test("evo.verifyWebhookAuth: WEBHOOK_REQUIRE_AUTH=true compara header authorization", () => {
  const origGet = Deno.env.get;
  (Deno.env as any).get = (k: string) => k === "WEBHOOK_REQUIRE_AUTH" ? "true" : origGet.call(Deno.env, k);
  try {
    const credsWithToken = { ...creds, webhook_token: "secret-evo-token" } as any;
    const goodHeaders = new Headers({ "authorization": "secret-evo-token" });
    const badHeaders = new Headers({ "authorization": "wrong-token" });
    const emptyHeaders = new Headers();

    assertEquals(e.verifyWebhookAuth({}, goodHeaders, credsWithToken), true);
    assertEquals(e.verifyWebhookAuth({}, badHeaders, credsWithToken), false);
    assertEquals(e.verifyWebhookAuth({}, emptyHeaders, credsWithToken), false);
    // null creds → false
    assertEquals(e.verifyWebhookAuth({}, goodHeaders, null), false);
    // creds without webhook_token → false
    assertEquals(e.verifyWebhookAuth({}, goodHeaders, creds), false);
  } finally {
    (Deno.env as any).get = origGet;
  }
});

// ── normalizeInbound ─────────────────────────────────────────────────────────

Deno.test("evo.normalizeInbound: messages.upsert texto → message neutro", async () => {
  const evs = await e.normalizeInbound(upsertText, creds);
  assertEquals(evs.length, 1);
  const ev = evs[0];
  assertEquals(ev.kind, "message");
  if (ev.kind === "message") {
    assertEquals(ev.messageType, "text");
    assertEquals(ev.chatId, "558192030166");          // dígitos do remoteJidAlt (lid mode)
    assertEquals(ev.fromMe, false);
    assertEquals(ev.senderName, "Asafe Silva");        // pushName
    assertEquals(ev.providerMsgId, "3EB041E7E371837D3775CB");
    assertEquals(ev.content, "texto da mensagem");
    assertEquals(ev.media, null);
    assertEquals(ev.isGroup, false);
    assertEquals(ev.senderPhone, "558192030166");      // same as chatId for non-group
    assertEquals(ev.caption, null);
    assertEquals(ev.quotedProviderId, null);
    assertEquals(typeof ev.timestamp, "string");
  }
});

Deno.test("evo.normalizeInbound: messages.upsert imagem → message com media fetch", async () => {
  const evs = await e.normalizeInbound(upsertImage, creds);
  assertEquals(evs.length, 1);
  const ev = evs[0];
  assertEquals(ev.kind, "message");
  if (ev.kind === "message") {
    assertEquals(ev.messageType, "image");
    assertEquals(ev.chatId, "558192030166");
    assertEquals(ev.caption, "Veja essa imagem");
    assertEquals(ev.quotedProviderId, "QUOTED_MSG_ID_001");
    assertEquals(ev.media !== null, true);
    if (ev.media) {
      assertEquals(ev.media.strategy, "fetch");
      assertEquals(ev.media.providerMsgId, "3EB041E7E371837D3775CC");
      assertEquals(ev.media.mime, "image/jpeg");
      assertEquals(ev.media.bucket, "whatsapp-images");
      assertEquals(ev.media.ext, "jpg");
    }
  }
});

Deno.test("evo.normalizeInbound: messages.update → evento status read", async () => {
  const evs = await e.normalizeInbound(statusPayload, creds);
  assertEquals(evs.length, 1);
  assertEquals(evs[0].kind, "status");
  if (evs[0].kind === "status") {
    assertEquals(evs[0].status, "read");
    assertEquals(evs[0].providerMsgIds, ["3EB041E7E371837D3775CB"]);
  }
});

Deno.test("evo.normalizeInbound: connection.update open → evento connection", async () => {
  const conn = { event: "connection.update", instance: "you_casa", data: { state: "open" } };
  const evs = await e.normalizeInbound(conn, creds);
  assertEquals(evs.length, 1);
  assertEquals(evs[0].kind, "connection");
  if (evs[0].kind === "connection") {
    assertEquals(evs[0].connected, true);
  }
});

Deno.test("evo.normalizeInbound: connection.update close → evento connection desconectado", async () => {
  const conn = { event: "connection.update", instance: "you_casa", data: { state: "close" } };
  const evs = await e.normalizeInbound(conn, creds);
  assertEquals(evs.length, 1);
  assertEquals(evs[0].kind, "connection");
  if (evs[0].kind === "connection") {
    assertEquals(evs[0].connected, false);
  }
});

Deno.test("evo.normalizeInbound: group-participants.update ADD → evento group_participant", async () => {
  const grp = {
    event: "group-participants.update",
    instance: "you_casa",
    data: {
      id: "5511group@g.us",
      action: "add",
      participants: ["5511999990001@s.whatsapp.net", "5511999990002@s.whatsapp.net"],
    },
  };
  const evs = await e.normalizeInbound(grp, creds);
  assertEquals(evs.length, 1);
  assertEquals(evs[0].kind, "group_participant");
  if (evs[0].kind === "group_participant") {
    assertEquals(evs[0].action, "add");
    assertEquals(evs[0].chatId, "5511group@g.us");
    assertEquals(evs[0].phones, ["5511999990001", "5511999990002"]);
  }
});

Deno.test("evo.normalizeInbound: evento desconhecido → []", async () => {
  const unknown = { event: "some.unknown", instance: "you_casa", data: {} };
  const evs = await e.normalizeInbound(unknown, creds);
  assertEquals(evs.length, 0);
});

Deno.test("evo.normalizeInbound: messages.upsert audio ptt → messageType ptt", async () => {
  const ptt = {
    event: "messages.upsert",
    instance: "you_casa",
    data: {
      key: { remoteJid: "5511999@s.whatsapp.net", fromMe: false, id: "MSG_PTT", participant: "", addressingMode: "user" },
      pushName: "Test",
      status: "DELIVERY_ACK",
      message: { audioMessage: { mimetype: "audio/ogg; codecs=opus", ptt: true } },
      messageType: "audioMessage",
      messageTimestamp: 1781039200,
    },
  };
  const evs = await e.normalizeInbound(ptt, creds);
  assertEquals(evs.length, 1);
  if (evs[0].kind === "message") {
    assertEquals(evs[0].messageType, "ptt");
    assertEquals(evs[0].media?.bucket, "whatsapp-audio");
    assertEquals(evs[0].media?.ext, "ogg");
  }
});

Deno.test("evo.normalizeInbound: messages.upsert audio non-ptt → messageType audio", async () => {
  const audio = {
    event: "messages.upsert",
    instance: "you_casa",
    data: {
      key: { remoteJid: "5511999@s.whatsapp.net", fromMe: false, id: "MSG_AUDIO", participant: "", addressingMode: "user" },
      pushName: "Test",
      status: "DELIVERY_ACK",
      message: { audioMessage: { mimetype: "audio/mp4", ptt: false } },
      messageType: "audioMessage",
      messageTimestamp: 1781039200,
    },
  };
  const evs = await e.normalizeInbound(audio, creds);
  assertEquals(evs.length, 1);
  if (evs[0].kind === "message") {
    assertEquals(evs[0].messageType, "audio");
  }
});

Deno.test("evo.normalizeInbound: messages.upsert reactionMessage → evento reaction", async () => {
  const reaction = {
    event: "messages.upsert",
    instance: "you_casa",
    data: {
      key: { remoteJid: "5511999@s.whatsapp.net", fromMe: false, id: "MSG_REACT", participant: "", addressingMode: "user" },
      pushName: "Test",
      status: "DELIVERY_ACK",
      message: {
        reactionMessage: {
          key: { id: "TARGET_MSG_ID" },
          text: "👍",
        },
      },
      messageType: "reactionMessage",
      messageTimestamp: 1781039300,
    },
  };
  const evs = await e.normalizeInbound(reaction, creds);
  assertEquals(evs.length, 1);
  assertEquals(evs[0].kind, "reaction");
  if (evs[0].kind === "reaction") {
    assertEquals(evs[0].emoji, "👍");
    assertEquals(evs[0].targetProviderMsgId, "TARGET_MSG_ID");
  }
});

Deno.test("evo.normalizeInbound: messages.upsert com ephemeralMessage → desembrulha", async () => {
  const ephemeral = {
    event: "messages.upsert",
    instance: "you_casa",
    data: {
      key: { remoteJid: "5511999@s.whatsapp.net", fromMe: false, id: "MSG_EPH", participant: "", addressingMode: "user" },
      pushName: "Test",
      status: "DELIVERY_ACK",
      message: {
        ephemeralMessage: {
          message: {
            conversation: "mensagem efemera",
          },
        },
      },
      messageType: "ephemeralMessage",
      messageTimestamp: 1781039400,
    },
  };
  const evs = await e.normalizeInbound(ephemeral, creds);
  assertEquals(evs.length, 1);
  if (evs[0].kind === "message") {
    assertEquals(evs[0].content, "mensagem efemera");
    assertEquals(evs[0].messageType, "text");
  }
});

Deno.test("evo.normalizeInbound: messages.upsert grupo → chatId=jid, senderPhone=participant", async () => {
  const grpMsg = {
    event: "messages.upsert",
    instance: "you_casa",
    data: {
      key: {
        remoteJid: "5511group@g.us",
        fromMe: false,
        id: "MSG_GRP",
        participant: "5511999@s.whatsapp.net",
        addressingMode: "user",
      },
      pushName: "Sender",
      status: "DELIVERY_ACK",
      message: { conversation: "oi grupo" },
      messageType: "conversation",
      messageTimestamp: 1781039500,
    },
  };
  const evs = await e.normalizeInbound(grpMsg, creds);
  assertEquals(evs.length, 1);
  if (evs[0].kind === "message") {
    assertEquals(evs[0].isGroup, true);
    assertEquals(evs[0].chatId, "5511group@g.us");
    assertEquals(evs[0].senderPhone, "5511999");
  }
});

Deno.test("evo.normalizeInbound: messages.update DELIVERY_ACK → status delivered", async () => {
  const deliveryAck = {
    event: "messages.update",
    instance: "you_casa",
    data: {
      key: { remoteJid: "5511999@s.whatsapp.net", fromMe: true, id: "MSG_DEL" },
      status: "DELIVERY_ACK",
    },
  };
  const evs = await e.normalizeInbound(deliveryAck, creds);
  assertEquals(evs.length, 1);
  if (evs[0].kind === "status") {
    assertEquals(evs[0].status, "delivered");
    assertEquals(evs[0].providerMsgIds, ["MSG_DEL"]);
  }
});

Deno.test("evo.normalizeInbound: messages.update SERVER_ACK → status sent", async () => {
  const serverAck = {
    event: "messages.update",
    instance: "you_casa",
    data: {
      key: { remoteJid: "5511999@s.whatsapp.net", fromMe: true, id: "MSG_SRV" },
      status: "SERVER_ACK",
    },
  };
  const evs = await e.normalizeInbound(serverAck, creds);
  assertEquals(evs.length, 1);
  if (evs[0].kind === "status") {
    assertEquals(evs[0].status, "sent");
  }
});

// ── fetchMedia ───────────────────────────────────────────────────────────────

Deno.test("evo.fetchMedia decodifica base64 do getBase64FromMediaMessage", async () => {
  const orig = globalThis.fetch;
  const b64 = btoa("abc");
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ base64: b64, mimetype: "audio/ogg", fileName: "a.ogg" }), { status: 200 }),
    );
  try {
    const out = await e.fetchMedia(creds, {
      strategy: "fetch",
      providerMsgId: "MID",
      mime: null,
      bucket: "whatsapp-audio",
      ext: "ogg",
    });
    assertEquals(new TextDecoder().decode(out.bytes), "abc");
    assertEquals(out.mime, "audio/ogg");
    assertEquals(out.fileName, "a.ogg");
  } finally {
    globalThis.fetch = orig;
  }
});

Deno.test("evo.fetchMedia envia POST correto para getBase64FromMediaMessage", async () => {
  const orig = globalThis.fetch;
  let capturedUrl = "";
  let capturedInit: RequestInit = {};
  const b64 = btoa("xyz");
  globalThis.fetch = (url: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedInit = init ?? {};
    return Promise.resolve(
      new Response(JSON.stringify({ base64: b64, mimetype: "image/jpeg", fileName: "img.jpg" }), { status: 200 }),
    );
  };
  try {
    await e.fetchMedia(creds, {
      strategy: "fetch",
      providerMsgId: "MSGID123",
      mime: "image/jpeg",
      bucket: "whatsapp-images",
      ext: "jpg",
    });
    assertEquals(capturedUrl, "https://evo.x/chat/getBase64FromMediaMessage/you_casa");
    assertEquals((capturedInit.headers as Record<string, string>)["apikey"], "APIKEY");
    assertEquals(JSON.parse(capturedInit.body as string), {
      message: { key: { id: "MSGID123" } },
      convertToMp4: false,
    });
  } finally {
    globalThis.fetch = orig;
  }
});

Deno.test("evo.fetchMedia usa mime/fileName de ref quando resposta não traz", async () => {
  const orig = globalThis.fetch;
  const b64 = btoa("fallback");
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ base64: b64 }), { status: 200 }),
    );
  try {
    const out = await e.fetchMedia(creds, {
      strategy: "fetch",
      providerMsgId: "MID2",
      mime: "video/mp4",
      bucket: "whatsapp-video",
      ext: "mp4",
      fileName: "clip.mp4",
    });
    assertEquals(out.mime, "video/mp4");
    assertEquals(out.fileName, "clip.mp4");
  } finally {
    globalThis.fetch = orig;
  }
});

Deno.test("evo.fetchMedia retenta em falha e sucede na segunda tentativa", async () => {
  const orig = globalThis.fetch;
  let attempts = 0;
  const b64 = btoa("retry");
  globalThis.fetch = () => {
    attempts++;
    if (attempts < 2) {
      return Promise.resolve(new Response("error", { status: 500 }));
    }
    return Promise.resolve(
      new Response(JSON.stringify({ base64: b64, mimetype: "audio/ogg" }), { status: 200 }),
    );
  };
  try {
    const out = await e.fetchMedia(creds, {
      strategy: "fetch",
      providerMsgId: "MID3",
      mime: null,
      bucket: "whatsapp-audio",
      ext: "ogg",
    });
    assertEquals(new TextDecoder().decode(out.bytes), "retry");
    assertEquals(attempts, 2);
  } finally {
    globalThis.fetch = orig;
  }
});
