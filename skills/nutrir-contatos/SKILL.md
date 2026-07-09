---
name: nutrir-contatos
description: Rotina diária de nutrição do vault de contatos (expert-contacts) a partir das conversas do WhatsApp. Lê as mensagens novas do dia (digest incremental), extrai fatos ditos pelas pessoas ("mudei de casa", "estou com dificuldade em X") e interações reais, e registra na timeline de quem JÁ é contato no vault. TRIGGER quando o dono pedir "nutre os contatos", "roda a nutrição", ou no agendamento diário (fim do dia). NÃO dispara pra ler/responder uma conversa específica, nem pra importar contatos novos (a nutrição nunca cria contato).
---

# Nutrir contatos a partir das conversas do WhatsApp

Transforma conversa em memória de relacionamento: o que as pessoas contam no WhatsApp
(grupos e privado) vira evento na timeline do contato no vault (expert-contacts), e fato
relevante vira observação que alimenta a busca semântica ("quem está com dificuldade de
contratar?").

## SEMPRE

- Registrar SÓ em quem JÁ existe no vault (política conservadora, a mesma da sync de
  grupos). Remetente sem contato correspondente é pulado em silêncio.
- Fato registrado EXPLÍCITO na mensagem. Na dúvida, pula.
- Incremental: o digest usa cursor por chat (tabela `nurture_state`) — mensagem nunca
  é reprocessada. O cursor só avança DEPOIS dos eventos registrados (commit separado).
- Máximo 3 observações por pessoa por rodada. Qualidade > cobertura.

## NUNCA

- Criar contato novo (nem quando o remetente parece importante — isso é decisão do dono).
- Editar perfil de contato por conta própria (fato durável vira SUGESTÃO no relatório).
- Registrar: opinião de terceiro sobre a pessoa, fofoca, conteúdo encaminhado, piada ou
  figurinha, negociação comercial em andamento (é CRM, não dossiê pessoal), inferência
  que a mensagem não sustenta literalmente.
- Avançar cursor antes de registrar os eventos da rodada.

## Pré-requisitos

- MCP `expert-contacts` conectado na sessão (tools `get_contact_by_phone`, `log_event`).
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` no ambiente ou em `mcp/.env` deste repo.

## Passo 1 — Gerar o digest

```bash
node scripts/nurture-digest.mjs digest --out /tmp/nurture-digest.json
```

Lê as mensagens novas por chat (default: últimas 24h no primeiro run; depois, do cursor
em diante). Read-only. O JSON traz, por chat: `instance_id`, `chat_id`, `name`,
`is_group`, `phone`, `since`, `truncated` e as mensagens (`ts`, `from_me`, `sender_phone`,
`sender_name`, `text`, `reply_to`).

Se `chats` vier vazio: reportar "nada novo" e encerrar (sem commit).

## Passo 2 — Resolver quem é quem

Pra cada chat do digest:

- **Chat privado** (`is_group: false`): resolver `phone` do chat com
  `get_contact_by_phone`. Sem match → pular o chat inteiro.
- **Grupo** (`is_group: true`): resolver cada `sender_phone` distinto das mensagens
  (ignorar `from_me: true`). Só os remetentes com match viram alvo de registro.

Cachear os lookups na sessão (mesmo telefone aparece em vários chats). Dois chats
privados podem resolver pro MESMO contato (chat normal + chat fantasma `@lid` do
mesmo número): tratar como uma conversa só na hora de registrar.

## Passo 3 — Extrair e registrar

Ler as mensagens do chat em ordem e classificar o que registrar em quem:

**a) Observação episódica** — a pessoa CONTOU algo datado e relevante sobre a própria
vida/negócio: mudança (casa, cidade, emprego), decisão tomada (demitiu, contratou,
lançou, fechou contrato), dificuldade/necessidade explícita ("estou penando com X",
"preciso de Y"), marco pessoal (casamento, filho, saúde mencionada abertamente).

```
log_event(entity_id, kind='note', source='whatsapp', ts=<ts da mensagem>,
          context='<fato em 1-2 frases, começando pelo verbo> — dito em <nome do chat>')
```

- `kind='note'` reindexa o vetor do contato — o fato entra na busca semântica.
- Saúde, finanças pessoais, conflito familiar ou qualquer coisa que a pessoa claramente
  contou em confiança → `private: true` (fica fora da busca e da timeline de agentes
  sem escopo).

**b) Fato durável** — característica estável nova ("é advogado tributarista", "virou
sócio da empresa X"): NÃO é evento; anotar no relatório final como sugestão de edição
do contato (campo `notes_text` / cargo / empresa via `save_person`), pro dono aprovar.
A rotina não edita perfil sozinha.

**c) Interação real** — em chat PRIVADO com troca de verdade (mensagens nos dois
sentidos, `from_me` e recebidas): UM evento por CONTATO por rodada (não por chat —
o mesmo número pode aparecer em dois chats, ver Passo 2):

```
log_event(entity_id, kind='talked', source='whatsapp', ts=<ts da última mensagem>,
          context='Conversa no WhatsApp — <tema em meia frase>')
```

`kind='talked'` atualiza o `last_contacted` do contato. Grupo NÃO gera evento de
interação (viraria spam de timeline) — grupo só gera observação (item a).

O que fica de fora está no bloco **NUNCA** acima — na dúvida entre registrar e pular,
pular.

## Passo 4 — Avançar os cursores

Montar `/tmp/nurture-commit.json` com UMA linha por chat processado (inclusive os que
não geraram evento — o cursor avança do mesmo jeito):

```json
[{ "instance_id": "...", "chat_id": "...", "last_processed_ts": "<ts da última mensagem lida>", "events_registered": 2 }]
```

```bash
node scripts/nurture-digest.mjs commit --file /tmp/nurture-commit.json
```

Chat com `truncated: true` bateu no cap de mensagens — o cursor avança até onde foi
lido e a próxima rodada continua de lá.

Chat com `also_commit` existe em mais de uma instância (o digest deduplicou as
mensagens): adicionar UMA linha extra por entrada, com o MESMO `chat_id` e o
`instance_id`/`last_processed_ts` da entrada — senão a outra instância reprocessa
o chat na próxima rodada.

## Passo 5 — Reportar

Resumo curto pro dono: N chats lidos, M observações registradas (com 1 linha por
observação: quem + o quê), K interações, sugestões de fato durável (item 3b) pra ele
aprovar, e quem foi pulado por não ser contato (só a contagem).
