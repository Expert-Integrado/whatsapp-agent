#!/usr/bin/env node
// Digest de conversas pra rotina de NUTRIÇÃO DE CONTATOS (skills/nutrir-contatos).
//
//   node scripts/nurture-digest.mjs digest [--since 2026-01-01T00:00:00Z] [--out arquivo.json]
//   node scripts/nurture-digest.mjs commit --file resultados.json
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
  return res.status === 204 ? null : res.json();
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
else {
  console.error('Uso: nurture-digest.mjs digest [--since ISO] [--out arquivo.json] | commit --file resultados.json');
  process.exit(1);
}
