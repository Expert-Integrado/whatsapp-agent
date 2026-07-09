# Documentação de referência

Referência técnica interna do WhatsApp Agent — a fonte de verdade para entender o que cada parte faz **antes de alterar qualquer coisa**. Para instalar/operar, veja o [README principal](../../README.md); para versões e upgrades, [CHANGELOG](../../CHANGELOG.md) e [MIGRATION](../../MIGRATION.md); para o modelo de ameaças, [SECURITY](../../SECURITY.md).

## Documentos

| Documento | Leia quando precisar entender… |
|---|---|
| [SCHEMA.md](SCHEMA.md) | O banco: tabelas, colunas, views, functions, triggers, cron jobs, RLS, Storage e a linha do tempo das migrations |
| [ARQUITETURA.md](ARQUITETURA.md) | As Edge Functions, o fluxo de uma mensagem (entrada e saída), o padrão de provider (Z-API × Evolution) e os secrets |
| [MCP.md](MCP.md) | O servidor MCP (`mcp-api`): como autentica e o catálogo das ~20 tools que o Claude usa |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Diagnóstico operacional: sintoma → causa → como verificar → resolver |

## Onde as mensagens caem (atalho)

Uma mensagem recebida entra pela Edge Function [`process-webhook`](../../supabase/functions/process-webhook/index.ts) e é gravada em:

- **`messages`** — texto, tipo, metadados e `raw_payload` ([detalhes no SCHEMA](SCHEMA.md#messages--todas-as-mensagens-o-centro-do-sistema-)).
- **`message_media`** + **Storage** — arquivos (áudio/imagem/vídeo/documento).
- **`webhook_events_raw`** — log bruto de todo webhook (auditoria/replay).

O caminho completo, passo a passo, está em [ARQUITETURA.md → fluxo inbound](ARQUITETURA.md#onde-as-mensagens-caem-fluxo-inbound).

---

> Estes documentos descrevem o **estado atual** (pós-migration 0040) e foram verificados contra o código. Ao alterar schema, functions ou tools, atualize o documento correspondente na mesma mudança.
