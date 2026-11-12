-- ============================================================
-- Difusiones: etiqueta con el nombre de la difusión para todos los
-- que la recibieron.
--
--   - broadcasts.sent_tag_id: etiqueta de difusión (tags.is_broadcast,
--     091) con el mismo nombre de la difusión. La crea o reutiliza el
--     asistente al enviar. NULL = no se etiqueta a nadie.
--   - Trigger en broadcast_recipients: cuando un destinatario pasa a
--     enviado / entregado / leído / respondido, su contacto recibe esa
--     etiqueta. Los fallidos no. Cubre el envío desde el navegador y el
--     del servidor (worker), y las difusiones programadas al salir.
--   - Solo etiquetas is_broadcast: los comerciales no las ven (091).
--   - SECURITY DEFINER: el insert en contact_tags no depende del RLS de
--     quien actualiza el estado (navegador, worker o webhook).
--
-- Idempotente: se puede ejecutar varias veces.
-- ============================================================

ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS sent_tag_id UUID NULL REFERENCES tags(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_broadcasts_sent_tag
  ON broadcasts(sent_tag_id)
  WHERE sent_tag_id IS NOT NULL;

CREATE OR REPLACE FUNCTION broadcast_recipient_sent_tag()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status IN ('sent', 'delivered', 'read', 'replied')
     AND (TG_OP = 'INSERT' OR OLD.status NOT IN ('sent', 'delivered', 'read', 'replied')) THEN
    INSERT INTO contact_tags (contact_id, tag_id)
    SELECT NEW.contact_id, b.sent_tag_id
      FROM broadcasts b
      JOIN tags t ON t.id = b.sent_tag_id AND t.is_broadcast = true
     WHERE b.id = NEW.broadcast_id
    ON CONFLICT (contact_id, tag_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_broadcast_recipient_sent_tag ON broadcast_recipients;
CREATE TRIGGER trg_broadcast_recipient_sent_tag
  AFTER INSERT OR UPDATE OF status ON broadcast_recipients
  FOR EACH ROW
  EXECUTE FUNCTION broadcast_recipient_sent_tag();

-- PostgREST: que la API vea la columna nueva sin esperar.
NOTIFY pgrst, 'reload schema';
