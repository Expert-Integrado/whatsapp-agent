-- Migration 0014 — Trigger pra transcrever audio assim que o download termina
--
-- Contexto:
--   Antes desta migration, transcricao rodava SO via cron a cada 2min
--   (`transcribe-audio-queue`). Latencia: 0-2min apos download terminar.
--   Pra reduzir pra ~3-5s, este trigger dispara o `transcribe-queue` Edge
--   Function imediatamente quando `message_media.download_status` muda pra
--   'done'.
--
-- Idempotente:
--   - `runSingle` na Edge Function checa `content IS NULL OR ''` antes de
--     transcrever. Se cron e trigger rodarem na mesma janela, o segundo skipa.
--
-- Filtro:
--   - So dispara pra mensagens ptt/audio em chat privado (mesmo escopo do
--     batch atual). Grupos ficam de fora pra evitar gasto Whisper desnecessario.

CREATE OR REPLACE FUNCTION public.trigger_transcribe_on_media_done()
RETURNS TRIGGER AS $$
DECLARE
  msg_type    TEXT;
  msg_content TEXT;
  is_private  BOOLEAN;
BEGIN
  -- So dispara em transicao PRA 'done' (evita re-disparo em outras updates)
  IF NEW.download_status = 'done' AND (OLD.download_status IS DISTINCT FROM 'done') THEN
    SELECT m.message_type, m.content, NOT c.is_group
      INTO msg_type, msg_content, is_private
    FROM public.messages m
    JOIN public.chats c ON c.chat_id = m.chat_id
    WHERE m.id = NEW.message_id;

    IF msg_type IN ('ptt', 'audio')
       AND (msg_content IS NULL OR msg_content = '')
       AND is_private THEN
      PERFORM public.call_edge_function('/functions/v1/transcribe-queue?id=' || NEW.message_id::text);
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_transcribe_on_media_done ON public.message_media;

CREATE TRIGGER trg_transcribe_on_media_done
  AFTER UPDATE OF download_status ON public.message_media
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_transcribe_on_media_done();

COMMENT ON FUNCTION public.trigger_transcribe_on_media_done IS
  'Dispara transcribe-queue?id=<msg_uuid> quando download de audio (ptt/audio em chat privado) termina. Cron continua rodando como fallback.';
