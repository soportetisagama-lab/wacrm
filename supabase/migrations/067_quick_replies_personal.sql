-- ============================================================
-- 067_quick_replies_personal.sql
--
-- Personal vs shared quick replies.
--
-- Until now every quick reply was account-shared, and only admins
-- (Configuración is admin-only, see 062) could create them. Advisors
-- now create their own from the inbox picker:
--
--   * is_shared = false → personal: only its author sees it (plus
--     admins, who see everything).
--   * is_shared = true  → shared with the whole account. Only
--     admin/owner can create, edit or delete these.
--
-- Existing rows were all created as account-wide snippets, so they
-- stay shared (column default true). The API always sets the column
-- explicitly from the caller's role.
-- ============================================================

ALTER TABLE quick_replies
  ADD COLUMN IF NOT EXISTS is_shared BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_quick_replies_account_user
  ON quick_replies(account_id, user_id);

DROP POLICY IF EXISTS quick_replies_select ON quick_replies;
DROP POLICY IF EXISTS quick_replies_insert ON quick_replies;
DROP POLICY IF EXISTS quick_replies_update ON quick_replies;
DROP POLICY IF EXISTS quick_replies_delete ON quick_replies;

CREATE POLICY quick_replies_select ON quick_replies FOR SELECT
  USING (
    is_account_member(account_id)
    AND (
      is_shared
      OR user_id = auth.uid()
      OR is_account_member(account_id, 'admin')
    )
  );

CREATE POLICY quick_replies_insert ON quick_replies FOR INSERT
  WITH CHECK (
    is_account_member(account_id, 'agent')
    AND user_id = auth.uid()
    AND (NOT is_shared OR is_account_member(account_id, 'admin'))
  );

CREATE POLICY quick_replies_update ON quick_replies FOR UPDATE
  USING (
    is_account_member(account_id, 'admin')
    OR (
      is_account_member(account_id, 'agent')
      AND user_id = auth.uid()
      AND NOT is_shared
    )
  );

CREATE POLICY quick_replies_delete ON quick_replies FOR DELETE
  USING (
    is_account_member(account_id, 'admin')
    OR (
      is_account_member(account_id, 'agent')
      AND user_id = auth.uid()
      AND NOT is_shared
    )
  );
