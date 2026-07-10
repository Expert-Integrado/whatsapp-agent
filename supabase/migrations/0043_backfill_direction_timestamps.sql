-- 0043_backfill_direction_timestamps.sql
-- last_received_at/last_sent_at so eram preenchidos pelo webhook a partir da 0008
-- — o historico anterior nunca foi backfillado, deixando 5.987 chats (81%) com
-- waiting_on = 'none' mesmo tendo mensagens registradas. Este backfill deriva as
-- duas colunas do proprio messages, SO pra chats com ambas nulas (nao mexe em
-- chat vivo). waiting_on (coluna gerada, 0041) recalcula sozinho.
-- Idempotente. Aplicado em prod 10/07/2026: 4.763 chats corrigidos
-- (none 5987 -> 1237; me 816 -> 2786; lead 576 -> 3356).

WITH agg AS (
  SELECT instance_id, chat_id,
         max(COALESCE(message_ts, created_at)) FILTER (WHERE NOT from_me) AS recv,
         max(COALESCE(message_ts, created_at)) FILTER (WHERE from_me)     AS sent
  FROM public.messages
  GROUP BY instance_id, chat_id
)
UPDATE public.chats c
SET last_received_at = a.recv,
    last_sent_at     = a.sent
FROM agg a
WHERE a.instance_id = c.instance_id
  AND a.chat_id = c.chat_id
  AND c.last_received_at IS NULL
  AND c.last_sent_at IS NULL
  AND (a.recv IS NOT NULL OR a.sent IS NOT NULL);
