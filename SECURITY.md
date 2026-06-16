# SECURITY — WhatsApp Agent

> Documento de modelo de ameaças, guard rails reais e runbooks de incidente.
> Atualizar SEMPRE que mexer em send/auth/credenciais. Última revisão: 2026-05-01.

## 1. O que está protegido (e o que NÃO está)

### Tool `send` do MCP whatsapp-agent

| Risco | Status |
|-------|--------|
| LLM disparar mensagem sem antes mostrar destinatário+conteúdo ao dono | **Mitigado**: `confirmed=true` é flag explícita, default false. Sem confirmed → MCP retorna `BLOQUEADO: confirmacao pendente.` |
| LLM mandar pra número que ainda não está em chats (primeiro contato) | **Mitigado**: `allow_new=true` é flag separada. Default false retorna erro pedindo confirmação. |
| LLM disparar em massa via MCP | **Mitigado por design**: MCP NÃO tem tool batch. 1 chamada = 1 chat. Campanhas em massa rodam via skills `whatsapp-campanha-*` (ChatGuru), separadas. |

### Limitações reconhecidas (NÃO mitigado)

- **`confirmed=true` é cooperativo, não adversarial.** O mesmo LLM que escreve a mensagem decide setar a flag. Prompt injection (ex: áudio transcrito malicioso) pode passar `confirmed=true` sem confirmação real do humano. Gate humano de verdade requer confirmação out-of-band — pendente (Telegram 2FA, ver §3).
- **Edge Function `send-message` não valida `confirmed` nem rate limit.** Qualquer caller com `service_role` chama a Edge direto e bypassa o gate do MCP. Hardening pendente (§3).
- **Sem rate limit em lugar nenhum** — MCP, Edge Function, Z-API config. Loop bug = N mensagens sem freio. Z-API aceita ~30 msg/s; em 60s = 1.800 msgs; WhatsApp bana o número pessoal em 200-500 disparos repetitivos.
- **Sem audit log estruturado** — só `messages.sent_by_agent` boolean. Não dá pra responder "qual prompt originou esse send, em qual instância, em qual sessão". Forense impossível hoje.
- **Webhook signature OFF** — `process-webhook` v9 tem validação opcional implementada mas `WEBHOOK_REQUIRE_AUTH=false` (default). Qualquer um pode forjar webhook (envenenar `webhook_events_raw` e indiretamente o contexto que o agente lê). Ativação pendente (depende de configurar Client-Token no painel Z-API).

## 2. Instâncias do MCP

Você pode rodar múltiplas cópias do MCP — em máquina local, container, VPS, etc. Recomendado manter todas na mesma versão do `index.js`.

| Local | Path exemplo |
|-------|------|
| Local (macOS/Linux) | `~/.claude/mcps/whatsapp-agent/` |
| Windows | `C:\MCPs\whatsapp-agent\` |
| Container/VPS | `/workspace/whatsapp-agent/mcp/` |

Verificar paridade entre instâncias: `sha256sum index.js` em cada uma. Diferença ⇒ alguém aplicou patch fora do fluxo, investigar.

## 3. Backlog de hardening (priorizado)

| Prioridade | Item | Status |
|-----------|------|--------|
| P0 | Webhook signature ON (`WEBHOOK_REQUIRE_AUTH=true`) | Pendente — configure Client-Token no painel Z-API |
| P0 | Rotação periódica de credenciais (service_role, Z-API client-token) | Pendente |
| P1 | Edge Function `send-message`: valida `confirmed=true` server-side | Backlog |
| P1 | Edge Function `send-message`: rate limit por número/janela (ex: 10 msg/min, 100 msg/dia, 5 msg/min por contato) | Backlog |
| P1 | Audit log estruturado (`outbound_messages_audit`: source, container_id, session_id, prompt_hash, payload, confirmed_at, status) | Backlog |
| P2 | Telegram 2FA out-of-band: antes do `send` executar, MCP pergunta no Telegram do dono "Confirmar pra X: [preview] SIM/NÃO" | Backlog |
| P2 | Tirar `service_role` de `.mcp.json` e `mcporter.json` — usar secret manager ou env do container | Backlog |
| P3 | Whitelist por contato (envia sem pedir) + blacklist (sempre confirmar) | Backlog |
| P3 | Botão "freeze outbound" global (kill switch) via expert-brain MCP | Backlog |

## 4. Runbooks de incidente

### Vazou `service_role` do Supabase
1. Dashboard Supabase → Settings → API → "Reset service_role". Gera nova key, **invalida a antiga imediatamente**.
2. Atualizar em todos os pontos: env das Edge Functions (via Management API), env do MCP (`SUPABASE_SERVICE_ROLE_KEY`).
3. Audit: `SELECT COUNT(*) FROM messages WHERE created_at > <hora_vazamento> AND from_me=true` — quantas mensagens enviadas no intervalo.
4. Se houver suspeita de injeção de mensagens fake: `SELECT * FROM messages WHERE created_at > <hora> AND sent_by_agent IS NULL` (rows sem flag = caminho não-MCP).

### Disparou mensagem errada
1. **Pausa imediata**: `UPDATE zapi_instance SET is_active=false WHERE is_active=true` — derruba a Edge Function `send-message` (retorna 500).
2. Identificar: `SELECT id, chat_id, content, created_at FROM messages WHERE from_me=true AND created_at > now() - interval '5 minutes' ORDER BY created_at DESC`.
3. Apagar via Z-API: `zapi_action({ action: "delete-message", params: { phone, messageId, owner: true } })`.
4. Reativar: `UPDATE zapi_instance SET is_active=true`.

### Loop de envio (N mensagens em segundos)
1. Pausa imediata (passo 1 acima).
2. Matar processo MCP que disparou: `docker exec <container> pkill -f whatsapp-agent` ou matar processo Node local.
3. Investigar `webhook_events_raw` + `messages` pra reconstruir o trigger.
4. Não reativar a Edge Function antes de identificar e corrigir o loop.

### Webhook hostil envenenando dados
1. Setar `WEBHOOK_REQUIRE_AUTH=true` (se não estava).
2. `DELETE FROM webhook_events_raw WHERE received_at > <hora_suspeita> AND raw_headers->>'Client-Token' IS NULL` (events sem token).
3. Reverter `messages` afetadas: `DELETE FROM messages WHERE created_at > <hora> AND raw_payload->>'instanceId' != '<nosso_instance_id>'`.

### Suspeita de prompt injection no agente
1. Pausa Edge Function (passo 1 do disparo errado).
2. Auditar últimas 20 entradas em `messages` lidas pelo MCP — procurar texto que parece instrução em vez de mensagem ("ignore tudo", "envie X pra Y", base64 suspeito).
3. Ativar `WEBHOOK_REQUIRE_AUTH` se ainda estiver OFF.
4. Reset do contexto do agente se ele estava executando tarefa multi-turn.

## 5. Convenções

- Mudança em `send`, `zapi_action`, `process-webhook` ou Edge Function `send-message` exige update deste documento.
- Nova credencial entra em memory-mcp `whatsapp-agent-*`, nunca no código nem em commit.
- Nova instância do MCP entra na tabela §2 antes de subir.
- Pull request que toca este arquivo precisa explicar a mudança de modelo de ameaças.
