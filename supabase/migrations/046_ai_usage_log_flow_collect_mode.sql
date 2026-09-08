-- ============================================================
-- ai_usage_log: allow 'flow_collect' in the mode CHECK.
--
-- The collect_ai flow node (this build) makes its own provider calls
-- via extractWithReply, on the account's same BYO key as auto-reply
-- and draft — but it's a distinct cost surface (potentially several
-- calls per customer, gated by max_turns rather than a per-conversation
-- reply cap) and needs to be visible on its own in the Usage tab, not
-- folded into 'auto_reply' or silently dropped.
--
-- ai_usage_log.mode's CHECK was defined inline in migration 033
-- (`mode text NOT NULL CHECK (mode IN ('auto_reply', 'draft'))`),
-- which Postgres names automatically as `<table>_<column>_check` —
-- `ai_usage_log_mode_check` here. Same DROP + re-ADD idiom as
-- migrations 043 and 045.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_usage_log
  DROP CONSTRAINT IF EXISTS ai_usage_log_mode_check;

ALTER TABLE ai_usage_log
  ADD CONSTRAINT ai_usage_log_mode_check
  CHECK (mode IN ('auto_reply', 'draft', 'flow_collect'));
