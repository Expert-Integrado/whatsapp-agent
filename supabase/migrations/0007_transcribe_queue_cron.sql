-- ════════════════════════════════════════════════════════════════
-- Cron: transcribe-queue a cada 2 minutos
-- Transcreve mensagens ptt/audio de chats privados via OpenAI Whisper
-- Requer OPENAI_API_KEY configurada como secret da Edge Function
-- ════════════════════════════════════════════════════════════════

SELECT cron.schedule(
  'transcribe-audio-queue',
  '*/2 * * * *',
  $$SELECT net.http_post(
      url := 'https://<SUPABASE_PROJECT_ID>.supabase.co/functions/v1/transcribe-queue',
      headers := '{"Authorization":"Bearer <SUPABASE_SERVICE_ROLE_KEY>"}'::jsonb
    )$$
);
