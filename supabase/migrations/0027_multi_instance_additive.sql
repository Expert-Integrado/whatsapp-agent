-- 0027_multi_instance_additive.sql
-- Multi-instância Z-API (Fase 1/aditiva): adiciona instance_id NULLABLE nas
-- tabelas de conversa + alias/is_default em zapi_instance. NÃO troca chaves
-- ainda (isso é a 0028, na janela de manutenção). Seguro, sem downtime.
BEGIN;

-- 1. alias + is_default em zapi_instance
ALTER TABLE public.zapi_instance
  ADD COLUMN IF NOT EXISTS alias      TEXT,
  ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT false;

-- Rotula a instância atual (única hoje) como 'pessoal' e default.
UPDATE public.zapi_instance SET alias = 'pessoal', is_default = true
WHERE alias IS NULL;

-- Cada alias aponta pra uma instância.
ALTER TABLE public.zapi_instance
  ADD CONSTRAINT zapi_instance_alias_unique UNIQUE (alias);

-- 2. instance_id NULLABLE nas tabelas de dados (FK só na 0028, após backfill)
ALTER TABLE public.chats              ADD COLUMN IF NOT EXISTS instance_id TEXT;
ALTER TABLE public.messages           ADD COLUMN IF NOT EXISTS instance_id TEXT;
ALTER TABLE public.lid_mapping        ADD COLUMN IF NOT EXISTS instance_id TEXT;
ALTER TABLE public.message_reactions  ADD COLUMN IF NOT EXISTS instance_id TEXT;
ALTER TABLE public.group_participants ADD COLUMN IF NOT EXISTS instance_id TEXT;
ALTER TABLE public.chat_categories    ADD COLUMN IF NOT EXISTS instance_id TEXT;
ALTER TABLE public.zapi_action_log    ADD COLUMN IF NOT EXISTS instance_id TEXT;

NOTIFY pgrst, 'reload schema';
COMMIT;
