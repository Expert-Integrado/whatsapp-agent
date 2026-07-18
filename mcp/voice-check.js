// ─── VOICE CHECK — motor GENERICO de regras hard + soft signals ──────────────
// Modulo puro (sem I/O, sem env, sem side-effects) usado por index.js (tools
// check_message/send) e por test-voice.js (suite unitaria).
//
// Split publico/privado (mesmo desenho da edge mcp-api):
//   - HARD_RULES: so fingerprints UNIVERSAIS de IA — nada pessoal do dono.
//   - Regras pessoais entram em runtime via compileCustomRules(checks), onde
//     `checks` vem do checks.json do voice guide do dono (mesmo formato que a
//     edge le de voice_guide.checks: hard_rules como regex serializada + soft).
//   - Soft signals: motor estrutural universal; assinaturas, thresholds e
//     mensagens calibradas com o corpus do dono vem de checks.soft (defaults
//     neutros abaixo).
//
// Filosofia: warning, nunca bloqueio. Quem decide bloquear ou nao e quem chama
// (index.js), nao este modulo.

// Regras hard universais — fingerprints binarias de IA, validas pra qualquer dono.
export const HARD_RULES = [
  {
    id: "em-dash",
    pattern: /—/,
    severity: "high",
    message: "Detectado em-dash (—) — fingerprint de IA. Voice guide manda virgula, dois-pontos, parenteses ou '..'.",
  },
  {
    id: "saudacao-generica",
    // \b em JS regex nao trata acentos como word chars; usa boundary custom (inicio/whitespace antes, nao-letra ASCII depois)
    pattern: /(?:^|[\s,!?;:.])(ol[áa]|prezad[oa]|cordialmente|atenciosamente|esp[ée]ro que esteja bem)(?=$|[\s,!?;:.])/iu,
    severity: "high",
    message: "Detectada saudacao generica/formal. Voice guide manda 'Fala [Nome], beleza?' ou direto no assunto.",
  },
  {
    id: "hype",
    pattern: /(?:^|[\s,!?;:.])(revolucion[áa]ri[oa]|transformador|disruptivo|game[- ]?changer|mindset|f[óo]rmula m[áa]gica)(?=$|[\s,!?;:.])/iu,
    severity: "high",
    message: "Detectado vocabulario de hype. Voice guide proibe — user posiciona com contencao.",
  },
  {
    id: "urgencia-manufaturada",
    pattern: /(?:^|[\s,!?;:.])([úu]ltima chance|s[óo] hoje|corre que|aproveita j[áa])(?=$|[\s,!?;:.])/iu,
    severity: "high",
    message: "Detectada urgencia manufaturada. Voice guide so aceita escassez REAL.",
  },
  {
    id: "softener-equipe",
    pattern: /\b(quando puder, por favor|se for poss[íi]vel|quando der um tempinho|com todo respeito)\b/iu,
    severity: "medium",
    message: "Detectado softener. Em equipe o dono usa ordem direta. Em discordancia, frontalidade direta.",
  },
  {
    id: "validacao-afetiva",
    pattern: /\b(te entendo|imagino como (voc[êe]|vc) (est[áa]|t[áa])|faz sentido (sua|tua) preocupa[çc][ãa]o|fica tranquil[oa] (que|q) vamos)\b/iu,
    severity: "high",
    message: "Detectada validacao afetiva. Voice guide regra hard: frontalidade nao inclui validar emocao — devolve pergunta de plano.",
  },
  {
    id: "rsrs",
    pattern: /\brsrs\w*\b/iu,
    severity: "medium",
    message: "Detectado 'rsrs'. Voice guide aceita 'kkk' ou 'rs' solto fim-de-frase, mas nao 'rsrs'.",
  },
];

// Regras hard PESSOAIS do dono vem do checks.json do voice guide como regex
// serializada ({ id, pattern, flags?, severity?, message }). Regex invalida e
// ignorada silenciosamente (nao derruba o check). Mesmo contrato da edge.
export function compileCustomRules(checks) {
  if (!Array.isArray(checks?.hard_rules)) return [];
  const out = [];
  for (const r of checks.hard_rules) {
    if (!r?.id || !r?.pattern || !r?.message) continue;
    try {
      out.push({ id: r.id, pattern: new RegExp(r.pattern, r.flags ?? "iu"), severity: r.severity ?? "medium", message: r.message });
    } catch { /* regex invalida */ }
  }
  return out;
}

export function checkVoiceViolations(content, customRules = []) {
  if (!content || typeof content !== "string") return [];
  const violations = [];
  for (const rule of [...HARD_RULES, ...customRules]) {
    const match = content.match(rule.pattern);
    if (match) {
      violations.push({
        id: rule.id,
        severity: rule.severity,
        message: rule.message,
        match: match[0],
      });
    }
  }
  return violations;
}

// Score 0-10: 10 - 3*high - 1.5*medium - 0.5*low - 0.5*soft, floor em 0.
export function computeVoiceScore(violations, softWarnings) {
  const weights = { high: 3, medium: 1.5, low: 0.5 };
  let score = 10;
  for (const v of violations) score -= weights[v.severity] ?? 0;
  for (const _w of softWarnings) score -= 0.5;
  return Math.max(0, Math.round(score * 10) / 10);
}

// ─── SOFT SIGNALS (estatistico, nao regex de violacao binaria) ──────────────
// Diferente de HARD_RULES: nao aponta um match especifico, mas um padrao
// estrutural (empilhamento de assinaturas, msg longa sem quebra, burst inflado)
// que e fingerprint de simulacao em qualquer voz: UNIFORMIDADE E FINGERPRINT
// (voz humana e distribuicao, voz simulada e ponto fixo). Sempre warning-only.
//
// Calibracao por dono via checks.soft: { signatures, max_prose_chars,
// multiline_lines, multiline_chars, ellipsis_min_runs, arrows_min,
// lowercase_min_units, burst_max, messages } — defaults neutros abaixo.
export const SOFT_DEFAULTS = {
  signatures: [],
  max_prose_chars: 250,
  multiline_lines: 3,
  multiline_chars: 200,
  ellipsis_min_runs: 3,
  arrows_min: 2,
  lowercase_min_units: 3,
  burst_max: 4,
  messages: {},
};

// URLs nao sao prosa: nao contam pra comprimento nem pra deteccao de setas
// (link longo de SharePoint/OneDrive tem 250+ chars e '->' na query sozinho).
function stripUrls(s) {
  return s.replace(/https?:\/\/\S+/g, "");
}

export function checkSoftSignals(content, softCfg = null) {
  const cfg = { ...SOFT_DEFAULTS, ...(softCfg ?? {}) };
  const msg = (id, fallback) => cfg.messages?.[id] ?? fallback;
  const warnings = [];

  const isArray = Array.isArray(content);
  const messages = isArray ? content : [content];
  const joined = messages.filter(m => typeof m === "string").join(" ");

  // Assinaturas fortes empilhadas (max 1 por resposta) — lista vem do dono.
  if (typeof joined === "string" && joined.length > 0 && Array.isArray(cfg.signatures) && cfg.signatures.length) {
    const lowerJoined = joined.toLowerCase();
    const foundSignatures = cfg.signatures.filter(sig => lowerJoined.includes(String(sig).toLowerCase()));
    if (foundSignatures.length > 1) {
      warnings.push({
        id: "assinaturas-empilhadas",
        severity: "soft",
        message: msg("assinaturas-empilhadas", `Detectadas ${foundSignatures.length} assinaturas fortes empilhadas na mesma msg (${foundSignatures.join(", ")}). Maximo 1 assinatura forte por resposta.`),
      });
    }
  }

  for (const m of messages) {
    if (typeof m !== "string") continue;

    const semUrl = stripUrls(m);

    // Quebra e UNIVERSAL — msg longa e fingerprint COM ou SEM \n interno. URLs descontadas.
    if (semUrl.length > cfg.max_prose_chars) {
      warnings.push({
        id: "msg-longa",
        severity: "soft",
        message: msg("msg-longa", `Mensagem unica com ${semUrl.length} chars de prosa (fora URLs). Quebrar em burst de sends separados ou virar audio — memo-monolito e fingerprint em qualquer estrato.`),
      });
    }

    const lines = m.split("\n").map(l => l.trim()).filter(Boolean);

    // Bolha multi-linha longa.
    if (lines.length >= cfg.multiline_lines && semUrl.length > cfg.multiline_chars) {
      warnings.push({
        id: "bolha-multilinha",
        severity: "soft",
        message: msg("bolha-multilinha", `Bolha unica com ${lines.length} linhas e ${semUrl.length} chars de prosa. Voz real prefere sends separados; considere fragmentar em burst.`),
      });
    }

    // Uniformidade de reticencias — voz real MISTURA '..' e '...'.
    // '…' unicode (autocorrect/IA) normalizado pra '...' — tambem conta como run.
    const runs = m.replace(/…/g, "...").match(/\.{2,}/g) || [];
    if (runs.length >= cfg.ellipsis_min_runs) {
      const sizes = new Set(runs.map(r => r.length));
      if (sizes.size === 1) {
        warnings.push({
          id: "uniformidade-reticencias",
          severity: "soft",
          message: msg("uniformidade-reticencias", `${runs.length} reticencias todas do mesmo tamanho ('${runs[0]}'). Voz real varia e mistura os tamanhos na mesma msg. Uniformidade e fingerprint.`),
        });
      }
    }

    // Cadeia de setas (estilo documentacao: "settings > danger zone > unarchive").
    // Matching por LINHA (nao atravessa \n), ignora quote-reply (linha comecando
    // com '>'), comparacao numerica (lado direito comecando com digito/R$/%) e
    // setas dentro de URL (ja stripadas).
    let setas = 0;
    for (const line of semUrl.split("\n")) {
      if (/^\s*>/.test(line)) continue; // quote-reply de WhatsApp
      setas += (line.match(/\S[ \t]*[>→»](?![ \t]*(?:\d|R\$|%))[ \t]*\S/g) || []).length;
    }
    if (setas >= cfg.arrows_min) {
      warnings.push({
        id: "cadeia-setas",
        severity: "soft",
        message: msg("cadeia-setas", "Cadeia de setas 'X > Y > Z' detectada — estilo de documentacao. Passo-a-passo em chat se escreve corrido ou vira audio/print."),
      });
    }
  }

  // Caixa uniforme minuscula — vale pra LINHAS de uma bolha multi-linha E pra
  // mensagens de um burst (array). Zero maiuscula em 3+ unidades = fingerprint.
  const units = [];
  for (const m of messages) {
    if (typeof m !== "string") continue;
    for (const line of m.split("\n")) {
      const t = line.trim();
      if (t) units.push(t);
    }
  }
  const letterStarts = units
    .map(u => (u.match(/^[A-Za-zÀ-ÖØ-öø-ÿ]/) || [null])[0])
    .filter(Boolean);
  if (letterStarts.length >= cfg.lowercase_min_units && letterStarts.every(ch => ch === ch.toLowerCase())) {
    warnings.push({
      id: "caixa-uniforme-minuscula",
      severity: "soft",
      message: msg("caixa-uniforme-minuscula", `${letterStarts.length} linhas/msgs TODAS comecando minusculas. Alternar a caixa — 100% minusculo e tao fingerprint quanto 100% capitalizado.`),
    });
  }

  // Conta so mensagens REAIS (string nao-vazia) — array com null/""/whitespace nao infla.
  const msgsReais = messages.filter(mm => typeof mm === "string" && mm.trim().length > 0).length;
  if (isArray && msgsReais > cfg.burst_max) {
    warnings.push({
      id: "burst-inflado",
      severity: "soft",
      message: msg("burst-inflado", `Burst com ${msgsReais} mensagens. Voz real fragmenta em 2-4 msgs — burst com mais de ${cfg.burst_max} e inflado.`),
    });
  }

  return warnings;
}
