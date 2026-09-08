-- ============================================================
-- messages: dedicated filename column for document cards.
--
-- MediaDocumentBubble (inbox UI) previously had no separate filename
-- to show next to the document icon — it fell back to content_text,
-- which for a document WITH a caption (e.g. Flows' send_media
-- caption) is a full paragraph, not a short filename. Confirmed live
-- on the collect_ai catalog send: the "card" rendered as a wide flat
-- bar of caption text instead of a compact icon+filename row.
--
-- send_media's config already carries a `filename` (sent to Meta so
-- the customer's phone shows the right name) — it was just never
-- persisted to `messages` for the CRM's own re-render. This column
-- fixes that; engineSendMedia and the inbound webhook both populate
-- it going forward (see the accompanying code change).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS filename TEXT;
