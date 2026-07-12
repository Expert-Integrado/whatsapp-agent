// humanize.ts — humanizador oral paulista para TTS (porte 1:1 do humanizar.py
// da skill pessoal:voz, absorvida pelo agente em 12/07/2026).
//
// Nivel por perfil (voice_profiles.humanize): forte | leve | nenhum.
//   leve  = R drop em infinitivos longos + para->pra
//   forte = leve + contracoes orais (ta/to/tava/tamo) + voce->ce (protegido apos preposicao)
//
// JS \b nao é unicode-aware (ê/á nao sao \w) — usar lookarounds com classe propria.

export type HumanizeLevel = "forte" | "leve" | "nenhum";

// Palavras curtas/comuns que NAO devem dropar o R final
const NAO_DROPAR: Record<string, Set<string>> = {
  ar: new Set(["lar", "mar", "par", "bar", "lugar", "familiar", "militar", "particular",
    "regular", "popular", "preliminar", "açúcar", "nectar", "âmbar"]),
  er: new Set(["ser", "ter", "ver", "ler", "ker", "mer", "ber", "per", "qualquer",
    "carater", "poder", "valer", "mulher", "colher", "talher", "mister"]),
  ir: new Set(["ir", "vir", "sair", "cair", "pair", "sorrir", "possuir", "elixir"]),
};

const ACENTO: Record<string, string> = { ar: "á", er: "ê", ir: "í" };

// Preposicoes que protegem "voce" (nao viram "ce" depois delas)
const PREPOSICOES = ["com", "para", "pra", "de", "em", "a", "por", "sem", "sobre", "entre", "contra"];

// Classe de "caractere de palavra" unicode-aware pro portugues
const W = "A-Za-zÀ-ÖØ-öø-ÿ";

function dropRInfinitivos(texto: string): string {
  const pattern = new RegExp(`(?<![${W}])[${W}]+(?:ar|er|ir)(?![${W}])`, "gu");
  return texto.replace(pattern, (palavra) => {
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
  return texto.replace(new RegExp(`(?<![${W}])(?:para|Para|PARA)(?![${W}])`, "gu"), (w) => {
    if (w === "para") return "pra";
    if (w === "Para") return "Pra";
    if (w === "PARA") return "PRA";
    return w;
  });
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

  // voce -> ce (mas NAO depois de preposicao: "com você" fica intacto)
  const prepAlt = PREPOSICOES.join("|");
  const voceRe = new RegExp(
    `((?<![${W}])(?:${prepAlt})\\s+)?(?<![${W}])(você)(?![${W}])`,
    "giu",
  );
  out = out.replace(voceRe, (full, prep: string | undefined, voce: string) => {
    if (prep) return full; // protegido: "preposicao + você" intacto
    return voce[0] === "V" ? "Cê" : "cê";
  });

  return out;
}

export function humanize(texto: string, nivel: HumanizeLevel): string {
  if (nivel === "leve") return humanizarLeve(texto);
  if (nivel === "forte") return humanizarForte(texto);
  return texto;
}
