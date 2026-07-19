// Feedback de dificuldade do voice gate (0058): quando o agente esta PATINANDO
// (varios bloqueios seguidos no mesmo chat), o dono que usa o Expert Brain ganha
// uma task de CORRECAO — revisar o voice guide / checks pra destravar o agente.
// Nao existe aprovacao de mensagem: o contrato do block e o agente corrigir o
// texto ate passar; a task e insumo de calibracao, nao um botao de liberar.

export const FEEDBACK_BLOCK_THRESHOLD = 3;

export function shouldOpenFeedbackTask(recentBlocks: number): boolean {
  return recentBlocks >= FEEDBACK_BLOCK_THRESHOLD;
}

// 1 task por instancia+chat+dia (dedupe_key do save_task segura duplicata).
export function feedbackDedupeKey(instanceId: string, chatRef: string, dayIso: string): string {
  return `voice-feedback-${instanceId}-${chatRef}-${dayIso}`.slice(0, 120);
}

export function voiceFeedbackMarkdown(input: {
  chatRef: string;
  instance: string;
  blocks: { tool: string; rule_ids: string[]; text_preview: string | null }[];
}): string {
  const counts = new Map<string, number>();
  for (const b of input.blocks) for (const r of b.rule_ids) counts.set(r, (counts.get(r) ?? 0) + 1);
  const rules = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => `- ${r} (${n}x)`).join("\n");
  const examples = input.blocks.slice(-3).map((b) => `> [${b.tool}] ${b.text_preview ?? "(sem preview)"}`).join("\n>\n");
  return [
    `O agente travou ${input.blocks.length}x seguidas no voice gate tentando escrever pra **${input.chatRef}** (instância ${input.instance}) — ele corrige e tenta de novo, mas está patinando nas mesmas regras.`,
    ``,
    `**Regras que estão barrando:**`,
    rules,
    ``,
    `**Últimas tentativas barradas:**`,
    examples,
    ``,
    `**O que fazer com esta task:** revisar se essas regras do voice guide estão calibradas — regra certa mas agente escrevendo errado (ajustar exemplos/instruções do guide) ou regra dura demais / falso positivo (ajustar o padrão no checks.json). A correção vira melhoria permanente do agente.`,
  ].join("\n");
}
