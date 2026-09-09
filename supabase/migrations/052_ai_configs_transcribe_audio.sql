-- ============================================================
-- ai_configs: opt-in switch for audio transcription (piece 2a of the
-- Whisper integration).
--
-- Off by default — transcription has real per-audio cost (Whisper
-- bills per minute, not gated by auto_reply_max_per_conversation the
-- way chat replies are) and requires the account's auxiliary OpenAI
-- key (embeddings_api_key, reused rather than adding a third key
-- column) to be usable at all.
--
-- Not wired to anything yet — no webhook, no UI. Just the column +
-- loadAiConfig plumbing, so later pieces have a real, typed flag to
-- read instead of retrofitting one under time pressure.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS transcribe_audio_enabled BOOLEAN NOT NULL DEFAULT false;
