-- 0056: trilha de auditoria SILENCIOSA dos bypasses do voice gate.
-- Registra cada envio que so passou porque o caller trouxe confirmed_voice:true
-- num gate em modo block com violacao severity=high. Nenhuma notificacao — o dono
-- consulta a tabela so se um dia precisar investigar (decisao do dono, 18/07/2026,
-- apos veredito do conselho sobre a flag cooperativa).
create table if not exists public.voice_bypass_log (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  instance_id text,
  tool text not null,
  rule_ids text[] not null,
  text_preview text
);

comment on table public.voice_bypass_log is
  'Bypasses do voice gate (confirmed_voice em modo block com violacao high). Log silencioso, so escrita pelo mcp-api (service_role).';

create index if not exists voice_bypass_log_created_idx on public.voice_bypass_log (created_at desc);

-- Mesmo padrao das demais tabelas operacionais (0048): RLS ligada, zero policy —
-- so service_role (mcp-api) le/escreve.
alter table public.voice_bypass_log enable row level security;
