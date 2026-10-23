-- ============================================================
-- 078_contact_tags_estado_insert_admin_only.sql
--
-- Follow-up to 077: the 13 xlr8 status tags (ASIGNADO, SPAM, …) can
-- now only be PUT ON a contact by an admin/owner too. Agents can
-- neither add nor remove them; the xlr8 sync keeps them up to date.
--
-- Same rule as contact_tags_delete in 077, applied to INSERT and to
-- the new row of an UPDATE. Reuses is_xlr8_estado_tag() from 077.
--
-- The xlr8 sync, flows and automations use the service role, which
-- bypasses RLS — they keep working as before.
-- ============================================================

DROP POLICY IF EXISTS contact_tags_insert ON contact_tags;
DROP POLICY IF EXISTS contact_tags_update ON contact_tags;

CREATE POLICY contact_tags_insert ON contact_tags FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_tags.contact_id AND is_account_member(c.account_id, 'agent'))
  AND EXISTS (SELECT 1 FROM tags t WHERE t.id = contact_tags.tag_id)
  AND (
    NOT is_xlr8_estado_tag(contact_tags.tag_id)
    OR EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_tags.contact_id AND is_account_member(c.account_id, 'admin'))
  )
);

CREATE POLICY contact_tags_update ON contact_tags FOR UPDATE USING (
  EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_tags.contact_id AND is_account_member(c.account_id, 'agent'))
  AND EXISTS (SELECT 1 FROM tags t WHERE t.id = contact_tags.tag_id)
  AND (
    NOT is_xlr8_estado_tag(contact_tags.tag_id)
    OR EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_tags.contact_id AND is_account_member(c.account_id, 'admin'))
  )
) WITH CHECK (
  EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_tags.contact_id AND is_account_member(c.account_id, 'agent'))
  AND EXISTS (SELECT 1 FROM tags t WHERE t.id = contact_tags.tag_id)
  AND (
    NOT is_xlr8_estado_tag(contact_tags.tag_id)
    OR EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_tags.contact_id AND is_account_member(c.account_id, 'admin'))
  )
);
