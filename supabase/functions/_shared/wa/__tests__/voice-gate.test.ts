import { assertEquals } from "jsr:@std/assert@1";
import { evaluateVoiceGate, type VoiceViolation } from "../voice-gate.ts";

// checker fake: "zapx" e "morx" = high, "blzx" = medium
const violationsFor = (text: string): VoiceViolation[] => {
  const out: VoiceViolation[] = [];
  if (/zapx/i.test(text)) out.push({ id: "zap", severity: "high", message: "regra zap", match: "zapx" });
  if (/morx/i.test(text)) out.push({ id: "vocativo", severity: "high", message: "regra vocativo", match: "morx" });
  if (/blzx/i.test(text)) out.push({ id: "blz", severity: "medium", message: "regra blz", match: "blzx" });
  return out;
};

Deno.test("gate off: passa mesmo com violacao high", () => {
  const r = evaluateVoiceGate({ texts: ["me chama no zapx"], gate: "off", confirmedVoice: false, violationsFor });
  assertEquals(r.blocked, false);
  assertEquals(r.violations.length, 0);
});

Deno.test("gate warn: violacao high vira warning, nao bloqueia", () => {
  const r = evaluateVoiceGate({ texts: ["me chama no zapx"], gate: "warn", confirmedVoice: false, violationsFor });
  assertEquals(r.blocked, false);
  assertEquals(r.violations.map((v) => v.id), ["zap"]);
});

Deno.test("gate block sem confirmed_voice: bloqueia violacao high", () => {
  const r = evaluateVoiceGate({ texts: ["me chama no zapx"], gate: "block", confirmedVoice: false, violationsFor });
  assertEquals(r.blocked, true);
  assertEquals(r.violations.map((v) => v.id), ["zap"]);
});

Deno.test("gate block com confirmed_voice: passa com warnings", () => {
  const r = evaluateVoiceGate({ texts: ["me chama no zapx"], gate: "block", confirmedVoice: true, violationsFor });
  assertEquals(r.blocked, false);
  assertEquals(r.violations.map((v) => v.id), ["zap"]);
});

Deno.test("gate block: violacao medium NAO bloqueia nem vira warning do gate", () => {
  const r = evaluateVoiceGate({ texts: ["blzx, seguimos"], gate: "block", confirmedVoice: false, violationsFor });
  assertEquals(r.blocked, false);
  assertEquals(r.violations.length, 0);
});

Deno.test("texto limpo: passa em qualquer gate", () => {
  for (const gate of ["off", "warn", "block"] as const) {
    const r = evaluateVoiceGate({ texts: ["beleza, seguimos"], gate, confirmedVoice: false, violationsFor });
    assertEquals(r.blocked, false);
    assertEquals(r.violations.length, 0);
  }
});

Deno.test("acumulacao: 2 violacoes high DISTINTAS na mesma chamada bloqueiam com as 2 listadas", () => {
  const r = evaluateVoiceGate({ texts: ["zapx e morx na mesma msg"], gate: "block", confirmedVoice: false, violationsFor });
  assertEquals(r.blocked, true);
  assertEquals(r.violations.map((v) => v.id).sort(), ["vocativo", "zap"]);
});

Deno.test("dedupe: mesma regra em 2 textos aparece 1x", () => {
  const r = evaluateVoiceGate({ texts: ["zapx aqui", "zapx ali"], gate: "block", confirmedVoice: false, violationsFor });
  assertEquals(r.blocked, true);
  assertEquals(r.violations.length, 1);
});

Deno.test("textos nao-string/vazios sao ignorados sem quebrar", () => {
  const r = evaluateVoiceGate({ texts: [null, undefined, 42 as unknown as string, "  ", "zapx"], gate: "block", confirmedVoice: false, violationsFor });
  assertEquals(r.blocked, true);
  assertEquals(r.violations.map((v) => v.id), ["zap"]);
});

Deno.test("gate desconhecido cai no default warn (fail-safe, nao bloqueia)", () => {
  const r = evaluateVoiceGate({ texts: ["zapx"], gate: "banana" as unknown as "warn", confirmedVoice: false, violationsFor });
  assertEquals(r.blocked, false);
  assertEquals(r.violations.map((v) => v.id), ["zap"]);
});
