-- ════════════════════════════════════════════════════════════════
-- 0034 — nurture_backfill: controle do "nutrir o passado"
--
-- A rotina de nutrição (skills/nutrir-contatos) varre o histórico
-- COMPLETO de um contato uma única vez: quando o contato é criado no
-- vault (com a integração WhatsApp ligada) ou em lotes diários até
-- esgotar os contatos existentes. Esta tabela marca quem já foi
-- varrido — telefone E.164 sem '+', o mesmo formato do vault.
--
-- Aditiva e clean-apply. Sem FK: o telefone referencia o vault de
-- contatos (expert-contacts), não uma tabela local.
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.nurture_backfill (
  phone       TEXT PRIMARY KEY,
  entity_id   TEXT NOT NULL,
  done_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  msgs_read   INT NOT NULL DEFAULT 0
);

-- Varredura por remetente em grupos (history mode filtra sender_phone)
CREATE INDEX IF NOT EXISTS idx_messages_sender_phone
  ON public.messages (sender_phone)
  WHERE sender_phone IS NOT NULL;
