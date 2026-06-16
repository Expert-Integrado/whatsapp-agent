"""
estou-devendo — Skill para Claude Code

Lista conversas do WhatsApp pessoal do dono onde ele esta devendo resposta
(lead/contato respondeu por ultimo). Filtra por categoria, exclui grupos,
ordena por dias parado.

Uso:
  python estou_devendo.py
  python estou_devendo.py --categoria=cliente,prospect
  python estou_devendo.py --excluir=descartar --dias=2 --limit=10
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

PROJ = os.environ.get("WHATSAPP_AGENT_SUPABASE_PROJECT", "your-project-ref")
PAT = os.environ.get("SUPABASE_PAT")
SERVICE_ROLE = os.environ.get("SUPABASE_SERVICE_ROLE")

if not PAT:
    print(
        "ERRO: SUPABASE_PAT precisa estar definida no env.\n"
        "       Tokens vivem em memory-mcp/expert-brain: 'supabase-pat'.",
        file=sys.stderr,
    )
    sys.exit(2)

SQL_URL = f"https://api.supabase.com/v1/projects/{PROJ}/database/query"


def sql(q):
    """Executa SQL via Supabase Management API."""
    payload = json.dumps({"query": q})
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


def days_since(iso_ts):
    """Quantos dias passaram desde um ISO timestamp UTC."""
    if not iso_ts:
        return None
    dt = datetime.fromisoformat(iso_ts.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    delta = datetime.now(timezone.utc) - dt
    return round(delta.total_seconds() / 86400, 2)


def fetch_pendencias(categorias_in, categorias_out, dias_min, include_groups, limit):
    """Query principal — usa view v_chats_with_categories pra ja vir com slugs."""
    cond = [
        "last_received_at IS NOT NULL",
        "(last_sent_at IS NULL OR last_received_at > last_sent_at)",
        f"last_received_at <= now() - interval '{dias_min} days'",
    ]
    if not include_groups:
        cond.append("is_group = false")
    if categorias_in:
        slugs_sql = ",".join(f"'{s.replace(chr(39), chr(39)*2)}'" for s in categorias_in)
        cond.append(f"category_slugs && ARRAY[{slugs_sql}]::text[]")
    if categorias_out:
        slugs_sql = ",".join(f"'{s.replace(chr(39), chr(39)*2)}'" for s in categorias_out)
        cond.append(f"NOT (category_slugs && ARRAY[{slugs_sql}]::text[])")

    where = " AND ".join(cond)
    q = f"""
SELECT chat_id, chat_name, is_group, category_slugs, category_labels,
       last_received_at, last_sent_at
FROM v_chats_with_categories
WHERE {where}
ORDER BY last_received_at ASC
LIMIT {limit}
"""
    return sql(q)


def fetch_last_message(chat_id):
    """Pega snippet da ultima mensagem recebida."""
    chat_id_esc = chat_id.replace("'", "''")
    rows = sql(f"""
SELECT content, message_type, message_ts
FROM messages
WHERE chat_id = '{chat_id_esc}' AND from_me = false AND is_deleted = false
ORDER BY message_ts DESC
LIMIT 1
""")
    if isinstance(rows, list) and rows:
        return rows[0]
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--categoria", help="Lista de slugs separados por virgula", default="")
    ap.add_argument("--excluir", help="Lista de slugs separados por virgula", default="descartar,comunidade")
    ap.add_argument("--dias", type=float, default=1)
    ap.add_argument("--limit", type=int, default=20)
    ap.add_argument("--all-groups", action="store_true")
    ap.add_argument("--with-snippet", action="store_true", help="Inclui snippet da ultima msg recebida (faz +N queries)")
    args = ap.parse_args()

    cats_in = [s.strip() for s in args.categoria.split(",") if s.strip()]
    cats_out = [s.strip() for s in args.excluir.split(",") if s.strip()]
    limit = max(1, min(args.limit, 100))

    rows = fetch_pendencias(cats_in, cats_out, args.dias, args.all_groups, limit)
    if isinstance(rows, dict) and "error" in rows:
        print(f"ERRO no SQL: {rows['error']}", file=sys.stderr)
        sys.exit(1)

    # Conta agrupado por categoria (antes de truncar)
    cat_counts = {}
    for r in rows:
        for slug in r.get("category_slugs") or []:
            cat_counts[slug] = cat_counts.get(slug, 0) + 1
        if not r.get("category_slugs"):
            cat_counts["(sem categoria)"] = cat_counts.get("(sem categoria)", 0) + 1

    chats = []
    for r in rows:
        snippet = None
        if args.with_snippet:
            last = fetch_last_message(r["chat_id"])
            if last:
                content = last.get("content") or ""
                snippet = content[:160] if last["message_type"] in ("text", "image", "audio", "video") else f"[{last['message_type']}]"

        chats.append({
            "chat_id": r["chat_id"],
            "chat_name": r["chat_name"],
            "is_group": r["is_group"],
            "categories": r.get("category_slugs") or [],
            "category_labels": r.get("category_labels") or [],
            "dias_parado": days_since(r["last_received_at"]),
            "ultima_msg_recebida": r["last_received_at"],
            "ultima_msg_enviada": r.get("last_sent_at"),
            **({"snippet": snippet} if snippet else {}),
        })

    out = {
        "total_pendencias": len(rows),
        "mostrando": len(chats),
        "filtro": {
            "categorias_incluir": cats_in or None,
            "categorias_excluir": cats_out or None,
            "dias_min": args.dias,
            "incluir_grupos": args.all_groups,
        },
        "por_categoria": dict(sorted(cat_counts.items(), key=lambda x: -x[1])),
        "chats": chats,
    }
    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
