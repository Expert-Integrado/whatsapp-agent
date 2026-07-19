# SECURITY — WhatsApp Agent

> Documento de modelo de ameaças, guard rails reais e runbooks de incidente.
> Atualizar SEMPRE que mexer em send/auth/credenciais. Última revisão: 2026-07-19 (redação de secrets em erros: `redact.ts`).

## 1. Arquitetura de segurança (v3)

Não existe mais processo MCP local: o runtime inteiro são **Edge Functions no Supabase**. O cliente (Claude Code, Desktop, Web, celular) fala com a `mcp-api` por HTTP.

| Camada | Proteção |
|-------|--------|
| Autenticação da `mcp-api` | Header `x-mcp-key` comparado em **tempo constante** com o secret `MCP_API_KEY`, ou **OAuth** (Claude Desktop/Web). Sem key válida → 401. |
| Edges internas (`send-message`, `send-voice`, `wa-proxy`) | `verify_jwt: true` — só aceitam chamada com JWT do projeto (a `mcp-api` chama com o JWT interno). |
| Webhook (`process-webhook`) | Autenticação **TOFU por instância** (`wa_instance.webhook_token`, migration 0029) + `WEBHOOK_REQUIRE_AUTH=true` recomendado: webhook de instância não registrada é rejeitado com 401. |
| Confirmação de envio | Toda tool destrutiva (`send`, `send_voice`, `send_image`, `schedule`, `edit_message`, `delete_message`, `zapi_action` de envio) exige `confirmed:true` numa **segunda** chamada — a primeira devolve o preview e bloqueia. |
| **Voice gate** (0055/0058) | `wa_instance.voice_gate` = `off` \| `warn` (default) \| `block`. Em `block`, envio com violação `severity: high` do voice guide é **recusado server-side**; o contrato é o agente **corrigir o texto e reenviar até passar**. Única exceção: `confirmed_voice:true` (dono aprovou o texto exato no chat). Cobre as 5 tools de envio **e** as actions de envio do `zapi_action` (texto, poll, forward, edição e mídia com caption). |
| Anti-atropelo | Gate de *inbound recente*: se o contato mandou mensagem há <10 min e não foi respondida, o `send` bloqueia (`force_send_after_inbound` destrava conscientemente). |
| Auditoria | `wa_action_log` (toda action do `wa-proxy`, com `agent_name` + `agent_request_id`), `messages.sent_by_agent`/`agent_name`, `voice_bypass_log` (0056: todo envio liberado por `confirmed_voice` em gate `block`) e `voice_block_log` (0058: toda recusa do gate; 3+ no mesmo chat em 15 min + Expert Brain conectado = task de calibração do voice guide no board do dono). |
| Massa | O MCP **não tem tool batch** por design: 1 chamada = 1 chat. |
| **Redação de secrets em erros** (19/07/2026) | A Z-API exige o `auth_token` no **path** da URL; o TypeError de rede do Deno embute a URL completa na mensagem. `redactSecrets()`/`safeFetch()` (`_shared/wa/redact.ts`) sanitizam na fonte (todo fetch de URL com secret re-lança redigido) e em toda fronteira que grava/retorna erro (`messages.send_error`, `wa_action_log.error`, `scheduled_sequences.error`, `message_media.download_error`, respostas HTTP). Cobre também query params de signed URL (`Authorization=`, `token=`) e userinfo em `base_url`. Mesma classe do incidente do Instagram Agent (fix `dcdf6d9` lá); scan retroativo de 19/07 nas 5 colunas de erro: **0 vazamentos**. |

## 2. Limitações reconhecidas (NÃO mitigado)

- **`confirmed:true` e `confirmed_voice:true` são cooperativos, não adversariais.** O mesmo LLM que redige decide setar as flags. Prompt injection (ex.: mensagem/áudio malicioso lido do próprio WhatsApp) pode setar as duas sem confirmação humana real. A confirmação out-of-band (retenção + card + PIN) foi **construída, testada e descartada** em 19/07/2026 como decisão de produto (migrations 0057→0058): humano no caminho da mensagem individual não entra no modelo. Mitigação adotada: **detecção auditada** (`voice_bypass_log` registra 100% dos usos de `confirmed_voice` em gate `block`; `voice_block_log` registra toda recusa) em vez de prevenção. Nas máquinas do dono, um hook local bloqueante (fora deste repo) reduz o risco; superfícies OAuth dependem do voice gate + confirmação cooperativa.
- **Caller com `service_role` bypassa tudo**: quem tem a key do projeto chama `send-message` direto. A key nunca sai do ambiente das functions/CI — vazou, rotacione (runbook §4).
- **Rate limit é básico** (por chat/minuto no caminho de envio) — um loop lento e distribuído entre chats ainda passa. WhatsApp bane números por volume repetitivo; monitore `messages` por picos.

## 3. Backlog de hardening (priorizado)

| Prioridade | Item | Status |
|-----------|------|--------|
| P0 | Rotação periódica de credenciais (`service_role`, `MCP_API_KEY`, tokens do provider) | Processo manual |
| ~~P1~~ | ~~Confirmação out-of-band (2FA via canal separado antes de `send` de risco)~~ | **Descartado (19/07/2026)** — construído e testado (0057), removido por decisão de produto (0058); risco residual aceito com detecção via `voice_bypass_log`/`voice_block_log` (ver §2) |
| P2 | Whitelist por contato (envia sem pedir) + blacklist (sempre confirmar) | Backlog |
| P3 | Kill switch global de outbound (freeze) por tool dedicada | Parcial: `UPDATE wa_instance SET is_active=false` já derruba o envio |

## 4. Runbooks de incidente

### Vazou `service_role` ou `MCP_API_KEY`

1. `service_role`: Dashboard Supabase → Settings → API → *Reset service_role* (invalida a antiga na hora). `MCP_API_KEY`: `supabase secrets set MCP_API_KEY=<nova>` + atualizar o cliente MCP.
2. Audit: `SELECT COUNT(*) FROM messages WHERE created_at > '<hora_vazamento>' AND from_me = true;` e `SELECT * FROM wa_action_log WHERE created_at > '<hora>' ORDER BY created_at DESC;`.

### Token do provider apareceu em coluna de erro

1. Scan: `SELECT count(*) FROM <tabela> WHERE <col_erro> ~ '/token/[A-Za-z0-9]{8,}'` nas colunas `messages.send_error`, `wa_action_log.error`, `scheduled_sequences.error`; para signed URLs de mídia, `~* '[?&](authorization|token|apikey|access_token)='` em `message_media.download_error` e `webhook_events_raw.error`. (`wa_action_log` é particionada: o SELECT no parent varre as partições vivas, ~90 dias.)
2. Mask preservando o resto da mensagem: `UPDATE <tabela> SET <col> = regexp_replace(<col>, '(/token/)[A-Za-z0-9]+', '\1REDACTED', 'g') WHERE <col> ~ '/token/[A-Za-z0-9]+';`.
3. **Rotacionar o token da instância afetada** (painel do provider + `UPDATE wa_instance`): mascarar é higiene — a mesma string já pode ter saído em resposta HTTP entregue, e partições antigas dropadas não são auditáveis.
4. Causa raiz: alguma fronteira nova gravando/retornando erro sem `redactSecrets()` — achar e corrigir (guard: todo fetch de URL com secret usa `safeFetch`).

### Disparou mensagem errada

1. **Pausa imediata**: `UPDATE wa_instance SET is_active = false WHERE is_active = true;` (o envio passa a falhar).
2. Identificar: `SELECT id, chat_id, content, agent_name, created_at FROM messages WHERE from_me = true AND created_at > now() - interval '5 minutes' ORDER BY created_at DESC;`.
3. Apagar para todos: tool `delete_message` (ou `zapi_action` `delete-message` com `owner: true`).
4. Reativar: `UPDATE wa_instance SET is_active = true;`.

### Loop de envio (N mensagens em segundos)

1. Pausa imediata (passo 1 acima). Não há processo local para matar — o disparo vem de um cliente MCP; desconecte o conector que originou (identifique por `agent_name` em `messages`/`wa_action_log`).
2. Se o loop vier de sequências agendadas: `UPDATE scheduled_sequences SET status='canceled' WHERE status='pending';`.
3. Investigar `wa_action_log` + `messages` para reconstruir o gatilho antes de reativar.

### Webhook hostil envenenando dados

1. Garantir `WEBHOOK_REQUIRE_AUTH=true` e `webhook_token` setado por instância.
2. `DELETE FROM webhook_events_raw WHERE received_at > '<hora_suspeita>' AND instance_id NOT IN (SELECT instance_id FROM wa_instance);`.
3. Reverter `messages` afetadas pelo mesmo critério de instância/período.

### Suspeita de prompt injection no agente

1. Pausa das instâncias (passo 1 do disparo errado).
2. Auditar as últimas mensagens lidas — procurar texto que parece instrução ("ignore tudo", "envie X pra Y", base64 suspeito).
3. Conferir se houve envio com `confirmed_voice:true` não aprovado pelo dono (`voice_warnings` no retorno ficam registradas no log do cliente).
4. Resetar o contexto do agente antes de reativar.

## 5. Convenções

- Mudança em tool de envio, `zapi_action`, `process-webhook`, voice gate ou qualquer edge de envio exige update deste documento.
- Credencial nunca no código nem em commit — secrets do Supabase ou env local gitignored.
- Pull request que toca este arquivo precisa explicar a mudança de modelo de ameaças.
