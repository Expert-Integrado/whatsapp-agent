-- 0052_instance_humanize_toggle.sql
-- Humanizacao oral como ESCOLHA da instalacao (feedback do dono, 12/07/2026).
-- O cliente do produto nao tem interface: o onboarding (skill setup) pergunta
-- se ele quer a oralizacao paulista nos audios TTS e grava aqui. Desligado
-- (false) forca texto literal no send-voice, SOBREPONDO o nivel do perfil
-- (voice_profiles.humanize) — o perfil guarda o nivel, a instancia decide se roda.
-- Default true preserva o comportamento das instalacoes existentes.

ALTER TABLE public.wa_instance
  ADD COLUMN IF NOT EXISTS humanize_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.wa_instance.humanize_enabled IS
  'Escolha da instalacao (onboarding): false desliga a humanizacao oral do send-voice nesta instancia, sobrepondo voice_profiles.humanize';
