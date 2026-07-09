-- 0031_provider_neutralization.sql
-- Neutraliza o acoplamento Z-API: rename de tabelas + coluna provider/base_url.
-- Preserva 100% dos dados (ALTER ... RENAME). Idempotente. Views de compat por 1 versão.
--
-- Colunas reais de zapi_instance antes desta migration (auditadas em 0001-0029):
--   id, instance_id, token (→ auth_token), client_token, webhook_url,
--   phone_connected, is_active, last_connected_at, last_disconnected_at,
--   created_at, updated_at,
--   alias (0027), is_default (0027),
--   webhook_token (0029)
--
-- Objetos dependentes de zapi_instance identificados:
--   - TRIGGER trg_zapi_instance_updated — Postgres move automaticamente com o RENAME, sem ação.
--   - FK chats_instance_fk em public.chats → Postgres atualiza automaticamente com o RENAME.
--   - CONSTRAINT zapi_instance_alias_unique — Postgres move automaticamente com o RENAME.
--   - migration 0028: referencia por nome literal em DO block histórico — já aplicada, sem impacto.
--
-- Objetos dependentes de zapi_action_log identificados:
--   - Partições filhas (zapi_action_log_2026_05, _06, _07, _08 …) — Postgres renomeia automaticamente
--     a tabela parent mas NÃO renomeia as partições filhas. As partições continuam existindo e
--     funcionando como filhas de wa_action_log sem problemas; apenas seus nomes ainda contêm "zapi".
--     Isso é aceitável: são objetos internos de storage, não acessados por nome pelo app.
--   - FUNCTION create_zapi_action_log_partition_next_month() — usa 'public.zapi_action_log' como
--     literal de texto no EXECUTE format e cria partitions com nome "zapi_action_log_YYYY_MM".
--     Após rename, a string literal falha (regclass lookup). CORRIGIDA nesta migration.
--   - FUNCTION drop_zapi_action_log_partitions_older_than_90d() — usa 'public.zapi_action_log'::regclass
--     para lookup de partições. Após rename, falha. CORRIGIDA nesta migration.
--   - pg_cron jobs 'zapi-action-log-partition-create' e 'zapi-action-log-partition-drop' — chamam
--     as funções acima. Continuam funcionando após as funções serem corrigidas.
--
-- NOTA: db push é responsabilidade do usuário (sem Supabase CLI disponível aqui).

-- ════════════════════════════════════════════════════════════════
-- 1) Rename tabelas (só se ainda não renomeadas)
-- ════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema='public' AND table_name='zapi_instance' AND table_type='BASE TABLE'
     )
     AND NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema='public' AND table_name='wa_instance' AND table_type='BASE TABLE'
     ) THEN
    ALTER TABLE public.zapi_instance RENAME TO wa_instance;
  END IF;

  IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema='public' AND table_name='zapi_action_log' AND table_type='BASE TABLE'
     )
     AND NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema='public' AND table_name='wa_action_log' AND table_type='BASE TABLE'
     ) THEN
    ALTER TABLE public.zapi_action_log RENAME TO wa_action_log;
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════
-- 2) Rename coluna token -> auth_token (só se token ainda existir)
-- ════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='wa_instance' AND column_name='token'
     )
     AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='wa_instance' AND column_name='auth_token'
     ) THEN
    ALTER TABLE public.wa_instance RENAME COLUMN token TO auth_token;
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════
-- 3) client_token nullable (Evolution API não usa este campo)
-- ════════════════════════════════════════════════════════════════
-- ALTER ... DROP NOT NULL é idempotente no Postgres (não falha se já nullable).
ALTER TABLE public.wa_instance ALTER COLUMN client_token DROP NOT NULL;

-- ════════════════════════════════════════════════════════════════
-- 4) Novas colunas provider e base_url
-- ════════════════════════════════════════════════════════════════
ALTER TABLE public.wa_instance
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'zapi',
  ADD COLUMN IF NOT EXISTS base_url  TEXT;

-- ════════════════════════════════════════════════════════════════
-- 5) CHECK constraint de provider (idempotente via pg_constraint)
-- ════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'wa_instance_provider_check'
     ) THEN
    ALTER TABLE public.wa_instance
      ADD CONSTRAINT wa_instance_provider_check CHECK (provider IN ('zapi', 'evolution'));
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════
-- 6) Corrigir funções de particionamento que referenciavam zapi_action_log
--    (agora a tabela se chama wa_action_log)
-- ════════════════════════════════════════════════════════════════
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
END;
$$;

CREATE OR REPLACE FUNCTION public.drop_zapi_action_log_partitions_older_than_90d()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  cutoff           DATE := (NOW() - interval '90 days')::DATE;
  partition_record RECORD;
BEGIN
  FOR partition_record IN
    SELECT inhrelid::regclass AS partition_name,
           pg_get_expr(relpartbound, inhrelid) AS bound
    FROM pg_inherits
    JOIN pg_class ON oid = inhrelid
    WHERE inhparent = 'public.wa_action_log'::regclass
  LOOP
    IF partition_record.bound ~ 'TO \(''[0-9-]+''\)' THEN
      DECLARE
        upper_bound DATE := substring(partition_record.bound from 'TO \(''([0-9-]+)''\)')::DATE;
      BEGIN
        IF upper_bound <= cutoff THEN
          EXECUTE format('DROP TABLE IF EXISTS %s', partition_record.partition_name);
        END IF;
      END;
    END IF;
  END LOOP;
END;
$$;

-- ════════════════════════════════════════════════════════════════
-- 7) Views de compat (shim de depreciação — remover numa versão futura)
--    A view zapi_instance expõe auth_token como "token" para não quebrar
--    código que ainda lê a coluna pelo nome antigo.
--    A view zapi_action_log é um alias simples sobre wa_action_log.
-- ════════════════════════════════════════════════════════════════
DROP VIEW IF EXISTS public.zapi_instance CASCADE;
CREATE VIEW public.zapi_instance AS
  SELECT
    id,
    instance_id,
    auth_token          AS token,
    client_token,
    webhook_url,
    phone_connected,
    is_active,
    last_connected_at,
    last_disconnected_at,
    created_at,
    updated_at,
    alias,
    is_default,
    webhook_token
  FROM public.wa_instance;

DROP VIEW IF EXISTS public.zapi_action_log CASCADE;
CREATE VIEW public.zapi_action_log AS
  SELECT * FROM public.wa_action_log;

NOTIFY pgrst, 'reload schema';
