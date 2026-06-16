-- Migration 0017 — Rastreamento de webhooks waitingMessage
--
-- Contexto:
--   Z-API entrega webhook ReceivedCallback com waitingMessage=true quando
--   o WhatsApp Multi-Device ainda nao conseguiu decriptar a mensagem
--   (chaves E2E nao sincronizadas com primario do remetente). Payload vem
--   sem text/audio/image — so metadados. Z-API NAO garante reenvio: pode
--   chegar evento novo com mesmo messageId e conteudo decriptado, ou pode
--   nunca chegar (se primario nao voltar online). Nao ha endpoint REST
--   pra puxar conteudo por messageId.
--
-- Fix anterior:
--   process-webhook v10 (deploy 2026-05-11) faz early-return quando
--   waitingMessage=true. Antes, esses eventos viravam messages com
--   message_type=unknown e bloqueavam o follow-up (unique constraint em
--   provider_msg_id descartava o evento real).
--
-- Esta migration:
--   Marca o evento em webhook_events_raw com was_waiting=true e cria view
--   pra detectar waitings sem follow-up (Z-API nunca decriptou) ou com
--   follow-up resolvido. Permite metrica real da taxa de perda.

ALTER TABLE public.webhook_events_raw
  ADD COLUMN IF NOT EXISTS was_waiting BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_webhook_raw_was_waiting
  ON public.webhook_events_raw (was_waiting, received_at DESC)
  WHERE was_waiting = TRUE;

COMMENT ON COLUMN public.webhook_events_raw.was_waiting IS
  'TRUE quando o webhook veio com waitingMessage=true (Z-API ainda nao decriptou). Marcado pelo process-webhook antes do early-return.';

-- View: waitings com status de follow-up
-- Resolvido = existe row em messages com mesmo provider_msg_id (Z-API mandou evento decriptado depois)
-- Pendente  = ainda dentro da janela de 24h, follow-up pode chegar
-- Perdido   = >24h sem follow-up, conteudo provavelmente nunca chegara
CREATE OR REPLACE VIEW public.v_waiting_messages_status AS
SELECT
  r.id                                 AS raw_event_id,
  r.received_at                        AS waiting_received_at,
  r.payload ->> 'messageId'            AS provider_msg_id,
  r.payload ->> 'phone'                AS phone,
  r.payload ->> 'senderName'           AS sender_name,
  r.payload ->> 'chatName'             AS chat_name,
  (r.payload ->> 'fromMe')::boolean    AS from_me,
  m.id                                 AS resolved_message_id,
  m.message_type                       AS resolved_type,
  m.message_ts                         AS resolved_at,
  CASE
    WHEN m.id IS NOT NULL                                           THEN 'resolved'
    WHEN r.received_at > (NOW() - INTERVAL '24 hours')             THEN 'pending'
    ELSE 'lost'
  END                                  AS status
FROM public.webhook_events_raw r
LEFT JOIN public.messages m
  ON m.provider_msg_id = (r.payload ->> 'messageId')
WHERE r.was_waiting = TRUE;

COMMENT ON VIEW public.v_waiting_messages_status IS
  'Status dos webhooks waitingMessage: resolved (follow-up chegou), pending (<24h), lost (>24h sem follow-up).';
