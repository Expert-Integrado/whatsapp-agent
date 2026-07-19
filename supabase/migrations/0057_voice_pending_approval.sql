-- 0057: aprovacao out-of-band do voice gate.
-- Novo modo wa_instance.voice_gate = 'approval': violacao severity=high RETEM o
-- envio (linha aqui + card PRIVADO no Brain com links Aprovar/Recusar) em vez de
-- aceitar confirmed_voice — a flag cooperativa (setada pelo mesmo agente que
-- redige) e o gap estrutural que este modo fecha (conselho 18/07/2026). O clique
-- do dono bate no endpoint publico do mcp-api com token secreto; o banco guarda
-- so o SHA-256 do token.
create table if not exists public.voice_pending_approval (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'expired', 'failed')),
  instance_id text,
  chat_id text,
  chat_name text,
  tool text not null,
  payload jsonb not null,
  violations jsonb not null,
  token_hash text not null,
  brain_task_id text,
  resolved_at timestamptz,
  sent_result jsonb,
  error text
);

comment on table public.voice_pending_approval is
  'Envios retidos pelo voice gate em modo approval, aguardando o clique do dono (link no card privado do Brain). payload = replay autossuficiente (callEdge/scheduled_sequences).';

create index if not exists voice_pending_approval_status_idx
  on public.voice_pending_approval (status, created_at desc);

alter table public.voice_pending_approval enable row level security;

-- PIN de aprovacao (fator que o agente NAO tem): definido pelo dono no primeiro
-- uso (TOFU), guardado como SHA-256. Sem PIN correto, o clique nao aprova nem
-- recusa nada — mesmo que o link do card vaze pra um agente. Linha unica.
create table if not exists public.voice_approval_pin (
  id int primary key check (id = 1),
  pin_hash text not null,
  updated_at timestamptz not null default now()
);

alter table public.voice_approval_pin enable row level security;

-- Contador de tentativas erradas de PIN por retencao (trava apos 5).
alter table public.voice_pending_approval
  add column if not exists pin_attempts int not null default 0;

-- wa_instance.voice_gate ganha o 4o modo.
alter table public.wa_instance
  drop constraint if exists wa_instance_voice_gate_check;

alter table public.wa_instance
  add constraint wa_instance_voice_gate_check
  check (voice_gate in ('off', 'warn', 'block', 'approval'));
