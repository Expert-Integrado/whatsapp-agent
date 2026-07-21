# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/); versionamento [SemVer](https://semver.org/lang/pt-BR/).

## [Unreleased]

### Added
- **Credencial escopada por categoria** (`MCP_API_KEY_SCOPED` + `MCP_SCOPED_CATEGORY`): segunda API key estática cujo universo é SÓ os chats de uma categoria — pra dar a um agente/integração acesso a uma fatia do WhatsApp sem enxergar o resto. `inbox`/`search` ganham o filtro **forçado no servidor** (params do cliente nunca relaxam o escopo), tools endereçadas a chat devolvem `contato fora do escopo desta credencial` fora da categoria (candidatos de desambiguação também são filtrados — nome de chat fora do escopo nunca vaza), e conversa **nova** aberta pela própria key (send/allow_new pra número sem chat, ou chat sem categoria E sem histórico) nasce categorizada automaticamente (`assigned_by: rule:scoped_key`). `categorize` escopada só aplica a própria categoria em chat ainda sem nenhuma; `uncategorize`, `zapi_action`, `sync_groups`, `merge_ghost_chats`, `setup_voice_guide`, `list_scheduled`, `cancel_scheduled` e `download_attachment` ficam indisponíveis; `tools/list` já devolve só o que a key pode chamar. Sem os dois secrets definidos, nada muda. Decisão pura em `_shared/wa/scoped-key.ts` com suíte própria (9 testes).

### Fixed
- **`edit_message` agora edita legenda de imagem/vídeo/documento**, não só texto. A Z-API documenta um campo de edição próprio por tipo (`editMessageId` em `/send-text`, `editImageMessageId` em `/send-image`, `editVideoMessageId` em `/send-video`, `editDocumentMessageId` em `/send-document`) — o bloqueio "So texto" era uma limitação do código, não da API. Fecha bug reportado durante envio dos convites do open house (30/06/2026, 9 mensagens `type:image` não editáveis na época).
- **`v_chats_with_contact.contact_name` cai pro `sender_name` da mensagem mais recente** quando `chat_name` está vazio (chats `@lid` sem nome próprio). Fecha o item 7 da task de correção de chat novo/LID (caso Leandro Eckhardt): `search`/`resolve_chat` por nome do contato agora encontram o chat mesmo quando ele só existe como `@lid`. Migration `0054`.

## [3.4.0] — 2026-07-10

Agendamento de mensagens: programe o envio futuro de uma **sequência** de mensagens (1–10 itens em ordem — texto, imagem+legenda, áudio/PTT, vídeo, documento, voz TTS, enquete, link com preview) em qualquer chat e qualquer instância.

### Added
- **Tool `schedule`** — agenda a sequência pra envio único futuro (`at` em ISO-8601 com offset). Gate de confirmação na **criação** (resumo → `confirmed:true`); o disparo depois roda sem novo gate e ignora o bloqueio de inbound recente (já autorizado). Pausa humanizada entre itens (ou `delay_after` 0–300 s por item). Item `voice` gera o TTS na hora do disparo; `media_url` precisa estar válida no disparo (aviso automático pra signed URLs do Storage).
- **Tools `list_scheduled` / `cancel_scheduled`** — acompanhamento (status, progresso `items_sent/total`, erro) e cancelamento enquanto `pending`. Sem edição: cancelar + agendar de novo.
- **Edge Function `dispatch-scheduled`** (cron `pg_cron` a cada 1 min) — drena `scheduled_sequences` vencidas reusando `send-message`/`send-voice`/`wa-proxy` (mesmo caminho de provider, rate-limit e `confirmed` do envio normal). Budget de 50 s por invocação com **resume** automático via cursor `items_sent`; item que falha aborta os restantes com erro registrado.
- **Migration `0049_scheduled_sequences`** (nasceu como 0047; renumerada por colisão com `categories_alinhamento_vault`) — tabela `scheduled_sequences` (itens em JSONB, status `pending/processing/sent/failed/canceled`, índice parcial de vencidas) + job `dispatch-scheduled`.

### Notes
- Precisão de disparo: minuto a minuto (cron 1/min), não segundo exato.
- Sequências longas de itens curtos podem esbarrar no rate-limit por chat/min — use `delay_after >= 15` nesses casos.

## [3.3.0] — 2026-07-09

Personalização por contato + página pública do projeto. Consolida o que entrou pela PR #5 (nunca documentado no changelog) e as adições do dia.

### Added
- **`chats.voice_profile` (perfil de voz por contato)** — como a pessoa chama o dono (`como_me_chama`), como o dono a chama (`como_chamo`, extraído só de mensagem autêntica do dono), gírias, registro da relação, exemplos e confiança. O `read` devolve o perfil e instrui o agente a **espelhar** ao redigir (por cima do voice guide global); o `annotate_chat` faz merge raso pra captura incremental (`fonte:'incremental'`); `fonte:'manual'` é intocável pra rotinas automáticas. Migrations `0035`/`0038`.
- **`chats.brain_contact_id` (vínculo com vault de contatos)** — link direto por ID pro contato no vault externo (expert-contacts): o agente encontra a pessoa sem depender de busca por telefone. Devolvido no `read`, gravado/desvinculado via `annotate_chat`. Migration `0036`.
- **Skill `voice-profile-backfill`** — varre o histórico (DMs + resgate por grupos + outbound autêntico do dono) e grava os perfis em lote, com piloto revisável. Inclui **modo `--nutricao`**: delta semanal (contatos novos com atividade + perfis defasados com mensagens novas, que o analista atualiza a partir do `current_profile`) — rotina local recomendada de 1x/semana, documentada no README.
- **Auditoria de disparo (`sent_by_agent`)** — mensagens enviadas por agente marcadas na origem (`fromApi` do webhook coberto pela migration `0037`); é o que garante que `como_chamo` aprende só com a voz real do dono.
- **Página pública do projeto (GitHub Pages)** — `docs/index.html` servido em <https://expert-integrado.github.io/whatsapp-agent/>: o que é, como funciona, as 22 tools, voz, provedores, segurança e instalação, com branding Expert Integrado fixo e og:image pra preview em redes sociais.

### Fixed
- **Timeout 57014 no backfill em chats gigantes** — `chat_id=in.(...)` com `order`+`limit` fazia o planner abandonar o índice composto; consultas agora são por chat (`eq.`) com merge no cliente (`sbPerChat`).
- **`voice-profile-backfill` resiliente ao rename da 0040** — tenta `wa_instance` e cai pra `zapi_instance` em banco ainda não migrado.

## [3.2.0] — 2026-07-09

### Added
- **Suporte multi-provider** — cada instância WhatsApp escolhe o provedor no campo `provider`: `'zapi'` (Z-API, hospedado/pago, padrão) ou `'evolution'` (Evolution API, open-source/self-hosted). A seleção é por instância; é possível misturar provedores no mesmo banco.
- **Abstração neutra `WaProvider`** — adapters intercambiáveis por trás das Edge Functions; cada adapter implementa envio, mídia, grupos e webhook de forma independente. Adicionar provedores futuros não exige tocar no código de negócio.
- **`wa-proxy`** — substitui a `zapi-proxy`; roteamento automático para o adapter correto conforme o `provider` da instância.
- **Evolution: `send-poll`, `get-contact-info`, `contacts` e `phone-exists`** no `buildAction` — enquetes, perfil de contato, listagem de contatos e verificação de número canônico (9º dígito) funcionais nos dois providers. `forward` permanece exclusivo Z-API (Evolution v2.3 não tem endpoint de encaminhamento).
- Collections Postman de referência (Z-API e Evolution v2.3) em `docs/`.

### Changed
- **Breaking interno — tabelas renomeadas:** `zapi_instance` → `wa_instance`, `zapi_action_log` → `wa_action_log`, coluna `token` → `auth_token`. Views de compatibilidade `zapi_instance`/`zapi_action_log` criadas como shims de depreciação — serão removidas numa versão futura.
- Upgrade automático via `supabase db push` (migration `0040_provider_neutralization`): instâncias existentes recebem `provider = 'zapi'` sem intervenção manual; nenhum dado é apagado (rename, não drop).

### Deprecated
- Views de compatibilidade `zapi_instance` e `zapi_action_log` — use `wa_instance` e `wa_action_log` diretamente. As views serão removidas numa versão futura.
- Edge Function `zapi-proxy` — substituída por `wa-proxy`; pode ser removida com `supabase functions delete zapi-proxy` após o deploy.

### Notes
- **Usuários Z-API: nenhuma reconfiguração necessária.** Credenciais e instâncias são preservadas; o comportamento é idêntico ao da v2.x.
- Guia de upgrade completo: [`MIGRATION.md`](MIGRATION.md) — seção "Upgrade para v3.0 (multi-provider)".

## [3.1.0] — 2026-07-06

Fix do bug de envio pra chat novo que engolia mensagens (ClickUp 86ajby187). A causa raiz **não era o remap de LID**: era o **9º dígito BR**. Contas antigas são registradas no WhatsApp sem o 9 — enviar pro número com 9 criava um **chat fantasma** (a 1ª mensagem chegava via remap do WhatsApp, as seguintes morriam no órfão e a Z-API seguia respondendo 200).

### Fixed
- **`send` com `allow_new` canonicaliza o 9º dígito** (`mcp-api`): antes de criar o chat de primeiro contato, consulta `GET /phone-exists/{phone}` na Z-API e usa o **número canônico registrado** como `chat_id` (o `lid` retornado já alimenta o `lid_mapping`). Número sem WhatsApp é recusado na hora, em vez de "enviar" pro nada. Se o `phone-exists` estiver fora, degrada pro comportamento antigo com `warning` explícito na resposta.
- **`resolveChat` não deixa mais o fantasma vencer**: quando existem dois chats numéricos na mesma instância que são variantes de 9º dígito um do outro, ganha o que tem identidade (nome real de contato) — antes o desempate era por recência, e os envios engolidos renovavam o `last_message_at` do próprio fantasma.

### Added
- **Tool `merge_ghost_chats`** + migration `0031` (função `merge_ninth_digit_ghosts`): encontra pares real+fantasma já existentes, move mensagens/categorias/reações pro chat real, redireciona o `lid_mapping`, funde metadados e apaga o fantasma. `dry_run=true` por default; pares ambíguos são reportados e não são tocados.
- **Tool `check_delivery`** (verificação de entrega): expõe o `send_status` (`pending/sent/delivered/read`) que o `process-webhook` já gravava via `MessageStatusCallback`. Mensagem de agente presa em `sent`/`pending` há 2+ min vira alerta com diagnóstico de chat fantasma. O `send` pra chat novo passa a devolver `delivery_hint` sugerindo a verificação.
- **Action `phone-exists`** na allowlist READ do `zapi-proxy` (`GET /phone-exists/{phone}`).

> Depois do deploy, rode `merge_ghost_chats` com `dry_run=true`, confira os pares e rode com `dry_run=false` pra limpar os fantasmas históricos.

## [3.0.2] — 2026-07-06

### Fixed
- **Regra `tu-pronome` removida das `HARD_RULES` universais** (`mcp-api`). Pronome (tu/você) é traço **pessoal/regional** do dono, não um fingerprint universal de IA — quem usa "tu" (ex: nordestino) e quem usa "você" estão ambos corretos. A regra marcava qualquer `tu/teu/tua` como violação `high` para **todos** que instalam o agent, forçando "vc/seu" indevidamente. A escolha de pronome passa a ser responsabilidade exclusiva do `voice_guide` de cada instância (`public.voice_guide`), nunca hardcoded como regra global. As outras 7 hard-rules — em-dash, saudação genérica, hype, urgência manufaturada, softener, validação afetiva e rsrs, essas sim universais — permanecem intactas.

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
