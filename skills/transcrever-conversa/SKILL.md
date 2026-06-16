---
name: transcrever-conversa
description: "Transcreve audios de uma conversa do WhatsApp (Supabase) usando Whisper local e retorna resumo da conversa. Use quando o dono pedir 'transcreve a conversa com X', 'resumo dos audios do fulano' ou similar."
argument-hint: "<nome_ou_telefone> [--dias N] [--openai]"
allowed-tools: Bash, Read
---

Skill para extrair contexto de conversas WhatsApp que misturam texto + audios.

## Como funciona

1. Recebe um nome ou telefone (parcial ou completo). Resolve para `chat_id` via `chats.chat_name ILIKE` ou `chat_id` literal.
2. Busca mensagens dos ultimos N dias (default: 30).
3. Para audios sem `content` (nao transcritos ainda):
   - Baixa do bucket `whatsapp-audio` via Supabase Storage API
   - Roda Whisper local (modelo `small` — rapido e bom o suficiente pra portugues)
   - Salva a transcricao em `messages.content`
4. Retorna a conversa completa em ordem cronologica (texto + transcricoes) pronta pra resumir.

## Flags

- `--dias N` — periodo em dias (default: 30)
- `--openai` — usa OpenAI Whisper API ao inves do Whisper local (quando estiver em PC sem Python/Whisper)

## Execucao

Execute o script passando os argumentos que o dono forneceu:

```
"python3" "~/.claude/skills/transcrever-conversa/scripts/transcrever.py" $ARGUMENTS
```

## Apos rodar

O script devolve JSON com:
- `chat_name`, `chat_id`, `total_messages`, `audios_transcritos`, `audios_ja_tinham_transcricao`
- `conversa`: array `[{ts, from, tipo, texto}]` em ordem cronologica

Use o output para escrever um resumo objetivo da conversa:
- Principais topicos discutidos
- Decisoes tomadas
- Pendencias em aberto
- Tom emocional (se relevante)

Nao invente conteudo — se um audio falhou na transcricao (aparece como `[audio — falha: ...]`), mencione isso no resumo.

## Observacoes importantes

- O projeto WhatsApp Agent so guarda audios dos ultimos ~30 dias (cron de limpeza). Audios mais antigos nao existem mais no storage.
- OpenAI API custa ~$0.006/min. 30 min de audio ≈ $0.18. So usar `--openai` quando Whisper local nao estiver disponivel.
- Transcricoes sao salvas de volta em `messages.content` — proxima vez que rodar pra mesma conversa, nao paga de novo.
