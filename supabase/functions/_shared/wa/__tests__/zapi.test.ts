// __tests__/zapi.test.ts
import { assertEquals } from "jsr:@std/assert";
import { ZapiProvider } from "../zapi.ts";
import type { InstanceCreds } from "../types.ts";
import receivedText from "./fixtures/zapi-received-text.json" with { type: "json" };
import receivedImage from "./fixtures/zapi-received-image.json" with { type: "json" };
import statusPayload from "./fixtures/zapi-status.json" with { type: "json" };
import reactionPayload from "./fixtures/zapi-reaction.json" with { type: "json" };

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

// ── normalizeInbound / matchesWebhook / webhookInstanceKey / verifyWebhookAuth ──

Deno.test("zapi.normalizeInbound: ReceivedCallback texto → 1 evento message", async () => {
  const evs = await z.normalizeInbound(receivedText, creds);
  assertEquals(evs.length, 1);
  const ev = evs[0];
  assertEquals(ev.kind, "message");
  if (ev.kind === "message") {
    assertEquals(ev.messageType, "text");
    assertEquals(ev.fromMe, false);
    assertEquals(typeof ev.providerMsgId, "string");
    assertEquals(ev.content, "Olá, mundo!");
    assertEquals(ev.chatId, "5511999991234");
  }
});

Deno.test("zapi.normalizeInbound: ReceivedCallback imagem → evento message com media", async () => {
  const evs = await z.normalizeInbound(receivedImage, creds);
  assertEquals(evs.length, 1);
  const ev = evs[0];
  assertEquals(ev.kind, "message");
  if (ev.kind === "message") {
    assertEquals(ev.messageType, "image");
    assertEquals(ev.media !== null, true);
    if (ev.media) {
      assertEquals(ev.media.strategy, "url");
      assertEquals(ev.media.bucket, "whatsapp-images");
      assertEquals(ev.media.ext, "jpg");
      assertEquals(ev.media.url, "https://media.z-api.io/img/sample.jpg");
      assertEquals(ev.media.width, 1280);
      assertEquals(ev.media.height, 720);
      assertEquals(ev.media.thumbUrl, "https://media.z-api.io/img/sample-thumb.jpg");
    }
    assertEquals(ev.caption, "Veja essa foto");
  }
});

Deno.test("zapi.normalizeInbound: waitingMessage=true → retorna []", async () => {
  const waiting = { ...receivedText, waitingMessage: true };
  const evs = await z.normalizeInbound(waiting, creds);
  assertEquals(evs.length, 0);
});

Deno.test("zapi.normalizeInbound: MessageStatusCallback → evento status", async () => {
  const evs = await z.normalizeInbound(statusPayload, creds);
  assertEquals(evs.length, 1);
  assertEquals(evs[0].kind, "status");
  if (evs[0].kind === "status") {
    assertEquals(evs[0].status, "read");
    assertEquals(evs[0].providerMsgIds.length, 2);
  }
});

Deno.test("zapi.normalizeInbound: ReactionCallback (via ReceivedCallback) → evento reaction", async () => {
  const evs = await z.normalizeInbound(reactionPayload, creds);
  assertEquals(evs.length, 1);
  assertEquals(evs[0].kind, "reaction");
  if (evs[0].kind === "reaction") {
    assertEquals(evs[0].emoji, "👍");
    assertEquals(evs[0].targetProviderMsgId, "3EB0A1234567890ABCDE");
  }
});

Deno.test("zapi.normalizeInbound: ConnectedCallback → evento connection", async () => {
  const conn = { type: "ConnectedCallback", instanceId: "INST123" };
  const evs = await z.normalizeInbound(conn, creds);
  assertEquals(evs.length, 1);
  assertEquals(evs[0].kind, "connection");
  if (evs[0].kind === "connection") {
    assertEquals(evs[0].connected, true);
  }
});

Deno.test("zapi.normalizeInbound: DisconnectedCallback → evento connection desconectado", async () => {
  const disc = { type: "DisconnectedCallback", instanceId: "INST123" };
  const evs = await z.normalizeInbound(disc, creds);
  assertEquals(evs.length, 1);
  assertEquals(evs[0].kind, "connection");
  if (evs[0].kind === "connection") {
    assertEquals(evs[0].connected, false);
  }
});

Deno.test("zapi.normalizeInbound: RevokedMessageCallback → evento revoke", async () => {
  const revoke = { type: "RevokedMessageCallback", instanceId: "INST123", messageId: "MSG_REVOKED" };
  const evs = await z.normalizeInbound(revoke, creds);
  assertEquals(evs.length, 1);
  assertEquals(evs[0].kind, "revoke");
  if (evs[0].kind === "revoke") {
    assertEquals(evs[0].providerMsgId, "MSG_REVOKED");
  }
});

Deno.test("zapi.normalizeInbound: EditedMessageCallback → evento edit", async () => {
  const edit = {
    type: "EditedMessageCallback", instanceId: "INST123",
    messageId: "MSG_EDITED", text: { message: "novo conteudo" },
  };
  const evs = await z.normalizeInbound(edit, creds);
  assertEquals(evs.length, 1);
  assertEquals(evs[0].kind, "edit");
  if (evs[0].kind === "edit") {
    assertEquals(evs[0].providerMsgId, "MSG_EDITED");
    assertEquals(evs[0].newContent, "novo conteudo");
  }
});

Deno.test("zapi.normalizeInbound: NotificationCallback ADD → evento group_participant", async () => {
  const notif = {
    type: "NotificationCallback", instanceId: "INST123",
    phone: "5511group", notification: "GROUP_PARTICIPANT_ADD",
    notificationParameters: ["5511999990001", "5511999990002"],
  };
  const evs = await z.normalizeInbound(notif, creds);
  assertEquals(evs.length, 1);
  assertEquals(evs[0].kind, "group_participant");
  if (evs[0].kind === "group_participant") {
    assertEquals(evs[0].action, "add");
    assertEquals(evs[0].chatId, "5511group");
    assertEquals(evs[0].phones, ["5511999990001", "5511999990002"]);
  }
});

Deno.test("zapi.normalizeInbound: tipo desconhecido → []", async () => {
  const unknown = { type: "SomeUnknownCallback", instanceId: "INST123" };
  const evs = await z.normalizeInbound(unknown, creds);
  assertEquals(evs.length, 0);
});

Deno.test("zapi.matchesWebhook usa presença de `type`", () => {
  assertEquals(z.matchesWebhook({ type: "ReceivedCallback" }), true);
  assertEquals(z.matchesWebhook({ event: "messages.upsert" }), false);
  assertEquals(z.matchesWebhook(null), false);
  assertEquals(z.matchesWebhook({}), false);
});

Deno.test("zapi.webhookInstanceKey retorna instanceId ou null", () => {
  assertEquals(z.webhookInstanceKey({ instanceId: "INST123" }), "INST123");
  assertEquals(z.webhookInstanceKey({ type: "SomeCallback" }), null);
  assertEquals(z.webhookInstanceKey(null), null);
});

Deno.test("zapi.verifyWebhookAuth compara header z-api-token com creds", () => {
  const credsWithToken = { ...creds, webhook_token: "secret-wh-token" } as any;
  const headers = new Headers({ "z-api-token": "secret-wh-token" });
  const wrongHeaders = new Headers({ "z-api-token": "wrong-token" });
  const emptyHeaders = new Headers();

  assertEquals(z.verifyWebhookAuth({}, headers, credsWithToken), true);
  assertEquals(z.verifyWebhookAuth({}, wrongHeaders, credsWithToken), false);
  assertEquals(z.verifyWebhookAuth({}, emptyHeaders, credsWithToken), false);
  // null creds → false
  assertEquals(z.verifyWebhookAuth({}, headers, null), false);
  // creds without webhook_token → false (no TOFU here)
  assertEquals(z.verifyWebhookAuth({}, headers, creds), false);
});

// ── fetchMedia ───────────────────────────────────────────────────────────────

Deno.test("zapi.fetchMedia faz GET e devolve bytes", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = ((_url: string | URL | Request, _init?: RequestInit) =>
    Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
  ) as typeof fetch;
  try {
    const out = await z.fetchMedia(creds, {
      strategy: "url",
      url: "https://x/a.jpg",
      mime: "image/jpeg",
      bucket: "whatsapp-images",
      ext: "jpg",
    });
    assertEquals(out.bytes.length, 3);
    assertEquals(out.mime, "image/jpeg");
  } finally {
    globalThis.fetch = orig;
  }
});

Deno.test("zapi.fetchMedia usa mime padrão quando ref.mime é null", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = ((_url: string | URL | Request, _init?: RequestInit) =>
    Promise.resolve(new Response(new Uint8Array([9]), { status: 200 }))
  ) as typeof fetch;
  try {
    const out = await z.fetchMedia(creds, {
      strategy: "url",
      url: "https://x/doc.bin",
      mime: null,
      bucket: "whatsapp-documents",
      ext: "bin",
    });
    assertEquals(out.mime, "application/octet-stream");
  } finally {
    globalThis.fetch = orig;
  }
});

// ── resolveChatIds ────────────────────────────────────────────────────────────

Deno.test("zapi.resolveChatIds resolve @lid via cache (camada 1)", async () => {
  const fakeSupabase = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: { phone: "5511999" } }),
          }),
        }),
      }),
    }),
  };
  const ev = {
    kind: "message",
    chatId: "ABC@lid",
    fromMe: true,
    isGroup: false,
    chatName: "Test User",
    providerMsgId: "M1",
    messageType: "text",
    content: "hello",
    caption: null,
    quotedProviderId: null,
    isForwarded: false,
    timestamp: new Date().toISOString(),
    senderPhone: null,
    senderName: null,
    media: null,
    raw: {},
  } as any;
  const out = await z.resolveChatIds!([ev], creds, { supabase: fakeSupabase });
  assertEquals((out[0] as any).chatId, "5511999");
});

Deno.test("zapi.resolveChatIds não modifica evento sem @lid", async () => {
  const fakeSupabase = { from: () => { throw new Error("should not be called"); } };
  const ev = {
    kind: "message",
    chatId: "5511999@s.whatsapp.net",
    fromMe: true,
    isGroup: false,
    chatName: null,
    providerMsgId: "M2",
    messageType: "text",
    content: "oi",
    caption: null,
    quotedProviderId: null,
    isForwarded: false,
    timestamp: new Date().toISOString(),
    senderPhone: null,
    senderName: null,
    media: null,
    raw: {},
  } as any;
  const out = await z.resolveChatIds!([ev], creds, { supabase: fakeSupabase });
  assertEquals((out[0] as any).chatId, "5511999@s.whatsapp.net");
});

Deno.test("zapi.resolveChatIds não modifica @lid em grupo", async () => {
  const fakeSupabase = { from: () => { throw new Error("should not be called"); } };
  const ev = {
    kind: "message",
    chatId: "GRP@lid",
    fromMe: true,
    isGroup: true,
    chatName: null,
    providerMsgId: "M3",
    messageType: "text",
    content: "oi",
    caption: null,
    quotedProviderId: null,
    isForwarded: false,
    timestamp: new Date().toISOString(),
    senderPhone: null,
    senderName: null,
    media: null,
    raw: {},
  } as any;
  const out = await z.resolveChatIds!([ev], creds, { supabase: fakeSupabase });
  assertEquals((out[0] as any).chatId, "GRP@lid");
});

// ── buildAction ──────────────────────────────────────────────────────────────

Deno.test("zapi.buildAction send-reaction monta /send-reaction", () => {
  const r = z.buildAction(creds, "send-reaction", { phone: "5511", messageId: "M", reaction: "👍" });
  assertEquals(r!.url.endsWith("/send-reaction"), true);
  assertEquals(r!.method, "POST");
  assertEquals(r!.headers["Client-Token"], "CT");
  assertEquals(JSON.parse(r!.body!), { phone: "5511", messageId: "M", reaction: "👍" });
});

Deno.test("zapi.buildAction get-contact-info vira GET /contacts/{phone}", () => {
  const r = z.buildAction(creds, "get-contact-info", { phone: "5511" });
  assertEquals(r!.method, "GET");
  assertEquals(r!.url.endsWith("/contacts/5511"), true);
  assertEquals(r!.body, undefined);
});

Deno.test("zapi.buildAction phone-exists vira GET /phone-exists/{phone}", () => {
  const r = z.buildAction(creds, "phone-exists", { phone: "5581992030166" });
  assertEquals(r!.method, "GET");
  assertEquals(r!.url.endsWith("/phone-exists/5581992030166"), true);
  assertEquals(r!.body, undefined);
});

Deno.test("zapi.buildAction contacts usa GET sem body", () => {
  const r = z.buildAction(creds, "contacts", {});
  assertEquals(r!.method, "GET");
  assertEquals(r!.url.endsWith("/contacts"), true);
  assertEquals(r!.body, undefined);
});

Deno.test("zapi.buildAction status usa GET sem body (RED: atualmente retorna POST)", () => {
  const r = z.buildAction(creds, "status", {});
  assertEquals(r!.method, "GET");
  assertEquals(r!.url.endsWith("/status"), true);
  assertEquals(r!.body, undefined);
});

Deno.test("zapi.buildAction chats usa GET sem body", () => {
  const r = z.buildAction(creds, "chats", {});
  assertEquals(r!.method, "GET");
  assertEquals(r!.url.endsWith("/chats"), true);
  assertEquals(r!.body, undefined);
});


Deno.test("zapi.parseConnection lê connected/smartphoneConnected", () => {
  assertEquals(z.parseConnection({ connected: true }).connected, true);
  assertEquals(z.parseConnection({ smartphoneConnected: true }).connected, true);
  assertEquals(z.parseConnection({ connected: false, smartphoneConnected: false }).connected, false);
  assertEquals(z.parseConnection({}).connected, false);
  assertEquals(z.parseConnection({ phone: "5511", connected: true }).phone, "5511");
});

Deno.test("zapi.fetchGroups filtra grupos e mapeia para NeutralGroup", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = ((_url: string | URL | Request, _init?: RequestInit) =>
    Promise.resolve(new Response(JSON.stringify([
      { isGroup: true, phone: "1111111111", name: "Grupo A" },
      { isGroup: false, phone: "2222222222", name: "Contato B" },
      { isGroup: true, chatId: "3333333333", chatName: "Grupo C" },
      { type: "group", id: "4444444444", subject: "Grupo D" },
    ]), { status: 200, headers: { "Content-Type": "application/json" } }))
  ) as typeof fetch;
  try {
    const groups = await z.fetchGroups(creds);
    assertEquals(groups.length, 3);
    assertEquals(groups[0].chatId, "1111111111");
    assertEquals(groups[0].name, "Grupo A");
    assertEquals(groups[1].chatId, "3333333333");
    assertEquals(groups[1].name, "Grupo C");
    assertEquals(groups[2].chatId, "4444444444");
    assertEquals(groups[2].name, "Grupo D");
  } finally {
    globalThis.fetch = orig;
  }
});

// ── mentionsEveryone ─────────────────────────────────────────────────────────

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

// ── buildAction: grupos ──────────────────────────────────────────────────────

const ZBASE = "https://api.z-api.io/instances/INST/token/TKN";

Deno.test("zapi.buildAction group-metadata → GET com id @g.us normalizado pra -group", () => {
  const r = z.buildAction(creds, "group-metadata", { groupId: "120363123@g.us" });
  assertEquals(r!.url, `${ZBASE}/group-metadata/120363123-group`);
  assertEquals(r!.method, "GET");
  assertEquals(r!.body, undefined);
});

Deno.test("zapi.buildAction group-invitation-link → GET, aceita alias phone", () => {
  const r = z.buildAction(creds, "group-invitation-link", { phone: "120363123-group" });
  assertEquals(r!.url, `${ZBASE}/group-invitation-link/120363123-group`);
  assertEquals(r!.method, "GET");
});

Deno.test("zapi.buildAction redefine-invitation-link → POST com id no path", () => {
  const r = z.buildAction(creds, "redefine-invitation-link", { groupId: "120363123" });
  assertEquals(r!.url, `${ZBASE}/redefine-invitation-link/120363123-group`);
  assertEquals(r!.method, "POST");
});

Deno.test("zapi.buildAction group-invitation-metadata / accept-invite → GET com url encodada", () => {
  const url = "https://chat.whatsapp.com/ABC123def";
  const r1 = z.buildAction(creds, "group-invitation-metadata", { url });
  assertEquals(r1!.url, `${ZBASE}/group-invitation-metadata?url=${encodeURIComponent(url)}`);
  assertEquals(r1!.method, "GET");
  const r2 = z.buildAction(creds, "accept-invite", { url });
  assertEquals(r2!.url, `${ZBASE}/accept-invite-group?url=${encodeURIComponent(url)}`);
  assertEquals(r2!.method, "GET");
});

Deno.test("zapi.buildAction toggle-ephemeral → null (não suportado)", () => {
  assertEquals(z.buildAction(creds, "toggle-ephemeral", { groupId: "1", expiration: 86400 }), null);
});

Deno.test("zapi.buildAction update-group-name normaliza groupId no POST genérico", () => {
  const r = z.buildAction(creds, "update-group-name", { groupId: "120363123@g.us", groupName: "Novo" });
  assertEquals(r!.url, `${ZBASE}/update-group-name`);
  assertEquals(r!.method, "POST");
  assertEquals(JSON.parse(r!.body!), { groupId: "120363123-group", groupName: "Novo" });
});

Deno.test("zapi.buildAction leave-group aceita alias phone → body com groupId", () => {
  const r = z.buildAction(creds, "leave-group", { phone: "120363123@g.us" });
  assertEquals(r!.url, `${ZBASE}/leave-group`);
  assertEquals(JSON.parse(r!.body!), { groupId: "120363123-group" });
});

Deno.test("zapi.buildAction update-group-settings usa campo phone (dialeto do endpoint)", () => {
  const r = z.buildAction(creds, "update-group-settings", {
    groupId: "120363123@g.us",
    adminOnlyMessage: true, adminOnlySettings: false,
    requireAdminApproval: false, adminOnlyAddMember: true,
  });
  assertEquals(r!.url, `${ZBASE}/update-group-settings`);
  assertEquals(JSON.parse(r!.body!), {
    phone: "120363123-group",
    adminOnlyMessage: true, adminOnlySettings: false,
    requireAdminApproval: false, adminOnlyAddMember: true,
  });
});

Deno.test("zapi.buildAction add-participant normaliza groupId e mantém phones", () => {
  const r = z.buildAction(creds, "add-participant", { groupId: "120363123", phones: ["5511999990001"], autoInvite: true });
  assertEquals(r!.url, `${ZBASE}/add-participant`);
  assertEquals(JSON.parse(r!.body!), { groupId: "120363123-group", phones: ["5511999990001"], autoInvite: true });
});
