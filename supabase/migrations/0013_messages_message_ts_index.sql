-- ════════════════════════════════════════════════════════════════
-- Indice global em messages.message_ts
-- ════════════════════════════════════════════════════════════════
-- Motivacao: o MCP whatsapp-agent passou a ordenar/filtrar por message_ts
-- (data ORIGINAL da mensagem no WhatsApp) ao inves de created_at, pra que
-- mensagens importadas via backfill historico (provider_msg_id LIKE 'csv_%')
-- aparecam na ordem cronologica correta — e nao todas empilhadas na data de
-- importacao.
--
-- Sem indice global em message_ts, queries por janela temporal (ex:
-- "ultimas 100 mensagens", "mensagens em abril/2025") fazem seq scan em
-- centenas de milhares de linhas e dao statement timeout.
--
-- O indice existente idx_messages_chat_ts (chat_id, message_ts DESC) so
-- ajuda quando ha filtro por chat_id especifico — nao serve pra varreduras
-- globais.

CREATE INDEX IF NOT EXISTS idx_messages_message_ts
  ON public.messages(message_ts);

COMMENT ON INDEX public.idx_messages_message_ts IS
  'Acelera queries por janela temporal global (sem chat_id). Usado pelo MCP whatsapp-agent (read/search/inbox), pelo importer ChatGuru e pelo reconcile pos-import.';
