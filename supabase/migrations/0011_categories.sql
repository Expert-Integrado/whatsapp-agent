-- Migration 0011 — Categorias de chats + linked_pipedrive_person_id
--
-- Contexto:
--   o dono quer categorizar conversas (pessoal, trabalho, saude, familia, cliente,
--   prospect, fornecedor, comunidade, descartar) pra:
--   1. Filtrar tools/skills (inbox, search, read) por categoria — economizar tokens
--   2. Skill diaria "estou devendo resposta" filtrada por categoria
--   3. Cruzamento com Pipedrive deals/persons (FK soft, nullable)
--
-- Decisao de schema:
--   Tabela separada `categories` + tabela ligacao N:N `chat_categories` (em vez de
--   coluna text[] em chats). Razoes:
--   - View v_chats_with_contact usa `c.*` — ALTER em chats exige DROP+CREATE da
--     view (precedente em migration 0008). Tabela separada blinda.
--   - Renomear/fundir categoria depois e UPDATE simples em chat_categories vs
--     reescrever 910 arrays.
--   - Suporta metadata (cor, slug, label) em categories e (assigned_at, assigned_by,
--     confidence) em chat_categories — essencial pra categorizacao LLM-assistida.
--   - Auto-descoberta via `SELECT slug, label FROM categories ORDER BY label`.
--   - Multi-valor nativo (Camila pode ser pessoal + cliente).
--
-- NAO foi criada coluna "check de resposta": ja existe last_received_at e
-- last_sent_at em chats (migration 0008). MCP `inbox` ja computa waiting_on.
-- Skill "estou devendo" filtra: waiting_on='me' AND is_group=false AND
-- last_received_at < now() - interval '1 day'.

-- ─── 1. categories — tabela mestre de categorias possiveis ───────────────────
CREATE TABLE IF NOT EXISTS public.categories (
  id          BIGSERIAL PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,           -- normalizado: lowercase, sem acento, ascii
  label       TEXT NOT NULL,                  -- display ("Saúde", "Família")
  color       TEXT,                           -- hex opcional pra UI futura
  description TEXT,                           -- explicacao do escopo da categoria
  parent_id   BIGINT REFERENCES public.categories(id) ON DELETE SET NULL,  -- hierarquia opcional
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Constraint pra slug normalizado: ascii, lowercase, sem acento, sem espaco
ALTER TABLE public.categories
  ADD CONSTRAINT categories_slug_normalized
  CHECK (slug = lower(slug) AND slug ~ '^[a-z0-9_-]+$');

-- ─── 2. chat_categories — tabela de ligacao N:N ──────────────────────────────
CREATE TABLE IF NOT EXISTS public.chat_categories (
  chat_id      TEXT NOT NULL REFERENCES public.chats(chat_id) ON DELETE CASCADE,
  category_id  BIGINT NOT NULL REFERENCES public.categories(id) ON DELETE CASCADE,
  assigned_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  assigned_by  TEXT NOT NULL DEFAULT 'manual',     -- 'manual' | 'llm' | 'rule:<nome>'
  confidence   NUMERIC(3,2),                       -- 0.00-1.00 (LLM categorizou com qual confianca)
  notes        TEXT,                               -- justificativa opcional do agente
  PRIMARY KEY (chat_id, category_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_categories_chat ON public.chat_categories (chat_id);
CREATE INDEX IF NOT EXISTS idx_chat_categories_category ON public.chat_categories (category_id);
CREATE INDEX IF NOT EXISTS idx_chat_categories_assigned_at ON public.chat_categories (assigned_at DESC);

COMMENT ON COLUMN public.chat_categories.assigned_by IS 'Quem atribuiu: manual (o dono), llm (modelo via tool categorize_chat), rule:<nome> (regra automatica).';
COMMENT ON COLUMN public.chat_categories.confidence IS 'Confianca da atribuicao quando assigned_by=llm. NULL pra manual.';

-- ─── 3. linked_pipedrive_person_id em chats — FK soft pro CRM ────────────────
-- Nullable porque a maioria dos chats pessoais nao tem deal/person no Pipedrive.
-- Sem FK constraint (Pipedrive vive fora do Postgres) — apenas metadata.
ALTER TABLE public.chats
  ADD COLUMN IF NOT EXISTS linked_pipedrive_person_id BIGINT;

CREATE INDEX IF NOT EXISTS idx_chats_pipedrive_person ON public.chats (linked_pipedrive_person_id)
  WHERE linked_pipedrive_person_id IS NOT NULL;

COMMENT ON COLUMN public.chats.linked_pipedrive_person_id IS 'ID do person no Pipedrive (cruzamento WhatsApp x CRM). NULL = sem ligacao.';

-- ─── 4. Recria v_chats_with_contact pra expor a coluna nova ──────────────────
-- (precedente: migration 0008 e 0010 fazem o mesmo padrao quando ALTER em chats)
DROP VIEW IF EXISTS public.v_chats_with_contact;
CREATE VIEW public.v_chats_with_contact AS
SELECT c.*,
       ct.display_name  AS contact_name,
       ct.given_name    AS contact_given,
       ct.photo_url     AS contact_photo,
       ct.emails        AS contact_emails
FROM public.chats c
LEFT JOIN public.contacts ct ON ct.primary_phone = c.phone;

-- ─── 5. Seed das categorias iniciais ─────────────────────────────────────────
-- o dono pode adicionar/remover via SQL ou via tool MCP. Slugs normalizados.
INSERT INTO public.categories (slug, label, color, description) VALUES
  ('pessoal',    'Pessoal',     '#a78bfa', 'Conversas pessoais nao-familiares (amigos, conhecidos)'),
  ('familia',    'Família',     '#fb7185', 'Familiares diretos e proximos'),
  ('saude',      'Saúde',       '#34d399', 'Medicos, clinicas, farmacia, planos, exames'),
  ('trabalho',   'Trabalho',    '#60a5fa', 'Time interno Expert Integrado'),
  ('cliente',    'Cliente',     '#f59e0b', 'Clientes ativos / contratos vigentes'),
  ('prospect',   'Prospect',    '#fbbf24', 'Leads e prospeccoes em andamento'),
  ('fornecedor', 'Fornecedor',  '#94a3b8', 'Fornecedores e parceiros recorrentes'),
  ('comunidade', 'Comunidade',  '#22d3ee', 'Grupos de comunidade (G4, eventos, networking)'),
  ('descartar',  'Descartar',   '#9ca3af', 'Marcado pra ignorar em skills automaticas (spam, bot, antigo)')
ON CONFLICT (slug) DO NOTHING;

-- ─── 6. View utilitaria: categorias agregadas por chat ───────────────────────
-- Facilita consulta "este chat tem quais categorias?" sem JOIN explicito.
DROP VIEW IF EXISTS public.v_chats_with_categories;
CREATE VIEW public.v_chats_with_categories AS
SELECT c.chat_id,
       c.chat_name,
       c.is_group,
       c.last_message_at,
       c.last_received_at,
       c.last_sent_at,
       c.linked_pipedrive_person_id,
       COALESCE(
         array_agg(cat.slug ORDER BY cat.slug)
           FILTER (WHERE cat.slug IS NOT NULL),
         ARRAY[]::TEXT[]
       ) AS category_slugs,
       COALESCE(
         array_agg(cat.label ORDER BY cat.label)
           FILTER (WHERE cat.label IS NOT NULL),
         ARRAY[]::TEXT[]
       ) AS category_labels
FROM public.chats c
LEFT JOIN public.chat_categories cc ON cc.chat_id = c.chat_id
LEFT JOIN public.categories cat ON cat.id = cc.category_id
GROUP BY c.chat_id;

COMMENT ON VIEW public.v_chats_with_categories IS 'Chats com array de slugs/labels das categorias atribuidas. Usar em queries que filtram por categoria sem JOIN explicito: WHERE category_slugs && ARRAY[''cliente'',''prospect''].';

-- ─── 7. RLS — segue o padrao do projeto (service_role only) ──────────────────
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_categories ENABLE ROW LEVEL SECURITY;
-- Sem policies = so service_role acessa. Padrao do whatsapp-agent.
