-- 0026_recreate_v_messages_with_sender.sql
-- Hotfix #2: mesma raiz do 0024 — o DROP CASCADE de contacts (migration 0023)
-- tambem levou a view v_messages_with_sender que joinava com contacts.
-- Recria a view sem dependencia de contacts:
--   - sender_contact_name agora vem de messages.sender_name (WhatsApp ja entrega)
--   - sender_photo fica NULL (nao tem mais essa fonte)
--
-- MCP whatsapp-agent usa em 2 lugares (mcp/index.js:1002, 1467) — funcao `read` de chat.

BEGIN;

DROP VIEW IF EXISTS public.v_messages_with_sender;

CREATE VIEW public.v_messages_with_sender AS
SELECT m.*,
       m.sender_name      AS sender_contact_name,
       NULL::text         AS sender_photo,
       c.chat_name        AS chat_display_name,
       c.is_group         AS chat_is_group
FROM public.messages m
LEFT JOIN public.chats c ON c.chat_id = m.chat_id;

NOTIFY pgrst, 'reload schema';

COMMIT;
