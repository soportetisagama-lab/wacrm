-- ============================================================
-- contacts: per-contact opt-out from AI inactivity nudges.
--
-- Set by the webhook (flagNudgeOptOutIfRequested, api/whatsapp/webhook/
-- route.ts) when an inbound message matches a fixed "stop bothering me"
-- keyword list — deterministic, not model-judged, so it's recognized
-- regardless of which flow/node (if any) the contact is currently in,
-- not only while a collect_ai node happens to be active.
--
-- Scoped to the CONTACT, not the flow_run: this is a durable customer
-- preference ("don't nudge THIS person again"), not something that
-- should reset on the next flow_run/conversation with them. account_id
-- on `contacts` already isolates this per tenant — the same phone
-- number opting out on one account's bot has no effect on another.
--
-- `ai_nudge_opt_out_at` is audit-only (support: "why did nudges stop
-- for this contact") — the cron sweep only reads the boolean.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS ai_nudge_opt_out BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ai_nudge_opt_out_at TIMESTAMPTZ;
