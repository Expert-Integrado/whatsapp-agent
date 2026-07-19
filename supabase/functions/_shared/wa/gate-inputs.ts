// Entradas do voice gate extraidas pra funcoes puras testaveis (achado F1 da
// verificacao cirurgica 18/07): a fiacao do gate no mcp-api nao tem harness — o
// que pode regredir em silencio e exatamente ISTO (quais campos de texto entram
// no gate e qual instancia resolve o modo quando o caller omite 'instance').
// Mudou a lista de campos ou a precedencia? O teste gate-inputs.test.ts acusa.

// Actions do zapi_action que carregam conteudo pra fora — todas passam pelo gate
// e pela confirmacao. send-image/video/document entram (revisao 19/07): o wa-proxy
// as allowlista pra edicao, mas nada impede um envio FRESCO com caption livre —
// sem elas aqui, esse caminho saia sem confirmacao e sem gate. create-group entra
// pelo mesmo motivo (censo 19/07): o groupName e texto visivel aos participantes.
export const ZAPI_SEND_ACTIONS = new Set([
  "send-poll", "forward-message", "forward", "edit-message", "send-text", "send-message",
  "send-image", "send-video", "send-document", "create-group",
]);

// Campos de texto livre que uma action de envio da Z-API pode carregar. Inclui o
// nome de documento (fileName/file_name — rotulo VISIVEL do arquivo na bolha), os
// rotulos de enquete no shape nativo Z-API (poll:[{name}], diferente do options
// plano) e o assunto de grupo (groupName) — todos texto-que-sai (censo 19/07).
export function zapiGateTexts(zparams: unknown): (string | null | undefined)[] {
  if (!zparams || typeof zparams !== "object") return [];
  const p = zparams as Record<string, unknown>;
  return [
    p.message as string | undefined,
    p.body as string | undefined,
    p.text as string | undefined,
    p.caption as string | undefined,
    p.fileName as string | undefined,
    p.file_name as string | undefined,
    p.groupName as string | undefined,
    ...(Array.isArray(p.options) ? (p.options as string[]) : []),
    ...(Array.isArray(p.poll) ? (p.poll as any[]).map((o) => o?.name) : []),
  ];
}

// Textos de uma sequencia agendada: content (texto/legenda/TTS), question, options
// (poll), title/description do card de link e file_name de documento (rotulo visivel).
export function scheduleGateTexts(items: unknown): (string | null | undefined)[] {
  if (!Array.isArray(items)) return [];
  return items.flatMap((it: any) => [
    it?.content,
    it?.question,
    it?.link?.title,
    it?.link?.description,
    it?.file_name,
    ...(Array.isArray(it?.options) ? it.options : []),
  ]);
}

// Precedencia da instancia cujo voice_gate governa a chamada: chave ja resolvida
// pelo caller > instancia default > primeira registrada > null (gate cai no 'warn').
export function defaultGateInstance(rows: any[], resolvedKey: string | null): string | null {
  return resolvedKey ?? rows.find((r: any) => r?.is_default)?.instance_id ?? rows[0]?.instance_id ?? null;
}
