import { createClient } from "npm:@supabase/supabase-js@2";

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } }
);

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
const BATCH_SIZE = 20;

// ─── MAIN ────────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (!OPENAI_API_KEY) {
    return json({ ok: false, error: "OPENAI_API_KEY not configured" }, 500);
  }

  // Suporta dois modos:
  //   GET/POST sem query  → batch (cron a cada 2min)
  //   ?id=<msg_uuid>      → transcreve so essa msg (chamado por trigger Postgres)
  const url = new URL(req.url);
  const singleId = url.searchParams.get("id");

  try {
    const result = singleId ? await runSingle(singleId) : await runBatch();
    return json({ ok: true, ...result });
  } catch (e) {
    console.error("transcribe-queue error:", e);
    return json({ ok: false, error: String(e) }, 500);
  }
});

async function runSingle(messageId: string) {
  // Valida e busca msg + media. Idempotente: se ja transcrita, skipa.
  const { data: msg, error } = await supabase
    .from("messages")
    .select("id, message_type, content, message_media!inner(storage_bucket, storage_path, original_url, mime_type, download_status)")
    .eq("id", messageId)
    .in("message_type", ["ptt", "audio"])
    .or("content.is.null,content.eq.")
    .maybeSingle();

  if (error) throw error;
  if (!msg) return { transcribed: 0, skipped: 1, reason: "msg nao elegivel (ja transcrita, tipo errado, ou nao existe)" };

  const mediaArr = (msg as any).message_media;
  const media = Array.isArray(mediaArr) ? mediaArr[0] : mediaArr;
  if (!media || media.download_status !== "done") {
    return { transcribed: 0, skipped: 1, reason: "midia nao baixada ainda" };
  }

  const transcription = await transcribeFromStorage(media);
  if (!transcription) return { transcribed: 0, skipped: 1, reason: "whisper retornou vazio" };

  const { error: saveErr } = await supabase
    .from("messages")
    .update({ content: transcription })
    .eq("id", messageId);

  if (saveErr) throw saveErr;
  return { transcribed: 1, message_id: messageId, length: transcription.length, mode: "single" };
}

async function runBatch() {
  // 1. Mensagens ptt/audio com midia baixada em chat privado (JOIN com chats).
  //
  // Antes (pre-02/05): query buscava todos chat_ids privados e fazia .in(ids).
  // Com 764+ chats privados, IN com 1000 IDs + INNER JOIN em messages estourava
  // statement_timeout (8s) e o cron rodava vazio. Fix: JOIN inner com chats e
  // filtra is_group=false direto. Uma query, sem hidratar IDs no client.
  //
  // cutoff 29 dias: cleanup-media apaga audio > 30 dias — sem arquivo nao
  // adianta tentar transcrever.
  const cutoff = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString();
  const { data: candidates, error: msgErr } = await supabase
    .from("messages")
    .select("id, message_type, chat_id, message_media!inner(message_id, storage_bucket, storage_path, original_url, mime_type), chats!inner(is_group)")
    .in("message_type", ["ptt", "audio"])
    .or("content.is.null,content.eq.")
    .eq("chats.is_group", false)
    .eq("message_media.download_status", "done")
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(BATCH_SIZE);

  if (msgErr) throw msgErr;
  if (!candidates?.length) return { transcribed: 0, skipped: 0, message: "Nenhuma mensagem pendente" };

  // 3. Transcreve cada mensagem sequencialmente para respeitar rate limits da OpenAI
  let transcribed = 0;
  let skipped = 0;

  for (const msg of candidates) {
    const mediaArr = (msg as any).message_media;
    const media = Array.isArray(mediaArr) ? mediaArr[0] : mediaArr;
    if (!media) {
      skipped++;
      continue;
    }

    const transcription = await transcribeFromStorage(media);
    if (!transcription) {
      skipped++;
      continue;
    }

    // Salva transcrição em messages.content (cache permanente)
    const { error: saveErr } = await supabase
      .from("messages")
      .update({ content: transcription })
      .eq("id", (msg as any).id);

    if (saveErr) {
      console.error(`Erro ao salvar transcrição msg ${(msg as any).id}:`, saveErr.message);
      skipped++;
    } else {
      transcribed++;
    }
  }

  return { transcribed, skipped, total_candidates: candidates.length };
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

async function transcribeFromStorage(media: any): Promise<string | null> {
  try {
    // Baixa do Supabase Storage (preferência — URL persistente)
    const { data: blob, error: dlErr } = await supabase.storage
      .from(media.storage_bucket)
      .download(media.storage_path);

    let audioBlob: Blob;
    if (dlErr || !blob) {
      // Fallback: tenta original_url (Backblaze CDN, pode expirar)
      if (!media.original_url) {
        console.warn("Sem URL disponível para mídia:", media.message_id);
        return null;
      }
      const res = await fetch(media.original_url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) {
        console.warn(`Falha download original_url (HTTP ${res.status}) para msg:`, media.message_id);
        return null;
      }
      audioBlob = await res.blob();
    } else {
      audioBlob = blob;
    }

    if (!audioBlob.size) {
      console.warn("Arquivo de áudio vazio para msg:", media.message_id);
      return null;
    }

    return await callWhisper(audioBlob, media.mime_type, media.storage_path);
  } catch (e) {
    console.error("Erro em transcribeFromStorage:", e);
    return null;
  }
}

async function callWhisper(audioBlob: Blob, mimeType: string, storagePath: string): Promise<string | null> {
  // Determina extensão pelo storage_path ou mime_type
  const ext = storagePath?.split(".").pop()?.toLowerCase() || mimeType?.split("/").pop()?.split(";")[0] || "ogg";
  const baseMime = mimeType?.split(";")[0].trim() || "audio/ogg";

  const form = new FormData();
  form.append("file", new File([audioBlob], `audio.${ext}`, { type: baseMime }));
  form.append("model", "whisper-1");
  form.append("language", "pt");
  form.append("response_format", "text");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form,
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`Whisper API ${res.status}:`, errText.slice(0, 200));
    return null;
  }

  const text = (await res.text()).trim();
  return text || null;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
