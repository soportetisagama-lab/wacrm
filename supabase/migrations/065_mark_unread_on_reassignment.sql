-- ============================================================
-- MARK UNREAD ON (RE)ASSIGNMENT
-- `unread_count` is per-conversation, not per-agent. Without this, a
-- conversation the triage/ATC person already opened and read (unread_count
-- back to 0) lands in the newly-assigned agent's inbox looking already
-- read, even though that agent never saw it. Whenever assigned_agent_id
-- changes to a real agent, bump unread_count back up so it shows as
-- needing attention for whoever it was just handed to — GREATEST, not a
-- flat set to 1, so it never *lowers* a genuinely higher pending count
-- (several customer messages piled up before the handoff).
--
-- BEFORE UPDATE (not AFTER, not INSERT): mutating NEW directly avoids a
-- second UPDATE statement re-firing this same trigger, and a brand-new
-- conversation created with assigned_agent_id already set has no
-- messages yet — nothing to mark unread.
-- ============================================================
CREATE OR REPLACE FUNCTION mark_unread_on_reassignment()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.assigned_agent_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.assigned_agent_id IS NOT DISTINCT FROM OLD.assigned_agent_id THEN
    RETURN NEW;
  END IF;

  NEW.unread_count := GREATEST(NEW.unread_count, 1);
  RETURN NEW;
END;
$$;

ALTER FUNCTION mark_unread_on_reassignment() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_conversation_reassigned_mark_unread ON conversations;
CREATE TRIGGER on_conversation_reassigned_mark_unread
  BEFORE UPDATE OF assigned_agent_id ON conversations
  FOR EACH ROW EXECUTE FUNCTION mark_unread_on_reassignment();
