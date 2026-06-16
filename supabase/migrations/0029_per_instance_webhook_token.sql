-- 0029_per_instance_webhook_token.sql  (APLICADO EM PROD 2026-05-31, durante homologacao)
-- Ajustes descobertos no teste real dos 2 numeros falando ENTRE SI:
--
-- 1) SENHA DE WEBHOOK POR INSTANCIA. Cada instancia Z-API tem seu proprio
--    webhook-token (header z-api-token). O process-webhook valida a senha
--    recebida contra zapi_instance.webhook_token DA INSTANCIA do payload
--    (com TOFU: aprende a senha na 1a requisicao da instancia registrada).
--    Sem isso, o numero novo era rejeitado com 401 (token != o do pessoal).
ALTER TABLE public.zapi_instance ADD COLUMN IF NOT EXISTS webhook_token TEXT;
COMMENT ON COLUMN public.zapi_instance.webhook_token IS
  'Token de seguranca do webhook (header z-api-token) POR INSTANCIA. Aprendido via TOFU no process-webhook.';

-- 2) UNIQUE de messages: provider_msg_id GLOBAL -> (instance_id, provider_msg_id).
--    Quando os 2 numeros do dono falam entre si, e a MESMA mensagem do WhatsApp
--    (mesmo provider_msg_id) dos dois lados: o pessoal grava como 'sent' e o
--    profissional precisa gravar a copia 'received'. Com unique global, a 2a
--    copia batia em 23505 e era descartada. Composto resolve.
--    (Tinha sido DEFERIDO na 0028 por medo de rebuild lento; build foi rapido
--     pois nao havia duplicatas — todas as linhas eram instancia pessoal.)
ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_provider_msg_id_key;
ALTER TABLE public.messages
  ADD CONSTRAINT messages_instance_provider_unique UNIQUE (instance_id, provider_msg_id);

NOTIFY pgrst, 'reload schema';
