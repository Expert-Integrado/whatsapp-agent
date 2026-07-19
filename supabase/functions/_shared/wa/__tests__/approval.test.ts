import { assertEquals, assertNotEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { approvalCardMarkdown, approvalDecision, hashToken, newApprovalToken } from "../approval.ts";

const NOW = 1_784_400_000_000; // instante fixo (testes nao dependem de relogio)
const FUTURE = new Date(NOW + 3_600_000).toISOString();
const PAST = new Date(NOW - 1_000).toISOString();

Deno.test("decision: pending + approve = prossegue pra approved", () => {
  const d = approvalDecision({ status: "pending", expires_at: FUTURE }, "approve", NOW);
  assertEquals(d, { kind: "proceed", to: "approved" });
});

Deno.test("decision: pending + reject = prossegue pra rejected", () => {
  const d = approvalDecision({ status: "pending", expires_at: FUTURE }, "reject", NOW);
  assertEquals(d, { kind: "proceed", to: "rejected" });
});

Deno.test("decision: pendente mas vencido = expired (mesmo com approve)", () => {
  const d = approvalDecision({ status: "pending", expires_at: PAST }, "approve", NOW);
  assertEquals(d.kind, "expired");
});

Deno.test("decision: ja processado = already com o status (idempotencia do 2o clique)", () => {
  for (const status of ["approved", "rejected", "failed", "expired"] as const) {
    const d = approvalDecision({ status, expires_at: FUTURE }, "approve", NOW);
    assertEquals(d, { kind: "already", status });
  }
});

Deno.test("decision: action desconhecida = invalid", () => {
  const d = approvalDecision({ status: "pending", expires_at: FUTURE }, "banana" as "approve", NOW);
  assertEquals(d.kind, "invalid");
});

Deno.test("token: 64 hex chars, unico entre chamadas", () => {
  const a = newApprovalToken();
  const b = newApprovalToken();
  assertEquals(/^[0-9a-f]{64}$/.test(a), true);
  assertNotEquals(a, b);
});

Deno.test("hashToken: sha-256 hex deterministico e != do token", async () => {
  const h1 = await hashToken("abc");
  const h2 = await hashToken("abc");
  assertEquals(h1, h2);
  assertEquals(/^[0-9a-f]{64}$/.test(h1), true);
  assertNotEquals(h1, await hashToken("abd"));
});

Deno.test("card: contem destinatario, texto exato, violacoes e os 2 links", () => {
  const md = approvalCardMarkdown({
    chatName: "Joao Silva",
    instance: "profissional",
    tool: "send",
    texts: ["te chamo no zap amanha"],
    violations: [{ id: "zap", message: "Eric nunca fala zap" }],
    approveUrl: "https://x.supabase.co/functions/v1/mcp-api?approval=id.tok&action=approve",
    rejectUrl: "https://x.supabase.co/functions/v1/mcp-api?approval=id.tok&action=reject",
    expiresBrt: "19/07/2026 14:00",
  });
  assertStringIncludes(md, "Joao Silva");
  assertStringIncludes(md, "te chamo no zap amanha");
  assertStringIncludes(md, "zap: Eric nunca fala zap");
  assertStringIncludes(md, "[APROVAR e enviar](https://x.supabase.co/functions/v1/mcp-api?approval=id.tok&action=approve)");
  assertStringIncludes(md, "[RECUSAR](https://x.supabase.co/functions/v1/mcp-api?approval=id.tok&action=reject)");
  assertStringIncludes(md, "19/07/2026 14:00");
});

Deno.test("card: multiplos textos (schedule/poll) todos presentes", () => {
  const md = approvalCardMarkdown({
    chatName: "Grupo X", instance: "pessoal", tool: "schedule",
    texts: ["primeiro item", "segundo item"],
    violations: [{ id: "zap", message: "m" }],
    approveUrl: "https://a/ok", rejectUrl: "https://a/no", expiresBrt: "x",
  });
  assertStringIncludes(md, "primeiro item");
  assertStringIncludes(md, "segundo item");
});
