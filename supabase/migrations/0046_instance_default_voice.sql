-- 0046_instance_default_voice.sql
-- Voz TTS default por instancia: send-voice deixava de funcionar sem voice_id
-- explicito (o agente tinha que adivinhar — e ja mandou audio com a voz errada
-- por escolher o id mais recente do log). Precedencia no send-voice:
-- voice_id do request > wa_instance.default_voice_id > env DEFAULT_VOICE_ID.
-- O VALOR e dado da instalacao (nao vai em migration) — setar via UPDATE apos aplicar.

ALTER TABLE public.wa_instance
  ADD COLUMN IF NOT EXISTS default_voice_id text;

COMMENT ON COLUMN public.wa_instance.default_voice_id IS
  'ElevenLabs voice ID usado pelo send-voice quando o request nao especifica voice_id';
