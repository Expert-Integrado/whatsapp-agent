# Troubleshooting (diagnóstico operacional)

Problemas comuns em produção: **sintoma → causa provável → como verificar → como resolver**. Complementa os runbooks de incidente do [SECURITY.md](../../SECURITY.md) (vazamento de chave, loop de envio, webhook hostil) — aqui o foco é o funcional do dia a dia.

> As queries SQL rodam com a `service_role` (Supabase Studio → SQL Editor, ou `psql`). Os exemplos usam nomes de tabela atuais (pós-0040).

---

## 1. Mensagem chegou no WhatsApp mas não aparece no banco

**Causas prováveis:** webhook não configurado/instável, falha de autenticação (`401`), ou erro no processamento.

**Verificar:**
```sql
-- O webhook está chegando? (eventos recentes)
SELECT id, event_type, processed, was_waiting, error, received_at
FROM webhook_events_raw ORDER BY received_at DESC LIMIT 20;
```
- **Nenhuma linha recente** → o provedor não está entregando: confira a URL do webhook no painel (Z-API) ou na config (Evolution) e a coluna `wa_instance.webhook_url`.
- **`error` preenchido** → falha no `dispatch`; o payload bruto está em `webhook_events_raw.payload` para replay/análise.
- **`was_waiting = true` sem follow-up** → WhatsApp Multi-Device não decriptou (E2E). Veja a view:
```sql
SELECT status, count(*) FROM v_waiting_messages_status GROUP BY status;
```
`lost` (>24h) significa que o conteúdo nunca chegou — não é bug do agente.
- **`401` nos logs** do `process-webhook` → o `z-api-token` recebido não bate com `wa_instance.webhook_token`. Se for instância nova, o TOFU aprende na 1ª requisição; se o token mudou, limpe-o para reaprender:
```sql
UPDATE wa_instance SET webhook_token = NULL WHERE instance_id = '<id>';
```

**Logs:** `supabase functions logs process-webhook`.

---

## 2. Áudios não estão sendo transcritos

**Causas prováveis:** `OPENAI_API_KEY` ausente, cron parado, ou mídia não baixada.

**Verificar:**
```sql
-- Áudios pendentes de transcrição
SELECT m.id, m.message_type, mm.download_status
FROM messages m JOIN message_media mm ON mm.message_id = m.id
WHERE m.message_type IN ('ptt','audio') AND (m.content IS NULL OR m.content = '')
ORDER BY m.created_at DESC LIMIT 20;

-- Os cron jobs estão agendados e rodando?
SELECT jobid, jobname, schedule, active FROM cron.job;
SELECT jobname, status, return_message, start_time
FROM cron.job_run_details ORDER BY start_time DESC LIMIT 20;
```
**Resolver:**
- `download_status='pending'` há muito tempo → a mídia não baixou; ver problema #4.
- Cron `transcribe-audio-queue` inativo/sem execuções → confira `OPENAI_API_KEY` (`supabase secrets list`) e o Vault (problema #6).
- Lembre: o cron transcreve **áudio privado**; grupos/antigos precisam da tool `transcribe_audio` (forçada). Logs: `supabase functions logs transcribe-queue`.

---

## 3. Chats duplicados (um "fantasma" por contato)

**Causa provável:** mensagens enviadas de dispositivo linkado chegam com `chat_id = "<lid>@lid"` e, sem resolução, viram um chat separado.

**Verificar:**
```sql
SELECT chat_id, chat_name FROM chats WHERE chat_id LIKE '%@lid%';
SELECT * FROM lid_mapping ORDER BY resolved_at DESC LIMIT 20;
```
**Resolver:** o `process-webhook` resolve `@lid`→telefone (Z-API, via `resolveChatIds`) e popula `lid_mapping`. Para pares históricos órfãos, mapeie manualmente (`resolved_via='manual'`). É um comportamento conhecido do Z-API Multi-Device (ver [migration 0016](../../supabase/migrations/0016_lid_mapping.sql)).

---

## 4. Mídia fica `pending` / imagens não carregam

**Causa provável:** o download dos bytes falhou (CDN do provedor instável, timeout).

**Verificar:**
```sql
SELECT download_status, count(*), max(download_error)
FROM message_media GROUP BY download_status;
```
**Resolver:** o cron `retry-pending-media` (a cada 15 min) re-tenta automaticamente. `download_error` mostra a causa. Para forçar agora, chame `retry-media`. Áudio com mais de 30 dias pode ter sido removido pelo `cleanup-media` — isso é esperado.

---

## 5. MCP retorna 401/403, ou o envio é bloqueado

**Causas e como agir:**

| Resposta | Causa | Resolver |
|---|---|---|
| `401` no MCP (Claude Code) | `x-mcp-key` ≠ `MCP_API_KEY` | Confira o header/secret. Lembre: rotacionar `MCP_API_KEY` invalida todos os tokens |
| OAuth falha (Desktop/Web) | `OAUTH_CLIENT_ID`/`SECRET` errados ou não configurados | `supabase secrets list`; reconfigure o connector |
| `send` "bloqueado" | Fluxo de confirmação | É esperado: refaça a chamada com `confirmed:true` |
| `403` mesmo confirmando | `REQUIRE_CONFIRMED` server-side | O body precisa de `confirmed:true` chegando ao `send-message`/`wa-proxy` |
| Erro de "número novo" | `allow_new` não setado | Primeiro contato exige `allow_new:true` + `instance` |

**Auditoria:** toda ação destrutiva fica em `wa_action_log`:
```sql
SELECT action, category, result_status, error, called_at
FROM wa_action_log ORDER BY called_at DESC LIMIT 20;
```

---

## 6. Cron jobs não disparam as Edge Functions

**Causa provável:** o Vault não está populado, então `call_edge_function` não consegue montar a chamada.

**Verificar:**
```sql
SELECT name FROM vault.decrypted_secrets WHERE name IN ('project_url','service_role_key');
```
Se faltar algum, a função apenas emite `NOTICE` e retorna NULL (não quebra, mas nada acontece). **Resolver:** popular os dois secrets do Vault (a skill `/setup` faz isso via `vault.create_secret`). Veja também `cron.job_run_details` (problema #2) para confirmar que os jobs estão `active`.

---

## 7. Envio falhou / rate-limit atingido

**Verificar:** o retorno do `send-message` traz `reason` (`rate_limit_per_chat_per_min` / `_global_per_min` / `_global_per_day`).

**Resolver:** os limites são por instância e ajustáveis por env var **sem redeploy** — `RATE_LIMIT_PER_CHAT_PER_MIN` (5), `RATE_LIMIT_GLOBAL_PER_MIN` (30), `RATE_LIMIT_GLOBAL_PER_DAY` (200). Se o limite estourou inesperadamente, investigue um possível loop de envio (runbook em [SECURITY.md](../../SECURITY.md)).

---

## Verificação rápida de saúde

```sql
-- Webhooks fluindo na última hora
SELECT count(*) FILTER (WHERE received_at > now() - interval '1 hour') AS ult_hora,
       count(*) FILTER (WHERE error IS NOT NULL)                        AS com_erro
FROM webhook_events_raw WHERE received_at > now() - interval '1 day';

-- Crons ativos e últimas execuções
SELECT jobname, active FROM cron.job;

-- Instâncias conectadas
SELECT alias, provider, is_active, last_connected_at FROM wa_instance;
```

**Logs de qualquer function:** `supabase functions logs <nome>` (ex.: `process-webhook`, `send-message`, `mcp-api`).
