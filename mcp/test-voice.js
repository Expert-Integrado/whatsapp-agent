// Unit test da camada de voice check (voice-check.js) — motor GENERICO.
// Modulo puro, sem I/O/DB — roda offline, sem env vars.
//
// O motor carrega so as regras hard UNIVERSAIS (fingerprints de IA); regras
// pessoais do dono entram em runtime via compileCustomRules(checks) — aqui
// testadas com regras DUMMY injetadas. Os casos pessoais reais de cada
// instalacao vivem fora do repo (ver test-checks-local.js, nao versionado).
//
// Uso:
//   node test-voice.js

import { HARD_RULES, compileCustomRules, checkVoiceViolations, checkSoftSignals, computeVoiceScore } from "./voice-check.js";

let pass = 0, fail = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) { pass++; console.log(`  PASS  ${name}  ::  ${detail}`); }
  else           { fail++; failures.push({ name, detail }); console.log(`  FAIL  ${name}  ::  ${detail}`); }
}

function hasViolation(content, id, custom = []) {
  return checkVoiceViolations(content, custom).some(v => v.id === id);
}

// ─── 1. Regras hard UNIVERSAIS (regressao) ──────────────────────────────────
console.log("\n=== Regras hard universais (regressao) ===");
check("em-dash dispara", hasViolation("Isso e — na verdade — diferente", "em-dash"));
check("saudacao-generica dispara em 'Ola'", hasViolation("Ola, tudo bem?", "saudacao-generica"));
check("saudacao-generica dispara em 'Prezado'", hasViolation("Prezado cliente", "saudacao-generica"));
check("hype dispara em 'revolucionario'", hasViolation("Isso e revolucionario", "hype"));
check("hype dispara em 'game changer'", hasViolation("Esse produto e um game changer", "hype"));
check("urgencia-manufaturada dispara em 'ultima chance'", hasViolation("Ultima chance de garantir", "urgencia-manufaturada"));
check("softener-equipe dispara em 'quando puder, por favor'", hasViolation("quando puder, por favor revisa", "softener-equipe"));
check("validacao-afetiva dispara em 'te entendo'", hasViolation("te entendo, deve ser dificil", "validacao-afetiva"));
check("rsrs dispara", hasViolation("kkk rsrs", "rsrs"));
check("frase neutra nao dispara nada", checkVoiceViolations("Vai. Manda bala").length === 0,
  JSON.stringify(checkVoiceViolations("Vai. Manda bala")));

// ─── 2. Motor NAO carrega regra pessoal hardcoded ───────────────────────────
console.log("\n=== Neutralidade: sem regra pessoal no codigo ===");
check("'Cade tu?' NAO dispara nada sem custom rules", checkVoiceViolations("Cade tu?").length === 0);
check("'blz' NAO dispara nada sem custom rules", checkVoiceViolations("Fechado, blz").length === 0);
check("'Exatamente' NAO dispara nada sem custom rules", checkVoiceViolations("Exatamente, e isso").length === 0);
check("HARD_RULES so contem ids universais",
  HARD_RULES.every(r => ["em-dash", "saudacao-generica", "hype", "urgencia-manufaturada", "softener-equipe", "validacao-afetiva", "rsrs"].includes(r.id)),
  HARD_RULES.map(r => r.id).join(","));

// ─── 3. Integridade de HARD_RULES ────────────────────────────────────────────
console.log("\n=== Integridade de HARD_RULES ===");
for (const rule of HARD_RULES) {
  check(`regra '${rule.id}' tem severity valida`, ["high", "medium", "low"].includes(rule.severity), rule.severity);
  check(`regra '${rule.id}' tem message`, typeof rule.message === "string" && rule.message.length > 10);
  check(`regra '${rule.id}' tem pattern RegExp`, rule.pattern instanceof RegExp);
}

// ─── 4. compileCustomRules ───────────────────────────────────────────────────
console.log("\n=== compileCustomRules ===");
{
  const compiled = compileCustomRules({
    hard_rules: [
      { id: "regra-dummy", pattern: "\\bfoobar\\b", severity: "high", message: "Detectado foobar (regra de teste)." },
      { id: "flags-custom", pattern: "SoMenteMaiuscula", flags: "u", severity: "low", message: "Case-sensitive (regra de teste)." },
    ],
  });
  check("compila 2 regras validas", compiled.length === 2, `compiled=${compiled.length}`);
  check("pattern vira RegExp", compiled[0].pattern instanceof RegExp);
  check("flags default 'iu' (case-insensitive)", compiled[0].pattern.test("FOOBAR aqui"));
  check("flags custom respeitadas ('u' sem 'i')", !compiled[1].pattern.test("somentemaiuscula"));
}
check("checks null/undefined vira []", compileCustomRules(null).length === 0 && compileCustomRules(undefined).length === 0);
check("hard_rules ausente vira []", compileCustomRules({}).length === 0);
check("regex INVALIDA e ignorada sem derrubar",
  compileCustomRules({ hard_rules: [{ id: "quebrada", pattern: "([", message: "invalida" }, { id: "ok", pattern: "abc", message: "valida valida" }] }).length === 1);
check("regra sem id/pattern/message e ignorada",
  compileCustomRules({ hard_rules: [{ id: "sem-pattern", message: "x" }, { pattern: "x", message: "sem id" }] }).length === 0);
check("severity default 'medium'",
  compileCustomRules({ hard_rules: [{ id: "x", pattern: "x", message: "mensagem valida" }] })[0].severity === "medium");

// ─── 5. checkVoiceViolations com custom rules injetadas ─────────────────────
console.log("\n=== checkVoiceViolations + custom rules ===");
{
  const custom = compileCustomRules({
    hard_rules: [{ id: "regra-dummy", pattern: "\\bfoobar\\b", severity: "high", message: "Detectado foobar (regra de teste)." }],
  });
  check("custom rule dispara", hasViolation("tem foobar aqui", "regra-dummy", custom));
  check("custom rule NAO dispara sem match", !hasViolation("texto limpo", "regra-dummy", custom));
  check("universal continua disparando junto com custom",
    hasViolation("Ola, tem foobar — aqui", "em-dash", custom) && hasViolation("Ola, tem foobar — aqui", "regra-dummy", custom));
  check("violation traz match", checkVoiceViolations("tem foobar aqui", custom).find(v => v.id === "regra-dummy")?.match === "foobar");
}

// ─── 6. computeVoiceScore ────────────────────────────────────────────────────
console.log("\n=== computeVoiceScore ===");
check("score 10 sem violacoes", computeVoiceScore([], []) === 10);
check("high tira 3", computeVoiceScore([{ severity: "high" }], []) === 7);
check("medium tira 1.5", computeVoiceScore([{ severity: "medium" }], []) === 8.5);
check("low tira 0.5", computeVoiceScore([{ severity: "low" }], []) === 9.5);
check("soft tira 0.5", computeVoiceScore([], [{ id: "x" }]) === 9.5);
check("floor em 0", computeVoiceScore([{ severity: "high" }, { severity: "high" }, { severity: "high" }, { severity: "high" }], []) === 0);

// ─── 7. checkSoftSignals — defaults NEUTROS (sem assinaturas hardcoded) ─────
console.log("\n=== checkSoftSignals: defaults neutros ===");
{
  const msg = "Faz sentido? Bora? Sendo bem sincero, acho que sim";
  const warnings = checkSoftSignals(msg);
  check("SEM cfg, assinaturas-empilhadas NAO dispara (default neutro [])",
    !warnings.some(w => w.id === "assinaturas-empilhadas"), JSON.stringify(warnings));
}
{
  const warnings = checkSoftSignals("Faz sentido? Bora? Sendo bem sincero, sim", { signatures: ["faz sentido?", "bora?", "sendo bem sincero"] });
  check("COM cfg.signatures, assinaturas-empilhadas dispara", warnings.some(w => w.id === "assinaturas-empilhadas"), JSON.stringify(warnings));
}
{
  const warnings = checkSoftSignals("Bora? Vamo nessa", { signatures: ["faz sentido?", "bora?"] });
  check("1 assinatura so NAO dispara", !warnings.some(w => w.id === "assinaturas-empilhadas"));
}

// ─── 8. checkSoftSignals — sinais estruturais (defaults e overrides) ────────
console.log("\n=== checkSoftSignals: sinais estruturais ===");
check("msg-longa dispara com 301 chars", checkSoftSignals("a".repeat(301)).some(w => w.id === "msg-longa"));
check("msg-longa NAO dispara com 240 chars (limiar 250)", !checkSoftSignals("a".repeat(240)).some(w => w.id === "msg-longa"));
check("msg-longa dispara MESMO com quebra de linha",
  checkSoftSignals("a".repeat(150) + "\n" + "b".repeat(150)).some(w => w.id === "msg-longa"));
check("msg-longa desconta URLs",
  !checkSoftSignals("olha esse link https://example.com/" + "x".repeat(300)).some(w => w.id === "msg-longa"));
check("cfg.max_prose_chars override (100)",
  checkSoftSignals("a".repeat(150), { max_prose_chars: 100 }).some(w => w.id === "msg-longa"));
{
  const memo = "Linha um do memo aqui\nLinha dois com mais conteudo relevante\nLinha tres fechando o bloco e passando de duzentos caracteres pra disparar o limiar combinado de linhas e comprimento total da bolha unica enviada agora";
  check("bolha-multilinha dispara com 3 linhas e >200 chars", checkSoftSignals(memo).some(w => w.id === "bolha-multilinha"), `len=${memo.length}`);
  check("bolha-multilinha NAO dispara com 3 linhas curtas", !checkSoftSignals("oi\ntudo bem?\nvamos marcar?").some(w => w.id === "bolha-multilinha"));
}
{
  check("uniformidade-reticencias dispara com 3 runs iguais ('..')",
    checkSoftSignals("hmm.. entendi.. vou ver isso.. te falo").some(w => w.id === "uniformidade-reticencias"));
  check("reticencias MISTAS nao disparam",
    !checkSoftSignals("hmm.. entendi... vou ver isso.. te falo").some(w => w.id === "uniformidade-reticencias"));
  check("2 runs iguais NAO disparam",
    !checkSoftSignals("hmm.. entendi.. te falo").some(w => w.id === "uniformidade-reticencias"));
}
check("cadeia-setas dispara em 'settings > danger zone > unarchive'",
  checkSoftSignals("vai em settings > danger zone > unarchive").some(w => w.id === "cadeia-setas"));
check("cadeia-setas NAO dispara em comparacao numerica",
  !checkSoftSignals("meta > 100 e ticket > R$ 500").some(w => w.id === "cadeia-setas"));
check("caixa-uniforme-minuscula dispara com 3 linhas minusculas",
  checkSoftSignals("primeira linha\nsegunda linha\nterceira linha").some(w => w.id === "caixa-uniforme-minuscula"));
check("caixa mista NAO dispara",
  !checkSoftSignals("Primeira linha\nsegunda linha\nterceira linha").some(w => w.id === "caixa-uniforme-minuscula"));
check("burst-inflado dispara com 5 msgs", checkSoftSignals(["a", "b", "c", "d", "e"]).some(w => w.id === "burst-inflado"));
check("burst com 4 msgs NAO dispara", !checkSoftSignals(["a", "b", "c", "d"]).some(w => w.id === "burst-inflado"));
check("burst com null/vazio nao infla", !checkSoftSignals(["a", "b", null, "", "  "]).some(w => w.id === "burst-inflado"));
check("cfg.messages sobrescreve texto do warning",
  checkSoftSignals("a".repeat(301), { messages: { "msg-longa": "TEXTO CUSTOM" } }).find(w => w.id === "msg-longa")?.message === "TEXTO CUSTOM");

// ─── Resultado ───────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(60)}`);
console.log(`RESULTADO: ${pass} PASS, ${fail} FAIL`);
if (failures.length) {
  console.log("\nFalhas:");
  for (const f of failures) console.log(`  - ${f.name} ${f.detail ? `(${f.detail})` : ""}`);
  process.exit(1);
}
