-- 0042_contact_profile_cache.sql
-- Recado ('about' do get-contact-info) e perfil business (get-business-profile)
-- persistidos em chats, com refresh lazy no read do mcp-api (TTL 7 dias) — o
-- inbox le o cache direto da view, sem chamada de provider por linha.

BEGIN;

ALTER TABLE public.chats
  ADD COLUMN IF NOT EXISTS contact_about text,
  ADD COLUMN IF NOT EXISTS business_profile jsonb,
  ADD COLUMN IF NOT EXISTS profile_refreshed_at timestamptz;

-- View: colunas novas APPENDED no fim (mesma lista/ordem da 0041).
CREATE OR REPLACE VIEW public.v_chats_with_contact AS
SELECT c.chat_id, c.chat_name, c.is_group, c.is_community, c.is_announcement,
       c.phone, c.profile_thumbnail, c.member_count, c.description,
       c.last_message_at, c.created_at, c.updated_at,
       c.last_received_at, c.last_sent_at, c.linked_pipedrive_person_id,
       c.observations, c.links, c.instance_id,
       c.chat_name AS contact_name,
       NULL::text AS contact_given, NULL::text AS contact_photo, NULL::text[] AS contact_emails,
       c.waiting_on,
       c.contact_about,
       (c.business_profile ->> 'description') AS business_description
FROM public.chats c;

NOTIFY pgrst, 'reload schema';
COMMIT;
