-- ============================================================
-- Difusiones: etiqueta para quienes respondan.
--
--   - broadcasts.reply_tag_id: etiqueta que se pone a cada contacto
--     que responde a la difusión (toca un botón de la plantilla o
--     escribe). La aplica el webhook de WhatsApp al marcar el
--     destinatario como 'replied', y el botón "Etiquetar a los que
--     respondieron" del detalle la aplica en bloque a los que ya
--     respondieron. NULL = no se etiqueta a nadie.
--   - ON DELETE SET NULL: borrar la etiqueta no borra la difusión.
--
-- RLS: no hace falta política nueva. La columna hereda las de
-- broadcasts (062: solo admin+ puede leer/editar) y la creación de
-- etiquetas ya exige admin (017: tags_insert).
--
-- Idempotente: se puede ejecutar varias veces.
-- ============================================================

ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS reply_tag_id UUID NULL REFERENCES tags(id) ON DELETE SET NULL;

-- Acelera el SET NULL al borrar una etiqueta (solo filas con etiqueta).
CREATE INDEX IF NOT EXISTS idx_broadcasts_reply_tag
  ON broadcasts(reply_tag_id)
  WHERE reply_tag_id IS NOT NULL;

-- PostgREST: que la API vea la columna nueva sin esperar.
NOTIFY pgrst, 'reload schema';
