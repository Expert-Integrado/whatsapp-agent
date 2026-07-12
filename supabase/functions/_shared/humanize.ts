// humanize.ts — humanizador oral paulista para TTS (porte do humanizar.py da
// skill pessoal:voz, absorvida pelo agente em 12/07/2026, + calibragem do mesmo
// dia com feedback do dono sobre os audios de teste — nao e mais 1:1 com o py).
//
// Nivel por perfil (voice_profiles.humanize): forte | leve | nenhum.
//   leve  = R drop em infinitivos longos + para->pra (com colapso de artigo)
//   forte = leve + contracoes orais (ta/to/tava/tamo) + voce->ce (protegido apos
//           preposicao e apos verbo no infinitivo)
// wa_instance.humanize_enabled=false (0052) desliga tudo no send-voice.
//
// JS \b nao é unicode-aware (ê/á nao sao \w) — usar lookarounds com classe propria.

export type HumanizeLevel = "forte" | "leve" | "nenhum";

// Palavras que NAO devem dropar o R final: curtas/comuns, substantivos que a
// heuristica de sufixo confundiria com verbo ("um prazer" nao vira "um prazê")
// e futuro do subjuntivo IRREGULAR ("se fizer" nao e infinitivo — "fizê" soa
// errado; regulares como "se falar" sao identicos ao infinitivo e seguem dropando).
const NAO_DROPAR: Record<string, Set<string>> = {
  ar: new Set(["lar", "mar", "par", "bar", "lugar", "familiar", "militar", "particular",
    "regular", "popular", "preliminar", "açúcar", "nectar", "âmbar"]),
  er: new Set(["ser", "ter", "ver", "ler", "ker", "mer", "ber", "per", "qualquer",
    "carater", "poder", "valer", "mulher", "colher", "talher", "mister",
    // substantivos em -er (calibragem 12/07)
    "prazer",
    // futuro do subjuntivo irregular (calibragem 12/07)
    "fizer", "refizer", "desfizer", "satisfizer", "quiser", "puder", "tiver",
    "mantiver", "obtiver", "retiver", "detiver", "contiver", "estiver", "houver",
    "souber", "couber", "trouxer", "disser", "compuser", "propuser", "dispuser", "supuser"]),
  ir: new Set(["ir", "vir", "sair", "cair", "pair", "sorrir", "possuir", "elixir"]),
};

const ACENTO: Record<string, string> = { ar: "á", er: "ê", ir: "í" };

// Preposicoes que protegem "voce" (nao viram "ce" depois delas)
const PREPOSICOES = ["com", "para", "pra", "de", "em", "a", "por", "sem", "sobre", "entre", "contra"];

// Determinantes que denunciam SUBSTANTIVO na palavra seguinte ("um prazer",
// "o jantar") — protegem do R-drop. "a"/"nos" ficam FORA de proposito: "a" e
// ambigua com a preposicao pre-infinitivo ("comecou a falar") e "nos" com o
// pronome obliquo ("pode nos ajudar"), que precedem verbo legitimamente.
const DETERMINANTES = ["o", "os", "um", "uma", "uns", "umas", "do", "da", "dos", "das",
  "no", "na", "nas", "pelo", "pela", "pelos", "pelas",
  "meu", "minha", "meus", "minhas", "seu", "sua", "seus", "suas",
  "nosso", "nossa", "nossos", "nossas", "esse", "essa", "esses", "essas",
  "este", "esta", "estes", "estas", "aquele", "aquela", "aqueles", "aquelas"];

// Classe de "caractere de palavra" unicode-aware pro portugues
const W = "A-Za-zÀ-ÖØ-öø-ÿ";

function dropRInfinitivos(texto: string): string {
  const detAlt = DETERMINANTES.join("|");
  const pattern = new RegExp(
    `((?<![${W}])(?:${detAlt})\\s+)?(?<![${W}])([${W}]+(?:ar|er|ir))(?![${W}])`,
    "giu",
  );
  return texto.replace(pattern, (full, det: string | undefined, palavra: string) => {
    if (det) return full; // determinante antes = substantivo ("um prazer"), nao dropa
    const lower = palavra.toLowerCase();
    for (const suf of ["ar", "er", "ir"] as const) {
      if (lower.endsWith(suf)) {
        if (NAO_DROPAR[suf].has(lower)) return palavra;
        if (palavra.length < 5) return palavra;
        const base = palavra.slice(0, -2);
        const acento = ACENTO[suf];
        if (palavra === palavra.toUpperCase() && /[A-ZÀ-Ö]/.test(palavra)) return base + acento.toUpperCase();
        return base + acento;
      }
    }
    return palavra;
  });
}

function paraParaPra(texto: string): string {
  let out = texto.replace(new RegExp(`(?<![${W}])(?:para|Para|PARA)(?![${W}])`, "gu"), (w) => {
    if (w === "para") return "pra";
    if (w === "Para") return "Pra";
    if (w === "PARA") return "PRA";
    return w;
  });
  // Colapsa artigo apos "pra": "pra a sua" -> "pra sua", "pra o time" -> "pro time"
  // (a fala oral funde preposicao+artigo; vale tambem pra "pra a" ja vindo no texto).
  out = out.replace(new RegExp(`(?<![${W}])(pra|Pra|PRA)\\s+(a|as|o|os)(?![${W}])`, "gu"),
    (_full, pra: string, artigo: string) => {
      const lower = artigo.toLowerCase();
      if (lower === "a") return pra;
      if (lower === "as") return pra + (pra === "PRA" ? "S" : "s");
      const pro = pra === "PRA" ? "PRO" : pra === "Pra" ? "Pro" : "pro";
      return lower === "o" ? pro : pro + (pra === "PRA" ? "S" : "s");
    });
  return out;
}

function humanizarLeve(texto: string): string {
  return paraParaPra(dropRInfinitivos(texto));
}

function humanizarForte(texto: string): string {
  let out = humanizarLeve(texto);

  // Contracoes orais paulistas (case explicito, como no python)
  const contracoes: Array<[RegExp, string]> = [
    [new RegExp(`(?<![${W}])está(?![${W}])`, "gu"), "tá"],
    [new RegExp(`(?<![${W}])Está(?![${W}])`, "gu"), "Tá"],
    [new RegExp(`(?<![${W}])estou(?![${W}])`, "gu"), "tô"],
    [new RegExp(`(?<![${W}])Estou(?![${W}])`, "gu"), "Tô"],
    [new RegExp(`(?<![${W}])estava(?![${W}])`, "gu"), "tava"],
    [new RegExp(`(?<![${W}])Estava(?![${W}])`, "gu"), "Tava"],
    [new RegExp(`(?<![${W}])estamos(?![${W}])`, "gu"), "tamo"],
    [new RegExp(`(?<![${W}])Estamos(?![${W}])`, "gu"), "Tamo"],
  ];
  for (const [pattern, repl] of contracoes) out = out.replace(pattern, repl);

  // voce -> ce, protegido em dois contextos onde "ce" soa artificial:
  //   - apos preposicao: "com você" fica intacto
  //   - apos verbo no infinitivo (calibragem 12/07): "ajudá você" / "ver você"
  //     ficam intactos — o R-drop ja rodou, entao o verbo termina em á/ê/í
  //     (dropado) ou ar/er/ir (curto/protegido).
  const prepAlt = PREPOSICOES.join("|");
  const voceRe = new RegExp(
    `((?:(?<![${W}])(?:${prepAlt})|[${W}]+(?:[áêí]|[aei]r))\\s+)?(?<![${W}])(você)(?![${W}])`,
    "giu",
  );
  out = out.replace(voceRe, (full, guard: string | undefined, voce: string) => {
    if (guard) return full; // protegido: preposicao ou verbo antes, "você" intacto
    return voce[0] === "V" ? "Cê" : "cê";
  });

  return out;
}

export function humanize(texto: string, nivel: HumanizeLevel): string {
  if (nivel === "leve") return humanizarLeve(texto);
  if (nivel === "forte") return humanizarForte(texto);
  return texto;
}
