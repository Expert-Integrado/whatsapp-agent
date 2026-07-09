#!/usr/bin/env node
// Backfill do VOICE PROFILE por contato (skills/voice-profile-backfill).
//
//   node scripts/voice-profile-backfill.mjs corpus --instance pessoal [--limit 50]
//        [--min-messages 5] [--force] [--out <dir>]
//   node scripts/voice-profile-backfill.mjs commit --file perfis.json [--force]
//
// `corpus` monta, por contato com conversa PRIVADA, o material bruto pra sessão do
// agente extrair: como a pessoa chama o dono (vocativo => intimidade) + gírias/registro.
// Junta DMs inbound + varredura longitudinal de vocativos + evidência em GRUPOS
// (mensagens do mesmo telefone, priorizando replies ao dono). Read-only.
//
// `commit` grava os perfis analisados em chats.voice_profile DEPOIS da revisão.
// Separar leitura e commit é de propósito (mesmo padrão do nurture-digest): se a
// análise falhar no meio, nada foi gravado e o re-run recomeça do mesmo ponto —
// a idempotência vem do filtro voice_profile=is.null no corpus.
//
// Credenciais (nunca hardcoded):
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — env ou mcp/.env deste repo
//
// Caps (env-overridable):
//   VP_CONTACT_CAP (default 50 contatos por rodada, por recência)
//   VP_MSG_CAP     (default 150 DMs inbound por contato, mais recentes)
//   VP_VOC_CAP     (default 30 hits da varredura de vocativos, mais antigos primeiro)
//   VP_GROUP_CAP   (default 100 msgs de grupo puxadas; ~40 mantidas após priorização)

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MODE = process.argv[2];
const argOf = (flag) => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const hasFlag = (flag) => process.argv.includes(flag);

const CONTACT_CAP = parseInt(argOf('--limit') || process.env.VP_CONTACT_CAP || '50', 10);
const MSG_CAP = parseInt(process.env.VP_MSG_CAP || '150', 10);
const VOC_CAP = parseInt(process.env.VP_VOC_CAP || '30', 10);
const GROUP_CAP = parseInt(process.env.VP_GROUP_CAP || '100', 10);
const GROUP_KEEP = 40;
const CONTENT_MAX = 300;
const MIN_MESSAGES = parseInt(argOf('--min-messages') || '5', 10);
const BATCH_SIZE = 10;

// Padrões de vocativo pra varredura longitudinal (ilike, case-insensitive).
// A análise (LLM) é quem decide o que é vocativo de verdade — isto é só rede de captura.
const VOCATIVE_PATTERNS = ['mano', 'irmão', 'irmao', 'brother', 'parça', 'parca', 'eric', 'chefe', 'mestre', 'querido'];

// --- credenciais (mesmo loader do nurture-digest.mjs) ---
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
  if (!res.ok) throw new Error(`Supabase ${pathAndQuery.slice(0, 120)} → ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

// Variantes BR do 9º dígito (portado de mcp-api/index.ts normalizePhoneBR)
function normalizePhoneBR(digits) {
  const out = new Set();
  if (!digits) return [];
  out.add(digits);
  const flipNine = (d) => {
    if (d.length === 13 && d.startsWith('55') && d[4] === '9') out.add(d.slice(0, 4) + d.slice(5));
    else if (d.length === 12 && d.startsWith('55')) out.add(d.slice(0, 4) + '9' + d.slice(4));
  };
  flipNine(digits);
  if (!digits.startsWith('55') && (digits.length === 10 || digits.length === 11)) {
    const with55 = '55' + digits; out.add(with55); flipNine(with55);
  }
  return Array.from(out);
}

const cleanText = (m) => ((m.content || m.caption || '').trim()).slice(0, CONTENT_MAX);
const isUseful = (m, text) =>
  text.length > 0 && !/^https?:\/\/\S+$/.test(text) &&
  ['text', 'audio', 'voice', 'ptt'].includes(m.message_type);
const inList = (arr) => `in.(${arr.map((v) => `"${v}"`).join(',')})`;

async function resolveInstance() {
  const key = argOf('--instance');
  if (!key) {
    console.error('corpus exige --instance <alias|instance_id> (rodar só na instância certa é de propósito).');
    process.exit(1);
  }
  const rows = await sb('zapi_instance?select=instance_id,alias,is_default');
  const inst = rows.find((r) => r.alias === key || r.instance_id === key);
  if (!inst) {
    console.error(`Instância "${key}" não encontrada. Disponíveis: ${rows.map((r) => r.alias || r.instance_id).join(', ')}`);
    process.exit(1);
  }
  return inst.instance_id;
}

// --- corpus ---
async function corpus() {
  const INST = await resolveInstance();
  const outDir = argOf('--out') || 'C:/tmp/voice-profile-backfill';
  mkdirSync(outDir, { recursive: true });

  // Contatos-alvo: DMs numéricas, sem perfil ainda (idempotência de re-run), por recência.
  // Chats fantasma @lid ficam de fora como ALVO (entram como fonte via lid_mapping).
  const vpFilter = hasFlag('--force') ? '' : '&voice_profile=is.null';
  const targetsRaw = await sb(
    `chats?select=instance_id,chat_id,chat_name,phone,last_message_at` +
    `&instance_id=eq.${encodeURIComponent(INST)}` +
    `&is_group=eq.false&is_announcement=eq.false&is_community=eq.false${vpFilter}` +
    `&order=last_message_at.desc.nullslast&limit=${CONTACT_CAP * 2}`
  );
  const numeric = targetsRaw.filter((c) => /^\d+$/.test(c.chat_id));
  const skippedNonNumeric = targetsRaw.length - numeric.length;

  // Fold de variantes do 9º dígito: se duas DMs são o mesmo telefone, a mais recente
  // é o chat canônico (onde o perfil será gravado) e a outra vira fonte extra.
  const consumed = new Set();
  const targets = [];
  for (const c of numeric) {
    if (consumed.has(c.chat_id)) continue;
    const variants = normalizePhoneBR(c.chat_id);
    const folded = numeric.filter((o) => o.chat_id !== c.chat_id && variants.includes(o.chat_id));
    folded.forEach((o) => consumed.add(o.chat_id));
    targets.push({ ...c, variants, folded_chat_ids: folded.map((o) => o.chat_id) });
    if (targets.length >= CONTACT_CAP) break;
  }

  // lid_mapping uma vez: phone -> lids (chats fantasma @lid do mesmo número)
  const lidRows = await sb(`lid_mapping?select=lid,phone&instance_id=eq.${encodeURIComponent(INST)}`);
  const lidsByPhone = new Map();
  for (const r of lidRows) {
    for (const v of normalizePhoneBR(String(r.phone || '').replace(/\D/g, ''))) {
      if (!lidsByPhone.has(v)) lidsByPhone.set(v, new Set());
      lidsByPhone.get(v).add(r.lid);
      lidsByPhone.get(v).add(String(r.lid).endsWith('@lid') ? String(r.lid) : `${r.lid}@lid`);
    }
  }

  const contacts = [];
  let skippedFewMsgs = 0;
  for (const t of targets) {
    const lids = new Set();
    for (const v of t.variants) for (const l of lidsByPhone.get(v) || []) lids.add(l);
    const dmIds = [...new Set([t.chat_id, ...t.folded_chat_ids, ...lids])];

    // DMs inbound (transcrição de áudio cacheada em content conta — gíria vive em áudio)
    const dmRaw = await sb(
      `messages?select=message_ts,message_type,content,caption` +
      `&instance_id=eq.${encodeURIComponent(INST)}&chat_id=${inList(dmIds)}` +
      `&from_me=eq.false&is_deleted=eq.false` +
      `&order=message_ts.desc&limit=${MSG_CAP}`
    );
    const dmMsgs = dmRaw
      .map((m) => ({ ts: m.message_ts, type: m.message_type, text: cleanText(m), _m: m }))
      .filter((m) => isUseful(m._m, m.text))
      .map(({ _m, ...m }) => m)
      .reverse();
    if (dmMsgs.length < MIN_MESSAGES) { skippedFewMsgs++; continue; }

    // Varredura longitudinal de vocativos (asc: pega apelido antigo fora da janela recente)
    const orVoc = encodeURIComponent(`(${VOCATIVE_PATTERNS.map((p) => `content.ilike.*${p}*`).join(',')})`);
    const vocRaw = await sb(
      `messages?select=message_ts,content` +
      `&instance_id=eq.${encodeURIComponent(INST)}&chat_id=${inList(dmIds)}` +
      `&from_me=eq.false&is_deleted=eq.false&or=${orVoc}` +
      `&order=message_ts.asc&limit=${VOC_CAP}`
    );
    const vocativeHits = vocRaw.map((m) => ({ ts: m.message_ts, text: (m.content || '').trim().slice(0, CONTENT_MAX) }));

    // Evidência em grupos: mensagens do mesmo telefone em qualquer grupo da instância
    const groupRaw = await sb(
      `v_messages_with_sender?select=chat_id,chat_display_name,message_ts,message_type,content,caption,quoted_msg_id` +
      `&instance_id=eq.${encodeURIComponent(INST)}&chat_is_group=eq.true` +
      `&sender_phone=${inList(t.variants)}` +
      `&order=message_ts.desc&limit=${GROUP_CAP}`
    );
    // Quais respondem ao dono? (quoted_msg_id casando com msg from_me)
    // LIMITAÇÃO conhecida (verificado em prod 09/07/2026): o webhook grava quoted_msg_id
    // num espaço de id que NÃO bate com provider_msg_id — reply_to_me hoje nunca acende.
    // Mantido porque é barato e passa a funcionar se o webhook corrigir o id; a evidência
    // de grupo que vale é a MENÇÃO EXPLÍCITA ao dono (regra da skill).
    const quotedIds = [...new Set(groupRaw.map((m) => m.quoted_msg_id).filter(Boolean))];
    const mineQuoted = new Set();
    for (let i = 0; i < quotedIds.length; i += 100) {
      const chunk = quotedIds.slice(i, i + 100);
      const mine = await sb(
        `messages?select=provider_msg_id&instance_id=eq.${encodeURIComponent(INST)}` +
        `&from_me=eq.true&provider_msg_id=${inList(chunk)}`
      );
      mine.forEach((m) => mineQuoted.add(m.provider_msg_id));
    }
    const vocRe = new RegExp(VOCATIVE_PATTERNS.join('|'), 'i');
    const groupMsgs = groupRaw
      .map((m) => ({
        group: m.chat_display_name || m.chat_id,
        ts: m.message_ts,
        text: cleanText(m),
        reply_to_me: mineQuoted.has(m.quoted_msg_id),
        _m: m,
      }))
      .filter((m) => isUseful(m._m, m.text))
      .map(({ _m, ...m }) => m)
      .sort((a, b) => (b.reply_to_me - a.reply_to_me) || (vocRe.test(b.text) - vocRe.test(a.text)) || (a.ts < b.ts ? 1 : -1))
      .slice(0, GROUP_KEEP);

    contacts.push({
      instance_id: INST,
      chat_id: t.chat_id,
      chat_name: t.chat_name,
      phone_variants: t.variants,
      folded_chat_ids: t.folded_chat_ids,
      dm_msgs: dmMsgs,
      vocative_hits: vocativeHits,
      group_msgs: groupMsgs,
      stats: { dm_fetched: dmRaw.length, dm_kept: dmMsgs.length, dm_truncated: dmRaw.length === MSG_CAP, group_kept: groupMsgs.length },
    });
    console.error(`corpus: ${t.chat_name || t.chat_id} — ${dmMsgs.length} DM, ${vocativeHits.length} vocativo-hit, ${groupMsgs.length} grupo`);
  }

  const files = [];
  for (let i = 0; i < contacts.length; i += BATCH_SIZE) {
    const n = String(Math.floor(i / BATCH_SIZE) + 1).padStart(3, '0');
    const file = join(outDir, `voice-corpus-batch-${n}.json`);
    writeFileSync(file, JSON.stringify({ generated_at: new Date().toISOString(), instance_id: INST, contacts: contacts.slice(i, i + BATCH_SIZE) }, null, 2));
    files.push(file);
  }
  console.error(
    `corpus: ${contacts.length} contato(s) em ${files.length} batch(es) → ${outDir}\n` +
    `pulados: ${skippedFewMsgs} com menos de ${MIN_MESSAGES} msgs úteis, ${skippedNonNumeric} chat_id não-numérico.\n` +
    `restam mais alvos? re-rodar corpus (o filtro voice_profile=is.null continua de onde parou após o commit).`
  );
}

// --- commit ---
async function commit() {
  const file = argOf('--file');
  if (!file) {
    console.error('commit exige --file <perfis.json>');
    process.exit(1);
  }
  const rows = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(rows) || rows.length === 0) {
    console.error('commit: arquivo vazio ou não é um array — nada a fazer.');
    return;
  }
  let written = 0, skippedManual = 0, failed = 0;
  for (const r of rows) {
    const vp = r.voice_profile;
    if (!r.instance_id || !r.chat_id || !vp || typeof vp !== 'object' || Array.isArray(vp)) {
      console.error(`commit: linha inválida (exige instance_id, chat_id, voice_profile objeto): ${JSON.stringify(r).slice(0, 160)}`);
      failed++; continue;
    }
    if (!vp.como_me_chama?.length && !vp.girias?.length && !vp.registro) {
      console.error(`commit: ${r.chat_id} sem conteúdo (como_me_chama/girias/registro vazios) — pulado.`);
      failed++; continue;
    }
    const key = `instance_id=eq.${encodeURIComponent(r.instance_id)}&chat_id=eq.${encodeURIComponent(r.chat_id)}`;
    const [cur] = await sb(`chats?select=voice_profile&${key}`);
    if (!cur) {
      console.error(`commit: chat ${r.chat_id} (${r.instance_id}) não existe — pulado.`);
      failed++; continue;
    }
    if (cur.voice_profile?.fonte === 'manual' && !hasFlag('--force')) {
      console.error(`commit: ${r.chat_id} tem perfil fonte:'manual' — intocável sem --force.`);
      skippedManual++; continue;
    }
    const profile = { fonte: 'backfill', analisado_em: new Date().toISOString(), ...vp };
    const updated = await sb(`chats?${key}`, {
      method: 'PATCH',
      headers: { prefer: 'return=representation' },
      body: JSON.stringify({ voice_profile: profile }),
    });
    if (!updated || updated.length !== 1) {
      console.error(`commit: PATCH de ${r.chat_id} afetou ${updated?.length ?? 0} linha(s) (esperado 1) — verificar.`);
      failed++; continue;
    }
    written++;
  }
  console.error(`commit: ${written} perfil(is) gravado(s), ${skippedManual} manual(is) preservado(s), ${failed} falha(s)/pulado(s).`);
  if (failed > 0) process.exitCode = 1;
}

if (MODE === 'corpus') await corpus();
else if (MODE === 'commit') await commit();
else {
  console.error('Uso: voice-profile-backfill.mjs corpus --instance <alias> [--limit N] [--min-messages N] [--force] [--out <dir>] | commit --file perfis.json [--force]');
  process.exit(1);
}
