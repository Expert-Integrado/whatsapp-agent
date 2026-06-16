-- Migration 0008 — Adiciona last_received_at e last_sent_at em chats
--
-- Contexto:
--   Inbox preview so mostrava ULTIMA msg (last_message_at), o que escondia o
--   estado real da conversa quando o dono mandava follow-up depois da resposta
--   do lead. A thread parecia "o dono pendente" mas na verdade era "lead pendente".
--
-- Solucao:
--   Separar last_message_at em duas colunas baseadas no fluxo (from_me).
--   process-webhook atualiza ambas conforme direction.
--   MCP inbox retorna ambas e a UI consegue mostrar quem deve responder agora.

ALTER TABLE public.chats
  ADD COLUMN IF NOT EXISTS last_received_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_sent_at     TIMESTAMPTZ;

-- Backfill (best-effort) usando o que existe nas messages
UPDATE public.chats c
SET last_received_at = sub.ts
FROM (
  SELECT chat_id, MAX(message_ts) AS ts
  FROM public.messages
  WHERE from_me = false AND is_deleted = false
  GROUP BY chat_id
) sub
WHERE c.chat_id = sub.chat_id AND c.last_received_at IS NULL;

UPDATE public.chats c
SET last_sent_at = sub.ts
FROM (
  SELECT chat_id, MAX(message_ts) AS ts
  FROM public.messages
  WHERE from_me = true AND is_deleted = false
  GROUP BY chat_id
) sub
WHERE c.chat_id = sub.chat_id AND c.last_sent_at IS NULL;

COMMENT ON COLUMN public.chats.last_received_at IS 'Timestamp da ultima msg RECEBIDA do contato (from_me=false). Atualizado por process-webhook.';
COMMENT ON COLUMN public.chats.last_sent_at     IS 'Timestamp da ultima msg ENVIADA pelo dono (from_me=true). Atualizado por process-webhook + send-message.';

-- Recria a view para expor as novas colunas (CREATE VIEW ... c.* foi resolvido na criacao original, novos campos nao aparecem automaticamente)
DROP VIEW IF EXISTS public.v_chats_with_contact;
CREATE VIEW public.v_chats_with_contact AS
SELECT c.*,
       ct.display_name  AS contact_name,
       ct.given_name    AS contact_given,
       ct.photo_url     AS contact_photo,
       ct.emails        AS contact_emails
FROM public.chats c
LEFT JOIN public.contacts ct ON ct.primary_phone = c.phone;
