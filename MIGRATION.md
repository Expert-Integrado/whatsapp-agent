# Guia de migração

## Upgrade para v3.0 (multi-provider)

A **v3.0** introduz suporte a múltiplos provedores de WhatsApp — Z-API e Evolution API — selecionável por instância. Internamente, a tabela `zapi_instance` foi renomeada para `wa_instance` e `zapi_action_log` para `wa_action_log`; a Edge Function `zapi-proxy` virou `wa-proxy`. **Quem usa Z-API não precisa reconfigurar nada** — o upgrade é automático.

### O que muda

| | v2.x | v3.0 |
|---|---|---|
| Tabela de instâncias | `zapi_instance` | `wa_instance` (coluna `provider` = `'zapi'` ou `'evolution'`) |
| Tabela de logs | `zapi_action_log` | `wa_action_log` |
| Coluna de credencial | `token` | `auth_token` |
| Edge Function de proxy | `zapi-proxy` | `wa-proxy` |
| Provedores suportados | Z-API | Z-API + Evolution API (opt-in por instância) |

### Nota — Comportamento de webhooks

Com `WEBHOOK_REQUIRE_AUTH=true` (recomendado), webhooks de instâncias não registradas são rejeitados com 401. Com a auth desabilitada, um webhook de instância desconhecida agora retorna 500 (o evento bruto ainda é gravado em `webhook_events_raw`) — diferente do comportamento legado que persistia sob uma instância `'unknown'`. Registre toda instância em `wa_instance` antes de apontar o webhook.

### Passo a passo

1. **Atualize o repositório:**
   ```bash
   git pull
   ```

2. **Aplique a migration `0031_provider_neutralization`:**
   ```bash
   supabase db push
   ```
   O que acontece: as tabelas são **renomeadas** (não dropadas — nenhum dado é perdido); a coluna `token` passa a se chamar `auth_token`; as colunas `provider` e `base_url` são adicionadas; todas as linhas existentes recebem `provider = 'zapi'` automaticamente. Views de compatibilidade `zapi_instance` e `zapi_action_log` são criadas para cobrir a janela de upgrade.

3. **Faça o deploy das Edge Functions:**
   ```bash
   supabase functions deploy
   ```
   Isso inclui a nova `wa-proxy` (substituta da `zapi-proxy`), além das funções atualizadas (`send-message`, `process-webhook`, `wa-proxy`, `mcp-api`, etc.).

4. **(Opcional) Remova a função antiga:**
   ```bash
   supabase functions delete zapi-proxy
   ```
   Não é obrigatório — a `zapi-proxy` ficará inativa de qualquer forma após o deploy, mas removê-la evita confusão.

### Verificação

Confirme que as instâncias existentes foram preservadas com o provedor correto:

```sql
SELECT provider, count(*) FROM wa_instance GROUP BY provider;
-- Resultado esperado: uma linha com provider = 'zapi' e o número de instâncias que você tinha
```

Faça um smoke test via MCP: peça ao Claude para usar a tool `status` — ela deve retornar o estado da instância Z-API sem nenhuma reconfiguração.

### Garantias

- **Dados preservados:** a migration usa `ALTER TABLE … RENAME`, nunca `DROP`. Nenhuma mensagem, chat ou log é apagado.
- **Z-API continua funcionando:** instâncias existentes recebem `provider = 'zapi'` automaticamente; nenhuma credencial precisa ser reinserida.
- **Evolution API é opt-in:** para adicionar uma instância Evolution, basta criar uma nova linha em `wa_instance` com `provider = 'evolution'` e o `base_url` do seu servidor Evolution.
- **Views de compatibilidade:** `zapi_instance` e `zapi_action_log` são shims de depreciação — cobrem integrações externas que ainda referenciem os nomes antigos durante o upgrade. Serão removidas numa versão futura.

---

## Upgrade de v1 → v2

A **v2** troca o MCP **local (stdio)** por um **MCP remoto sobre HTTP** nas Edge Functions do Supabase, e dissolve as skills operacionais em **tools**. Quem rodava a v1 remove o cliente local, (re)provisiona o Supabase e reconecta o MCP no harness. **Nenhum dado de mensagem é perdido** — o banco é o mesmo.

## O que muda

| | v1 (stdio) | v2 (HTTP) |
|---|---|---|
| Transporte do MCP | stdio — cliente Node local (`mcp/`) | HTTP remoto (`mcp-api` Edge Function) |
| Onde roda | máquina do usuário | Supabase (sem processo local) |
| Auth | local (sem token) | `x-mcp-key` (Code) **ou** OAuth 2.1 (Desktop/Web) |
| `estou-devendo` | skill + script Python | tool `inbox(waiting_on:"me", min_idle_days:N)` |
| `transcrever-conversa` | skill + script Python | tool `read` (já transcreve os áudios) |
| Distribuição | plugin do Claude Code | sem plugin — tools universais (qualquer cliente MCP) |
| Setup | manual | skill `/setup` (Supabase CLI) |

## Passo a passo

1. **Atualize o repositório** para a v2 (`git pull`).

2. **Remova o que era da v1:**
   - Desinstale o plugin antigo no Claude Code: `/plugin uninstall whatsapp-agent` (e remova o marketplace, se adicionou).
   - Apague do seu `.mcp.json`/config qualquer servidor MCP `whatsapp-agent` do tipo **stdio** (apontava pra `mcp/index.js`).

3. **Provisione o Supabase (v2)** — rode a skill **`/setup`** (ou siga [`.claude/skills/setup/SKILL.md`](.claude/skills/setup/SKILL.md)). Ela:
   - aplica as migrations novas (`supabase db push`) — inclui `0030_voice_guide`, `pg_cron`/`pg_net` e o helper de Vault;
   - deploya as Edge Functions (`mcp-api`, `process-webhook`, cron internas…);
   - configura os secrets: `MCP_API_KEY`, `OAUTH_CLIENT_ID`/`OAUTH_CLIENT_SECRET`, `ZAPI_*`, `OPENAI_API_KEY`;
   - popula o **Vault** (`project_url`, `service_role_key`) pros cron jobs;
   - aponta o webhook da Z-API pro `process-webhook`.

4. **Reconecte o MCP no seu harness:**
   - **Claude Code** (header): `claude mcp add --transport http whatsapp-agent https://<ref>.supabase.co/functions/v1/mcp-api --header "x-mcp-key: <MCP_API_KEY>"`
   - **Claude Desktop (chat) / Web**: Settings → Connectors → *Add custom connector* → cole a URL → *Advanced settings* → Client ID + Secret (do passo 3).

5. **Atualize seus fluxos** — onde você invocava as skills, agora é linguagem natural sobre as tools:
   - *"do que tô devendo?"* → `inbox(waiting_on:"me", min_idle_days:1)`
   - *"transcreve / resume a conversa com X"* → `read(chat:"X")`

## Banco de dados

As migrations da v2 são **aditivas e clean-apply** — `supabase db push` num banco da v1 não dropa nenhuma tabela de mensagens. Novidades: voice guide (`0030`), extensões `pg_cron`/`pg_net` e o helper `call_edge_function` (lê secrets do Vault em runtime).

## Coexistência e rollback

v1 (stdio) e v2 (HTTP) podem apontar para o **mesmo banco** durante a transição. Para voltar à v1, reconecte o cliente stdio antigo — mas o caminho mantido é a v2. Depois de validar a v2, descarte o cliente local e o plugin de vez.
