-- ============================================================
-- Derivación automática: cola de fuera de horario.
--
--   - conversations.derivacion_pendiente_at: el traspaso llegó fuera
--     del horario de derivación (HORARIO_DERIVACION en
--     lib/derivacion-auto.ts). El cron de flujos la deriva al abrir el
--     horario, la más antigua primero, y la pone de nuevo en NULL al
--     reclamarla.
--   - conversations.derivacion_pendiente_agente: asesor asignado al
--     encolar (el propio traspaso puede asignarla). Si al abrir el
--     horario el asesor es otro, alguien la tomó en el CRM y no se deriva.
--
-- Requiere la 088. Idempotente: se puede ejecutar varias veces.
-- ============================================================

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS derivacion_pendiente_at TIMESTAMPTZ NULL;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS derivacion_pendiente_agente UUID NULL;

CREATE INDEX IF NOT EXISTS conversations_derivacion_pendiente_idx
  ON conversations(derivacion_pendiente_at)
  WHERE derivacion_pendiente_at IS NOT NULL;
