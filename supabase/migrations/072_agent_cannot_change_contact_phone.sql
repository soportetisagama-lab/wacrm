-- ============================================================
-- 072_agent_cannot_change_contact_phone.sql
--
-- An Asesor (account_role = 'agent') can edit a contact's name, email,
-- company and tags, but not its phone number — ATC / admins decide
-- that. Enforced here (not only in the UI) so no screen or API call
-- can get around it.
--
-- Only applies to signed-in members: the webhook / automations run as
-- the service role (auth.uid() IS NULL) and keep updating phones
-- (e.g. a BSUID-only contact getting its number, migration 042).
--
-- Idempotent.
-- ============================================================

CREATE OR REPLACE FUNCTION prevent_agent_contact_phone_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.phone IS DISTINCT FROM OLD.phone
     AND auth.uid() IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM profiles p
       WHERE p.user_id = auth.uid()
         AND p.account_id = OLD.account_id
         AND p.account_role = 'agent'
     )
  THEN
    RAISE EXCEPTION 'Los asesores no pueden cambiar el número de teléfono de un contacto'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS contacts_agent_phone_guard ON contacts;
CREATE TRIGGER contacts_agent_phone_guard
  BEFORE UPDATE OF phone ON contacts
  FOR EACH ROW
  EXECUTE FUNCTION prevent_agent_contact_phone_change();
