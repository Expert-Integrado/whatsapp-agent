# Backlog

1. **Reparar `chats.last_*` em 3 chats (instalação do Asafe)** — sobra do backfill da janela de 11/07 (00:45–10:35 BRT, 209 webhooks sintéticos reinjetados); o UPDATE de reparo ficou bloqueado pro agente, aplicar manualmente.
2. **Bug: `group-participants.update` falha 100%** — `TypeError: (jid ?? "").split is not a function` no process-webhook há 7+ dias; nenhum evento de entrada/saída de participante de grupo está sendo processado. Fix no código mergeado na PR #12 — falta confirmar o redeploy do `process-webhook` na instalação do Asafe e então remover este item.
3. **Comunidades Z-API fora do escopo das tools de grupo** — a suite `/communities*` da Z-API (criar, linkar/deslinkar grupos, settings) não tem paridade na Evolution e ficou de fora das tools `group_*` (decisão consciente, 14/07/2026). Acessível via `zapi_action` se precisar; promover a tool própria só se surgir demanda real.
