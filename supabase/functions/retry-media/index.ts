import { createClient } from "npm:@supabase/supabase-js@2";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

Deno.serve(async (_req) => {
  const { data: pending } = await supabase.from("message_media").select("id, original_url, storage_bucket, storage_path, mime_type").eq("download_status", "pending").not("original_url", "is", null).order("created_at", { ascending: true }).limit(50);
  let done = 0, failed = 0;
  for (const m of (pending ?? [])) {
    try {
      const r = await fetch(m.original_url, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      const { error } = await supabase.storage.from(m.storage_bucket).upload(m.storage_path, bytes, { contentType: m.mime_type, upsert: true });
      if (error) throw error;
      await supabase.from("message_media").update({ download_status: "done", file_size_bytes: bytes.length, download_error: null }).eq("id", m.id);
      done++;
    } catch (e) {
      await supabase.from("message_media").update({ download_status: "failed", download_error: String(e) }).eq("id", m.id);
      failed++;
    }
  }
  return new Response(JSON.stringify({ ok: true, processed: (pending ?? []).length, done, failed }), { headers: { "Content-Type": "application/json" } });
});
