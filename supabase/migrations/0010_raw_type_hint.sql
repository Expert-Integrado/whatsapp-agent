-- Migration 0010 — Adiciona raw_type_hint em messages
--
-- Contexto:
--   Quando Z-API entrega um payload sem nenhum dos campos conhecidos
--   (text/image/audio/video/document/sticker/location/contact/poll), o
--   process-webhook salva message_type="unknown" sem indicar o que era.
--   Resultado: msgs aparecem mudas no read/search.
--
-- Solucao:
--   Coluna raw_type_hint guarda a primeira chave nao trivial do payload
--   (ex: "reaction", "ephemeral", "groupNotification") como pista.
--   process-webhook v9 popula no momento da insercao.

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS raw_type_hint TEXT;

CREATE INDEX IF NOT EXISTS idx_messages_raw_type_hint
  ON public.messages (raw_type_hint)
  WHERE raw_type_hint IS NOT NULL;

COMMENT ON COLUMN public.messages.raw_type_hint IS 'Quando message_type=unknown, guarda a primeira chave nao-trivial do raw_payload pra investigacao.';

-- Recria a view v_messages_with_sender pra expor raw_type_hint
DROP VIEW IF EXISTS public.v_messages_with_sender;
CREATE VIEW public.v_messages_with_sender AS
SELECT m.*,
       ct.display_name AS sender_contact_name,
       ct.photo_url    AS sender_photo,
       c.chat_name     AS chat_display_name,
       c.is_group      AS chat_is_group
FROM public.messages m
LEFT JOIN public.chats c     ON c.chat_id = m.chat_id
LEFT JOIN public.contacts ct ON ct.primary_phone = m.sender_phone;
