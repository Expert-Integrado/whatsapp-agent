-- 0049_scheduled_sequences.sql
-- (nasceu como 0047 na branch da feature; renumerada em 11/07/2026 — o slot 0047
-- colidiu com categories_alinhamento_vault, criada em paralelo na main. O registro
-- em prod-Asafe foi realinhado pra 0049 na mesma data.)
-- Agendamento de sequencias de mensagens (envio unico futuro, sem recorrencia).
-- Uma linha = uma sequencia de 1..10 itens (jsonb) pra um chat/instancia, disparada
-- pelo worker edge dispatch-scheduled (cron a cada 1 min). Itens sao imutaveis apos
-- criacao (editar = cancelar + recriar); items_sent e o cursor de progresso/resume.
-- Gate confirmed e satisfeito NA CRIACAO (tool schedule) — o disparo roda confirmed=true.
-- Cron do pg_cron roda em UTC, mas o job e '* * * * *' e a comparacao
-- scheduled_at <= now() e timezone-safe (timestamptz).
BEGIN;

CREATE TABLE IF NOT EXISTS public.scheduled_sequences (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id   text NOT NULL,           -- resolvido na criacao (resolveInstanceKey)
  chat_id       text NOT NULL,           -- resolvido na criacao (resolveChat) — nunca nome/apelido
  chat_name     text,                    -- snapshot pra listagem sem JOIN
  scheduled_at  timestamptz NOT NULL,
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','processing','sent','failed','canceled')),
  items         jsonb NOT NULL,          -- array 1..10; shape espelha params do send/send_voice/send-poll
  items_sent    int  NOT NULL DEFAULT 0, -- cursor: proximo item a enviar (resume + onde falhou)
  error         text,
  created_by    text,                    -- agent_name
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  finished_at   timestamptz
);

COMMENT ON TABLE public.scheduled_sequences IS
  'Sequencias de mensagens agendadas pra envio futuro (tool schedule da mcp-api; worker dispatch-scheduled)';

-- Indice parcial pro worker: so pendentes, ordenadas por vencimento.
CREATE INDEX IF NOT EXISTS idx_scheduled_sequences_due
  ON public.scheduled_sequences (scheduled_at)
  WHERE status = 'pending';

-- RLS padrao do projeto (0006): enable sem policies — so service_role acessa.
ALTER TABLE public.scheduled_sequences ENABLE ROW LEVEL SECURITY;

-- Cron: dispara o worker a cada minuto (idempotente: remove job antigo se existir).
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'dispatch-scheduled') THEN
    PERFORM cron.unschedule('dispatch-scheduled');
  END IF;
END
$do$;

SELECT cron.schedule(
  'dispatch-scheduled',
  '* * * * *',
  $$SELECT public.call_edge_function('/functions/v1/dispatch-scheduled')$$
);

NOTIFY pgrst, 'reload schema';
COMMIT;
