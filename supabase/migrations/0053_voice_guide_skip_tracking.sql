-- 0053: registro do pulo consciente do voice guide no onboarding.
-- Distingue "decidiu pular" (timestamp preenchido) de "nunca foi ofertado" (NULL),
-- pra sessoes futuras nao reofertarem o guide como se fosse novidade.

ALTER TABLE public.wa_instance
  ADD COLUMN IF NOT EXISTS voice_guide_skipped_at timestamptz;

COMMENT ON COLUMN public.wa_instance.voice_guide_skipped_at IS
  'Momento em que o dono decidiu conscientemente pular a criacao do voice guide no onboarding. NULL = nunca ofertado ou guide instalado.';
