-- ════════════════════════════════════════════════════════════════
-- EXTENSIONS
-- ════════════════════════════════════════════════════════════════
CREATE EXTENSION IF NOT EXISTS pgcrypto;
-- pg_cron (agendador) + pg_net (HTTP de dentro do Postgres) são pré-requisito
-- das migrations 0005/0007/0019 (cron.schedule + net.http_post). Habilitadas aqui
-- pra que um banco novo aplique a 0005 sem o erro "schema cron does not exist".
CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- ════════════════════════════════════════════════════════════════
-- HELPER: chamar uma Edge Function de dentro do Postgres (cron/triggers)
-- ════════════════════════════════════════════════════════════════
-- Lê a URL base e a service_role do Supabase Vault em runtime — nada de
-- segredo hardcoded nas migrations. A skill `setup` popula os 2 secrets
-- (`project_url`, `service_role_key`) via vault.create_secret. Enquanto o
-- Vault não estiver populado, a função apenas avisa e não dispara (não quebra
-- o cron nem o trigger).
CREATE OR REPLACE FUNCTION public.call_edge_function(path TEXT)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  base_url TEXT;
  srk      TEXT;
BEGIN
  SELECT decrypted_secret INTO base_url FROM vault.decrypted_secrets WHERE name = 'project_url';
  SELECT decrypted_secret INTO srk      FROM vault.decrypted_secrets WHERE name = 'service_role_key';
  IF base_url IS NULL OR srk IS NULL THEN
    RAISE NOTICE 'call_edge_function: secrets project_url/service_role_key ausentes no Vault — pulando %', path;
    RETURN NULL;
  END IF;
  RETURN net.http_post(
    url     := base_url || path,
    headers := jsonb_build_object('Authorization', 'Bearer ' || srk, 'Content-Type', 'application/json')
  );
END;
$$;

-- ════════════════════════════════════════════════════════════════
-- TIMESTAMP HELPER
-- ════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ════════════════════════════════════════════════════════════════
-- 1) zapi_instance — 1 linha só (instância Z-API do dono)
-- ════════════════════════════════════════════════════════════════
CREATE TABLE public.zapi_instance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id TEXT NOT NULL UNIQUE,
  token TEXT NOT NULL,
  client_token TEXT NOT NULL,
  webhook_url TEXT NOT NULL,
  phone_connected TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_connected_at TIMESTAMPTZ,
  last_disconnected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_zapi_instance_updated
  BEFORE UPDATE ON public.zapi_instance
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ════════════════════════════════════════════════════════════════
-- 2) chats — qualquer chat (grupo, 1:1, comunidade)
-- ════════════════════════════════════════════════════════════════
CREATE TABLE public.chats (
  chat_id TEXT PRIMARY KEY,
  chat_name TEXT,
  is_group BOOLEAN NOT NULL DEFAULT false,
  is_community BOOLEAN NOT NULL DEFAULT false,
  is_announcement BOOLEAN NOT NULL DEFAULT false,
  phone TEXT,
  profile_thumbnail TEXT,
  member_count INT,
  description TEXT,
  last_message_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_chats_updated
  BEFORE UPDATE ON public.chats
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ════════════════════════════════════════════════════════════════
-- 3) messages — toda mensagem enviada/recebida
-- ════════════════════════════════════════════════════════════════
CREATE TABLE public.messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_msg_id TEXT NOT NULL UNIQUE,
  chat_id TEXT NOT NULL REFERENCES public.chats(chat_id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('sent','received')),
  from_me BOOLEAN NOT NULL DEFAULT false,
  sender_phone TEXT,
  sender_name TEXT,
  message_type TEXT NOT NULL,
  content TEXT,
  caption TEXT,
  quoted_msg_id TEXT,
  is_forwarded BOOLEAN NOT NULL DEFAULT false,
  is_edited BOOLEAN NOT NULL DEFAULT false,
  is_deleted BOOLEAN NOT NULL DEFAULT false,
  message_ts TIMESTAMPTZ,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_messages_chat_ts ON public.messages(chat_id, message_ts DESC);
CREATE INDEX idx_messages_provider_id ON public.messages(provider_msg_id);
CREATE INDEX idx_messages_type ON public.messages(message_type);
CREATE INDEX idx_messages_from_me ON public.messages(from_me);

-- ════════════════════════════════════════════════════════════════
-- 4) message_media — uma linha por mídia
-- ════════════════════════════════════════════════════════════════
CREATE TABLE public.message_media (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  mime_type TEXT,
  storage_bucket TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  original_url TEXT,
  file_size_bytes BIGINT,
  duration_seconds INT,
  width INT,
  height INT,
  thumbnail_path TEXT,
  download_status TEXT NOT NULL DEFAULT 'pending' CHECK (download_status IN ('pending','done','failed')),
  download_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_message_media_msg ON public.message_media(message_id);
CREATE INDEX idx_message_media_status ON public.message_media(download_status);

-- ════════════════════════════════════════════════════════════════
-- 5) message_reactions — emojis em mensagens
-- ════════════════════════════════════════════════════════════════
CREATE TABLE public.message_reactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_msg_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  reactor_phone TEXT NOT NULL,
  reactor_name TEXT,
  emoji TEXT,
  from_me BOOLEAN NOT NULL DEFAULT false,
  reacted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_payload JSONB,
  UNIQUE (target_msg_id, reactor_phone)
);

CREATE INDEX idx_reactions_target ON public.message_reactions(target_msg_id);
CREATE INDEX idx_reactions_chat ON public.message_reactions(chat_id);

-- ════════════════════════════════════════════════════════════════
-- 6) message_edits — histórico de edições
-- ════════════════════════════════════════════════════════════════
CREATE TABLE public.message_edits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  previous_content TEXT,
  new_content TEXT,
  edited_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_edits_msg ON public.message_edits(message_id);

-- ════════════════════════════════════════════════════════════════
-- 7) presence_events — online/typing/recording/read
-- ════════════════════════════════════════════════════════════════
CREATE TABLE public.presence_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id TEXT NOT NULL,
  participant_phone TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('online','offline','typing','recording','read','delivered','played')),
  related_msg_id TEXT,
  event_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_payload JSONB
);

CREATE INDEX idx_presence_chat_at ON public.presence_events(chat_id, event_at DESC);
CREATE INDEX idx_presence_participant ON public.presence_events(participant_phone);

-- ════════════════════════════════════════════════════════════════
-- 8) group_participants — membros de grupos
-- ════════════════════════════════════════════════════════════════
CREATE TABLE public.group_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id TEXT NOT NULL REFERENCES public.chats(chat_id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  name TEXT,
  is_admin BOOLEAN NOT NULL DEFAULT false,
  is_super_admin BOOLEAN NOT NULL DEFAULT false,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at TIMESTAMPTZ,
  UNIQUE (chat_id, phone)
);

CREATE INDEX idx_participants_chat ON public.group_participants(chat_id);

-- ════════════════════════════════════════════════════════════════
-- 9) webhook_events_raw — log bruto (debug/replay)
-- ════════════════════════════════════════════════════════════════
CREATE TABLE public.webhook_events_raw (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT,
  payload JSONB NOT NULL,
  processed BOOLEAN NOT NULL DEFAULT false,
  error TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX idx_webhook_raw_received ON public.webhook_events_raw(received_at DESC);
CREATE INDEX idx_webhook_raw_unprocessed ON public.webhook_events_raw(processed) WHERE processed = false;
