-- ============================================================
-- messages: our own persisted copy of an inbound image, for vision.
--
-- Deliberately separate from `media_url` (the /api/whatsapp/media/
-- {mediaId} proxy the inbox uses to render <img> — re-verifies against
-- Meta on every request, and stays untouched by this column). This
-- column holds the public URL of OUR OWN Supabase Storage copy
-- (`flow-media` bucket, path `inbound/<account_id>/<message_id>.<ext>`),
-- written once by `persistInboundImage` (lib/ai/inbound-image.ts) right
-- after the inbound image is inserted. `buildConversationContext`
-- reads this column on every later turn instead of re-hitting Meta —
-- Meta's media URLs are short-lived and re-downloading on every model
-- call would be both slow and needlessly dependent on Meta being up.
--
-- Null until the webhook populates it (or forever, for a sticker —
-- see is_sticker in migration 054 — or if the download/upload failed;
-- both cases degrade gracefully in buildConversationContext, no retry).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS media_storage_url TEXT;
