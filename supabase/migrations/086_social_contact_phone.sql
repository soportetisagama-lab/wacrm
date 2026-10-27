-- ============================================================
-- 086_social_contact_phone.sql — celular de los contactos de
--                                 Instagram y Messenger
--
-- Requiere 080 y 081. Antes de derivar un chat de Instagram/Messenger,
-- el bot pide el celular (igual que en WhatsApp a los contactos sin
-- número) y deriva recién cuando el cliente lo escribe.
--
-- El número NO va en `contacts.phone`: la 081 lo prohíbe a propósito,
-- porque findExistingContact() busca por `phone` y los WhatsApp de esa
-- persona terminarían dentro del chat de la red social. Por eso va en
-- una columna aparte, `contact_phone`, que solo se muestra y se usa para
-- contactar al cliente; ninguna búsqueda ni fusión de contactos la lee.
--
-- Idempotente.
-- ============================================================

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS contact_phone TEXT;

COMMENT ON COLUMN contacts.contact_phone IS
  'Celular que escribió un contacto de Instagram/Messenger (solo dígitos, con código de país). No se usa para buscar ni fusionar contactos (ver 081).';
