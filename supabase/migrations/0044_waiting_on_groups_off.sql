-- 0044_waiting_on_groups_off.sql
-- Decisao do Eric (10/07/2026): grupo NUNCA participa da semantica de "quem
-- espera resposta" — qualquer msg de qualquer membro marcava 'me', poluindo o
-- inbox. Regra desce pra coluna gerada (fonte unica): is_group => 'none'.
-- Coluna gerada nao aceita ALTER de expressao: DROP+ADD, com DROP/CREATE das
-- views dependentes na mesma transacao (definicoes identicas a 0042).

BEGIN;

DROP VIEW IF EXISTS public.v_chats_with_contact;
DROP VIEW IF EXISTS public.v_chats_with_categories;

ALTER TABLE public.chats DROP COLUMN IF EXISTS waiting_on;
ALTER TABLE public.chats
  ADD COLUMN waiting_on text GENERATED ALWAYS AS (
    CASE
      WHEN is_group THEN 'none'
      WHEN last_received_at IS NULL AND last_sent_at IS NULL THEN 'none'
      WHEN last_sent_at IS NULL THEN 'me'
      WHEN last_received_at IS NULL THEN 'lead'
      WHEN last_received_at > last_sent_at THEN 'me'
      WHEN last_sent_at > last_received_at THEN 'lead'
      ELSE 'none'
    END
  ) STORED;

-- O DROP COLUMN levou o indice junto — recriar.
CREATE INDEX IF NOT EXISTS idx_chats_waiting_on
  ON public.chats (waiting_on, last_message_at);

CREATE VIEW public.v_chats_with_contact AS
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

CREATE VIEW public.v_chats_with_categories AS
SELECT c.instance_id, c.chat_id, c.chat_name, c.is_group, c.last_message_at,
       c.last_received_at, c.last_sent_at, c.linked_pipedrive_person_id,
       COALESCE(array_agg(cat.slug ORDER BY cat.slug) FILTER (WHERE cat.slug IS NOT NULL), ARRAY[]::TEXT[]) AS category_slugs,
       COALESCE(array_agg(cat.label ORDER BY cat.label) FILTER (WHERE cat.label IS NOT NULL), ARRAY[]::TEXT[]) AS category_labels,
       c.waiting_on
FROM public.chats c
LEFT JOIN public.chat_categories cc ON cc.instance_id = c.instance_id AND cc.chat_id = c.chat_id
LEFT JOIN public.categories cat ON cat.id = cc.category_id
GROUP BY c.instance_id, c.chat_id;

-- DROP+CREATE reseta grants (licao Meeting Hub: grants de view nao vem sozinhos).
GRANT SELECT ON public.v_chats_with_contact, public.v_chats_with_categories
  TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
