-- 0030_voice_guide.sql
-- Voice guide migrado do filesystem (mcp/index.js stdio) pro banco — agora server-side,
-- consumivel via MCP remoto (mcp-api) de qualquer harness. Single-tenant:
-- 1 linha global (instance_id NULL) ou 1 por instancia. As regras hard (regex) sao
-- universais e vivem na edge function; aqui guarda so o markdown do guide.

CREATE TABLE IF NOT EXISTS public.voice_guide (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id TEXT,
  content     TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 1 guide por escopo (NULL = global)
CREATE UNIQUE INDEX IF NOT EXISTS voice_guide_scope_uniq
  ON public.voice_guide ((COALESCE(instance_id, '__global__')));

-- Padrao do projeto: RLS on, sem policies = so service_role acessa.
ALTER TABLE public.voice_guide ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.voice_guide IS
  'Voice guide do dono (markdown) — como ele se comunica. Single-tenant. instance_id NULL = global. Regras hard (regex) vivem na edge mcp-api.';
