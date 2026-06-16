-- ════════════════════════════════════════════════════════════════
-- EXTENSÃO pg_trgm (busca fuzzy em contatos)
-- ════════════════════════════════════════════════════════════════
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ════════════════════════════════════════════════════════════════
-- 10) oauth_tokens — tokens OAuth (múltiplas contas por provider)
-- ════════════════════════════════════════════════════════════════
CREATE TABLE public.oauth_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,                   -- 'google'
  account_email TEXT NOT NULL,              -- contato@expertintegrado.com.br | owner@example.com
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  token_type TEXT DEFAULT 'Bearer',
  scope TEXT,
  expires_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (provider, account_email)
);
-- Segredos. Service role only, RLS desligado.

CREATE TRIGGER trg_oauth_tokens_updated
  BEFORE UPDATE ON public.oauth_tokens
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ════════════════════════════════════════════════════════════════
-- 11) contacts — unificado (Google Contacts + descobertos em chats)
-- ════════════════════════════════════════════════════════════════
CREATE TABLE public.contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL CHECK (source IN ('google','whatsapp','manual')),
  source_account TEXT,                      -- email da conta Google (null se whatsapp/manual)
  google_resource_name TEXT,                -- 'people/c12345' se Google
  display_name TEXT,
  given_name TEXT,
  family_name TEXT,
  primary_phone TEXT,                       -- normalizado E.164 sem +
  phones JSONB DEFAULT '[]'::jsonb,         -- [{phone, type, label}]
  emails JSONB DEFAULT '[]'::jsonb,
  organizations JSONB DEFAULT '[]'::jsonb,
  notes TEXT,
  photo_url TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,       -- birthdays, addresses, etc.
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_contacts_primary_phone ON public.contacts(primary_phone);
CREATE INDEX idx_contacts_display_name_trgm ON public.contacts USING gin (display_name gin_trgm_ops);
CREATE UNIQUE INDEX idx_contacts_google_unique ON public.contacts(source_account, google_resource_name)
  WHERE source = 'google';

CREATE TRIGGER trg_contacts_updated
  BEFORE UPDATE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ════════════════════════════════════════════════════════════════
-- Views enriquecidas
-- ════════════════════════════════════════════════════════════════

-- Chat com nome do contato Google
CREATE VIEW public.v_chats_with_contact AS
SELECT c.*,
       ct.display_name  AS contact_name,
       ct.given_name    AS contact_given,
       ct.photo_url     AS contact_photo,
       ct.emails        AS contact_emails
FROM public.chats c
LEFT JOIN public.contacts ct ON ct.primary_phone = c.phone;

-- Mensagem com sender enriquecido
CREATE VIEW public.v_messages_with_sender AS
SELECT m.*,
       ct.display_name AS sender_contact_name,
       ct.photo_url    AS sender_photo,
       c.chat_name     AS chat_display_name,
       c.is_group      AS chat_is_group
FROM public.messages m
LEFT JOIN public.chats c     ON c.chat_id = m.chat_id
LEFT JOIN public.contacts ct ON ct.primary_phone = m.sender_phone;
