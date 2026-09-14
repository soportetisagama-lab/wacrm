-- ============================================================
-- 064_contacts_visibility_by_role.sql — Asesor sees only contacts
--                                        from their own conversations
--
-- Mirrors 039_conversation_visibility_by_role.sql, applied to
-- `contacts`. contacts_select (042, itself replacing the original
-- single-user policy from 001) was a flat is_account_member(account_id)
-- check — every account member, including an Asesor (agent), could
-- read/update/delete every contact in the account regardless of
-- whether any conversation with that contact was ever assigned to
-- them. Unlike the inbox "Asesor" filter dropdown (which
-- can_view_conversation already backstops — an agent's conversations
-- list never contained anyone else's rows to begin with), the
-- Contacts page is a raw `select('*')` with no assigned-agent filter,
-- so this was a real data-exposure gap.
--
-- Contacts have no assigned_agent_id of their own — ownership is
-- derived through conversations: a contact is "theirs" if ANY
-- conversation between that contact and the account has
-- assigned_agent_id = auth.uid(). A contact can have more than one
-- conversation (e.g. re-contacted after a prior one closed), so this
-- is an EXISTS, not a 1:1 join.
--
-- Visibility rule per role (identical broad-vs-scoped split as 039):
--   owner / admin / gerencia / atc / viewer / jefe_linea -> every
--     contact in the account (unchanged).
--   agent (Asesor) -> only contacts with at least one conversation
--     assigned to them.
--
-- SELECT, UPDATE and DELETE all get the same scoping — an Asesor
-- must not be able to edit or delete a contact they can't even see
-- listed, even if they somehow knew/guessed its id. INSERT is left
-- untouched (042's contacts_insert): creating a brand-new contact
-- isn't "reaching into someone else's", and a freshly-inserted
-- contact has no assigned conversation yet anyway.
--
-- Idempotent — CREATE OR REPLACE + DROP POLICY IF EXISTS.
-- ============================================================

CREATE OR REPLACE FUNCTION can_view_contact(
  target_account_id UUID,
  target_contact_id UUID
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM profiles p
    WHERE p.user_id = auth.uid()
      AND p.account_id = target_account_id
      AND (
        -- Broad-visibility roles: every contact in the account.
        p.account_role IN ('owner', 'admin', 'gerencia', 'atc', 'viewer', 'jefe_linea')
        -- Asesor: only contacts with a conversation assigned to them.
        OR (
          p.account_role = 'agent'
          AND EXISTS (
            SELECT 1 FROM conversations c
            WHERE c.contact_id = target_contact_id
              AND c.assigned_agent_id = auth.uid()
          )
        )
      )
  );
$$;

ALTER FUNCTION can_view_contact(UUID, UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION can_view_contact(UUID, UUID) TO authenticated, service_role;

DROP POLICY IF EXISTS contacts_select ON contacts;
CREATE POLICY contacts_select ON contacts FOR SELECT
  USING (can_view_contact(account_id, id));

DROP POLICY IF EXISTS contacts_update ON contacts;
CREATE POLICY contacts_update ON contacts FOR UPDATE
  USING (is_account_member(account_id, 'agent') AND can_view_contact(account_id, id));

DROP POLICY IF EXISTS contacts_delete ON contacts;
CREATE POLICY contacts_delete ON contacts FOR DELETE
  USING (is_account_member(account_id, 'agent') AND can_view_contact(account_id, id));

-- ============================================================
-- Manual validation (run against a live instance — no automated SQL
-- test harness exists in this repo):
--
--   1. As an Asesor (agent) JWT, GET /rest/v1/contacts must return
--      only contacts with a conversation assigned to them.
--   2. As the same Asesor, PATCH/DELETE a contact NOT theirs (known
--      id) must affect 0 rows.
--   3. As ATC / Jefe de Línea / Gerencia / admin / owner / viewer,
--      contacts listing/edit/delete is unchanged (sees/edits/deletes
--      everyone's, same as today).
--   4. As an Asesor, INSERT (creating a new contact) still succeeds
--      — contacts_insert (042) is untouched.
-- ============================================================
