// Normalizacao de texto ANTES de casar as regras hard do voice guide.
// Fecha a CLASSE de bypass por Unicode: caracteres que RENDERIZAM iguais na bolha
// do WhatsApp mas escapam da regex crua (revisao adversarial 19/07). Sem isto, um
// texto vindo de mensagem recebida (prompt injection) ou do proprio autocorrect
// passa "me chama no zap" com um zero-width no meio, ou o em-dash como en-dash,
// e o gate nao pega. So o COTEJO e normalizado — o texto ENVIADO nunca muda.
//
// Escopo (fechado por decisao do conselho 19/07, sem scripts exoticos):
//   1. NFC          — acento decomposto ("a"+U+0301) volta a ser precomposto, senao "ola" escapa.
//   2. zero-width   — ZWSP/ZWNJ/ZWJ/word-joiner/BOM/soft-hyphen somem do meio das palavras.
//   3. dash-fold    — tracos LONGOS parecidos com em-dash (figure/en/horizontal-bar/
//                     minus/2-3-em/small-em) colapsam no em-dash canonico U+2014.
//                     NAO inclui hyphen-minus comum (U+002D) nem hifens curtos
//                     (U+2010/U+2011): foldar hifen viraria falso-positivo em massa.

// ZWSP/ZWNJ/ZWJ/word-joiner/BOM/soft-hyphen
const ZERO_WIDTH = /[​‌‍⁠﻿­]/g;
// figure/en/horizontal-bar/minus/two-em/three-em/small-em dashes (nao o em-dash alvo nem hyphen-minus)
const DASH_LIKE = /[‒–―−⸺⸻﹘]/g;

export function normalizeForVoiceCheck(text: string): string {
  if (typeof text !== "string") return "";
  return text.normalize("NFC").replace(ZERO_WIDTH, "").replace(DASH_LIKE, "—");
}
