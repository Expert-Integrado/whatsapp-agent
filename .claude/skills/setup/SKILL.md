---
name: setup
description: "Instala o WhatsApp Agent do zero em CONVERSA — provisiona o Supabase (migrations + edge functions + secrets), configura o provider (Z-API ou Evolution) e conduz as 3 decisões de identidade do dono: voz em áudio (clone ElevenLabs + calibração de ouvido), humanização oral e voice guide (jeito de escrever). Use no primeiro setup, depois de clonar o repositório; também serve pra rodar SÓ uma etapa de personalização depois (voz, humanização, guide)."
argument-hint: "(sem argumentos — conduz o setup interativo)"
allowed-tools: Bash, Read, Write, Edit, AskUserQuestion
---

Conduz a instalação completa do WhatsApp Agent como uma CONVERSA. Separação de planos:

- **Desenvolvimento / deploy** (este setup) roda pelo **Supabase CLI**, local.
- **Operação** (dia a dia) é via o **MCP remoto** (edge function `mcp-api`) — fora do escopo.

## Como conduzir a conversa (leia antes de executar qualquer coisa)

O usuário típico é o DONO de um negócio, não um dev. Regras de condução:

1. **Linguagem de dono, sempre.** Ele nunca precisa entender nome de credencial ("PAT", "service_role", "ref"). Nas rotas de navegador, VOCÊ coleta as chaves em silêncio e só narra o resultado ("guardei a chave do seu cofre"). Nome técnico só aparece se ele escolher a rota manual — e aí com o passo a passo exato de onde clicar.
2. **Uma pergunta por vez**, sempre explicando a consequência da escolha. Pergunta de decisão = AskUserQuestion com botões. Nunca duas decisões na mesma pergunta.
3. **Custo dito ANTES, consolidado.** Na abertura, dê a ordem de grandeza mensal do conjunto (Z-API paga por número conectado; OpenAI cobra centavos por áudio transcrito; ElevenLabs tem plano pago pra clonar voz) e aponte onde ver os preços atuais. Nunca deixe um custo aparecer depois do usuário já ter investido meia hora.
4. **Privacidade tem resposta pronta.** Se (quando) ele perguntar "quem vê minhas conversas?", responda: "Tudo fica num banco criado NA SUA conta da Supabase — a chave é sua, eu não guardo nada fora dele. O agente lê as mensagens só quando você pede algo que exige ler. Você pode apagar o projeto inteiro a qualquer momento, e ele morre com tudo dentro." Não espere a pergunta pra dizer a primeira frase: ela entra na etapa do Supabase.
5. **Login é sempre do usuário.** Nunca peça senha ou código 2FA no chat. Na rota automatizada, abra a página de login e aguarde ele autenticar na própria janela.
6. **Etapa de navegador = AskUserQuestion com 3 rotas** (protocolo do CLAUDE.md): (a) eu navego e preencho (Playwright MCP — instale com `claude mcp add playwright -- npx -y @playwright/mcp@latest` se faltar), (b) Claude in Chrome (o Chrome dele, já logado), (c) manual — eu dito o passo a passo. Confira que uma rota de browser EXISTE antes de oferecê-la.
7. **Validar cada credencial com uma chamada real** antes de seguir. Credencial inválida = corrigir na hora, não acumular pro fim.
8. **Segredos só em `.env` local** (gitignored) e nos secrets do Supabase. Nunca em arquivo versionado; não ecoar valores no chat além do necessário.
9. **Retomada:** o `.env` é o registro de progresso. Se a sessão cair, ao reabrir a pasta detecte o que já existe (.env parcial, projeto linkado, functions no ar) e diga: "A gente parou em X — sigo de lá." Diga isso ao usuário NA ABERTURA: "se a conversa cair, reabra esta pasta e diga 'continua o setup'".
10. **Nunca declare pronto sem prova real** (seção 8). Nunca siga pras decisões de identidade com o cano quebrado.

### Abertura (fala de referência)

> "Vou instalar o seu WhatsApp Agent conversando com você do início ao fim — a parte técnica é toda minha; eu só te chamo quando a decisão for sua. O caminho: (1) criamos as contas que o agente usa, (2) eu monto tudo sozinho, (3) provamos juntos que está funcionando, e (4) você toma as 3 decisões de identidade do agente: a VOZ dos áudios, se o áudio soa FALADO ou LIDO, e o seu JEITO DE ESCREVER, pra quando eu redigir em seu nome. Sobre custo: além do plano gratuito da Supabase, o conjunto tem uma assinatura mensal da Z-API (por número), centavos por áudio transcrito na OpenAI e, se você quiser a sua voz clonada, o plano pago da ElevenLabs — confira os preços atuais nos sites antes de seguir. Se a conversa cair no meio, reabra esta pasta e diga 'continua o setup' que eu sei onde paramos. Vamos?"

---

## 0. Pré-requisitos

### 0.1 Escolha do provider de WhatsApp

Pergunta em linguagem de negócio (AskUserQuestion):

> "Qual serviço vai manter o seu número de WhatsApp conectado 24h?"
> - **Z-API (recomendado):** serviço pago e gerenciado — você cria a conta, escaneia um QR code com o celular (igual WhatsApp Web) e pronto. É o caminho pra 9 em cada 10 pessoas.
> - **Evolution API:** só se a sua empresa JÁ tem um servidor Evolution rodando com HTTPS e apikey. Se você não sabe o que é isso, a resposta é a primeira opção.

| # | Provider | Modelo | Pré-requisito |
|---|---|---|---|
| **A** | **Z-API** | SaaS gerenciado | Conta no [z-api.io](https://z-api.io), instância criada, número conectado via QR code |
| **B** | **Evolution API** | Self-hosted | Servidor Evolution rodando com HTTPS público + apikey configurada |

> **Caminho B:** este setup **não** provisiona o servidor Evolution — assume que ele já está no ar (docker-compose oficial: <https://github.com/EvolutionAPI/evolution-api/blob/main/docker-compose.yaml>).

Anote a escolha (`zapi` ou `evolution`) — ela ramifica as seções 1, 4.2 e 5.

### 0.2 Contas e dados necessários

#### Serviços comuns (ambos os providers)

| Serviço | O que criar | O que anotar |
|---|---|---|
| **[Supabase](https://supabase.com)** | um projeto | project **ref**, **PAT** (Account → Access Tokens), **senha do banco**, **secret key** e **service_role JWT legado** (Settings → API Keys) |
| **[OpenAI](https://platform.openai.com)** | uma API key | `OPENAI_API_KEY` (transcrição de áudio recebido) |
| **[ElevenLabs](https://elevenlabs.io)** *(condicional — ver 0.4)* | uma API key | `ELEVENLABS_API_KEY` — só pra mensagens de voz (`send_voice`). Sem ela, todo o resto funciona. |

#### Caminho A — Z-API

| Serviço | O que criar | O que anotar |
|---|---|---|
| **[Z-API](https://z-api.io)** | uma instância + conectar o número (QR code) | `instance_id`, `token`, `client_token` |

#### Caminho B — Evolution API

| Item | O que anotar |
|---|---|
| Servidor Evolution já rodando | URL base (ex: `https://evo.meudominio.com`) |
| Instância Evolution | nome da instância |
| Autenticação | `apikey` do servidor |

### 0.3 Supabase CLI (silencioso — não vira pergunta)

Fala: *"Vou preparar minhas ferramentas aqui na sua máquina — só um utilitário oficial da Supabase; nada mais muda no seu computador."*

Cheque `supabase --version`. Se faltar, instale conforme o OS:

- **macOS / Linux (Homebrew):** `brew install supabase/tap/supabase`
- **Windows (Scoop):** `scoop bucket add supabase https://github.com/supabase/scoop-bucket.git && scoop install supabase`
- **Qualquer OS (binário):** asset do OS/arch em <https://github.com/supabase/cli/releases/latest>, extrair e pôr no PATH.
- **Docker é OPCIONAL** — o `functions deploy` faz o bundle sem Docker (ignore o `WARNING: Docker is not running`).

Aproveite e confira se há MCP de browser disponível (pra rota automatizada das etapas de navegador existir de verdade).

### 0.4 Triagem de personalização (decide o que coletar)

Anuncie as 3 decisões de identidade que virão e faça AGORA só a primeira (ela muda a coleta de credenciais):

> "Mais pra frente você toma 3 decisões de identidade do agente. A primeira eu preciso saber já: **mensagens de VOZ**. Quando você pedir 'responde o fulano com um áudio', eu transformo texto em mensagem de voz (aquela bolinha de áudio, não um arquivo). Com que voz?"
> - **A minha voz, clonada (recomendado):** o áudio chega como se você tivesse gravado. Você grava 1-2 minutos falando natural e a ElevenLabs clona — precisa do plano pago de lá.
> - **Uma voz pronta do acervo** da ElevenLabs.
> - **Sem áudio por enquanto:** o agente só escreve. Dá pra ligar depois rodando só essa etapa.

Registre a intenção. Ela define se `ELEVENLABS_API_KEY` entra na coleta (seção 1) e se as etapas 2.3-2.5 e 8.1 rodam. As outras duas decisões (humanização e voice guide) são perguntadas na hora certa — NÃO pergunte agora.

---

## 1. Credenciais → `.env`

Colete em blocos, na ordem: Supabase → provider → OpenAI (→ ElevenLabs se a triagem pediu voz). Cada bloco é uma etapa de navegador (AskUserQuestion 3 rotas). Na rota automatizada, VOCÊ coleta os valores e o usuário só loga; na manual, dite exatamente onde clicar. Grave tudo no `.env` da raiz (gitignored) conforme chega e **valide cada credencial com chamada real** (`supabase projects list` com o PAT; `GET /me` da Z-API — deve responder o número conectado; chamada mínima da OpenAI; `GET /v1/user` da ElevenLabs).

Fala do bloco Supabase (inclui a frase de privacidade):

> "Primeiro a casa do agente: um projeto na Supabase, gratuito no plano inicial e criado NA SUA conta — suas conversas ficam guardadas lá e só você tem a chave. Essa etapa é no navegador. Quer que eu faça pra você?"

Fala do bloco do número (Z-API):

> "Agora o seu número. É aqui que entra a assinatura mensal que te avisei. Tem um passo que só você pode fazer: escanear um QR code com o SEU celular, igual conectar o WhatsApp Web. Quando o QR aparecer, aponta a câmera e me avisa."

> Se o QR ficar pendente (usuário sem o celular na mão), o setup CONTINUA — a conexão do número vira pendência explícita no cartão final (seção 9) e a prova de vida (seção 8) fica adiada.

Fala do bloco OpenAI:

> "Última chave por agora: uma da OpenAI. Ela serve pra UMA coisa — quando alguém te manda áudio, o agente transcreve pra texto. Custa centavos por áudio, na sua conta."

### Variáveis do `.env`

#### Caminho A — Z-API

```
SUPABASE_ACCESS_TOKEN=sbp_...        # PAT — Account → Access Tokens
SUPABASE_PROJECT_REF=...             # ref do projeto (ex: abcdwxyzab)
SUPABASE_SECRET_KEY=sb_secret_...    # Settings → API Keys (chave nova)
SUPABASE_SERVICE_ROLE_KEY=eyJ...     # service_role JWT (Settings → API Keys → Legacy) — Vault (cron interno)
SUPABASE_DB_PASSWORD=...             # senha do banco (pro db push)
ZAPI_INSTANCE_ID=...
ZAPI_TOKEN=...
ZAPI_CLIENT_TOKEN=...
OPENAI_API_KEY=sk-...
ELEVENLABS_API_KEY=...               # SÓ se a triagem 0.4 pediu voz
```

#### Caminho B — Evolution API

```
SUPABASE_ACCESS_TOKEN=sbp_...
SUPABASE_PROJECT_REF=...
SUPABASE_SECRET_KEY=sb_secret_...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
SUPABASE_DB_PASSWORD=...
EVO_BASE_URL=https://...             # sem barra final
EVO_INSTANCE=...
EVO_APIKEY=...
OPENAI_API_KEY=sk-...
ELEVENLABS_API_KEY=...               # SÓ se a triagem 0.4 pediu voz
```

Antes de rodar o CLI, exporte o token no ambiente:
- bash/zsh: `export SUPABASE_ACCESS_TOKEN=sbp_...`
- PowerShell: `$env:SUPABASE_ACCESS_TOKEN = 'sbp_...'`

---

## 2. Banco — a montagem silenciosa

Fala: *"Tenho tudo o que preciso. Agora é comigo — vou montar o banco, guardar as chaves no cofre e registrar o seu número. Uns 3 minutos, vou narrando cada passo."* Nenhuma pergunta ao usuário nesta seção (exceto 2.3+).

```bash
supabase link --project-ref <SUPABASE_PROJECT_REF>   # usa o PAT; pede a senha do banco
supabase db push                                      # aplica supabase/migrations/ em ordem
```

A `0001` habilita `pg_cron`/`pg_net` e cria `public.call_edge_function(path)`, que lê URL+service_role do **Vault** em runtime — nenhuma migration tem segredo hardcoded.

### 2.1 Popular o Vault (cron interno)

```bash
SQL="select vault.create_secret('https://<SUPABASE_PROJECT_REF>.supabase.co','project_url');
     select vault.create_secret('<SUPABASE_SERVICE_ROLE_KEY>','service_role_key');"
curl -s -X POST "https://api.supabase.com/v1/projects/<SUPABASE_PROJECT_REF>/database/query" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" \
  -d "{\"query\": \"$(echo "$SQL" | tr '\n' ' ')\"}"
```

> Em **re-setup** (secret já existe), troque `vault.create_secret(valor, nome)` por `vault.update_secret(id, valor)` — `select id, name from vault.secrets`. Vault vazio não quebra nada (jobs só emitem NOTICE).

### 2.2 Registrar a instância em `wa_instance`

#### Caminho A — Z-API

```bash
SQL="INSERT INTO wa_instance (provider, instance_id, auth_token, client_token, webhook_url, is_default, is_active)
     VALUES ('zapi', '<ZAPI_INSTANCE_ID>', '<ZAPI_TOKEN>', '<ZAPI_CLIENT_TOKEN>',
             'https://<SUPABASE_PROJECT_REF>.supabase.co/functions/v1/process-webhook',
             true, true);" # alias: coluna opcional para rótulo amigável
curl -s -X POST "https://api.supabase.com/v1/projects/<SUPABASE_PROJECT_REF>/database/query" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" \
  -d "{\"query\": \"$(echo "$SQL" | tr '\n' ' ')\"}"
```

> `base_url` fica `NULL` (Z-API constrói o endpoint a partir de `instance_id`/`auth_token`).

#### Caminho B — Evolution API

```bash
SQL="INSERT INTO wa_instance (provider, instance_id, base_url, auth_token, webhook_url, is_default, is_active)
     VALUES ('evolution', '<EVO_INSTANCE>', '<EVO_BASE_URL>', '<EVO_APIKEY>',
             'https://<SUPABASE_PROJECT_REF>.supabase.co/functions/v1/process-webhook',
             true, true);"
curl -s -X POST "https://api.supabase.com/v1/projects/<SUPABASE_PROJECT_REF>/database/query" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" \
  -d "{\"query\": \"$(echo "$SQL" | tr '\n' ' ')\"}"
```

> `client_token` fica `NULL` (Evolution autentica só pela `apikey` em `auth_token`).

### 2.3 Voz do agente (só se a triagem 0.4 pediu voz)

Se a triagem foi "sem áudio por enquanto", diga uma linha de skip consciente e pule pra 2.6: *"Sem ElevenLabs o agente não manda áudio; todo o resto funciona. Pra ligar depois: reabra esta pasta e diga 'quero configurar a voz'."*

Etapa de navegador ([Voice Lab](https://elevenlabs.io/app/voice-lab)):

- **Clonar a própria voz** (rota recomendada da triagem): *"Tem um passo que só você pode fazer: gravar a sua voz. Dica: 1-2 minutos falando naturalmente — conte como foi seu dia, em lugar silencioso, sem ler texto (leitura sai robótica e o clone herda). Pode até reaproveitar áudios de WhatsApp em que só você fala."* Voice Lab → *Add voice* → *Instant voice clone*.
- **Voz do acervo:** escolher e copiar o voice ID.

Grave o default da instância:

```bash
SQL="UPDATE wa_instance SET default_voice_id = '<VOICE_ID>' WHERE instance_id = '<INSTANCE_ID>';"
curl -s -X POST "https://api.supabase.com/v1/projects/<SUPABASE_PROJECT_REF>/database/query" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" \
  -d "{\"query\": \"$(echo "$SQL" | tr '\n' ' ')\"}"
```

> Precedência no `send_voice`: `profile` > `voice_id` do request > `default_voice_id` da instância > env `DEFAULT_VOICE_ID`. Modelo: **`eleven_turbo_v2_5`** (o multilingual v2 gera gagueira em clones).
>
> A **calibração de ouvido** (áudios A/B) NÃO acontece aqui — ela exige o `send_voice` no ar (secrets + deploy + webhook) e vive na seção **8.1**, depois do smoke test.

### 2.4 Perfis de voz do cliente (só se há voz — o catálogo nasce VAZIO)

A tabela `voice_profiles` (migration 0051) não vem com nenhum perfil. Crie os dois canônicos com a voz escolhida — são eles que o agente usa no dia a dia (`send_voice` com `profile`):

```bash
SQL="INSERT INTO voice_profiles (profile, voice_id, humanize, description) VALUES
     ('casual', '<VOICE_ID>', 'forte', 'DEFAULT — conversa em curso, tom dia a dia'),
     ('profissional', '<VOICE_ID>', 'leve', 'Lead novo, primeira abordagem, contexto B2B')
     ON CONFLICT (profile) DO UPDATE SET voice_id = EXCLUDED.voice_id;"
curl -s -X POST "https://api.supabase.com/v1/projects/<SUPABASE_PROJECT_REF>/database/query" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" \
  -d "{\"query\": \"$(echo "$SQL" | tr '\n' ' ')\"}"
```

> `stability/similarity_boost/style/speed` ficam NULL por enquanto (defaults da edge) — os valores finais saem da calibração de ouvido na 8.1, que atualiza os perfis. `humanize` define o NÍVEL de oralização por perfil; o liga/desliga global é a 2.5.

### 2.5 Humanização oral (escolha obrigatória quando há voz)

Os áudios podem sair com **oralização** — o texto é adaptado antes do TTS pra soar falado, não lido. Pergunte (AskUserQuestion):

> "Os seus áudios devem soar FALADOS ou LIDOS? Ninguém fala como escreve: 'está' vira 'tá', 'para' vira 'pra', 'implementar' vira 'implementá'. **Humanizado (padrão):** soa como gente conversando — recomendado pra WhatsApp. **Texto literal:** o áudio lê exatamente o que está escrito — tom 100% formal/corporativo. Quer ouvir os dois antes de decidir? Eu mando uma demonstração depois do teste de funcionamento."

- **Humanizado:** nada a fazer (`humanize_enabled` já nasce `true`).
- **Texto literal:**

```bash
SQL="UPDATE wa_instance SET humanize_enabled = false WHERE instance_id = '<INSTANCE_ID>';"
curl -s -X POST "https://api.supabase.com/v1/projects/<SUPABASE_PROJECT_REF>/database/query" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" \
  -d "{\"query\": \"$(echo "$SQL" | tr '\n' ' ')\"}"
```

- **Quer ouvir antes:** registre e rode a demo na 8.1 (par de áudios humanizado vs literal, em thread), aí grave a escolha.

> `humanize_enabled = false` força texto literal na instância inteira, sobrepondo o nível do perfil. Reversível com o mesmo UPDATE.

### 2.6 Voice guide — o jeito de ESCREVER (decisão obrigatória, com ou sem voz)

Separe os conceitos pro usuário: *"Até aqui cuidamos de como você SOA (áudio). Agora é como você ESCREVE."* Pergunte (AskUserQuestion):

> "Quando você pedir 'responde o João pra mim', eu redijo a mensagem EM SEU NOME. Sem um guia do seu estilo, o texto sai correto mas com cara de assistente genérico — e quem te conhece percebe. O **voice guide** é um documento com o seu jeito de escrever, que eu consulto antes de redigir. Três caminhos:"
> - **Montar agora (recomendado, ~10 min):** você cola 3-5 mensagens SUAS de WhatsApp e responde 6 perguntas rápidas — eu escrevo o guia e você aprova.
> - **Já tenho um documento de estilo:** cola aqui que eu adapto e instalo.
> - **Pular por enquanto:** as mensagens em seu nome saem em estilo genérico e eu aviso pra você revisar antes de enviar. Você monta depois com uma frase ('quero montar meu voice guide').

Esta é a ÚNICA decisão que o onboarding não deixa passar em silêncio — todo caminho termina com guide instalado OU pulo consciente registrado.

#### Rota "montar agora" (entrevista + amostras)

1. **Amostras reais primeiro:** *"Cola aqui de 3 a 5 mensagens que VOCÊ mandou recentemente (abre a conversa no WhatsApp, segura na mensagem, Copiar). Vale cliente, equipe, fornecedor — quanto mais variado melhor."* Se o número já está conectado (QR feito), alternativa melhor: ele manda as mensagens pra si mesmo no WhatsApp e você as lê direto do banco depois do smoke test.
2. **Entrevista curta, uma pergunta por vez** (salve um rascunho em arquivo local a cada resposta — proteção contra queda da sessão): (1) "vc" ou "você"? (2) Emoji: usa, pouco, nunca? (3) Como você costuma ABRIR uma conversa? (4) E FECHAR? (5) Alguma palavra ou expressão que você NUNCA usaria? (6) Alguém te pede desconto — o que você responde? (a reação a pedido/queixa revela o estilo real mais que vocabulário).
3. **Redija o guide** (markdown curto: abertura/fechamento típicos, registro, o que nunca usar, 2-3 exemplos reais anonimizados — as amostras mandam quando divergirem do que ele DISSE). Mostre e ajuste até ele aprovar. Teste: redija uma mensagem de exemplo no estilo e pergunte "soou como você?".
4. **Instale** (dollar-quoting obrigatório — o conteúdo é texto livre):

```bash
SQL="INSERT INTO voice_guide (content) VALUES (\$vg2026\$<MARKDOWN_DO_GUIDE>\$vg2026\$);"
curl -s -X POST "https://api.supabase.com/v1/projects/<SUPABASE_PROJECT_REF>/database/query" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" \
  -d "{\"query\": \"$(echo "$SQL" | tr '\n' ' ')\"}"
```

> `instance_id` NULL = global (o normal em instalação de 1 número). Verifique com `SELECT length(content) FROM voice_guide` e, após o deploy, com a tool `get_voice_guide` no smoke test. NUNCA instale um guide-placeholder genérico — sem guide de verdade, é melhor ficar `not_configured` (o agente sabe avisar) do que servir estilo falso como se fosse o dono. A calibração avançada (`voice_guide.checks`, regras pessoais do verificador) é evolução posterior — não faz parte do onboarding.

#### Rota "pular por enquanto" — registre o pulo consciente

```bash
SQL="UPDATE wa_instance SET voice_guide_skipped_at = now() WHERE instance_id = '<INSTANCE_ID>';"
curl -s -X POST "https://api.supabase.com/v1/projects/<SUPABASE_PROJECT_REF>/database/query" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" \
  -d "{\"query\": \"$(echo "$SQL" | tr '\n' ' ')\"}"
```

> A coluna (migration 0053) distingue "decidiu pular" de "nunca foi ofertado" — sessões futuras não reofertam como se fosse novidade (só relembram se ELE tocar no assunto). O pulo também entra como pendência no cartão final.

---

## 3. Secrets das edge functions

Fala: *"Reta final da infraestrutura, sem nada pra você fazer: gero a chave-mestra do servidor e subo todos os segredos pro cofre das functions."*

Gere um `MCP_API_KEY` aleatório (32+ chars) e configure tudo de uma vez:

### Caminho A — Z-API

```bash
supabase secrets set --project-ref <SUPABASE_PROJECT_REF> \
  MCP_API_KEY=<aleatorio> \
  ZAPI_INSTANCE_ID=... ZAPI_TOKEN=... ZAPI_CLIENT_TOKEN=... \
  OPENAI_API_KEY=sk-... \
  ELEVENLABS_API_KEY=... \
  INTERNAL_EDGE_JWT=<SUPABASE_SERVICE_ROLE_KEY>
```

### Caminho B — Evolution API

```bash
supabase secrets set --project-ref <SUPABASE_PROJECT_REF> \
  MCP_API_KEY=<aleatorio> \
  EVO_BASE_URL=... EVO_INSTANCE=... EVO_APIKEY=... \
  OPENAI_API_KEY=sk-... \
  ELEVENLABS_API_KEY=... \
  INTERNAL_EDGE_JWT=<SUPABASE_SERVICE_ROLE_KEY>
```

> `ELEVENLABS_API_KEY` só entra se foi coletada (triagem 0.4).
>
> O `SUPABASE_URL` e a `SUPABASE_SERVICE_ROLE_KEY` o Supabase **injeta automaticamente** nas functions — mas no formato novo (não-JWT), que o **Storage** e o gateway `verify_jwt` rejeitam. O `INTERNAL_EDGE_JWT` recebe o **service_role JWT legado** (`eyJ…`): é ele que as functions usam pra baixar áudio do Storage e pra chamadas edge→edge. Sem ele, download de mídia falha com `400`.

---

## 4. Edge functions

```bash
supabase functions deploy --project-ref <SUPABASE_PROJECT_REF>
```

`mcp-api` e `process-webhook` já estão com `verify_jwt = false` no `config.toml` (auth própria: `x-mcp-key` e `webhook_token`). As demais ficam `verify_jwt = true`.

Confirme: `supabase functions list --project-ref <ref>` — todas `ACTIVE`.

---

## 5. Webhook do provider de WhatsApp

Fala: *"Agora aponto o WhatsApp pro seu banco. Detalhe que muda tudo: além das mensagens RECEBIDAS, eu ligo a notificação das que VOCÊ envia — sem isso, o que você manda pelo celular fica invisível pro agente."*

### Caminho A — Z-API

```bash
HOOK="https://<SUPABASE_PROJECT_REF>.supabase.co/functions/v1/process-webhook"
ZBASE="https://api.z-api.io/instances/$ZAPI_INSTANCE_ID/token/$ZAPI_TOKEN"

# mensagens recebidas
curl -s -X PUT "$ZBASE/update-webhook-received" -H "Client-Token: $ZAPI_CLIENT_TOKEN" -H "Content-Type: application/json" -d "{\"value\":\"$HOOK\"}"
# status de entrega
curl -s -X PUT "$ZBASE/update-webhook-delivery" -H "Client-Token: $ZAPI_CLIENT_TOKEN" -H "Content-Type: application/json" -d "{\"value\":\"$HOOK\"}"
# ESSENCIAL: notificar as mensagens que VOCÊ envia (endpoint dedicado)
curl -s -X PUT "$ZBASE/update-notify-sent-by-me" -H "Client-Token: $ZAPI_CLIENT_TOKEN" -H "Content-Type: application/json" -d '{"notifySentByMe":true}'
```

Confirme em `GET $ZBASE/me` (header `Client-Token`): `receivedCallbackUrl`/`deliveryCallbackUrl` apontando pro `process-webhook` **e `receiveCallbackSentByMe: true`**.

### Caminho B — Evolution API

O `WEBHOOK_SECRET` deve ser o `webhook_token` da linha em `wa_instance` (2.2) — defina se ainda não há:

```bash
SQL="UPDATE wa_instance SET webhook_token = '<WEBHOOK_SECRET>' WHERE instance_id = '<EVO_INSTANCE>';"
curl -s -X POST "https://api.supabase.com/v1/projects/<SUPABASE_PROJECT_REF>/database/query" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" \
  -d "{\"query\": \"$(echo "$SQL" | tr '\n' ' ')\"}"
```

```bash
HOOK="https://<SUPABASE_PROJECT_REF>.supabase.co/functions/v1/process-webhook"
curl -s -X POST "$EVO_BASE_URL/webhook/set/$EVO_INSTANCE" \
  -H "apikey: $EVO_APIKEY" -H "Content-Type: application/json" \
  -d '{
    "webhook": {
      "enabled": true,
      "url": "'"$HOOK"'",
      "byEvents": false,
      "base64": false,
      "headers": { "authorization": "Bearer '"$WEBHOOK_SECRET"'", "Content-Type": "application/json" },
      "events": ["MESSAGES_UPSERT","MESSAGES_UPDATE","MESSAGES_DELETE","SEND_MESSAGE",
                 "CONNECTION_UPDATE","CONTACTS_UPDATE","GROUPS_UPSERT","GROUP_PARTICIPANTS_UPDATE"]
    }
  }'
```

Confirme com `GET $EVO_BASE_URL/webhook/find/$EVO_INSTANCE -H "apikey: $EVO_APIKEY"` (`webhook.url` certo, `enabled: true`). O header é validado quando `WEBHOOK_REQUIRE_AUTH=true` está nos secrets: `supabase secrets set --project-ref <REF> WEBHOOK_REQUIRE_AUTH=true`.

---

## 6. OAuth — credenciais do connector (chat do Claude)

Pra conectar pelo **chat do Claude Desktop/Web** (a UI de Connectors não aceita header custom), a `mcp-api` é o Authorization Server: auto-aprova o fluxo OAuth e protege o `/token` com um confidential client.

```bash
# OAUTH_CLIENT_ID = ex. wa-<16 chars>;  OAUTH_CLIENT_SECRET = >=40 chars aleatórios
supabase secrets set --project-ref <SUPABASE_PROJECT_REF> \
  OAUTH_CLIENT_ID=<gerado> OAUTH_CLIENT_SECRET=<gerado>
```

> Salve os dois no `.env` e **exiba-os ao usuário** — são o que ele cola nas *Advanced settings* do connector (cartão do passo 9). O `x-mcp-key` (Claude Code) vale em paralelo.

---

## 7. Conectar o MCP (operação)

Pergunte ONDE ele vai conversar com o agente no dia a dia:

**Claude Code** (inclui a aba Code do Desktop) — header key no `.mcp.json`:
```json
{ "mcpServers": { "whatsapp-agent": { "type": "http", "url": "https://<ref>.supabase.co/functions/v1/mcp-api", "headers": { "x-mcp-key": "${MCP_API_KEY}" } } } }
```

**Claude Desktop (chat) ou Claude Web** — OAuth, sem header:
1. Settings → Connectors → **Add custom connector**.
2. URL: `https://<SUPABASE_PROJECT_REF>.supabase.co/functions/v1/mcp-api`
3. **Advanced settings** → OAuth Client ID/Secret (passo 6).
4. Conectar → fluxo OAuth auto-aprovado → as 27 tools aparecem.

> Se o dia a dia dele vai ser no chat/celular, a prova final da seção 8 deve rodar POR ESSA conexão — não só pelo header no Claude Code.

---

## 8. Prova de vida (nunca declare pronto sem isso)

1. **Status real:** tool `status` via mcp-api — conexão do provider + contagem de mensagens. Por HTTP:

```bash
curl -s -X POST "https://<ref>.supabase.co/functions/v1/mcp-api" \
  -H "x-mcp-key: <MCP_API_KEY>" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"status","arguments":{}}}'
```

2. **Prova participativa** (o momento que convence o usuário): *"Pega o seu celular e manda um 'oi' pra qualquer conversa, agora. Me avisa quando enviar."* Leia a mensagem de volta (tool `read`) e mostre: *"Recebi do outro lado: 'oi', enviado às 14:32 pra Maria. O agente está oficialmente vendo o seu WhatsApp."* Isso prova o webhook inbound E o notify-sent-by-me com tráfego real. Falhou = diagnosticar AQUI, antes de qualquer coisa.
3. **Voice guide instalado?** Chame `get_voice_guide` e confirme que o markdown volta (`configured: true`).

### 8.1 Calibração da voz de ouvido (só se há voz; clonada = obrigatória, acervo = 1 áudio de conferência)

Só agora o `send_voice` existe de ponta a ponta. Fala: *"Última etapa da voz, a mais divertida: calibrar de OUVIDO, não por número. Vou mandar áudios de teste no seu próprio WhatsApp — o mesmo texto com ajustes diferentes. Embaixo de CADA áudio vai uma resposta em thread dizendo qual versão é, pra você não se perder. Ouve com fone e me diz qual soou mais você."*

Protocolo (aprendizado de campo, 12/07/2026):

- Pra voz CLONADA, `similarity_boost` alto (**0.90+**) é o que segura o timbre — com ele alto, dá pra subir `style` (0.70-0.80) e baixar `stability` (0.25-0.35) sem a voz desgarrar. Os defaults da edge (0.45/0.75/0.30/0.95) são conservadores: com similarity 0.75, style alto distorce o clone.
- Mande 2-3 variações (ex.: expressiva `0.25/0.90/0.80/1.0`, neutra `0.45/0.90/0.30/0.95`) via `send_voice` com `voice_id` explícito + settings manuais, **cada áudio seguido de uma mensagem em RESPOSTA (reply_to) com a config** — nunca legenda numerada separada (áudios chegam fora de ordem).
- Esconda os números do usuário na conversa (ele escolhe "a mais expressiva", não "a 0.25") — os números vão só na thread de identificação.
- Se a 2.5 ficou de demo: mande também o par humanizado vs literal (mesmo texto) e grave a escolha.
- Itere até o "soou como eu". Grave o resultado nos PERFIS (não só na conversa):

```bash
SQL="UPDATE voice_profiles SET stability = <stab>, similarity_boost = <sim>, style = <style>, speed = <speed>, updated_at = now() WHERE profile IN ('casual', 'profissional');"
curl -s -X POST "https://api.supabase.com/v1/projects/<SUPABASE_PROJECT_REF>/database/query" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" \
  -d "{\"query\": \"$(echo "$SQL" | tr '\n' ' ')\"}"
```

---

## 9. Entrega final — cartão de conexão + escolhas

Antes de montar o cartão, **confira o estado no BANCO** (o resumo espelha o banco, não a memória da conversa):

```bash
SQL="SELECT default_voice_id, humanize_enabled, voice_guide_skipped_at FROM wa_instance;
     SELECT profile, voice_id, humanize FROM voice_profiles;
     SELECT length(content) AS guide_chars FROM voice_guide;"
```

Entregue o cartão e deixe claro que serve pra **qualquer app de IA com suporte a MCP**:

```
╔══ WhatsApp Agent · servidor MCP ══════════════════════════════╗

  Servidor (URL):
    https://<SUPABASE_PROJECT_REF>.supabase.co/functions/v1/mcp-api

  ▸ Apps de chat (Claude Desktop, Claude Web e outros clientes MCP):
        OAuth Client ID:     <OAUTH_CLIENT_ID>
        OAuth Client Secret: <OAUTH_CLIENT_SECRET>

  ▸ Apps que aceitam header custom (Claude Code, etc.):
        header  x-mcp-key: <MCP_API_KEY>

  ── Personalização ──────────────────────────────────────────────
  Voz em áudio:   [clonada/acervo · calibrada hoje | não configurada]
  Humanização:    [humanizado (padrão) | texto literal]
  Voice guide:    [instalado (X chars) | pulado conscientemente]

  ────────────────────────────────────────────────────────────────
  WhatsApp Agent · um produto Expert Integrado
  Mentoria Automações Inteligentes de Eric Luciano
  expertintegrado.com.br

╚════════════════════════════════════════════════════════════════╝
```

Feche com o mapa do "mudar depois" — cada escolha com o alcance certo:

> Pronto. Guarde o **Client Secret** num gerenciador de senhas — ele é a chave da sua conta. Pra mudar qualquer escolha depois: o **voice guide** você atualiza de qualquer app conectado (me pede que eu regravo); **voz e humanização** exigem reabrir esta pasta e pedir a etapa ("quero recalibrar a voz" / "quero mudar a humanização"). O perfil de cada contato (como você trata cada pessoa) o agente aprende por rotinas que rodam COM esta pasta aberta — não é automático na nuvem.

Liste as pendências explícitas (ex.: QR não escaneado, voz adiada, guide pulado, prova final não rodada no app de uso real).