// zapi-proxy — edge function que centraliza todas as chamadas Z-API
// que antes saiam direto do MCP local (PC/notebook/VPS).
//
// Item 8.1 do PRD (whatsapp-agent). Apos cutover (Fase D), MCP perde envs
// ZAPI_INSTANCE_ID/ZAPI_TOKEN/ZAPI_CLIENT_TOKEN — token vive so na tabela
// zapi_instance e e lido aqui.
//
// Features:
//   - Allowlist literal de 18 actions categorizadas (READ/WRITE/DESTRUCTIVE)
//   - confirmed: true obrigatorio em DESTRUCTIVE (defense-in-depth do gate MCP)
//   - Idempotency: agent_request_id UNIQUE com cache 24h
//   - Rate limit por categoria (DESTRUCTIVE usa messages; WRITE/READ usa zapi_action_log)
//   - Audit log inline em zapi_action_log
//   - Sanitizacao anti-log-injection
//   - Timeout 15s na chamada Z-API
//
// Veredito do Conselho (5 LLMs, 11/05/2026): GO COM AJUSTES — todos aplicados aqui.

import { createClient } from "npm:@supabase/supabase-js@2";
import {
  checkSendRateLimit,
  checkActionRateLimit,
  type Category,
} from "../_shared/rate-limit.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ─── Allowlist ──────────────────────────────────────────────────────────────
// CRITICO: action eh validada como LITERAL STRING MATCH contra estes sets.
// URL Z-API soh eh montada DEPOIS do match (anti-SSRF). Nunca concatenar input.

// Allowlist alinhada com docs Z-API (https://developer.z-api.io/llms.txt)
// Apos correcao 12/05/2026 (pesquisa via Conselho-on-demand). Mantemos aliases
// pra retrocompat onde Z-API aceita os dois (edit-message/delete-message).
const READ_ACTIONS = new Set([
  "status",
  "chats",
  "contacts",
  "get-contact-info",  // alias: edge converte pra GET /contacts/{phone}
  "phone-exists",      // alias: edge converte pra GET /phone-exists/{phone} — devolve numero canonico + lid
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
  "forward",           // canonico Z-API (substitui forward-message)
  "forward-message",   // alias retrocompat
]);

// DESTRUCTIVE outras (rate limit so global)
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

// Sanitizacao anti-log-injection (Auditor: CWE-117)
function sanitizeAgentName(name: unknown): string {
  if (typeof name !== "string") return "unknown";
  return name.replace(/[^\w.\-]/g, "").slice(0, 64) || "unknown";
}

// Idempotency: busca log existente com mesmo agent_request_id em janela 24h
async function findCachedResponse(agentRequestId: string) {
  const oneDayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const { data } = await supabase
    .from("zapi_action_log")
    .select("result_status, result_body, error, action")
    .eq("agent_request_id", agentRequestId)
    .gte("called_at", oneDayAgo)
    .not("result_status", "is", null)  // soh retorna se ja concluiu
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
    await supabase.from("zapi_action_log").insert({
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

  // 5. confirmed obrigatorio em DESTRUCTIVE
  if (REQUIRE_CONFIRMED && category === "destructive" && confirmed !== true) {
    return json({
      error: "confirmed=true e obrigatorio em DESTRUCTIVE actions",
      action,
      hint: "Garanta que usuario viu destinatario+conteudo antes de chamar com confirmed:true",
    }, 403);
  }

  // 6. agent_request_id obrigatorio em WRITE/DESTRUCTIVE
  if ((category === "write" || category === "destructive") && !agent_request_id) {
    return json({
      error: "agent_request_id obrigatorio em WRITE/DESTRUCTIVE (idempotency)",
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

  // 8. Buscar credenciais Z-API da instância indicada (alias ou instance_id);
  //    fallback à default (compat single-instance). Sanitiza instanceKey
  //    pra evitar injeção no filtro .or() do PostgREST. Resolve ANTES do
  //    rate limit pra escopar a cota por instância.
  if (instanceKey !== undefined && (typeof instanceKey !== "string" || !/^[A-Za-z0-9_-]+$/.test(instanceKey))) {
    return json({ error: "instance invalido" }, 400);
  }
  const instSel = supabase.from("zapi_instance").select("instance_id, token, client_token");
  const { data: instance } = (typeof instanceKey === "string" && instanceKey.length > 0)
    ? await instSel.or(`alias.eq.${instanceKey},instance_id.eq.${instanceKey}`).limit(1).maybeSingle()
    : await instSel.eq("is_default", true).maybeSingle();
  if (!instance) return json({ error: "instancia Z-API nao encontrada", instance: instanceKey ?? "(default)" }, 500);

  // 9. Rate limit (por instância — cada número tem cota Z-API própria)
  let rl;
  if (category === "destructive" && DESTRUCTIVE_SEND_ACTIONS.has(action)) {
    // Sends precisam de chat_id pra per-chat limit
    const chat_id = params.phone ?? params.chat_id;
    if (!chat_id) {
      return json({ error: "params.phone obrigatorio em send actions" }, 400);
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
    rl = { ok: true };  // DESTRUCTIVE_OTHER nao tem rate limit por chat
  }

  if (!rl.ok) {
    return json({ error: "rate_limit", reason: rl.reason, meta: rl.meta }, 429);
  }

  // 10. Insert audit log INICIAL (sem result ainda)
  const sanitizedAgentName = sanitizeAgentName(agent_name);
  const startTs = Date.now();
  const { data: logRow, error: logErr } = await supabase
    .from("zapi_action_log")
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

  // 11. Chamada Z-API — aliases e shape tweaks por endpoint
  const base = `https://api.z-api.io/instances/${instance.instance_id}/token/${instance.token}`;
  let resolvedAction = action;
  let resolvedMethod = method;
  let resolvedParams: any = params;

  // get-contact-info: Z-API exige GET /contacts/{phone}, sem body
  if (action === "get-contact-info") {
    if (!params.phone) {
      return json({ error: "params.phone obrigatorio em get-contact-info" }, 400);
    }
    resolvedAction = `contacts/${encodeURIComponent(String(params.phone))}`;
    resolvedMethod = "GET";
    resolvedParams = {};
  }

  // phone-exists: Z-API exige GET /phone-exists/{phone}, sem body.
  // Resposta traz o numero CANONICO registrado no WhatsApp (campo phone) + lid —
  // fonte de verdade pra normalizacao do 9o digito antes de primeiro contato.
  if (action === "phone-exists") {
    if (!params.phone) {
      return json({ error: "params.phone obrigatorio em phone-exists" }, 400);
    }
    resolvedAction = `phone-exists/${encodeURIComponent(String(params.phone))}`;
    resolvedMethod = "GET";
    resolvedParams = {};
  }

  let url: string;
  if (resolvedMethod === "GET" && Object.keys(resolvedParams).length > 0) {
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries(resolvedParams).map(([k, v]) => [k, String(v)])),
    ).toString();
    url = `${base}/${resolvedAction}?${qs}`;
  } else {
    url = `${base}/${resolvedAction}`;
  }

  let resultStatus: number | null = null;
  let resultBody: unknown = null;
  let errorText: string | null = null;

  try {
    const abort = AbortSignal.timeout(ZAPI_TIMEOUT_MS);
    const r = await fetch(url, {
      method: resolvedMethod,
      headers: {
        "Content-Type": "application/json",
        "Client-Token": instance.client_token,
      },
      body: resolvedMethod === "POST" ? JSON.stringify(resolvedParams) : undefined,
      signal: abort,
    });
    resultStatus = r.status;
    const text = await r.text();
    try { resultBody = JSON.parse(text); } catch { resultBody = text; }
    if (!r.ok) errorText = `Z-API ${r.status}: ${typeof resultBody === "string" ? resultBody : JSON.stringify(resultBody)}`.slice(0, 500);
  } catch (e) {
    errorText = String(e).slice(0, 500);
    resultStatus = 504;
  }

  const durationMs = Date.now() - startTs;

  // 12. Update audit log com result
  if (logRow?.id) {
    await supabase
      .from("zapi_action_log")
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
