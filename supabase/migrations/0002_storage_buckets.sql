-- ════════════════════════════════════════════════════════════════
-- Storage Buckets — 6 buckets privados
-- ════════════════════════════════════════════════════════════════
INSERT INTO storage.buckets (id, name, public) VALUES
  ('whatsapp-audio',      'whatsapp-audio',      false),
  ('whatsapp-images',     'whatsapp-images',     false),
  ('whatsapp-video',      'whatsapp-video',      false),
  ('whatsapp-documents',  'whatsapp-documents',  false),
  ('whatsapp-stickers',   'whatsapp-stickers',   false),
  ('whatsapp-thumbnails', 'whatsapp-thumbnails', false)
ON CONFLICT (id) DO NOTHING;

-- Acesso: service role via backend (Edge Functions).
-- Clientes lêem via signed URLs geradas no backend.
-- Path convention:
--   whatsapp-audio/{chat_id}/{provider_msg_id}.ogg
--   whatsapp-images/{chat_id}/{provider_msg_id}.jpg
--   whatsapp-video/{chat_id}/{provider_msg_id}.mp4
--   whatsapp-documents/{chat_id}/{provider_msg_id}-{filename}
--   whatsapp-stickers/{chat_id}/{provider_msg_id}.webp
--   whatsapp-thumbnails/{chat_id}/{provider_msg_id}.jpg
