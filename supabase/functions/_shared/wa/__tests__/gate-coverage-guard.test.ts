import { assertEquals } from "jsr:@std/assert@1";
import { ZAPI_SEND_ACTIONS } from "../gate-inputs.ts";

// GUARD DE COBERTURA DO VOICE GATE (censo 19/07, item 1 do conselho de encerramento).
// Este teste NAO exercita comportamento — ele congela o INVENTARIO. Se uma tool nova
// ou uma action de envio nova aparecer no codigo sem passar pela classificacao, ele
// QUEBRA e obriga uma decisao consciente (gatear ou justificar por escrito), em vez
// de o texto novo escapar em silencio. Foi assim que 3 furos passaram despercebidos
// (send-image/video/document, link.title, poll[].name): cobertura sem trava congelada.

const ROOT = new URL("../../../", import.meta.url); // supabase/functions/
const read = (p: string) => Deno.readTextFileSync(new URL(p, ROOT));

// Toda tool declarada no mcp-api, classificada A MAO. Enviam texto -> DEVE gatear.
// Alterar esta lista e um ATO DELIBERADO: tool nova cai no assert de baixo ate ser
// classificada aqui.
const TOOL_CLASS: Record<string, "envio" | "interno" | "readonly"> = {
  status: "readonly", inbox: "readonly", resolve_chat: "interno", read: "readonly",
  send: "envio", send_voice: "envio", send_image: "envio", search: "readonly",
  transcribe_audio: "readonly", react: "envio", sync_groups: "interno",
  list_categories: "readonly", categorize_chat: "interno", uncategorize_chat: "interno",
  annotate_chat: "interno", edit_message: "envio", delete_message: "interno",
  download_attachment: "readonly", zapi_action: "envio", get_voice_guide: "readonly",
  check_message: "readonly", setup_voice_guide: "readonly", check_delivery: "readonly",
  merge_ghost_chats: "interno", schedule: "envio", list_scheduled: "readonly",
  cancel_scheduled: "readonly",
};

Deno.test("guard: o conjunto de tools do mcp-api == inventario classificado (tool nova quebra aqui)", () => {
  const src = read("mcp-api/index.ts");
  // captura os schemas de tool: linhas `    name: "<tool>",` (4 espacos = nivel da tool)
  const declared = new Set([...src.matchAll(/^    name: "([a-z_]+)",$/gm)].map((m) => m[1]));
  const classified = new Set(Object.keys(TOOL_CLASS));
  const semClasse = [...declared].filter((t) => !classified.has(t));
  const orfaos = [...classified].filter((t) => !declared.has(t));
  assertEquals(semClasse, [], `tool(s) nova(s) sem classificacao no guard: ${semClasse.join(", ")}`);
  assertEquals(orfaos, [], `tool(s) classificada(s) que sumiu(ram) do codigo: ${orfaos.join(", ")}`);
});

Deno.test("guard: toda action de envio da allowlist do wa-proxy que carrega texto esta em ZAPI_SEND_ACTIONS", () => {
  const src = read("wa-proxy/index.ts");
  // extrai o corpo do Set DESTRUCTIVE_SEND_ACTIONS
  const bloco = src.match(/DESTRUCTIVE_SEND_ACTIONS = new Set\(\[([\s\S]*?)\]\)/);
  assertEquals(!!bloco, true, "nao achei DESTRUCTIVE_SEND_ACTIONS no wa-proxy");
  const sendActions = [...bloco![1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
  // actions de envio que NAO carregam texto livre (so referencia/ids) — justificadas.
  const SEM_TEXTO = new Set(["forward", "forward-message"]);
  const faltando = sendActions.filter((a) => !SEM_TEXTO.has(a) && !ZAPI_SEND_ACTIONS.has(a));
  assertEquals(faltando, [], `action(s) de envio com texto fora do gate: ${faltando.join(", ")}`);
});

// create-group vive em DESTRUCTIVE_OTHER no wa-proxy mas carrega groupName (texto):
// travamos explicitamente que ela segue gateada (censo 19/07).
Deno.test("guard: create-group (groupName visivel) permanece em ZAPI_SEND_ACTIONS", () => {
  assertEquals(ZAPI_SEND_ACTIONS.has("create-group"), true);
});
