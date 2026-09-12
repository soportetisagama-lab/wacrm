-- ============================================================
-- 063_conversation_pins.sql
--
-- Per-agent conversation pinning (WhatsApp-style): each user pins
-- their own conversations to the top of their inbox. Deliberately
-- personal, not shared — a junction table keyed on (user_id,
-- conversation_id) rather than a column on `conversations`, so one
-- agent pinning a conversation never affects what a teammate sees.
--
-- Capped at 3 pins per user via a BEFORE INSERT trigger (DB-level,
-- not just a frontend check, so it holds even across concurrent
-- requests / multiple devices).
-- ============================================================

CREATE TABLE IF NOT EXISTS conversation_pins (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  pinned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, conversation_id)
);

CREATE INDEX IF NOT EXISTS idx_conversation_pins_user ON conversation_pins(user_id);

ALTER TABLE conversation_pins ENABLE ROW LEVEL SECURITY;

-- A user can only ever see/manage their own pins.
DROP POLICY IF EXISTS conversation_pins_select ON conversation_pins;
CREATE POLICY conversation_pins_select ON conversation_pins FOR SELECT
  USING (user_id = auth.uid());

-- INSERT additionally requires the conversation to belong to an
-- account the user is a member of — otherwise any authenticated user
-- could pin (and thus read, once join-based UI trusts pin rows)
-- conversation ids from another tenant by guessing UUIDs.
DROP POLICY IF EXISTS conversation_pins_insert ON conversation_pins;
CREATE POLICY conversation_pins_insert ON conversation_pins FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM conversations c
      WHERE c.id = conversation_pins.conversation_id
        AND is_account_member(c.account_id)
    )
  );

DROP POLICY IF EXISTS conversation_pins_delete ON conversation_pins;
CREATE POLICY conversation_pins_delete ON conversation_pins FOR DELETE
  USING (user_id = auth.uid());

-- Cap: 3 pinned conversations per user, matching WhatsApp's own limit.
CREATE OR REPLACE FUNCTION enforce_conversation_pin_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (SELECT COUNT(*) FROM conversation_pins WHERE user_id = NEW.user_id) >= 3 THEN
    RAISE EXCEPTION 'pin_limit_reached: a user may only pin up to 3 conversations'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS conversation_pins_limit_trigger ON conversation_pins;
CREATE TRIGGER conversation_pins_limit_trigger
  BEFORE INSERT ON conversation_pins
  FOR EACH ROW EXECUTE FUNCTION enforce_conversation_pin_limit();
