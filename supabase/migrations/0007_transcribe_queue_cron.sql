-- ════════════════════════════════════════════════════════════════
-- Cron: transcribe-queue a cada 2 minutos
-- Transcreve mensagens ptt/audio de chats privados via OpenAI Whisper
-- Requer OPENAI_API_KEY configurada como secret da Edge Function.
-- URL+service_role vêm do Vault via public.call_edge_function (0001).
-- ════════════════════════════════════════════════════════════════

SELECT cron.schedule(
  'transcribe-audio-queue',
  '*/2 * * * *',
  $$SELECT public.call_edge_function('/functions/v1/transcribe-queue')$$
);
