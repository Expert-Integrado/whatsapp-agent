"""
transcrever-conversa — Skill para Claude Code

Baixa audios de uma conversa WhatsApp do Supabase, transcreve via Whisper local
(ou OpenAI API com --openai) e devolve a conversa completa em ordem cronologica.

Uso:
  python transcrever.py <nome_ou_telefone> [--dias N] [--openai]

Examples:
  python transcrever.py "Joao Silva"
  python transcrever.py 5511999999999 --dias 60
  python transcrever.py "nome do contato" --openai
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

PROJ = os.environ.get("WHATSAPP_AGENT_SUPABASE_PROJECT", "")
PAT = os.environ.get("SUPABASE_PAT")
SERVICE_ROLE = os.environ.get("SUPABASE_SERVICE_ROLE")

if not PROJ or not PAT or not SERVICE_ROLE:
    print(
        "ERRO: WHATSAPP_AGENT_SUPABASE_PROJECT, SUPABASE_PAT e SUPABASE_SERVICE_ROLE devem estar definidas no env.\n"
        "       Em PowerShell: $env:WHATSAPP_AGENT_SUPABASE_PROJECT = 'seu-project-id'; $env:SUPABASE_PAT = 'sbp_...'; $env:SUPABASE_SERVICE_ROLE = 'eyJ...'\n"
        "       Em bash:       export WHATSAPP_AGENT_SUPABASE_PROJECT=seu-project-id SUPABASE_PAT=sbp_... SUPABASE_SERVICE_ROLE=eyJ...",
        file=sys.stderr,
    )
    sys.exit(2)

STORAGE_URL = f"https://{PROJ}.supabase.co/storage/v1/object"
SQL_URL = f"https://api.supabase.com/v1/projects/{PROJ}/database/query"


def sql(q):
    """Executa SQL no Supabase via Management API (curl para escapar Cloudflare)."""
    payload = json.dumps({"query": q})
    # Usa tmpfile pro body (evita problemas de escape no Windows bash)
    with tempfile.NamedTemporaryFile("w", delete=False, suffix=".json", encoding="utf-8") as f:
        f.write(payload)
        body_path = f.name
    try:
        r = subprocess.run(
            ["curl", "-s", "-X", "POST", SQL_URL,
             "-H", f"Authorization: Bearer {PAT}",
             "-H", "Content-Type: application/json",
             "--data-binary", f"@{body_path}"],
            capture_output=True, text=True, encoding="utf-8"
        )
        try:
            return json.loads(r.stdout)
        except Exception:
            return {"error": r.stdout[:500]}
    finally:
        os.unlink(body_path)


def resolve_chat(query):
    """Resolve nome ou telefone parcial para chat_id."""
    qesc = query.replace("'", "''")
    rows = sql(
        "SELECT chat_id, chat_name, is_group "
        "FROM chats "
        f"WHERE chat_id = '{qesc}' "
        f"OR chat_name ILIKE '%{qesc}%' "
        f"OR chat_id ILIKE '%{qesc}%' "
        "ORDER BY last_message_at DESC NULLS LAST "
        "LIMIT 5"
    )
    if isinstance(rows, dict) and "error" in rows:
        raise RuntimeError(f"SQL error: {rows['error']}")
    if not rows:
        return None
    # Prefere nao-grupo (conversa 1:1) se tiver multiplo match
    rows.sort(key=lambda r: (r["is_group"], -(len(r["chat_name"] or ""))))
    return rows[0]


def fetch_messages(chat_id, dias):
    """Traz mensagens com metadados de audio."""
    cesc = chat_id.replace("'", "''")
    rows = sql(
        "SELECT m.id, m.provider_msg_id, m.message_ts, m.from_me, m.sender_name, "
        "m.message_type, m.content, m.caption, "
        "mm.storage_bucket, mm.storage_path "
        "FROM messages m "
        "LEFT JOIN message_media mm ON mm.message_id = m.id "
        f"WHERE m.chat_id = '{cesc}' "
        f"AND m.message_ts >= now() - interval '{dias} days' "
        "AND m.is_deleted = false "
        "ORDER BY m.message_ts ASC"
    )
    if isinstance(rows, dict) and "error" in rows:
        raise RuntimeError(f"SQL error: {rows['error']}")
    return rows


def download_audio(storage_path, dest_file):
    """Baixa audio do bucket whatsapp-audio."""
    url = f"{STORAGE_URL}/whatsapp-audio/{storage_path}"
    r = subprocess.run(
        ["curl", "-s", "-S", "--max-time", "60",
         "-w", "%{http_code}",
         "-o", str(dest_file),
         "-H", f"Authorization: Bearer {SERVICE_ROLE}",
         url],
        capture_output=True, text=True
    )
    code = r.stdout.strip()[-3:] if r.stdout else "???"
    return code == "200"


_whisper_model = None

def transcribe_local(audio_path):
    """Transcreve usando whisper local (modelo small, pt-BR)."""
    global _whisper_model
    import whisper  # type: ignore
    if _whisper_model is None:
        print("[whisper] carregando modelo small...", file=sys.stderr, flush=True)
        _whisper_model = whisper.load_model("small")
    result = _whisper_model.transcribe(audio_path, language="pt", fp16=False)
    return result["text"].strip()


def transcribe_openai(audio_path):
    """Transcreve via OpenAI Whisper API."""
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY nao definida no env")
    r = subprocess.run(
        ["curl", "-s", "-X", "POST", "https://api.openai.com/v1/audio/transcriptions",
         "-H", f"Authorization: Bearer {api_key}",
         "-F", f"file=@{audio_path}",
         "-F", "model=whisper-1",
         "-F", "language=pt"],
        capture_output=True, text=True, encoding="utf-8"
    )
    try:
        data = json.loads(r.stdout)
        if "text" in data:
            return data["text"].strip()
        raise RuntimeError(f"OpenAI erro: {data}")
    except json.JSONDecodeError:
        raise RuntimeError(f"OpenAI resposta invalida: {r.stdout[:300]}")


def save_transcription(msg_id, text):
    """Salva transcricao em messages.content."""
    tesc = text.replace("'", "''")
    sql(f"UPDATE messages SET content = '{tesc}' WHERE id = '{msg_id}'")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("query", help="Nome ou telefone")
    ap.add_argument("--dias", type=int, default=30)
    ap.add_argument("--openai", action="store_true", help="Usa OpenAI API")
    args = ap.parse_args()

    chat = resolve_chat(args.query)
    if not chat:
        print(json.dumps({"error": f"Chat nao encontrado: {args.query}"}, ensure_ascii=False))
        sys.exit(1)

    print(f"[chat] {chat['chat_name']} ({chat['chat_id']})", file=sys.stderr, flush=True)

    msgs = fetch_messages(chat["chat_id"], args.dias)
    print(f"[msgs] {len(msgs)} mensagens nos ultimos {args.dias} dias", file=sys.stderr, flush=True)

    transcribe_fn = transcribe_openai if args.openai else transcribe_local

    audios_to_do = [m for m in msgs if m["message_type"] in ("audio", "ptt")
                    and not m.get("content")
                    and m.get("storage_bucket") == "whatsapp-audio"
                    and m.get("storage_path")]
    audios_ja = sum(1 for m in msgs if m["message_type"] in ("audio", "ptt") and m.get("content"))

    print(f"[audios] {len(audios_to_do)} pra transcrever, {audios_ja} ja transcritos",
          file=sys.stderr, flush=True)

    tmpdir = Path(tempfile.mkdtemp(prefix="trans_"))
    transcritos = 0
    falhas = 0

    for i, m in enumerate(audios_to_do, 1):
        audio_file = tmpdir / f"{m['id']}.ogg"
        if not download_audio(m["storage_path"], audio_file):
            print(f"  [{i}/{len(audios_to_do)}] DOWNLOAD FALHOU: {m['storage_path']}",
                  file=sys.stderr, flush=True)
            falhas += 1
            m["content"] = f"[audio — falha: download]"
            continue
        try:
            text = transcribe_fn(str(audio_file))
            if not text:
                text = "[audio vazio]"
            save_transcription(m["id"], text)
            m["content"] = text
            transcritos += 1
            print(f"  [{i}/{len(audios_to_do)}] OK ({len(text)} chars)",
                  file=sys.stderr, flush=True)
        except Exception as e:
            print(f"  [{i}/{len(audios_to_do)}] TRANSCRICAO FALHOU: {e}",
                  file=sys.stderr, flush=True)
            falhas += 1
            m["content"] = f"[audio — falha: {e}]"
        finally:
            try: audio_file.unlink()
            except: pass

    try: tmpdir.rmdir()
    except: pass

    # Monta conversa em ordem cronologica
    conversa = []
    for m in msgs:
        tipo = m["message_type"]
        texto = m.get("content") or m.get("caption") or f"[{tipo}]"
        conversa.append({
            "ts": m["message_ts"],
            "from": "Eu" if m["from_me"] else (m.get("sender_name") or "Outro"),
            "tipo": tipo,
            "texto": texto,
        })

    out = {
        "chat_name": chat["chat_name"],
        "chat_id": chat["chat_id"],
        "total_messages": len(msgs),
        "audios_transcritos_agora": transcritos,
        "audios_ja_tinham_transcricao": audios_ja,
        "audios_falharam": falhas,
        "conversa": conversa,
    }
    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
