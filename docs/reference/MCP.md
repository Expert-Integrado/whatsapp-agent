# Referência do MCP

O servidor MCP é a Edge Function [`mcp-api`](../../supabase/functions/mcp-api/index.ts) — **não** é um processo local nem um MCP externo. Ele expõe **27 tools** que o Claude (ou qualquer harness com suporte a MCP) aciona em linguagem natural. **Fonte:** [`supabase/functions/mcp-api/index.ts`](../../supabase/functions/mcp-api/index.ts).

---

## Como funciona

- **Transporte:** MCP-over-HTTP, JSON-RPC 2.0 stateless (`initialize`, `tools/list`, `tools/call`, `ping`). Protocolo `2024-11-05`, server `whatsapp-agent` v3.0.0.
- **URL:** `https://SEU_PROJECT_REF.supabase.co/functions/v1/mcp-api`.
- **Acesso interno:** a function roda com a `service_role` e chama as outras Edge Functions (`wa-proxy`, `send-message`, `send-voice`, `transcribe-queue`) e o banco diretamente. Deploy com `verify_jwt=false` (tem auth própria — ver [config.toml](../../supabase/config.toml)).

### Autenticação (dois caminhos)

| Caminho | Para quê | Como |
|---|---|---|
| **Header `x-mcp-key`** | Claude Code | Comparação timing-safe contra o secret `MCP_API_KEY` (aceita também `Authorization: Bearer <MCP_API_KEY>`) |
| **OAuth 2.1** | Claude Desktop (chat) / Web | A própria `mcp-api` é o Authorization Server: confidential client (`OAUTH_CLIENT_ID`/`OAUTH_CLIENT_SECRET`) + PKCE |

**Fluxo OAuth** (auto-aprovado, sem tela de consent):
1. Discovery: `GET /.well-known/oauth-protected-resource` e `/.well-known/oauth-authorization-server`.
2. `GET /authorize` — valida `client_id` + PKCE (`code_challenge` S256) e retorna `302` com um `code` (JWT, exp 120 s). **Sem tela** — o Supabase bloqueia HTML no domínio dele, então o consent é automático.
3. `POST /token` — exige `client_secret` (+ PKCE no `authorization_code`, ou `refresh_token`). Devolve `access_token` (JWT HS256, com TTL) e `refresh_token` (sem exp).
4. Chamadas seguintes: `Authorization: Bearer <access_token>`, verificado via `jwtVerify(bearer, MCP_API_KEY)`.

> Todos os JWTs são **HS256 assinados com a `MCP_API_KEY`** — stateless, sem tabela. **Kill switch:** rotacionar a `MCP_API_KEY` invalida todos os tokens (header e OAuth) de uma vez.

---

## Catálogo de tools

Categoria: **read** (consulta), **write** (altera metadados no banco), **destructive** (age no WhatsApp em seu nome). A coluna *confirma?* indica as tools que exigem `confirmed:true` numa segunda chamada — o Claude mostra destinatário+conteúdo e bloqueia até você confirmar.

Além da confirmação, todo envio de texto passa pelo **voice gate** da instância (`wa_instance.voice_gate`, migration 0055): em `warn` (default) violações *hard* do voice guide voltam como `voice_warnings` sem barrar; em `block` uma violação `severity: high` **recusa o envio** (`send`, `send_voice`, `send_image`, `schedule`, `edit_message` e as actions de envio do `zapi_action`); `off` desliga o gate. Em `block`, o contrato é fixo: diante da recusa, o agente **corrige o texto** (remove a violação mantendo o sentido) e reenvia até passar — não existe fluxo de aprovação de mensagem. A única exceção é `confirmed_voice:true`, usada só quando o dono aprovou explicitamente o texto exato no chat; todo envio liberado assim em gate `block` fica registrado na tabela `voice_bypass_log` (trilha silenciosa de auditoria, migration 0056 — nenhuma notificação, consulta sob demanda). Cada recusa do gate vira uma linha em `voice_block_log` (migration 0058); quando o mesmo chat acumula 3+ bloqueios em 15 minutos e a instalação tem o Expert Brain conectado (secret `EXPERT_BRAIN_PAT`), o servidor abre **uma** task de correção no board do dono (dedupe por instância+chat+dia) com as regras que estão barrando e as últimas tentativas — insumo pra calibrar o voice guide/checks, nunca um botão de liberar envio.

| Tool | Categoria | Confirma? | O que faz |
|---|---|:--:|---|
| `status` | read | — | WhatsApp conectado? Stats por instância (via `wa-proxy`) |
| `inbox` | read | — | Lista conversas com a última mensagem. `waiting_on:'me'` + `min_idle_days` = "do que estou devendo" (ordena por mais parado). Filtra por categoria/grupos |
| `read` | read | — | Lê mensagens de uma conversa em ordem cronológica e **transcreve áudios pendentes**. `chat` aceita nome/telefone/chat_id |
| `search` | read | — | Busca texto nas mensagens; filtra por chat/categoria/período |
| `list_categories` | read | — | Lista categorias válidas (use antes de `categorize_chat`) |
| `download_attachment` | read | — | URL pública de uma mídia do Storage (por `message_id`) |
| `check_delivery` | read | — | Status de entrega de uma mensagem enviada (`pending`/`sent`/`delivered`/`read`) por `message_id` |
| `get_voice_guide` | read | — | Retorna o voice guide (markdown) do dono |
| `check_message` | read | — | Verifica se um texto viola regras hard do voice guide (warning, não bloqueio) |
| `setup_voice_guide` | read | — | Status do voice guide + regras hard ativas |
| `categorize_chat` | write | — | Atribui categorias a um chat (idempotente) |
| `uncategorize_chat` | write | — | Remove categorias de um chat |
| `annotate_chat` | write | — | Salva observações/links sobre um contato |
| `resolve_chat` | write | — | Marca uma conversa como resolvida (sai do "devendo resposta") ou adia com `snooze_until`; mensagem nova reabre sozinha |
| `react` | write | — | Reage a uma mensagem com emoji (string vazia remove) |
| `transcribe_audio` | write | — | Força transcrição de áudios pendentes (até 20) → `messages.content` |
| `sync_groups` | write | — | Sincroniza nomes de grupos via provider (`dry_run` disponível) |
| `merge_ghost_chats` | write | — | Funde chats duplicados do mesmo contato (`@lid` vs telefone) preservando o histórico |
| `list_scheduled` | read | — | Lista sequências de mensagens agendadas (default: `pending`); traz id, horário BRT, progresso (`items_sent/total`) e erro |
| `cancel_scheduled` | write | — | Cancela uma sequência agendada ainda `pending` (por id) |
| `schedule` | destructive | ✅ | Agenda uma **sequência** de 1–10 mensagens (texto/mídia/voz TTS/enquete) pra envio único futuro. Confirmação na **criação**; o disparo (worker `dispatch-scheduled`, cron 1/min) roda sem novo gate |
| `send` | destructive | ✅ | Envia texto/mídia para contato/grupo |
| `send_voice` | destructive | ✅ | Gera TTS (ElevenLabs) e envia como PTT |
| `send_image` | destructive | ✅ | Envia imagem **gerada** (bytes base64): hospeda no bucket `whatsapp-images`, assina URL (1h) e envia. Imagem que já tem URL pública vai pelo `send` |
| `edit_message` | destructive | ✅ | Edita texto/legenda de uma mensagem sua — texto, imagem, video ou documento (janela ~15 min) |
| `delete_message` | destructive | ✅ | Apaga uma mensagem sua (para todos) |
| `zapi_action` | destructive | ✅* | Ação avançada do provider não coberta pelas tools. *Confirmação só para actions de envio |

> Quase todas aceitam `instance` (alias `pessoal`/`profissional` ou `instance_id`) para escolher de qual número operar em setups multi-instância.

> **Menção em grupos LID:** quando os participantes aparecem com LID (ex.: `sender_phone` de 14-15 dígitos nas mensagens do grupo), o `mentions` do `send` aceita o JID completo — `mentions: ["<lid>@lid"]` com o token `@<lid>` no texto renderiza a menção clicável nos dois providers.

---

## Gates de segurança

Defesa em profundidade, alinhada com [SECURITY.md](../../SECURITY.md):

1. **Dupla confirmação** — o schema da tool instrui o fluxo de 2 passos (sem `confirmed` → bloqueia mostrando o que será feito; `confirmed:true` → executa). O **gate server-side** (`REQUIRE_CONFIRMED`, default ON) repete a verificação em `send-message`/`send-voice`/`wa-proxy`, então um cliente que ignore o schema ainda é barrado.
2. **Rate-limit** — por chat/min, global/min e global/dia (ver [ARQUITETURA.md](ARQUITETURA.md#fluxo-outbound-claude-envia)).
3. **Auditoria** — toda ação destrutiva/write passa por `wa-proxy` e fica registrada em `wa_action_log` (com `agent_request_id` para idempotência em retries).

---

**Próximo:** [TROUBLESHOOTING.md](TROUBLESHOOTING.md) para diagnóstico, [SCHEMA.md](SCHEMA.md) para o banco, [ARQUITETURA.md](ARQUITETURA.md) para o fluxo.
