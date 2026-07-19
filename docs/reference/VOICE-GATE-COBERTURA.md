# Voice gate — matriz de cobertura (censo das 27 tools)

> Inventário auditado 19/07/2026 (conselho de encerramento, caixa 1). Congelado pelo
> guard `supabase/functions/_shared/wa/__tests__/gate-coverage-guard.test.ts`, que
> quebra se uma tool ou action de envio nova aparecer sem classificação.
>
> **Regra:** todo parâmetro que **renderiza visível pro destinatário** (texto-que-sai)
> tem de passar pelo `runVoiceGate`. O gate só avalia o que está no array `texts` — o
> que fica de fora escapa. Cada célula é `GATEADO`, `JUSTIFICADO` (parece texto mas não
> precisa) ou `FURO` (era texto-que-sai fora do gate → **corrigido nesta rodada**).

## Como rodar a verificação

```bash
deno task test        # suite completa (161 testes), inclui o guard de cobertura
deno task test:gate   # só o guard
```

## Matriz

| tool | categoria | texto-que-sai | status |
|---|---|---|---|
| status, inbox, read, search, list_categories, list_scheduled, get_voice_guide, check_message, check_delivery, setup_voice_guide, download_attachment, transcribe_audio | readonly | — | n/a |
| resolve_chat, uncategorize_chat, sync_groups, merge_ghost_chats, cancel_scheduled, delete_message | controle/interno | — (não emite texto) | n/a |
| categorize_chat, annotate_chat | interno | notes, observations, links, voice_profile | JUSTIFICADO (só no read do agente, não sai) |
| **send** | envio | content, link.title, link.description, **file_name** | GATEADO |
| send | envio | link.url, link.image, image | JUSTIFICADO (URL/bytes, não prosa) |
| **send_voice** | envio | text (vira fala TTS) | GATEADO |
| **send_image** | envio | caption | GATEADO |
| **edit_message** | envio | new_content | GATEADO |
| **schedule** | envio | items[].content, .question, .options, .link.title/description, **.file_name** | GATEADO (via `scheduleGateTexts`) |
| **zapi_action** | envio | message, body, text, caption, **fileName/file_name**, **groupName**, options, **poll[].name** | GATEADO (via `zapiGateTexts`, só actions em `ZAPI_SEND_ACTIONS`) |
| react | envio (reação) | emoji | JUSTIFICADO (1 emoji, sem prosa; regras hard não incidem) |

Todas as 27 classificadas. Tools de envio: send, send_voice, send_image, edit_message, schedule, zapi_action, react.

## Furos fechados nesta rodada (censo 19/07)

Todos eram texto-que-sai que **escapava** do gate — corrigidos e provados em prod:

1. **`file_name` de documento** (send, schedule, zapi_action send-document): o nome do arquivo é o **rótulo visível** do documento na bolha. Um PDF com `file_name: "Olá—proposta.pdf"` carregava saudação + em-dash (2 regras hard) sem gate. → `file_name` entra no array do `send`, em `scheduleGateTexts` e em `zapiGateTexts`.
2. **`poll[].name` no zapi_action send-poll**: o shape nativo Z-API é `poll:[{name}]`, mas o gate só lia `options` plano — os **rótulos das opções** escapavam (a pergunta era gateada). → `zapiGateTexts` passa a ler `poll[].name`.
3. **`groupName` de create-group**: assunto de grupo visível a todos os participantes; a action nem estava em `ZAPI_SEND_ACTIONS` (sem gate nem confirmação). → `create-group` entrou no set e `groupName` no `zapiGateTexts`.

Antecedente (rodada 19/07 manhã, mesma classe): `link.title/description` do card de preview e as actions de mídia `send-image/video/document` também escapavam — daí o guard, pra que a **classe** não reabra a cada tool nova.

## Fora de escopo (risco aceito e documentado)

- **Texto embutido em imagem** (`send_image` bytes): o gate é textual (regex sobre strings), não faz OCR. A `caption` é o texto gateável.
- **forward / forward-message**: referenciam `messageId` existente; não há prosa nova injetada pelo agente.
- **Instagram via claude.ai**: check server-side próprio (mais fraco, flags cooperativas sem trilha) — fora do escopo do WhatsApp Agent.
