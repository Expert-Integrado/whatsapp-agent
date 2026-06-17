-- ════════════════════════════════════════════════════════════════
-- pg_cron jobs — limpeza e retry de mídia
-- Requer pg_cron + pg_net (habilitadas na 0001) e a função helper
-- public.call_edge_function (0001), que lê URL+service_role do Vault.
-- ════════════════════════════════════════════════════════════════

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
  $$SELECT public.call_edge_function('/functions/v1/cleanup-media')$$
);

-- Retry: mídias com download_status='pending' a cada 15 min
SELECT cron.schedule(
  'retry-pending-media',
  '*/15 * * * *',
  $$SELECT public.call_edge_function('/functions/v1/retry-media')$$
);
