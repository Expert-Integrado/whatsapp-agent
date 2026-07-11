-- Migration 0048 — categoria operacional de chat 'mapear' (contatos mapeados)
--
-- Decisao 10/07/2026 (Brain fh39xlmxi973): grupos com a categoria 'mapear' ligada
-- alimentam o mapeamento de contatos — a cron de nutricao le o delta do dia desses
-- grupos e cria entidades categoria 'mapeado' no vault (expert-contacts) quando ha
-- pelo menos 1 fato digno de historico. Grupo sem a categoria = ignorado.
--
-- A 0047 ja documentava 'mapear' como categoria operacional, mas nenhuma migration
-- a semeava; o passo 3.5 da skill nutrir-contatos pressupoe o slug existindo.
-- Liga/desliga por frase no chat via categorize_chat/uncategorize_chat (o MCP
-- valida por lookup na tabela — nenhum codigo muda).
--
-- Aditiva e idempotente (ON CONFLICT DO NOTHING). Aplicar em prod via Management
-- API POST /v1/projects/{ref}/database/query — NUNCA `supabase db push` cego
-- (schema_migrations remoto nao segue a numeracao do repo; ver memoria 09/07).

INSERT INTO public.categories (slug, label, color, description) VALUES
  ('mapear', 'Mapear', '#64748b', 'Operacional: grupo alimenta o mapeamento de contatos (cron de nutricao cria mapeados no vault)')
ON CONFLICT (slug) DO NOTHING;
