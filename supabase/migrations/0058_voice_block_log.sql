-- 0058: modelo FIXO do voice gate — fim do fluxo de aprovacao (reverte a 0057).
-- Decisao do dono (19/07/2026): nao existe aprovacao de mensagem nem PIN. O
-- contrato do modo block e o agente CORRIGIR o texto e reenviar ate passar
-- (unica excecao auditada: confirmed_voice, 0056). Novo: todo bloqueio do gate
-- vira linha em voice_block_log; quando o agente PATINA (3+ bloqueios no mesmo
-- chat em 15min) e o dono usa o Expert Brain (secret EXPERT_BRAIN_PAT), nasce
-- UMA task de correcao/calibracao do voice guide — insumo de melhoria, nunca
-- botao de liberar envio.

drop table if exists public.voice_pending_approval;
drop table if exists public.voice_approval_pin;

-- Nenhuma instancia pode ficar num modo que deixou de existir.
update public.wa_instance set voice_gate = 'block' where voice_gate = 'approval';

alter table public.wa_instance
  drop constraint if exists wa_instance_voice_gate_check;

alter table public.wa_instance
  add constraint wa_instance_voice_gate_check
  check (voice_gate in ('off', 'warn', 'block'));

create table if not exists public.voice_block_log (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  instance_id text,
  chat_ref text,
  tool text not null,
  rule_ids text[] not null,
  text_preview text
);

comment on table public.voice_block_log is
  'Cada recusa do voice gate (modo block, severity high). Alimenta a task de correcao do voice guide no Brain quando o mesmo chat acumula bloqueios na janela.';

create index if not exists voice_block_log_chat_recent_idx
  on public.voice_block_log (chat_ref, created_at desc);

alter table public.voice_block_log enable row level security;
