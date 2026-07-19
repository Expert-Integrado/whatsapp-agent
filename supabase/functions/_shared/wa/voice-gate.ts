// Voice gate server-side (0055): decisao pura de bloquear/avisar envio que viola
// regra HARD do voice guide. Existe porque superficies sem hook local (claude.ai
// celular/Desktop/Web) chegam direto na edge — o gate e a ultima linha.
//
// Modos (wa_instance.voice_gate): 'off' ignora; 'warn' (default) anexa warnings
// sem barrar; 'block' recusa violacao severity=high a menos que confirmed_voice
// (aprovacao explicita do dono no chat); 'approval' (0057, out-of-band) RETEM o
// envio pra aprovacao do dono via card no Brain — confirmed_voice NAO bypassa,
// porque a flag cooperativa (setada pelo mesmo agente que redige) e exatamente o
// gap que o modo fecha. So severity=high entra no gate — medium/low seguem como
// feedback do check_message, nunca barram envio.

export type VoiceViolation = { id: string; severity: string; message: string; match?: string };
export type VoiceGateMode = "off" | "warn" | "block" | "approval";

export function evaluateVoiceGate(input: {
  texts: (string | null | undefined)[];
  gate: VoiceGateMode;
  confirmedVoice: boolean;
  violationsFor: (text: string) => VoiceViolation[];
}): { blocked: boolean; violations: VoiceViolation[]; bypassed: boolean; retain: boolean } {
  const { texts, gate, confirmedVoice, violationsFor } = input;
  if (gate === "off") return { blocked: false, violations: [], bypassed: false, retain: false };
  const strings = texts.filter((t): t is string => typeof t === "string" && t.trim().length > 0);
  const seen = new Set<string>();
  const violations: VoiceViolation[] = [];
  for (const t of strings) {
    for (const v of violationsFor(t)) {
      if (v.severity === "high" && !seen.has(v.id)) { seen.add(v.id); violations.push(v); }
    }
  }
  const blocked = gate === "block" && violations.length > 0 && !confirmedVoice;
  // bypassed = envio que SO passou porque o caller trouxe confirmed_voice num gate
  // block com violacao high — e o evento que a trilha de auditoria registra.
  const bypassed = gate === "block" && violations.length > 0 && confirmedVoice;
  // retain = modo approval com violacao high: reter pra aprovacao out-of-band.
  const retain = gate === "approval" && violations.length > 0;
  return { blocked, violations, bypassed, retain };
}
