-- ============================================================
-- Flows: inactivity-nudge state for collect_ai.
--
-- `last_nudge_sent_at` marks the last time the /api/flows/cron sweep
-- sent an inactivity nudge for this run's CURRENT collect_ai node.
-- Compared against `last_advanced_at` (not treated as a boolean "did
-- we already nudge") so a nudge doesn't permanently block a later one:
-- once the customer replies (bumping last_advanced_at, already
-- existing behavior), `last_nudge_sent_at` is naturally "stale" —
-- older than the new last_advanced_at — and a fresh silence period
-- becomes nudge-eligible again with zero extra writes anywhere else
-- in the codebase. See shouldSendCollectAiNudge (engine.ts).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE flow_runs
  ADD COLUMN IF NOT EXISTS last_nudge_sent_at TIMESTAMPTZ;
