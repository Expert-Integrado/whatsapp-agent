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

// bypassed = trilha de auditoria (log silencioso): envio que SO passou porque o
// caller trouxe confirmed_voice:true num gate block com violacao high.
Deno.test("bypassed: block + confirmed_voice + violacao high marca o bypass", () => {
  const r = evaluateVoiceGate({ texts: ["me chama no zapx"], gate: "block", confirmedVoice: true, violationsFor });
  assertEquals(r.blocked, false);
  assertEquals(r.bypassed, true);
});

Deno.test("bypassed: confirmed_voice em texto limpo NAO e bypass", () => {
  const r = evaluateVoiceGate({ texts: ["beleza, seguimos"], gate: "block", confirmedVoice: true, violationsFor });
  assertEquals(r.bypassed, false);
});

Deno.test("bypassed: gate warn com violacao high NAO e bypass (nada seria barrado)", () => {
  const r = evaluateVoiceGate({ texts: ["zapx"], gate: "warn", confirmedVoice: true, violationsFor });
  assertEquals(r.bypassed, false);
});

Deno.test("bypassed: bloqueio real (sem confirmed_voice) NAO e bypass", () => {
  const r = evaluateVoiceGate({ texts: ["zapx"], gate: "block", confirmedVoice: false, violationsFor });
  assertEquals(r.blocked, true);
  assertEquals(r.bypassed, false);
});

// modo 'approval' (out-of-band): violacao high RETEM o envio pra aprovacao do dono
// no board — confirmed_voice NAO bypassa (a flag cooperativa e exatamente o gap).
Deno.test("approval: violacao high sem confirmed_voice retem (retain, nao block)", () => {
  const r = evaluateVoiceGate({ texts: ["me chama no zapx"], gate: "approval", confirmedVoice: false, violationsFor });
  assertEquals(r.retain, true);
  assertEquals(r.blocked, false);
  assertEquals(r.violations.map((v) => v.id), ["zap"]);
});

Deno.test("approval: confirmed_voice NAO bypassa — retem do mesmo jeito", () => {
  const r = evaluateVoiceGate({ texts: ["me chama no zapx"], gate: "approval", confirmedVoice: true, violationsFor });
  assertEquals(r.retain, true);
  assertEquals(r.blocked, false);
  assertEquals(r.bypassed, false);
});

Deno.test("approval: texto limpo passa sem retencao", () => {
  const r = evaluateVoiceGate({ texts: ["beleza, seguimos"], gate: "approval", confirmedVoice: false, violationsFor });
  assertEquals(r.retain, false);
  assertEquals(r.blocked, false);
});

Deno.test("approval: violacao medium nao retem", () => {
  const r = evaluateVoiceGate({ texts: ["blzx, seguimos"], gate: "approval", confirmedVoice: false, violationsFor });
  assertEquals(r.retain, false);
});

Deno.test("retain e false nos modos off/warn/block (sem request_approval)", () => {
  for (const gate of ["off", "warn", "block"] as const) {
    const r = evaluateVoiceGate({ texts: ["zapx"], gate, confirmedVoice: false, violationsFor });
    assertEquals(r.retain, false, gate);
  }
});

// Fluxo PONTUAL (decisao do dono 19/07): em block, o padrao e o agente corrigir o
// texto e reenviar; request_approval retem pro card SO quando o texto precisa
// sair exatamente como esta e o dono vai decidir pelo board.
Deno.test("block + request_approval + violacao high: retem (nao bloqueia, nao bypassa)", () => {
  const r = evaluateVoiceGate({ texts: ["zapx"], gate: "block", confirmedVoice: false, requestApproval: true, violationsFor });
  assertEquals(r.retain, true);
  assertEquals(r.blocked, false);
  assertEquals(r.bypassed, false);
});

Deno.test("block + request_approval em texto limpo: envia normal, sem retencao", () => {
  const r = evaluateVoiceGate({ texts: ["beleza, seguimos"], gate: "block", confirmedVoice: false, requestApproval: true, violationsFor });
  assertEquals(r.retain, false);
  assertEquals(r.blocked, false);
});

Deno.test("warn/off ignoram request_approval (nada seria barrado)", () => {
  for (const gate of ["off", "warn"] as const) {
    const r = evaluateVoiceGate({ texts: ["zapx"], gate, confirmedVoice: false, requestApproval: true, violationsFor });
    assertEquals(r.retain, false, gate);
  }
});

Deno.test("block + request_approval + confirmed_voice juntos: retencao vence (card decide)", () => {
  const r = evaluateVoiceGate({ texts: ["zapx"], gate: "block", confirmedVoice: true, requestApproval: true, violationsFor });
  assertEquals(r.retain, true);
  assertEquals(r.bypassed, false);
});

Deno.test("gate desconhecido cai no default warn (fail-safe, nao bloqueia)", () => {
  const r = evaluateVoiceGate({ texts: ["zapx"], gate: "banana" as unknown as "warn", confirmedVoice: false, violationsFor });
  assertEquals(r.blocked, false);
  assertEquals(r.violations.map((v) => v.id), ["zap"]);
});
