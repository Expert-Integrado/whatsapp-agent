// deno test supabase/functions/_shared/humanize.test.ts
// Regressao do comportamento aprovado nos audios de 12/07 + calibragem dos
// defeitos apontados pelo dono (prazê, fizê sentido, pra a sua, ajudá cê).
// Nao entra no bundle das functions (nenhuma importa este arquivo).

import { assertEquals } from "jsr:@std/assert";
import { humanize } from "./humanize.ts";

Deno.test("nenhum: texto intacto", () => {
  assertEquals(humanize("Vou implementar isso para você, está bem?", "nenhum"),
    "Vou implementar isso para você, está bem?");
});

Deno.test("leve: R-drop em infinitivo longo (aprovado 12/07)", () => {
  assertEquals(humanize("vou implementar amanhã", "leve"), "vou implementá amanhã");
  assertEquals(humanize("posso qualificar e responder depois", "leve"), "posso qualificá e respondê depois");
  assertEquals(humanize("IMPLEMENTAR", "leve"), "IMPLEMENTÁ");
});

Deno.test("leve: substantivo em -er nao dropa (defeito 1: um prazê)", () => {
  assertEquals(humanize("foi um prazer falar com o time", "leve"), "foi um prazer falá com o time");
  assertEquals(humanize("muito prazer", "leve"), "muito prazer");
});

Deno.test("leve: determinante protege substantivo do drop", () => {
  assertEquals(humanize("depois do jantar a gente conversa", "leve"), "depois do jantar a gente conversa");
  assertEquals(humanize("vamos jantar juntos", "leve"), "vamos jantá juntos");
});

Deno.test("leve: futuro do subjuntivo irregular intacto (defeito 2: se fizê)", () => {
  assertEquals(humanize("Se fizer sentido, a gente avança", "leve"), "Se fizer sentido, a gente avança");
  assertEquals(humanize("se quiser eu te mostro", "leve"), "se quiser eu te mostro");
  assertEquals(humanize("quando puder me avisa", "leve"), "quando puder me avisa");
  // regular = identico ao infinitivo, segue dropando (fala oral aceita)
  assertEquals(humanize("se precisar me chama", "leve"), "se precisá me chama");
});

Deno.test("leve: para + artigo colapsa (defeito 3: pra a sua)", () => {
  assertEquals(humanize("para a sua equipe", "leve"), "pra sua equipe");
  assertEquals(humanize("para o time comercial", "leve"), "pro time comercial");
  assertEquals(humanize("para os leads novos", "leve"), "pros leads novos");
  assertEquals(humanize("para as empresas", "leve"), "pras empresas");
  assertEquals(humanize("Para a proposta", "leve"), "Pra proposta");
  assertEquals(humanize("para você", "leve"), "pra você");
});

Deno.test("leve: nao contrai está/estou", () => {
  assertEquals(humanize("está tudo certo", "leve"), "está tudo certo");
});

Deno.test("forte: contracoes orais (aprovado 12/07)", () => {
  assertEquals(humanize("está tudo bem, estou por aqui", "forte"), "tá tudo bem, tô por aqui");
  assertEquals(humanize("Estamos juntos", "forte"), "Tamo juntos");
});

Deno.test("forte: você -> cê fora de protecao (aprovado 12/07)", () => {
  assertEquals(humanize("você viu isso?", "forte"), "cê viu isso?");
  assertEquals(humanize("Você pode responder depois", "forte"), "Cê pode respondê depois");
});

Deno.test("forte: você protegido apos preposicao (aprovado 12/07)", () => {
  assertEquals(humanize("falo com você amanhã", "forte"), "falo com você amanhã");
  assertEquals(humanize("isso é para você", "forte"), "isso é pra você");
});

Deno.test("forte: você protegido apos verbo (defeito 4: ajudá cê)", () => {
  assertEquals(humanize("quero ajudar você nisso", "forte"), "quero ajudá você nisso");
  assertEquals(humanize("vou ver você lá", "forte"), "vou ver você lá");
});
