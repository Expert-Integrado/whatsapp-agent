// send-voice — gera áudio TTS via ElevenLabs (OGG/Opus) e envia via provider WA.
//
// Padrão alinhado com 8.1 (zapi-proxy):
//   - confirmed=true obrigatório (gate destrutivo — envio em nome do user)
//   - agent_request_id pra idempotency (cache 24h em wa_action_log)
//   - audit log centralizado em wa_action_log com category=destructive
//   - rate limit reusa lógica do send-message (por chat + global)
//   - timeout 30s pra ElevenLabs + 15s pra provider WA
//
// ElevenLabs output_format=opus_48000_32 entrega OGG/Opus mono 48kHz direto
// (sem ffmpeg server-side). Provider WA com type=ptt exibe onda real em PTT.
//
// Perfis de voz (0051, absorve a skill pessoal:voz): param `profile` resolve o
// catalogo em voice_profiles e TRAVA voice_id/model/settings server-side; a
// humanizacao oral (nivel do perfil) roda aqui antes do TTS. Caminho legado
// (voice_id explicito + settings manuais) segue funcionando sem perfil.

import { createClient } from "npm:@supabase/supabase-js@2";
import { checkSendRateLimit } from "../_shared/rate-limit.ts";
import { getProvider, type InstanceCreds } from "../_shared/wa/index.ts";
import { humanize, type HumanizeLevel } from "../_shared/humanize.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const ELEVENLABS_API_KEY = Deno.env.get("ELEVENLABS_API_KEY")!;
const ELEVENLABS_TIMEOUT_MS = Number(Deno.env.get("ELEVENLABS_TIMEOUT_MS") ?? "30000");
const ZAPI_TIMEOUT_MS = Number(Deno.env.get("ZAPI_TIMEOUT_MS") ?? "15000");
// TTL 5min: Z-API baixa o audio em <5s, 5min eh folga 60x. Reduz janela de exposicao
// se a signed URL vazar em log (CWE-532). Override via VOICE_SIGNED_URL_TTL env se necessario.
const SIGNED_URL_TTL_SECONDS = Number(Deno.env.get("VOICE_SIGNED_URL_TTL") ?? "300");

const RATE_LIMIT_PER_CHAT_PER_MIN = Number(Deno.env.get("RATE_LIMIT_PER_CHAT_PER_MIN") ?? "5");
const RATE_LIMIT_GLOBAL_PER_MIN   = Number(Deno.env.get("RATE_LIMIT_GLOBAL_PER_MIN")   ?? "30");
const RATE_LIMIT_GLOBAL_PER_DAY   = Number(Deno.env.get("RATE_LIMIT_GLOBAL_PER_DAY")   ?? "200");

const REQUIRE_CONFIRMED = Deno.env.get("REQUIRE_CONFIRMED") !== "false";
const VOICE_BUCKET = "whatsapp-audio";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(data: unknown, status = 200, extra?: Record<string, string>) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json", ...(extra ?? {}) },
  });
}

function sanitizeAgentName(name: unknown): string {
  if (typeof name !== "string") return "unknown";
  return name.replace(/[^\w.\-]/g, "").slice(0, 64) || "unknown";
}

async function findCachedResponse(agentRequestId: string) {
  const oneDayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const { data } = await supabase
    .from("wa_action_log")
    .select("result_status, result_body, error, action")
    .eq("agent_request_id", agentRequestId)
    .gte("called_at", oneDayAgo)
    .not("result_status", "is", null)
    .order("called_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  // ─── 1. Parse + validate body
  let body: any;
  try { body = await req.json(); }
  catch { return json({ error: "invalid json" }, 400); }

  const {
    chat_id,           // ex: "5511999998888" (privado) ou "120363...-group" (grupo)
    text,              // texto a converter em fala
    profile: profileKey, // perfil do catalogo voice_profiles (trava voice/settings server-side)
    voice_id,          // ElevenLabs voice ID explicito (caminho legado, sem perfil)
    model_id = "eleven_turbo_v2_5",
    stability = 0.45,
    similarity_boost = 0.75,
    style = 0.30,
    speed = 0.95,
    use_speaker_boost = true,
    confirmed,
    agent_name,
    agent_request_id,
    output_format = "opus_48000_32",  // OGG/Opus mono 48kHz — WhatsApp PTT
    instance: instanceKey,            // alias ('pessoal'/'profissional') ou instance_id; default se ausente
  } = body;

  if (!chat_id || typeof chat_id !== "string") return json({ error: "chat_id obrigatorio" }, 400);
  if (!text || typeof text !== "string" || text.length < 1) return json({ error: "text obrigatorio" }, 400);
  if (text.length > 5000) return json({ error: "text > 5000 chars (limite ElevenLabs)" }, 400);
  // voice_id agora e OPCIONAL: sem ele, cai no default_voice_id da instancia
  // (wa_instance.default_voice_id, migration 0046) — resolvido apos carregar a instancia.
  if (voice_id !== undefined && typeof voice_id !== "string") {
    return json({ error: "voice_id deve ser string" }, 400);
  }
  if (profileKey !== undefined && (typeof profileKey !== "string" || !/^[a-z0-9-]{1,64}$/.test(profileKey))) {
    return json({ error: "profile invalido (minusculas/numeros/hifen)" }, 400);
  }
  if (profileKey && voice_id) {
    return json({ error: "passe profile OU voice_id, nao os dois (profile trava o voice_id do catalogo)" }, 400);
  }
  if (!/^opus_48000_(32|64|96|128|192)$/.test(output_format)) {
    return json({ error: "output_format invalido (deve ser opus_48000_XX)" }, 400);
  }

  // ─── 2. confirmed obrigatorio (destrutivo: envia em nome do user)
  if (REQUIRE_CONFIRMED && confirmed !== true) {
    return json({
      error: "confirmed=true obrigatorio (envio de audio em nome do user)",
      hint: "Mostre destinatario+texto pro user antes",
    }, 403);
  }

  // ─── 3. agent_request_id obrigatorio (idempotency)
  if (!agent_request_id || typeof agent_request_id !== "string") {
    return json({ error: "agent_request_id obrigatorio (idempotency)" }, 400);
  }
  if (agent_request_id.length > 128) {
    return json({ error: "agent_request_id > 128 chars" }, 400);
  }
  // messages.agent_request_id é UUID — valida aqui pra erro claro em vez de
  // exception postgres 22P02. zapi_action_log.agent_request_id é TEXT (inconsistencia
  // schema-wise; manter compat exigindo UUID que cabe nos dois).
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(agent_request_id)) {
    return json({ error: "agent_request_id deve ser UUID (formato xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)" }, 400);
  }

  // ─── 4. Idempotency cache
  const cached = await findCachedResponse(agent_request_id);
  if (cached && cached.action === "send-voice") {
    return json({
      ok: cached.result_status !== null && cached.result_status < 400,
      action: "send-voice",
      status: cached.result_status,
      result: cached.result_body,
      error: cached.error,
      cached: true,
    }, 200, { "X-Idempotent-Replay": "true" });
  }

  // ─── 5. Resolve instância (alias/instance_id) → credenciais; fallback default.
  //     Sanitiza instanceKey pra evitar injeção no filtro .or() do PostgREST.
  if (instanceKey !== undefined && (typeof instanceKey !== "string" || !/^[A-Za-z0-9_-]+$/.test(instanceKey))) {
    return json({ error: "instance invalido" }, 400);
  }
  const instSel = supabase.from("wa_instance").select("provider, instance_id, base_url, auth_token, client_token, alias, default_voice_id, humanize_enabled");
  const { data: instanceRow } = (typeof instanceKey === "string" && instanceKey.length > 0)
    ? await instSel.or(`alias.eq.${instanceKey},instance_id.eq.${instanceKey}`).limit(1).maybeSingle()
    : await instSel.eq("is_default", true).maybeSingle();
  if (!instanceRow) return json({ error: "instancia WA nao encontrada" }, 500);

  // Resolve PERFIL (voice_profiles, 0051): voice_id/model/settings TRAVADOS pelo catalogo.
  let profileRow: {
    profile: string; voice_id: string | null; model_id: string;
    stability: number | null; similarity_boost: number | null; style: number | null; speed: number | null;
    humanize: HumanizeLevel; is_active: boolean; blocked_reason: string | null;
  } | null = null;
  if (profileKey) {
    const { data: pr } = await supabase
      .from("voice_profiles")
      .select("profile, voice_id, model_id, stability, similarity_boost, style, speed, humanize, is_active, blocked_reason")
      .eq("profile", profileKey)
      .maybeSingle();
    if (!pr) {
      const { data: actives } = await supabase
        .from("voice_profiles").select("profile").eq("is_active", true).order("profile");
      return json({
        error: `perfil de voz '${profileKey}' nao existe no catalogo`,
        perfis_ativos: (actives ?? []).map((a) => a.profile),
      }, 404);
    }
    if (!pr.is_active || !pr.voice_id) {
      return json({
        error: `perfil de voz '${profileKey}' esta bloqueado`,
        reason: pr.blocked_reason ??
          (pr.voice_id ? "perfil inativo" : "voice_id a preencher — confirmar com o dono antes do 1o uso"),
      }, 403);
    }
    profileRow = pr;
  }

  // Resolve voz: perfil > explicita > default da instancia > env DEFAULT_VOICE_ID.
  const effectiveVoiceId: string | null =
    profileRow?.voice_id ?? (voice_id as string | undefined) ?? instanceRow.default_voice_id ?? Deno.env.get("DEFAULT_VOICE_ID") ?? null;
  if (!effectiveVoiceId) {
    return json({ error: "voice_id obrigatorio (instancia sem default_voice_id configurado)" }, 400);
  }
  // Settings efetivos: com perfil, SO os do catalogo (NULL = default da edge); sem perfil, os do request.
  const effModelId = profileRow ? profileRow.model_id : model_id;
  const effStability = profileRow ? (profileRow.stability !== null ? Number(profileRow.stability) : 0.45) : stability;
  const effSimilarity = profileRow ? (profileRow.similarity_boost !== null ? Number(profileRow.similarity_boost) : 0.75) : similarity_boost;
  const effStyle = profileRow ? (profileRow.style !== null ? Number(profileRow.style) : 0.30) : style;
  const effSpeed = profileRow ? (profileRow.speed !== null ? Number(profileRow.speed) : 0.95) : speed;
  // Humanizacao oral server-side (nivel do perfil); sem perfil = texto literal (compat legado).
  // wa_instance.humanize_enabled=false (escolha do onboarding, 0052) sobrepoe o
  // nivel do perfil — a instalacao decide se a oralizacao roda, o perfil so o nivel.
  const humanizeEnabled = instanceRow.humanize_enabled !== false;
  const effHumanize: HumanizeLevel = humanizeEnabled ? (profileRow?.humanize ?? "nenhum") : "nenhum";
  const spokenText = humanize(text, effHumanize);
  const creds: InstanceCreds = {
    provider: instanceRow.provider,
    instance_id: instanceRow.instance_id,
    base_url: instanceRow.base_url ?? null,
    auth_token: instanceRow.auth_token,
    client_token: instanceRow.client_token ?? null,
    alias: instanceRow.alias ?? null,
  };
  const instance = creds;

  // ─── 6. Resolve chat → phone (escopado por instância) + verifica que existe
  const { data: chat } = await supabase
    .from("chats")
    .select("chat_id, phone, is_group, chat_name")
    .eq("instance_id", instance.instance_id)
    .eq("chat_id", chat_id)
    .single();
  if (!chat) return json({ error: "chat nao encontrado nesta instancia" }, 404);
  const phone = chat.phone ?? chat_id.replace("@c.us", "").replace("@g.us", "");

  // ─── 7. Rate limit (por instância — cada número tem cota própria)
  const rl = await checkSendRateLimit(supabase, instance.instance_id, chat_id, {
    perChatPerMin: RATE_LIMIT_PER_CHAT_PER_MIN,
    globalPerMin: RATE_LIMIT_GLOBAL_PER_MIN,
    globalPerDay: RATE_LIMIT_GLOBAL_PER_DAY,
  });
  if (!rl.ok) {
    return json({ error: "rate_limit", reason: rl.reason, meta: rl.meta }, 429);
  }

  const sanitizedAgentName = sanitizeAgentName(agent_name);
  const startTs = Date.now();

  // ─── 8. Audit log inicial
  const { data: logRow } = await supabase
    .from("wa_action_log")
    .insert({
      agent_request_id,
      action: "send-voice",
      category: "destructive",
      params: { chat_id, voice_id: effectiveVoiceId, ...(profileKey && { profile: profileKey, humanize: effHumanize }), ...(!humanizeEnabled && { humanize_enabled: false }), model_id: effModelId, stability: effStability, similarity_boost: effSimilarity, style: effStyle, speed: effSpeed, output_format, text_length: spokenText.length },
      method: "POST",
      agent_name: sanitizedAgentName,
      instance_id: instance.instance_id,
    })
    .select("id")
    .single();

  // ─── 9. Insert messages (pending, igual send-message faz)
  const tempId = crypto.randomUUID();
  const { data: msg, error: insertErr } = await supabase
    .from("messages")
    .insert({
      instance_id: instance.instance_id,
      provider_msg_id: `pending-${tempId}`,
      chat_id, direction: "sent", from_me: true,
      message_type: "ptt",
      content: spokenText,  // o que foi FALADO (humanizado quando ha perfil)
      send_status: "pending",
      sent_by_agent: true,
      sent_by_agent_name: sanitizedAgentName,
      agent_request_id,
      message_ts: new Date().toISOString(),
      raw_payload: { source: "send-voice", voice_id: effectiveVoiceId, text: spokenText,
        ...(profileKey && { profile: profileKey }), ...(spokenText !== text && { text_original: text }) },
    })
    .select("id")
    .single();

  if (insertErr) {
    await supabase.from("wa_action_log").update({
      result_status: 500,
      error: `insert messages: ${insertErr.message}`.slice(0, 500),
      duration_ms: Date.now() - startTs,
    }).eq("id", logRow!.id);
    return json({ error: insertErr.message }, 500);
  }

  try {
    // ─── 10. ElevenLabs TTS → OGG/Opus
    const elPayload = {
      text: spokenText,
      model_id: effModelId,
      voice_settings: { stability: effStability, similarity_boost: effSimilarity, style: effStyle, speed: effSpeed, use_speaker_boost },
    };
    const elAbort = AbortSignal.timeout(ELEVENLABS_TIMEOUT_MS);
    const elRes = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${effectiveVoiceId}?output_format=${output_format}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
          "Accept": "audio/ogg",
        },
        body: JSON.stringify(elPayload),
        signal: elAbort,
      },
    );
    if (!elRes.ok) {
      const errBody = await elRes.text();
      throw new Error(`ElevenLabs ${elRes.status}: ${errBody.slice(0, 200)}`);
    }
    const audioBuf = new Uint8Array(await elRes.arrayBuffer());
    if (audioBuf.length < 500) {
      throw new Error(`ElevenLabs retornou apenas ${audioBuf.length} bytes (corrompido?)`);
    }

    // ─── 11. Upload pro Storage (path outbound/<instance_id>/<chat_id>/<uuid>.ogg)
    const storagePath = `outbound/${instance.instance_id}/${chat_id}/${tempId}.ogg`;
    const { error: upErr } = await supabase.storage
      .from(VOICE_BUCKET)
      .upload(storagePath, audioBuf, { contentType: "audio/ogg", upsert: true });
    if (upErr) throw new Error(`Storage upload: ${upErr.message}`);

    // ─── 12. Signed URL TTL 1h pra Z-API baixar
    const { data: signed, error: signErr } = await supabase.storage
      .from(VOICE_BUCKET)
      .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);
    if (signErr || !signed?.signedUrl) throw new Error(`Signed URL: ${signErr?.message ?? "no url"}`);

    // ─── 13. Provider-agnostic send PTT
    const provider = getProvider(creds.provider);
    const built = await provider.buildSend(creds, { chatId: chat_id, phone, type: "ptt", media: { url: signed.signedUrl } });
    const sendAbort = AbortSignal.timeout(ZAPI_TIMEOUT_MS);
    const res = await fetch(built.url, { method: built.method, headers: built.headers, body: built.body, signal: sendAbort });
    if (!res.ok) throw new Error(`${creds.provider} audio ${res.status}: ${(await res.text()).slice(0,200)}`);
    const realId = provider.parseSendResult(await res.json()).providerMsgId || `sent-${tempId}`;

    // ─── 14. Update messages com provider_msg_id real
    await supabase
      .from("messages")
      .update({ provider_msg_id: realId, send_status: "sent" })
      .eq("id", msg!.id);

    const durationMs = Date.now() - startTs;
    const resultBody = {
      message_id: msg!.id,
      provider_msg_id: realId,
      storage_path: storagePath,
      audio_bytes: audioBuf.length,
      duration_ms: durationMs,
      ...(profileKey && { profile: profileKey }),
      ...(spokenText !== text && { text_spoken: spokenText }),
    };

    // ─── 15. Audit log final
    await supabase
      .from("wa_action_log")
      .update({
        result_status: 200,
        result_body: resultBody as any,
        duration_ms: durationMs,
      })
      .eq("id", logRow!.id);

    return json({ ok: true, action: "send-voice", status: 200, result: resultBody });
  } catch (e) {
    const errorText = String((e as Error)?.message ?? e).slice(0, 500);
    const durationMs = Date.now() - startTs;
    await supabase.from("messages").update({
      send_status: "failed",
      send_error: errorText,
    }).eq("id", msg!.id);
    await supabase.from("wa_action_log").update({
      result_status: 500,
      error: errorText,
      duration_ms: durationMs,
    }).eq("id", logRow!.id);
    return json({ ok: false, action: "send-voice", error: errorText }, 500);
  }
});
