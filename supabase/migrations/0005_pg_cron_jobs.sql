-- ════════════════════════════════════════════════════════════════
-- pg_cron jobs — URLs hardcoded (projeto <SUPABASE_PROJECT_ID>)
-- Requer extensões pg_cron e pg_net habilitadas
-- ════════════════════════════════════════════════════════════════

-- Limpeza: presence_events > 30 dias (03:00 UTC = 00:00 BRT)
SELECT cron.schedule(
  'cleanup-presence-events',
  '0 3 * * *',
  $$DELETE FROM presence_events WHERE event_at < now() - interval '30 days'$$
);

-- Limpeza: webhook_events_raw processados > 7 dias (03:15 UTC)
SELECT cron.schedule(
  'cleanup-webhook-raw',
  '15 3 * * *',
  $$DELETE FROM webhook_events_raw WHERE processed = true AND received_at < now() - interval '7 days'$$
);

-- Limpeza: mídia pesada (áudio/vídeo) > 30 dias (03:30 UTC)
SELECT cron.schedule(
  'cleanup-heavy-media',
  '30 3 * * *',
  $$SELECT net.http_post(
      url := 'https://<SUPABASE_PROJECT_ID>.supabase.co/functions/v1/cleanup-media',
      headers := '{"Authorization":"Bearer <SUPABASE_SERVICE_ROLE_KEY>"}'::jsonb
    )$$
);

-- Retry: mídias com download_status='pending' a cada 15 min
SELECT cron.schedule(
  'retry-pending-media',
  '*/15 * * * *',
  $$SELECT net.http_post(
      url := 'https://<SUPABASE_PROJECT_ID>.supabase.co/functions/v1/retry-media',
      headers := '{"Authorization":"Bearer <SUPABASE_SERVICE_ROLE_KEY>"}'::jsonb
    )$$
);

-- Sync Google Contacts diário 04:00 BRT (= 07:00 UTC)
SELECT cron.schedule(
  'sync-google-contacts',
  '0 7 * * *',
  $$SELECT net.http_post(
      url := 'https://<SUPABASE_PROJECT_ID>.supabase.co/functions/v1/sync-google-contacts',
      headers := '{"Authorization":"Bearer <SUPABASE_SERVICE_ROLE_KEY>"}'::jsonb
    )$$
);
