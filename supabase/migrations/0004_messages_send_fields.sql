-- ════════════════════════════════════════════════════════════════
-- Campos de envio via agente na tabela messages
-- ════════════════════════════════════════════════════════════════
ALTER TABLE public.messages
  ADD COLUMN send_status TEXT CHECK (send_status IN ('pending','sent','delivered','read','failed')),
  ADD COLUMN send_error TEXT,
  ADD COLUMN sent_by_agent BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN agent_request_id UUID;

CREATE INDEX idx_messages_send_status ON public.messages(send_status) WHERE send_status IS NOT NULL;
CREATE INDEX idx_messages_agent ON public.messages(sent_by_agent) WHERE sent_by_agent = true;
