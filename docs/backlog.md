# Backlog

1. **Aplicar `0047_categories_alinhamento_vault` em prod (Asafe)** — commitada no repo mas os slugs `aluno`/`network`/`vip` não existem na tabela `categories` do banco. É um INSERT idempotente (ON CONFLICT DO NOTHING); aplicar via Management API/MCP conforme o cabeçalho da migration.
2. **`mcp-api` deployada (v8) diverge do repo** — a versão em prod tem a tool `schedule` (cria linhas em `scheduled_sequences`), que não existe no `supabase/functions/mcp-api/index.ts` do repo. Sincronizar o código da feature pro repo (a edge `dispatch-scheduled` e a migration já foram recuperados — ver `0049_scheduled_sequences.sql`).
3. **Reparar `chats.last_*` em 3 chats (instalação do Asafe)** — sobra do backfill da janela de 11/07 (00:45–10:35 BRT, 209 webhooks sintéticos reinjetados); o UPDATE de reparo ficou bloqueado pro agente, aplicar manualmente.
4. **Bug: `group-participants.update` falha 100%** — `TypeError: (jid ?? "").split is not a function` no process-webhook há 7+ dias; nenhum evento de entrada/saída de participante de grupo está sendo processado.
