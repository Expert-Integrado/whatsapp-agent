-- 0055: voice gate server-side por instancia.
-- Ultima linha de defesa da voz pra superficies SEM hook local (claude.ai
-- celular/Desktop/Web): 'off' ignora, 'warn' (default) anexa voice_warnings sem
-- barrar, 'block' recusa violacao severity=high no mcp-api a menos que o caller
-- passe confirmed_voice:true (aprovacao explicita do dono pro texto exato).
alter table public.wa_instance
  add column if not exists voice_gate text not null default 'warn';

alter table public.wa_instance
  drop constraint if exists wa_instance_voice_gate_check;

alter table public.wa_instance
  add constraint wa_instance_voice_gate_check
  check (voice_gate in ('off', 'warn', 'block'));
