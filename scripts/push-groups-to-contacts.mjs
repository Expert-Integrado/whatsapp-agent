#!/usr/bin/env node
// Push de grupos do WhatsApp Agent pro grafo de contatos (expert-contacts
// specs/whatsapp-groups-sync.md). Roda sob demanda na máquina do dono:
//
//   node scripts/push-groups-to-contacts.mjs [--dry-run]
//
// Fluxo: lê grupos do Supabase (chats is_group) → empurra o CATÁLOGO pro worker →
// lê a ALLOWLIST (escolhida no painel do Brain em /app/config#whatsapp-grupos) →
// empurra participantes SÓ dos grupos allowlistados. O worker faz o match por
// telefone e nunca cria contato novo.
//
// Credenciais (nunca hardcoded):
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — env ou mcp/.env deste repo
//   WHATSAPP_SYNC_TOKEN — env ou 1Password (op read op://Agentes Eric/WHATSAPP_SYNC_TOKEN/credential)
//   CONTACTS_URL — env (default: prod)

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DRY = process.argv.includes('--dry-run');
const CONTACTS_URL = (process.env.CONTACTS_URL || 'https://expert-contacts.contato-d9a.workers.dev').replace(/\/$/, '');
const IMPORT_CHUNK = 10; // grupos por request de import (respeita caps do worker)

// --- credenciais ---
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

function syncToken() {
  if (process.env.WHATSAPP_SYNC_TOKEN) return process.env.WHATSAPP_SYNC_TOKEN;
  try {
    return execFileSync('op', ['read', 'op://Agentes Eric/WHATSAPP_SYNC_TOKEN/credential'], { encoding: 'utf8' }).trim();
  } catch {
    console.error('WHATSAPP_SYNC_TOKEN não encontrado (env ou 1Password). Abortando.');
    process.exit(1);
  }
}

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY não encontrados (env ou mcp/.env). Abortando.');
  process.exit(1);
}
const TOKEN = syncToken();

// --- helpers HTTP ---
async function sb(pathAndQuery) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    headers: { apikey: SUPABASE_KEY, authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) throw new Error(`Supabase ${pathAndQuery} → ${res.status}: ${await res.text()}`);
  return res.json();
}

async function worker(path, opts = {}) {
  const res = await fetch(`${CONTACTS_URL}${path}`, {
    ...opts,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...opts.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

// --- fluxo ---
const chats = await sb('chats?is_group=eq.true&is_announcement=eq.false&select=chat_id,chat_name,member_count&order=chat_name');
const groups = chats
  .filter((c) => c.chat_id && c.chat_name)
  .map((c) => ({ chat_id: c.chat_id, name: c.chat_name, member_count: c.member_count ?? null }));
console.log(`Grupos no WhatsApp Agent: ${groups.length}`);

if (DRY) {
  for (const g of groups) console.log(`  - ${g.name} (${g.member_count ?? '?'} membros)`);
  console.log('[dry-run] nada foi enviado.');
  process.exit(0);
}

const cat = await worker('/whatsapp/groups/catalog', { method: 'POST', body: JSON.stringify({ groups }) });
console.log(`Catálogo enviado: ${cat.groups} grupos.`);

const { allowlist } = await worker('/whatsapp/groups/config');
if (!allowlist?.length) {
  console.log('Nenhum grupo marcado ainda. Marque os grupos no painel do Brain (/app/config#whatsapp-grupos) e rode de novo.');
  process.exit(0);
}
console.log(`Grupos marcados pra sincronizar: ${allowlist.length}`);

const allowed = groups.filter((g) => allowlist.includes(g.chat_id));
const payload = [];
for (const g of allowed) {
  const parts = await sb(`group_participants?chat_id=eq.${encodeURIComponent(g.chat_id)}&left_at=is.null&select=phone,name`);
  payload.push({
    chat_id: g.chat_id,
    name: g.name,
    participants: parts.filter((p) => p.phone).map((p) => ({ phone: p.phone, name: p.name ?? null })),
  });
  console.log(`  ${g.name}: ${parts.length} participantes ativos`);
}

const totals = { groups_imported: 0, members_linked: 0, members_unlinked: 0, unmatched: 0, unmatched_sample: [] };
for (let i = 0; i < payload.length; i += IMPORT_CHUNK) {
  const r = await worker('/whatsapp/groups/import', {
    method: 'POST',
    body: JSON.stringify({ groups: payload.slice(i, i + IMPORT_CHUNK) }),
  });
  totals.groups_imported += r.groups_imported ?? 0;
  totals.members_linked += r.members_linked ?? 0;
  totals.members_unlinked += r.members_unlinked ?? 0;
  totals.unmatched += r.unmatched ?? 0;
  totals.unmatched_sample.push(...(r.unmatched_sample ?? []));
}

console.log('--- resultado ---');
console.log(`Grupos importados: ${totals.groups_imported}`);
console.log(`Vínculos criados: ${totals.members_linked} · desfeitos: ${totals.members_unlinked}`);
console.log(`Participantes sem contato correspondente: ${totals.unmatched}`);
if (totals.unmatched_sample.length) console.log(`  amostra: ${totals.unmatched_sample.slice(0, 10).join(', ')}`);
