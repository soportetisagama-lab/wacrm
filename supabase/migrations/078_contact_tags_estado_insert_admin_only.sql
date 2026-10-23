-- ============================================================
-- 078_contact_tags_estado_insert_admin_only.sql
--
-- Follow-up to 077. The tags the xlr8 sync manages can only be put on
-- or taken off a contact by an admin/owner; agents can do neither.
-- They're edited in xlr8 and the sync keeps them up to date:
--   * the 13 statuses (ASIGNADO, SPAM, … — XLR8_ESTADOS)
--   * the 5 lead types (PRODUCTO, PROYECTO, INFO, VOLVER A LLAMAR,
--     DISEÑO — XLR8_TIPOS), new here
-- See src/lib/xlr8/estados.ts.
--
-- Self-contained: it (re)creates is_xlr8_estado_tag() and the three
-- contact_tags write policies, so it works whether or not 077 ran.
--
-- The xlr8 sync, flows and automations use the service role, which
-- bypasses RLS — they keep working as before.
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
        'EN EVALUACION', 'SPAM', 'CERRADO 0',
        'PRODUCTO', 'PROYECTO', 'INFO', 'VOLVER A LLAMAR', 'DISEÑO'
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

CREATE POLICY contact_tags_delete ON contact_tags FOR DELETE USING (
  EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_tags.contact_id AND is_account_member(c.account_id, 'agent'))
  AND EXISTS (SELECT 1 FROM tags t WHERE t.id = contact_tags.tag_id)
  AND (
    NOT is_xlr8_estado_tag(contact_tags.tag_id)
    OR EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_tags.contact_id AND is_account_member(c.account_id, 'admin'))
  )
);
