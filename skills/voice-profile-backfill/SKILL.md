---
name: voice-profile-backfill
description: Backfill do perfil de voz por contato (chats.voice_profile) a partir do histórico do WhatsApp. Varre DMs e grupos de cada contato, extrai como a pessoa chama o dono (vocativo => nível de intimidade) + gírias/registro dela, e grava o perfil que o agente espelha ao redigir (somado ao voice guide global). TRIGGER quando o dono pedir "roda o backfill de voice profile", "captura como cada um me chama", "perfil de linguagem dos contatos". NÃO dispara pra atualizar o perfil de UM contato (isso é annotate_chat direto com voice_profile), nem pra mexer no voice guide global.
---

# Backfill do voice profile por contato

Transforma histórico em espelhamento: o jeito que CADA pessoa fala com o dono (como o
chama, gírias, registro) vira `chats.voice_profile`, que o `read` devolve e o agente
espelha ao redigir — por cima do voice guide global, nunca no lugar dele.

## SEMPRE

- Análise via subagentes da sessão Claude Code (assinatura). NUNCA API Anthropic direta.
- `como_me_chama` só com vocativo LITERAL dirigido ao dono. Em grupo, só mensagem com
  `reply_to_me: true` ou menção explícita ao dono conta como evidência de vocativo.
- Gíria só com 2+ ocorrências (termo distintivo da pessoa, não português coloquial comum).
- Contato sem evidência suficiente: NÃO emitir perfil (fica NULL, re-analisável depois).
- Piloto antes do run completo: 10 contatos, revisão do dono, só então o resto.
- Commit gravando com `fonte: 'backfill'`; perfil existente com `fonte: 'manual'` é
  intocável (o script pula sem `--force`).

## NUNCA

- Inferir intimidade sem vocativo literal ("parece próximo" não é evidência).
- Usar mensagem encaminhada, piada/figurinha, ou fala de terceiro sobre a pessoa.
- Rodar sem `--instance` (o corpus recusa — instância errada contamina os perfis).
- Gravar perfil de grupo (voice_profile é por PESSOA, no chat privado dela).
- Rodar o commit do run completo sem OK do dono após o piloto.

## Pré-requisitos

- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` no ambiente ou em `mcp/.env` deste repo.
- Migration 0035 aplicada (coluna `chats.voice_profile`).

## Passo 1 — Gerar o corpus

```bash
node scripts/voice-profile-backfill.mjs corpus --instance pessoal --limit 10 --out C:/tmp/voice-profile-backfill
```

Piloto = `--limit 10`. Run completo = rodadas de `--limit 50`; o filtro
`voice_profile=is.null` faz cada rodada continuar de onde a anterior parou (após o
commit). Read-only. Cada batch JSON traz, por contato: `chat_id`, `chat_name`,
`dm_msgs` (inbound, transcrição de áudio incluída), `vocative_hits` (varredura
longitudinal — pega apelido antigo), `group_msgs` (com flag `reply_to_me`) e `stats`.

## Passo 2 — Analisar (1 subagente por batch)

Pra cada contato do batch, extrair:

| Campo | Regra |
|---|---|
| `como_me_chama` | vocativos literais dirigidos ao dono (ex: `["mano", "irmão"]`); em grupo, só com `reply_to_me` ou menção explícita |
| `girias` | até 10 termos distintivos com 2+ ocorrências (ex: `["top demais", "dale"]`) |
| `registro` | 1 linha (ex: "informal-íntimo, zoa, manda áudio longo") |
| `exemplos` | 2-3 citações literais ≤80 chars que mostram o tom |
| `confianca` | `alta` = vocativo 3+ vezes consistente; `media` = 2; `baixa` = 1 ocorrência ou só gíria |
| `fonte` | `'backfill'` |

Na dúvida entre registrar e pular, pular (perfil ruim é pior que perfil nenhum).

Consolidar tudo em `perfis.json`:

```json
[{ "instance_id": "...", "chat_id": "5511...", "voice_profile": { "como_me_chama": ["mano"], "girias": ["dale"], "registro": "...", "exemplos": ["..."], "confianca": "alta", "fonte": "backfill" } }]
```

## Passo 3 — Revisão do dono (gate)

Mostrar os perfis do piloto (tabela: contato, como_me_chama, gírias, confiança,
1 exemplo). Só seguir pro commit com OK explícito. No run completo, mostrar amostra +
contagens por rodada.

## Passo 4 — Commit

```bash
node scripts/voice-profile-backfill.mjs commit --file perfis.json
```

Grava via PATCH pela chave composta (`instance_id` + `chat_id`), valida 1 linha
afetada por perfil, preserva `fonte:'manual'`. Relatório: N gravados / M manuais
preservados / K falhas.

## Passo 5 — Reportar

Resumo pro dono: N contatos analisados, M perfis gravados, K pulados sem evidência,
distribuição de confiança, e 3-5 exemplos interessantes (quem chama o dono de quê).

## Daí pra frente (incremental)

O backfill é o pontapé. No dia a dia, ao ler uma conversa e notar vocativo/gíria nova,
o agente atualiza direto: `annotate_chat` com `voice_profile` (merge raso — mandar só
as chaves que mudam) e `fonte: 'incremental'`.
