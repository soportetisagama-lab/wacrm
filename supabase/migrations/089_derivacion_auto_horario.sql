-- ============================================================
-- Derivación automática: cola de fuera de horario.
--
--   - conversations.derivacion_pendiente_at: el traspaso llegó fuera
--     del horario de derivación (HORARIO_DERIVACION en
--     lib/derivacion-auto.ts). El cron de flujos la deriva al abrir el
--     horario, la más antigua primero, y la pone de nuevo en NULL al
--     reclamarla.
--
-- Requiere la 088. Idempotente: se puede ejecutar varias veces.
-- ============================================================

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS derivacion_pendiente_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS conversations_derivacion_pendiente_idx
  ON conversations(derivacion_pendiente_at)
  WHERE derivacion_pendiente_at IS NOT NULL;
