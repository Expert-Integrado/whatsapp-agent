-- Migration 0012 — Audit log de agente nas mensagens enviadas
--
-- Contexto:
--   Hoje messages.sent_by_agent e boolean — diz "foi agente?" mas nao "qual?".
--   o dono pediu rastrear qual instancia mandou: claude-code-vps, openclaw,
--   claude-code-local, etc. Audit log basico, alavancagem alta pra incident
--   response e debug ("qual agente disparou pra X?").
--
--   Tambem cobre o gap apontado pelo conselho de LLMs (sessao 01/05/2026):
--   sem rastreamento por agente, forense impossivel.

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS sent_by_agent_name TEXT;

CREATE INDEX IF NOT EXISTS idx_messages_agent_name
  ON public.messages (sent_by_agent_name)
  WHERE sent_by_agent_name IS NOT NULL;

COMMENT ON COLUMN public.messages.sent_by_agent_name IS
  'Nome da instancia do MCP que originou o send. Ex: claude-code-vps, openclaw, claude-code-local. NULL = mensagem do celular do dono (nao foi via agente). Edge Function send-message persiste o valor recebido no body.';

-- Recria v_messages_with_sender pra expor a coluna nova
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
