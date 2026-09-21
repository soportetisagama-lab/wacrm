-- ============================================================
-- DEVICE PUSH TOKENS
-- One row per (user, device) — the FCM registration token the
-- Android wrapper app got from Firebase after the user granted the
-- native notification permission. Used by
-- src/lib/notifications/push-send.ts (service-role only) to fan out
-- a push when a new inbound message arrives for their assigned
-- conversation. A user can have several rows (several devices).
-- ============================================================
CREATE TABLE IF NOT EXISTS device_push_tokens (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'android' CHECK (platform IN ('android', 'ios')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (token)
);

CREATE INDEX IF NOT EXISTS idx_device_push_tokens_user
  ON device_push_tokens(user_id);

ALTER TABLE device_push_tokens ENABLE ROW LEVEL SECURITY;

-- A user manages only their own devices. All writes go through
-- /api/push/register (service-role), but these policies also let the
-- client read/clean up its own rows directly if ever needed.
DROP POLICY IF EXISTS device_push_tokens_select ON device_push_tokens;
DROP POLICY IF EXISTS device_push_tokens_insert ON device_push_tokens;
DROP POLICY IF EXISTS device_push_tokens_update ON device_push_tokens;
DROP POLICY IF EXISTS device_push_tokens_delete ON device_push_tokens;

CREATE POLICY device_push_tokens_select ON device_push_tokens FOR SELECT
  USING (auth.uid() = user_id);
CREATE POLICY device_push_tokens_insert ON device_push_tokens FOR INSERT
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY device_push_tokens_update ON device_push_tokens FOR UPDATE
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY device_push_tokens_delete ON device_push_tokens FOR DELETE
  USING (auth.uid() = user_id);
