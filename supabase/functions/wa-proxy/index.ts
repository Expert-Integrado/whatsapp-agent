// wa-proxy — gateway de ações agnóstico de provider (substitui zapi-proxy).
//
// Item 8.1 do PRD (whatsapp-agent). Após cutover (Fase D), o MCP perde envs
// ZAPI_INSTANCE_ID/ZAPI_TOKEN/ZAPI_CLIENT_TOKEN — credenciais vivem na tabela
// wa_instance e são lidas aqui.
//
// Features:
//   - Allowlist literal de 18 actions categorizadas (READ/WRITE/DESTRUCTIVE)
//   - confirmed: true obrigatório em DESTRUCTIVE (defense-in-depth do gate MCP)
//   - Idempotency: agent_request_id UNIQUE com cache 24h
//   - Rate limit por categoria (DESTRUCTIVE usa messages; WRITE/READ usa wa_action_log)
//   - Audit log inline em wa_action_log
//   - Sanitização anti-log-injection
//   - Timeout 15s na chamada do provider
//   - Dispatch via getProvider(creds.provider).buildAction (anti-SSRF: allowlist antes do dispatch)
//
// Tasks 1-15 done; migration 0040 renomeou: zapi_instance→wa_instance, zapi_action_log→wa_action_log,
// token→auth_token, e adicionou colunas provider/base_url.

import { createClient } from "npm:@supabase/supabase-js@2";
import {
  checkSendRateLimit,
  checkActionRateLimit,
  type Category,
} from "../_shared/rate-limit.ts";
import { getProvider } from "../_shared/wa/index.ts";
import type { InstanceCreds } from "../_shared/wa/types.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ─── Allowlist ──────────────────────────────────────────────────────────────
// CRÍTICO: action é validada como LITERAL STRING MATCH contra estes sets.
// URL do provider só é montada DEPOIS do match (anti-SSRF). Nunca concatenar input.

const READ_ACTIONS = new Set([
  "status",
  "chats",
  "contacts",
  "get-contact-info",     // alias: edge converte pra GET /contacts/{phone} (inclui 'about' = recado)
  "phone-exists",         // alias: edge converte pra GET /phone-exists/{phone} — devolve numero canonico + lid
  "get-business-profile", // GET /business/profile?phone= — descricao/site/categorias de conta business de TERCEIRO (so Z-API)
]);

const WRITE_ACTIONS = new Set([
  "read-chat",         // marca chat como lido (substitui mark-read)
  "read-message",      // marca msg individual como lida
  "send-reaction",
]);

// DESTRUCTIVE de envio (afeta rate limit por chat via messages table)
const DESTRUCTIVE_SEND_ACTIONS = new Set([
  "send-text",
  "send-poll",
  "forward",           // canônico Z-API (substitui forward-message)
  "forward-message",   // alias retrocompat
  // send-image/video/document: uso oficial e a edicao (edit*MessageId), mas nada
  // aqui impede um envio fresco — por isso as tres tambem estao em ZAPI_SEND_ACTIONS
  // (confirmacao + voice gate no mcp-api). Envio normal de midia usa /send-message.
  "send-image",
  "send-video",
  "send-document",
]);

// DESTRUCTIVE outras (rate limit só global)
const DESTRUCTIVE_OTHER_ACTIONS = new Set([
  "delete-message",    // POST aceito (docs dizem DELETE; aceitamos POST igual smoke)
  "block-contact",     // payload {phone, action: "block"|"unblock"}
  "create-group",
  "add-participant",
  "remove-participant",
  "add-admin",         // promove a admin (substitui promote-participant)
  "remove-admin",      // rebaixa (substitui demote-participant)
]);

const DESTRUCTIVE_ACTIONS = new Set([
  ...DESTRUCTIVE_SEND_ACTIONS,
  ...DESTRUCTIVE_OTHER_ACTIONS,
]);

const ALLOWED = new Set([
  ...READ_ACTIONS,
  ...WRITE_ACTIONS,
  ...DESTRUCTIVE_ACTIONS,
]);

function categorize(action: string): Category | null {
  if (READ_ACTIONS.has(action)) return "read";
  if (WRITE_ACTIONS.has(action)) return "write";
  if (DESTRUCTIVE_ACTIONS.has(action)) return "destructive";
  return null;
}

// ─── Rate limit config (env override) ───────────────────────────────────────
const RATE_LIMIT_PER_CHAT_PER_MIN  = Number(Deno.env.get("RATE_LIMIT_PER_CHAT_PER_MIN")  ?? "5");
const RATE_LIMIT_GLOBAL_PER_MIN    = Number(Deno.env.get("RATE_LIMIT_GLOBAL_PER_MIN")    ?? "30");
const RATE_LIMIT_GLOBAL_PER_DAY    = Number(Deno.env.get("RATE_LIMIT_GLOBAL_PER_DAY")    ?? "200");
const RATE_LIMIT_WRITE_PER_MIN     = Number(Deno.env.get("RATE_LIMIT_WRITE_PER_MIN")     ?? "30");
const RATE_LIMIT_READ_PER_MIN      = Number(Deno.env.get("RATE_LIMIT_READ_PER_MIN")      ?? "60");

const REQUIRE_CONFIRMED = Deno.env.get("REQUIRE_CONFIRMED") !== "false";
const ZAPI_TIMEOUT_MS = Number(Deno.env.get("ZAPI_TIMEOUT_MS") ?? "15000");

// ─── Helpers ────────────────────────────────────────────────────────────────

function json(data: unknown, status = 200, extraHeaders?: Record<string, string>) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json", ...(extraHeaders ?? {}) },
  });
}

// Sanitização anti-log-injection (Auditor: CWE-117)
function sanitizeAgentName(name: unknown): string {
  if (typeof name !== "string") return "unknown";
  return name.replace(/[^\w.\-]/g, "").slice(0, 64) || "unknown";
}

// Idempotency: busca log existente com mesmo agent_request_id em janela 24h
async function findCachedResponse(agentRequestId: string) {
  const oneDayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const { data } = await supabase
    .from("wa_action_log")
    .select("result_status, result_body, error, action")
    .eq("agent_request_id", agentRequestId)
    .gte("called_at", oneDayAgo)
    .not("result_status", "is", null)  // só retorna se já concluiu
    .order("called_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

// ─── Handler ────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  // 1. Parse body
  let body: any;
  try { body = await req.json(); }
  catch { return json({ error: "invalid json" }, 400); }

  const {
    action,
    params = {},
    method = "POST",
    confirmed,
    agent_name,
    agent_request_id,
    instance: instanceKey,   // alias ('pessoal'/'profissional') ou instance_id; default se ausente
  } = body;

  // 2. Validate action (allowlist literal match — anti-SSRF)
  if (typeof action !== "string" || !ALLOWED.has(action)) {
    // Log mesmo rejeitado pra observability
    await supabase.from("wa_action_log").insert({
      action: typeof action === "string" ? action.slice(0, 64) : "invalid",
      category: "rejected",
      params: typeof params === "object" ? params : null,
      method,
      agent_name: sanitizeAgentName(agent_name),
      error: "action_not_allowed",
      result_status: 400,
    });
    return json({ error: "action_not_allowed", action }, 400);
  }

  const category = categorize(action)!;

  // 3. Validate method
  if (method !== "POST" && method !== "GET") {
    return json({ error: "method must be POST or GET" }, 400);
  }

  // 4. Validate params (anti-DoS)
  if (typeof params !== "object" || params === null) {
    return json({ error: "params must be object" }, 400);
  }
  if (Object.keys(params).length > 50) {
    return json({ error: "params too large" }, 400);
  }

  // 5. confirmed obrigatório em DESTRUCTIVE
  if (REQUIRE_CONFIRMED && category === "destructive" && confirmed !== true) {
    return json({
      error: "confirmed=true é obrigatório em DESTRUCTIVE actions",
      action,
      hint: "Garanta que usuário viu destinatário+conteúdo antes de chamar com confirmed:true",
    }, 403);
  }

  // 6. agent_request_id obrigatório em WRITE/DESTRUCTIVE
  if ((category === "write" || category === "destructive") && !agent_request_id) {
    return json({
      error: "agent_request_id obrigatório em WRITE/DESTRUCTIVE (idempotency)",
      action,
    }, 400);
  }
  if (agent_request_id && (typeof agent_request_id !== "string" || agent_request_id.length > 128)) {
    return json({ error: "agent_request_id deve ser string < 128 chars" }, 400);
  }

  // 7. Idempotency check — cache 24h
  if (agent_request_id) {
    const cached = await findCachedResponse(agent_request_id);
    if (cached && cached.action === action) {
      return json({
        ok: cached.result_status !== null && cached.result_status < 400,
        action,
        status: cached.result_status,
        result: cached.result_body,
        error: cached.error,
        cached: true,
      }, 200, { "X-Idempotent-Replay": "true" });
    }
  }

  // 8. Buscar credenciais da instância indicada (alias ou instance_id);
  //    fallback à default (compat single-instance). Sanitiza instanceKey
  //    pra evitar injeção no filtro .or() do PostgREST. Resolve ANTES do
  //    rate limit pra escopar a cota por instância.
  if (instanceKey !== undefined && (typeof instanceKey !== "string" || !/^[A-Za-z0-9_-]+$/.test(instanceKey))) {
    return json({ error: "instance inválido" }, 400);
  }
  const instSel = supabase
    .from("wa_instance")
    .select("provider, instance_id, base_url, auth_token, client_token, alias");
  const { data: instance } = (typeof instanceKey === "string" && instanceKey.length > 0)
    ? await instSel.or(`alias.eq.${instanceKey},instance_id.eq.${instanceKey}`).limit(1).maybeSingle()
    : await instSel.eq("is_default", true).maybeSingle();
  if (!instance) return json({ error: "instância wa_instance não encontrada", instance: instanceKey ?? "(default)" }, 500);

  // Montar InstanceCreds tipado para o provider
  const creds: InstanceCreds = {
    provider: instance.provider,
    instance_id: instance.instance_id,
    base_url: instance.base_url,
    auth_token: instance.auth_token,
    client_token: instance.client_token,
    alias: instance.alias,
  };

  // 9. Rate limit (por instância — cada número tem cota própria)
  let rl;
  if (category === "destructive" && DESTRUCTIVE_SEND_ACTIONS.has(action)) {
    // Sends precisam de chat_id pra per-chat limit
    const chat_id = params.phone ?? params.chat_id;
    if (!chat_id) {
      return json({ error: "params.phone obrigatório em send actions" }, 400);
    }
    rl = await checkSendRateLimit(supabase, instance.instance_id, String(chat_id), {
      perChatPerMin: RATE_LIMIT_PER_CHAT_PER_MIN,
      globalPerMin: RATE_LIMIT_GLOBAL_PER_MIN,
      globalPerDay: RATE_LIMIT_GLOBAL_PER_DAY,
    });
  } else if (category === "write") {
    rl = await checkActionRateLimit(supabase, instance.instance_id, "write", RATE_LIMIT_WRITE_PER_MIN);
  } else if (category === "read") {
    rl = await checkActionRateLimit(supabase, instance.instance_id, "read", RATE_LIMIT_READ_PER_MIN);
  } else {
    rl = { ok: true };  // DESTRUCTIVE_OTHER não tem rate limit por chat
  }

  if (!rl.ok) {
    return json({ error: "rate_limit", reason: rl.reason, meta: rl.meta }, 429);
  }

  // 10. Insert audit log INICIAL (sem result ainda)
  const sanitizedAgentName = sanitizeAgentName(agent_name);
  const startTs = Date.now();
  const { data: logRow, error: logErr } = await supabase
    .from("wa_action_log")
    .insert({
      agent_request_id: agent_request_id ?? null,
      action,
      category,
      params,
      method,
      agent_name: sanitizedAgentName,
      instance_id: instance.instance_id,
    })
    .select("id")
    .single();
  if (logErr) console.error("audit log insert error", logErr);

  // 11. Dispatch via provider — APÓS allowlist (anti-SSRF)
  //     getProvider() lança se provider desconhecido (falha 500 segura — não expõe URL)
  const provider = getProvider(creds.provider);
  let resultStatus: number = 500;
  let resultBody: unknown = null;
  let errorText: string | null = null;

  try {
    if (action === "status") {
      const built = provider.buildAction(creds, "status", {});
      const r = await fetch(built!.url, {
        method: built!.method,
        headers: built!.headers,
        signal: AbortSignal.timeout(ZAPI_TIMEOUT_MS),
      });
      resultStatus = r.status;
      resultBody = provider.parseConnection(await r.json());
    } else if (action === "chats") {
      resultBody = await provider.fetchGroups(creds);
      resultStatus = 200;
    } else {
      // Todos os outros actions (WRITE + DESTRUCTIVE + READ restantes)
      const built = provider.buildAction(creds, action as any, params);
      if (!built) {
        // Provider não suporta esta action — log + 400
        errorText = `not_supported_by_provider: ${action} / ${creds.provider}`;
        if (logRow?.id) {
          await supabase
            .from("wa_action_log")
            .update({ result_status: 400, error: errorText, duration_ms: Date.now() - startTs })
            .eq("id", logRow.id);
        }
        return json({ error: "not_supported_by_provider", action, provider: creds.provider }, 400);
      }
      const r = await fetch(built.url, {
        method: built.method,
        headers: built.headers,
        body: built.body,
        signal: AbortSignal.timeout(ZAPI_TIMEOUT_MS),
      });
      resultStatus = r.status;
      const t = await r.text();
      try { resultBody = JSON.parse(t); } catch { resultBody = t; }
      if (!r.ok) {
        errorText = `${creds.provider} ${r.status}: ${typeof resultBody === "string" ? resultBody : JSON.stringify(resultBody)}`.slice(0, 500);
      }
    }
  } catch (e) {
    errorText = String(e).slice(0, 500);
    resultStatus = 504;
  }

  const durationMs = Date.now() - startTs;

  // 12. Update audit log com result
  if (logRow?.id) {
    await supabase
      .from("wa_action_log")
      .update({
        result_status: resultStatus,
        result_body: resultBody as any,
        error: errorText,
        duration_ms: durationMs,
      })
      .eq("id", logRow.id);
  }

  // 13. Response
  if (errorText) {
    return json({ ok: false, action, status: resultStatus, error: errorText }, resultStatus ?? 500);
  }
  return json({ ok: true, action, status: resultStatus, result: resultBody });
});
