// humanize.ts — humanizador oral paulista para TTS (origem: porte do humanizar.py
// da skill pessoal:voz, absorvida pelo agente em 12/07/2026; calibragem v2 no mesmo
// dia apos auditoria adversarial de 436 casos com feedback do dono).
//
// Nivel por perfil (voice_profiles.humanize): forte | leve | nenhum.
//   leve  = R drop em infinitivos + para->pra (com colapso de artigo: pra sua, pro time)
//   forte = leve + contracoes orais (ta/to/tava/tamo/tao) + voce->ce (so em posicao
//           de sujeito: inicio de frase ou apos conjuncao da whitelist)
// wa_instance.humanize_enabled=false (0052) desliga tudo no send-voice.
//
// PRINCIPIOS do R-drop (em vez de lista infinita, regras linguisticas):
//   1. So palavra 100% minuscula dropa — maiuscula = nome proprio/sigla/enfase
//      (Oscar, Valdir, DETER, SALVAR, Docker ficam intactos; verbo capitalizado
//      em inicio de frase fica literal, custo aceitavel).
//   2. Palavra com QUALQUER acento grafico nunca dropa — infinitivo pt jamais
//      leva acento (mata líder, câncer, dólar, repórter, caráter, pôster, mártir).
//   3. Grafia estranha ao portugues nunca dropa — k/w/y, consoante dobrada
//      nao-pt (nn/tt/ff/pp/mm/bb/gg/dd/zz), th/ck/sh (docker, banner, newsletter).
//      Estrangeirismo sem sinal grafico vai pra lista NAO_DROPAR (designer, server).
//   4. Futuro do subjuntivo irregular protegido por MORFOLOGIA (sufixos), nao por
//      enumeracao — cobre compostos: repuser, pressupuser, entretiver, convier.
//   5. Determinante (+ adjetivo pre-nominal opcional) antes = substantivo, nao dropa
//      ("um prazer", "o jantar", "no terceiro andar").
//   Limitacoes conhecidas (documentadas, sem fix seguro): "ele para o carro" sem
//   negacao, substantivo nu ambiguo sem determinante ("sobrou jantar"), adjetivo
//   -ar fora da lista sem sinal grafico.
//
// JS \b nao é unicode-aware (ê/á nao sao \w) — usar lookarounds com classe propria.

export type HumanizeLevel = "forte" | "leve" | "nenhum";

// Classe de "caractere de palavra" unicode-aware pro portugues
const W = "A-Za-zÀ-ÖØ-öø-ÿ";

// Oxitonas nominais e estrangeirismos SEM sinal grafico que a heuristica de sufixo
// confundiria com infinitivo. (Paroxitonas acentuadas e grafias k/w/y/nn/tt/... ja
// caem nas regras estruturais — nao precisam estar aqui.)
const NAO_DROPAR: Record<string, Set<string>> = {
  ar: new Set(["lar", "mar", "par", "bar", "lugar", "azar", "altar", "pilar", "pomar",
    "patamar", "radar", "hangar", "placar", "webinar",
    // adjetivos denominais oxitonos em -ar (vem DEPOIS do substantivo — determinante nunca protege)
    "familiar", "militar", "particular", "regular", "irregular", "popular", "preliminar",
    "singular", "similar", "titular", "celular", "escolar", "solar", "lunar", "nuclear",
    "linear", "muscular", "vascular", "espetacular", "estelar", "vulgar", "peculiar",
    "exemplar", "ocular", "polar", "angular", "retangular", "triangular", "curricular",
    "circular", "auxiliar"]),
  er: new Set(["ser", "ter", "ver", "ler", "ker", "mer", "ber", "per", "qualquer",
    "poder", "valer", "mulher", "colher", "talher", "mister", "prazer", "lazer", "super",
    // estrangeirismos sem sinal grafico (k/w/y/dobrada), frequentes em mensagem de negocio
    "server", "trailer", "container", "influencer", "developer", "freelancer", "manager",
    "master", "cluster", "laser", "blazer", "freezer", "folder", "voucher", "center",
    "designer", "gangster", "poster", "gamer", "streamer", "trader", "tester", "partner",
    "premier", "reporter", "toner", "scooter", "mixer", "blender", "dealer", "leader",
    "driver", "spoiler", "cooler", "router"]),
  ir: new Set(["ir", "vir", "sair", "cair", "pair", "sorrir", "possuir", "elixir",
    "nadir", "faquir", "emir"]),
};

// Futuro do subjuntivo IRREGULAR por morfologia: estas terminacoes nunca sao
// infinitivo (fizer, repuser, pressupuser, entretiver, convier, prouver, trouxer,
// disser, souber/couber, quiser, puder — e todos os prefixados).
const SUFIXOS_SUBJUNTIVO = ["fizer", "tiver", "vier", "user", "ouver", "ouxer",
  "isser", "ouber", "quiser", "puder"];

// Grafia estranha ao portugues nativo = estrangeirismo, nao dropa.
const GRAFIA_ESTRANGEIRA = /[kwy]|nn|tt|ff|pp|mm|bb|gg|dd|zz|ll|th|ck|sh/;

// Determinantes que denunciam SUBSTANTIVO adiante ("um prazer", "o jantar").
// "a" e "nos" ficam FORA de proposito: "a" e ambigua com a preposicao pre-infinitivo
// ("comecou a falar") e "nos" com o pronome obliquo ("pode nos ajudar"). "ao" fica
// fora por "ao chegar/ao falar" (infinitivo apos "ao" e comum).
const DETERMINANTES = ["o", "os", "um", "uma", "uns", "umas", "do", "da", "dos", "das",
  "no", "na", "nas", "num", "numa", "pelo", "pela", "pelos", "pelas", "pro", "pros",
  "à", "às", "meu", "minha", "meus", "minhas", "seu", "sua", "seus", "suas",
  "nosso", "nossa", "nossos", "nossas", "esse", "essa", "esses", "essas",
  "este", "esta", "estes", "estas", "aquele", "aquela", "aqueles", "aquelas",
  "nesse", "nessa", "neste", "nesta", "naquele", "naquela",
  "desse", "dessa", "deste", "desta", "daquele", "daquela",
  "outro", "outra", "outros", "outras", "cada", "qualquer"];

// Adjetivos pre-nominais/ordinais que podem ficar ENTRE o determinante e o
// substantivo ("no terceiro andar", "um bom jantar", "o novo celular").
const ADJ_PRENOMINAIS = ["bom", "boa", "bons", "boas", "grande", "grandes",
  "novo", "nova", "novos", "novas", "velho", "velha", "melhor", "melhores",
  "pior", "piores", "próximo", "próxima", "último", "última", "últimos", "últimas",
  "antigo", "antiga", "ótimo", "ótima", "mero", "mera",
  "primeiro", "primeira", "segundo", "segunda", "terceiro", "terceira",
  "quarto", "quinto", "sexto", "oitavo", "nono", "décimo"];

// Contextos onde "você" e SUJEITO e o "cê" soa natural: inicio de frase ou apos
// conjuncao/advérbio da whitelist ("se cê quiser", "aí cê me fala"). Fora disso
// (objeto pos-verbal: "atendemos você", "vi você"; "até você"; "e você?") fica intacto.
const CONTEXTO_SUJEITO = new Set(["que", "se", "quando", "mas", "porque", "pois",
  "então", "aí", "lá", "como", "enquanto", "onde", "e"]);

const ACENTO: Record<string, string> = { ar: "á", er: "ê", ir: "í" };

function dropRInfinitivos(texto: string): string {
  const detAlt = DETERMINANTES.join("|");
  const adjAlt = ADJ_PRENOMINAIS.join("|");
  const pattern = new RegExp(
    `((?<![${W}])(?:${detAlt})\\s+(?:(?:${adjAlt})\\s+)?)?(?<![${W}-])([${W}]+(?:ar|er|ir))(?![${W}-])`,
    "giu",
  );
  return texto.replace(pattern, (full, det: string | undefined, palavra: string, offset: number, str: string) => {
    if (det) return full; // determinante antes = substantivo, nao dropa
    if (palavra !== palavra.toLowerCase()) return full; // maiuscula = nome/sigla/enfase
    if (/[áéíóúâêôãõàü]/.test(palavra)) return full; // acento grafico = nunca infinitivo
    if (GRAFIA_ESTRANGEIRA.test(palavra)) return full; // estrangeirismo
    if (SUFIXOS_SUBJUNTIVO.some((s) => palavra.endsWith(s))) return full; // subjuntivo irregular
    if (palavra.length < 5) return full;
    // locucao fixa "a partir (de)" — "a partí de segunda" soa errado
    if (palavra === "partir" &&
      new RegExp(`(?:^|[^${W}])a\\s+$`, "u").test(str.slice(Math.max(0, offset - 8), offset))) return full;
    for (const suf of ["ar", "er", "ir"] as const) {
      if (palavra.endsWith(suf)) {
        if (NAO_DROPAR[suf].has(palavra)) return full;
        return palavra.slice(0, -2) + ACENTO[suf];
      }
    }
    return full;
  });
}

function paraParaPra(texto: string): string {
  // "para" preposicao vira "pra"; o VERBO parar (3a pessoa/imperativo) fica intacto.
  // Sinais de verbo: nao/nunca/jamais/quem antes; "de/com/na/no/nas/nos", pontuacao
  // ou fim de frase depois ("nao para de crescer", "para com isso", "tudo para na
  // sexta", "o relogio nao para."). Hifen protege de-para, para-brisa, para-choque.
  let out = texto.replace(
    new RegExp(`(?<![${W}-])(para|Para|PARA)(?![${W}-])`, "gu"),
    (match, _p: string, offset: number, str: string) => {
      const antes = str.slice(0, offset);
      const mAntes = antes.match(new RegExp(`([${W}]+)\\s*$`, "u"));
      const palavraAntes = mAntes ? mAntes[1].toLowerCase() : null;
      if (palavraAntes && ["não", "nunca", "jamais", "quem"].includes(palavraAntes)) return match;
      const depois = str.slice(offset + match.length);
      if (/^\s*(?:$|[.,;:!?…)\]])/.test(depois)) return match; // fim/pontuacao = verbo
      if (new RegExp(`^\\s+(?:de|com|na|no|nas|nos|aqui|ali)(?![${W}])`, "iu").test(depois)) return match;
      if (match === "para") return "pra";
      if (match === "Para") return "Pra";
      return "PRA";
    },
  );
  // Colapsa artigo apos "pra": "pra a sua" -> "pra sua", "pra o time" -> "pro time"
  // (a fala funde preposicao+artigo; vale tambem pra "pra a" ja vindo no texto).
  // Nao colapsa se o "artigo" e demonstrativo ("passa pra a do juridico").
  out = out.replace(
    new RegExp(`(?<![${W}-])(pra|Pra|PRA)\\s+(a|as|o|os)(?![${W}-])(\\s+(?:de|do|da|dos|das|que)(?![${W}]))?`, "giu"),
    (full, pra: string, artigo: string, demonstrativo: string | undefined) => {
      if (demonstrativo) return full; // "pra a do juridico" fica
      const caps = pra === "PRA";
      const art = artigo.toLowerCase();
      if (art === "a") return pra;
      if (art === "as") return pra + (caps ? "S" : "s");
      const pro = caps ? "PRO" : pra === "Pra" ? "Pro" : "pro";
      return art === "o" ? pro : pro + (caps ? "S" : "s");
    },
  );
  return out;
}

function humanizarLeve(texto: string): string {
  return paraParaPra(dropRInfinitivos(texto));
}

function humanizarForte(texto: string): string {
  let out = humanizarLeve(texto);

  // Contracoes orais paulistas (case explicito, como no python original)
  const contracoes: Array<[RegExp, string]> = [
    [new RegExp(`(?<![${W}-])está(?![${W}-])`, "gu"), "tá"],
    [new RegExp(`(?<![${W}-])Está(?![${W}-])`, "gu"), "Tá"],
    [new RegExp(`(?<![${W}-])estou(?![${W}-])`, "gu"), "tô"],
    [new RegExp(`(?<![${W}-])Estou(?![${W}-])`, "gu"), "Tô"],
    [new RegExp(`(?<![${W}-])estava(?![${W}-])`, "gu"), "tava"],
    [new RegExp(`(?<![${W}-])Estava(?![${W}-])`, "gu"), "Tava"],
    [new RegExp(`(?<![${W}-])estamos(?![${W}-])`, "gu"), "tamo"],
    [new RegExp(`(?<![${W}-])Estamos(?![${W}-])`, "gu"), "Tamo"],
    [new RegExp(`(?<![${W}-])estão(?![${W}-])`, "gu"), "tão"],
    [new RegExp(`(?<![${W}-])Estão(?![${W}-])`, "gu"), "Tão"],
  ];
  for (const [pattern, repl] of contracoes) out = out.replace(pattern, repl);

  // voce -> ce SO em posicao de sujeito: inicio de frase ou apos conjuncao da
  // whitelist, e sempre com palavra em seguida ("cê viu", "se cê quiser",
  // "aí cê me fala"). Objeto pos-verbal ("atendemos você", "vi você"), "até você",
  // "e você?" e ALL CAPS ficam intactos.
  out = out.replace(
    new RegExp(`(?<![${W}-])(você|Você|VOCÊ)(?![${W}-])`, "gu"),
    (match, _v: string, offset: number, str: string) => {
      if (match === "VOCÊ") return match; // enfase grafica fica literal
      const depois = str.slice(offset + match.length);
      if (!new RegExp(`^\\s+[${W}]`, "u").test(depois)) return match; // precisa de palavra depois
      const antes = str.slice(0, offset).replace(/\s+$/, "");
      if (antes === "" || /[.!?;:\n]$/.test(antes)) {
        return match[0] === "V" ? "Cê" : "cê"; // inicio de frase = sujeito
      }
      const mAntes = antes.match(new RegExp(`([${W}]+)$`, "u"));
      if (mAntes && CONTEXTO_SUJEITO.has(mAntes[1].toLowerCase())) {
        return match[0] === "V" ? "Cê" : "cê";
      }
      return match;
    },
  );

  return out;
}

export function humanize(texto: string, nivel: HumanizeLevel): string {
  if (nivel === "leve") return humanizarLeve(texto);
  if (nivel === "forte") return humanizarForte(texto);
  return texto;
}
