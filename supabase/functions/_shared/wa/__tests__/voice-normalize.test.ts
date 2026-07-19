import { assertEquals } from "jsr:@std/assert@1";
import { normalizeForVoiceCheck } from "../voice-normalize.ts";

// Regras reais que os bypasses tentam furar (copia dos patterns do gate/hook).
const EM_DASH = /—/;
const SAUDACAO = /(?:^|[\s,!?;:.])(ol[áa]|prezad[oa])(?=$|[\s,!?;:.])/iu;
// regra pessoal tipica do dono (checks.json): "zap" proibido
const ZAP = /\bzap\b/iu;

// Helper: a regra PEGA depois de normalizar?
const pega = (re: RegExp, raw: string) => re.test(normalizeForVoiceCheck(raw));

Deno.test("dash-fold: en-dash, horizontal-bar, minus, figure, 2/3-em, small-em viram em-dash e disparam a regra", () => {
  for (const cp of ["‒", "–", "―", "−", "⸺", "⸻", "﹘"]) {
    assertEquals(pega(EM_DASH, `fecho o contrato ${cp} amanha`), true, `codepoint U+${cp.codePointAt(0)!.toString(16)}`);
  }
});

Deno.test("dash-fold NAO toca hyphen-minus comum nem hifens curtos (sem falso-positivo)", () => {
  for (const cp of ["-", "‐", "‑"]) {
    assertEquals(pega(EM_DASH, `bem-vindo${cp}ok`), false, `codepoint U+${cp.codePointAt(0)!.toString(16)} nao deve virar em-dash`);
  }
  // em-dash de verdade continua pegando
  assertEquals(pega(EM_DASH, "texto — texto"), true);
});

Deno.test("zero-width: ZWSP/ZWNJ/ZWJ/word-joiner/BOM/soft-hyphen no meio da palavra vigiada nao escondem a violacao", () => {
  for (const zw of ["​", "‌", "‍", "⁠", "﻿", "­"]) {
    assertEquals(pega(ZAP, `me chama no za${zw}p depois`), true, `zero-width U+${zw.codePointAt(0)!.toString(16)}`);
  }
});

Deno.test("NFC: acento decomposto (a + combining acute) recompoe e a saudacao dispara", () => {
  const decomposto = "olá, tudo bem"; // "ola-agudo," escrito decomposto
  // sanidade: cru NAO pega (o combining quebra o lookahead)
  assertEquals(SAUDACAO.test(decomposto), false);
  // normalizado pega
  assertEquals(pega(SAUDACAO, decomposto), true);
});

Deno.test("texto limpo continua limpo (idempotente, sem falso-positivo)", () => {
  const limpo = "fechado, te mando no whats amanha de manha";
  assertEquals(normalizeForVoiceCheck(limpo), limpo);
  assertEquals(pega(ZAP, limpo), false);
  assertEquals(pega(EM_DASH, limpo), false);
});

Deno.test("entrada nao-string nao quebra", () => {
  assertEquals(normalizeForVoiceCheck(null as unknown as string), "");
  assertEquals(normalizeForVoiceCheck(undefined as unknown as string), "");
});
