-- ============================================================
-- 069_tags_personal.sql
--
-- Personal vs shared tags — same model as quick replies (067).
--
-- Until now tags were account-wide and only admins could create them.
-- Advisors now create their own from the inbox contact panel:
--
--   * is_shared = false → personal: only its author sees it (plus
--     admins, who see everything), and only its author (or an admin)
--     can rename/delete it.
--   * is_shared = true  → the whole account. Only admin/owner create,
--     edit or delete these.
--
-- Existing tags stay shared (column default true).
--
-- contact_tags follows the tag's visibility: a member only sees — and
-- can only add/remove — contact_tags rows whose tag they can see. The
-- EXISTS on `tags` runs under the caller's own RLS, so another
-- advisor's personal tag on a shared contact stays invisible and
-- untouchable.
-- ============================================================

ALTER TABLE tags
  ADD COLUMN IF NOT EXISTS is_shared BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_tags_account_user ON tags(account_id, user_id);

DROP POLICY IF EXISTS tags_select ON tags;
DROP POLICY IF EXISTS tags_insert ON tags;
DROP POLICY IF EXISTS tags_update ON tags;
DROP POLICY IF EXISTS tags_delete ON tags;

CREATE POLICY tags_select ON tags FOR SELECT
  USING (
    is_account_member(account_id)
    AND (
      is_shared
      OR user_id = auth.uid()
      OR is_account_member(account_id, 'admin')
    )
  );

CREATE POLICY tags_insert ON tags FOR INSERT
  WITH CHECK (
    is_account_member(account_id, 'admin')
    OR (
      is_account_member(account_id, 'agent')
      AND user_id = auth.uid()
      AND NOT is_shared
    )
  );

CREATE POLICY tags_update ON tags FOR UPDATE
  USING (
    is_account_member(account_id, 'admin')
    OR (
      is_account_member(account_id, 'agent')
      AND user_id = auth.uid()
      AND NOT is_shared
    )
  );

CREATE POLICY tags_delete ON tags FOR DELETE
  USING (
    is_account_member(account_id, 'admin')
    OR (
      is_account_member(account_id, 'agent')
      AND user_id = auth.uid()
      AND NOT is_shared
    )
  );

DROP POLICY IF EXISTS contact_tags_select ON contact_tags;
DROP POLICY IF EXISTS contact_tags_modify ON contact_tags;

CREATE POLICY contact_tags_select ON contact_tags FOR SELECT USING (
  EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_tags.contact_id AND is_account_member(c.account_id))
  AND EXISTS (SELECT 1 FROM tags t WHERE t.id = contact_tags.tag_id)
);

CREATE POLICY contact_tags_modify ON contact_tags FOR ALL USING (
  EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_tags.contact_id AND is_account_member(c.account_id, 'agent'))
  AND EXISTS (SELECT 1 FROM tags t WHERE t.id = contact_tags.tag_id)
) WITH CHECK (
  EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_tags.contact_id AND is_account_member(c.account_id, 'agent'))
  AND EXISTS (SELECT 1 FROM tags t WHERE t.id = contact_tags.tag_id)
);
