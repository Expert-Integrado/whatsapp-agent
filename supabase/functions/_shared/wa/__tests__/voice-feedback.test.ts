import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { shouldOpenFeedbackTask, voiceFeedbackMarkdown, feedbackDedupeKey } from "../voice-feedback.ts";

Deno.test("threshold: abre task no 3o bloqueio da janela, nao antes", () => {
  assertEquals(shouldOpenFeedbackTask(1), false);
  assertEquals(shouldOpenFeedbackTask(2), false);
  assertEquals(shouldOpenFeedbackTask(3), true);
  assertEquals(shouldOpenFeedbackTask(7), true);
});

Deno.test("dedupe key: estavel por instancia+chat+dia (nao spamma o board)", () => {
  const a = feedbackDedupeKey("INST1", "5511999", "2026-07-19");
  const b = feedbackDedupeKey("INST1", "5511999", "2026-07-19");
  const c = feedbackDedupeKey("INST1", "5511999", "2026-07-20");
  const d = feedbackDedupeKey("INST2", "5511999", "2026-07-19"); // outra instancia
  const e = feedbackDedupeKey("INST1", "5511000", "2026-07-19"); // outro chat
  assertEquals(a, b);
  assertEquals(a === c, false); // difere por DIA
  assertEquals(a === d, false); // difere por INSTANCIA (dois donos, mesmo chat/dia = cards distintos)
  assertEquals(a === e, false); // difere por CHAT
  assertEquals(a.length <= 120, true);
});

Deno.test("card: contem destinatario, regras, exemplos e orientacao de correcao (sem aprovacao)", () => {
  const md = voiceFeedbackMarkdown({
    chatRef: "Joao Silva",
    instance: "profissional",
    blocks: [
      { tool: "send", rule_ids: ["zap"], text_preview: "te chamo no zap" },
      { tool: "send", rule_ids: ["zap", "tu-pronome"], text_preview: "tu me chama no zap" },
      { tool: "send", rule_ids: ["zap"], text_preview: "zap de novo" },
    ],
  });
  assertStringIncludes(md, "Joao Silva");
  assertStringIncludes(md, "zap (3x)");
  assertStringIncludes(md, "tu-pronome (1x)");
  assertStringIncludes(md, "te chamo no zap");
  assertStringIncludes(md, "voice guide");
  assertEquals(/aprovar|aprovação|pin|senha/i.test(md), false);
});

Deno.test("card: preview com quebra de linha NAO escapa do blockquote (injecao de markdown)", () => {
  const md = voiceFeedbackMarkdown({
    chatRef: "5511999",
    instance: "profissional",
    blocks: [
      { tool: "send", rule_ids: ["zap"], text_preview: "linha1\n# titulo injetado\n> fake quote" },
    ],
  });
  const linhas = md.split("\n");
  const idx = linhas.findIndex((l) => l.includes("linha1"));
  assertEquals(idx >= 0, true);
  assertEquals(linhas[idx].startsWith(">"), true);
  assertEquals(linhas[idx].includes("# titulo injetado"), true); // colapsado na MESMA linha do quote
  assertEquals(md.includes("\n# titulo injetado"), false); // nunca vira heading proprio
});
