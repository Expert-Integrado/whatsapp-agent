-- Migration 0049 — scheduled_sequences (reconstruida do banco em 2026-07-11)
--
-- Historico: foi aplicada direto em prod via MCP em 11/07/2026 (entry '0047' do
-- schema_migrations de la) ANTES de existir arquivo no repo; enquanto isso a
-- numeracao 0047 do repo foi tomada por categories_alinhamento_vault. Este
-- arquivo e a reconstrucao fiel (DDL extraido do banco) pra install do zero.
-- A numeracao do schema_migrations em prod nao segue a do repo (ver cabecalho
-- da 0047) — aplicar via Management API/MCP, nunca `db push` cego.
--
-- Sequencias de mensagens agendadas (tool `schedule` da mcp-api), disparadas
-- pela edge dispatch-scheduled via pg_cron a cada 1 min.

CREATE TABLE IF NOT EXISTS public.scheduled_sequences (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id  text NOT NULL,
  chat_id      text NOT NULL,
  chat_name    text,
  scheduled_at timestamptz NOT NULL,
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','processing','sent','failed','canceled')),
  items        jsonb NOT NULL,
  items_sent   integer NOT NULL DEFAULT 0,
  error        text,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  started_at   timestamptz,
  finished_at  timestamptz
);

CREATE INDEX IF NOT EXISTS idx_scheduled_sequences_due
  ON public.scheduled_sequences (scheduled_at) WHERE status = 'pending';

ALTER TABLE public.scheduled_sequences ENABLE ROW LEVEL SECURITY;

-- Worker a cada minuto (mesmo mecanismo call_edge_function dos crons de media/transcricao)
SELECT cron.schedule(
  'dispatch-scheduled',
  '* * * * *',
  $$SELECT public.call_edge_function('/functions/v1/dispatch-scheduled')$$
);
