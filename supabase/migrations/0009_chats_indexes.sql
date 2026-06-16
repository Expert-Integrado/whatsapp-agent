-- Migration 0009 — Indices em chats para acelerar resolveChat() do MCP
--
-- Contexto:
--   resolveChat() do MCP whatsapp-agent faz lookup por phone (variantes BR
--   com/sem 9) e por chat_name (busca por nome de contato). Sem indices
--   esses queries fazem seq scan, ficando lento conforme a tabela cresce.
--
-- Indices criados:
--   - idx_chats_phone: BTREE em phone (lookup exato + ilike prefix)
--   - idx_chats_name_trgm: GIN trigram (ilike substring case-insensitive)
--   - idx_chats_last_message_at: BTREE descending (ordenacao da inbox)
--   - idx_chats_last_received_at: BTREE descending (filtro "leads pendentes")

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_chats_phone
  ON public.chats (phone);

CREATE INDEX IF NOT EXISTS idx_chats_name_trgm
  ON public.chats USING gin (chat_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_chats_last_message_at
  ON public.chats (last_message_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_chats_last_received_at
  ON public.chats (last_received_at DESC NULLS LAST);
