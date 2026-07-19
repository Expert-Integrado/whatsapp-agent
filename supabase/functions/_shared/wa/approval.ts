// Aprovacao out-of-band do voice gate (0057): helpers PUROS da retencao.
// Um envio retido vira uma linha em voice_pending_approval + um card PRIVADO no
// Brain com links Aprovar/Recusar; o clique do dono (browser) bate no endpoint
// publico do mcp-api com o token secreto. O agente nunca ve o token — o banco
// guarda so o SHA-256 e o link mora no card privado do board.

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "failed";
export type ApprovalAction = "approve" | "reject";

export type ApprovalDecision =
  | { kind: "proceed"; to: "approved" | "rejected" }
  | { kind: "already"; status: ApprovalStatus }
  | { kind: "expired" }
  | { kind: "invalid" };

// Maquina de estados do clique: so linha 'pending' e nao-vencida prossegue;
// vencida vira expired; qualquer outro status = idempotente (2o clique informa).
export function approvalDecision(
  row: { status: string; expires_at: string },
  action: ApprovalAction,
  nowMs: number,
): ApprovalDecision {
  if (action !== "approve" && action !== "reject") return { kind: "invalid" };
  if (row.status !== "pending") return { kind: "already", status: row.status as ApprovalStatus };
  if (Date.parse(row.expires_at) <= nowMs) return { kind: "expired" };
  return { kind: "proceed", to: action === "approve" ? "approved" : "rejected" };
}

export function newApprovalToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Corpo (markdown) do card de aprovacao no Brain. Renderiza na pagina de detalhe
// da task (links clicaveis); o texto retido vai em blockquote, EXATO.
export function approvalCardMarkdown(input: {
  chatName: string;
  instance: string;
  tool: string;
  texts: string[];
  violations: { id: string; message: string }[];
  approveUrl: string;
  rejectUrl: string;
  expiresBrt: string;
}): string {
  const quoted = input.texts.map((t) => t.split("\n").map((l) => `> ${l}`).join("\n")).join("\n>\n> ---\n>\n");
  const viols = input.violations.map((v) => `- ${v.id}: ${v.message}`).join("\n");
  return [
    `Envio retido pelo voice gate (modo aprovação). Só sai com o seu clique.`,
    ``,
    `**Para:** ${input.chatName}`,
    `**Instância:** ${input.instance} · **Ferramenta:** ${input.tool}`,
    ``,
    `**Texto exato:**`,
    ``,
    quoted,
    ``,
    `**Violações detectadas:**`,
    viols,
    ``,
    `[APROVAR e enviar](${input.approveUrl}) · [RECUSAR](${input.rejectUrl})`,
    ``,
    `Válido até ${input.expiresBrt}. Depois disso o envio expira e nada sai.`,
  ].join("\n");
}
