-- ============================================================
-- 070_inbound_media.sql
--
-- Our own copy of every inbound customer media file.
--
-- Meta only hands us a media id; the inbox used to re-download each
-- file from Meta on every view (/api/whatsapp/media/[mediaId]). Meta
-- stops serving those ids after a while (or once the WhatsApp token /
-- app changes), and the file then shows up broken — "Object with ID …
-- does not exist". Photos already had a public copy in `flow-media`
-- (for AI vision, see lib/ai/inbound-image.ts); audio, video and
-- documents had none.
--
-- 1. `inbound-media` bucket — PRIVATE (customer documents), no
--    storage policies, so only the service role reads/writes it. The
--    media route serves it to signed-in members after an RLS-scoped
--    lookup of the message row. 50 MB (the default Supabase global
--    cap — a bucket can't exceed it); larger files keep using Meta.
--    Any mime type: customers send zips, CSVs, etc.
--
-- 2. Index for that lookup (messages.media_url = the route's own
--    /api/whatsapp/media/<id> path).
-- ============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('inbound-media', 'inbound-media', FALSE, 52428800, NULL)
ON CONFLICT (id) DO UPDATE
SET
  public = FALSE,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = NULL;

CREATE INDEX IF NOT EXISTS idx_messages_media_url
  ON messages(media_url)
  WHERE media_url IS NOT NULL;
