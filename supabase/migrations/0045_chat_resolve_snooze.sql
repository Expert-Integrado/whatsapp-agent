-- 0045_chat_resolve_snooze.sql
-- Modelo Zendesk aprovado pelo Eric (10/07/2026): acao explicita de "resolvido"
-- mata a cortesia eterna ("obrigado" do lead marcava divida pra sempre), com
-- REABERTURA AUTOMATICA quando chega mensagem nova (last_received_at > resolved_at)
-- e snooze opcional (some ate a data OU ate responderem — comportamento Front).
-- waiting_on cru continua sendo a verdade fisica (quem falou por ultimo);
-- waiting_on_effective e a visao de trabalho (mascara 'me' resolvido).
-- Vive em VIEW (nao em coluna gerada) porque usa now() — expressao volatil.

BEGIN;

ALTER TABLE public.chats
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS snooze_until timestamptz;

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
       (c.business_profile ->> 'description') AS business_description,
       c.resolved_at,
       c.snooze_until,
       CASE
         WHEN c.waiting_on = 'me' AND c.resolved_at IS NOT NULL
              AND (c.last_received_at IS NULL OR c.last_received_at <= c.resolved_at)
              AND (c.snooze_until IS NULL OR now() < c.snooze_until)
         THEN 'resolved'
         ELSE c.waiting_on
       END AS waiting_on_effective
FROM public.chats c;

CREATE OR REPLACE VIEW public.v_chats_with_categories AS
SELECT c.instance_id, c.chat_id, c.chat_name, c.is_group, c.last_message_at,
       c.last_received_at, c.last_sent_at, c.linked_pipedrive_person_id,
       COALESCE(array_agg(cat.slug ORDER BY cat.slug) FILTER (WHERE cat.slug IS NOT NULL), ARRAY[]::TEXT[]) AS category_slugs,
       COALESCE(array_agg(cat.label ORDER BY cat.label) FILTER (WHERE cat.label IS NOT NULL), ARRAY[]::TEXT[]) AS category_labels,
       c.waiting_on,
       CASE
         WHEN c.waiting_on = 'me' AND c.resolved_at IS NOT NULL
              AND (c.last_received_at IS NULL OR c.last_received_at <= c.resolved_at)
              AND (c.snooze_until IS NULL OR now() < c.snooze_until)
         THEN 'resolved'
         ELSE c.waiting_on
       END AS waiting_on_effective
FROM public.chats c
LEFT JOIN public.chat_categories cc ON cc.instance_id = c.instance_id AND cc.chat_id = c.chat_id
LEFT JOIN public.categories cat ON cat.id = cc.category_id
GROUP BY c.instance_id, c.chat_id;

NOTIFY pgrst, 'reload schema';
COMMIT;
