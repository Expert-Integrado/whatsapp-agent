# Design — Suporte multi-provider de WhatsApp (Z-API + Evolution API)

**Data:** 2026-06-26
**Status:** Aprovado para implementação (pendente revisão final do spec)
**Autor:** Asafe Silva + Claude

---

## Contexto

O WhatsApp Agent hoje é 100% acoplado à **Z-API** (API hospedada, paga). A **Evolution API** é uma
alternativa **gratuita e self-hosted** (Docker/VPS, baseada em Baileys). O objetivo é tornar o
projeto **multi-provider**, de forma que **cada instância** (número) escolha seu provider — `zapi`
ou `evolution` — e que qualquer pessoa que clone o repositório possa optar por Evolution no setup.

### Decisões de produto (já fechadas com o usuário)

1. **Coexistência por instância** — não substituir Z-API; cada instância tem seu provider. Aproveita
   a arquitetura multi-instância existente (`instance_id` como chave de escopo em todas as tabelas).
2. **Paridade completa** — receber/enviar texto, mídia (imagem/áudio/vídeo/documento/sticker), voz
   (TTS), grupos, menções, reply, reações, status de entrega, edição e exclusão.
3. **Neutralização total** — o Z-API deixa de "ser dono" do schema/código e vira **um adapter entre
   iguais** atrás de uma interface neutra. Renomeações de tabela/função incluídas.
4. **Genérico** — o setup oferece a escolha do provider; serve para qualquer clone do repo.

### Fonte de verdade da Evolution

- **Postman oficial v2.3** (`Evolution API - v2.3.*`) — endpoints, headers (`apikey`), corpos de envio,
  reação, edição, delete, grupos, `getBase64FromMediaMessage`, `webhook/set`.
- **Payload de webhook real capturado** (fluxo n8n do usuário, usado **apenas** como referência de
  estrutura de dados — não copiamos a implementação n8n).

Versão-alvo: **Evolution API v2.3.x** (compatível com a família 2.x).

---

## Diferenças entre os providers (resumo de referência)

| Aspecto | Z-API (atual) | Evolution API (novo) |
|---|---|---|
| Hosting | `https://api.z-api.io` (fixo) | self-hosted — `base_url` por instância |
| Auth API | URL `/token/{token}/` + header `Client-Token` | header `apikey` |
| URL envio | `.../instances/{id}/token/{tk}/send-text` | `{base}/message/sendText/{instance}` |
| Destinatário | `phone` | `number` (dígitos do JID) |
| Reply | `messageId` | `quoted: { key:{id}, message:{conversation} }` |
| Menções | array `mentioned` + tokens `@<num>` no texto; "todos" expandido manualmente | `mentioned: []` + `mentionsEveryOne: true` (nativo) |
| Webhook | objeto **plano**: `{type, phone, text:{message}, image:{imageUrl}…}` | aninhado: `{event, instance, server_url, apikey, data:{key:{remoteJid, remoteJidAlt, fromMe, id, participant, addressingMode}, pushName, message:{...}, messageType, messageTimestamp}}` |
| LID | só `@lid` → resolução em 3 camadas (cache → nome → API) | `remoteJidAlt` traz o número real direto |
| Mídia recebida | **URL** (`imageUrl`) → download | `POST /chat/getBase64FromMediaMessage/{instance}` → `{base64,mimetype,fileName}` |
| Reação | `send-reaction {phone,messageId,reaction}` | `POST /message/sendReaction/{instance} {key:{remoteJid,fromMe,id}, reaction}` |
| Edição | `send-text {editMessageId}` | `POST /chat/updateMessage/{instance} {number,key,text}` |
| Delete | `delete-message {phone,messageId,owner}` | `DELETE /chat/deleteMessageForEveryone/{instance} {id,remoteJid,fromMe,participant?}` |
| Status conexão | action `status` → `connected/smartphoneConnected` | `GET /instance/connectionState/{instance}` → `{instance:{state:"open"}}` |
| Grupos | action `chats` (filtra isGroup) | `GET /group/fetchAllGroups/{instance}?getParticipants=` |
| Marcar lido | `read-chat`/`read-message` | `POST /chat/markMessageAsRead {readMessages:[{remoteJid,fromMe,id}]}` |
| Bloquear | `block-contact {phone,action}` | `POST /message/updateBlockStatus {number,status:"block\|unblock"}` |
| Delay humano | `delayTyping`/`delayMessage` (1-15s) | `delay` (ms) + `chat/sendPresence` |

---

## Arquitetura

Núcleo neutro + adapters. As edge functions deixam de conhecer "Z-API"/"Evolution" — falam com a
interface `WaProvider`, e cada provider traduz entre o **modelo de domínio neutro** e a sua API.

```
                        ┌─────────────────────────────────────────┐
  webhook (zapi|evo) ─► │ process-webhook (orquestrador)          │
                        │   matchesWebhook → resolve instância    │──► handlers existentes
                        │   verifyWebhookAuth → normalizeInbound  │    (handleReceived/Status/…)
                        └─────────────────────────────────────────┘        │ upsert chats/messages/media
  MCP ─► send-message / send-voice / wa-proxy / mcp-api                     ▼
                        │   resolve instância → getProvider()     │     Supabase (DB + Storage)
                        │   buildSend / buildAction / fetchMedia  │
                        └──────────────┬──────────────────────────┘
                                       ▼
                       ┌──────────────┐   ┌───────────────────┐
                       │ ZapiProvider │   │ EvolutionProvider │  (únicos que sabem URLs/payloads)
                       └──────────────┘   └───────────────────┘
```

**Princípio de isolamento:** só os adapters conhecem URLs, headers e formatos de payload. Tudo acima
deles opera no modelo neutro. Trocar/adicionar provider = escrever um adapter + uma linha no factory.

### Módulo `_shared/wa/`

```
supabase/functions/_shared/wa/
  types.ts        # modelo de domínio neutro
  provider.ts     # interface WaProvider + getProvider() factory
  zapi.ts         # adapter Z-API (lógica atual migrada pra cá)
  evolution.ts    # adapter Evolution (novo)
  jid.ts          # helpers de JID/phone (Evolution) e normalização de chat_id
  index.ts        # re-exports
  __tests__/
    zapi.test.ts          # golden tests (capturados ANTES do refactor)
    evolution.test.ts     # fixtures reais (webhook + envios)
    fixtures/             # payloads .json reais dos dois providers
```

### Modelo de domínio neutro (`types.ts`)

```ts
type ProviderId = "zapi" | "evolution";

interface InstanceCreds {
  provider: ProviderId;
  instance_id: string;       // Z-API: instance id | Evolution: nome da instância
  base_url: string | null;   // Evolution: URL do servidor | Z-API: null (host fixo)
  auth_token: string;        // Z-API: token | Evolution: apikey
  client_token: string | null; // só Z-API
  alias: string | null;
}

// Evento de entrada normalizado — união discriminada
type InboundEvent =
  | { kind: "message"; chatId: string; chatName: string|null; isGroup: boolean;
      fromMe: boolean; senderPhone: string|null; senderName: string|null;
      providerMsgId: string; messageType: MsgType; content: string|null;
      caption: string|null; quotedProviderId: string|null; isForwarded: boolean;
      timestamp: string; media: MediaRef|null; raw: unknown }
  | { kind: "status"; providerMsgIds: string[]; status: SendStatus }
  | { kind: "reaction"; chatId: string; targetProviderMsgId: string;
      reactorPhone: string|null; reactorName: string|null; emoji: string|null;
      fromMe: boolean; timestamp: string; raw: unknown }
  | { kind: "edit"; providerMsgId: string; newContent: string|null }
  | { kind: "revoke"; providerMsgId: string }
  | { kind: "group_participant"; chatId: string; action: "add"|"remove"|"promote"|"demote"; phones: string[] }
  | { kind: "connection"; connected: boolean };

// MediaRef carrega o que o adapter precisa pra materializar a mídia depois:
//  - Z-API: { strategy:"url", url, mime, bucket, ext, ... }
//  - Evolution: { strategy:"fetch", providerMsgId, mime, bucket, ext, ... }
interface MediaRef { strategy: "url"|"fetch"; bucket: string; ext: string;
  mime: string|null; url?: string; providerMsgId?: string;
  duration?: number; width?: number; height?: number; thumbUrl?: string; fileName?: string }

interface OutboundMessage { chatId: string; phone: string; type: MsgType;
  content?: string; media?: { url?: string; bytes?: Uint8Array; mime?: string; fileName?: string };
  caption?: string; quotedProviderId?: string|null; mentions?: string[];
  mentionsEveryone?: boolean; isGroup?: boolean; delayTyping?: number; delayMessage?: number }

interface SendResult { providerMsgId: string }
interface MediaPayload { bytes: Uint8Array; mime: string; fileName?: string }
interface BuiltRequest { url: string; method: "GET"|"POST"|"DELETE"; headers: Record<string,string>; body?: string }
interface NeutralGroup { chatId: string; name: string|null; participantCount?: number }
```

### Interface `WaProvider` (`provider.ts`)

```ts
interface WaProvider {
  readonly id: ProviderId;

  // ── entrada ──
  matchesWebhook(raw: any): boolean;                    // detecção: zapi tem `type`; evo tem `event`
  webhookInstanceKey(raw: any): string | null;          // zapi: instanceId; evo: instance (nome)
  verifyWebhookAuth(raw: any, headers: Headers, creds: InstanceCreds|null): boolean;
  normalizeInbound(raw: any, creds: InstanceCreds): Promise<InboundEvent[]>; // 1 webhook → N eventos
  fetchMedia(creds: InstanceCreds, ref: MediaRef): Promise<MediaPayload>;     // evo: getBase64; zapi: GET url

  // ── saída ──
  buildSend(creds: InstanceCreds, msg: OutboundMessage): Promise<BuiltRequest>;
  parseSendResult(json: any): SendResult;

  // ── ações / consultas ──
  buildAction(creds: InstanceCreds, action: WaAction, params: any): BuiltRequest | null;
  parseConnection(json: any): { connected: boolean; phone?: string };
  fetchGroups(creds: InstanceCreds): Promise<NeutralGroup[]>;
}

function getProvider(id: ProviderId): WaProvider; // factory; default 'zapi'
```

`buildSend`/`normalizeInbound`/`fetchMedia` são `async` porque o adapter Z-API pode precisar de I/O
(resolução de LID, expansão de @todos via group-metadata). O adapter Evolution geralmente é síncrono
internamente, mas respeita a mesma assinatura.

`WaAction` é o conjunto neutro de ações (espelha o allowlist do antigo zapi-proxy): `status`, `chats`,
`get-contact-info`, `read-chat`, `read-message`, `send-reaction`, `send-text`, `send-poll`, `forward`,
`delete-message`, `block-contact`, `create-group`, `add-participant`, `remove-participant`,
`add-admin`, `remove-admin`. Cada adapter mapeia para seus endpoints; ações sem equivalente retornam
`null` (o caller responde `not_supported_by_provider`).

---

## Schema — migration de neutralização

Nova migration `supabase/migrations/0030_provider_neutralization.sql` (idempotente — segura de rodar
mais de uma vez):

1. **Rename preservando dados** (`ALTER TABLE ... RENAME`, não drop/recreate):
   - `zapi_instance` → `wa_instance`
   - `zapi_action_log` → `wa_action_log`
   - Triggers/índices/constraints associados acompanham o rename.
2. **`wa_instance`** ganha colunas:
   - `provider TEXT NOT NULL DEFAULT 'zapi' CHECK (provider IN ('zapi','evolution'))`
   - `base_url TEXT` (Evolution: URL do servidor; Z-API: `NULL`)
   - Renomeia `token` → `auth_token` (apikey na Evolution; token na Z-API).
   - `client_token` passa a `NULL`-able (só Z-API usa).
   - `instance_id` mantém semântica de chave única: id Z-API **ou** nome da instância Evolution.
3. **Backfill**: linhas existentes assumem `provider='zapi'` pelo default. Sem quebra de dados.
4. **VIEWs de compatibilidade (shim de depreciação — 1 versão):**
   - `CREATE VIEW zapi_instance AS SELECT *, auth_token AS token FROM wa_instance`
   - `CREATE VIEW zapi_action_log AS SELECT * FROM wa_action_log`
   - Protegem a *janela de upgrade parcial* (quem rodar `db push` antes de `functions deploy`).
     Views simples são auto-atualizáveis no Postgres, então código antigo que ainda escreva no nome
     velho continua funcionando durante a transição.
   - Removidas numa migration futura (`0031` numa versão seguinte), após o período de depreciação.
5. **Demais tabelas não mudam** (`chats`, `messages`, `message_media`, `lid_mapping`, etc.) —
   `instance_id` já é a chave de escopo agnóstica. `lid_mapping` continua, mas só será populada pelo
   adapter Z-API.

> Código que referencia `zapi_instance`/`zapi_action_log`/`token`/`client_token` em **todas** as
> edge functions é atualizado para os novos nomes/colunas na mesma PR. As views são apenas rede de
> segurança para a janela de upgrade — o código novo já fala os nomes neutros.

---

## Refactor das edge functions

### `process-webhook` → orquestrador agnóstico
- Detecta provider via `matchesWebhook` (Z-API tem `type`; Evolution tem `event`).
- `webhookInstanceKey` → resolve a linha `wa_instance` (cache em memória do isolate, como hoje).
- `verifyWebhookAuth` por provider (Z-API: header `z-api-token` + TOFU; Evolution: header de auth
  configurado no `webhook/set`, comparado ao segredo salvo).
- `normalizeInbound(raw, creds)` → `InboundEvent[]`.
- Itera os eventos e despacha para os handlers **existentes**, que passam a consumir o tipo neutro:
  `handleReceived` ⇐ `kind:"message"`, `handleStatus` ⇐ `"status"`, `handleReaction` ⇐ `"reaction"`,
  `handleEdited` ⇐ `"edit"`, `handleRevoked` ⇐ `"revoke"`, `handleGroupNotif` ⇐ `"group_participant"`,
  `handleConnection` ⇐ `"connection"`.
- Resolução de `@lid` em 3 camadas **migra para dentro do adapter Z-API** (não roda para Evolution).
- `webhook_events_raw` continua gravando o payload bruto **antes** de normalizar (auditoria/replay).
- Download de mídia: `handleReceived` chama `provider.fetchMedia(creds, mediaRef)` e grava os bytes no
  Storage. Z-API materializa via download de URL; Evolution via `getBase64FromMediaMessage` (com retry).

### `send-message` / `send-voice`
- Substituem o `switch` de URL/body por `provider.buildSend(creds, outboundMsg)` + `parseSendResult`.
- Voz: Evolution `sendWhatsAppAudio` aceita URL → mandamos a signed URL do Storage (como hoje na Z-API).
- "@todos": detalhe do adapter — Z-API expande via `group-metadata`; Evolution usa `mentionsEveryOne`.
- Rate limit, idempotência (`agent_request_id`), `confirmed=true`, audit: **inalterados** (agnósticos).

### `zapi-proxy` → `wa-proxy` (renomear, sem alias)
- Mantém allowlist + segurança (confirmed, idempotência, rate limit, audit em `wa_action_log`).
- A montagem da chamada vem de `provider.buildAction(creds, action, params)`.
- Ações sem equivalente no provider → `400 not_supported_by_provider` (logado).
- `mcp-api` é atualizado para chamar `wa-proxy`. `supabase/config.toml` e o deploy refletem o novo nome.

### `mcp-api`
- `status` usa `provider.parseConnection`.
- `sync_groups` usa `provider.fetchGroups`.
- `send`/`react`/`edit`/`delete`/`voice` já delegam a `send-message`/`send-voice`/`wa-proxy` →
  ficam provider-aware automaticamente.
- Cache de instâncias inclui `provider`.

### Funções de mídia (`transcribe-queue`, `retry-media`)
- Hoje baixam de `message_media.original_url`. Na Evolution **não há URL durável** → ao gravar a mídia,
  `original_url` fica `NULL` e os bytes já vão pro Storage no `process-webhook`.
- Ajuste: quando `original_url` for `NULL`, essas funções leem o arquivo direto do **Storage** (signed
  URL pelo `storage_bucket`/`storage_path`) em vez de tentar `fetch(original_url)`. Para Z-API nada muda.

### Não mudam
`_shared/rate-limit.ts`, `cleanup-media`, `sync-google-contacts` — já agnósticos.

---

## Evolution adapter — especificidades

- **Auth/base:** header `apikey: {auth_token}`; base `{base_url}`; `number` = dígitos do JID
  (`remoteJid.split("@")[0]`, usando `remoteJidAlt` quando `addressingMode==="lid"`).
- **Envio:**
  - texto → `POST /message/sendText/{inst}` `{number,text,delay?,quoted?,mentioned?,mentionsEveryOne?}`
  - imagem/vídeo/documento → `POST /message/sendMedia/{inst}` `{number,mediatype,mimetype,media(url|base64),caption?,fileName?}`
  - áudio/ptt → `POST /message/sendWhatsAppAudio/{inst}` `{number,audio(url|base64),delay?}`
  - sticker → `POST /message/sendSticker/{inst}`
  - reação → `POST /message/sendReaction/{inst}` `{key:{remoteJid,fromMe,id},reaction}`
  - reply → campo `quoted:{key:{id}}` no corpo do send
- **Ações:** edit `POST /chat/updateMessage`; delete `DELETE /chat/deleteMessageForEveryone`; bloquear
  `POST /message/updateBlockStatus`; ler `POST /chat/markMessageAsRead`; grupos `POST /group/create`,
  `POST /group/updateParticipant?groupJid=` (`action: add|remove|promote|demote`); conexão
  `GET /instance/connectionState`; grupos `GET /group/fetchAllGroups`.
- **Entrada (`normalizeInbound`):** lê `data.key/message/messageType/pushName`; desembrulha
  `ephemeralMessage.message.*`; deriva `chatId` (1:1 `@s.whatsapp.net`, grupo `@g.us`, usa `remoteJidAlt`
  para `@lid`); mapeia tipos: `conversation`/`extendedTextMessage`→text, `imageMessage`,
  `audioMessage`(ptt), `videoMessage`, `documentMessage`, `stickerMessage`, `locationMessage`,
  `contactMessage`, `reactionMessage`→reaction; `messages.update` → status/ack; `connection.update` →
  connection; `group-participants.update` → group_participant.
- **Mídia (`fetchMedia`):** `POST /chat/getBase64FromMediaMessage/{inst}` `{message:{key:{id}},convertToMp4:false}`
  com retry (≈3x); resposta `{base64,mimetype,fileName}` → decodifica base64 → grava bytes no Storage.

---

## Z-API adapter — migração

- Move a lógica atual de `send-message` (switch de endpoints) e de `process-webhook` (parse do payload
  plano, `extractMediaInfo`, resolução de `@lid` em 3 camadas, expansão de @todos) para `zapi.ts`,
  **preservando comportamento** (sem alterar a API externa).
- Mídia: `fetchMedia` faz `GET` da `imageUrl/audioUrl/...` (download de URL, como hoje).
- `parseSendResult`: `messageId ?? id`.

---

## Identidade & roteamento de webhook

- Um único endpoint `process-webhook` atende os dois providers. O provider é detectado pelo **shape**:
  Z-API → presença de `type`; Evolution → presença de `event` (`messages.upsert`, etc.).
- A instância é resolvida por `webhookInstanceKey` (Z-API: `instanceId`; Evolution: `instance`),
  buscando em `wa_instance` (que carrega `provider`, então a detecção por shape é confirmada pela linha).
- Auth: Z-API mantém `z-api-token` + TOFU; Evolution valida o header de auth configurado no
  `webhook/set` (`headers.authorization` ou equivalente) contra o segredo salvo na instância.

---

## Setup skill (`.claude/skills/setup/SKILL.md`)

- Passo inicial passa a **perguntar o provider** (`zapi` | `evolution`).
- **Registro da instância** (hoje implícito) vira passo explícito: `INSERT INTO wa_instance(...)`
  com `provider`, `base_url` (Evolution), `auth_token`, `client_token` (Z-API), `alias`, `is_default`.
- **Caminho Evolution:** pré-requisito = servidor Evolution rodando (https público) + apikey. Configura
  o webhook via `POST {base}/webhook/set/{instance}` com `byEvents:false`, `base64:false`, header de
  auth, e eventos `[MESSAGES_UPSERT, MESSAGES_UPDATE, MESSAGES_DELETE, SEND_MESSAGE, CONNECTION_UPDATE,
  CONTACTS_UPDATE, GROUPS_UPSERT, GROUP_PARTICIPANTS_UPDATE]`. Documenta que é self-hosted (link ao
  docker-compose oficial), sem detalhar o provisionamento.
- **Caminho Z-API:** permanece como hoje (atualizado só para os novos nomes de tabela).

---

## Estratégia de testes

- **Unit nos adapters (Deno test)** com **fixtures reais** em `__tests__/fixtures/`:
  - Evolution: `normalizeInbound` sobre o `messages.upsert` capturado (texto, mídia, grupo, reação,
    `@lid`); `buildSend`/`buildAction` por tipo, comparando o corpo gerado ao do Postman v2.3.
  - Z-API: **golden tests capturados ANTES do refactor** — congela o comportamento atual de
    `normalizeInbound`/`buildSend` para garantir zero regressão na migração.
- **Smoke e2e manual** no fim (ver Verificação).

---

## Upgrade de instalações existentes

O projeto já tem usuários com deployments próprios (cada um no seu Supabase). Esta versão é um
**breaking change interno** (rename de tabelas/função), mas o upgrade é **automático e
preserva 100% dos dados** — quem já usa continua no Z-API sem reconfigurar nada; Evolution é opt-in.

**Procedimento de upgrade (documentado em `MIGRATION.md`):**
1. `git pull` (traz `0030` + código novo).
2. `supabase db push` — aplica o rename + colunas + views de compat (dados preservados; instâncias
   existentes recebem `provider='zapi'`).
3. `supabase functions deploy` — sobe as edge functions novas (incluindo `wa-proxy`).
4. (opcional) remover a função antiga: `supabase functions delete zapi-proxy`.
5. **Verificação:** query `SELECT count(*), provider FROM wa_instance GROUP BY provider;` — deve
   listar as instâncias antigas como `zapi`. Smoke test da tool `status`.

**Garantias:**
- `ALTER TABLE RENAME` preserva linhas, FKs e índices — nada de chats/mensagens é perdido.
- `provider` default `'zapi'` ⇒ instâncias existentes seguem funcionando sem mudança.
- VIEWs de compat cobrem a janela entre `db push` e `functions deploy` (atualização fora de ordem
  não quebra).
- Versão marcada no `CHANGELOG.md` (ex. **v3.0**) com nota explícita: "upgrade via db push + deploy;
  Z-API segue funcionando; Evolution é opcional".

**Depreciação:** as VIEWs `zapi_instance`/`zapi_action_log` são removidas numa versão futura, após
o período de depreciação anunciado no CHANGELOG.

---

## Inventário de arquivos

**Criar**
- `supabase/migrations/0030_provider_neutralization.sql`
- `supabase/functions/_shared/wa/{types,provider,zapi,evolution,jid,index}.ts`
- `supabase/functions/_shared/wa/__tests__/{zapi,evolution}.test.ts` + `fixtures/`
- `supabase/functions/wa-proxy/index.ts` (novo nome; substitui `zapi-proxy`)

**Modificar**
- `supabase/functions/process-webhook/index.ts`
- `supabase/functions/send-message/index.ts`
- `supabase/functions/send-voice/index.ts`
- `supabase/functions/mcp-api/index.ts` (status, sync_groups, chamar `wa-proxy`, cache com provider)
- `supabase/functions/transcribe-queue/index.ts`, `retry-media/index.ts` (fallback Storage quando `original_url` nulo)
- `supabase/config.toml` (entrada `wa-proxy`)
- `.claude/skills/setup/SKILL.md`
- `README.md`, `CHANGELOG.md`, `MIGRATION.md`

**Remover**
- `supabase/functions/zapi-proxy/` (substituído por `wa-proxy`)

---

## Verificação (end-to-end)

1. **Testes de adapter** verdes (`deno test`), incluindo golden do Z-API.
2. **Migration** aplicada (`supabase db push`): `wa_instance`/`wa_action_log` existem, `provider`/`base_url`
   presentes, linhas antigas em `provider='zapi'`.
3. **Não-regressão Z-API**: na instância Z-API existente — `status`, enviar texto/mídia, receber,
   reagir, editar, deletar — comportamento idêntico ao anterior.
4. **Registrar instância Evolution** real do usuário; configurar webhook via `webhook/set`.
5. **Receber (Evolution)**: enviar texto, imagem e áudio para o número; conferir `webhook_events_raw`
   (bruto) e `messages`/`message_media` (normalizado + bytes no Storage).
6. **Enviar (Evolution)**: via MCP `send` (texto, imagem, documento, reply, menção, @todos) e
   `send-voice`; confirmar entrega e `provider_msg_id` populado (`send_status='sent'`).
7. **Ações (Evolution)**: `react`, `sync_groups`, `status`.
8. **Idempotência/rate limit**: replay com mesmo `agent_request_id` e estouro de limite por chat —
   comportamento idêntico ao Z-API (lógica agnóstica).

---

## Fora de escopo (YAGNI)

- Provisionamento automatizado do servidor Evolution (é pré-requisito do usuário).
- Tipos de mensagem que o app ainda não modela (botões, listas, enquetes avançadas) além do que já
  existe — mantém-se a paridade com o conjunto atual de tipos.
- Migração de dados entre providers (cada instância nasce em um provider).
