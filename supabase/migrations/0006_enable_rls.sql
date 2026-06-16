-- Migration 0006 — Enable RLS on all public tables (single-tenant hardening)
--
-- Contexto:
--   Projeto single-tenant. Acesso legitimo e APENAS via service_role
--   (Edge Functions, MCP Python, skill transcrever-conversa).
--   Sem RLS, qualquer um com a anon key (que e publica) lia tudo.
--
-- Estrategia:
--   1. ENABLE ROW LEVEL SECURITY em todas as tabelas do schema public.
--      Sem policies = bloqueia anon/authenticated por padrao.
--      service_role bypassa RLS (comportamento nativo Postgres/Supabase).
--   2. REVOKE ALL de anon/authenticated no schema (defense-in-depth).
--   3. ALTER DEFAULT PRIVILEGES pra garantir que novos objetos
--      nao recebam privilegios automaticos de anon/authenticated.
--
-- Validado em 22/04/2026:
--   - anon SELECT em messages/chats -> 42501 permission denied
--   - anon listando storage whatsapp-audio -> [] (vazio)
--   - service_role SELECT/INSERT/DELETE funcionando normalmente

ALTER TABLE public.chats              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contacts           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_edits      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_media      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_reactions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oauth_tokens       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.presence_events    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_events_raw ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.zapi_instance      ENABLE ROW LEVEL SECURITY;

-- Defense-in-depth: remove qualquer privilegio residual de anon/authenticated
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;

-- Novos objetos criados no schema tambem ja nascem sem privilegios pra anon/authenticated
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;
