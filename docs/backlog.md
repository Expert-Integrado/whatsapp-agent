# Backlog

1. **Reparar `chats.last_*` em 3 chats (instalação do Asafe)** — sobra do backfill da janela de 11/07 (00:45–10:35 BRT, 209 webhooks sintéticos reinjetados); o UPDATE de reparo ficou bloqueado pro agente, aplicar manualmente.
2. **Bug: `group-participants.update` falha 100%** — `TypeError: (jid ?? "").split is not a function` no process-webhook há 7+ dias; nenhum evento de entrada/saída de participante de grupo está sendo processado. Fix no código mergeado na PR #12 — falta confirmar o redeploy do `process-webhook` na instalação do Asafe e então remover este item.
