-- ============================================================
-- 068_contacts_delete_gerencia.sql
--
-- Only Gerencia, Administrador (admin) and owner may delete contacts.
-- Jefe de Línea, ATC and Asesor keep create/edit (contacts_insert /
-- contacts_update are unchanged) but can no longer delete.
--
-- The contacts page hides the delete actions for those roles
-- (canDeleteContacts in src/lib/auth/roles.ts); contacts are deleted
-- straight from the browser, so this policy is what actually enforces
-- it. Visibility scoping from 064 (can_view_contact) is kept.
-- ============================================================

DROP POLICY IF EXISTS contacts_delete ON contacts;
CREATE POLICY contacts_delete ON contacts FOR DELETE
  USING (is_account_member(account_id, 'gerencia') AND can_view_contact(account_id, id));
