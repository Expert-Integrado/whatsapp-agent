---
name: nutrir-contatos
description: Rotina diária de nutrição do vault de contatos (expert-contacts) a partir das conversas do WhatsApp E do Instagram. Lê as mensagens novas do dia (digest incremental dos dois canais), extrai fatos ditos pelas pessoas ("mudei de casa", "estou com dificuldade em X") e interações reais, registra na timeline de quem JÁ é contato e mescla contexto durável na visão geral do perfil. Contato novo no vault dispara varredura do histórico completo dele (backfill), e o passado dos contatos existentes é varrido em lotes diários. TRIGGER quando o dono pedir "nutre os contatos", "roda a nutrição", ou no agendamento diário (fim do dia). NÃO dispara pra ler/responder uma conversa específica, nem pra importar contatos novos (a nutrição não cria contato comum; a ÚNICA criação permitida é o contato MAPEADO do Passo 3.5, em grupo com categoria mapear ligada).
---

# Nutrir contatos a partir das conversas (WhatsApp + Instagram)

Transforma conversa em memória de relacionamento: o que as pessoas contam no WhatsApp
(grupos e privado) e nas DMs do Instagram vira evento na timeline do contato no vault
(expert-contacts), e fato relevante vira observação que alimenta a busca semântica
("quem está com dificuldade de contratar?").

## SEMPRE

- Registrar SÓ em quem JÁ existe no vault (política conservadora, a mesma da sync de
  grupos). Remetente sem contato correspondente é pulado em silêncio.
- Fato registrado EXPLÍCITO na mensagem. Na dúvida, pula.
- Incremental: o digest usa cursor por chat (`nurture_state` no WhatsApp,
  `ig_nurture_state` no Instagram) — mensagem nunca é reprocessada. O cursor só avança
  DEPOIS dos eventos registrados (commit separado).
- Máximo 3 observações por pessoa por rodada. Qualidade > cobertura.
- Escrever no vault SEMPRE pelo id da entidade (`save_person` com `id`, `log_event`
  com `entity_id`) — nunca gravar por telefone (bug conhecido de phoneVariants no
  worker cria entidade duplicada).
- `attributes` é JSON substituído por inteiro no `save_person`: ler o atual
  (`get_entity`), mesclar no cliente e mandar o objeto completo.

## NUNCA

- Criar contato novo de categoria comum (nem quando o remetente parece importante —
  pulado vira sugestão no relatório, o dono decide criar). Única exceção: contato
  MAPEADO via Passo 3.5, com os dois gates satisfeitos.
- Apagar ou sobrescrever informação existente no perfil (a visão geral só CRESCE por
  mescla; campo estruturado como e-mail/empresa/cargo só é preenchido se estiver VAZIO).
- Registrar: opinião de terceiro sobre a pessoa, fofoca, conteúdo encaminhado, piada ou
  figurinha, negociação comercial com valores/proposta em andamento (é CRM, não dossiê
  pessoal — INTERESSE em produto/mentoria pode), inferência que a mensagem não sustenta
  literalmente.
- Avançar cursor antes de registrar os eventos da rodada.

## Pré-requisitos

- MCP `expert-contacts` conectado na sessão (tools `get_contact_by_phone`, `log_event`,
  `get_entity`, `list_entities`, `save_person`, `recall`).
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` no ambiente ou em `mcp/.env` deste repo.
- Instagram (opcional): repo `C:/repos/instagram-agent` presente na máquina — sem ele,
  a rodada cobre só o WhatsApp e o relatório avisa.

## Passo 1 — Gerar os digests

```bash
node scripts/nurture-digest.mjs digest --out /tmp/nurture-digest.json
node C:/repos/instagram-agent/scripts/nurture-digest.mjs digest --out /tmp/ig-nurture-digest.json
```

Cada um lê as mensagens novas por chat (default: últimas 24h no primeiro run; depois,
do cursor em diante). Read-only. O JSON do WhatsApp traz, por chat: `instance_id`,
`chat_id`, `name`, `is_group`, `phone`, `since`, `truncated` e as mensagens (`ts`,
`from_me`, `sender_phone`, `sender_name`, `text`, `reply_to`). O do Instagram traz,
por DM: `ig_user_id`, `igsid`, `username`, `name`, `since`, `truncated` e mensagens
(`ts`, `from_me`, `type`, `by_agent`, `text`) — só entram DMs onde a PESSOA escreveu
algo novo (outbound de campanha fica de fora por construção).

Se os dois vierem vazios: reportar "nada novo" e encerrar (sem commit).

## Passo 2 — Resolver quem é quem

Pra cada chat do digest:

- **Chat privado** (`is_group: false`): resolver `phone` do chat com
  `get_contact_by_phone`. Sem match → pular o chat inteiro.
- **Grupo** (`is_group: true`): resolver cada `sender_phone` distinto das mensagens
  (ignorar `from_me: true`). Só os remetentes com match viram alvo de registro.
- **DM do Instagram**: não tem telefone — resolver por identidade: `recall` com o
  `name`/`username` e conferir no resultado o canal `instagram` (`@username` bate) ou
  o nome. Match ambíguo = pular (mesma política conservadora).

Cachear os lookups na sessão (mesmo telefone aparece em vários chats). Dois chats
privados podem resolver pro MESMO contato (chat normal + chat fantasma `@lid` do
mesmo número, ou WhatsApp + Instagram da mesma pessoa): tratar como uma conversa só
na hora de registrar.

## Passo 3 — Extrair e registrar

Ler as mensagens do chat em ordem e classificar o que registrar em quem:

**a) Observação episódica (evento)** — a pessoa CONTOU algo datado e IMPORTANTE sobre
a própria vida/negócio: mudança (casa, cidade, emprego), decisão tomada (demitiu,
contratou, lançou, fechou contrato), dificuldade/necessidade explícita ("estou penando
com X", "preciso de Y"), marco pessoal (casamento, filho, saúde mencionada abertamente).

```
log_event(entity_id, kind='note', source='whatsapp'|'instagram', ts=<ts da mensagem>,
          context='<fato em 1-2 frases, começando pelo verbo> — dito em <nome do chat>')
```

- Barra ALTA: evento é pra marco, não pra conversa comum — senão a timeline vira spam
  diário. Contexto menor e acumulativo vai pra visão geral (item b), não pra timeline.
- `kind='note'` reindexa o vetor do contato — o fato entra na busca semântica.
- Saúde, finanças pessoais, conflito familiar ou qualquer coisa que a pessoa claramente
  contou em confiança → `private: true` (fica fora da busca e da timeline de agentes
  sem escopo).

**b) Visão geral do contato (perfil)** — fato durável ("é advogado tributarista",
"virou sócio da empresa X") e contexto acumulativo relevante entram MESCLADOS na visão
geral do contato: ler o `notes_text` atual (`get_entity`) e regravar via `save_person`
com o texto enriquecido — prosa curta, o que já existia + o que é novo, sem duplicar.
Campos estruturados (e-mail, empresa, cargo) só são preenchidos se estiverem VAZIOS.
Toda edição de perfil aparece no relatório final (o dono audita).

**c) Interação real** — em chat PRIVADO/DM com troca de verdade (mensagens nos dois
sentidos, `from_me` e recebidas; no Instagram, `by_agent: true` NÃO conta como troca —
é o agente/campanha, não o dono): UM evento por CONTATO por rodada (não por chat —
a mesma pessoa pode aparecer em dois chats, ver Passo 2):

```
log_event(entity_id, kind='talked', source='whatsapp'|'instagram', ts=<ts da última mensagem>,
          context='Conversa no WhatsApp — <tema em meia frase>')
```

`kind='talked'` atualiza o `last_contacted` do contato. Grupo NÃO gera evento de
interação (viraria spam de timeline) — grupo só gera observação (item a).

**d) Campos estruturados e attributes** (padrão validado no backfill em massa de
10/07/2026 — 2.179 contatos):

- **Aniversário** → coluna nativa `birthday` do `save_person`, SÓ se vazia. Parsing
  conservador: apenas dia+mês exatos declarados ("meu aniversário é 15/03");
  aproximações ("por volta de", "início de março") NUNCA viram data. Sem ano
  conhecido, formato `0000-MM-DD` (convenção do sync Google).
- **Cidade / família / interesses** → `attributes.cidade` (string),
  `attributes.familia` (string), `attributes.interesses` (array) — só se ausentes.
  O dossiê renderiza os três como fields.
- **Relação** (cliente/aluno/parceiro/família/pessoal/network/equipe/fornecedor):
  atualizar `category` SÓ com evidência de confiança ALTA na conversa E quando a
  category atual está vazia ou `lead`. Confiança média → `attributes.relacao_sugerida`
  (dado interno de curadoria, não aparece no dossiê) — e só se ainda não houver
  sugestão nem category firme.
- **Grupos em comum** → `attributes.shared_groups`, array de `{chat_id, name}`
  (o dossiê linka pra página do grupo quando ele existe no vault via
  `whatsapp_links`). Contato apareceu num grupo novo no digest = mesclar a entrada.
- **Instagram** → SÓ quando o PRÓPRIO contato declara o handle DELE na conversa
  ("meu insta é @fulano", link do próprio perfil). NUNCA inferir de nome parecido,
  post de terceiro ou link compartilhado.

O que fica de fora está no bloco **NUNCA** acima — na dúvida entre registrar e pular,
pular.

## Passo 3.5 — Grupos mapeados (contatos que o dono nunca falou)

> Decisão do dono em 10/07/2026 (nota `fh39xlmxi973` no Brain): grupos de networking
> marcados como "mapear" geram contato de categoria `mapeado` pra quem ainda não está
> no vault — um sub-vault desligado, invisível nas buscas, esperando o dia em que o
> dono encontra a pessoa.

**Gates — os DOIS precisam passar, senão pular este passo em silêncio (1 linha no
relatório) e seguir com o comportamento padrão:**

1. **Grupo ligado**: o chat do grupo tem a categoria de chat `mapear` (consultar
   `v_chats_with_categories` via REST: `category_slugs` contém `mapear`). Grupo sem
   ela = ignorado por este passo (remetente sem match continua pulado em silêncio).
2. **Worker pronto**: `GET /canon` do expert-contacts retorna `mapeado` em
   `contact_categories`. Enquanto o deploy não sai (task `9zfjcquprh03`), este passo
   inteiro fica dormente.

**Pra cada remetente SEM match no vault em grupo ligado:**

- Aplicar os MESMOS critérios do Passo 3a: só interessa fato digno de histórico
  (marco de vida/negócio, dificuldade explícita, relação com o dono). **Sem fato
  digno = não cria nada** — quem só deu bom dia nunca ganha entidade.
- Com fato digno: conferir de novo `get_contact_by_phone` (o lookup inclui mapeados)
  e só então criar:
  ```
  save_person(name=<sender_name do digest; sem nome: 'Mapeado +<fone formatado>'>,
              phones=[sender_phone], category='mapeado', source='whatsapp')
  ```
  Depois registrar o(s) fato(s) por `entity_id` (Passo 3a) e `attributes.shared_groups`
  (Passo 3d). Regras de privacidade e máximo de observações valem igual.
- Cap de segurança: no máximo 15 mapeados novos por rodada — excedente vira lista no
  relatório (o dono decide se roda de novo).

## Passo 3.6 — Reuniões do dia (Meeting Hub)

> Backfill histórico de reuniões CONCLUÍDO em 11/07/2026 (176 reuniões desde 30/05,
> 49 eventos gravados). Este passo cobre só o delta diário.

Gate: `MEETINGHUB_SUPABASE_URL`/`MEETINGHUB_SERVICE_ROLE_KEY` no `mcp/.env`. Ausentes =
pular com 1 linha no relatório.

```bash
node scripts/meetings-digest.mjs digest --out /tmp/meetings-digest.json
```

Pra cada reunião do digest (já vem só com `resumo` de extração pronto):

- Participante EXTERNO apenas: ignorar time (`@expertintegrado` no email, Eric) e bots
  de gravação (Fireflies, tldv, "Meeting Assistant", "Usuário").
- Resolver contra o vault: email exato primeiro; senão nome completo ÚNICO
  (`search_contacts`). Sem match = pular (lead de CRM não vira contato — vai como
  contagem no relatório; com a política de mapeados ativa, ver Passo 3.5, também não:
  reunião não é grupo mapeado).
- Registrar UM evento por contato por reunião:
  ```
  log_event(entity_id, kind='meeting', source='manual', ts=<started_at>,
            context='Reunião Zoom: <topic>. <resumo em até 2 frases, SEM valores/proposta>')
  ```
- Ao final, avançar o cursor com o `started_at` da ÚLTIMA reunião processada:
  ```bash
  node scripts/meetings-digest.mjs commit --ts "<started_at>"
  ```
  (mesma regra dos outros cursores: só avança DEPOIS dos eventos gravados)

## Passo 4 — Avançar os cursores

Montar `/tmp/nurture-commit.json` com UMA linha por chat processado (inclusive os que
não geraram evento — o cursor avança do mesmo jeito):

```json
[{ "instance_id": "...", "chat_id": "...", "last_processed_ts": "<ts da última mensagem lida>", "events_registered": 2 }]
```

```bash
node scripts/nurture-digest.mjs commit --file /tmp/nurture-commit.json
```

Instagram: mesmo desenho, chaves próprias (`ig_user_id` + `igsid`):

```bash
node C:/repos/instagram-agent/scripts/nurture-digest.mjs commit --file /tmp/ig-nurture-commit.json
```

Chat com `truncated: true` bateu no cap de mensagens — o cursor avança até onde foi
lido e a próxima rodada continua de lá.

Chat com `also_commit` existe em mais de uma instância (o digest deduplicou as
mensagens): adicionar UMA linha extra por entrada, com o MESMO `chat_id` e o
`instance_id`/`last_processed_ts` da entrada — senão a outra instância reprocessa
o chat na próxima rodada.

## Passo 5 — Varredura de histórico (contato novo + backfill do passado)

> **Backfill histórico em massa CONCLUÍDO em 10/07/2026** (pipeline de squads: 2.179
> contatos nutridos com timeline/relação/perfil, 3.215 telefones marcados em
> `nurture_backfill`). Na prática este passo agora serve quase só a CONTATOS NOVOS —
> o lote diário de antigos tende a voltar vazio, o que é o esperado.

Além do digest do dia, cada rodada faz a varredura COMPLETA de alguns contatos — uma
única vez por contato, controlada pela tabela `nurture_backfill`:

1. **Contatos novos primeiro**: `list_entities(kind='person', limit=...)` no vault,
   filtrar quem tem telefone e entrou desde a última rodada (`created_at`). Quem o dono
   acabou de salvar tem prioridade — provavelmente já conversou em grupos antes de
   virar contato, e é esse passado que a varredura resgata.
2. **Completar o lote** (default 10 contatos/rodada, `NURTURE_BACKFILL_BATCH`) com
   contatos antigos que têm telefone: checar quem falta com
   `node scripts/nurture-digest.mjs backfill-status --phones <lista>`.
3. Pra cada contato do lote:
   ```bash
   node scripts/nurture-digest.mjs history --phone <fone> --out /tmp/hist-<fone>.json
   ```
   (histórico completo: chats privados dele + tudo que ele falou em grupos). Extrair
   com os MESMOS critérios do Passo 3: visão geral mesclada no perfil + no máximo 3-5
   eventos pros marcos realmente importantes (com `ts` da mensagem original, pra
   timeline ficar cronológica).
4. Marcar: `node scripts/nurture-digest.mjs backfill-done --phone <fone> --entity <id>
   --msgs <total_messages>`. Sem mensagem no banco = marcar com `--msgs 0` do mesmo
   jeito (não re-tentar todo dia).

Instagram: contato com canal `instagram` no vault tem o mesmo tratamento, com o script
de lá (`history --username <handle>`, controle em `ig_nurture_backfill` via
`backfill-status --igsids` / `backfill-done --igsid ... --entity ...`). O lote diário é
um só (WhatsApp + Instagram somados) — priorizar contatos novos de qualquer canal.

## Passo 6 — Reportar

Resumo curto pro dono: N chats lidos (WhatsApp + Instagram, discriminados), M eventos
registrados (1 linha por evento: quem + o quê), K perfis enriquecidos (visão
geral/backfill), contatos MAPEADOS criados (1 linha cada: nome/fone + grupo + fato —
ou "passo dormente: worker sem categoria mapeado" enquanto o gate 2 falhar), quem foi
pulado por não ser contato — com o fato que se perdeu, como
sugestão de contato novo pro dono aprovar — e quantos contatos ainda faltam no
backfill. Se o repo do Instagram não estava disponível, avisar que a rodada cobriu só
o WhatsApp.
