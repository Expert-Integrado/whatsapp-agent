# Guia de migração — v1 → v2

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
