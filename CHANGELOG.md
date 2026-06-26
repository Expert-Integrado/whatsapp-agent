# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/); versionamento [SemVer](https://semver.org/lang/pt-BR/).

## [3.0.0] — 2026-06-26

### Added
- **Suporte multi-provider** — cada instância WhatsApp escolhe o provedor no campo `provider`: `'zapi'` (Z-API, hospedado/pago, padrão) ou `'evolution'` (Evolution API, open-source/self-hosted). A seleção é por instância; é possível misturar provedores no mesmo banco.
- **Abstração neutra `WaProvider`** — adapters intercambiáveis por trás das Edge Functions; cada adapter implementa envio, mídia, grupos e webhook de forma independente. Adicionar provedores futuros não exige tocar no código de negócio.
- **`wa-proxy`** — substitui a `zapi-proxy`; roteamento automático para o adapter correto conforme o `provider` da instância.

### Changed
- **Breaking interno — tabelas renomeadas:** `zapi_instance` → `wa_instance`, `zapi_action_log` → `wa_action_log`, coluna `token` → `auth_token`. Views de compatibilidade `zapi_instance`/`zapi_action_log` criadas como shims de depreciação — serão removidas numa versão futura.
- Upgrade automático via `supabase db push` (migration `0031_provider_neutralization`): instâncias existentes recebem `provider = 'zapi'` sem intervenção manual; nenhum dado é apagado (rename, não drop).

### Deprecated
- Views de compatibilidade `zapi_instance` e `zapi_action_log` — use `wa_instance` e `wa_action_log` diretamente. As views serão removidas em v3.1.
- Edge Function `zapi-proxy` — substituída por `wa-proxy`; pode ser removida com `supabase functions delete zapi-proxy` após o deploy.

### Notes
- **Usuários Z-API: nenhuma reconfiguração necessária.** Credenciais e instâncias são preservadas; o comportamento é idêntico ao da v2.x.
- Guia de upgrade completo: [`MIGRATION.md`](MIGRATION.md) — seção "Upgrade para v3.0 (multi-provider)".

---

## [2.2.1] — 2026-06-17

### Fixed
- O setup passa a configurar o `INTERNAL_EDGE_JWT` (service_role no formato **JWT legado**). A `SUPABASE_SERVICE_ROLE_KEY` auto-injetada vem no formato novo (não-JWT), que o **Storage** rejeita com `400` — sem o `INTERNAL_EDGE_JWT`, o download de áudio (transcrição Whisper) e as chamadas edge→edge falhavam. Passo 3 da skill `setup` atualizado com a explicação.

## [2.2.0] — 2026-06-17

### Fixed
- **Menção "@todos" em grupos** agora funciona de verdade. A Z-API não tem "mencionar todos" nativo e o antigo `mentionsEveryOne` não surtia efeito. A edge `send-message` passa a: buscar os participantes via `group-metadata`, **injetar os tokens `@<número>` no texto** E preencher o array `mentioned` — a Z-API exige os dois. Aplicado a **texto, imagem e vídeo**; `mentionsEveryOne` removido. (Porte do fix do Eric, commit c2f8d92.)

## [2.1.1] — 2026-06-17

### Fixed
- Setup do webhook Z-API agora liga o `receiveCallbackSentByMe` via o endpoint dedicado **`update-notify-sent-by-me`**. Sem isso, as mensagens **enviadas pelo dono** não chegavam ao `process-webhook` e ficavam de fora do banco (só as recebidas eram registradas). O passo 5 da skill `setup` passou de "configure pelo painel" para os 3 comandos `curl` concretos (received + delivery + notify-sent-by-me) com verificação no `/me`.

## [2.1.0] — 2026-06-17

### Added
- **Refresh token** no OAuth da `mcp-api`. O `/token` passa a emitir um `refresh_token` **sem expiração** junto do `access_token` (1h) e a aceitar `grant_type=refresh_token`. O cliente renova o access sozinho em background — a conexão do connector (Claude Desktop/Web) **não cai mais** sem reconexão manual. Segurança: access curto que rotaciona, refresh protegido pelo `client_secret`; *kill switch* = rotacionar a `MCP_API_KEY` invalida todos os tokens. O AS metadata anuncia `grant_types_supported: [authorization_code, refresh_token]`.

> Quem já conectou na v2.0 deve **remover e re-adicionar o connector uma vez** para receber o `refresh_token`; daí em diante não reconecta mais.

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
