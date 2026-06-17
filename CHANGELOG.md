# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/); versionamento [SemVer](https://semver.org/lang/pt-BR/).

## [2.0.0] — 2026-06-17

Reescrita arquitetural. O MCP deixa de rodar **local (stdio)** e passa a ser um **servidor MCP remoto sobre HTTP**, hospedado nas Edge Functions do Supabase. A operação fica **agnóstica de harness**: funciona em qualquer app de IA com suporte a MCP (Claude Code, Desktop, Web e outros). Guia de migração: [`MIGRATION.md`](MIGRATION.md).

### Added
- **MCP-over-HTTP** — Edge Function `mcp-api`: servidor MCP em Streamable HTTP / JSON-RPC, expondo ~20 tools. O runtime mora no Supabase; não há processo local.
- **OAuth 2.1** na própria `mcp-api` — ela é o Authorization Server (auto-approve, confidential client + PKCE). Conecta no **chat do Claude Desktop/Web** via *Add custom connector* → *Advanced settings* (Client ID + Secret). Sem tela de consent, sem hosting externo.
- **Auth por header** `x-mcp-key` para o Claude Code, em paralelo ao OAuth.
- Tool `inbox`: parâmetro `min_idle_days` + campo `idle_days` no retorno + ordenação por "mais parado primeiro" — absorve a antiga skill `estou-devendo`.
- Skill **`setup`** como *project skill* (`.claude/skills/setup`) — instalação ponta a ponta via Supabase CLI (migrations, secrets, deploy, OAuth, webhook Z-API).
- Voice guide no banco (`0030_voice_guide`), lido server-side pela `mcp-api`.
- `pg_cron`/`pg_net` habilitados na migration inicial; helper `call_edge_function` lê URL + `service_role` do **Supabase Vault** — zero segredo hardcoded nos cron jobs.

### Changed
- Tool `read` passa a transcrever os áudios pendentes inline (Whisper) e devolve o histórico cronológico pronto — absorve a antiga skill `transcrever-conversa`.
- `.mcp.json`: de stdio (cliente Node local) para HTTP remoto (`${WHATSAPP_AGENT_MCP_URL}` + `${MCP_API_KEY}`).
- Migrations tornadas *clean-apply* (`0028`/`0029`) — aplicam num banco virgem sem ajuste manual.

### Removed
- **Cliente MCP stdio local** (`mcp/`).
- **Plugin do Claude Code** (`.claude-plugin/`, marketplace).
- **Skills operacionais** `estou-devendo` e `transcrever-conversa` e seus scripts Python — viraram tools.

### Security
- `service_role` / secret key vivem só nos secrets das Edge Functions e no Vault; nunca no repositório.
- Acesso ao MCP protegido por `x-mcp-key` (header) ou OAuth (client_secret + PKCE).

## [1.x] — base (era stdio)

Ponto de partida, antes da v2:
- MCP via **stdio** — cliente Node local em `mcp/`, operado pelo Claude Code.
- Funcionalidades como **skills** com scripts Python (`estou-devendo`, `transcrever-conversa`).
- Distribuído como **plugin** do Claude Code (`.claude-plugin/` + marketplace).
