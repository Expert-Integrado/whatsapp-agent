-- 0051_voice_profiles.sql
-- Perfis de voz TTS como CONFIG no banco (absorve a skill pessoal:voz, 12/07/2026).
-- send-voice ganha param `profile`: resolve o perfil aqui e TRAVA voice_id/model/
-- settings server-side (agente nao consegue inventar settings — enforcement mais
-- forte que a skill, que confiava no agente copiar os valores). A humanizacao
-- (nivel por perfil) roda na edge antes do TTS (_shared/humanize.ts).
-- Os VALORES (voice_ids do dono da instalacao) sao dado da instalacao — seed via
-- INSERT apos aplicar, NAO nesta migration (mesmo padrao da 0046 default_voice_id).

CREATE TABLE IF NOT EXISTS public.voice_profiles (
  profile           text PRIMARY KEY CHECK (profile ~ '^[a-z0-9-]{1,64}$'),
  voice_id          text,                    -- NULL = a preencher (perfil inutilizavel ate preencher)
  model_id          text NOT NULL DEFAULT 'eleven_turbo_v2_5',
  stability         numeric,                 -- NULL = default da edge (0.45)
  similarity_boost  numeric,                 -- NULL = default da edge (0.75)
  style             numeric,                 -- NULL = default da edge (0.30)
  speed             numeric,                 -- NULL = default da edge (0.95)
  humanize          text NOT NULL DEFAULT 'nenhum' CHECK (humanize IN ('forte', 'leve', 'nenhum')),
  is_active         boolean NOT NULL DEFAULT true,
  blocked_reason    text,                    -- por que o perfil esta bloqueado (is_active=false)
  aliases           text[] NOT NULL DEFAULT '{}',
  description       text,                    -- quando usar (vai pro agente via erro/hint)
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.voice_profiles IS
  'Catalogo de perfis de voz TTS (ElevenLabs) da instalacao. send-voice resolve `profile` aqui e trava voice_id/model/settings server-side; humanize = nivel de oralizacao aplicado ao texto antes do TTS.';
COMMENT ON COLUMN public.voice_profiles.voice_id IS
  'ElevenLabs voice ID. NULL = a preencher: o perfil existe no catalogo mas e recusado (403) ate ser configurado.';

ALTER TABLE public.voice_profiles ENABLE ROW LEVEL SECURITY;
