-- ============================================================
-- ai_configs: opt-in switch for sending images to the model as vision
-- content (piece c of the image-vision integration).
--
-- Unlike transcribe_audio_enabled, this has NO secondary key
-- dependency: vision uses the account's own chat provider/model
-- (OpenAI or Anthropic) — piece (a)'s adapters already speak
-- multimodal content natively for both, so there's no separate
-- embeddings_api_key requirement to check alongside this flag.
--
-- Off by default — image tokens cost meaningfully more than text on
-- both providers, so an account opts in explicitly, same posture as
-- audio transcription.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS vision_enabled BOOLEAN NOT NULL DEFAULT false;
