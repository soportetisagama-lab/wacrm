-- ============================================================
-- messages: capture Meta's status-callback error detail.
--
-- handleStatusUpdate (api/whatsapp/webhook/route.ts) previously wrote
-- only `status.status` ('failed', etc.) onto `messages`, discarding
-- the `errors` array Meta includes on a failed status callback — so a
-- failed send was undiagnosable from the DB (confirmed live: two
-- failed template sends with nothing but the bare word "failed").
--
-- broadcast_recipients already has an `error_message` column
-- (migration 001) with the same problem — never populated. That one
-- gets the fix in code too, no migration needed there (column already
-- exists); this migration only covers `messages`, which has no error
-- column at all yet.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS error_code INTEGER,
  ADD COLUMN IF NOT EXISTS error_message TEXT;
