# WhatsApp Agent — instruções para o Claude

Backend headless que conecta um número de WhatsApp ao Claude via MCP: provedor (Z-API ou Evolution API) → Supabase (Postgres + Storage + Edge Functions) → `mcp-api` (MCP-over-HTTP, 23 tools). Não há processo local: o runtime é o projeto Supabase de quem instala.

- Página do projeto: <https://expert-integrado.github.io/whatsapp-agent/>
- Instalação e manual de uso: [README](README.md) · referência técnica: [docs/reference/](docs/reference/)

## Onboarding assistido (instruções para o Claude)

**Oferta ativa:** ao abrir este repositório sem configuração (sem `.env` na raiz, ou o usuário indica que nada foi instalado ainda), ofereça o setup de imediato: "Quer que eu instale o WhatsApp Agent agora? Eu conduzo passo a passo." A condução completa mora na project skill [`setup`](.claude/skills/setup/SKILL.md) — siga-a etapa por etapa; esta seção define só o protocolo de condução (não duplica a skill).

**Protocolo:**

1. **Pré-requisitos primeiro.** Verifique o Supabase CLI (`supabase --version`) e as contas necessárias (Supabase, Z-API ou Evolution, OpenAI; ElevenLabs opcional) antes de qualquer passo.
2. **Etapa de navegador = perguntar com botões.** Para CADA etapa que acontece no navegador, pergunte via AskUserQuestion: **"Essa etapa é no navegador. Quer que eu faça pra você?"** com estas opções:
   - **Default — Playwright MCP:** o Claude navega e preenche. Se o MCP faltar, instalar com `claude mcp add playwright -- npx -y @playwright/mcp@latest`.
   - **Claude in Chrome** (Chrome do usuário, já logado), quando disponível.
   - **Manual:** o Claude dita o passo a passo e o usuário executa.
3. **Login é sempre do usuário.** Nunca peça senha ou código 2FA no chat. Na rota automatizada, abra a página de login e aguarde o usuário autenticar na própria janela antes de continuar.
4. **Validar cada credencial com uma chamada real** antes de avançar (ex.: `GET /me` da instância Z-API; `supabase projects list` com o PAT; uma chamada mínima com a key da OpenAI). Credencial inválida = parar e corrigir na hora, não acumular pro fim.
5. **Segredos só em `.env` local** (gitignored) e nos secrets do Supabase (`supabase secrets set`). Nunca em arquivo versionado; não ecoar valores no chat além do necessário.
6. **Encerramento:** teste E2E real (tool `status` na `mcp-api` — conexão do provedor + contagem de mensagens), cartão de conexão (URL da `mcp-api` + credenciais de acesso) e resumo do que ficou configurado, com pendências explícitas.

**Etapas de navegador deste repo (com URLs):**

| Etapa | Onde |
|---|---|
| Criar conta + instância Z-API e conectar o número via QR code | <https://z-api.io> (painel da conta) |
| Criar o projeto Supabase | <https://supabase.com/dashboard/new> |
| Gerar o PAT do Supabase | <https://supabase.com/dashboard/account/tokens> |
| Copiar as chaves do projeto (secret key + service_role legacy) | dashboard do projeto → Settings → API Keys |
| Criar a API key da OpenAI (Whisper) | <https://platform.openai.com/api-keys> |
| (Opcional) Escolher ou clonar a voz na ElevenLabs | <https://elevenlabs.io/app/voice-lab> |

Webhooks do provedor e secrets do Supabase são configurados por **CLI/curl** (a skill traz os comandos prontos) — não são etapa de navegador.

## Operação (pós-setup)

O dia a dia é pelo **MCP remoto** (`https://SEU_PROJECT_REF.supabase.co/functions/v1/mcp-api`) — ver [Manual de uso](README.md#manual-de-uso). O repositório só é necessário pra setup, migrations e as skills locais (`voice-profile-backfill`, `nutrir-contatos`).
