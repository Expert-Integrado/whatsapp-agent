#!/usr/bin/env node
// Reconciliacao do voice gate (caixa 5 do encerramento, 19/07/2026).
// Transforma o modo de falha dominante — uma superficie que ESCAPA do gate — em
// alarme de producao. Reprocessa as mensagens REALMENTE enviadas pelo agente em
// instancia voice_gate='block' com o mesmo motor hard (ja normalizado) e aponta
// qualquer uma que viole regra HIGH e NAO tenha bypass registrado (voice_bypass_log)
// = escapou do gate. Tambem detecta sumico de blocks (log/gate quebrado).
//
// O ALARME real e sobre a rota GATEADA: sent_by_agent_name='mcp-api' (a tool do
// agente que passa por runVoiceGate). Escape ali = furo. Outras rotas tem cobertura
// propria ou outro escopo, e saem numa secao INFORMATIVA (nao falham o exit):
//   - claude-code-local: stdio legado (motor v2.11 proprio + hook local).
//   - dispatch-scheduled: worker de agendamento; o gate roda na CRIACAO do schedule.
//   - crons de relatorio/digest: texto estruturado de sistema, nao voz do dono.
//
// Rodar (em D+3 e D+7 do soak, ou quando quiser auditar):
//   SUPABASE_ACCESS_TOKEN=$(op read "op://Agentes Eric/SUPABASE_ACCESS_TOKEN/credential") \
//     node scripts/voice-gate-reconcile.mjs [--days 7] [--since 2026-07-19T15:00:00]
// --since crava o inicio do soak (so olha dai pra frente); --days e a alternativa por janela.
//
// Saida: relatorio no stdout. Exit 0 = limpo; exit 1 = escape pela rota gateada (mcp-api).
import fs from 'node:fs';

const PROJECT = 'gmpurkzxtvzqlvkqwjkp';
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
if (!TOKEN) { console.error('Falta SUPABASE_ACCESS_TOKEN (op read op://Agentes Eric/SUPABASE_ACCESS_TOKEN/credential).'); process.exit(2); }
const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const SINCE = arg('--since'); // ISO; se ausente, usa janela por dias
const DAYS = Number(arg('--days') ?? 7) || 7;
const WINDOW = SINCE ? `'${SINCE}'::timestamptz` : `now() - interval '${DAYS} days'`;
// rota gateada pelo voice gate server-side (a tool do agente):
const GATED_ROUTE = 'mcp-api';
const IGNORE = new Set(['voice-gate-e2e']); // ruido de teste E2E

// ── normalizacao identica ao gate (voice-normalize.ts) ──
const ZERO_WIDTH = /[​‌‍⁠﻿­]/g;
const DASH_LIKE = /[‒–―−⸺⸻﹘]/g;
const norm = (t) => typeof t !== 'string' ? '' : t.normalize('NFC').replace(ZERO_WIDTH, '').replace(DASH_LIKE, '—');

// ── regras hard HIGH: builtin do gate + custom high do dono (checks.json) ──
const BUILTIN_HIGH = [
  { id: 'em-dash', re: /—/ },
  { id: 'saudacao-generica', re: /(?:^|[\s,!?;:.])(ol[áa]|prezad[oa]|cordialmente|atenciosamente|esp[ée]ro que esteja bem)(?=$|[\s,!?;:.])/iu },
  { id: 'hype', re: /(?:^|[\s,!?;:.])(revolucion[áa]ri[oa]|transformador|disruptivo|game[- ]?changer|mindset|f[óo]rmula m[áa]gica)(?=$|[\s,!?;:.])/iu },
  { id: 'urgencia-manufaturada', re: /(?:^|[\s,!?;:.])([úu]ltima chance|s[óo] hoje|corre que|aproveita j[áa])(?=$|[\s,!?;:.])/iu },
  { id: 'validacao-afetiva', re: /\b(te entendo|imagino como (voc[êe]|vc) (est[áa]|t[áa])|faz sentido (sua|tua) preocupa[çc][ãa]o|fica tranquil[oa] (que|q) vamos)\b/iu },
];
function loadCustomHigh() {
  const cands = [process.env.VOICE_GUIDE_CHECKS_PATH, 'C:/repos/voice-guide/checks.json'].filter(Boolean);
  for (const p of cands) {
    try {
      const c = JSON.parse(fs.readFileSync(p, 'utf8'));
      return (c.hard_rules || []).filter((r) => r.severity === 'high' && r.id && r.pattern)
        .map((r) => { try { return { id: r.id, re: new RegExp(r.pattern, r.flags ?? 'iu') }; } catch { return null; } }).filter(Boolean);
    } catch { /* proximo candidato */ }
  }
  return [];
}
const RULES = [...BUILTIN_HIGH, ...loadCustomHigh()];
const violations = (content) => { const p = norm(content); return RULES.filter((r) => r.re.test(p)).map((r) => r.id); };

async function q(sql) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: sql }),
  });
  if (!r.ok) throw new Error(`query ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

const main = async () => {
  const inst = await q(`select instance_id, alias from wa_instance where voice_gate = 'block'`);
  if (!inst.length) { console.log('Nenhuma instancia em block — nada a reconciliar.'); return 0; }
  const ids = inst.map((i) => `'${i.instance_id}'`).join(',');
  const aliasOf = Object.fromEntries(inst.map((i) => [i.instance_id, i.alias ?? i.instance_id]));

  const msgs = await q(`select id, instance_id, content, message_ts, coalesce(sent_by_agent_name,'(null)') as rota from messages
    where from_me and sent_by_agent and instance_id in (${ids})
    and content is not null and length(trim(content)) > 0
    and message_ts > ${WINDOW} order by message_ts desc limit 5000`);
  const bypass = await q(`select instance_id, rule_ids, text_preview from voice_bypass_log
    where created_at > ${WINDOW}`);
  const blocks = await q(`select date_trunc('day', created_at)::date as dia, count(*) as n from voice_block_log
    where created_at > ${WINDOW} group by 1 order by 1`);

  // bypass consciente: mesma instancia + a violacao consta nos rule_ids do bypass +
  // o texto enviado casa (contido) no preview registrado.
  const bypassCovers = (m, vio) => bypass.some((b) => b.instance_id === m.instance_id
    && (b.rule_ids || []).some((r) => vio.includes(r))
    && norm(b.text_preview || '').includes(norm(m.content).slice(0, 60)));

  const gated = [], outras = new Map(); // gated = rota mcp-api (alarme); outras = por rota (informativo)
  for (const m of msgs) {
    if (IGNORE.has(m.rota)) continue;
    const vio = violations(m.content);
    if (!vio.length || bypassCovers(m, vio)) continue;
    if (m.rota === GATED_ROUTE) gated.push({ ...m, vio });
    else { const arr = outras.get(m.rota) ?? []; arr.push({ ...m, vio }); outras.set(m.rota, arr); }
  }

  console.log(`\n== Reconciliacao do voice gate — ${SINCE ? `desde ${SINCE}` : `ultimos ${DAYS}d`} ==`);
  if (!SINCE) console.log('NOTA: sem --since a janela pode incluir periodo PRE-gate (gate passou a bloquear 18/07 ~17:27 UTC); escapes anteriores sao historico, nao furo. Para o soak use --since com o inicio do periodo.');
  console.log(`Instancias em block: ${inst.map((i) => aliasOf[i.instance_id]).join(', ')}`);
  console.log(`Mensagens reprocessadas: ${msgs.length}  |  bypasses conscientes: ${bypass.length}`);
  console.log(`Blocks por dia: ${blocks.length ? blocks.map((b) => `${b.dia}=${b.n}`).join('  ') : '(nenhum)'}`);

  if (outras.size) {
    console.log(`\n(informativo) escapes por rota NAO-gateada pelo servidor (cobertura por outro caminho / fora de escopo):`);
    for (const [rota, arr] of outras) console.log(`  ${rota}: ${arr.length} (rota com motor proprio, gate na criacao, ou relatorio de sistema)`);
  }

  if (gated.length) {
    console.log(`\n!! ${gated.length} MENSAGEM(NS) ESCAPARAM PELA ROTA GATEADA (${GATED_ROUTE}) — FURO REAL:`);
    for (const e of gated.slice(0, 40)) console.log(`  [${aliasOf[e.instance_id]}] ${e.message_ts} regras=${e.vio.join(',')} :: ${norm(e.content).replace(/\s+/g, ' ').slice(0, 90)}`);
    console.log('\nCada linha viola regra HIGH, saiu pela tool do agente numa instancia block e nao tem bypass. Investigar a tool/param que produziu.');
    return 1;
  }
  console.log(`\nOK: nenhuma mensagem pela rota gateada (${GATED_ROUTE}) viola HIGH sem bypass. Gate cobrindo o trafego do agente.`);
  return 0;
};
main().then((code) => process.exit(code)).catch((e) => { console.error('erro:', e.message); process.exit(2); });
