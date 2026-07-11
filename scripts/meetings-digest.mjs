#!/usr/bin/env node
// Digest incremental de reunioes do Meeting Hub pra rotina de nutricao de contatos.
// Le meetings (Zoom) com extraction/resumo desde o cursor e devolve JSON pro agente
// casar participantes externos com o vault e registrar kind='meeting' na timeline.
//
// Env (mcp/.env deste repo ou ambiente): MEETINGHUB_SUPABASE_URL, MEETINGHUB_SERVICE_ROLE_KEY
// Cursor: .meetings-cursor.json na raiz do repo (fora do git) — avanca so no commit.
//
//   node scripts/meetings-digest.mjs digest --out /tmp/meetings-digest.json
//   node scripts/meetings-digest.mjs commit --ts "<started_at da ultima reuniao processada>"
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CURSOR_F = path.join(ROOT, '.meetings-cursor.json');

// carrega mcp/.env se as vars nao estiverem no ambiente
if (!process.env.MEETINGHUB_SUPABASE_URL) {
  const f = path.join(ROOT, 'mcp', '.env');
  if (fs.existsSync(f)) {
    for (const l of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      const i = l.indexOf('=');
      if (i > 0 && !l.startsWith('#')) {
        const k = l.slice(0, i).trim();
        if (!process.env[k]) process.env[k] = l.slice(i + 1).trim();
      }
    }
  }
}
const BASE = (process.env.MEETINGHUB_SUPABASE_URL || '').replace(/\/$/, '');
const KEY = process.env.MEETINGHUB_SERVICE_ROLE_KEY || '';
if (!BASE || !KEY) {
  console.error('MEETINGHUB_SUPABASE_URL / MEETINGHUB_SERVICE_ROLE_KEY ausentes — passo de reunioes indisponivel');
  process.exit(2);
}
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

const cmd = process.argv[2];
const argOf = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };

if (cmd === 'digest') {
  const cursor = fs.existsSync(CURSOR_F) ? JSON.parse(fs.readFileSync(CURSOR_F, 'utf8')).last_started_at
    : new Date(Date.now() - 26 * 3600000).toISOString(); // primeiro run: ultimas 26h
  const url = `${BASE}/rest/v1/meetings?select=id,topic,started_at,participants,extraction&started_at=gt.${encodeURIComponent(cursor)}&extraction=not.is.null&order=started_at&limit=50`;
  const rows = await (await fetch(url, { headers: H })).json();
  if (!Array.isArray(rows)) { console.error('resposta inesperada do Meeting Hub'); process.exit(1); }
  const out = rows.filter((m) => m.extraction?.resumo).map((m) => ({
    id: m.id, topic: m.topic, started_at: m.started_at,
    participants: m.participants || [],
    resumo: String(m.extraction.resumo).slice(0, 600),
  }));
  const dest = argOf('--out');
  const payload = JSON.stringify({ since: cursor, count: out.length, meetings: out }, null, 1);
  if (dest) fs.writeFileSync(dest, payload); else process.stdout.write(payload);
  console.error(`meetings novas desde ${cursor}: ${out.length}`);
} else if (cmd === 'commit') {
  const ts = argOf('--ts');
  if (!ts || Number.isNaN(Date.parse(ts))) { console.error('--ts <ISO started_at> obrigatorio'); process.exit(1); }
  fs.writeFileSync(CURSOR_F, JSON.stringify({ last_started_at: new Date(ts).toISOString(), committed_at: new Date().toISOString() }));
  console.error(`cursor -> ${ts}`);
} else {
  console.error('uso: meetings-digest.mjs digest [--out f] | commit --ts <started_at>');
  process.exit(1);
}
