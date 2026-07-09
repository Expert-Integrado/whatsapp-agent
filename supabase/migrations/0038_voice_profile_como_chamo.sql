-- ════════════════════════════════════════════════════════════════
-- 0038 — voice_profile ganha como_chamo (como o dono chama a pessoa)
--
-- Pedido do dono (09/07/2026): alem de "como a pessoa me chama"
-- (como_me_chama), registrar "como EU chamo a pessoa" (como_chamo),
-- pro agente usar o vocativo certo ao redigir em nome dele.
-- como_chamo so pode ser aprendido de mensagem AUTENTICA do dono:
-- sent_by_agent = false e, quando raw_payload.fromApi nao existir
-- (historico importado), so mensagens ate 2026-04-15 (pre-agente).
--
-- Coluna e JSONB opaco — so o COMMENT muda (documentacao do shape).
-- ════════════════════════════════════════════════════════════════

COMMENT ON COLUMN public.chats.voice_profile IS
  'Perfil de voz do contato (JSONB): { como_me_chama: string[] (vocativos que a pessoa usa com o dono), '
  'como_chamo: string[] (vocativos que o dono usa com ela — aprender so de msg autentica do dono, nunca de agente), '
  'girias: string[], registro: string (1 linha), exemplos: string[] (2-3 citacoes <=80 chars), '
  'confianca: alta|media|baixa, fonte: backfill|manual|incremental, analisado_em: ISO }. '
  'NULL = nunca analisado. Lido pelo read; escrito via annotate (merge raso por chave de topo).';
