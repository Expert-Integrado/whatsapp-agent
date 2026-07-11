-- Migration 0050 — RLS nas tabelas que ficaram sem (advisor de seguranca).
--
-- Mesmo racional da 0006: todo acesso e via service_role (edge functions e
-- scripts/*.mjs), que bypassa RLS. Habilitar sem policy nenhuma bloqueia
-- anon/authenticated e nao muda nada pro fluxo real.
--
-- Tabelas criadas depois da 0006 sem o ENABLE: 0016 (lid_mapping),
-- 0018 (zapi_action_log → wa_action_log + particoes), 0033 (nurture_state),
-- 0034 (nurture_backfill), 0039 (social_graph_state).

ALTER TABLE public.lid_mapping        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wa_action_log      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nurture_state      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nurture_backfill   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.social_graph_state ENABLE ROW LEVEL SECURITY;

-- RLS na mae nao propaga pra particoes ja existentes — habilitar em cada uma
-- (dinamico porque o conjunto de particoes varia por instalacao/data).
DO $$
DECLARE part regclass;
BEGIN
  FOR part IN
    SELECT inhrelid::regclass FROM pg_inherits
    WHERE inhparent = 'public.wa_action_log'::regclass
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', part);
  END LOOP;
END $$;

-- Root cause das particoes futuras: o cron mensal (0019) cria a particao do
-- mes seguinte sem RLS. Recria a funcao ja habilitando na particao nova.
CREATE OR REPLACE FUNCTION public.create_zapi_action_log_partition_next_month()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  next_month     DATE := date_trunc('month', NOW() + interval '1 month')::DATE;
  month_after    DATE := date_trunc('month', NOW() + interval '2 month')::DATE;
  partition_name TEXT := 'zapi_action_log_' || to_char(next_month, 'YYYY_MM');
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.wa_action_log FOR VALUES FROM (%L) TO (%L)',
    partition_name, next_month, month_after
  );
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', partition_name);
END;
$$;
