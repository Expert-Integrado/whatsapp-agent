-- ════════════════════════════════════════════════════════════════
-- 0037 — sent_by_agent sem buraco: fromApi do webhook
--
-- messages.sent_by_agent (0004) so era gravada pela edge send-message/
-- send-voice. Disparo via API que entrava so pelo webhook (ex: zapi_action
-- direto, ou insert da edge que falhou) ficava false — 317 linhas em prod
-- (auditoria 09/07/2026 via raw_payload->>'fromApi'). process-webhook
-- agora grava sent_by_agent = fromApi no insert; aqui o backfill
-- idempotente do historico.
--
-- Semantica final da coluna: true = disparada por agente/automacao via
-- API; false = digitada pelo dono no aparelho. Historico importado sem
-- raw_payload.fromApi e confiavel como "dono" so ate 2026-04-15 (antes
-- do primeiro agente conectado) — regra usada pelo backfill de voice
-- profile ao aprender a voz do dono.
-- ════════════════════════════════════════════════════════════════

UPDATE public.messages
   SET sent_by_agent = true
 WHERE from_me = true
   AND sent_by_agent = false
   AND raw_payload->>'fromApi' = 'true';

COMMENT ON COLUMN public.messages.sent_by_agent IS
  'true = enviada por agente/automacao via API (edge send-message/send-voice, ou fromApi do webhook). '
  'false = digitada pelo dono no aparelho. Atencao: historico importado sem raw_payload.fromApi '
  'so e confiavel como "dono" ate 2026-04-15 (pre-agente).';
