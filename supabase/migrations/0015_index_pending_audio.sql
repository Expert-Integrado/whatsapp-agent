-- Migration 0015 — Index parcial pra acelerar batch da transcricao
--
-- Contexto:
--   Tabela `messages` cresceu pra 1.45M linhas. Query do `transcribe-queue`
--   batch (cron a cada 2min) que filtra ptt/audio sem content estourava
--   statement_timeout (10.2s vs limite 8s) — cron rodava vazio silenciosamente
--   por dias.
--
-- Solucao:
--   Index parcial cobrindo APENAS as linhas que o batch realmente acessa
--   (audio/ptt sem content). Em 1.45M rows, pendentes sao tipicamente <100,
--   entao o index e pequeno e ordenado por created_at DESC alinha com o
--   ORDER BY da query.
--
-- Resultado esperado:
--   Query batch passa de ~10s pra <100ms.

CREATE INDEX IF NOT EXISTS idx_messages_pending_audio
  ON public.messages (created_at DESC)
  WHERE message_type IN ('ptt', 'audio')
    AND (content IS NULL OR content = '');

COMMENT ON INDEX public.idx_messages_pending_audio IS
  'Index parcial pra acelerar batch transcribe-queue (mensagens audio/ptt sem content). Pequeno, atualizado quando msg vira "transcrita" (sai do filtro automaticamente).';
