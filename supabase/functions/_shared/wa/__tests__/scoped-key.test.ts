import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { decideScopedAction, SCOPE_CHAT_TOOLS, SCOPE_FREE, SCOPE_SEND_NEW } from "../scoped-key.ts";

const CAT = "vip";
const d = (i: Partial<Parameters<typeof decideScopedAction>[0]> & { action: string }) =>
  decideScopedAction({ category: CAT, ...i }).kind;

Deno.test("tools globais sem conteudo de chat passam direto", () => {
  for (const a of SCOPE_FREE) assertEquals(d({ action: a }), "pass");
});

Deno.test("inbox e search sempre ganham filtro forcado (ignora chatCats)", () => {
  assertEquals(d({ action: "inbox" }), "force_filter");
  assertEquals(d({ action: "search", chatCats: [] }), "force_filter");
});

Deno.test("tool fora da lista = bloqueada, mesmo dentro da categoria", () => {
  for (const a of ["zapi_action", "sync_groups", "merge_ghost_chats", "setup_voice_guide", "uncategorize", "list_scheduled", "cancel_scheduled", "download_attachment"]) {
    assertEquals(d({ action: a, chatCats: [CAT] }), "blocked", a);
  }
});

Deno.test("chat na categoria = pass pra toda tool de chat", () => {
  for (const a of SCOPE_CHAT_TOOLS) {
    if (a === "categorize") continue; // regra propria testada abaixo
    assertEquals(d({ action: a, chatCats: [CAT, "outra"] }), "pass", a);
  }
});

Deno.test("chat categorizado FORA da categoria = deny (o incidente que motivou tudo)", () => {
  assertEquals(d({ action: "read", chatCats: ["pessoal"] }), "deny");
  assertEquals(d({ action: "send", chatCats: ["equipe"], semHistorico: true }), "deny");
  assertEquals(d({ action: "react", chatCats: ["cliente"] }), "deny");
});

Deno.test("chat SEM categoria mas COM historico = conversa pre-existente do dono, deny ate pra send", () => {
  assertEquals(d({ action: "send", chatCats: [], semHistorico: false }), "deny");
  assertEquals(d({ action: "read", chatCats: [], semHistorico: false }), "deny");
});

Deno.test("conversa nascendo (sem categoria, sem historico): familia send adota, leitura nao", () => {
  for (const a of SCOPE_SEND_NEW) assertEquals(d({ action: a, chatCats: [], semHistorico: true }), "adopt", a);
  assertEquals(d({ action: "read", chatCats: [], semHistorico: true }), "deny");
});

Deno.test("destino sem chat nenhum: so a familia send segue (allow_new)", () => {
  for (const a of SCOPE_SEND_NEW) assertEquals(d({ action: a, chatCats: null }), "send_new", a);
  assertEquals(d({ action: "read", chatCats: null }), "deny");
  assertEquals(d({ action: "transcribe", chatCats: null }), "deny");
});

Deno.test("categorize escopada: so a propria categoria e so em chat virgem de categoria", () => {
  assertEquals(d({ action: "categorize", chatCats: [], categorizeSlugs: [CAT] }), "pass");
  assertEquals(d({ action: "categorize", chatCats: [], categorizeSlugs: ["pessoal"] }), "deny");
  assertEquals(d({ action: "categorize", chatCats: [], categorizeSlugs: [CAT, "outra"] }), "deny");
  assertEquals(d({ action: "categorize", chatCats: ["pessoal"], categorizeSlugs: [CAT] }), "deny");
  assertEquals(d({ action: "categorize", chatCats: [CAT] }), "pass"); // ja dentro: idempotente
});
