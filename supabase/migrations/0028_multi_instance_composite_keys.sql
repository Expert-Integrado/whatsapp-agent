-- 0028_multi_instance_composite_keys.sql
-- Multi-instância (Fase 3/janela): backfill + troca de chaves para compostas
-- (instance_id, chat_id). RODAR COM WEBHOOK PAUSADO. Transacional.
--
-- ⚠️ ANTES DE APLICAR: confirmar os nomes REAIS das constraints em produção
--    (podem divergir dos defaults abaixo). Rodar:
--    SELECT conrelid::regclass AS t, conname, contype FROM pg_constraint
--    WHERE conrelid::regclass::text IN ('public.chats','public.messages',
--      'public.lid_mapping','public.chat_categories','public.group_participants',
--      'public.message_reactions') ORDER BY t, contype;
--    e ajustar os DROP CONSTRAINT abaixo se necessário.
BEGIN;

-- ── 0. Backfill das linhas antigas (pré-webhook-carimbo) com a instância default
DO $$
DECLARE def_inst TEXT;
BEGIN
  SELECT instance_id INTO def_inst FROM public.zapi_instance WHERE is_default LIMIT 1;
  IF def_inst IS NULL THEN RAISE EXCEPTION 'instância default não encontrada'; END IF;
  UPDATE public.chats              SET instance_id = def_inst WHERE instance_id IS NULL;
  UPDATE public.messages           SET instance_id = def_inst WHERE instance_id IS NULL;
  UPDATE public.lid_mapping        SET instance_id = def_inst WHERE instance_id IS NULL;
  UPDATE public.message_reactions  SET instance_id = def_inst WHERE instance_id IS NULL;
  UPDATE public.group_participants SET instance_id = def_inst WHERE instance_id IS NULL;
  UPDATE public.chat_categories    SET instance_id = def_inst WHERE instance_id IS NULL;
  UPDATE public.zapi_action_log    SET instance_id = def_inst WHERE instance_id IS NULL;
END $$;

-- ── 1. Garantir zero NULL antes de NOT NULL (proteção do UNIQUE composto)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.messages WHERE instance_id IS NULL)
     OR EXISTS (SELECT 1 FROM public.chats WHERE instance_id IS NULL)
  THEN RAISE EXCEPTION 'ainda há instance_id NULL — abortar'; END IF;
END $$;

-- ── 2. NOT NULL (zapi_action_log fica nullable de propósito: fallback auditoria)
ALTER TABLE public.chats              ALTER COLUMN instance_id SET NOT NULL;
ALTER TABLE public.messages           ALTER COLUMN instance_id SET NOT NULL;
ALTER TABLE public.lid_mapping        ALTER COLUMN instance_id SET NOT NULL;
ALTER TABLE public.message_reactions  ALTER COLUMN instance_id SET NOT NULL;
ALTER TABLE public.group_participants ALTER COLUMN instance_id SET NOT NULL;
ALTER TABLE public.chat_categories    ALTER COLUMN instance_id SET NOT NULL;

-- ── 3. Dropar FKs que dependem de chats.chat_id ANTES de trocar a PK
ALTER TABLE public.messages           DROP CONSTRAINT messages_chat_id_fkey;
ALTER TABLE public.chat_categories    DROP CONSTRAINT chat_categories_chat_id_fkey;
ALTER TABLE public.group_participants DROP CONSTRAINT group_participants_chat_id_fkey;

-- ── 4. Trocar a PK de chats para composta
ALTER TABLE public.chats DROP CONSTRAINT chats_pkey;
ALTER TABLE public.chats ADD PRIMARY KEY (instance_id, chat_id);

-- ── 5. FK de instance_id -> zapi_instance (chats + filhas)
ALTER TABLE public.chats
  ADD CONSTRAINT chats_instance_fk FOREIGN KEY (instance_id) REFERENCES public.zapi_instance(instance_id);

-- ── 6. Recriar FKs compostas filhas -> chats(instance_id, chat_id)
ALTER TABLE public.messages
  ADD CONSTRAINT messages_chat_fk FOREIGN KEY (instance_id, chat_id)
  REFERENCES public.chats(instance_id, chat_id) ON DELETE CASCADE;
ALTER TABLE public.chat_categories
  ADD CONSTRAINT chat_categories_chat_fk FOREIGN KEY (instance_id, chat_id)
  REFERENCES public.chats(instance_id, chat_id) ON DELETE CASCADE;
ALTER TABLE public.group_participants
  ADD CONSTRAINT group_participants_chat_fk FOREIGN KEY (instance_id, chat_id)
  REFERENCES public.chats(instance_id, chat_id) ON DELETE CASCADE;

-- ── 7. messages: provider_msg_id global -> UNIQUE(instance_id, provider_msg_id)
ALTER TABLE public.messages DROP CONSTRAINT messages_provider_msg_id_key;
ALTER TABLE public.messages
  ADD CONSTRAINT messages_instance_provider_unique UNIQUE (instance_id, provider_msg_id);

-- ── 8. lid_mapping PK composta
ALTER TABLE public.lid_mapping DROP CONSTRAINT lid_mapping_pkey;
ALTER TABLE public.lid_mapping ADD PRIMARY KEY (instance_id, lid);

-- ── 9. message_reactions UNIQUE composta
ALTER TABLE public.message_reactions DROP CONSTRAINT message_reactions_target_msg_id_reactor_phone_key;
ALTER TABLE public.message_reactions
  ADD CONSTRAINT message_reactions_inst_unique UNIQUE (instance_id, target_msg_id, reactor_phone);

-- ── 10. chat_categories PK composta
ALTER TABLE public.chat_categories DROP CONSTRAINT chat_categories_pkey;
ALTER TABLE public.chat_categories ADD PRIMARY KEY (instance_id, chat_id, category_id);

-- ── 11. group_participants UNIQUE composta
ALTER TABLE public.group_participants DROP CONSTRAINT group_participants_chat_id_phone_key;
ALTER TABLE public.group_participants
  ADD CONSTRAINT group_participants_inst_unique UNIQUE (instance_id, chat_id, phone);

-- ── 12. Índice de mensagens com instância no prefixo
DROP INDEX IF EXISTS idx_messages_chat_ts;
CREATE INDEX idx_messages_inst_chat_ts ON public.messages(instance_id, chat_id, message_ts DESC);

-- ── 13. Recriar trigger 0014 (JOIN por chave composta — senão SELECT INTO ambíguo)
--     JWT service_role idêntico ao da 0014 (mesma instância Supabase).
CREATE OR REPLACE FUNCTION public.trigger_transcribe_on_media_done()
RETURNS TRIGGER AS $$
DECLARE
  msg_type    TEXT;
  msg_content TEXT;
  is_private  BOOLEAN;
BEGIN
  IF NEW.download_status = 'done' AND (OLD.download_status IS DISTINCT FROM 'done') THEN
    SELECT m.message_type, m.content, NOT c.is_group
      INTO msg_type, msg_content, is_private
    FROM public.messages m
    JOIN public.chats c ON c.instance_id = m.instance_id AND c.chat_id = m.chat_id
    WHERE m.id = NEW.message_id;
    IF msg_type IN ('ptt', 'audio')
       AND (msg_content IS NULL OR msg_content = '')
       AND is_private THEN
      PERFORM net.http_post(
        url := 'https://<SUPABASE_PROJECT_ID>.supabase.co/functions/v1/transcribe-queue?id=' || NEW.message_id::text,
        headers := '{"Authorization":"Bearer <SUPABASE_SERVICE_ROLE_KEY>"}'::jsonb
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── 14. Recriar as 3 views com chave composta
DROP VIEW IF EXISTS public.v_chats_with_contact;
CREATE VIEW public.v_chats_with_contact AS
SELECT c.*, c.chat_name AS contact_name,
       NULL::text AS contact_given, NULL::text AS contact_photo, NULL::text[] AS contact_emails
FROM public.chats c;

DROP VIEW IF EXISTS public.v_messages_with_sender;
CREATE VIEW public.v_messages_with_sender AS
SELECT m.*, m.sender_name AS sender_contact_name, NULL::text AS sender_photo,
       c.chat_name AS chat_display_name, c.is_group AS chat_is_group
FROM public.messages m
LEFT JOIN public.chats c ON c.instance_id = m.instance_id AND c.chat_id = m.chat_id;

DROP VIEW IF EXISTS public.v_chats_with_categories;
CREATE VIEW public.v_chats_with_categories AS
SELECT c.instance_id, c.chat_id, c.chat_name, c.is_group, c.last_message_at,
       c.last_received_at, c.last_sent_at, c.linked_pipedrive_person_id,
       COALESCE(array_agg(cat.slug ORDER BY cat.slug) FILTER (WHERE cat.slug IS NOT NULL), ARRAY[]::TEXT[]) AS category_slugs,
       COALESCE(array_agg(cat.label ORDER BY cat.label) FILTER (WHERE cat.label IS NOT NULL), ARRAY[]::TEXT[]) AS category_labels
FROM public.chats c
LEFT JOIN public.chat_categories cc ON cc.instance_id = c.instance_id AND cc.chat_id = c.chat_id
LEFT JOIN public.categories cat ON cat.id = cc.category_id
GROUP BY c.instance_id, c.chat_id;

NOTIFY pgrst, 'reload schema';
COMMIT;
