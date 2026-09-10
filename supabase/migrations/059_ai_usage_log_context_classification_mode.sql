-- ============================================================
-- ai_usage_log: allow 'context_classification' in the mode CHECK.
--
-- The first-inbound context classifier (classifyFirstInboundContext,
-- lib/ai/classify-first-inbound.ts) makes its own provider call via the
-- account's same BYO key as auto-reply/draft/flow_collect — a distinct,
-- much smaller cost surface (at most once per contact ever, only on
-- their very first message) that needs to be visible on its own in the
-- Usage tab, not folded into 'auto_reply'.
--
-- Same DROP + re-ADD idiom as migrations 043, 045, and 046 (which added
-- 'flow_collect' the same way).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_usage_log
  DROP CONSTRAINT IF EXISTS ai_usage_log_mode_check;

ALTER TABLE ai_usage_log
  ADD CONSTRAINT ai_usage_log_mode_check
  CHECK (mode IN ('auto_reply', 'draft', 'flow_collect', 'context_classification'));
