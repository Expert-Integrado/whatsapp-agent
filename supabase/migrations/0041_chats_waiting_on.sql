-- 0041_chats_waiting_on.sql
-- Problema: o inbox do mcp-api filtrava waiting_on/min_idle_days EM MEMORIA depois
-- de buscar so os N chats mais recentes ordenados por last_message_at -> chats
-- esperando resposta alem da janela eram PERDIDOS silenciosamente.
-- Fix: waiting_on vira coluna gerada (fonte unica da semantica recv/sent) e o
-- filtro desce pro SQL. Bonus: indice trgm em messages.content pro search parar
-- de fazer full-scan (~1.5M linhas em prod).

BEGIN;

-- 1. Coluna gerada: espelha exatamente a logica que estava no mcp-api
--    (recv > sent = 'me'; sent > recv = 'lead'; empate/ambos null = 'none').
ALTER TABLE public.chats
  ADD COLUMN IF NOT EXISTS waiting_on text GENERATED ALWAYS AS (
    CASE
      WHEN last_received_at IS NULL AND last_sent_at IS NULL THEN 'none'
      WHEN last_sent_at IS NULL THEN 'me'
      WHEN last_received_at IS NULL THEN 'lead'
      WHEN last_received_at > last_sent_at THEN 'me'
      WHEN last_sent_at > last_received_at THEN 'lead'
      ELSE 'none'
    END
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_chats_waiting_on
  ON public.chats (waiting_on, last_message_at);

-- 2. Views ganham waiting_on APPENDED no fim. CREATE OR REPLACE exige as colunas
--    existentes na MESMA ordem — por isso a lista explicita, na ordem em que o
--    c.* da 0028 expandiu (conferida via pg_get_viewdef em prod 10/07/2026).
CREATE OR REPLACE VIEW public.v_chats_with_contact AS
SELECT c.chat_id, c.chat_name, c.is_group, c.is_community, c.is_announcement,
       c.phone, c.profile_thumbnail, c.member_count, c.description,
       c.last_message_at, c.created_at, c.updated_at,
       c.last_received_at, c.last_sent_at, c.linked_pipedrive_person_id,
       c.observations, c.links, c.instance_id,
       c.chat_name AS contact_name,
       NULL::text AS contact_given, NULL::text AS contact_photo, NULL::text[] AS contact_emails,
       c.waiting_on
FROM public.chats c;

CREATE OR REPLACE VIEW public.v_chats_with_categories AS
SELECT c.instance_id, c.chat_id, c.chat_name, c.is_group, c.last_message_at,
       c.last_received_at, c.last_sent_at, c.linked_pipedrive_person_id,
       COALESCE(array_agg(cat.slug ORDER BY cat.slug) FILTER (WHERE cat.slug IS NOT NULL), ARRAY[]::TEXT[]) AS category_slugs,
       COALESCE(array_agg(cat.label ORDER BY cat.label) FILTER (WHERE cat.label IS NOT NULL), ARRAY[]::TEXT[]) AS category_labels,
       c.waiting_on
FROM public.chats c
LEFT JOIN public.chat_categories cc ON cc.instance_id = c.instance_id AND cc.chat_id = c.chat_id
LEFT JOIN public.categories cat ON cat.id = cc.category_id
GROUP BY c.instance_id, c.chat_id;

NOTIFY pgrst, 'reload schema';
COMMIT;

-- 3. Indice trgm pro search de conteudo (ILIKE %q%). Em PROD foi criado com
--    CREATE INDEX CONCURRENTLY (fora de transacao) pra nao bloquear os INSERTs
--    do webhook durante o build. Aqui fica a versao plana pra install do zero
--    (tabela vazia, build instantaneo).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_messages_content_trgm
  ON public.messages USING gin (content gin_trgm_ops);
