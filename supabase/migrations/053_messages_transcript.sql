-- ============================================================
-- messages: dedicated column for a Whisper-generated transcript of an
-- audio message (piece 2a of the Whisper integration).
--
-- Kept separate from content_text on purpose: content_text represents
-- what the sender actually wrote/typed, while a transcript is INFERRED
-- (and can be wrong) — worth keeping structurally distinct rather than
-- silently overloading content_text, both for the inbox UI (should be
-- visually marked as an automatic transcription, not verbatim sender
-- text) and for buildConversationContext (a later piece), which will
-- need to read this column specifically to surface it to the model.
--
-- Not populated by anything yet — that's piece 2b (webhook downloads
-- the real audio bytes + calls transcribeAudio + writes this column).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS transcript TEXT;
