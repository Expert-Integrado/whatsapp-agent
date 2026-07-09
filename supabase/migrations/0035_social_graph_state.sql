-- ════════════════════════════════════════════════════════════════
-- 0035 — social_graph_state: cursor do grafo social de interações
--
-- O script scripts/social-graph.mjs lê replies diretos em grupos
-- (quoted_msg_id), agrega pares "quem conversa com quem" e empurra
-- pro vault de contatos (expert-contacts specs/whatsapp-interactions.md).
-- Linha única com o cursor global — só mensagens novas por rodada.
--
-- Aditiva e clean-apply.
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.social_graph_state (
  id                 INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_processed_ts  TIMESTAMPTZ NOT NULL,
  last_run_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  pairs_pushed       INT NOT NULL DEFAULT 0
);

-- Varredura de replies por período (o filtro dominante é quoted_msg_id + ts)
CREATE INDEX IF NOT EXISTS idx_messages_quoted_ts
  ON public.messages (message_ts)
  WHERE quoted_msg_id IS NOT NULL;
