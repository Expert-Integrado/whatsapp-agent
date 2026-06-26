-- 0022_drop_presence_events.sql
-- Remove tabela presence_events e cron de cleanup associado.
--
-- Justificativa: tabela armazena eventos inbound de presence (online/typing/recording)
-- e status de delivery (delivered/read/played), mas nenhum codigo le esses dados.
-- 216 MB / 165K rows de dado morto crescendo permanentemente.
--
-- A funcao "digitando..." OUTBOUND (o dono -> destinatario) NAO depende dessa tabela:
-- e implementada via parametro delay_typing/delayTyping no envio Z-API (mcp/index.js).
--
-- Send status (sent/delivered/read) continua sendo atualizado em messages.send_status
-- pelo handleStatus do process-webhook (edge function atualizada na mesma data).
--
-- REQUER: deploy da edge function process-webhook ANTES de aplicar esta migration,
-- caso contrario inserts em presence_events falharao (mas como tabela vai sumir,
-- o erro seria silencioso de qualquer modo).

BEGIN;

-- 1) Remover cron job de cleanup
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cleanup-presence-events') THEN
    PERFORM cron.unschedule('cleanup-presence-events');
  END IF;
END $$;

-- 2) Drop tabela
DROP TABLE IF EXISTS public.presence_events CASCADE;

COMMIT;
