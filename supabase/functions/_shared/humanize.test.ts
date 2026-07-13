// deno test supabase/functions/_shared/humanize.test.ts
// Regressao do comportamento aprovado nos audios de 12/07 + calibragem v2
// (auditoria adversarial de 436 casos, 158 defeitos confirmados/plausiveis).
// Nao entra no bundle das functions (nenhuma importa este arquivo).

import { assertEquals } from "jsr:@std/assert";
import { humanize } from "./humanize.ts";

Deno.test("nenhum: texto intacto", () => {
  assertEquals(humanize("Vou implementar isso para você, está bem?", "nenhum"),
    "Vou implementar isso para você, está bem?");
});

Deno.test("leve: R-drop em infinitivo legitimo (aprovado 12/07)", () => {
  assertEquals(humanize("vou implementar amanhã", "leve"), "vou implementá amanhã");
  assertEquals(humanize("posso qualificar e responder depois", "leve"), "posso qualificá e respondê depois");
  assertEquals(humanize("queria te mostrar como automatizar o atendimento", "leve"),
    "queria te mostrá como automatizá o atendimento");
});

Deno.test("leve: maiuscula nunca dropa (nomes, siglas, enfase)", () => {
  assertEquals(humanize("falei com Valdir ontem", "leve"), "falei com Valdir ontem");
  assertEquals(humanize("Oscar vai apresentar a proposta", "leve"), "Oscar vai apresentá a proposta");
  assertEquals(humanize("Wagner e Kleber são sócios", "leve"), "Wagner e Kleber são sócios");
  assertEquals(humanize("a Somar Contabilidade abriu duas unidades", "leve"), "a Somar Contabilidade abriu duas unidades");
  assertEquals(humanize("clica no botão SALVAR para confirmar", "leve"), "clica no botão SALVAR pra confirmá");
  assertEquals(humanize("assina o plano MASTER até sexta", "leve"), "assina o plano MASTER até sexta");
});

Deno.test("leve: acento grafico nunca dropa (paroxitonas)", () => {
  assertEquals(humanize("sua empresa é líder no segmento", "leve"), "sua empresa é líder no segmento");
  assertEquals(humanize("é um ajuste de caráter técnico", "leve"), "é um ajuste de caráter técnico");
  assertEquals(humanize("vai pagar em dólar dessa vez", "leve"), "vai pagá em dólar dessa vez");
  assertEquals(humanize("conversei com a repórter ontem", "leve"), "conversei com a repórter ontem");
  assertEquals(humanize("quero comer hambúrguer hoje", "leve"), "quero comê hambúrguer hoje");
});

Deno.test("leve: grafia estrangeira nunca dropa (k/w/y, dobradas, th/ck/sh)", () => {
  assertEquals(humanize("sobe docker na VPS antes do deploy", "leve"), "sobe docker na VPS antes do deploy");
  assertEquals(humanize("mandei a newsletter pra base inteira", "leve"), "mandei a newsletter pra base inteira");
  assertEquals(humanize("sobe banner novo no site", "leve"), "sobe banner novo no site");
  assertEquals(humanize("vou fazer webinar amanhã às 19h", "leve"), "vou fazê webinar amanhã às 19h");
  assertEquals(humanize("tem player novo entrando no mercado", "leve"), "tem player novo entrando no mercado");
});

Deno.test("leve: estrangeirismos da lista (sem sinal grafico)", () => {
  assertEquals(humanize("sou designer há dez anos", "leve"), "sou designer há dez anos");
  assertEquals(humanize("virei influencer de tecnologia", "leve"), "virei influencer de tecnologia");
  assertEquals(humanize("problema de server de novo", "leve"), "problema de server de novo");
  assertEquals(humanize("reinicia container na VPS", "leve"), "reinicia container na VPS");
  assertEquals(humanize("te mando voucher de 10%", "leve"), "te mando voucher de 10%");
  assertEquals(humanize("nosso call center reduziu 40% do volume", "leve"), "nosso call center reduziu 40% do volume");
});

Deno.test("leve: oxitonas nominais da lista", () => {
  assertEquals(humanize("comprei celular novo essa semana", "leve"), "comprei celular novo essa semana");
  assertEquals(humanize("tempo de lazer é importante", "leve"), "tempo de lazê é importante".replace("lazê", "lazer"));
  assertEquals(humanize("tomei multa de radar na marginal", "leve"), "tomei multa de radá na marginal".replace("radá", "radar"));
  assertEquals(humanize("situação irregular no cadastro", "leve"), "situação irregular no cadastro");
  assertEquals(humanize("achei produto similar por metade do preço", "leve"), "achei produto similar por metade do preço");
  assertEquals(humanize("instalei energia solar em casa", "leve"), "instalei energia solar em casa");
  assertEquals(humanize("ficou SUPER bom e super rápido", "leve"), "ficou SUPER bom e super rápido");
});

Deno.test("leve: substantivo protegido por determinante (+ adjetivo/ordinal)", () => {
  assertEquals(humanize("foi um prazer falar com o time", "leve"), "foi um prazer falá com o time");
  assertEquals(humanize("depois do jantar a gente conversa", "leve"), "depois do jantar a gente conversa");
  assertEquals(humanize("vamos jantar juntos", "leve"), "vamos jantá juntos");
  assertEquals(humanize("a sala fica no terceiro andar do prédio", "leve"), "a sala fica no terceiro andar do prédio");
  assertEquals(humanize("fechamos num jantar de negócios na sexta", "leve"), "fechamos num jantar de negócios na sexta");
  assertEquals(humanize("chegamos em outro patamar de receita", "leve"), "chegamos em outro patamar de receita");
});

Deno.test("leve: futuro do subjuntivo por morfologia (inclui compostos)", () => {
  assertEquals(humanize("Se fizer sentido, a gente avança", "leve"), "Se fizer sentido, a gente avança");
  assertEquals(humanize("se quiser eu te mostro", "leve"), "se quiser eu te mostro");
  assertEquals(humanize("quando puder me avisa", "leve"), "quando puder me avisa");
  assertEquals(humanize("se eu puser tudo no papel hoje", "leve"), "se eu puser tudo no papel hoje");
  assertEquals(humanize("se ele repuser o estoque até sexta", "leve"), "se ele repuser o estoque até sexta");
  assertEquals(humanize("se ele pressupuser que o preço é fixo", "leve"), "se ele pressupuser que o preço é fixo");
  assertEquals(humanize("se não convier pra vocês, a gente remarca", "leve"), "se não convier pra vocês, a gente remarca");
  assertEquals(humanize("se sobrevier qualquer problema, o suporte resolve", "leve"),
    "se sobrevier qualquer problema, o suporte resolve");
  // regular = identico ao infinitivo, segue dropando (fala oral aceita)
  assertEquals(humanize("se precisar me chama", "leve"), "se precisá me chama");
});

Deno.test("leve: para preposicao converte, verbo PARAR fica", () => {
  assertEquals(humanize("para a sua equipe", "leve"), "pra sua equipe");
  assertEquals(humanize("para o time comercial", "leve"), "pro time comercial");
  assertEquals(humanize("para os leads novos", "leve"), "pros leads novos");
  assertEquals(humanize("para as empresas", "leve"), "pras empresas");
  assertEquals(humanize("enviei o convite PARA A EQUIPE TODA", "leve"), "enviei o convite PRA EQUIPE TODA");
  assertEquals(humanize("isso é para você", "leve"), "isso é pra você");
  // verbo parar: negacao antes, "de/com/na", pontuacao ou fim depois
  assertEquals(humanize("esse mercado não para de crescer", "leve"), "esse mercado não para de crescê");
  assertEquals(humanize("para de me enrolar e me manda o contrato", "leve"), "para de me enrolá e me manda o contrato");
  assertEquals(humanize("esse cara nunca para", "leve"), "esse cara nunca para");
  assertEquals(humanize("a esteira não para, roda 24 horas", "leve"), "a esteira não para, roda 24 horas");
  assertEquals(humanize("tudo para na sexta depois das seis", "leve"), "tudo para na sexta depois das seis");
  assertEquals(humanize("quem para, perde espaço pro concorrente", "leve"), "quem para, perde espaço pro concorrente");
  assertEquals(humanize("para com isso, não precisa se desculpar", "leve"), "para com isso, não precisa se desculpá");
  // hifen: compostos ficam intactos
  assertEquals(humanize("fiz um de-para dos campos do CRM", "leve"), "fiz um de-para dos campos do CRM");
  assertEquals(humanize("o para-brisa trincou no estacionamento", "leve"), "o para-brisa trincou no estacionamento");
  // demonstrativo nao colapsa
  assertEquals(humanize("passa o caso para a do jurídico", "leve"), "passa o caso pra a do jurídico");
});

Deno.test("leve: compostos com hifen nao dropam", () => {
  assertEquals(humanize("o bem-estar da equipe é prioridade", "leve"), "o bem-estar da equipe é prioridade");
  assertEquals(humanize("senti um mal-estar depois do almoço", "leve"), "senti um mal-estar depois do almoço");
});

Deno.test("leve: locucao a partir de", () => {
  assertEquals(humanize("a promoção vale a partir de segunda", "leve"), "a promoção vale a partir de segunda");
});

Deno.test("leve: nao contrai está/estou", () => {
  assertEquals(humanize("está tudo certo", "leve"), "está tudo certo");
});

Deno.test("forte: contracoes orais (aprovado 12/07 + estão)", () => {
  assertEquals(humanize("está tudo bem, estou por aqui", "forte"), "tá tudo bem, tô por aqui");
  assertEquals(humanize("Estamos juntos", "forte"), "Tamo juntos");
  assertEquals(humanize("os leads estão entrando certinho", "forte"), "os leads tão entrando certinho");
  assertEquals(humanize("esta empresa cresce muito", "forte"), "esta empresa cresce muito"); // determinante sem acento fica
  assertEquals(humanize("o bem-estar importa", "forte"), "o bem-estar importa"); // sem cascata bem-tá
});

Deno.test("forte: você -> cê so em posicao de sujeito", () => {
  assertEquals(humanize("você viu isso?", "forte"), "cê viu isso?");
  assertEquals(humanize("Você pode responder depois", "forte"), "Cê pode respondê depois");
  assertEquals(humanize("se você quiser a gente conversa", "forte"), "se cê quiser a gente conversa");
  assertEquals(humanize("aí você me fala o que achou", "forte"), "aí cê me fala o que achou");
  assertEquals(humanize("lá você decide com calma", "forte"), "lá cê decide com calma");
  assertEquals(humanize("e você viu o resultado?", "forte"), "e cê viu o resultado?");
});

Deno.test("forte: você intacto fora de posicao de sujeito", () => {
  assertEquals(humanize("falo com você amanhã", "forte"), "falo com você amanhã");
  assertEquals(humanize("isso é para você", "forte"), "isso é pra você");
  assertEquals(humanize("quero ajudar você nisso", "forte"), "quero ajudá você nisso");
  assertEquals(humanize("atendemos você em até 24 horas", "forte"), "atendemos você em até 24 horas");
  assertEquals(humanize("vi você ontem no evento", "forte"), "vi você ontem no evento");
  assertEquals(humanize("encontro você amanhã às 10", "forte"), "encontro você amanhã às 10");
  assertEquals(humanize("todo mundo topou, até você", "forte"), "todo mundo topou, até você");
  assertEquals(humanize("por aqui tudo certo, e você?", "forte"), "por aqui tudo certo, e você?");
  assertEquals(humanize("você, me escuta um segundo", "forte"), "você, me escuta um segundo");
  assertEquals(humanize("VOCÊ DECIDE O PRÓXIMO PASSO", "forte"), "VOCÊ DECIDE O PRÓXIMO PASSO");
});

Deno.test("forte: frase B2B completa (integracao)", () => {
  assertEquals(
    humanize("Oi Oscar, tudo bem? Vi que sua empresa está crescendo e queria te mostrar como automatizar o atendimento.", "forte"),
    "Oi Oscar, tudo bem? Vi que sua empresa tá crescendo e queria te mostrá como automatizá o atendimento.",
  );
  assertEquals(
    humanize("Se fizer sentido para você, o designer sobe o banner e a newsletter não para de rodar.", "forte"),
    "Se fizer sentido pra você, o designer sobe o banner e a newsletter não para de rodá.",
  );
});
