---
name: setup
description: "Instala o WhatsApp Agent do zero — provisiona o Supabase (migrations + edge functions + secrets via Supabase CLI) e configura os serviços externos (Z-API, OpenAI). Use no primeiro setup, depois de clonar o repositorio."
argument-hint: "(sem argumentos — conduz o setup interativo)"
allowed-tools: Bash, Read, Write, Edit
---

Conduz a instalacao completa do WhatsApp Agent. Separacao clara de planos:

- **Desenvolvimento / deploy** (este setup) roda pelo **Supabase CLI**, local — como um desenvolvedor faria.
- **Operacao** (uso no dia a dia) e via o **MCP remoto** (edge function `mcp-api`) conectado ao seu harness — fora do escopo deste setup.

Conduza o usuario **passo a passo, uma informacao por vez**, validando cada etapa antes de seguir. **NUNCA** escreva credenciais em arquivos versionados — somente no `.env` local (que e gitignored). Pare e peca confirmacao antes de qualquer passo destrutivo.

---

## 0. Pre-requisitos

### Contas (todas com plano gratuito pra comecar)

| Servico | O que criar | O que anotar |
|---|---|---|
| **[Supabase](https://supabase.com)** | um projeto | project **ref**, **PAT** (Account → Access Tokens), **senha do banco**, **secret key** (Settings → API Keys) |
| **[Z-API](https://z-api.io)** | uma instancia + conectar o numero (QR code) | `instance_id`, `token`, `client_token` |
| **[OpenAI](https://platform.openai.com)** | uma API key | `OPENAI_API_KEY` (transcricao de audio) |

### Supabase CLI

Cheque se ja existe: `supabase --version`. Se nao, instale conforme o OS:

- **macOS / Linux (Homebrew):**
  ```bash
  brew install supabase/tap/supabase
  ```
- **Windows (Scoop):**
  ```powershell
  scoop bucket add supabase https://github.com/supabase/scoop-bucket.git
  scoop install supabase
  ```
- **Qualquer OS (binario oficial)** — quando nao houver gerenciador: baixe o asset do seu OS/arch em <https://github.com/supabase/cli/releases/latest>, extraia e ponha no PATH. Ex. (Windows, PowerShell):
  ```powershell
  # baixe supabase_<versao>_windows_amd64.tar.gz, depois:
  tar -xzf supabase_*_windows_amd64.tar.gz -C "$env:USERPROFILE\supabase-cli"
  ```
  (Linux: `..._linux_amd64.tar.gz`; macOS: `..._darwin_arm64.tar.gz` ou `_amd64`.)
- **Docker e OPCIONAL** — o `functions deploy` faz o bundle sem Docker (so emite um `WARNING: Docker is not running`, que pode ignorar). Docker so e necessario pra rodar functions localmente (`supabase functions serve`).

---

## 1. Credenciais → `.env`

Crie/edite o `.env` na raiz do repo (ja e gitignored) com o que o usuario fornecer:

```
SUPABASE_ACCESS_TOKEN=sbp_...        # PAT — Account → Access Tokens
SUPABASE_PROJECT_REF=...             # ref do projeto (ex: abcdwxyzab)
SUPABASE_SECRET_KEY=sb_secret_...    # Settings → API Keys (chave nova)
SUPABASE_SERVICE_ROLE_KEY=eyJ...     # service_role JWT (Settings → API Keys → Legacy) — vai pro Vault (cron interno)
SUPABASE_DB_PASSWORD=...             # senha do banco (pro db push)
ZAPI_INSTANCE_ID=...
ZAPI_TOKEN=...
ZAPI_CLIENT_TOKEN=...
OPENAI_API_KEY=sk-...
```

Antes de rodar o CLI, exporte o token no ambiente (o CLI o usa pra autenticar, sem login interativo):
- bash/zsh: `export SUPABASE_ACCESS_TOKEN=sbp_...`
- PowerShell: `$env:SUPABASE_ACCESS_TOKEN = 'sbp_...'`

---

## 2. Banco — migrations

```bash
supabase link --project-ref <SUPABASE_PROJECT_REF>   # usa o PAT; pede a senha do banco
supabase db push                                      # aplica supabase/migrations/ em ordem
```

A `0001` habilita `pg_cron`/`pg_net` e cria o helper `public.call_edge_function(path)`, que lê URL+service_role do **Vault** em runtime — por isso **nenhuma** migration tem segredo hardcoded.

### 2.1 Popular o Vault (cron interno)

Os cron jobs e o trigger de transcrição chamam edge functions via `call_edge_function`, que busca dois secrets no Vault. Popule-os (idempotente) com o **ref** e o **service_role JWT** (não a secret key nova — as functions internas usam `verify_jwt`):

```bash
SQL="select vault.create_secret('https://<SUPABASE_PROJECT_REF>.supabase.co','project_url');
     select vault.create_secret('<SUPABASE_SERVICE_ROLE_KEY>','service_role_key');"
curl -s -X POST "https://api.supabase.com/v1/projects/<SUPABASE_PROJECT_REF>/database/query" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" \
  -d "{\"query\": \"$(echo "$SQL" | tr '\n' ' ')\"}"
```

> Em **re-setup** (secret já existe), troque `vault.create_secret(valor, nome)` por `vault.update_secret(id, valor)` — pegue o `id` em `select id, name from vault.secrets`. Enquanto o Vault estiver vazio, os jobs apenas emitem um `NOTICE` e não disparam (não quebram nada).

---

## 3. Secrets das edge functions

Gere um `MCP_API_KEY` aleatorio (32+ chars; ele e a chave que protege a `mcp-api`) e configure todos os secrets de uma vez:

```bash
supabase secrets set --project-ref <SUPABASE_PROJECT_REF> \
  MCP_API_KEY=<aleatorio> \
  ZAPI_INSTANCE_ID=... ZAPI_TOKEN=... ZAPI_CLIENT_TOKEN=... \
  OPENAI_API_KEY=sk-...
```

> O `SUPABASE_URL` e a `service_role`/secret key o Supabase **injeta automaticamente** nas functions — nao precisa setar.

---

## 4. Edge functions

Deploy de todas de uma vez (respeita o `verify_jwt` de cada uma no `supabase/config.toml`):

```bash
supabase functions deploy --project-ref <SUPABASE_PROJECT_REF>
```

A `mcp-api` e o `process-webhook` ja estao marcados com `verify_jwt = false` no `config.toml` (tem auth propria: `x-mcp-key` e `webhook_token`). As demais ficam com `verify_jwt = true` (so chamada interna via service_role).

Confirme: `supabase functions list --project-ref <ref>` — todas `ACTIVE`.

---

## 5. Webhook da Z-API

Aponte os webhooks da instancia pro `process-webhook` **e** ligue a notificacao de mensagens **enviadas por voce** — sem o ultimo passo, so as mensagens recebidas entram no banco (as que voce envia ficam de fora). Tres chamadas (use `ZAPI_INSTANCE_ID`/`ZAPI_TOKEN`/`ZAPI_CLIENT_TOKEN` do `.env`):

```bash
HOOK="https://<SUPABASE_PROJECT_REF>.supabase.co/functions/v1/process-webhook"
ZBASE="https://api.z-api.io/instances/$ZAPI_INSTANCE_ID/token/$ZAPI_TOKEN"

# mensagens recebidas
curl -s -X PUT "$ZBASE/update-webhook-received" -H "Client-Token: $ZAPI_CLIENT_TOKEN" -H "Content-Type: application/json" -d "{\"value\":\"$HOOK\"}"
# status de entrega
curl -s -X PUT "$ZBASE/update-webhook-delivery" -H "Client-Token: $ZAPI_CLIENT_TOKEN" -H "Content-Type: application/json" -d "{\"value\":\"$HOOK\"}"
# ESSENCIAL: notificar as mensagens que VOCE envia (endpoint dedicado — nao e o notifySentByMe do update-webhook-received)
curl -s -X PUT "$ZBASE/update-notify-sent-by-me" -H "Client-Token: $ZAPI_CLIENT_TOKEN" -H "Content-Type: application/json" -d '{"notifySentByMe":true}'
```

Confirme em `GET $ZBASE/me` (header `Client-Token`): `receivedCallbackUrl`/`deliveryCallbackUrl` apontando pro `process-webhook` **e `receiveCallbackSentByMe: true`**.

---

## 6. OAuth — credenciais do connector (chat do Claude)

Pra conectar pelo **chat do Claude Desktop/Web** (a UI de Connectors nao aceita header custom como o `x-mcp-key`), a propria `mcp-api` e o **Authorization Server**: ela auto-aprova o fluxo OAuth (sem tela de consent) e protege o `/token` com um **confidential client** — um par `client_id` + `client_secret` que o dono cola nas *Advanced settings* do connector. Sem login, sem usuario: o secret e a credencial.

Gere o par (forte, aleatorio) e configure como secrets:

```bash
# OAUTH_CLIENT_ID = ex. wa-<16 chars>;  OAUTH_CLIENT_SECRET = >=40 chars aleatorios
supabase secrets set --project-ref <SUPABASE_PROJECT_REF> \
  OAUTH_CLIENT_ID=<gerado> OAUTH_CLIENT_SECRET=<gerado>
```

> Salve `OAUTH_CLIENT_ID` + `OAUTH_CLIENT_SECRET` no `.env` e **exiba-os ao usuario** — sao o que ele informa nas *Advanced settings* do connector (entregues no cartao do passo 9). O `x-mcp-key` (Claude Code) continua valendo em paralelo.

---

## 7. Conectar o MCP (operacao)

O backend esta no ar. Escolha o caminho conforme o harness:

**Claude Code** (inclui a aba Code do Desktop) — header key, direto no `.mcp.json`:
```json
{ "mcpServers": { "whatsapp-agent": { "type": "http", "url": "https://<ref>.supabase.co/functions/v1/mcp-api", "headers": { "x-mcp-key": "${MCP_API_KEY}" } } } }
```

**Claude Desktop (chat) ou Claude Web** (claude.ai) — via OAuth, **sem** header:
1. Settings -> Connectors -> **Add custom connector**.
2. URL: `https://<SUPABASE_PROJECT_REF>.supabase.co/functions/v1/mcp-api`
3. **Advanced settings** -> OAuth Client ID = `<OAUTH_CLIENT_ID>`, OAuth Client Secret = `<OAUTH_CLIENT_SECRET>` (passo 6).
4. Conectar -> o Claude roda o fluxo OAuth (auto-aprovado, sem tela) -> as ~20 tools aparecem.

---

## 8. Smoke test

Com o MCP conectado, chame a tool **`status`** — deve retornar a conexao Z-API e contagem de mensagens. Ou direto por HTTP (caminho Claude Code, com a chave):

```bash
curl -s -X POST "https://<ref>.supabase.co/functions/v1/mcp-api" \
  -H "x-mcp-key: <MCP_API_KEY>" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"status","arguments":{}}}'
```

---

## 9. Entrega final — cartão de conexão

Ao terminar, **entregue ao usuario este cartao de conexao** e deixe claro que ele serve pra **qualquer app de IA que aceite servidores MCP remotos** (Claude Desktop, Claude Web, Claude Code — e outros clientes MCP). Preencha com os valores reais:

```
╔══ WhatsApp Agent · servidor MCP ══════════════════════════════╗

  Servidor (URL):
    https://<SUPABASE_PROJECT_REF>.supabase.co/functions/v1/mcp-api

  ▸ Apps de chat (Claude Desktop, Claude Web, e outros clientes
    MCP) — conecte a URL e, nas Advanced settings, informe:
        OAuth Client ID:     <OAUTH_CLIENT_ID>
        OAuth Client Secret: <OAUTH_CLIENT_SECRET>

  ▸ Apps que aceitam header custom (Claude Code, etc.):
        header  x-mcp-key: <MCP_API_KEY>

╚════════════════════════════════════════════════════════════════╝
```

Feche com uma orientação assim:

> Pronto. Esse servidor MCP funciona em **qualquer app de IA com suporte a MCP**. Em apps de chat, adicione a **URL** como connector e cole o **Client ID + Client Secret** nas *Advanced settings*. Em apps que aceitam header (Claude Code), use a **chave `x-mcp-key`**. **Guarde o Client Secret num gerenciador** — é o seu acesso ao MCP.

Resuma também o que ficou configurado e aponte qualquer pendencia (ex.: numero Z-API ainda nao conectado, `OPENAI_API_KEY` ausente).
