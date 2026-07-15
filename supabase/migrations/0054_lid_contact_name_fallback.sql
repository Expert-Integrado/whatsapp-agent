-- 0054_lid_contact_name_fallback.sql
-- Bug (task 5cgs881pew2n item 7, caso Leandro Eckhardt): search/resolveChat NAO
-- achavam chat salvo como @lid pelo nome/numero do contato porque contact_name
-- em v_chats_with_contact e so espelho de chat_name, e chat_name de um chat @lid
-- costuma ser o LID cru ("171287641088230@lid") ou ficar vazio (nameIsJunk no
-- webhook nunca grava lixo em chat_name — ver process-webhook/index.ts:206).
-- O nome real do contato so existe em messages.sender_name (populado pela Z-API
-- em toda mensagem recebida, mesmo quando o chat_id vira @lid).
--
-- Fix: contact_name passa a cair pro sender_name mais recente do chat quando
-- chat_name for nulo/lixo (@lid cru ou so digitos). scoreNameMatch (resolveChat
-- e search chat_name) ja usa contact_name — ganha o fallback de graca, sem
-- mexer em mcp-api/index.ts.

BEGIN;

CREATE OR REPLACE VIEW public.v_chats_with_contact AS
SELECT c.chat_id, c.chat_name, c.is_group, c.is_community, c.is_announcement,
       c.phone, c.profile_thumbnail, c.member_count, c.description,
       c.last_message_at, c.created_at, c.updated_at,
       c.last_received_at, c.last_sent_at, c.linked_pipedrive_person_id,
       c.observations, c.links, c.instance_id,
       CASE
         WHEN NULLIF(c.chat_name, '') IS NOT NULL THEN c.chat_name
         ELSE lm.sender_name
       END AS contact_name,
       NULL::text AS contact_given, NULL::text AS contact_photo, NULL::text[] AS contact_emails,
       c.waiting_on,
       c.contact_about,
       (c.business_profile ->> 'description') AS business_description
FROM public.chats c
LEFT JOIN LATERAL (
  SELECT m.sender_name
    FROM public.messages m
   WHERE m.instance_id = c.instance_id
     AND m.chat_id = c.chat_id
     AND m.sender_name IS NOT NULL
     AND m.sender_name !~ '@lid$'
     AND m.sender_name !~ '^[0-9]+$'
   ORDER BY m.message_ts DESC
   LIMIT 1
) lm ON NULLIF(c.chat_name, '') IS NULL;

NOTIFY pgrst, 'reload schema';
COMMIT;
