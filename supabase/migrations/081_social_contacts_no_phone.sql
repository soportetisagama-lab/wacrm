-- ============================================================
-- 081_social_contacts_no_phone.sql — los contactos de Instagram y
--                                     Facebook no tienen teléfono
--
-- Requiere 080. Si un contacto de Instagram/Messenger tuviera teléfono,
-- findExistingContact() lo encontraría por número y los WhatsApp de esa
-- persona caerían en el chat de la red social. La interfaz y la API v1
-- ya no lo permiten; esto lo garantiza para cualquier escritura (incluida
-- la edición directa de la ficha, que va por PostgREST).
--
-- Idempotente.
-- ============================================================

CREATE OR REPLACE FUNCTION prevent_social_contact_phone()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.channel IS DISTINCT FROM 'whatsapp'
     AND NEW.phone IS NOT NULL
     AND btrim(NEW.phone) <> ''
  THEN
    RAISE EXCEPTION 'Los contactos de Instagram y Facebook no usan teléfono'
      USING ERRCODE = '23514';
  END IF;
  -- Un texto vacío se guarda como NULL (sin teléfono).
  IF NEW.channel IS DISTINCT FROM 'whatsapp' THEN
    NEW.phone := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS contacts_social_no_phone ON contacts;
CREATE TRIGGER contacts_social_no_phone
  BEFORE INSERT OR UPDATE OF phone, channel ON contacts
  FOR EACH ROW
  EXECUTE FUNCTION prevent_social_contact_phone();

-- Validación manual: UPDATE contacts SET phone = '+51999999999'
--   WHERE channel = 'instagram' → error "Los contactos de Instagram y
--   Facebook no usan teléfono". En WhatsApp no cambia nada.
