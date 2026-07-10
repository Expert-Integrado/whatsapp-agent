// phone.ts — normalizacao de numero BR (9o digito) e decisao de match por telefone.
//
// Extraido do mcp-api/index.ts (auditoria de config 07/2026): o matcher de
// telefone ja mandou mensagem pro numero ERRADO (irreversivel) quando 2+ chats
// casavam com as variantes do numero e o ranking por boost (recencia/lid/grupo)
// "escolhia um". Regra endurecida: match ambiguo NUNCA se resolve sozinho —
// so os dois colapsos DETERMINISTICOS de mesmo-contato (espelho lid e par
// real+fantasma do 9o digito) escolhem; qualquer outro caso devolve candidates
// pro agente pedir desambiguacao ao usuario.

/**
 * Gera as variantes equivalentes de um numero BR (com/sem 9o digito, com/sem DDI 55).
 * Cobre os dois sentidos: 13 digitos 55+DDD+9xxxx -> variante sem o 9;
 * 12 digitos 55+DDD+xxxx -> variante com o 9; numero local (10/11 digitos sem 55)
 * ganha as variantes com DDI. O proprio input sempre esta no conjunto.
 */
export function normalizePhoneBR(digits: string): string[] {
  const out = new Set<string>();
  if (!digits) return [];
  out.add(digits);
  const flipNine = (d: string) => {
    if (d.length === 13 && d.startsWith("55") && d[4] === "9") out.add(d.slice(0, 4) + d.slice(5));
    else if (d.length === 12 && d.startsWith("55")) out.add(d.slice(0, 4) + "9" + d.slice(4));
  };
  flipNine(digits);
  if (!digits.startsWith("55") && (digits.length === 10 || digits.length === 11)) {
    const with55 = "55" + digits; out.add(with55); flipNine(with55);
  }
  return Array.from(out);
}

/** Expande variantes de telefone pros formatos de chat_id usados pelos providers. */
export function expandChatIdCandidates(phoneVariants: string[]): string[] {
  const suffixes = ["", "@s.whatsapp.net", "@c.us", "@lid", "-group", "@g.us"];
  const out = new Set<string>();
  for (const v of phoneVariants) for (const s of suffixes) out.add(v + s);
  return Array.from(out);
}

export interface PhoneChatRow {
  instance_id: string;
  chat_id: string;
  chat_name: string | null;
  contact_name: string | null;
  is_group?: boolean;
  last_message_at?: string | null;
}

export type PhonePick =
  | { chat: PhoneChatRow }
  | { candidates: PhoneChatRow[] }
  | null;

/**
 * Decide o chat alvo entre as linhas que casaram EXATAMENTE com as variantes
 * do numero. Retorna:
 * - null            -> nenhum match (caller segue pro fallback de prefixo/nome)
 * - { chat }        -> match unico OU colapso deterministico de mesmo-contato
 * - { candidates }  -> AMBIGUO: o caller DEVE devolver a lista e pedir
 *                      desambiguacao — nunca escolher por score/recencia.
 *
 * Colapsos deterministicos (unicos casos em que 2+ linhas viram 1 escolha):
 * 1. Espelho lid: 1 chat numerico (variante do numero digitado) + N chats @lid
 *    do mesmo numero -> envio vai pro numerico (o lid e espelho tecnico).
 * 2. Par real + fantasma do 9o digito: 2 chats numericos na MESMA instancia,
 *    um variante do outro, onde so UM tem identidade (nome != proprio numero)
 *    -> o real vence (o fantasma nao pode vencer por recencia, porque envios
 *    engolidos renovam o last_message_at dele).
 */
export function pickPhoneChat(rows: PhoneChatRow[], phoneVariants: string[]): PhonePick {
  if (!rows?.length) return null;
  if (rows.length === 1) return { chat: rows[0] };

  const numericos = rows.filter((c) => /^\d+$/.test(String(c.chat_id)));
  const lids = rows.filter((c) => String(c.chat_id).endsWith("@lid"));
  const onlyNumericAndLid = numericos.length + lids.length === rows.length;

  // Colapso 1: espelho lid do mesmo numero.
  if (numericos.length === 1 && lids.length >= 1 && onlyNumericAndLid) {
    const phoneCanonical = String(numericos[0].chat_id);
    if (phoneVariants.includes(phoneCanonical)) {
      return { chat: numericos[0] };
    }
  }

  // Colapso 2: par real + fantasma do 9o digito (mesma instancia, variantes
  // um do outro). Linhas @lid extras nao quebram o colapso (sao espelho).
  if (numericos.length === 2 && onlyNumericAndLid
      && numericos[0].instance_id === numericos[1].instance_id
      && normalizePhoneBR(String(numericos[0].chat_id)).includes(String(numericos[1].chat_id))) {
    const hasIdentity = (c: PhoneChatRow) => {
      const n = c.chat_name || c.contact_name;
      return !!n && n !== c.chat_id;
    };
    const [a, b] = numericos;
    const real = hasIdentity(a) && !hasIdentity(b) ? a : (hasIdentity(b) && !hasIdentity(a) ? b : null);
    if (real) return { chat: real };
  }

  // Qualquer outro caso (2 instancias, grupo com mesmo numero-base, par
  // fantasma sem identidade clara...) e AMBIGUO de verdade: devolve a lista.
  return { candidates: rows };
}
