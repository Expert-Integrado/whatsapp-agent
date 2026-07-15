import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HARD_RULES, checkVoiceViolations, checkSoftSignals, computeVoiceScore } from "./voice-check.js";

// Load local .env if present (dev/local override, gitignored)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const localEnv = path.join(__dirname, ".env");
if (fs.existsSync(localEnv)) {
  fs.readFileSync(localEnv, "utf8").split("\n").forEach(line => {
    const [k, ...v] = line.trim().split("=");
    if (k && !k.startsWith("#") && !process.env[k]) process.env[k] = v.join("=");
  });
}

// Bootstrap secrets via 1Password CLI quando env vars ausentes.
// Evita armazenar tokens em texto plano em .env / ~/.claude.json. Requer `op` CLI
// logado na maquina (Windows: Windows Hello; macOS/Linux: senha do vault). Custa
// ~8-12s no primeiro boot, ~6-9s subsequentes (cache de sessao op). Customize o
// vault via env var OP_SECRETS_VAULT (default: "Agentes Eric").
//
// Usa `op inject` que resolve todas as refs numa unica chamada de processo —
// 6x mais rapido que `op read` sequencial (sequencial frio: ~56s, inject: ~9s).
const OP_VAULT = process.env.OP_SECRETS_VAULT || "Agentes Eric";
// Pos-cutover (gateway): o MCP NAO acessa o banco direto. Precisa so de
// SUPABASE_URL (pra montar a URL da edge) + MCP_API_KEY (auth na edge mcp-api)
// + OPENAI (opcional, Whisper). Z-API e service role vivem server-side.
const OP_REFS = {
  SUPABASE_URL:   `op://${OP_VAULT}/SUPABASE_URL_WHATSAPP/credential`,
  MCP_API_KEY:    `op://${OP_VAULT}/MCP_API_KEY_WHATSAPP/credential`,
  OPENAI_API_KEY: `op://${OP_VAULT}/OPENAI_API_KEY/credential`,
};
const missingKeys = Object.keys(OP_REFS).filter(k => !process.env[k]);
if (missingKeys.length > 0) {
  // Usa --in-file pra evitar problemas com stdin do op inject em Linux/container
  // (Node 20 + op CLI: stdin via spawnSync nao funciona em alguns ambientes).
  // O template so contem refs 'op://...', nao secrets em texto plano.
  const tmpFile = path.join(os.tmpdir(), `wa-mcp-op-${process.pid}-${Date.now()}.tpl`);
  const template = missingKeys.map(k => `${k}={{ ${OP_REFS[k]} }}`).join("\n");
  fs.writeFileSync(tmpFile, template, { mode: 0o600 });
  try {
    const r = spawnSync("op", ["inject", "--in-file", tmpFile], {
      encoding: "utf8",
      timeout: 30000,
    });
    if (r.status === 0 && r.stdout) {
      r.stdout.split("\n").forEach(line => {
        const idx = line.indexOf("=");
        if (idx > 0) {
          const k = line.slice(0, idx).trim();
          const v = line.slice(idx + 1).trim();
          if (k && v && !process.env[k]) process.env[k] = v;
        }
      });
    } else {
      const reason = r.error ? r.error.message : (r.stderr || `exit ${r.status}`);
      const opNotFound = r.error && (r.error.code === "ENOENT" || /not found|command not found/i.test(String(reason)));
      const missingList = missingKeys.join(", ");
      if (opNotFound) {
        console.error([
          `AVISO: '1Password CLI (op)' nao encontrado no PATH.`,
          `Variaveis faltando: ${missingList}.`,
          `Voce tem 2 opcoes:`,
          `  1) Instalar 1Password CLI e logar (https://developer.1password.com/docs/cli/get-started/),`,
          `     OU usar Service Account Token via env OP_SERVICE_ACCOUNT_TOKEN (Linux/container).`,
          `  2) Configurar as envs diretamente:`,
          `     - SUPABASE_URL`,
          `     - MCP_API_KEY`,
          `     - OPENAI_API_KEY (opcional — so pra transcricao automatica)`,
          `     Coloque no bloco "env" do mcpServers em ~/.claude.json, ou exporte no shell.`,
        ].join("\n"));
      } else {
        console.error([
          `AVISO: bootstrap 1Password falhou (${String(reason).slice(0, 160)}).`,
          `Variaveis faltando: ${missingList}.`,
          `Verifique se 'op' CLI esta logado (PC: 'op signin'; Linux/container: env OP_SERVICE_ACCOUNT_TOKEN).`,
          `Alternativa: configurar SUPABASE_URL/MCP_API_KEY direto no env do ~/.claude.json.`,
        ].join("\n"));
      }
    }
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const AGENT_NAME = process.env.AGENT_NAME || "unknown-agent";  // identifica esta instancia em audit log

// Pos-cutover (gateway): o MCP fala SO com a edge mcp-api via MCP_API_KEY.
// SUPABASE_URL ainda e usado pra montar a URL da edge. SERVICE_ROLE_KEY NAO e
// mais necessario (menor privilegio) — o trabalho de banco acontece na edge.
if (!SUPABASE_URL || !process.env.MCP_API_KEY) {
  console.error([
    "ERRO: SUPABASE_URL e MCP_API_KEY sao obrigatorios.",
    "Configure no bloco \"env\" do mcpServers em ~/.claude.json:",
    '  SUPABASE_URL  = https://gmpurkzxtvzqlvkqwjkp.supabase.co',
    "  MCP_API_KEY   = (chave da edge mcp-api; 1Password)",
  ].join("\n"));
  process.exit(1);
}

// ─── MCP API GATEWAY (item: MCP sem acesso direto ao banco) ───────────────────
// O MCP fala SO com a edge mcp-api (auth por API key), que faz o trabalho de DB
// internamente com service role. Cada tool vira um wrapper fino sobre callApi.
const MCP_API_URL = `${SUPABASE_URL}/functions/v1/mcp-api`;
const MCP_API_KEY = process.env.MCP_API_KEY;

async function callApi(action, params = {}) {
  if (!MCP_API_KEY) throw new Error("MCP_API_KEY nao configurada — necessaria pra falar com a mcp-api.");
  const res = await fetch(MCP_API_URL, {
    method: "POST",
    headers: { "x-mcp-key": MCP_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ action, params }),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  if (!res.ok && !parsed?.error) throw new Error(`mcp-api ${res.status}: ${text.slice(0, 200)}`);
  return parsed;
}

// ─── VOICE GUIDE ─────────────────────────────────────────────────────────────
// Carrega arquivo de voice guide do user (single-tenant per install).
// Procura em ordem: VOICE_GUIDE_PATH env > ./voice-guide.md (raiz MCP) > ~/.claude/voice-guide.md
// > OneDrive\Workspace\claude-sync\memory\voice-guide.md > eric-voice.md (legacy seed)
//
// Filosofia: warning, nunca bloqueio. send() executa normal mas avisa Claude se detectar
// violacao das regras hard. Cabe a Claude reescrever ou prosseguir consciente.
//
// Multi-instalacao: cada user gera o proprio voice-guide.md a partir do template.

const VOICE_GUIDE_CANDIDATES = [
  process.env.VOICE_GUIDE_PATH,
  path.join(process.cwd(), "voice-guide.md"),
  path.join(os.homedir(), ".claude", "voice-guide.md"),
  path.join(os.homedir(), "OneDrive", "Workspace", "claude-sync", "memory", "voice-guide.md"),
  path.join(os.homedir(), "OneDrive", "Workspace", "claude-sync", "memory", "eric-voice.md"),
].filter(Boolean);

function findVoiceGuide() {
  for (const candidate of VOICE_GUIDE_CANDIDATES) {
    try {
      if (fs.existsSync(candidate)) {
        return { path: candidate, content: fs.readFileSync(candidate, "utf8") };
      }
    } catch { /* ignora e tenta proximo */ }
  }
  return null;
}

// Regras hard, checkVoiceViolations, checkSoftSignals e computeVoiceScore
// vivem em ./voice-check.js (modulo puro, importado no topo do arquivo) —
// extraido pra ser testavel via test-voice.js sem precisar bootstrapar o
// server MCP inteiro (env vars, 1Password, stdio transport).

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function err(msg) {
  return { content: [{ type: "text", text: `ERRO: ${msg}` }], isError: true };
}

// ─── SERVER ──────────────────────────────────────────────────────────────────

const server = new McpServer({ name: "whatsapp-agent", version: "2.12.0" });

// Auto-calcula tempo de typing baseado em tipo+content (humanize=true).
// Heuristica: ~30 chars/seg = velocidade de digitacao confortavel.
// Cap em 5s (nao 15s): cap alto acumulava atraso em sends paralelos (fila
// do provider), o Eric nao via a msg chegar e reenviava -> duplicata
// (incidente 01/07/2026, Sartori/Joao Paulo/Lourivaldo). Task 376drb5eilif.
function humanizedTypingSeconds(type, content) {
  const len = (content || "").length;
  if (type === "text")            return Math.min(5, Math.max(1, Math.ceil(len / 30)));
  if (type === "audio" || type === "ptt") return 3;  // "Gravando audio..."
  if (type === "image" || type === "video") return 2;
  return 1; // document
}

// ─── 1. inbox ────────────────────────────────────────────────────────────────
server.tool(
  "inbox",
  `Mostra as conversas recentes do WhatsApp com as ultimas mensagens de cada uma.
Use para: "quem me mandou mensagem?", "o que tem no WhatsApp?".

Filtros disponiveis:
- since: ISO timestamp, so atividade apos a data
- waiting_on: "eric" (lead respondeu por ultimo, eu devo responder), "lead" (eu respondi por ultimo, espera deles), "none"
- exclude_groups: ignora grupos (default false)
- category_slugs: array de slugs (use list_categories pra ver opcoes). Se passar, so retorna chats que TEM PELO MENOS UMA dessas categorias.
- exclude_categories: array de slugs. Chats com QUALQUER uma dessas categorias sao filtrados fora.

Retorna: lista de chats com nome, ultima msg, timestamp, categorias atribuidas, waiting_on.
Mensagens de audio incluem campo transcription transcrito automaticamente.`,
  {
    limit: z.number().int().min(1).max(50).default(15),
    since: z.string().optional().describe("ISO timestamp — so chats com atividade apos esta data"),
    waiting_on: z.enum(["eric", "lead", "none"]).optional().describe("Filtra por quem deve responder agora"),
    exclude_groups: z.boolean().default(false).describe("Se true, ignora grupos (so 1:1)"),
    category_slugs: z.array(z.string()).optional().describe("So chats que tem pelo menos uma dessas categorias"),
    exclude_categories: z.array(z.string()).optional().describe("Chats com qualquer uma dessas categorias sao filtrados fora"),
    instance: z.string().optional().describe("Filtra por instancia (alias 'pessoal'/'profissional' ou instance_id). Omitir = inbox unificado com rotulo de instancia por chat."),
  },
  async (args) => {
    try {
      const r = await callApi("inbox", args);
      return r.error ? err(r.error) : ok(r);
    } catch (e) {
      return err(e.message);
    }
  }
);

// ─── 2. read ─────────────────────────────────────────────────────────────────
server.tool(
  "read",
  `Le as mensagens de uma conversa especifica.
Use para: "o que o Marcos disse?", "mostra as msgs do grupo G4", "qual foi a ultima msg da Maria?".
O parametro "chat" aceita: nome do contato, nome do grupo, numero de telefone, ou chat_id.
Se o nome for ambiguo, retorna lista de candidatos para voce escolher.
Retorna mensagens em ordem cronologica com conteudo, tipo, remetente e timestamp.
Mensagens de audio incluem campo transcription com o conteudo transcrito automaticamente (requer OPENAI_API_KEY).`,
  {
    chat: z.string().describe("Nome, telefone ou chat_id da conversa"),
    limit: z.number().int().min(1).max(100).default(30).describe("Numero de mensagens (mais recentes)"),
    before: z.string().optional().describe("ISO timestamp — mensagens anteriores a esta data (para paginar)"),
    instance: z.string().optional().describe("Instancia (alias 'pessoal'/'profissional' ou instance_id) — desambigua quando o mesmo contato existe nos dois numeros."),
  },
  async (args) => {
    try {
      const r = await callApi("read", args);
      return r.error ? err(r.error) : ok(r);
    } catch (e) {
      return err(e.message);
    }
  }
);

// ─── 3. send ─────────────────────────────────────────────────────────────────
server.tool(
  "send",
  `Envia mensagem para qualquer contato ou grupo.
Use para: "manda pra Marcos: oi", "envia a imagem X pra Maria", "responde aquela msg dizendo Y".
O parametro "to" aceita nome, telefone ou chat_id (igual ao "read").
Tipos suportados: text (padrao), image, audio, ptt (voz com waveform), video, document.
Para reply (responder mensagem especifica): passe reply_to com o UUID da mensagem.
Para midia: passe media_url com URL publica do arquivo.

VOICE GUIDE (CRITICO ANTES DE ENVIAR TEXTO EM NOME DO USER):
- Chame get_voice_guide() pra ler como o user se comunica antes de redigir
- OU chame check_message(content) pra validar draft contra regras hard (em-dash, hype, saudacao generica, tu/teu/tua etc.)
- send() roda voice check internamente e retorna warnings em \`voice\` na resposta, mas a boa pratica e revisar ANTES de enviar
- Filosofia: send() executa mesmo com violacoes (warning, nao bloqueio). Cabe a Claude decidir reescrever ou prosseguir consciente.

Simulacao de comportamento humano (Z-API delayMessage/delayTyping):
- humanize=true (padrao): calcula automaticamente delay_typing baseado em tamanho+tipo
  do conteudo (ex: texto curto=1s, texto longo=5s, audio=3s "gravando audio").
  Cap em 5s pra nao acumular atraso em sends paralelos. Override explicito via delay_typing.
- delay_typing (0-15s): tempo mostrando "Digitando..." / "Gravando audio..." pro destinatario
- delay_message (0-15s): atraso geral antes de enviar (alem do typing)

FLUXO OBRIGATORIO (duas chamadas):
1a chamada — SEM confirmed: mostre ao usuario destinatario + conteudo, aguarde confirmacao. O MCP vai bloquear e retornar o resumo para exibir ao usuario.
2a chamada — COM confirmed: true: so apos o usuario confirmar explicitamente ("sim", "confirma", "pode enviar").`,
  {
    to: z.string().describe("Destinatario: nome, telefone ou chat_id"),
    content: z.string().default("").describe("Texto ou legenda da midia"),
    type: z.enum(["text", "image", "audio", "ptt", "video", "document"]).default("text"),
    media_url: z.string().url().optional().describe("URL publica da midia (obrigatorio se type != text)"),
    file_name: z.string().optional().describe("Nome do arquivo para type=document (ex: 'proposta.pdf'). Se omitido, usa content como fallback."),
    reply_to: z.string().optional().describe("UUID da mensagem para responder (quote reply)"),
    confirmed: z.boolean().default(false).describe("OBRIGATORIO true para enviar. So passe true apos mostrar destinatario+conteudo ao usuario e receber confirmacao explicita."),
    allow_new: z.boolean().default(false).describe("Se true, permite enviar para numeros que ainda nao existem em chats (primeiro contato). Cria entrada em chats automaticamente. Use para dispatch consciente."),
    humanize: z.boolean().default(true).describe("Se true (padrao), calcula delay_typing automaticamente baseado em tamanho+tipo. Passe false pra desligar simulacao humana."),
    delay_typing: z.number().int().min(0).max(15).optional().describe("Override do delay de digitacao (0-15s). Se passado, ignora humanize."),
    delay_message: z.number().int().min(0).max(15).optional().describe("Atraso geral antes de enviar (0-15s, alem do typing)."),
    mentions: z.array(z.string()).optional().describe("Phones pra mencionar (ex: [\"5511999998888\"]). So funciona em grupos."),
    mentions_everyone: z.boolean().optional().describe("Se true, menciona @todos no grupo."),
    force_send_after_inbound: z.boolean().default(false).describe("Se true, ignora o gate de inbound recente nao respondido. Default false: se a pessoa enviou algo nos ultimos 10 minutos e voce ainda nao respondeu, o send eh bloqueado pra evitar perder contexto. Use true APOS confirmar com Eric que ele quer enviar mesmo assim."),
    instance: z.string().optional().describe("De qual numero enviar (alias 'pessoal'/'profissional' ou instance_id). Padrao: herda a instancia do chat. Use pra FORCAR outro numero (ex: responder pelo profissional um chat que veio do pessoal). Obrigatorio em primeiro contato (allow_new) pois nao ha chat pra herdar."),
    link: z.object({
      url: z.string().url().describe("URL do link"),
      title: z.string().optional().describe("Titulo do card (default: a URL)"),
      description: z.string().optional().describe("Descricao curta do card"),
      image: z.string().optional().describe("URL da imagem do card (ex: og:image da pagina)"),
      previewSize: z.enum(["SMALL", "MEDIUM", "LARGE"]).optional().describe("Tamanho do card"),
    }).optional().describe("Card de preview de link (so type=text). Renderiza a URL como card com imagem/titulo/descricao; a URL e anexada ao content automaticamente se nao estiver nele."),
  },
  async ({ to, content, type, media_url, file_name, reply_to, confirmed, allow_new, humanize, delay_typing, delay_message, mentions, mentions_everyone, force_send_after_inbound, instance, link }) => {
    if (!confirmed) {
      return {
        content: [{
          type: "text",
          text: [
            "BLOQUEADO: confirmacao pendente.",
            "",
            "Mostre ao usuario:",
            `  Destinatario : ${to}`,
            `  Mensagem     : ${content || "(midia)"}`,
            `  Tipo         : ${type}`,
            ...(media_url ? [`  URL midia    : ${media_url}`] : []),
            "",
            'Apos o usuario confirmar ("sim", "confirma", "pode enviar"), chame novamente com confirmed: true.',
          ].join("\n"),
        }],
        isError: true,
      };
    }

    try {
      // Humanize (delay de digitacao) fica LOCAL no MCP; resolveChat, allow_new,
      // gate de inbound recente e o envio acontecem na edge mcp-api.
      const effectiveDelayTyping =
        delay_typing !== undefined
          ? delay_typing
          : (humanize ? humanizedTypingSeconds(type, content) : undefined);

      const r = await callApi("send", {
        to, content, type, allow_new, force_send_after_inbound, instance,
        confirmed: true, // gate de confirmacao ja passou aqui no MCP; a edge exige o flag
        agent_name: AGENT_NAME,
        ...(link && { link }),
        ...(media_url && { media_url }),
        ...(file_name && { file_name }),
        ...(reply_to && { reply_to }),
        ...(effectiveDelayTyping !== undefined && { delay_typing: effectiveDelayTyping }),
        ...(delay_message !== undefined && { delay_message }),
        ...(mentions?.length && { mentions }),
        ...(mentions_everyone && { mentions_everyone: true }),
      });
      if (r.error) return err(r.error);

      // Voice guide check — WARNING only, roda local (so texto, envio real).
      let voiceWarning = null;
      if (type === "text" && content && !r.blocked && !r.ambiguous) {
        const violations = checkVoiceViolations(content);
        const softWarnings = checkSoftSignals(content);
        if (violations.length > 0 || softWarnings.length > 0) {
          const guide = findVoiceGuide();
          voiceWarning = {
            voice_guide_violations: violations.length,
            violations: violations.map(v => `[${v.severity}] ${v.id} ("${v.match}"): ${v.message}`),
            soft_warnings: softWarnings,
            voice_guide_loaded: !!guide,
            voice_guide_path: guide?.path,
            note: "Mensagem foi enviada mesmo assim. Pra proxima, considere reescrever respeitando regras hard. Use get_voice_guide() pra ler o documento.",
          };
        } else if (findVoiceGuide()) {
          voiceWarning = { voice_guide_check: "passed", soft_warnings: [], note: "Mensagem compativel com voice guide." };
        }
      }

      return ok({ ...r, ...(voiceWarning && { voice: voiceWarning }) });
    } catch (e) {
      return err(e.message);
    }
  }
);

// ─── 3.5. send_voice — TTS via ElevenLabs + envio Z-API PTT ──────────────────
//
// Wrapper thin que chama a mcp-api (case send_voice) → edge send-voice. Edge faz:
// resolve perfil no catalogo voice_profiles (0051, settings TRAVADOS server-side),
// humanizacao oral pelo nivel do perfil, TTS via ElevenLabs (OGG/Opus mono 48kHz),
// upload pro Storage, signed URL e provider WA com waveform=true (PTT).
//
// A antiga skill 'voz' foi ABSORVIDA (12/07/2026): o catalogo agora vive no banco
// e a decisao de perfil e feita por esta description — nao ha mais skill.
server.tool(
  "send_voice",
  `Gera audio TTS via ElevenLabs e envia como mensagem de voz (PTT) via WhatsApp.

QUANDO USAR: SO quando o user pediu audio EXPLICITAMENTE ("manda audio", "responde em audio", "mensagem de voz", "/voz"). Texto e o canal default — nunca gerar audio "porque combina".

PERFIS (catalogo voice_profiles no banco; settings TRAVADOS server-side — prefira profile a voice_id):
- eric-casual — DEFAULT. Conversa em curso, cliente atual, tom dia-a-dia
- eric-casual-animado — comemoracao (parabens, bora, fechou, deu certo, arrasou)
- eric-profissional — lead novo, decisor senior, primeira abordagem, B2B serio
- eric-prospeccao — prospeccao em massa (config legada)
- eric-v2 — versao alternativa Eric v2.0 (uso pontual)
- jully — assistente; audio pro proprio Eric
Perfil inexistente/bloqueado = erro com a lista dos ativos. Voz "1309" (qualquer rotulo: 13/09, versao de setembro...) esta BLOQUEADA ate calibrar. Rotulo vago ("voz antiga do Eric") = NAO adivinhar: listar candidatos (eric-v2, eric-prospeccao, 1309) e o user aponta.

HUMANIZACAO: server-side conforme o perfil (forte/leve/nenhum). NAO pre-humanizar — envie texto LIMPO com acentuacao correta; o retorno traz text_spoken (o que foi falado). Max ~150 palavras (~60s de audio).

DESTINATARIO: mesmo formato do send(); chat confirmado por read/inbox — NUNCA inferir numero. Retorno ambiguous = mostrar candidatos ao user, nao escolher sozinho.

FLUXO OBRIGATORIO (duas chamadas):
1a chamada — SEM confirmed: mostre ao user destinatario + perfil + texto, aguarde confirmacao explicita
2a chamada — COM confirmed: true
EXCECAO: audio pro proprio Eric que ele ja pediu explicito → confirmed: true direto.

LEGACY: voice_id explicito + settings manuais ainda funciona (sem humanizacao); sem profile e sem voice_id = voz default da instancia.

IDEMPOTENCY: tool gera agent_request_id automatico. 2x mesma call em 24h retorna cache.
ATENCAO QUOTA: ElevenLabs tem quota mensal (nao ha tool de saldo) — antes de burst de 3+ audios, avisar que a quota precisa ser conferida no dashboard.`,
  {
    to: z.string().describe("Destinatario: chat_id ou phone (igual a send())"),
    text: z.string().min(1).max(5000).describe("Texto a converter em fala. Limpo, com acentos — humanizacao e server-side"),
    profile: z.string().optional().describe("Perfil do catalogo (ex: eric-casual). Trava voice_id/model/settings server-side. Nao combinar com voice_id"),
    voice_id: z.string().optional().describe("ElevenLabs voice ID (legado/avancado — prefira profile)"),
    model_id: z.string().optional().describe("Modelo ElevenLabs (default eleven_turbo_v2_5; ignorado com profile)"),
    stability: z.number().min(0).max(1).optional().describe("0-1 (default 0.45; ignorado com profile)"),
    similarity_boost: z.number().min(0).max(1).optional().describe("0-1 (default 0.75; ignorado com profile)"),
    style: z.number().min(0).max(1).optional().describe("0-1 (default 0.30; ignorado com profile)"),
    speed: z.number().min(0.7).max(1.2).optional().describe("0.7-1.2 (default 0.95; ignorado com profile)"),
    confirmed: z.boolean().default(false).describe("OBRIGATORIO true. So passe true apos confirmacao explicita do user."),
    instance: z.string().optional().describe("De qual numero enviar (alias 'pessoal'/'profissional' ou instance_id). Padrao: herda do chat."),
  },
  async ({ to, text, profile, voice_id, model_id, stability, similarity_boost, style, speed, confirmed, instance }) => {
    if (!confirmed) {
      return {
        content: [{ type: "text", text: [
          "BLOQUEADO: confirmacao pendente.",
          "",
          `Audio pra: ${to}`,
          `Perfil   : ${profile ?? voice_id ?? "(voz default da instancia)"}`,
          ...(profile ? [] : [`Settings : stab=${stability ?? 0.45} sim=${similarity_boost ?? 0.75} style=${style ?? 0.30} speed=${speed ?? 0.95}`]),
          `Texto    : "${text}"`,
          "",
          'Apos confirmacao explicita do user, chame novamente com confirmed: true.',
        ].join("\n") }],
        isError: true,
      };
    }
    try {
      const r = await callApi("send_voice", {
        to, text, profile, voice_id, model_id, stability, similarity_boost, style, speed, instance,
        confirmed: true, // gate de confirmacao ja passou aqui no MCP; a edge exige o flag
        agent_name: AGENT_NAME,
      });
      return r.error ? err(r.error) : ok(r);
    } catch (e) {
      return err(e.message);
    }
  }
);

// ─── 3.6. schedule / list_scheduled / cancel_scheduled ───────────────────────
// Agendamento de sequencias de mensagens (envio unico futuro). Validacao pesada
// e insert acontecem na mcp-api (case "schedule"); o worker dispatch-scheduled
// (cron 1/min) dispara reusando as edges de envio. Gate confirmed satisfeito AQUI
// na criacao — o disparo roda confirmed=true sem nova confirmacao.

const scheduleItemSchema = z.object({
  type: z.enum(["text", "image", "audio", "ptt", "video", "document", "voice", "poll"])
    .describe("voice = TTS ElevenLabs gerado no disparo; poll = enquete"),
  content: z.string().optional().describe("Texto, legenda da midia, ou (voice) texto a virar fala (max 5000)"),
  media_url: z.string().url().optional().describe("URL PUBLICA da midia (obrigatorio pra image/audio/ptt/video/document); precisa estar valida NA HORA DO DISPARO — nao use signed URL curta"),
  file_name: z.string().optional().describe("Nome do arquivo para type=document"),
  link: z.object({
    url: z.string().url(),
    title: z.string().optional(),
    description: z.string().optional(),
    image: z.string().optional(),
    previewSize: z.enum(["SMALL", "MEDIUM", "LARGE"]).optional(),
  }).optional().describe("Card de preview de link (so type=text); mesmo shape do send"),
  voice_id: z.string().optional().describe("(voice) ElevenLabs voice ID; default: default_voice_id da instancia"),
  model_id: z.string().optional(),
  stability: z.number().min(0).max(1).optional(),
  similarity_boost: z.number().min(0).max(1).optional(),
  style: z.number().min(0).max(1).optional(),
  speed: z.number().min(0.7).max(1.2).optional(),
  question: z.string().optional().describe("(poll) pergunta da enquete"),
  options: z.array(z.string()).optional().describe("(poll) 2-12 opcoes"),
  selectableCount: z.number().int().optional().describe("(poll) quantas opcoes podem ser marcadas (default 1)"),
  delay_after: z.number().min(0).max(300).optional().describe("Segundos de pausa APOS este item antes do proximo (0-300). Default: humanizado (~1-15s)"),
});

server.tool(
  "schedule",
  `Agenda uma SEQUENCIA de mensagens (1-10 itens, enviados em ordem) pra envio futuro UNICO.
Use para: "agenda pra amanha 9h uma imagem com legenda + um audio + um texto pro Marcos".

- Tipos por item: text, image, audio, ptt, video, document, voice (TTS gerado no disparo), poll (enquete).
- Sem recorrencia e sem edicao: pra mudar, cancel_scheduled + schedule de novo.
- No disparo o gate de inbound recente NAO se aplica (o agendamento ja foi confirmado aqui).
- Precisao: minuto a minuto (cron 1/min), nao segundo exato.
- Sequencia longa de itens curtos pode bater no rate limit por chat/min — use delay_after >= 15.

FLUXO OBRIGATORIO (duas chamadas):
1a chamada — SEM confirmed: o MCP bloqueia e retorna o resumo (destinatario, horario BRT, itens). Mostre ao usuario.
2a chamada — COM confirmed: true: so apos o usuario confirmar explicitamente.`,
  {
    to: z.string().describe("Destinatario: nome, telefone ou chat_id (o chat precisa existir)"),
    at: z.string().describe("Quando enviar: ISO-8601 COM offset (ex: 2026-07-15T09:30:00-03:00). Precisa ser futuro."),
    items: z.array(scheduleItemSchema).min(1).max(10).describe("Sequencia ordenada de mensagens"),
    instance: z.string().optional().describe("Instancia (alias ou instance_id); default: herda a do chat"),
    confirmed: z.boolean().default(false).describe("OBRIGATORIO true; so apos o usuario confirmar o resumo do agendamento"),
  },
  async ({ to, at, items, instance, confirmed }) => {
    if (!confirmed) {
      return {
        content: [{ type: "text", text: [
          "BLOQUEADO: confirmacao pendente.",
          "",
          "Mostre ao usuario:",
          `  Destinatario : ${to}`,
          `  Quando       : ${at}`,
          `  Sequencia    :`,
          ...items.map((it, i) => `    ${i + 1}. [${it.type}] ${(it.content ?? it.question ?? it.media_url ?? "").slice(0, 80)}`),
          "",
          'Apos o usuario confirmar ("sim", "confirma", "pode agendar"), chame novamente com confirmed: true.',
        ].join("\n") }],
        isError: true,
      };
    }
    try {
      const r = await callApi("schedule", { to, at, items, instance, confirmed: true, agent_name: AGENT_NAME });
      return r.error ? err(r.error) : ok(r);
    } catch (e) {
      return err(e.message);
    }
  }
);

server.tool(
  "list_scheduled",
  `Lista sequencias de mensagens agendadas (default: so pending).
Use para: "o que tem agendado?", "aquele envio de amanha ainda ta de pe?".
Retorna id (pra cancel_scheduled), horario BRT, progresso (items_sent/total) e erro se falhou.`,
  {
    status: z.enum(["pending", "processing", "sent", "failed", "canceled", "all"]).default("pending").describe("Filtro de status"),
    chat: z.string().optional().describe("Filtra por conversa (nome, telefone ou chat_id)"),
    instance: z.string().optional().describe("Filtra por instancia (alias ou instance_id)"),
    limit: z.number().int().min(1).max(50).default(20),
  },
  async (args) => {
    try {
      const r = await callApi("list_scheduled", args);
      return r.error ? err(r.error) : ok(r);
    } catch (e) {
      return err(e.message);
    }
  }
);

server.tool(
  "cancel_scheduled",
  `Cancela uma sequencia agendada ainda pending (id vem de list_scheduled ou do schedule).
Ja em processing/sent/failed nao da pra cancelar.`,
  {
    id: z.string().describe("UUID do agendamento"),
  },
  async (args) => {
    try {
      const r = await callApi("cancel_scheduled", args);
      return r.error ? err(r.error) : ok(r);
    } catch (e) {
      return err(e.message);
    }
  }
);

// ─── 4. search ───────────────────────────────────────────────────────────────
server.tool(
  "search",
  `Busca texto nas mensagens do WhatsApp.
Use para: "vc falou alguma coisa sobre reuniao?", "o que o Pedro disse sobre o contrato?".
Pode filtrar por chat especifico (parametro "chat"), categoria (category_slugs), e periodo (after/before).
Retorna mensagens com contexto: chat de origem, remetente e timestamp.
Mensagens de audio nos resultados incluem campo transcription automaticamente.`,
  {
    query: z.string().min(2).describe("Texto a buscar"),
    chat: z.string().optional().describe("Limitar busca a um chat especifico (nome ou chat_id)"),
    search_in: z.enum(["content", "chat_name", "both"]).default("both").describe("Onde buscar: content (texto das msgs), chat_name (nome do contato/grupo), ou both (default)"),
    category_slugs: z.array(z.string()).optional().describe("Limitar busca a chats com pelo menos uma destas categorias (ex: ['saude','familia'])"),
    exclude_categories: z.array(z.string()).optional().describe("Filtrar fora chats com qualquer uma destas categorias"),
    limit: z.number().int().min(1).max(50).default(20),
    after: z.string().optional().describe("ISO timestamp — so mensagens apos esta data"),
    before: z.string().optional().describe("ISO timestamp — so mensagens antes desta data"),
    instance: z.string().optional().describe("Limitar busca a uma instancia (alias 'pessoal'/'profissional' ou instance_id). Omitir = busca nos dois numeros."),
  },
  async (args) => {
    try {
      const r = await callApi("search", args);
      return r.error ? err(r.error) : ok(r);
    } catch (e) {
      return err(e.message);
    }
  }
);

// ─── transcribe_audio ────────────────────────────────────────────────────────
server.tool(
  "transcribe_audio",
  `Forca transcricao de audios antigos que nao foram processados pelo cron automatico
(ex: audios de grupos, audios mais antigos que 29 dias, ou audios que falharam).

Aceita um message_id especifico OU um chat (transcreve ate 20 audios pendentes do chat).
Salva o resultado em messages.content (cache permanente).
Reaproveita a logica do cron transcribe-queue: prefere Supabase Storage, fallback CDN.`,
  {
    message_id: z.string().optional().describe("UUID da mensagem (de read/search). Transcreve so essa."),
    chat: z.string().optional().describe("Nome/phone/chat_id. Transcreve ate 20 audios pendentes desse chat."),
    limit: z.number().int().min(1).max(20).default(20).describe("Maximo de audios por chamada (so com chat). Default 20."),
    instance: z.string().optional().describe("Instancia (alias ou instance_id) — desambigua quando o contato existe nos dois numeros."),
  },
  async (args) => {
    try {
      const r = await callApi("transcribe", args);
      return r.error ? err(r.error) : ok(r);
    } catch (e) {
      return err(e.message);
    }
  }
);

// ─── 5. react ────────────────────────────────────────────────────────────────
server.tool(
  "react",
  `Reage a uma mensagem com emoji.
Use para: "reage com joinha naquela msg", "coloca um coracao na ultima mensagem do Marcos".
Precisa do message_id (UUID da tabela messages — obtenha via read ou search).`,
  {
    message_id: z.string().describe("UUID da mensagem (campo id retornado por read/search)"),
    emoji: z.string().describe("Emoji de reacao. Ex: '❤️', '👍', '😂', '🔥'. String vazia remove reacao."),
  },
  async (args) => {
    try {
      const r = await callApi("react", args);
      return r.error ? err(r.error) : ok(r);
    } catch (e) {
      return err(e.message);
    }
  }
);

// ─── 6. status ───────────────────────────────────────────────────────────────
server.tool(
  "status",
  `Verifica se o WhatsApp esta conectado e funcionando.
Use quando: o usuario pedir status, antes de enviar mensagens importantes, ou ao investigar por que nao chegam msgs.`,
  {},
  async () => {
    try {
      const r = await callApi("status", {});
      return r.error ? err(r.error) : ok(r);
    } catch (e) {
      return err(e.message);
    }
  }
);

// ─── 7. sync_groups ──────────────────────────────────────────────────────────
server.tool(
  "sync_groups",
  `Sincroniza nomes de grupos do WhatsApp buscando diretamente da Z-API (GET /chats).
Use quando nomes de grupos estiverem faltando ou desatualizados no banco do Supabase.
O webhook da Z-API nem sempre envia chatName para grupos — esta tool corrige isso manualmente.
Retorna: total de grupos encontrados na Z-API, quantos foram atualizados no banco, e quais nao foram encontrados.`,
  {
    dry_run: z.boolean().default(false).describe("Se true, lista o que seria atualizado sem salvar nada no banco"),
    instance: z.string().optional().describe("De qual instancia sincronizar grupos (alias 'pessoal'/'profissional' ou instance_id). Padrao: instancia default."),
  },
  async (args) => {
    try {
      const r = await callApi("sync_groups", args);
      return r.error ? err(r.error) : ok(r);
    } catch (e) {
      return err(e.message);
    }
  }
);

// ─── CATEGORIES TOOLS ────────────────────────────────────────────────────────

server.tool(
  "list_categories",
  `Lista todas as categorias disponiveis pra classificar chats.
Use antes de chamar categorize_chat pra saber quais slugs sao validos.
Retorna: array de { slug, label, color, description, parent_slug }.

Slugs sao normalizados (lowercase ascii). Eric pode adicionar categorias novas
diretamente no DB ou via tool no futuro — sempre listar primeiro.`,
  {},
  async () => {
    try {
      const r = await callApi("list_categories", {});
      return r.error ? err(r.error) : ok(r);
    } catch (e) {
      return err(e.message);
    }
  }
);

server.tool(
  "categorize_chat",
  `Atribui uma ou mais categorias a um chat. Idempotente: rerun com mesma combinacao
nao falha (ON CONFLICT DO NOTHING).

Use depois de list_categories pra saber slugs validos. Se passar slug invalido
retorna erro com a lista de slugs aceitos.

Param assigned_by indica origem da atribuicao:
- "manual" — Eric atribuiu (default)
- "llm"    — Modelo categorizou; passa confidence (0-1)
- "rule:X" — Regra automatica (futuro)

Multi-valor: 1 chat pode ter varias categorias (ex: cliente + saude pra um plano
de saude que o Eric paga). Slug unico por chat (PK chat_id+category_id).

Retorna: { chat_id, chat_name, applied: [...slugs aplicados], skipped: [...slugs ja existiam] }.`,
  {
    chat: z.string().describe("Nome, telefone ou chat_id da conversa (mesmo formato de read/send)"),
    category_slugs: z.array(z.string()).min(1).describe("Lista de slugs (ex: ['cliente', 'saude']). Use list_categories pra ver opcoes."),
    assigned_by: z.enum(["manual", "llm"]).default("manual"),
    confidence: z.number().min(0).max(1).optional().describe("Obrigatorio quando assigned_by=llm"),
    notes: z.string().optional().describe("Justificativa opcional (especialmente util pra llm)"),
    instance: z.string().optional().describe("Instancia (alias ou instance_id) — desambigua quando o contato existe nos dois numeros."),
  },
  async (args) => {
    try {
      const r = await callApi("categorize", args);
      return r.error ? err(r.error) : ok(r);
    } catch (e) {
      return err(e.message);
    }
  }
);

server.tool(
  "uncategorize_chat",
  `Remove uma ou mais categorias de um chat. Categorias nao atribuidas sao ignoradas
(no-op, nao retorna erro).

Use quando perceber que categorizou errado, ou quando a relacao mudou
(ex: cliente virou ex-cliente).

Retorna: { chat_id, chat_name, removed: [...slugs removidos] }.`,
  {
    chat: z.string().describe("Nome, telefone ou chat_id da conversa"),
    category_slugs: z.array(z.string()).min(1).describe("Slugs a remover"),
    instance: z.string().optional().describe("Instancia (alias ou instance_id) — desambigua quando o contato existe nos dois numeros."),
  },
  async (args) => {
    try {
      const r = await callApi("uncategorize", args);
      return r.error ? err(r.error) : ok(r);
    } catch (e) {
      return err(e.message);
    }
  }
);

// Actions que enviam conteudo visivel para outros — requerem confirmed: true
const ZAPI_SEND_ACTIONS = new Set([
  "send-poll",
  "forward-message",
  "edit-message",
  "send-text",
  "send-message",
]);


// ─── VOICE GUIDE TOOLS ───────────────────────────────────────────────────────

server.tool(
  "get_voice_guide",
  `Retorna o voice guide do user (markdown completo).

O voice guide descreve como o user se comunica — lexico, sintaxe, modulacao por audiencia,
padroes retoricos, anti-padroes — pra que o agente possa simular a voz dele com fidelidade.

Use SEMPRE antes de redigir mensagem em nome do user, simular voz dele, ou avaliar
se um texto soa como ele.

Procura nos paths (em ordem): VOICE_GUIDE_PATH env > ./voice-guide.md > ~/.claude/voice-guide.md
> OneDrive\\Workspace\\claude-sync\\memory\\voice-guide.md > eric-voice.md (legacy seed).

Se nao encontrar, retorna instrucoes pra setup. Cada user tem o proprio voice guide
em sua maquina (single-tenant per install).`,
  {},
  async () => {
    const guide = findVoiceGuide();
    if (!guide) {
      return {
        content: [{
          type: "text",
          text: [
            "VOICE GUIDE NAO ENCONTRADO.",
            "",
            "Pra ativar a checagem de voz nas mensagens, crie um arquivo `voice-guide.md` em UM destes locais:",
            ...VOICE_GUIDE_CANDIDATES.map(p => `  - ${p}`),
            "",
            "Ou defina a env var VOICE_GUIDE_PATH apontando pra qualquer caminho.",
            "",
            "Template inicial: copie `voice-guide-template.md` da pasta deste MCP e personalize.",
            "Pra gerar empiricamente a partir do seu historico de WhatsApp: rode o pipeline em scripts/voice-pipeline/ (ver README).",
          ].join("\n"),
        }],
        isError: false, // nao e erro, so estado de setup pendente
      };
    }
    return {
      content: [{
        type: "text",
        text: [
          `# Voice Guide carregado de: ${guide.path}`,
          "",
          guide.content,
        ].join("\n"),
      }],
    };
  }
);

server.tool(
  "check_message",
  `Verifica se um texto viola alguma regra hard do voice guide do user.

Roda checagem regex contra padroes hard (pronomes, em-dash, hype, saudacoes proibidas,
validacao afetiva, vocativos inventados pra Camila, concordancia lisa, etc) e retorna
lista de violacoes detectadas com severidade e sugestao. Roda tambem checks estatisticos
soft (soft_warnings): assinaturas fortes empilhadas, msg longa sem quebra, burst inflado.

Retorna um score 0-10 (10 - 3*high - 1.5*medium - 0.5*low - 0.5*soft, floor 0).
Score < 7 sugere regenerar a mensagem antes de enviar.

Use ANTES de chamar send() pra revisar/reescrever se houver violacoes.
A tool send() ja roda esta checagem internamente — esta tool e pra checar drafts
sem enviar.

Filosofia: warning, nao bloqueio. send() executa mesmo com violacoes mas inclui aviso.
Cabe a Claude decidir reescrever ou prosseguir consciente.`,
  {
    content: z.string().describe("Texto a verificar"),
    estrato: z.enum(["vendas-lead", "cliente", "equipe", "network", "intimo-amigo", "intimo-camila"]).optional()
      .describe("Estrato/audiencia da mensagem (ver voice guide secao 3). Informativo — nao muda quais regras rodam, mas e ecoado no retorno pra contexto."),
  },
  async ({ content, estrato }) => {
    const violations = checkVoiceViolations(content);
    const softWarnings = checkSoftSignals(content);
    const score = computeVoiceScore(violations, softWarnings);
    const guide = findVoiceGuide();

    if (violations.length === 0 && softWarnings.length === 0) {
      return ok({
        ok: true,
        violations_count: 0,
        soft_warnings: [],
        score,
        estrato: estrato ?? null,
        message: "Nenhuma violacao hard nem soft warning detectados. Texto compativel com voice guide.",
      });
    }
    return ok({
      ok: violations.length === 0,
      violations_count: violations.length,
      violations,
      soft_warnings: softWarnings,
      score,
      estrato: estrato ?? null,
      voice_guide_loaded: !!guide,
      voice_guide_path: guide?.path,
      hint: score < 7
        ? "Score abaixo de 7: considere regenerar a mensagem. Use get_voice_guide() pra ler o documento completo e reescrever respeitando as regras hard."
        : "Score aceitavel, mas revise os warnings antes de enviar se houver algum.",
    });
  }
);

server.tool(
  "setup_voice_guide",
  `Mostra status atual do voice guide e instrucoes pra setup.

Use quando o user perguntar "como ativo a checagem de voz", "tem voice guide configurado?",
ou quando get_voice_guide() retornar setup pendente.`,
  {},
  async () => {
    const guide = findVoiceGuide();
    const lines = ["=== Voice Guide Setup ==="];
    if (guide) {
      lines.push(`Status: ATIVO`);
      lines.push(`Path: ${guide.path}`);
      lines.push(`Tamanho: ${guide.content.length} chars / ${guide.content.split("\n").length} linhas`);
      lines.push("");
      lines.push("Cada send() vai rodar checagem regex contra as regras hard e incluir warning no retorno se detectar violacao.");
      lines.push("Pra validar um draft sem enviar, use check_message(content).");
    } else {
      lines.push(`Status: NAO CONFIGURADO`);
      lines.push("");
      lines.push("Paths procurados (em ordem):");
      VOICE_GUIDE_CANDIDATES.forEach(p => lines.push(`  - ${p}`));
      lines.push("");
      lines.push("Pra ativar:");
      lines.push("  1. Crie arquivo voice-guide.md em qualquer um dos paths acima");
      lines.push("  2. Ou defina VOICE_GUIDE_PATH no env apontando pro arquivo");
      lines.push("  3. Reinicie o MCP (Claude Code: /mcp restart whatsapp-agent)");
      lines.push("");
      lines.push("Template inicial disponivel em voice-guide-template.md na pasta do MCP.");
    }
    lines.push("");
    lines.push("Regras hard ativas (regex bloqueio nivel WARNING — send executa mesmo com violacao):");
    HARD_RULES.forEach(r => lines.push(`  - [${r.severity}] ${r.id}: ${r.message.split(".")[0]}`));
    return ok({ status: guide ? "active" : "not_configured", info: lines.join("\n") });
  }
);

// ─── 8. zapi_action ──────────────────────────────────────────────────────────
server.tool(
  "zapi_action",
  `Executa qualquer acao avancada da Z-API diretamente.
Use quando as tools acima nao cobrirem o caso (operacoes infrequentes).

Para acoes que enviam conteudo (send-poll, forward-message, edit-message):
  - confirmed: false (padrao): MCP bloqueia e retorna resumo para exibir ao usuario.
  - confirmed: true: so apos confirmacao explicita do usuario.
  Acoes de leitura/config nao precisam de confirmed.

Actions disponiveis e seus params:
- read-chat: { phone, action: "read"|"unread" } — marca chat como lido/nao lido
- read-message: { phone, messageId } — marca msg individual como lida
- delete-message: { phone, messageId, owner } — deleta mensagem (owner: true=minha, false=de outro)
- edit-message: { phone, messageId, newMessage } — edita mensagem de texto enviada por voce  [REQUER confirmed]
- send-poll: { phone, question, options: string[], selectableCount } — envia enquete  [REQUER confirmed]
- forward: { phone, messageId, forwardPhone } — encaminha mensagem  [REQUER confirmed]
- send-reaction: { phone, messageId, reaction } — reage com emoji (nao requer confirmed)
- block-contact: { phone, action: "block"|"unblock" } — bloqueia ou desbloqueia contato
- get-contact-info: { phone } — info do contato (nome, foto, status). Edge converte pra GET /contacts/{phone}
- create-group: { groupName, phones: string[] } — cria grupo
- add-participant: { groupId, phone } — adiciona membro ao grupo
- remove-participant: { groupId, phone } — remove membro do grupo
- add-admin: { groupId, phone } — promove a admin
- remove-admin: { groupId, phone } — rebaixa de admin

Para "phone": usar apenas digitos sem + (ex: "5511999998888").
Para "messageId": usar provider_msg_id da tabela messages (nao o UUID interno).`,
  {
    action: z.string().describe("Nome do endpoint Z-API (ex: mark-read, delete-message, send-poll)"),
    params: z.record(z.unknown()).describe("Parametros da action conforme documentacao acima"),
    confirmed: z.boolean().default(false).describe("Obrigatorio true para actions de envio (send-poll, forward-message, edit-message). So passe true apos confirmacao explicita do usuario."),
    instance: z.string().optional().describe("De qual numero executar a acao (alias 'pessoal'/'profissional' ou instance_id). Padrao: instancia default."),
  },
  async ({ action, params, confirmed, instance }) => {
    if (ZAPI_SEND_ACTIONS.has(action) && !confirmed) {
      return {
        content: [{
          type: "text",
          text: [
            `BLOQUEADO: a action "${action}" envia conteudo e requer confirmacao do usuario.`,
            "",
            "Mostre ao usuario o que sera enviado (action + parametros) e aguarde confirmacao.",
            'Apos "sim", "confirma" ou equivalente, chame novamente com confirmed: true.',
          ].join("\n"),
        }],
        isError: true,
      };
    }

    try {
      const r = await callApi("zapi_action", {
        action, params, instance,
        confirmed: ZAPI_SEND_ACTIONS.has(action) ? true : confirmed,
      });
      return r.error ? err(r.error) : ok(r);
    } catch (e) {
      return err(e.message);
    }
  }
);

// ─── START ───────────────────────────────────────────────────────────────────


// ─── 9. annotate_chat ────────────────────────────────────────────────────────
server.tool(
  "annotate_chat",
  `Salva observacoes e/ou links sobre um contato ou grupo.
Use para: "anota que o Marcos so responde audio", "salva o LinkedIn da Maria", "esse lead nao lê texto".
observations: texto livre com contexto do contato (exibido no read e inbox automaticamente).
links: array de {label, url} com links relevantes (LinkedIn, proposta, etc).
Passe so o campo que quer atualizar — o outro permanece inalterado.`,
  {
    chat: z.string().describe("Nome, telefone ou chat_id do contato"),
    observations: z.string().optional().describe("Texto livre com contexto do contato. Ex: 'So responde audio. Cliente desde 2023.'"),
    links: z.array(z.object({
      label: z.string().describe("Rotulo do link. Ex: LinkedIn, Proposta, Site"),
      url: z.string().url().describe("URL completa"),
    })).optional().describe("Links relevantes do contato"),
    instance: z.string().optional().describe("Instancia (alias ou instance_id) — desambigua quando o contato existe nos dois numeros."),
  },
  async ({ chat, observations, links, instance }) => {
    if (!observations && !links) return err("Passe ao menos observations ou links.");
    try {
      const r = await callApi("annotate", { chat, observations, links, instance });
      return r.error ? err(r.error) : ok(r);
    } catch (e) { return err(e.message); }
  }
);

// ─── 10. edit_message ─────────────────────────────────────────────────────────
server.tool(
  "edit_message",
  `Edita o texto/legenda de uma mensagem enviada por voce.
Use para: "corrige aquela msg que mandei pro Marcos", "edita a ultima mensagem que enviei", "corrige a legenda daquela imagem".
Precisa do message_id (UUID da tabela messages) — obtenha via read ou search.
Funciona em mensagens enviadas por voce (from_me=true) do tipo texto, imagem, video ou documento (edita a legenda/caption nesses 3 ultimos). Audio, figurinha, enquete e localizacao nao sao editaveis (limite da Z-API). Janela de 15min desde o envio.`,
  {
    message_id: z.string().describe("UUID da mensagem (campo id retornado por read/search)"),
    new_content: z.string().describe("Novo texto da mensagem"),
    confirmed: z.boolean().default(false).describe("Obrigatorio true para editar. So passe true apos confirmacao explicita do usuario."),
  },
  async ({ message_id, new_content, confirmed }) => {
    if (!confirmed) {
      return {
        content: [{ type: "text", text: [
          "BLOQUEADO: confirmacao pendente.",
          "",
          "Mostre ao usuario:",
          `  Mensagem ID: ${message_id}`,
          `  Novo texto : ${new_content}`,
          "",
          'Apos confirmacao, chame novamente com confirmed: true.',
        ].join("\n") }],
        isError: true,
      };
    }
    try {
      const r = await callApi("edit_message", { message_id, new_content, confirmed: true });
      return r.error ? err(r.error) : ok(r);
    } catch (e) { return err(e.message); }
  }
);

// ─── 10. delete_message ──────────────────────────────────────────────────────
server.tool(
  "delete_message",
  `Deleta uma mensagem enviada por voce (apaga para todos).
Use para: "apaga aquela msg que mandei", "deleta a ultima mensagem para o Marcos".
Precisa do message_id (UUID da tabela messages) — obtenha via read ou search.`,
  {
    message_id: z.string().describe("UUID da mensagem (campo id retornado por read/search)"),
    confirmed: z.boolean().default(false).describe("Obrigatorio true para deletar. So passe true apos confirmacao explicita do usuario."),
  },
  async ({ message_id, confirmed }) => {
    if (!confirmed) {
      return {
        content: [{ type: "text", text: [
          "BLOQUEADO: confirmacao pendente.",
          "",
          `  Mensagem ID: ${message_id}`,
          "",
          'Apos confirmacao, chame novamente com confirmed: true.',
        ].join("\n") }],
        isError: true,
      };
    }
    try {
      const r = await callApi("delete_message", { message_id, confirmed: true });
      return r.error ? err(r.error) : ok(r);
    } catch (e) { return err(e.message); }
  }
);

// ─── 11. download_attachment ─────────────────────────────────────────────────
server.tool(
  "download_attachment",
  `Retorna a URL publica de uma midia (imagem, audio, video, documento) salva no Storage.
Use para: "me mostra o PDF que o Marcos mandou", "qual o link da foto da Maria".
Precisa do message_id (UUID da tabela messages) — obtenha via read ou search.
Retorna URL do Supabase Storage (permanente) ou original_url (CDN temporaria Z-API como fallback).`,
  {
    message_id: z.string().describe("UUID da mensagem (campo id retornado por read/search)"),
  },
  async ({ message_id }) => {
    try {
      const r = await callApi("download_attachment", { message_id });
      return r.error ? err(r.error) : ok(r);
    } catch (e) { return err(e.message); }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
