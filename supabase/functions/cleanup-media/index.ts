import { createClient } from "npm:@supabase/supabase-js@2";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
// Audio descontinuado da lista 27/05/2026: voice notes valem preservar (alimentam Brain,
// transcricoes ja indexadas, baixa rotatividade). Storage Pro suporta 100 GB e audio
// cresce ~2.5 GB/ano. Manter apenas whatsapp-video em rotacao de 30d.
const EXPIRING = ["whatsapp-video"];

Deno.serve(async (_req) => {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: expired } = await supabase.from("message_media").select("id, storage_bucket, storage_path, thumbnail_path").in("storage_bucket", EXPIRING).eq("download_status", "done").lt("created_at", cutoff);
  let deleted = 0, errors = 0;
  for (const m of (expired ?? [])) {
    try {
      await supabase.storage.from(m.storage_bucket).remove([m.storage_path]);
      if (m.thumbnail_path) await supabase.storage.from("whatsapp-thumbnails").remove([m.thumbnail_path]);
      await supabase.from("message_media").delete().eq("id", m.id);
      deleted++;
    } catch { errors++; }
  }
  return new Response(JSON.stringify({ ok: true, deleted, errors }), { headers: { "Content-Type": "application/json" } });
});
