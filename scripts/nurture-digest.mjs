#!/usr/bin/env node
// Digest de conversas pra rotina de NUTRIÇÃO DE CONTATOS (skills/nutrir-contatos).
//
//   node scripts/nurture-digest.mjs digest [--since 2026-01-01T00:00:00Z] [--out arquivo.json]
//   node scripts/nurture-digest.mjs commit --file resultados.json
//   node scripts/nurture-digest.mjs history --phone 5511900000000 [--out arquivo.json]
//   node scripts/nurture-digest.mjs backfill-status --phones 5511...,5521...
//   node scripts/nurture-digest.mjs backfill-done --phone 5511... --entity <id> --msgs 123
//
// `history` varre o histórico COMPLETO de um telefone: chats privados dele
// (inclusive chat fantasma @lid, achado pelo campo phone) + tudo que ele falou
// em grupos (sender_phone). É o insumo do backfill ("nutrir o passado") e da
// varredura disparada quando um contato novo entra no vault. Read-only.
//
// `backfill-status`/`backfill-done` controlam quem já foi varrido (tabela
// nurture_backfill) — a varredura de histórico roda UMA vez por contato.
//
// `digest` lê as mensagens NOVAS de cada chat com atividade (cursor incremental na
// tabela nurture_state; sem cursor, janela default de 24h) e imprime um JSON compacto
// pra sessão do agente extrair fatos/interações. Read-only — não grava nada.
//
// `commit` avança os cursores DEPOIS que a sessão registrou os eventos no vault:
// recebe um JSON [{instance_id, chat_id, last_processed_ts, events_registered}].
// Separar leitura e commit é de propósito: se a extração falhar no meio, nada foi
// consumido e a próxima rodada reprocessa do mesmo ponto.
//
// Credenciais (nunca hardcoded):
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — env ou mcp/.env deste repo
//
// Caps (contra rodada gigante — dado que cresce sozinho estoura qualquer teto):
//   NURTURE_CHAT_CAP (default 40 chats, por recência)
//   NURTURE_MSG_CAP  (default 150 mensagens por chat, mais antigas primeiro)

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MODE = process.argv[2];
const argOf = (flag) => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : undefined;
};

const CHAT_CAP = parseInt(process.env.NURTURE_CHAT_CAP || '40', 10);
const MSG_CAP = parseInt(process.env.NURTURE_MSG_CAP || '150', 10);
const CONTENT_MAX = 600; // chars por mensagem no digest (transcrição de áudio pode ser longa)
const DEFAULT_LOOKBACK_H = 24;

// --- credenciais (mesmo loader do push-groups-to-contacts.mjs) ---
function loadDotEnv() {
  const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'mcp', '.env');
  const out = {};
  try {
    for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch { /* sem .env — fica só o process.env */ }
  return out;
}
const dotenv = loadDotEnv();
const SUPABASE_URL = process.env.SUPABASE_URL || dotenv.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || dotenv.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY não encontrados (env ou mcp/.env). Abortando.');
  process.exit(1);
}

async function sb(pathAndQuery, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_KEY,
      authorization: `Bearer ${SUPABASE_KEY}`,
      'content-type': 'application/json',
      ...opts.headers,
    },
  });
  if (!res.ok) throw new Error(`Supabase ${pathAndQuery} → ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null; // return=minimal responde 201 com corpo vazio
}

// --- digest ---
async function digest() {
  const sinceArg = argOf('--since');
  const defaultSince = sinceArg
    ? new Date(sinceArg)
    : new Date(Date.now() - DEFAULT_LOOKBACK_H * 3600_000);
  if (isNaN(defaultSince.getTime())) {
    console.error(`--since inválido: ${sinceArg}`);
    process.exit(1);
  }

  // Cursores existentes → mapa por instance:chat
  const stateRows = await sb('nurture_state?select=instance_id,chat_id,last_processed_ts');
  const cursor = new Map(stateRows.map((r) => [`${r.instance_id}:${r.chat_id}`, r.last_processed_ts]));

  // Chats com atividade desde o horizonte mais antigo possível (menor cursor vs default).
  // Broadcast/anúncio fica de fora: é ruído de um-pra-muitos, não conversa.
  const horizons = [...cursor.values(), defaultSince.toISOString()].sort();
  const oldest = horizons[0];
  const chats = await sb(
    `chats?select=instance_id,chat_id,chat_name,is_group,phone,member_count,last_message_at` +
    `&last_message_at=gte.${encodeURIComponent(oldest)}` +
    `&is_announcement=eq.false&is_community=eq.false` +
    `&order=last_message_at.desc&limit=${CHAT_CAP}`
  );

  const out = [];
  let totalMsgs = 0;
  for (const c of chats) {
    const key = `${c.instance_id}:${c.chat_id}`;
    const since = cursor.get(key) ?? defaultSince.toISOString();
    if (c.last_message_at && c.last_message_at <= since) continue; // nada novo neste chat
    const msgs = await sb(
      `messages?select=message_ts,from_me,sender_phone,sender_name,message_type,content,caption,quoted_msg_id` +
      `&instance_id=eq.${encodeURIComponent(c.instance_id)}&chat_id=eq.${encodeURIComponent(c.chat_id)}` +
      `&message_ts=gt.${encodeURIComponent(since)}&is_deleted=eq.false` +
      `&order=message_ts.asc&limit=${MSG_CAP}`
    );
    const kept = msgs
      .map((m) => ({
        ts: m.message_ts,
        from_me: m.from_me,
        sender_phone: m.sender_phone,
        sender_name: m.sender_name,
        type: m.message_type,
        text: ((m.content || m.caption || '').trim()).slice(0, CONTENT_MAX),
        reply_to: m.quoted_msg_id || undefined,
      }))
      .filter((m) => m.text.length > 0);
    if (kept.length === 0) continue;
    totalMsgs += kept.length;
    out.push({
      instance_id: c.instance_id,
      chat_id: c.chat_id,
      name: c.chat_name,
      is_group: c.is_group,
      phone: c.phone,
      member_count: c.member_count,
      since,
      truncated: msgs.length === MSG_CAP, // bateu no cap — a próxima rodada continua do cursor
      messages: kept,
    });
  }

  // Mesmo chat em 2+ instâncias (multi-instância Z-API) = mensagens duplicadas.
  // Mantém a cópia com mais mensagens; as outras viram cursor extra em also_commit,
  // pra rodada seguinte não reprocessar o mesmo grupo pela outra instância.
  const byChat = new Map();
  for (const c of out) {
    const prev = byChat.get(c.chat_id);
    if (!prev) { byChat.set(c.chat_id, c); continue; }
    const [keep, drop] = prev.messages.length >= c.messages.length ? [prev, c] : [c, prev];
    keep.also_commit = [
      ...(keep.also_commit || []),
      ...(drop.also_commit || []),
      { instance_id: drop.instance_id, last_processed_ts: drop.messages[drop.messages.length - 1].ts },
    ];
    byChat.set(c.chat_id, keep);
  }
  const chatsOut = [...byChat.values()];
  const totalKept = chatsOut.reduce((n, c) => n + c.messages.length, 0);

  const payload = {
    generated_at: new Date().toISOString(),
    default_since: defaultSince.toISOString(),
    chat_cap: CHAT_CAP,
    msg_cap: MSG_CAP,
    chats: chatsOut,
  };
  const dropped = out.length - chatsOut.length;
  const dupNote = dropped > 0 ? ` (${dropped} cópia(s) multi-instância deduplicada(s), ${totalMsgs - totalKept} msgs)` : '';
  const outFile = argOf('--out');
  const json = JSON.stringify(payload, null, 2);
  if (outFile) {
    writeFileSync(outFile, json);
    console.error(`digest: ${chatsOut.length} chat(s), ${totalKept} mensagem(ns)${dupNote} → ${outFile}`);
  } else {
    console.log(json);
    console.error(`digest: ${chatsOut.length} chat(s), ${totalKept} mensagem(ns)${dupNote}`);
  }
}

// --- history: varredura completa de um telefone (backfill / contato novo) ---
const HIST_PRIV_CAP = parseInt(process.env.NURTURE_HIST_PRIV_CAP || '1000', 10); // msgs por chat privado
const HIST_GROUP_CAP = parseInt(process.env.NURTURE_HIST_GROUP_CAP || '800', 10); // falas em grupos, total

// 9o dígito BR: 5511 + 8 dígitos ganha variante com 9; com 9, variante sem.
function phoneVariants(p) {
  const v = new Set([p]);
  if (p.startsWith('55')) {
    if (p.length === 12) v.add(p.slice(0, 4) + '9' + p.slice(4));
    if (p.length === 13 && p[4] === '9') v.add(p.slice(0, 4) + p.slice(5));
  }
  return [...v];
}

const toMsg = (m) => ({
  ts: m.message_ts,
  from_me: m.from_me,
  text: ((m.content || m.caption || '').trim()).slice(0, CONTENT_MAX),
});

// Página pequena: transcrição de áudio é TOAST pesado — página grande estoura
// o statement timeout do PostgREST.
const HIST_PAGE = 200;
async function pagedMessages(baseQuery, cap) {
  const out = [];
  let cursor = null;
  while (out.length < cap) {
    const page = await sb(
      `${baseQuery}${cursor ? `&message_ts=gt.${encodeURIComponent(cursor)}` : ''}` +
      `&order=message_ts.asc&limit=${Math.min(HIST_PAGE, cap - out.length)}`
    );
    out.push(...page);
    if (page.length < HIST_PAGE) return { rows: out, truncated: false };
    cursor = page[page.length - 1].message_ts;
  }
  return { rows: out, truncated: true };
}

async function history() {
  const phone = argOf('--phone');
  if (!phone || !/^\d{8,15}$/.test(phone)) {
    console.error('history exige --phone <E.164 sem +>');
    process.exit(1);
  }
  const variants = phoneVariants(phone);
  const inList = `in.(${variants.map((v) => `"${v}"`).join(',')})`;

  // Chats privados do número (o campo phone também acha o chat fantasma @lid)
  const privChats = await sb(
    `chats?select=instance_id,chat_id,chat_name,phone&phone=${inList}&is_group=eq.false`
  );
  const privOut = [];
  for (const c of privChats) {
    const { rows, truncated } = await pagedMessages(
      `messages?select=message_ts,from_me,content,caption` +
      `&instance_id=eq.${encodeURIComponent(c.instance_id)}&chat_id=eq.${encodeURIComponent(c.chat_id)}` +
      `&is_deleted=eq.false`,
      HIST_PRIV_CAP
    );
    const kept = rows.map(toMsg).filter((m) => m.text.length > 0);
    if (kept.length) privOut.push({
      chat_name: c.chat_name, chat_id: c.chat_id,
      truncated, messages: kept,
    });
  }

  // Falas do número em grupos (só o que ELE disse; contexto vem do nome do grupo)
  const { rows: groupMsgs, truncated: groupTruncated } = await pagedMessages(
    `messages?select=message_ts,from_me,content,caption,chat_id,sender_name` +
    `&sender_phone=${inList}&from_me=eq.false&is_deleted=eq.false`,
    HIST_GROUP_CAP
  );
  const privIds = new Set(privChats.map((c) => c.chat_id));
  const inGroups = groupMsgs.filter((m) => !privIds.has(m.chat_id));
  const groupNames = new Map();
  if (inGroups.length) {
    const ids = [...new Set(inGroups.map((m) => m.chat_id))];
    const rows = await sb(
      `chats?select=chat_id,chat_name&chat_id=in.(${ids.map((i) => `"${i}"`).join(',')})`
    );
    for (const r of rows) groupNames.set(r.chat_id, r.chat_name);
  }
  const byGroup = new Map();
  for (const m of inGroups) {
    const g = byGroup.get(m.chat_id) || { chat_name: groupNames.get(m.chat_id) || m.chat_id, chat_id: m.chat_id, messages: [] };
    const km = toMsg(m);
    if (km.text.length) g.messages.push(km);
    byGroup.set(m.chat_id, g);
  }

  const groups = [...byGroup.values()].filter((g) => g.messages.length > 0);
  const total = privOut.reduce((n, c) => n + c.messages.length, 0) +
    groups.reduce((n, g) => n + g.messages.length, 0);
  const payload = {
    phone, variants, generated_at: new Date().toISOString(),
    total_messages: total,
    group_truncated: groupTruncated,
    private_chats: privOut, groups,
  };
  const outFile = argOf('--out');
  const json = JSON.stringify(payload, null, 2);
  if (outFile) {
    writeFileSync(outFile, json);
    console.error(`history ${phone}: ${total} mensagem(ns) (${privOut.length} chat(s) privado(s), ${groups.length} grupo(s)) → ${outFile}`);
  } else {
    console.log(json);
  }
}

// --- backfill-status / backfill-done: controle de quem já foi varrido ---
async function backfillStatus() {
  const phones = (argOf('--phones') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!phones.length) {
    console.error('backfill-status exige --phones a,b,c');
    process.exit(1);
  }
  const rows = await sb(`nurture_backfill?select=phone&phone=in.(${phones.map((p) => `"${p}"`).join(',')})`);
  const done = new Set(rows.map((r) => r.phone));
  console.log(JSON.stringify({ done: [...done], pending: phones.filter((p) => !done.has(p)) }));
}

async function backfillDone() {
  const phone = argOf('--phone');
  const entity = argOf('--entity');
  if (!phone || !entity) {
    console.error('backfill-done exige --phone e --entity (id no vault); --msgs opcional');
    process.exit(1);
  }
  await sb('nurture_backfill?on_conflict=phone', {
    method: 'POST',
    headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([{
      phone, entity_id: entity,
      done_at: new Date().toISOString(),
      msgs_read: parseInt(argOf('--msgs') || '0', 10),
    }]),
  });
  console.error(`backfill-done: ${phone} marcado.`);
}

// --- commit ---
async function commit() {
  const file = argOf('--file');
  if (!file) {
    console.error('commit exige --file <resultados.json>');
    process.exit(1);
  }
  const rows = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(rows) || rows.length === 0) {
    console.error('commit: arquivo vazio ou não é um array — nada a fazer.');
    return;
  }
  for (const r of rows) {
    if (!r.instance_id || !r.chat_id || !r.last_processed_ts) {
      console.error(`commit: linha inválida (exige instance_id, chat_id, last_processed_ts): ${JSON.stringify(r)}`);
      process.exit(1);
    }
  }
  const body = rows.map((r) => ({
    instance_id: r.instance_id,
    chat_id: r.chat_id,
    last_processed_ts: r.last_processed_ts,
    last_run_at: new Date().toISOString(),
    events_registered: r.events_registered ?? 0,
  }));
  await sb('nurture_state?on_conflict=instance_id,chat_id', {
    method: 'POST',
    headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(body),
  });
  console.error(`commit: ${body.length} cursor(es) avançado(s).`);
}

if (MODE === 'digest') await digest();
else if (MODE === 'commit') await commit();
else if (MODE === 'history') await history();
else if (MODE === 'backfill-status') await backfillStatus();
else if (MODE === 'backfill-done') await backfillDone();
else {
  console.error('Uso: nurture-digest.mjs digest [--since ISO] [--out arquivo.json] | commit --file resultados.json | history --phone <fone> [--out arquivo.json] | backfill-status --phones a,b | backfill-done --phone <fone> --entity <id> [--msgs N]');
  process.exit(1);
}
