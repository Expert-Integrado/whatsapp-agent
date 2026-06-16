-- Migration 0018 — Audit log para zapi-proxy edge function
--
-- Contexto:
--   Item 8.1 do PRD (whatsapp-agent): centralizar chamadas Z-API que hoje saem
--   do MCP local em 4 maquinas (PC, notebook, 2 VPS containers) numa edge
--   function unica `zapi-proxy`. Token Z-API deixa de viver no env do MCP.
--
-- Esta tabela:
--   - Audit log per call (action, params, result, latency, agent_name)
--   - Idempotency: agent_request_id UNIQUE com janela de 24h evita duplicacao
--     em retries de timeout (critico em delete-message, forward-message)
--   - Particionada por mes pra cleanup automatico (LGPD: 90d retencao)
--   - Tambem serve como contador pra rate limit de WRITE/READ actions
--     (DESTRUCTIVE de envio continua usando tabela messages, igual send-message)

-- Partitioned parent table
CREATE TABLE IF NOT EXISTS public.zapi_action_log (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  agent_request_id TEXT,
  action TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('read','write','destructive','rejected')),
  params JSONB,
  method TEXT NOT NULL DEFAULT 'POST',
  result_status INTEGER,
  result_body JSONB,
  error TEXT,
  agent_name TEXT,
  duration_ms INTEGER,
  called_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, called_at)
) PARTITION BY RANGE (called_at);

-- Idempotency: agent_request_id unico (janela enforced via query, nao constraint
-- pq teria que ser unique no parent + cada partition; queries SQL fazem o check).
-- Index parcial pra performance.
CREATE INDEX IF NOT EXISTS idx_zapi_action_log_request_id
  ON public.zapi_action_log (agent_request_id, called_at DESC)
  WHERE agent_request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_zapi_action_log_called_at
  ON public.zapi_action_log (called_at DESC);

CREATE INDEX IF NOT EXISTS idx_zapi_action_log_action_category
  ON public.zapi_action_log (action, category, called_at DESC);

-- Partitions iniciais (mes corrente + proximo mes pra evitar gap)
CREATE TABLE IF NOT EXISTS public.zapi_action_log_2026_05
  PARTITION OF public.zapi_action_log
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');

CREATE TABLE IF NOT EXISTS public.zapi_action_log_2026_06
  PARTITION OF public.zapi_action_log
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

CREATE TABLE IF NOT EXISTS public.zapi_action_log_2026_07
  PARTITION OF public.zapi_action_log
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');

-- Funcao helper pra criar partition do mes seguinte (chamada via cron)
CREATE OR REPLACE FUNCTION public.create_zapi_action_log_partition_next_month()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  next_month DATE := date_trunc('month', NOW() + interval '1 month')::DATE;
  month_after DATE := date_trunc('month', NOW() + interval '2 month')::DATE;
  partition_name TEXT := 'zapi_action_log_' || to_char(next_month, 'YYYY_MM');
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.zapi_action_log FOR VALUES FROM (%L) TO (%L)',
    partition_name, next_month, month_after
  );
END;
$$;

-- Funcao helper pra dropar partitions com mais de 90 dias
CREATE OR REPLACE FUNCTION public.drop_zapi_action_log_partitions_older_than_90d()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  cutoff DATE := (NOW() - interval '90 days')::DATE;
  partition_record RECORD;
BEGIN
  FOR partition_record IN
    SELECT inhrelid::regclass AS partition_name,
           pg_get_expr(relpartbound, inhrelid) AS bound
    FROM pg_inherits
    JOIN pg_class ON oid = inhrelid
    WHERE inhparent = 'public.zapi_action_log'::regclass
  LOOP
    -- Parse upper bound from partition expression
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

COMMENT ON TABLE public.zapi_action_log IS
  'Audit log das chamadas Z-API via edge function zapi-proxy. Particionada mensalmente, retencao 90d.';

COMMENT ON COLUMN public.zapi_action_log.agent_request_id IS
  'UUID gerado pelo MCP por call (WRITE/DESTRUCTIVE). Edge faz cache 24h pra idempotency em retries.';

COMMENT ON COLUMN public.zapi_action_log.category IS
  'Categoria da action: read (status/chats/get-contact-info), write (mark-read/send-reaction), destructive (sends/deletes/group ops), rejected (allowlist miss).';
