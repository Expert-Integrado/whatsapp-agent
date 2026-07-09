#!/usr/bin/env node
// Grafo social: replies diretos em GRUPOS → conexões interacts_with no vault de
// contatos (expert-contacts specs/whatsapp-interactions.md).
//
//   node scripts/social-graph.mjs [--dry-run] [--since 2026-01-01T00:00:00Z]
//
// Fluxo: lê mensagens de grupo com quoted_msg_id (reply direto) desde o cursor
// (tabela social_graph_state; primeiro run = 90 dias), resolve o AUTOR da mensagem
// citada via provider_msg_id, agrega pares não-ordenados (A,B) com contagem e
// grupos, e empurra pro worker. O worker só conecta quem JÁ é contato — este
// script não filtra por vault de propósito (o servidor decide, não o cliente).
//
// Multi-instância: o mesmo grupo pode existir em 2+ instâncias (mensagens
// duplicadas) — replies são deduplicados por provider_msg_id.
//
// Credenciais (nunca hardcoded): mesmas do push-groups-to-contacts.mjs.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DRY = process.argv.includes('--dry-run');
const CONTACTS_URL = (process.env.CONTACTS_URL || 'https://expert-contacts.contato-d9a.workers.dev').replace(/\/$/, '');
const DEFAULT_LOOKBACK_DAYS = 90;
const PAGE = 1000;            // replies por request (colunas pequenas, sem TOAST)
const REPLIES_CAP = 20000;    // teto por rodada; o cursor continua de onde parou
const PUSH_CHUNK = 250;       // pares por POST (cap do worker: 300)

const argOf = (flag) => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : undefined;
};

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

function syncToken() {
  if (process.env.WHATSAPP_SYNC_TOKEN) return process.env.WHATSAPP_SYNC_TOKEN;
  if (dotenv.WHATSAPP_SYNC_TOKEN) return dotenv.WHATSAPP_SYNC_TOKEN;
  try {
    return execFileSync('op', ['read', 'op://Agentes Eric/WHATSAPP_SYNC_TOKEN/credential'], { encoding: 'utf8' }).trim();
  } catch {
    console.error('WHATSAPP_SYNC_TOKEN não encontrado (env ou 1Password). Abortando.');
    process.exit(1);
  }
}

// --- helpers HTTP ---
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
  return text ? JSON.parse(text) : null;
}

async function worker(path, body) {
  const res = await fetch(`${CONTACTS_URL}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${JSON.stringify(out)}`);
  return out;
}

// --- fluxo ---
const state = await sb('social_graph_state?select=last_processed_ts&id=eq.1');
const sinceArg = argOf('--since');
const since = sinceArg
  || state?.[0]?.last_processed_ts
  || new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * 86400_000).toISOString();
if (isNaN(new Date(since).getTime())) {
  console.error(`--since inválido: ${sinceArg}`);
  process.exit(1);
}

// Grupos: mapa (instance:chat) → nome, pra filtrar replies e nomear no why.
const groupRows = await sb('chats?select=instance_id,chat_id,chat_name&is_group=eq.true&is_announcement=eq.false&is_community=eq.false');
const groupName = new Map(groupRows.map((c) => [`${c.instance_id}:${c.chat_id}`, c.chat_name || c.chat_id]));

// Replies desde o cursor, paginado. Dedupe por provider_msg_id (multi-instância).
const replies = [];
const seenReply = new Set();
let cursor = since;
let truncated = false;
while (replies.length < REPLIES_CAP) {
  // quoted_msg_id OU raw_payload->>referenceMessageId: mensagens ingeridas antes
  // do fix do process-webhook (09/07/2026) foram backfilladas, mas mensagens novas
  // até o deploy da edge fn só têm o campo no raw_payload — o fallback cobre o vão.
  const page = await sb(
    `messages?select=instance_id,chat_id,provider_msg_id,sender_phone,quoted_msg_id,message_ts,ref:raw_payload->>referenceMessageId` +
    `&or=(quoted_msg_id.not.is.null,raw_payload->>referenceMessageId.not.is.null)` +
    `&from_me=eq.false&sender_phone=not.is.null&is_deleted=eq.false` +
    `&message_ts=gt.${encodeURIComponent(cursor)}&order=message_ts.asc&limit=${PAGE}`
  );
  for (const m of page) {
    cursor = m.message_ts;
    if (!groupName.has(`${m.instance_id}:${m.chat_id}`)) continue; // só grupos
    if (m.provider_msg_id && seenReply.has(m.provider_msg_id)) continue;
    if (m.provider_msg_id) seenReply.add(m.provider_msg_id);
    replies.push(m);
  }
  if (page.length < PAGE) break;
  if (replies.length >= REPLIES_CAP) { truncated = true; break; }
}
console.error(`replies em grupos desde ${since}: ${replies.length}${truncated ? ' (truncado — próxima rodada continua)' : ''}`);

// Autor da mensagem citada, em lote por provider_msg_id.
const quotedIds = [...new Set(replies.map((r) => r.quoted_msg_id || r.ref))];
const quotedAuthor = new Map(); // instance:provider → {sender_phone, from_me}
for (let i = 0; i < quotedIds.length; i += 100) {
  const chunk = quotedIds.slice(i, i + 100);
  const rows = await sb(
    `messages?select=instance_id,provider_msg_id,sender_phone,from_me` +
    `&provider_msg_id=in.(${chunk.map((x) => `"${x}"`).join(',')})`
  );
  for (const q of rows) quotedAuthor.set(`${q.instance_id}:${q.provider_msg_id}`, q);
}

// Agrega pares não-ordenados. from_me em qualquer ponta fica de fora: interação
// do DONO já vira evento 'talked' na nutrição — o grafo é entre TERCEIROS.
const pairs = new Map(); // "a|b" → {a_phone, b_phone, replies, groups:Set}
let noQuoted = 0;
for (const r of replies) {
  const q = quotedAuthor.get(`${r.instance_id}:${r.quoted_msg_id || r.ref}`);
  if (!q) { noQuoted++; continue; }        // citada não está no banco
  if (q.from_me || !q.sender_phone) continue;
  if (q.sender_phone === r.sender_phone) continue; // respondeu a si mesmo
  const [a, b] = [r.sender_phone, q.sender_phone].sort();
  const key = `${a}|${b}`;
  const p = pairs.get(key) || { a_phone: a, b_phone: b, replies: 0, groups: new Set() };
  p.replies++;
  p.groups.add(groupName.get(`${r.instance_id}:${r.chat_id}`));
  pairs.set(key, p);
}
const pairList = [...pairs.values()]
  .map((p) => ({ ...p, groups: [...p.groups].slice(0, 10) }))
  .sort((x, y) => y.replies - x.replies);
console.error(`pares agregados: ${pairList.length} (${noQuoted} reply sem mensagem citada no banco)`);

if (DRY) {
  for (const p of pairList.slice(0, 30)) {
    console.log(`${p.a_phone} <-> ${p.b_phone}: ${p.replies} reply(s) [${p.groups.join(', ')}]`);
  }
  console.error('dry-run: nada foi enviado nem commitado.');
  process.exit(0);
}

const TOKEN = syncToken();
const windowDays = Math.max(1, Math.round((Date.now() - new Date(since).getTime()) / 86400_000));
let created = 0, updated = 0, unknown = 0;
for (let i = 0; i < pairList.length; i += PUSH_CHUNK) {
  const chunk = pairList.slice(i, i + PUSH_CHUNK);
  const r = await worker('/whatsapp/interactions/import', { window_days: windowDays, pairs: chunk });
  created += r.connections_created ?? 0;
  updated += r.connections_updated ?? 0;
  unknown += r.skipped_unknown ?? 0;
}
console.error(`worker: ${created} conexão(ões) criada(s), ${updated} atualizada(s), ${unknown} par(es) com ponta fora do vault.`);

// Cursor avança SÓ depois do push bem-sucedido.
await sb('social_graph_state?on_conflict=id', {
  method: 'POST',
  headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
  body: JSON.stringify([{ id: 1, last_processed_ts: cursor, last_run_at: new Date().toISOString(), pairs_pushed: pairList.length }]),
});
console.error(`cursor avançado pra ${cursor}.`);
