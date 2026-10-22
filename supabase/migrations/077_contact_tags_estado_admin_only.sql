-- ============================================================
-- 077_contact_tags_estado_admin_only.sql
--
-- The 13 xlr8 status tags (ASIGNADO, NO CONTESTADO, CONTESTADO,
-- SEGUIMIENTO, CAIDO, CERRADO, ANTICIPO, VISITA, VENTA FUTURA,
-- SERVICIO, EN EVALUACION, SPAM, CERRADO 0 — see src/lib/xlr8/estados.ts)
-- can only be REMOVED from a contact by an admin/owner. Any member
-- with agent rank or above can still add them.
--
-- The inbox writes contact_tags straight from the browser, so this
-- policy is the real guard; the UI only hides the "x".
--
-- A status tag = a SHARED tag whose name (trimmed, collapsed spaces,
-- upper-cased) is one of the 13. Personal tags with the same name are
-- not affected. Renaming/deleting the tags themselves is already
-- admin/owner-only (shared tags, migration 069).
--
-- The xlr8 sync (src/lib/xlr8/sync.ts) uses the service role, which
-- bypasses RLS — it keeps working as before.
--
-- Replaces the single FOR ALL `contact_tags_modify` policy from 069
-- with per-command policies; INSERT keeps exactly the same rule.
-- ============================================================

CREATE OR REPLACE FUNCTION is_xlr8_estado_tag(p_tag_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM tags t
    WHERE t.id = p_tag_id
      AND t.is_shared
      AND upper(regexp_replace(btrim(t.name), '\s+', ' ', 'g')) IN (
        'ASIGNADO', 'NO CONTESTADO', 'CONTESTADO', 'SEGUIMIENTO', 'CAIDO',
        'CERRADO', 'ANTICIPO', 'VISITA', 'VENTA FUTURA', 'SERVICIO',
        'EN EVALUACION', 'SPAM', 'CERRADO 0'
      )
  );
$$;

DROP POLICY IF EXISTS contact_tags_modify ON contact_tags;
DROP POLICY IF EXISTS contact_tags_insert ON contact_tags;
DROP POLICY IF EXISTS contact_tags_update ON contact_tags;
DROP POLICY IF EXISTS contact_tags_delete ON contact_tags;

CREATE POLICY contact_tags_insert ON contact_tags FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_tags.contact_id AND is_account_member(c.account_id, 'agent'))
  AND EXISTS (SELECT 1 FROM tags t WHERE t.id = contact_tags.tag_id)
);

-- Changing tag_id on an existing row would also drop the status tag,
-- so UPDATE follows the same rule as DELETE for the old row.
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
);

CREATE POLICY contact_tags_delete ON contact_tags FOR DELETE USING (
  EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_tags.contact_id AND is_account_member(c.account_id, 'agent'))
  AND EXISTS (SELECT 1 FROM tags t WHERE t.id = contact_tags.tag_id)
  AND (
    NOT is_xlr8_estado_tag(contact_tags.tag_id)
    OR EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_tags.contact_id AND is_account_member(c.account_id, 'admin'))
  )
);
