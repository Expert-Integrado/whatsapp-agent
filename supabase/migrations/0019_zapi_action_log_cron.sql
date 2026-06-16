-- Migration 0019 — Cron mensal para criar partition do mes seguinte
-- e dropar partitions > 90 dias da tabela zapi_action_log.
--
-- Contexto: 0018 criou as funcoes
--   - public.create_zapi_action_log_partition_next_month()
--   - public.drop_zapi_action_log_partitions_older_than_90d()
-- mas nunca foram agendadas. Sem isso, INSERTs falham assim que ultrapassam
-- a ultima partition (2026-07 criada manualmente).

-- pg_cron usa horario UTC. Rodar dia 25 as 03:00 UTC garante que a partition
-- do mes seguinte exista com folga de 5-6 dias antes do mes virar.
SELECT cron.schedule(
  'zapi-action-log-partition-create',
  '0 3 25 * *',
  $$SELECT public.create_zapi_action_log_partition_next_month();$$
);

-- Drop de partitions antigas roda dia 1 as 04:00 UTC (apos virada do mes).
SELECT cron.schedule(
  'zapi-action-log-partition-drop',
  '0 4 1 * *',
  $$SELECT public.drop_zapi_action_log_partitions_older_than_90d();$$
);

-- Pre-cria partition de agosto AGORA pra fechar o gap (0018 so foi ate julho).
CREATE TABLE IF NOT EXISTS public.zapi_action_log_2026_08
  PARTITION OF public.zapi_action_log
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
