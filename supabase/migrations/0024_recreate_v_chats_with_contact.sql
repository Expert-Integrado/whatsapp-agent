-- 0024_recreate_v_chats_with_contact.sql
-- Hotfix: a migration 0023 dropou public.contacts com CASCADE e levou junto a VIEW
-- v_chats_with_contact (que fazia JOIN com contacts). O MCP whatsapp-agent usa essa
-- view em 8 lugares (mcp/index.js linhas 519, 560, 600, 631, 859, 893, 1424, 1441),
-- entao tudo que tenta listar/buscar chats quebrou com:
--   "Could not find the table 'public.v_chats_with_contact' in the schema cache"
--
-- Recria a view sem dependencia de contacts:
--   - contact_name agora vem direto de chats.chat_name (WhatsApp ja entrega isso)
--   - contact_given/photo/emails ficam NULL (nao tem mais essa fonte)
--
-- Mantem a mesma assinatura/colunas do MCP, sem quebrar nada.

BEGIN;

DROP VIEW IF EXISTS public.v_chats_with_contact;

CREATE VIEW public.v_chats_with_contact AS
SELECT c.*,
       c.chat_name        AS contact_name,
       NULL::text         AS contact_given,
       NULL::text         AS contact_photo,
       NULL::text[]       AS contact_emails
FROM public.chats c;

-- Sinaliza PostgREST pra recarregar o schema cache
NOTIFY pgrst, 'reload schema';

COMMIT;
