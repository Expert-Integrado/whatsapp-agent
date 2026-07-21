// Credencial ESCOPADA por categoria — decisao PURA (testada em __tests__/scoped-key.test.ts).
// Uma segunda API key estatica (MCP_API_KEY_SCOPED) enxerga SO os chats de UMA categoria
// (MCP_SCOPED_CATEGORY): inbox/search ganham o filtro FORCADO no servidor, tools enderecadas
// a chat sao barradas fora da categoria, e conversa nova aberta pela propria key nasce
// categorizada. Filtro no prompt/skill nao basta — o enforcement tem que ser a API nao
// devolver. Sem os dois secrets definidos, nada muda pra ninguem.

// Tools globais sem conteudo de conversa: liberadas pra key escopada.
export const SCOPE_FREE = new Set([
  "ping", "status", "list_categories", "get_voice_guide", "check_message",
]);

// Familia de envio: as unicas que podem ABRIR conversa nova (que entao nasce na categoria).
export const SCOPE_SEND_NEW = new Set(["send", "send_voice", "send_image", "schedule"]);

// Tools enderecadas a um chat que a key escopada PODE usar (dentro da categoria).
// Fora desta lista e de SCOPE_FREE = bloqueada (zapi_action, sync_groups, merge_ghost_chats,
// setup_voice_guide, uncategorize, list_scheduled, cancel_scheduled, download_attachment...).
export const SCOPE_CHAT_TOOLS = new Set([
  "read", "resolve_chat", "resolve", "annotate", "categorize",
  "send", "send_voice", "send_image", "schedule",
  "react", "edit_message", "delete_message", "transcribe", "check_delivery",
]);

export type ScopeDecision =
  | { kind: "pass" }          // despacha como veio
  | { kind: "force_filter" }  // inbox/search: forca category_slugs=[categoria]
  | { kind: "blocked" }       // tool indisponivel pra credencial escopada
  | { kind: "deny" }          // chat existe mas esta fora da categoria
  | { kind: "adopt" }         // chat sem categoria e sem historico: categoriza e despacha
  | { kind: "send_new" };     // destino ainda sem chat: despacha (allow_new) e adota depois

export function decideScopedAction(input: {
  action: string;
  category: string;
  // null/undefined = chat nao resolvido (destino inexistente); [] = resolvido sem categoria
  chatCats?: string[] | null;
  // slugs pedidos quando action=categorize
  categorizeSlugs?: string[];
  // true = chat resolvido mas sem nenhuma mensagem (conversa que esta nascendo)
  semHistorico?: boolean;
}): ScopeDecision {
  const { action, category, chatCats, categorizeSlugs, semHistorico } = input;
  if (SCOPE_FREE.has(action)) return { kind: "pass" };
  if (action === "inbox" || action === "search") return { kind: "force_filter" };
  if (!SCOPE_CHAT_TOOLS.has(action)) return { kind: "blocked" };

  // destino sem chat: so a familia de envio segue (o case faz o allow_new e o chat nasce na categoria)
  if (chatCats == null) return SCOPE_SEND_NEW.has(action) ? { kind: "send_new" } : { kind: "deny" };

  if (chatCats.includes(category)) return { kind: "pass" };

  if (action === "categorize") {
    // escopada so categoriza NA propria categoria, e apenas chat ainda sem categoria alguma
    const ok = chatCats.length === 0 && categorizeSlugs?.length === 1 && categorizeSlugs[0] === category;
    return ok ? { kind: "pass" } : { kind: "deny" };
  }
  // conversa que o agente esta ABRINDO (sem categoria e sem historico) nasce na categoria;
  // chat sem categoria COM historico = conversa pre-existente do dono -> fora do escopo
  if (SCOPE_SEND_NEW.has(action) && chatCats.length === 0 && semHistorico) return { kind: "adopt" };
  return { kind: "deny" };
}
