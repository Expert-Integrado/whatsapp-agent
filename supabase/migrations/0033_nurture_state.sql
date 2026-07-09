-- ════════════════════════════════════════════════════════════════
-- 0033 — nurture_state: cursor da rotina de nutrição de contatos
--
-- A rotina diária (skills/nutrir-contatos) lê as mensagens novas de
-- cada chat, extrai fatos/interações e registra no vault de contatos
-- (expert-contacts). Esta tabela guarda APENAS o cursor incremental
-- por chat — nunca conteúdo — pra rodada seguinte não reprocessar
-- mensagem já vista (cache de obsolescência).
--
-- Aditiva e clean-apply. Segue as chaves compostas multi-instância
-- da 0028: PK/FK (instance_id, chat_id).
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.nurture_state (
  instance_id        TEXT NOT NULL,
  chat_id            TEXT NOT NULL,
  last_processed_ts  TIMESTAMPTZ NOT NULL,
  last_run_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  events_registered  INT NOT NULL DEFAULT 0,
  PRIMARY KEY (instance_id, chat_id),
  FOREIGN KEY (instance_id, chat_id)
    REFERENCES public.chats(instance_id, chat_id) ON DELETE CASCADE
);
