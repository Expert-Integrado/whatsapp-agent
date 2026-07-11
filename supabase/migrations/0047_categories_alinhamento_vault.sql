-- Migration 0047 — alinhamento de categorias com o vault de contatos (expert-contacts)
--
-- Decisao 11/07/2026: nucleo comum de SEGMENTOS DE RELACIONAMENTO padronizado nos
-- 3 sistemas (WhatsApp Agent + Instagram Agent, que compartilham esta tabela, e o
-- vault expert-contacts): cliente, lead, aluno, parceiro, fornecedor, equipe,
-- familia, pessoal, network, vip.
--
-- Divisao de papeis:
--   - Categorias OPERACIONAIS de chat (descartar, mapear, resolver, comunidade,
--     palestra) existem SO aqui — descrevem como tratar o chat, nao quem a pessoa e.
--   - 'lead-perdido' existe SO no vault (estado de funil, nao de chat).
--   - Vault = fonte da verdade do segmento da PESSOA; a categoria do chat e estado
--     operacional + espelho do segmento.
--
-- Aditiva e idempotente (ON CONFLICT DO NOTHING). Aplicar em prod via Management
-- API POST /v1/projects/{ref}/database/query — NUNCA `supabase db push` cego
-- (schema_migrations remoto nao segue a numeracao do repo; ver memoria 09/07).

INSERT INTO public.categories (slug, label, color, description) VALUES
  ('aluno',   'Aluno',   '#84cc16', 'Alunos de mentoria, AI Innovation Lab e cursos'),
  ('network', 'Network', '#e879f9', 'Networking sem relacao comercial ativa'),
  ('vip',     'VIP',     '#eab308', 'Contatos VIP — maxima prioridade de atencao')
ON CONFLICT (slug) DO NOTHING;
