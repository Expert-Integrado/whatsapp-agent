---
name: estou-devendo
description: "Lista as conversas do WhatsApp em que o dono está devendo resposta (lead respondeu por último), filtradas por categoria opcional e ordenadas por urgência. Use quando o dono pedir 'do que estou devendo?', 'quem está esperando resposta?', 'me lembra das pendências de WhatsApp', ou similar."
argument-hint: "[--categoria=cliente,prospect] [--excluir=descartar,comunidade] [--dias=1] [--limit=20]"
allowed-tools: Bash, Read
---

Skill que lista as conversas onde o dono está devendo resposta no WhatsApp pessoal — quem mandou a última mensagem é o lead/contato, não o dono.

## Como funciona

1. Conecta no Supabase do projeto WhatsApp Agent (`<SUPABASE_PROJECT_ID>`).
2. Filtra conversas onde `last_received_at > last_sent_at` (pendência aberta).
3. Filtra `is_group=false` por padrão (grupos sempre geram falso positivo — alguém manda algo, o dono não deve nada a ninguém).
4. Aplica filtro de categoria se passado (`--categoria=cliente,prospect`) ou exclui categorias (`--excluir=descartar`).
5. Filtra `last_received_at` mais antiga que N dias (default: 1 dia — pendências recentes não importam).
6. Ordena por `last_received_at` ascendente — quem está esperando mais tempo aparece primeiro.
7. Limita a `--limit` resultados (default: 20).

## Variáveis de ambiente obrigatórias

- `SUPABASE_PAT` — Personal Access Token user-level
- `SUPABASE_SERVICE_ROLE` — Service Role Key do projeto whatsapp-agent

Mesmas vars da skill `transcrever-conversa`. No container claude-code da VPS já estão exportadas via `~/.whatsapp-agent.env`. Em Windows local: `$env:SUPABASE_PAT` e `$env:SUPABASE_SERVICE_ROLE`.

## Flags

- `--categoria=slug1,slug2` — só chats com pelo menos uma destas categorias
- `--excluir=slug1,slug2` — exclui chats com qualquer destas categorias (default: `descartar,comunidade`)
- `--dias=N` — só pendências com mais de N dias parado (default: 1). Use 0 pra incluir as de hoje.
- `--limit=N` — número máximo de chats no output (default: 20, max: 100)
- `--all-groups` — inclui grupos (não recomendado — gera ruído)
- `--with-snippet` — inclui snippet da última msg recebida (faz +N queries)

## Execução

```bash
python3 /home/node/.claude/skills/estou-devendo/scripts/estou_devendo.py $ARGUMENTS
```

Em Windows local:
```
"python3" "~/.claude/skills/estou-devendo/scripts/estou_devendo.py" $ARGUMENTS
```

## Após rodar

O script devolve JSON com:
- `total_pendencias`: total absoluto encontrado (antes do limit)
- `mostrando`: quantos retornados (após limit)
- `por_categoria`: contagem agrupada por categoria
- `chats`: array `[{ chat_id, chat_name, categories[], dias_parado, ultima_msg_recebida }]` ordenado por `dias_parado` desc

Use o output pra escrever um briefing curto pro dono:
- Liste no máximo top 10 (resto agrupa em "+N outros")
- Mostre o que cada lead está esperando, idealmente com snippet da última msg deles
- Agrupar por categoria quando relevante (3+ pendências da mesma categoria → seção separada)
- Tom direto, sem firula. Tipo "Você está devendo: 3 clientes (Cesar há 5d, ...), 2 prospects (...), 1 família (Camila há 2d)."

Se quiser detalhe de uma conversa específica, chama a skill `transcrever-conversa` ou usa o MCP `whatsapp-agent` (tool `read`).

## Exemplos de uso

```
estou-devendo
estou-devendo --categoria=cliente,prospect --dias=2
estou-devendo --excluir=descartar,comunidade,pessoal --limit=10
estou-devendo --categoria=familia --dias=0 --limit=5
```

## Observações

- **Grupos por padrão NÃO entram** porque mensagem em grupo não é "devendo resposta" pessoal. Use `--all-groups` se quiser conferir grupos também (raro).
- A skill **não envia mensagem** — só lista o que está pendente. O envio é via tool `send` do MCP whatsapp-agent (com `confirmed=true` explícito).
- Categoria precisa estar atribuída no DB pra filtro funcionar — chats sem categoria aparecem na listagem geral mas não no filtro `--categoria=X`.
- Pra atribuir categoria a um chat, usar tool `categorize_chat` do MCP (v2.3.0+).
