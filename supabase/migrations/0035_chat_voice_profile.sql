-- ════════════════════════════════════════════════════════════════
-- 0035 — chats.voice_profile: perfil de voz por contato
--
-- Como a pessoa chama o dono (vocativo => nível de intimidade) +
-- gírias/registro dela, pro agente ESPELHAR ao redigir mensagem
-- (soma ao voice_guide global, nunca substitui). Escrito pela tool
-- annotate (merge raso) e pelo backfill scripts/voice-profile-backfill.mjs;
-- lido pela tool read. NULL = contato nunca analisado.
--
-- De carona (higiene): observations e links existiam SÓ no banco de
-- produção, criadas manualmente sem migration — versionadas aqui com
-- IF NOT EXISTS (no-op em prod, necessárias pra clean-apply em banco novo).
--
-- Aditiva e clean-apply. Sem índice: o filtro voice_profile IS NULL do
-- backfill varre poucos milhares de chats (seq scan barato).
-- ════════════════════════════════════════════════════════════════

ALTER TABLE public.chats ADD COLUMN IF NOT EXISTS observations TEXT;
ALTER TABLE public.chats ADD COLUMN IF NOT EXISTS links JSONB;
ALTER TABLE public.chats ADD COLUMN IF NOT EXISTS voice_profile JSONB;

COMMENT ON COLUMN public.chats.voice_profile IS
  'Perfil de voz do contato (JSONB): { como_me_chama: string[], girias: string[], '
  'registro: string (1 linha), exemplos: string[] (2-3 citações <=80 chars), '
  'confianca: alta|media|baixa, fonte: backfill|manual|incremental, analisado_em: ISO }. '
  'NULL = nunca analisado. Lido pelo read; escrito via annotate (merge raso por chave de topo).';

-- PostgREST enxergar as colunas sem esperar o reload periódico (padrão da 0028)
NOTIFY pgrst, 'reload schema';
