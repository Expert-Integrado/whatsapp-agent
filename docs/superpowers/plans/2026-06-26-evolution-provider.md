# Suporte multi-provider de WhatsApp (Z-API + Evolution API) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tornar o backend multi-provider — cada instância de WhatsApp escolhe `zapi` ou `evolution` — atrás de uma interface neutra `WaProvider`, com paridade completa e zero regressão para usuários Z-API existentes.

**Architecture:** Núcleo neutro + adapters. Um módulo `_shared/wa/` define o modelo de domínio neutro (`InboundEvent`, `OutboundMessage`, `InstanceCreds`…) e a interface `WaProvider`. Z-API e Evolution são adapters iguais; só eles conhecem URLs e formatos de payload. As edge functions (`process-webhook`, `send-message`, `send-voice`, `wa-proxy`, `mcp-api`) viram orquestradoras agnósticas que resolvem a instância → `getProvider(creds.provider)` → operam no modelo neutro.

**Tech Stack:** Supabase Edge Functions (Deno + TypeScript), Postgres (migrations SQL), `@supabase/supabase-js@2`, `deno test` (BDD `Deno.test` + `jsr:@std/assert`).

## Global Constraints

- **Runtime:** Deno (edge functions). Imports via `npm:`/`jsr:`/`https:` — sem `package.json`.
- **Provider IDs:** exatamente `"zapi"` | `"evolution"` (string literal; CHECK no banco).
- **Versão-alvo Evolution:** v2.3.x (família 2.x). Endpoints/payloads conforme Postman v2.3.
- **Auth Evolution:** header `apikey: {auth_token}`; base `{base_url}`; destinatário `number` (dígitos do JID).
- **Auth Z-API:** URL `/instances/{instance_id}/token/{auth_token}/...` + header `Client-Token: {client_token}`.
- **Credenciais nunca no código nem em env vars** — vivem na tabela `wa_instance`, lidas só dentro das edge functions.
- **Tabela de instâncias:** `wa_instance` (era `zapi_instance`); log de ações: `wa_action_log` (era `zapi_action_log`). Coluna de credencial principal: `auth_token` (era `token`).
- **Zero regressão Z-API:** comportamento externo das functions inalterado para `provider='zapi'`. Golden tests capturam o comportamento atual ANTES de refatorar.
- **chat_id interno:** mantém a convenção atual (dígitos puros p/ 1:1; `@g.us`/`-group` p/ grupos; `@lid` só se irresolúvel). O adapter normaliza o JID para essa convenção.
- **Mídia Evolution:** buscada via `POST /chat/getBase64FromMediaMessage/{instance}` (com retry), nunca via `base64:true` no webhook.
- **TDD:** todo código novo puro nasce de um teste que falha. Commits frequentes (1 por task no mínimo).
- **Idempotência de migration:** `0030` segura de rodar mais de uma vez (`IF EXISTS`/`IF NOT EXISTS`).

---

## File Structure

**Criar:**
- `supabase/functions/_shared/wa/types.ts` — modelo de domínio neutro (tipos puros).
- `supabase/functions/_shared/wa/jid.ts` — helpers JID↔phone e normalização de chat_id.
- `supabase/functions/_shared/wa/provider.ts` — interface `WaProvider` + `getProvider()` factory.
- `supabase/functions/_shared/wa/zapi.ts` — adapter Z-API (lógica atual migrada).
- `supabase/functions/_shared/wa/evolution.ts` — adapter Evolution (novo).
- `supabase/functions/_shared/wa/index.ts` — re-exports.
- `supabase/functions/_shared/wa/__tests__/jid.test.ts`
- `supabase/functions/_shared/wa/__tests__/zapi.test.ts`
- `supabase/functions/_shared/wa/__tests__/evolution.test.ts`
- `supabase/functions/_shared/wa/__tests__/fixtures/` — payloads reais `.json` (zapi + evolution).
- `supabase/functions/wa-proxy/index.ts` — gateway de ações agnóstico (substitui `zapi-proxy`).
- `supabase/migrations/0030_provider_neutralization.sql`
- `MIGRATION.md` (se não existir) / seção de upgrade.

**Modificar:**
- `supabase/functions/process-webhook/index.ts` — orquestrador agnóstico.
- `supabase/functions/send-message/index.ts` — usa `buildSend`.
- `supabase/functions/send-voice/index.ts` — usa `buildSend` (tipo ptt).
- `supabase/functions/mcp-api/index.ts` — `status`/`sync_groups` via provider; chama `wa-proxy`; cache c/ provider; nomes de tabela/coluna.
- `supabase/functions/transcribe-queue/index.ts`, `supabase/functions/retry-media/index.ts` — fallback Storage quando `original_url` nulo.
- `supabase/config.toml` — entrada `wa-proxy`.
- `.claude/skills/setup/SKILL.md` — escolha de provider + caminho Evolution.
- `README.md`, `CHANGELOG.md`, `MIGRATION.md`.

**Remover:**
- `supabase/functions/zapi-proxy/` (após cutover p/ `wa-proxy`).

---

## Fases

- **Fase 0 — Fundação neutra** (Tasks 1-3): tipos, jid helpers, interface + factory. Código novo, puro, TDD. Não altera nada em produção.
- **Fase 1 — Adapter Z-API** (Tasks 4-7): porta a lógica atual pro adapter, com golden tests do comportamento existente.
- **Fase 2 — Adapter Evolution** (Tasks 8-11): novo adapter, fixtures reais.
- **Fase 3 — Migration** (Task 12): rename + colunas + views de compat.
- **Fase 4 — Wiring das edge functions** (Tasks 13-18): send-message, send-voice, process-webhook, wa-proxy, mcp-api, mídia.
- **Fase 5 — Setup + docs** (Tasks 19-20): SKILL de setup, MIGRATION/CHANGELOG/README.

> Cada task termina com `deno test` verde (ou, nas tasks de migration/refactor, com o critério de verificação indicado) e um commit.

---

## Fase 0 — Fundação neutra

### Task 1: Modelo de domínio neutro (`types.ts`)

**Files:**
- Create: `supabase/functions/_shared/wa/types.ts`
- Test: `supabase/functions/_shared/wa/__tests__/types.test.ts`

**Interfaces:**
- Produces: `ProviderId`, `MsgType`, `SendStatus`, `WaAction`, `InstanceCreds`, `MediaRef`, `InboundEvent`, `OutboundMessage`, `SendResult`, `MediaPayload`, `BuiltRequest`, `NeutralGroup`. Todos os tasks seguintes consomem estes tipos.

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/types.test.ts
import { assertEquals } from "jsr:@std/assert";
import type { InboundEvent, OutboundMessage, InstanceCreds } from "../types.ts";

Deno.test("InboundEvent discrimina por kind", () => {
  const ev: InboundEvent = {
    kind: "message", chatId: "5511999998888", chatName: "João", isGroup: false,
    fromMe: false, senderPhone: "5511999998888", senderName: "João",
    providerMsgId: "ABC", messageType: "text", content: "oi", caption: null,
    quotedProviderId: null, isForwarded: false, timestamp: "2026-06-26T00:00:00Z",
    media: null, raw: {},
  };
  assertEquals(ev.kind, "message");
});

Deno.test("OutboundMessage e InstanceCreds compilam com campos neutros", () => {
  const creds: InstanceCreds = {
    provider: "evolution", instance_id: "you_casa", base_url: "https://evo.x",
    auth_token: "key", client_token: null, alias: "youcasa",
  };
  const msg: OutboundMessage = { chatId: "x", phone: "5511", type: "text", content: "oi" };
  assertEquals(creds.provider, "evolution");
  assertEquals(msg.type, "text");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test supabase/functions/_shared/wa/__tests__/types.test.ts`
Expected: FAIL — `Module not found "../types.ts"`.

- [ ] **Step 3: Write `types.ts`**

```ts
// supabase/functions/_shared/wa/types.ts
export type ProviderId = "zapi" | "evolution";

export type MsgType =
  | "text" | "image" | "audio" | "ptt" | "video"
  | "document" | "sticker" | "location" | "contact" | "poll" | "unknown";

export type SendStatus = "pending" | "sent" | "delivered" | "read" | "failed";

export type WaAction =
  | "status" | "chats" | "get-contact-info"
  | "read-chat" | "read-message" | "send-reaction"
  | "send-text" | "send-poll" | "forward"
  | "delete-message" | "block-contact"
  | "create-group" | "add-participant" | "remove-participant"
  | "add-admin" | "remove-admin";

export interface InstanceCreds {
  provider: ProviderId;
  instance_id: string;          // Z-API: instance id | Evolution: nome da instância
  base_url: string | null;      // Evolution: URL do servidor | Z-API: null
  auth_token: string;           // Z-API: token | Evolution: apikey
  client_token: string | null;  // só Z-API
  alias: string | null;
}

// Referência de mídia a ser materializada DEPOIS da normalização.
//  - Z-API:     { strategy: "url", url, ... }       → fetchMedia faz GET da url
//  - Evolution: { strategy: "fetch", providerMsgId } → fetchMedia chama getBase64FromMediaMessage
export interface MediaRef {
  strategy: "url" | "fetch";
  bucket: string;               // ex. "whatsapp-images"
  ext: string;                  // ex. "jpg"
  mime: string | null;
  url?: string;                 // strategy "url"
  providerMsgId?: string;       // strategy "fetch"
  duration?: number;
  width?: number;
  height?: number;
  thumbUrl?: string;
  fileName?: string;
}

export type InboundEvent =
  | {
      kind: "message"; chatId: string; chatName: string | null; isGroup: boolean;
      fromMe: boolean; senderPhone: string | null; senderName: string | null;
      providerMsgId: string; messageType: MsgType; content: string | null;
      caption: string | null; quotedProviderId: string | null; isForwarded: boolean;
      timestamp: string; media: MediaRef | null; raw: unknown;
    }
  | { kind: "status"; providerMsgIds: string[]; status: SendStatus }
  | {
      kind: "reaction"; chatId: string; targetProviderMsgId: string;
      reactorPhone: string | null; reactorName: string | null; emoji: string | null;
      fromMe: boolean; timestamp: string; raw: unknown;
    }
  | { kind: "edit"; providerMsgId: string; newContent: string | null }
  | { kind: "revoke"; providerMsgId: string }
  | { kind: "group_participant"; chatId: string; action: "add" | "remove" | "promote" | "demote"; phones: string[] }
  | { kind: "connection"; connected: boolean };

export interface OutboundMessage {
  chatId: string;
  phone: string;
  type: MsgType;
  content?: string;
  media?: { url?: string; bytes?: Uint8Array; mime?: string; fileName?: string };
  caption?: string;
  quotedProviderId?: string | null;
  mentions?: string[];
  mentionsEveryone?: boolean;
  isGroup?: boolean;
  delayTyping?: number;   // segundos (neutro; adapter converte)
  delayMessage?: number;  // segundos (neutro; adapter converte)
}

export interface SendResult { providerMsgId: string }
export interface MediaPayload { bytes: Uint8Array; mime: string; fileName?: string }
export interface BuiltRequest {
  url: string; method: "GET" | "POST" | "DELETE"; headers: Record<string, string>; body?: string;
}
export interface NeutralGroup { chatId: string; name: string | null; participantCount?: number }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test supabase/functions/_shared/wa/__tests__/types.test.ts`
Expected: PASS (2 testes).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/wa/types.ts supabase/functions/_shared/wa/__tests__/types.test.ts
git commit -m "feat(wa): modelo de dominio neutro (types)"
```

---

### Task 2: Helpers de JID (`jid.ts`)

**Files:**
- Create: `supabase/functions/_shared/wa/jid.ts`
- Test: `supabase/functions/_shared/wa/__tests__/jid.test.ts`

**Interfaces:**
- Produces: `digitsFromJid(jid)`, `isGroupJid(jid)`, `isLidJid(jid)`. Consumido pelo adapter Evolution.

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/jid.test.ts
import { assertEquals } from "jsr:@std/assert";
import { digitsFromJid, isGroupJid, isLidJid } from "../jid.ts";

Deno.test("digitsFromJid extrai dígitos antes do @", () => {
  assertEquals(digitsFromJid("558192030166@s.whatsapp.net"), "558192030166");
  assertEquals(digitsFromJid("120363012345678901@g.us"), "120363012345678901");
  assertEquals(digitsFromJid("5511999998888"), "5511999998888");
});

Deno.test("isGroupJid detecta @g.us", () => {
  assertEquals(isGroupJid("120363@g.us"), true);
  assertEquals(isGroupJid("5511@s.whatsapp.net"), false);
});

Deno.test("isLidJid detecta @lid", () => {
  assertEquals(isLidJid("5511@lid"), true);
  assertEquals(isLidJid("5511@s.whatsapp.net"), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test supabase/functions/_shared/wa/__tests__/jid.test.ts`
Expected: FAIL — `Module not found "../jid.ts"`.

- [ ] **Step 3: Write `jid.ts`**

```ts
// supabase/functions/_shared/wa/jid.ts

/** Extrai só os dígitos antes do "@" de um JID; aceita JID ou número puro. */
export function digitsFromJid(jid: string): string {
  const left = (jid ?? "").split("@")[0];
  return left.replace(/\D/g, "");
}

export function isGroupJid(jid: unknown): jid is string {
  return typeof jid === "string" && jid.endsWith("@g.us");
}

export function isLidJid(jid: unknown): jid is string {
  return typeof jid === "string" && jid.endsWith("@lid");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test supabase/functions/_shared/wa/__tests__/jid.test.ts`
Expected: PASS (3 testes).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/wa/jid.ts supabase/functions/_shared/wa/__tests__/jid.test.ts
git commit -m "feat(wa): helpers de JID (digits/group/lid)"
```

---

### Task 3: Interface `WaProvider` + factory (`provider.ts`)

**Files:**
- Create: `supabase/functions/_shared/wa/provider.ts`
- Test: `supabase/functions/_shared/wa/__tests__/provider.test.ts`

**Interfaces:**
- Consumes: tipos da Task 1.
- Produces: `interface WaProvider`, `registerProvider(p)`, `getProvider(id): WaProvider`. Adapters se auto-registram no load; edge functions chamam `getProvider`.

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/provider.test.ts
import { assertEquals, assertThrows } from "jsr:@std/assert";
import { registerProvider, getProvider, type WaProvider } from "../provider.ts";

const stub: WaProvider = {
  id: "zapi",
  matchesWebhook: () => true,
  webhookInstanceKey: () => "x",
  verifyWebhookAuth: () => true,
  normalizeInbound: () => Promise.resolve([]),
  fetchMedia: () => Promise.resolve({ bytes: new Uint8Array(), mime: "x" }),
  buildSend: () => Promise.resolve({ url: "u", method: "POST", headers: {} }),
  parseSendResult: () => ({ providerMsgId: "id" }),
  buildAction: () => null,
  parseConnection: () => ({ connected: true }),
  fetchGroups: () => Promise.resolve([]),
};

Deno.test("registerProvider + getProvider devolve o adapter", () => {
  registerProvider(stub);
  assertEquals(getProvider("zapi").id, "zapi");
});

Deno.test("getProvider lança em provider não registrado", () => {
  assertThrows(() => getProvider("evolution"), Error, "não registrado");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test supabase/functions/_shared/wa/__tests__/provider.test.ts`
Expected: FAIL — `Module not found "../provider.ts"`.

- [ ] **Step 3: Write `provider.ts`**

```ts
// supabase/functions/_shared/wa/provider.ts
import type {
  ProviderId, InstanceCreds, InboundEvent, OutboundMessage, SendResult,
  MediaRef, MediaPayload, BuiltRequest, NeutralGroup, WaAction,
} from "./types.ts";

export interface WaProvider {
  readonly id: ProviderId;

  // entrada
  matchesWebhook(raw: any): boolean;
  webhookInstanceKey(raw: any): string | null;
  verifyWebhookAuth(raw: any, headers: Headers, creds: InstanceCreds | null): boolean;
  normalizeInbound(raw: any, creds: InstanceCreds): Promise<InboundEvent[]>;
  fetchMedia(creds: InstanceCreds, ref: MediaRef): Promise<MediaPayload>;

  // saída
  buildSend(creds: InstanceCreds, msg: OutboundMessage): Promise<BuiltRequest>;
  parseSendResult(json: any): SendResult;

  // ações / consultas
  buildAction(creds: InstanceCreds, action: WaAction, params: any): BuiltRequest | null;
  parseConnection(json: any): { connected: boolean; phone?: string };
  fetchGroups(creds: InstanceCreds): Promise<NeutralGroup[]>;

  // OPCIONAL — enriquecimento de chatId que exige I/O (só Z-API: resolução @lid em 3 camadas).
  // process-webhook chama `provider.resolveChatIds?.(events, creds, { supabase }) ?? events`
  // DEPOIS de normalizeInbound (que permanece PURO). Evolution não implementa (usa remoteJidAlt).
  resolveChatIds?(events: InboundEvent[], creds: InstanceCreds, deps: { supabase: any }): Promise<InboundEvent[]>;
}

const registry = new Map<ProviderId, WaProvider>();

export function registerProvider(p: WaProvider): void {
  registry.set(p.id, p);
}

export function getProvider(id: ProviderId): WaProvider {
  const p = registry.get(id);
  if (!p) throw new Error(`provider não registrado: ${id}`);
  return p;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test supabase/functions/_shared/wa/__tests__/provider.test.ts`
Expected: PASS (2 testes).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/wa/provider.ts supabase/functions/_shared/wa/__tests__/provider.test.ts
git commit -m "feat(wa): interface WaProvider + factory com registry"
```

---

## Fase 1 — Adapter Z-API (port + golden tests)

> Estas tasks **portam** a lógica que hoje vive em `send-message/index.ts` e `process-webhook/index.ts`
> para `zapi.ts`, **sem mudar comportamento**. A proteção é golden test: capturamos a saída esperada
> a partir de payloads reais e travamos. Onde o plano diz "porta a lógica de X (linhas N-M)", o
> implementador copia a lógica existente e adapta as assinaturas para os tipos neutros — não reescreve
> do zero.

### Task 4: `ZapiProvider.buildSend` + `parseSendResult`

**Files:**
- Create: `supabase/functions/_shared/wa/zapi.ts` (esqueleto da classe + estes 2 métodos)
- Test: `supabase/functions/_shared/wa/__tests__/zapi.test.ts`

**Interfaces:**
- Consumes: `InstanceCreds`, `OutboundMessage`, `BuiltRequest`, `SendResult` (Task 1).
- Produces: `class ZapiProvider implements WaProvider` (parcial); `buildSend`, `parseSendResult`.
- Porta de: `send-message/index.ts:195-218` (switch de endpoints) e `:224` (parse `messageId ?? id`).

- [ ] **Step 1: Write the failing test** (contrato — corpo Z-API por tipo)

```ts
// __tests__/zapi.test.ts
import { assertEquals } from "jsr:@std/assert";
import { ZapiProvider } from "../zapi.ts";
import type { InstanceCreds } from "../types.ts";

const z = new ZapiProvider();
const creds: InstanceCreds = {
  provider: "zapi", instance_id: "INST", base_url: null,
  auth_token: "TKN", client_token: "CT", alias: "pessoal",
};

Deno.test("zapi.buildSend texto monta /send-text com phone+message", async () => {
  const r = await z.buildSend(creds, { chatId: "5511", phone: "5511", type: "text", content: "oi" });
  assertEquals(r.url, "https://api.z-api.io/instances/INST/token/TKN/send-text");
  assertEquals(r.method, "POST");
  assertEquals(r.headers["Client-Token"], "CT");
  assertEquals(JSON.parse(r.body!), { phone: "5511", message: "oi" });
});

Deno.test("zapi.buildSend imagem com caption e reply", async () => {
  const r = await z.buildSend(creds, {
    chatId: "5511", phone: "5511", type: "image", content: "legenda",
    media: { url: "https://x/img.jpg" }, quotedProviderId: "MID",
  });
  assertEquals(r.url.endsWith("/send-image"), true);
  assertEquals(JSON.parse(r.body!), { phone: "5511", image: "https://x/img.jpg", caption: "legenda", messageId: "MID" });
});

Deno.test("zapi.buildSend ptt usa /send-audio com waveform", async () => {
  const r = await z.buildSend(creds, { chatId: "5511", phone: "5511", type: "ptt", media: { url: "https://x/a.ogg" } });
  assertEquals(r.url.endsWith("/send-audio"), true);
  assertEquals(JSON.parse(r.body!), { phone: "5511", audio: "https://x/a.ogg", waveform: true });
});

Deno.test("zapi.parseSendResult prioriza messageId", () => {
  assertEquals(z.parseSendResult({ messageId: "M1", id: "X" }), { providerMsgId: "M1" });
  assertEquals(z.parseSendResult({ id: "X" }), { providerMsgId: "X" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test supabase/functions/_shared/wa/__tests__/zapi.test.ts`
Expected: FAIL — `Module not found "../zapi.ts"`.

- [ ] **Step 3: Implement** `zapi.ts` com a classe e estes 2 métodos

Crie `ZapiProvider implements WaProvider` (os demais métodos podem lançar `Error("not impl")` por enquanto — serão preenchidos nas tasks 5-7). Em `buildSend`, **porta o switch de `send-message/index.ts:195-218`** trocando o destinatário pela `msg.phone`, montando `base = https://api.z-api.io/instances/${creds.instance_id}/token/${creds.auth_token}` e `headers = { "Content-Type":"application/json", "Client-Token": creds.client_token! }`. Mapeie:
- `text` → `/send-text` `{ phone, message: withMentions(content), ...(quoted && {messageId}), ...(mentions && {mentioned}) }`
- `image|video|document|audio|ptt` conforme o switch atual (incluindo `waveform:true` no ptt, `fileName` no document).
- `delayTyping`/`delayMessage`: se `msg.delayTyping/delayMessage`, aplique `Math.min(15,Math.max(1,floor))` (porta `:213-218`).
- `@todos`: se `msg.mentionsEveryone && msg.isGroup`, faça o GET `/group-metadata/{phone}` (porta `fetchGroupParticipants` de `send-message/index.ts:91-99`) e use a lista como `mentioned`. (Caminho com I/O — coberto por teste separado stubando `globalThis.fetch`.)

`parseSendResult(json)` → `{ providerMsgId: json.messageId ?? json.id ?? "" }`.

(Registro no factory: ao final do arquivo, `registerProvider(new ZapiProvider())`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test supabase/functions/_shared/wa/__tests__/zapi.test.ts`
Expected: PASS (4 testes).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/wa/zapi.ts supabase/functions/_shared/wa/__tests__/zapi.test.ts
git commit -m "feat(wa): ZapiProvider.buildSend + parseSendResult (port send-message)"
```

---

### Task 5: `ZapiProvider.normalizeInbound` (port do parse do webhook)

**Files:**
- Modify: `supabase/functions/_shared/wa/zapi.ts`
- Create: `supabase/functions/_shared/wa/__tests__/fixtures/zapi-received-text.json`, `zapi-received-image.json`, `zapi-status.json`, `zapi-reaction.json` (payloads reais — capturar de `webhook_events_raw` da instância Z-API; se indisponível, montar a partir dos shapes em `process-webhook/index.ts:261-365`)
- Test: `supabase/functions/_shared/wa/__tests__/zapi.test.ts` (novos casos)

**Interfaces:**
- Consumes: `InboundEvent`, `MediaRef`, `InstanceCreds`.
- Produces: `ZapiProvider.normalizeInbound(raw, creds): Promise<InboundEvent[]>` (PURO — sem I/O; `@lid` fica como veio, resolução é Task 7), `matchesWebhook`, `webhookInstanceKey`, `verifyWebhookAuth`.
- Porta de: `routeEvent`/`handleReceived`/`extractMediaInfo`/`handleStatus`/`handleReaction`/`handleEdited`/`handleRevoked`/`handleGroupNotif` (`process-webhook/index.ts:244-445`), reescrevendo cada `handle*` como um **mapeador puro** payload → `InboundEvent` (em vez de gravar no banco).

- [ ] **Step 1: Write the failing test**

```ts
// adicionar em zapi.test.ts
import received from "./fixtures/zapi-received-text.json" with { type: "json" };
import status from "./fixtures/zapi-status.json" with { type: "json" };

Deno.test("zapi.normalizeInbound: ReceivedCallback texto → 1 evento message", async () => {
  const evs = await z.normalizeInbound(received, creds);
  assertEquals(evs.length, 1);
  const ev = evs[0];
  assertEquals(ev.kind, "message");
  if (ev.kind === "message") {
    assertEquals(ev.messageType, "text");
    assertEquals(ev.fromMe, false);
    assertEquals(typeof ev.providerMsgId, "string");
  }
});

Deno.test("zapi.normalizeInbound: MessageStatusCallback → evento status", async () => {
  const evs = await z.normalizeInbound(status, creds);
  assertEquals(evs[0].kind, "status");
});

Deno.test("zapi.matchesWebhook usa presença de `type`", () => {
  assertEquals(z.matchesWebhook({ type: "ReceivedCallback" }), true);
  assertEquals(z.matchesWebhook({ event: "messages.upsert" }), false);
});
```
(`zapi-received-text.json` deve conter um `ReceivedCallback` real com `text.message`; `zapi-status.json` um `MessageStatusCallback` com `ids` + `status`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test supabase/functions/_shared/wa/__tests__/zapi.test.ts`
Expected: FAIL — `normalizeInbound`/fixtures ausentes.

- [ ] **Step 3: Implement**

Em `zapi.ts`:
- `matchesWebhook(raw)` → `typeof raw?.type === "string"`.
- `webhookInstanceKey(raw)` → `raw?.instanceId ?? null`.
- `verifyWebhookAuth(raw, headers, creds)` → porta a lógica de `process-webhook/index.ts:172-198` (header `z-api-token`, comparação com `creds`/TOFU). **Nota:** TOFU grava no banco → mantenha o write fora daqui; retorne também um sinal "aprender token" OU deixe a verificação como booleana simples comparando contra `creds.webhook_token` (a gravação TOFU permanece no `process-webhook`). Decisão: `verifyWebhookAuth` é booleano puro; o aprendizado TOFU continua no orquestrador (Task 16).
- `normalizeInbound(raw, creds)`: replica o roteamento de `routeEvent` (`:244-258`) e o desempacotamento defensivo de `handleReceived` (`:281-288`: `notification`→group_participant, `reaction`→reaction, `isEdit`→edit). Para cada caso, **monte e retorne** o `InboundEvent` correspondente em vez de gravar:
  - mensagem: usa `extractMediaInfo` (porta `:354-365`) → preenche `messageType`, `content`, `caption` e, se houver mídia, um `MediaRef` `{ strategy:"url", url, mime, bucket, ext, duration?, width?, height?, thumbUrl? }`. `chatId = raw.phone` (sem resolver `@lid` aqui). `senderPhone` porta `:322-324`. `timestamp = new Date(raw.momment ?? Date.now()).toISOString()`. `waitingMessage===true` → retorna `[]` (skip, porta `:269-272`).
  - status → `{ kind:"status", providerMsgIds: raw.ids ?? [], status: map[raw.status] }` (map de `:370`).
  - reaction/edit/revoke/group_participant/connection → portam `handleReaction/Edited/Revoked/GroupNotif/Connection` como mapeadores.

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test supabase/functions/_shared/wa/__tests__/zapi.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/wa/zapi.ts supabase/functions/_shared/wa/__tests__/
git commit -m "feat(wa): ZapiProvider.normalizeInbound puro (port process-webhook handlers)"
```

---

### Task 6: `ZapiProvider.fetchMedia` + `resolveChatIds` (camadas @lid)

**Files:**
- Modify: `supabase/functions/_shared/wa/zapi.ts`
- Test: `supabase/functions/_shared/wa/__tests__/zapi.test.ts`

**Interfaces:**
- Produces: `ZapiProvider.fetchMedia(creds, ref)` (GET da URL com retry — porta `fetchWithRetry` de `process-webhook/index.ts:456-475`); `ZapiProvider.resolveChatIds(events, creds, { supabase })` (porta `resolveLidToPhone`/`resolveChatIdFromPayload`, `:69-152`, aplicada aos eventos `message`/`reaction` cujo `chatId` é `@lid`).

- [ ] **Step 1: Write the failing test** (stub de `fetch` e de `supabase`)

```ts
Deno.test("zapi.fetchMedia faz GET e devolve bytes", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(new Response(new Uint8Array([1,2,3]), { status: 200 }));
  try {
    const out = await z.fetchMedia(creds, { strategy: "url", url: "https://x/a.jpg", mime: "image/jpeg", bucket: "whatsapp-images", ext: "jpg" });
    assertEquals(out.bytes.length, 3);
    assertEquals(out.mime, "image/jpeg");
  } finally { globalThis.fetch = orig; }
});

Deno.test("zapi.resolveChatIds resolve @lid via cache (camada 1)", async () => {
  const fakeSupabase = {
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { phone: "5511999" } }) }) }) }) }),
  };
  const ev = { kind: "message", chatId: "ABC@lid", fromMe: true, isGroup: false /* …demais campos */ } as any;
  const out = await z.resolveChatIds!([ev], creds, { supabase: fakeSupabase });
  assertEquals(out[0].chatId, "5511999");
});
```

- [ ] **Step 2: Run** → FAIL (métodos ausentes).
- [ ] **Step 3: Implement** `fetchMedia` (porta `fetchWithRetry` + escolha de timeout por bucket, `:447-475`) e `resolveChatIds` (porta as 3 camadas `:69-152`; só atua quando `isLidJid(ev.chatId) && ev.fromMe && !ev.isGroup`; grava em `lid_mapping` como hoje).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/wa/zapi.ts supabase/functions/_shared/wa/__tests__/zapi.test.ts
git commit -m "feat(wa): ZapiProvider.fetchMedia + resolveChatIds (port @lid 3 camadas)"
```

---

### Task 7: `ZapiProvider.buildAction` + `parseConnection` + `fetchGroups`

**Files:**
- Modify: `supabase/functions/_shared/wa/zapi.ts`
- Test: `supabase/functions/_shared/wa/__tests__/zapi.test.ts`

**Interfaces:**
- Produces: `buildAction(creds, action, params)` (porta o mapeamento de `zapi-proxy/index.ts:276-299`, incluindo o caso `get-contact-info`→`GET /contacts/{phone}`); `parseConnection(json)` → `{ connected: json.connected ?? json.smartphoneConnected ?? false, phone: json.phone }`; `fetchGroups(creds)` (GET `/chats`, filtra `isGroup`, mapeia p/ `NeutralGroup` — porta de `mcp-api/index.ts:854-864`).

- [ ] **Step 1: Write the failing test**

```ts
Deno.test("zapi.buildAction send-reaction monta /send-reaction", () => {
  const r = z.buildAction(creds, "send-reaction", { phone: "5511", messageId: "M", reaction: "👍" });
  assertEquals(r!.url.endsWith("/send-reaction"), true);
  assertEquals(JSON.parse(r!.body!), { phone: "5511", messageId: "M", reaction: "👍" });
});
Deno.test("zapi.buildAction get-contact-info vira GET /contacts/{phone}", () => {
  const r = z.buildAction(creds, "get-contact-info", { phone: "5511" });
  assertEquals(r!.method, "GET");
  assertEquals(r!.url.endsWith("/contacts/5511"), true);
});
Deno.test("zapi.parseConnection lê connected/smartphoneConnected", () => {
  assertEquals(z.parseConnection({ connected: true }).connected, true);
  assertEquals(z.parseConnection({ smartphoneConnected: true }).connected, true);
});
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** os 3 métodos portando as lógicas indicadas. `buildAction` monta `base` + `/{action}` (ou o GET especial de `get-contact-info`), headers com `Client-Token`.
- [ ] **Step 4: Run** → PASS. Rode a suíte inteira: `deno test supabase/functions/_shared/wa/` → tudo verde.
- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/wa/zapi.ts supabase/functions/_shared/wa/__tests__/zapi.test.ts
git commit -m "feat(wa): ZapiProvider.buildAction + parseConnection + fetchGroups"
```

---

## Fase 2 — Adapter Evolution (código novo, fixtures reais)

### Task 8: `EvolutionProvider.buildSend` + `parseSendResult`

**Files:**
- Create: `supabase/functions/_shared/wa/evolution.ts`
- Test: `supabase/functions/_shared/wa/__tests__/evolution.test.ts`

**Interfaces:**
- Produces: `class EvolutionProvider implements WaProvider` (parcial); `buildSend`, `parseSendResult`.
- Referência: Postman v2.3 — `sendText`/`sendMedia`/`sendWhatsAppAudio`/`sendSticker`.

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/evolution.test.ts
import { assertEquals } from "jsr:@std/assert";
import { EvolutionProvider } from "../evolution.ts";
import type { InstanceCreds } from "../types.ts";

const e = new EvolutionProvider();
const creds: InstanceCreds = {
  provider: "evolution", instance_id: "you_casa", base_url: "https://evo.x",
  auth_token: "APIKEY", client_token: null, alias: "youcasa",
};

Deno.test("evo.buildSend texto → /message/sendText/{inst} com apikey", async () => {
  const r = await e.buildSend(creds, { chatId: "5511", phone: "5511", type: "text", content: "oi" });
  assertEquals(r.url, "https://evo.x/message/sendText/you_casa");
  assertEquals(r.method, "POST");
  assertEquals(r.headers["apikey"], "APIKEY");
  assertEquals(JSON.parse(r.body!), { number: "5511", text: "oi" });
});

Deno.test("evo.buildSend texto com reply+menções", async () => {
  const r = await e.buildSend(creds, {
    chatId: "5511", phone: "5511", type: "text", content: "oi",
    quotedProviderId: "MID", mentions: ["5599"], mentionsEveryone: true,
  });
  assertEquals(JSON.parse(r.body!), {
    number: "5511", text: "oi",
    quoted: { key: { id: "MID" } }, mentioned: ["5599"], mentionsEveryOne: true,
  });
});

Deno.test("evo.buildSend imagem por URL → /message/sendMedia", async () => {
  const r = await e.buildSend(creds, {
    chatId: "5511", phone: "5511", type: "image", content: "leg",
    media: { url: "https://x/i.png", mime: "image/png", fileName: "i.png" },
  });
  assertEquals(r.url.endsWith("/message/sendMedia/you_casa"), true);
  assertEquals(JSON.parse(r.body!), {
    number: "5511", mediatype: "image", mimetype: "image/png",
    media: "https://x/i.png", caption: "leg", fileName: "i.png",
  });
});

Deno.test("evo.buildSend ptt/audio → /message/sendWhatsAppAudio", async () => {
  const r = await e.buildSend(creds, { chatId: "5511", phone: "5511", type: "ptt", media: { url: "https://x/a.ogg" } });
  assertEquals(r.url.endsWith("/message/sendWhatsAppAudio/you_casa"), true);
  assertEquals(JSON.parse(r.body!), { number: "5511", audio: "https://x/a.ogg" });
});

Deno.test("evo.parseSendResult lê data.key.id", () => {
  assertEquals(e.parseSendResult({ key: { id: "EVO1" } }), { providerMsgId: "EVO1" });
});
```

- [ ] **Step 2: Run** → FAIL (`Module not found`).
- [ ] **Step 3: Implement** `evolution.ts`:

```ts
// supabase/functions/_shared/wa/evolution.ts (trecho de buildSend/parseSendResult)
import { registerProvider, type WaProvider } from "./provider.ts";
import type { InstanceCreds, OutboundMessage, BuiltRequest, SendResult, MsgType } from "./types.ts";

const MEDIA_TYPE: Partial<Record<MsgType, "image"|"video"|"document">> = {
  image: "image", video: "video", document: "document",
};

export class EvolutionProvider implements WaProvider {
  readonly id = "evolution" as const;

  private h(creds: InstanceCreds) {
    return { "Content-Type": "application/json", "apikey": creds.auth_token };
  }
  private u(creds: InstanceCreds, path: string) {
    return `${creds.base_url}/${path}/${creds.instance_id}`;
  }
  private opts(msg: OutboundMessage) {
    const o: Record<string, unknown> = {};
    if (msg.quotedProviderId) o.quoted = { key: { id: msg.quotedProviderId } };
    if (msg.mentions?.length) o.mentioned = msg.mentions;
    if (msg.mentionsEveryone) o.mentionsEveryOne = true;
    if (msg.delayMessage) o.delay = Math.min(15000, Math.max(0, Math.floor(msg.delayMessage * 1000)));
    return o;
  }

  buildSend(creds: InstanceCreds, msg: OutboundMessage): Promise<BuiltRequest> {
    const headers = this.h(creds);
    const number = msg.phone;
    let path: string, body: Record<string, unknown>;
    if (msg.type === "image" || msg.type === "video" || msg.type === "document") {
      path = "message/sendMedia";
      body = { number, mediatype: MEDIA_TYPE[msg.type], mimetype: msg.media?.mime,
               media: msg.media?.url ?? msg.media?.bytes, ...(msg.content ? { caption: msg.content } : {}),
               ...(msg.media?.fileName ? { fileName: msg.media.fileName } : {}), ...this.opts(msg) };
    } else if (msg.type === "audio" || msg.type === "ptt") {
      path = "message/sendWhatsAppAudio";
      body = { number, audio: msg.media?.url ?? msg.media?.bytes, ...this.opts(msg) };
    } else if (msg.type === "sticker") {
      path = "message/sendSticker";
      body = { number, sticker: msg.media?.url ?? msg.media?.bytes, ...this.opts(msg) };
    } else {
      path = "message/sendText";
      body = { number, text: msg.content ?? "", ...this.opts(msg) };
    }
    return Promise.resolve({ url: this.u(creds, path), method: "POST", headers, body: JSON.stringify(body) });
  }

  parseSendResult(json: any): SendResult {
    return { providerMsgId: json?.key?.id ?? json?.messageId ?? json?.id ?? "" };
  }
  // demais métodos: Tasks 9-11 (lançar Error("not impl") por enquanto)
  // ...
}

registerProvider(new EvolutionProvider());
```

- [ ] **Step 4: Run** → PASS (5 testes).
- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/wa/evolution.ts supabase/functions/_shared/wa/__tests__/evolution.test.ts
git commit -m "feat(wa): EvolutionProvider.buildSend + parseSendResult (Postman v2.3)"
```

---

### Task 9: `EvolutionProvider.normalizeInbound` (fixture real)

**Files:**
- Modify: `supabase/functions/_shared/wa/evolution.ts`
- Create: `__tests__/fixtures/evo-messages-upsert-text.json` (o payload real capturado — `event:"messages.upsert"`, `data.key.{remoteJid,remoteJidAlt,fromMe,id,addressingMode}`, `data.pushName`, `data.message.conversation`, `data.messageTimestamp`), `evo-messages-upsert-image.json`, `evo-status.json` (`messages.update`).
- Test: `__tests__/evolution.test.ts`

**Interfaces:**
- Produces: `matchesWebhook` (`typeof raw?.event === "string"`), `webhookInstanceKey` (`raw?.instance ?? null`), `verifyWebhookAuth`, `normalizeInbound`. Usa `digitsFromJid`/`isGroupJid`/`isLidJid` (Task 2).

- [ ] **Step 1: Write the failing test**

```ts
import upsertText from "./fixtures/evo-messages-upsert-text.json" with { type: "json" };

Deno.test("evo.matchesWebhook usa `event`", () => {
  assertEquals(e.matchesWebhook({ event: "messages.upsert" }), true);
  assertEquals(e.matchesWebhook({ type: "ReceivedCallback" }), false);
});

Deno.test("evo.webhookInstanceKey lê `instance`", () => {
  assertEquals(e.webhookInstanceKey({ instance: "you_casa" }), "you_casa");
});

Deno.test("evo.normalizeInbound: messages.upsert texto → message neutro", async () => {
  const evs = await e.normalizeInbound(upsertText, creds);
  assertEquals(evs.length, 1);
  const ev = evs[0];
  assertEquals(ev.kind, "message");
  if (ev.kind === "message") {
    assertEquals(ev.messageType, "text");
    assertEquals(ev.chatId, "558192030166");          // dígitos do remoteJid/remoteJidAlt
    assertEquals(ev.fromMe, false);
    assertEquals(ev.senderName, "Asafe Silva");        // pushName
    assertEquals(ev.providerMsgId, "3EB041E7E371837D3775CB");
    assertEquals(ev.content, /* texto do fixture */ ev.content);
    assertEquals(ev.media, null);
  }
});
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `normalizeInbound`:
  - `matchesWebhook` → `typeof raw?.event === "string"`. `webhookInstanceKey` → `raw?.instance ?? null`.
  - `verifyWebhookAuth(raw, headers, creds)` → compara o header de auth configurado (ex.: `authorization`) com o segredo salvo da instância (booleano puro; sem TOFU). Se `WEBHOOK_REQUIRE_AUTH` desligado, retorna `true`.
  - `normalizeInbound(raw, creds)` por `raw.event`:
    - `messages.upsert` → 1 evento. `const d = raw.data; const k = d.key;` JID efetivo: `const jid = (k.addressingMode === "lid" && k.remoteJidAlt) ? k.remoteJidAlt : k.remoteJid;` `isGroup = isGroupJid(jid)`. `chatId = isGroup ? jid : digitsFromJid(jid)`. `senderPhone = isGroup ? digitsFromJid(k.participant || "") || null : chatId`. Desembrulhe `ephemeralMessage`: `const m = d.message?.ephemeralMessage?.message ?? d.message;`. Tipo via presença de `m.conversation`/`m.extendedTextMessage`→text, `m.imageMessage`→image, `m.audioMessage`→ (`m.audioMessage.ptt`? "ptt":"audio"), `m.videoMessage`→video, `m.documentMessage`→document, `m.stickerMessage`→sticker, `m.reactionMessage`→**evento reaction** (não message), `m.locationMessage`/`m.contactMessage` conforme. `content` = `m.conversation ?? m.extendedTextMessage?.text ?? null`. `caption` = `imageMessage.caption ?? videoMessage.caption ?? documentMessage.caption ?? null`. `quotedProviderId` = `m.<type>.contextInfo?.stanzaId ?? null`. Para mídia, `media: { strategy:"fetch", providerMsgId: k.id, mime, bucket, ext }` (sem URL — Task 11 busca base64). `timestamp = new Date(Number(d.messageTimestamp) * 1000).toISOString()`.
    - `messages.update` → `{ kind:"status", providerMsgIds:[d.key.id], status: mapAck(d.status) }` (`DELIVERY_ACK`→delivered, `READ`/`PLAYED`→read, `SERVER_ACK`/`PENDING`→sent).
    - `connection.update` → `{ kind:"connection", connected: d.state === "open" }`.
    - `group-participants.update`/`groups.update` → `{ kind:"group_participant", ... }`.
    - eventos não tratados → `[]`.

- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/wa/evolution.ts supabase/functions/_shared/wa/__tests__/
git commit -m "feat(wa): EvolutionProvider.normalizeInbound (fixture real v2.3)"
```

---

### Task 10: `EvolutionProvider.fetchMedia`

**Files:**
- Modify: `supabase/functions/_shared/wa/evolution.ts`
- Test: `__tests__/evolution.test.ts`

**Interfaces:**
- Produces: `fetchMedia(creds, ref)` → `POST {base}/chat/getBase64FromMediaMessage/{inst}` `{ message:{ key:{ id: ref.providerMsgId } }, convertToMp4:false }`; decodifica `base64` da resposta; retorna `{ bytes, mime, fileName }`. Retry (≈3x) com backoff.

- [ ] **Step 1: Write the failing test** (stub fetch devolvendo `{base64,mimetype,fileName}`)

```ts
Deno.test("evo.fetchMedia decodifica base64 do getBase64FromMediaMessage", async () => {
  const orig = globalThis.fetch;
  const b64 = btoa("abc");
  globalThis.fetch = () => Promise.resolve(new Response(JSON.stringify({ base64: b64, mimetype: "audio/ogg", fileName: "a.ogg" }), { status: 200 }));
  try {
    const out = await e.fetchMedia(creds, { strategy: "fetch", providerMsgId: "MID", mime: null, bucket: "whatsapp-audio", ext: "ogg" });
    assertEquals(new TextDecoder().decode(out.bytes), "abc");
    assertEquals(out.mime, "audio/ogg");
  } finally { globalThis.fetch = orig; }
});
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `fetchMedia` com retry; usa `atob` → `Uint8Array`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/wa/evolution.ts supabase/functions/_shared/wa/__tests__/evolution.test.ts
git commit -m "feat(wa): EvolutionProvider.fetchMedia (getBase64FromMediaMessage)"
```

---

### Task 11: `EvolutionProvider.buildAction` + `parseConnection` + `fetchGroups` + `index.ts`

**Files:**
- Modify: `supabase/functions/_shared/wa/evolution.ts`
- Create: `supabase/functions/_shared/wa/index.ts`
- Test: `__tests__/evolution.test.ts`

**Interfaces:**
- Produces: `buildAction` (mapa de ações → endpoints v2.3), `parseConnection` (`{ connected: json?.instance?.state === "open" || json?.state === "open" }`), `fetchGroups` (GET `/group/fetchAllGroups/{inst}?getParticipants=false` → `NeutralGroup[]`); `index.ts` que importa ambos os adapters (dispara o `registerProvider`) e re-exporta `getProvider` + tipos.

Mapa de ações Evolution (`buildAction`):
| WaAction | Endpoint / método | body |
|---|---|---|
| `send-reaction` | POST `message/sendReaction` | `{ key:{ remoteJid, fromMe, id }, reaction }` |
| `send-text` (edit) | POST `chat/updateMessage` | `{ number, key:{ remoteJid, fromMe, id }, text }` (quando `params.editMessageId`) |
| `delete-message` | DELETE `chat/deleteMessageForEveryone` | `{ id, remoteJid, fromMe, participant? }` |
| `block-contact` | POST `message/updateBlockStatus` | `{ number, status }` |
| `read-message` | POST `chat/markMessageAsRead` | `{ readMessages:[{ remoteJid, fromMe, id }] }` |
| `create-group` | POST `group/create` | `{ subject, participants }` |
| `add/remove/promote/demote` | POST `group/updateParticipant?groupJid=` | `{ action, participants }` |
| `status` | GET `instance/connectionState` | — |
| `chats` | GET `group/fetchAllGroups?getParticipants=false` | — |

`params` chega no vocabulário Z-API (`phone`, `messageId`); o adapter Evolution converte (`phone`→JID `@s.whatsapp.net`/`@g.us`, `messageId`→`key.id`). Ações sem equivalente → `null`.

- [ ] **Step 1: Write the failing test**

```ts
Deno.test("evo.buildAction send-reaction monta key+reaction", () => {
  const r = e.buildAction(creds, "send-reaction", { phone: "5511", messageId: "M", reaction: "✅", fromMe: false });
  assertEquals(r!.url.endsWith("/message/sendReaction/you_casa"), true);
  assertEquals(JSON.parse(r!.body!), { key: { remoteJid: "5511@s.whatsapp.net", fromMe: false, id: "M" }, reaction: "✅" });
});
Deno.test("evo.parseConnection lê instance.state", () => {
  assertEquals(e.parseConnection({ instance: { state: "open" } }).connected, true);
  assertEquals(e.parseConnection({ instance: { state: "close" } }).connected, false);
});
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** os 3 métodos + `index.ts`:

```ts
// supabase/functions/_shared/wa/index.ts
import "./zapi.ts";        // dispara registerProvider(new ZapiProvider())
import "./evolution.ts";   // dispara registerProvider(new EvolutionProvider())
export { getProvider, registerProvider, type WaProvider } from "./provider.ts";
export * from "./types.ts";
```

- [ ] **Step 4: Run a suíte toda** → `deno test supabase/functions/_shared/wa/` → tudo verde.
- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/wa/
git commit -m "feat(wa): EvolutionProvider.buildAction/parseConnection/fetchGroups + index"
```

---

## Fase 3 — Migration de neutralização

### Task 12: Migration `0030_provider_neutralization.sql`

**Files:**
- Create: `supabase/migrations/0030_provider_neutralization.sql`

**Interfaces:**
- Produces: tabela `wa_instance` (era `zapi_instance`) com colunas `provider`, `base_url`, `auth_token` (era `token`), `client_token` nullable; tabela `wa_action_log` (era `zapi_action_log`); views de compat `zapi_instance`/`zapi_action_log`.

- [ ] **Step 1: Write the migration** (idempotente)

```sql
-- supabase/migrations/0030_provider_neutralization.sql
-- Neutraliza o acoplamento Z-API: rename de tabelas + coluna provider/base_url.
-- Preserva 100% dos dados (ALTER ... RENAME). Idempotente. Views de compat por 1 versão.

-- 1) Rename tabelas (só se ainda não renomeadas)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='zapi_instance' AND table_type='BASE TABLE')
     AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='wa_instance' AND table_type='BASE TABLE') THEN
    ALTER TABLE public.zapi_instance RENAME TO wa_instance;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='zapi_action_log' AND table_type='BASE TABLE')
     AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='wa_action_log' AND table_type='BASE TABLE') THEN
    ALTER TABLE public.zapi_action_log RENAME TO wa_action_log;
  END IF;
END $$;

-- 2) Rename coluna token -> auth_token (só se ainda existir token)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='wa_instance' AND column_name='token')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='wa_instance' AND column_name='auth_token') THEN
    ALTER TABLE public.wa_instance RENAME COLUMN token TO auth_token;
  END IF;
END $$;

-- 3) client_token nullable (Evolution não usa)
ALTER TABLE public.wa_instance ALTER COLUMN client_token DROP NOT NULL;

-- 4) Novas colunas
ALTER TABLE public.wa_instance
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'zapi',
  ADD COLUMN IF NOT EXISTS base_url TEXT;

-- 5) CHECK do provider (idempotente)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wa_instance_provider_check') THEN
    ALTER TABLE public.wa_instance
      ADD CONSTRAINT wa_instance_provider_check CHECK (provider IN ('zapi','evolution'));
  END IF;
END $$;

-- 6) Views de compat (shim de depreciação — removidas numa versão futura)
DROP VIEW IF EXISTS public.zapi_instance;
CREATE VIEW public.zapi_instance AS
  SELECT id, instance_id, auth_token AS token, client_token, webhook_url, webhook_token,
         phone_connected, alias, is_default, is_active,
         last_connected_at, last_disconnected_at, created_at, updated_at
  FROM public.wa_instance;

DROP VIEW IF EXISTS public.zapi_action_log;
CREATE VIEW public.zapi_action_log AS SELECT * FROM public.wa_action_log;
```

> Ajuste a lista de colunas da view `zapi_instance` à realidade do schema (confira com
> `\d zapi_instance` antes — a lista acima reflete o schema documentado em 0001 + 0027-0029).

- [ ] **Step 2: Verificar localmente** (se houver stack local) ou validar a sintaxe

Run: `supabase db push` (em projeto de teste) **ou** valida a sintaxe aplicando num branch Supabase descartável.
Expected: aplica sem erro; `SELECT provider, count(*) FROM wa_instance GROUP BY provider;` lista linhas existentes como `zapi`; `SELECT token FROM zapi_instance LIMIT 1;` (via view) ainda funciona.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0030_provider_neutralization.sql
git commit -m "feat(db): migration 0030 — rename wa_instance/wa_action_log + provider/base_url + views compat"
```

---

## Fase 4 — Wiring das edge functions

> Estas tasks integram os adapters (já testados) nas functions. Não há unit test novo de adapter;
> a verificação é **deploy + smoke** (ver seção Verificação) e a não-regressão Z-API é garantida pelos
> golden tests da Fase 1. Cada task atualiza também os nomes de tabela/coluna (`wa_instance`,
> `auth_token`) na função tocada.

### Task 13: `send-message` usa `buildSend`

**Files:**
- Modify: `supabase/functions/send-message/index.ts`

**Interfaces:**
- Consumes: `getProvider`, `OutboundMessage` de `_shared/wa/index.ts`.

- [ ] **Step 1:** No SELECT da instância (`:131`), trocar `from("zapi_instance").select("instance_id, token, client_token")` por `from("wa_instance").select("provider, instance_id, base_url, auth_token, client_token, alias")`. Montar `creds: InstanceCreds`.
- [ ] **Step 2:** Substituir o bloco `:163-218` (montagem de `base`/`headers`/`switch zapiBody`/delays/mentions) por:

```ts
import { getProvider, type OutboundMessage } from "../_shared/wa/index.ts";
// ...
const provider = getProvider(creds.provider);
const outbound: OutboundMessage = {
  chatId: chat_id, phone, type: message_type, content: content ?? undefined,
  media: media_url ? { url: media_url, fileName: file_name } : undefined,
  caption: content ?? undefined, quotedProviderId: resolvedQuotedId,
  mentions: mentionedList, mentionsEveryone: !!mentions_everyone, isGroup: !!chat.is_group,
  delayTyping: delay_typing, delayMessage: delay_message,
};
const built = await provider.buildSend(creds, outbound);
const r = await fetch(built.url, { method: built.method, headers: built.headers, body: built.body });
if (!r.ok) throw new Error(`${creds.provider} ${r.status}: ${await r.text()}`);
const realId = provider.parseSendResult(await r.json()).providerMsgId || `sent-${tempId}`;
```

Mantém intactos: rate limit, insert `messages` pending, resolução de `quoted_msg_id` (`:167-181`), update final. A resolução de `mentions_everyone` agora é responsabilidade do `buildSend` do provider — remova `fetchGroupParticipants` daqui (migrou pro adapter Z-API).
- [ ] **Step 3:** Deploy + smoke (instância Z-API): `send` texto e imagem → entregue, `provider_msg_id` setado.
- [ ] **Step 4: Commit**

```bash
git add supabase/functions/send-message/index.ts
git commit -m "refactor(send-message): usa WaProvider.buildSend (agnostico de provider)"
```

---

### Task 14: `send-voice` usa `buildSend`

**Files:**
- Modify: `supabase/functions/send-voice/index.ts`

- [ ] **Step 1:** Trocar SELECT (`:143`) para `wa_instance` + colunas neutras; montar `creds`. Trocar nomes `zapi_action_log`→`wa_action_log` (`:58,174,208,296,312`).
- [ ] **Step 2:** Substituir o bloco Z-API `:260-277` por:

```ts
import { getProvider } from "../_shared/wa/index.ts";
// ... após gerar signed.signedUrl:
const provider = getProvider(creds.provider);
const built = await provider.buildSend(creds, { chatId: chat_id, phone, type: "ptt", media: { url: signed.signedUrl } });
const sendAbort = AbortSignal.timeout(ZAPI_TIMEOUT_MS);
const res = await fetch(built.url, { method: built.method, headers: built.headers, body: built.body, signal: sendAbort });
if (!res.ok) throw new Error(`${creds.provider} audio ${res.status}: ${(await res.text()).slice(0,200)}`);
const realId = provider.parseSendResult(await res.json()).providerMsgId || `sent-${tempId}`;
```
- [ ] **Step 3:** Deploy + smoke (Z-API): `send-voice` entrega PTT.
- [ ] **Step 4: Commit**

```bash
git add supabase/functions/send-voice/index.ts
git commit -m "refactor(send-voice): usa WaProvider.buildSend (ptt agnostico)"
```

---

### Task 15: `process-webhook` vira orquestrador agnóstico

**Files:**
- Modify: `supabase/functions/process-webhook/index.ts`

**Interfaces:**
- Consumes: `getProvider`, `InboundEvent` de `_shared/wa/index.ts`.

- [ ] **Step 1:** Após `payload = await req.json()` e do insert em `webhook_events_raw` (mantém igual, `:211-219`), substituir o roteamento atual (`routeEvent` + handlers) por:

```ts
import { getProvider, type InboundEvent } from "../_shared/wa/index.ts";

// detecta provider tentando os adapters registrados
const provider = [getProvider("zapi"), getProvider("evolution")].find(p => p.matchesWebhook(payload));
if (!provider) { /* log unhandled + 200 */ return ok(); }

const instKey = provider.webhookInstanceKey(payload);
const { data: creds } = await supabase.from("wa_instance")
  .select("provider, instance_id, base_url, auth_token, client_token, alias, webhook_token")
  .eq("instance_id", instKey).maybeSingle();
// auth (mantém WEBHOOK_REQUIRE_AUTH + TOFU para zapi aqui no orquestrador)
if (REQUIRE_AUTH && !provider.verifyWebhookAuth(payload, req.headers, creds)) { /* TOFU zapi … */ }

let events: InboundEvent[] = await provider.normalizeInbound(payload, creds!);
if (provider.resolveChatIds) events = await provider.resolveChatIds(events, creds!, { supabase });

for (const ev of events) await dispatch(ev, creds!, provider);
```

- [ ] **Step 2:** Reescrever os handlers existentes (`handleReceived/Status/Reaction/Edited/Revoked/GroupNotif/Connection`) como uma função `dispatch(ev, creds, provider)` que faz `switch (ev.kind)` e executa **os mesmos upserts/inserts de hoje**, lendo do `InboundEvent` neutro em vez do payload Z-API cru. Para `kind:"message"` com `ev.media`, chamar `provider.fetchMedia(creds, ev.media)` e gravar os bytes no Storage (porta `downloadMediaToStorage` `:477-503`, mas recebendo bytes em vez de baixar URL — a busca agora é do provider). `instance_id` vem de `creds.instance_id`.
- [ ] **Step 3:** Atualizar `handleConnection` (`:426-428`) e qualquer `from("zapi_instance")` → `wa_instance`. Remover `resolveLidToPhone`/`resolveChatIdFromPayload`/`extractMediaInfo` locais (migraram pro adapter Z-API).
- [ ] **Step 4:** Deploy + smoke: enviar/receber numa instância **Z-API** → mensagens, mídia, reações, status idênticos a antes (compara com `webhook_events_raw`).
- [ ] **Step 5: Commit**

```bash
git add supabase/functions/process-webhook/index.ts
git commit -m "refactor(process-webhook): orquestrador agnostico (normalizeInbound + dispatch neutro)"
```

---

### Task 16: `zapi-proxy` → `wa-proxy` (provider-aware)

**Files:**
- Create: `supabase/functions/wa-proxy/index.ts` (a partir de `zapi-proxy/index.ts`)
- Modify: `supabase/config.toml` (adicionar `[functions.wa-proxy] verify_jwt = true`, espelhando `zapi-proxy`)
- Remove: `supabase/functions/zapi-proxy/` (após Task 17 reapontar o caller)

**Interfaces:**
- Consumes: `getProvider`, `WaAction` de `_shared/wa/index.ts`.

- [ ] **Step 1:** Copiar `zapi-proxy/index.ts` → `wa-proxy/index.ts`. Trocar `zapi_instance`→`wa_instance` (cols neutras), `zapi_action_log`→`wa_action_log`.
- [ ] **Step 2:** Substituir a montagem de URL Z-API (`:276-299`) por:

```ts
import { getProvider } from "../_shared/wa/index.ts";
const provider = getProvider(creds.provider);
let resultBody: unknown, resultStatus: number;
if (action === "status") {
  const built = provider.buildAction(creds, "status", {});
  const r = await fetch(built!.url, { method: built!.method, headers: built!.headers, signal: AbortSignal.timeout(ZAPI_TIMEOUT_MS) });
  resultStatus = r.status; resultBody = provider.parseConnection(await r.json());
} else if (action === "chats") {
  resultBody = await provider.fetchGroups(creds); resultStatus = 200;
} else {
  const built = provider.buildAction(creds, action, params);
  if (!built) return json({ error: "not_supported_by_provider", action, provider: creds.provider }, 400);
  const r = await fetch(built.url, { method: built.method, headers: built.headers, body: built.body, signal: AbortSignal.timeout(ZAPI_TIMEOUT_MS) });
  resultStatus = r.status; const t = await r.text(); try { resultBody = JSON.parse(t); } catch { resultBody = t; }
}
```

Mantém intactos: allowlist, `confirmed`, idempotência, rate limit, audit log.
- [ ] **Step 3:** Deploy `wa-proxy`. Smoke (Z-API): `wa-proxy` `status` retorna `{connected}` normalizado; `send-reaction` reage.
- [ ] **Step 4: Commit**

```bash
git add supabase/functions/wa-proxy/index.ts supabase/config.toml
git commit -m "feat(wa-proxy): gateway de acoes agnostico (buildAction) — substitui zapi-proxy"
```

---

### Task 17: `mcp-api` aponta para `wa-proxy` + provider-aware

**Files:**
- Modify: `supabase/functions/mcp-api/index.ts`

- [ ] **Step 1:** `loadInstances` (`:104`): `from("zapi_instance")` → `from("wa_instance")` e incluir `provider` no select.
- [ ] **Step 2:** Trocar todas as chamadas `callEdge("zapi-proxy", …)` → `callEdge("wa-proxy", …)` (linhas `414, 780, 795, 807, 817, 854`).
- [ ] **Step 3:** `status` (`:422`): como `wa-proxy` agora retorna `{connected}` normalizado, simplificar para `connected: zapiData?.connected ?? false` (mantém o campo `zapi:` como `provider:` opcional). `sync_groups` (`:854-864`): `wa-proxy` action `chats` agora retorna `NeutralGroup[]` → ler `chatId`/`name` diretamente (remove o garimpo de campos `phone/id/chatId/subject/...`).
- [ ] **Step 4:** Edit message (`:795`) usa `params.editMessageId` — confirmar que o adapter Evolution roteia isso pra `chat/updateMessage` (Task 11). Para Z-API, mantém `send-text` com `editMessageId` (comportamento atual).
- [ ] **Step 5:** Deploy. Smoke: tools `status`, `react`, `sync_groups` na instância Z-API inalteradas.
- [ ] **Step 6: Commit**

```bash
git add supabase/functions/mcp-api/index.ts
git commit -m "refactor(mcp-api): chama wa-proxy + status/sync_groups via provider neutro"
```

---

### Task 18: Remover `zapi-proxy` + fallback de Storage na mídia

**Files:**
- Remove: `supabase/functions/zapi-proxy/`
- Modify: `supabase/config.toml` (remove `[functions.zapi-proxy]`)
- Modify: `supabase/functions/transcribe-queue/index.ts`, `supabase/functions/retry-media/index.ts`

- [ ] **Step 1:** Confirmar (grep) que nada mais referencia `zapi-proxy`; remover a pasta e a entrada no `config.toml`. Rodar `supabase functions delete zapi-proxy` faz parte do upgrade (documentado na Task 20), não do código.
- [ ] **Step 2:** `transcribe-queue` (`:139-142`) e `retry-media` (`:6-10`): quando `media.original_url` for `NULL` (caso Evolution — mídia já está no Storage), baixar do Storage via `supabase.storage.from(media.storage_bucket).createSignedUrl(media.storage_path, 300)` em vez de `fetch(original_url)`. Quando `original_url` existir (Z-API), comportamento atual.
- [ ] **Step 3:** `zapi_action_log`→`wa_action_log` em qualquer referência remanescente (grep no diretório `functions/`).
- [ ] **Step 4:** Deploy. Smoke: transcrição de um áudio recebido funciona nos dois caminhos.
- [ ] **Step 5: Commit**

```bash
git add -A supabase/functions/ supabase/config.toml
git commit -m "chore: remove zapi-proxy + fallback Storage p/ midia sem original_url (Evolution)"
```

---

## Fase 5 — Setup + documentação

### Task 19: Setup skill com escolha de provider

**Files:**
- Modify: `.claude/skills/setup/SKILL.md`

- [ ] **Step 1:** No passo 0/1, adicionar a **escolha do provider** e um passo explícito de **registro da instância** (`INSERT INTO wa_instance(provider, instance_id, base_url, auth_token, client_token, alias, webhook_url, is_default, is_active) VALUES (...)`), com os dois caminhos:
  - **Z-API:** `provider='zapi'`, `auth_token`=token, `client_token`=client-token, `base_url=NULL`; passo de webhook como hoje (atualizado pra `wa_instance`).
  - **Evolution:** `provider='evolution'`, `instance_id`=nome da instância, `auth_token`=apikey, `client_token=NULL`, `base_url`=URL do servidor; configurar webhook via:
    ```bash
    curl -s -X POST "$EVO_BASE/webhook/set/$EVO_INSTANCE" -H "apikey: $EVO_APIKEY" -H "Content-Type: application/json" -d '{
      "webhook": { "enabled": true, "url": "'"$HOOK"'", "byEvents": false, "base64": false,
        "headers": { "authorization": "Bearer '"$WEBHOOK_SECRET"'", "Content-Type": "application/json" },
        "events": ["MESSAGES_UPSERT","MESSAGES_UPDATE","MESSAGES_DELETE","SEND_MESSAGE","CONNECTION_UPDATE","CONTACTS_UPDATE","GROUPS_UPSERT","GROUP_PARTICIPANTS_UPDATE"] } }'
    ```
- [ ] **Step 2:** Documentar que Evolution é **self-hosted** (pré-requisito: servidor rodando com https + apikey; link ao docker-compose oficial), sem detalhar o provisionamento.
- [ ] **Step 3: Commit**

```bash
git add .claude/skills/setup/SKILL.md
git commit -m "docs(setup): escolha de provider (zapi|evolution) + registro de instancia + webhook Evolution"
```

---

### Task 20: MIGRATION.md, CHANGELOG, README

**Files:**
- Modify: `MIGRATION.md`, `CHANGELOG.md`, `README.md`

- [ ] **Step 1:** `MIGRATION.md` — seção "Upgrade para v3.0 (multi-provider)" com o procedimento: `git pull` → `supabase db push` → `supabase functions deploy` → `supabase functions delete zapi-proxy` (opcional) → verificação `SELECT provider, count(*) FROM wa_instance GROUP BY provider;` + smoke `status`. Garantias: dados preservados, instâncias antigas viram `zapi`, views de compat cobrem janela de upgrade.
- [ ] **Step 2:** `CHANGELOG.md` — entrada **v3.0**: multi-provider (Z-API + Evolution); breaking interno (rename `wa_instance`/`wa_action_log`, `wa-proxy`); upgrade automático via db push + deploy; Z-API segue funcionando; views de compat depreciadas.
- [ ] **Step 3:** `README.md` — seção "Provedores de WhatsApp (Z-API vs Evolution API)" explicando a escolha por instância e o pré-requisito self-hosted da Evolution.
- [ ] **Step 4: Commit**

```bash
git add MIGRATION.md CHANGELOG.md README.md
git commit -m "docs: guia de upgrade v3.0 + changelog + secao de providers no README"
```

---

## Self-Review (preenchido)

- **Cobertura do spec:** modelo neutro (T1), jid (T2), interface+factory (T3), adapter Z-API completo
  (T4-7), adapter Evolution completo (T8-11), migration rename+views (T12), wiring send-message/voice/
  webhook/wa-proxy/mcp-api/mídia (T13-18), setup+docs+upgrade (T19-20). Sem lacunas.
- **Placeholders:** tasks de adapter trazem código/teste; tasks de wiring trazem o bloco novo + linhas-
  fonte a portar (refactor, não invenção). Sem "TODO/TBD".
- **Consistência de tipos:** `InstanceCreds`/`OutboundMessage`/`InboundEvent`/`MediaRef`/`BuiltRequest`/
  `WaProvider` definidos em T1/T3 e usados com os mesmos nomes em T4-18.

## Notas de execução

- Suíte de testes dos adapters: `deno test supabase/functions/_shared/wa/`.
- Fixtures reais: capturar de `webhook_events_raw` (Z-API) e do servidor Evolution do usuário; commitar
  em `__tests__/fixtures/` (sem segredos — limpar tokens/apikey dos payloads).
- Ordem obrigatória: Fase 0 → 1 → 2 antes de tocar edge functions (Fase 4). A migration (Fase 3) pode
  ir junto com a Fase 4, mas **antes** do deploy das functions novas.
