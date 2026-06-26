// Rate limit compartilhado entre edge functions (zapi-proxy, futuramente send-message)
//
// Decisao revisada apos Conselho (11/05/2026): edges Supabase sao stateless,
// contador em memoria nao funciona entre invocacoes. Usa tabela existente
// (messages para DESTRUCTIVE de envio, wa_action_log para WRITE/READ).

// Alinhado ao specifier npm: usado pelas edges (zapi-proxy/send-voice) — usar
// esm.sh aqui criava duas identidades de tipo SupabaseClient incompatíveis.
import { SupabaseClient } from "npm:@supabase/supabase-js@2";

export type Category = "read" | "write" | "destructive";

export interface RateLimitResult {
  ok: boolean;
  reason?: string;
  meta?: Record<string, unknown>;
}

/**
 * Rate limit para DESTRUCTIVE sends (texto/imagem/audio/video/poll/forward).
 * Usa a mesma logica de send-message (tabela messages).
 *
 * Limites configuraveis via env vars (mesmos do send-message).
 */
export async function checkSendRateLimit(
  supabase: SupabaseClient,
  instanceId: string,
  chat_id: string,
  limits: { perChatPerMin: number; globalPerMin: number; globalPerDay: number },
): Promise<RateLimitResult> {
  const now = Date.now();
  const oneMinAgo = new Date(now - 60_000).toISOString();
  const oneDayAgo = new Date(now - 86_400_000).toISOString();

  // Por chat / minuto (isolado por instância: (instance_id, chat_id))
  const { data: perChat } = await supabase
    .from("messages")
    .select("id")
    .eq("instance_id", instanceId)
    .eq("chat_id", chat_id)
    .eq("from_me", true)
    .gte("message_ts", oneMinAgo)
    .limit(limits.perChatPerMin + 1);
  if ((perChat?.length ?? 0) >= limits.perChatPerMin) {
    return {
      ok: false,
      reason: "rate_limit_per_chat_per_min",
      meta: { instance_id: instanceId, chat_id, count_at_least: perChat?.length, limit: limits.perChatPerMin },
    };
  }

  // Global / minuto (por instância — cada número Z-API tem cota própria)
  const { data: globalMin } = await supabase
    .from("messages")
    .select("id")
    .eq("instance_id", instanceId)
    .eq("from_me", true)
    .gte("message_ts", oneMinAgo)
    .limit(limits.globalPerMin + 1);
  if ((globalMin?.length ?? 0) >= limits.globalPerMin) {
    return {
      ok: false,
      reason: "rate_limit_global_per_min",
      meta: { instance_id: instanceId, count_at_least: globalMin?.length, limit: limits.globalPerMin },
    };
  }

  // Global / dia (por instância)
  const { data: globalDay } = await supabase
    .from("messages")
    .select("id")
    .eq("instance_id", instanceId)
    .eq("from_me", true)
    .gte("message_ts", oneDayAgo)
    .limit(limits.globalPerDay + 1);
  if ((globalDay?.length ?? 0) >= limits.globalPerDay) {
    return {
      ok: false,
      reason: "rate_limit_global_per_day",
      meta: { instance_id: instanceId, count_at_least: globalDay?.length, limit: limits.globalPerDay },
    };
  }

  return { ok: true };
}

/**
 * Rate limit para WRITE/READ actions (mark-read, send-reaction, status, chats, etc).
 * Usa wa_action_log como contador.
 */
export async function checkActionRateLimit(
  supabase: SupabaseClient,
  instanceId: string,
  category: "read" | "write",
  limit: number,
): Promise<RateLimitResult> {
  const oneMinAgo = new Date(Date.now() - 60_000).toISOString();
  const { data } = await supabase
    .from("wa_action_log")
    .select("id")
    .eq("instance_id", instanceId)
    .eq("category", category)
    .gte("called_at", oneMinAgo)
    .limit(limit + 1);
  if ((data?.length ?? 0) >= limit) {
    return {
      ok: false,
      reason: `rate_limit_${category}_per_min`,
      meta: { instance_id: instanceId, count_at_least: data?.length, limit },
    };
  }
  return { ok: true };
}
