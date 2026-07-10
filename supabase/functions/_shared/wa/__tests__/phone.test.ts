// __tests__/phone.test.ts — normalizacao BR do 9o digito + decisao de match
// por telefone (auditoria 07/2026: ambiguo NUNCA se resolve sozinho).
import { assertEquals } from "jsr:@std/assert";
import { normalizePhoneBR, expandChatIdCandidates, pickPhoneChat, type PhoneChatRow } from "../phone.ts";

function row(over: Partial<PhoneChatRow> & { chat_id: string }): PhoneChatRow {
  return { instance_id: "inst-a", chat_name: null, contact_name: null, is_group: false, ...over };
}

// ─── normalizePhoneBR ──────────────────────────────────────────────────────────

Deno.test("normalizePhoneBR: 13 digitos com 9 gera variante sem o 9", () => {
  const v = normalizePhoneBR("5511987654321");
  assertEquals(v.includes("5511987654321"), true);
  assertEquals(v.includes("551187654321"), true);
});

Deno.test("normalizePhoneBR: 12 digitos sem 9 gera variante com o 9", () => {
  const v = normalizePhoneBR("551187654321");
  assertEquals(v.includes("551187654321"), true);
  assertEquals(v.includes("5511987654321"), true);
});

Deno.test("normalizePhoneBR: local 11 digitos ganha DDI 55 e flip do 9", () => {
  const v = normalizePhoneBR("11987654321");
  assertEquals(v.includes("11987654321"), true);
  assertEquals(v.includes("5511987654321"), true);
  assertEquals(v.includes("551187654321"), true);
});

Deno.test("normalizePhoneBR: local 10 digitos ganha DDI 55 e variante com 9", () => {
  const v = normalizePhoneBR("1187654321");
  assertEquals(v.includes("1187654321"), true);
  assertEquals(v.includes("551187654321"), true);
  assertEquals(v.includes("5511987654321"), true);
});

Deno.test("normalizePhoneBR: consistencia bidirecional (com-9 e sem-9 geram o mesmo conjunto 55*)", () => {
  const com9 = new Set(normalizePhoneBR("5511987654321").filter((d) => d.startsWith("55")));
  const sem9 = new Set(normalizePhoneBR("551187654321").filter((d) => d.startsWith("55")));
  assertEquals(com9, sem9);
});

Deno.test("normalizePhoneBR: vazio retorna []", () => {
  assertEquals(normalizePhoneBR(""), []);
});

// ─── expandChatIdCandidates ────────────────────────────────────────────────────

Deno.test("expandChatIdCandidates: cobre sufixos de provider", () => {
  const c = expandChatIdCandidates(["5511987654321"]);
  assertEquals(c.includes("5511987654321"), true);
  assertEquals(c.includes("5511987654321@s.whatsapp.net"), true);
  assertEquals(c.includes("5511987654321@lid"), true);
  assertEquals(c.includes("5511987654321-group"), true);
});

// ─── pickPhoneChat ─────────────────────────────────────────────────────────────

Deno.test("pickPhoneChat: zero linhas -> null (cai pro fallback)", () => {
  assertEquals(pickPhoneChat([], ["5511987654321"]), null);
});

Deno.test("pickPhoneChat: match unico -> escolhe direto", () => {
  const r = row({ chat_id: "5511987654321", chat_name: "Carlos" });
  const pick = pickPhoneChat([r], ["5511987654321"]);
  assertEquals(pick && "chat" in pick ? pick.chat.chat_id : null, "5511987654321");
});

Deno.test("pickPhoneChat: colapso 1 — numerico + espelho @lid do mesmo numero -> numerico", () => {
  const num = row({ chat_id: "5511987654321", chat_name: "Carlos" });
  const lid = row({ chat_id: "123456789@lid", chat_name: "Carlos" });
  const pick = pickPhoneChat([num, lid], normalizePhoneBR("5511987654321"));
  assertEquals(pick && "chat" in pick ? pick.chat.chat_id : null, "5511987654321");
});

Deno.test("pickPhoneChat: colapso 2 — par real + fantasma do 9o digito -> o que tem identidade", () => {
  const fantasma = row({ chat_id: "5511987654321", chat_name: "5511987654321", last_message_at: "2026-07-10T00:00:00Z" });
  const real = row({ chat_id: "551187654321", chat_name: "Carlos Shimizu", last_message_at: "2026-01-01T00:00:00Z" });
  const pick = pickPhoneChat([fantasma, real], normalizePhoneBR("5511987654321"));
  // o real vence MESMO sendo menos recente (envio engolido renova o fantasma)
  assertEquals(pick && "chat" in pick ? pick.chat.chat_id : null, "551187654321");
});

Deno.test("pickPhoneChat: par do 9o digito SEM identidade clara -> ambiguo (candidates)", () => {
  const a = row({ chat_id: "5511987654321", chat_name: "5511987654321" });
  const b = row({ chat_id: "551187654321", chat_name: "551187654321" });
  const pick = pickPhoneChat([a, b], normalizePhoneBR("5511987654321"));
  assertEquals(pick && "candidates" in pick ? pick.candidates.length : 0, 2);
});

Deno.test("pickPhoneChat: par do 9o digito com AMBOS com identidade -> ambiguo", () => {
  const a = row({ chat_id: "5511987654321", chat_name: "Carlos A" });
  const b = row({ chat_id: "551187654321", chat_name: "Carlos B" });
  const pick = pickPhoneChat([a, b], normalizePhoneBR("5511987654321"));
  assertEquals(pick && "candidates" in pick ? pick.candidates.length : 0, 2);
});

Deno.test("pickPhoneChat: mesmo numero em 2 instancias -> ambiguo (nunca por recencia)", () => {
  const a = row({ chat_id: "5511987654321", chat_name: "Carlos", instance_id: "inst-a", last_message_at: "2026-07-10T00:00:00Z" });
  const b = row({ chat_id: "5511987654321", chat_name: "Carlos", instance_id: "inst-b", last_message_at: "2026-01-01T00:00:00Z" });
  const pick = pickPhoneChat([a, b], normalizePhoneBR("5511987654321"));
  assertEquals(pick && "candidates" in pick ? pick.candidates.length : 0, 2);
});

Deno.test("pickPhoneChat: pessoa + grupo com mesmo numero-base -> ambiguo (boost nao decide)", () => {
  const pessoa = row({ chat_id: "5511987654321", chat_name: "Carlos", last_message_at: "2026-07-10T00:00:00Z" });
  const grupo = row({ chat_id: "5511987654321-group", chat_name: "Grupo do Carlos", is_group: true, last_message_at: "2026-07-09T00:00:00Z" });
  const pick = pickPhoneChat([pessoa, grupo], normalizePhoneBR("5511987654321"));
  assertEquals(pick && "candidates" in pick ? pick.candidates.length : 0, 2);
});

Deno.test("pickPhoneChat: numerico que NAO e variante do digitado + lid -> ambiguo", () => {
  // ex.: lid_mapping apontou pra um numero diferente do digitado — nao colapsa
  const num = row({ chat_id: "5521999998888", chat_name: "Outro" });
  const lid = row({ chat_id: "123456789@lid", chat_name: "Carlos" });
  const pick = pickPhoneChat([num, lid], normalizePhoneBR("5511987654321"));
  assertEquals(pick && "candidates" in pick ? pick.candidates.length : 0, 2);
});
