# WhatsApp Agent — instruções para o Claude

Backend headless que conecta um número de WhatsApp ao Claude via MCP: provedor (Z-API ou Evolution API) → Supabase (Postgres + Storage + Edge Functions) → `mcp-api` (MCP-over-HTTP, 32 tools). Não há processo local: o runtime é o projeto Supabase de quem instala.

- Página do projeto: <https://expert-integrado.github.io/whatsapp-agent/>
- Instalação e manual de uso: [README](README.md) · referência técnica: [docs/reference/](docs/reference/)

## Onboarding assistido (instruções para o Claude)

**Oferta ativa:** ao abrir este repositório sem configuração (sem `.env` na raiz, ou o usuário indica que nada foi instalado ainda), ofereça o setup de imediato: "Quer que eu instale o WhatsApp Agent agora? Eu conduzo conversando com você." A condução completa — inclusive o protocolo de conversa (linguagem de dono, uma pergunta por vez, custos antes, rotas de navegador, validação de credencial, retomada) — mora na project skill [`setup`](.claude/skills/setup/SKILL.md): siga a seção "Como conduzir a conversa" dela antes de executar qualquer etapa. Não improvise um roteiro próprio.

**Invariantes (valem mesmo fora do setup completo, ex. reconfigurar só a voz):**

1. **Login é sempre do usuário.** Nunca peça senha ou código 2FA no chat.
2. **Segredos só em `.env` local** (gitignored) e nos secrets do Supabase (`supabase secrets set`). Nunca em arquivo versionado; não ecoar valores no chat além do necessário.
3. **Nunca declare pronto sem prova real** — a prova de vida da skill (seção 8), não build/deploy bem-sucedido.
4. **Etapas de personalização são rodáveis isoladas:** "quero configurar a voz" = seções 2.3-2.5 + 8.1 da skill; "quero montar meu voice guide" = seção 2.6. Não exigem refazer o setup.

**Etapas de navegador deste repo (com URLs):**

| Etapa | Onde |
|---|---|
| Criar conta + instância Z-API e conectar o número via QR code | <https://z-api.io> (painel da conta) |
| Criar o projeto Supabase | <https://supabase.com/dashboard/new> |
| Gerar o PAT do Supabase | <https://supabase.com/dashboard/account/tokens> |
| Copiar as chaves do projeto (secret key + service_role legacy) | dashboard do projeto → Settings → API Keys |
| Criar a API key da OpenAI (Whisper) | <https://platform.openai.com/api-keys> |
| (Se o usuário quis voz — triagem 0.4 da skill) Escolher ou clonar a voz na ElevenLabs | <https://elevenlabs.io/app/voice-lab> |

Webhooks do provedor e secrets do Supabase são configurados por **CLI/curl** (a skill traz os comandos prontos) — não são etapa de navegador.

## Operação (pós-setup)

O dia a dia é pelo **MCP remoto** (`https://SEU_PROJECT_REF.supabase.co/functions/v1/mcp-api`) — ver [Manual de uso](README.md#manual-de-uso). O repositório só é necessário pra setup, migrations e as skills locais (`voice-profile-backfill`, `nutrir-contatos`).
