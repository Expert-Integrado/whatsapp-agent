import { assertEquals } from "jsr:@std/assert@1";
import { ZAPI_SEND_ACTIONS, zapiGateTexts, scheduleGateTexts, defaultGateInstance } from "../gate-inputs.ts";

Deno.test("ZAPI_SEND_ACTIONS cobre as 6 actions de envio", () => {
  for (const a of ["send-poll", "forward-message", "forward", "edit-message", "send-text", "send-message"]) {
    assertEquals(ZAPI_SEND_ACTIONS.has(a), true, a);
  }
  assertEquals(ZAPI_SEND_ACTIONS.has("get-chats"), false);
});

Deno.test("zapiGateTexts: coleta os campos de texto-que-sai, ignora o resto", () => {
  const texts = zapiGateTexts({ phone: "5511", message: "m", body: "b", text: "t", caption: "c", options: ["o1", "o2"] });
  assertEquals(texts.filter((t) => typeof t === "string"), ["m", "b", "t", "c", "o1", "o2"]);
});

Deno.test("zapiGateTexts: campos ausentes viram undefined (o gate filtra), options nao-array ignorado", () => {
  const texts = zapiGateTexts({ phone: "5511", message: "so isto", options: "nao-e-array" });
  assertEquals(texts.filter((t) => typeof t === "string"), ["so isto"]);
});

Deno.test("zapiGateTexts: zparams nulo/nao-objeto retorna vazio sem quebrar", () => {
  assertEquals(zapiGateTexts(null), []);
  assertEquals(zapiGateTexts(undefined), []);
  assertEquals(zapiGateTexts("string" as unknown as object), []);
});

Deno.test("scheduleGateTexts: coleta content/question/options de cada item", () => {
  const texts = scheduleGateTexts([
    { type: "text", content: "a" },
    { type: "poll", question: "q", options: ["x", "y"] },
    { type: "image", media_url: "http://..." },
  ]);
  assertEquals(texts.filter((t) => typeof t === "string"), ["a", "q", "x", "y"]);
});

Deno.test("scheduleGateTexts: items nao-array/itens nulos nao quebram", () => {
  assertEquals(scheduleGateTexts(null as unknown as []), []);
  assertEquals(scheduleGateTexts([null, undefined] as unknown as []).filter((t) => typeof t === "string"), []);
});

Deno.test("defaultGateInstance: chave resolvida vence; senao is_default; senao primeira; senao null", () => {
  const rows = [{ instance_id: "A" }, { instance_id: "B", is_default: true }];
  assertEquals(defaultGateInstance(rows, "X"), "X");
  assertEquals(defaultGateInstance(rows, null), "B");
  assertEquals(defaultGateInstance([{ instance_id: "A" }], null), "A");
  assertEquals(defaultGateInstance([], null), null);
});

// Revisao 19/07: envio FRESCO de midia via zapi_action tem caption livre — sem
// estas actions no set, saia sem confirmacao e sem gate (o wa-proxy allowlista
// as tres e nada exige o campo edit*MessageId).
Deno.test("ZAPI_SEND_ACTIONS: send-image/send-video/send-document passam pelo gate", () => {
  for (const a of ["send-image", "send-video", "send-document"]) {
    assertEquals(ZAPI_SEND_ACTIONS.has(a), true, a);
  }
});

Deno.test("scheduleGateTexts: link.title e link.description entram no gate", () => {
  const texts = scheduleGateTexts([
    { type: "text", content: "limpo", link: { url: "https://x", title: "me chama no zapx", description: "desc" } },
  ]);
  assertEquals(texts.filter((t) => typeof t === "string"), ["limpo", "me chama no zapx", "desc"]);
});

// Censo 19/07: furos de texto-que-sai que escapavam do gate.
Deno.test("zapiGateTexts: fileName/file_name de documento entram no gate", () => {
  const a = zapiGateTexts({ caption: "segue", fileName: "Ola-proposta.pdf" });
  const b = zapiGateTexts({ caption: "segue", file_name: "corre-que-e-so-hoje.pdf" });
  assertEquals(a.includes("Ola-proposta.pdf"), true);
  assertEquals(b.includes("corre-que-e-so-hoje.pdf"), true);
});

Deno.test("zapiGateTexts: opcoes de enquete no shape nativo Z-API (poll:[{name}]) entram no gate", () => {
  const texts = zapiGateTexts({ message: "Escolhe", poll: [{ name: "corre que e so hoje" }, { name: "opcao b" }] });
  assertEquals(texts.includes("corre que e so hoje"), true);
  assertEquals(texts.includes("opcao b"), true);
});

Deno.test("zapiGateTexts: groupName (assunto de grupo) entra no gate", () => {
  assertEquals(zapiGateTexts({ groupName: "Ola pessoal" }).includes("Ola pessoal"), true);
});

Deno.test("ZAPI_SEND_ACTIONS: create-group passa pelo gate/confirmacao", () => {
  assertEquals(ZAPI_SEND_ACTIONS.has("create-group"), true);
});

Deno.test("scheduleGateTexts: file_name de documento agendado entra no gate", () => {
  const texts = scheduleGateTexts([{ type: "document", media_url: "http://x", file_name: "Ola-doc.pdf" }]);
  assertEquals(texts.includes("Ola-doc.pdf"), true);
});
