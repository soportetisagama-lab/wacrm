-- ============================================================
-- messages: distinguish a WhatsApp sticker from a real inbound photo.
--
-- Both arrive today as content_type='image' (the webhook maps
-- message.type='sticker' to content_type='image' so MessageBubble
-- renders an <img> — see api/whatsapp/webhook/route.ts, "stickers are
-- images"). That collapsing loses the one bit vision sourcing needs:
-- a sticker must never be downloaded/persisted for vision (piece b)
-- and must never be sent to a model (piece d) — stickers are decorative,
-- not content, and burning vision tokens on them is pure waste.
--
-- Default false so all existing image rows (all real photos so far,
-- since nothing has read this column before now) keep today's
-- behavior with no backfill needed.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS is_sticker BOOLEAN NOT NULL DEFAULT false;
