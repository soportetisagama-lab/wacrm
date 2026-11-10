-- ============================================================
-- 094_marcaciones_estado.sql — "Horarios de contacto" (Marketing)
--
-- Una fila por lead de xlr8 con la hora de su PRIMER cambio de estado
-- desde ASIGNADO (project_list.tiempo_estado), para saber a qué horas
-- los leads se marcan CONTESTADO o NO CONTESTADO.
--
--   - estado_inicial: estado visto la primera vez que xlr9 registra el
--     lead. Nunca se actualiza (es el que clasifica la marcación).
--   - estado_actual / asesor: se refrescan en cada sync.
--   - aproximado: true cuando el lead se registró más de 15 min después
--     de su tiempo_estado (carga histórica o sync caído): el estado pudo
--     haber avanzado antes de verlo, así que estado_inicial es aproximado.
--
-- Lo llena el sync de xlr8 (src/lib/xlr8/sync.ts) con la clave de
-- servicio. RLS: lectura solo owner / admin / analista de la cuenta
-- (igual que message_usage(), migraciones 075/076); escritura solo
-- service role (no hay políticas de escritura).
--
-- Idempotente: se puede ejecutar varias veces.
-- ============================================================

CREATE TABLE IF NOT EXISTS marcaciones_estado (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  lead_id BIGINT NOT NULL,
  celular TEXT NULL,
  estado_inicial TEXT NULL,
  estado_actual TEXT NULL,
  tiempo_estado TIMESTAMPTZ NOT NULL,
  asesor TEXT NULL,
  aproximado BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, lead_id)
);

CREATE INDEX IF NOT EXISTS idx_marcaciones_estado_account_tiempo
  ON marcaciones_estado(account_id, tiempo_estado);

DROP TRIGGER IF EXISTS set_updated_at ON marcaciones_estado;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON marcaciones_estado
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE marcaciones_estado ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS marcaciones_estado_select ON marcaciones_estado;
CREATE POLICY marcaciones_estado_select ON marcaciones_estado FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.user_id = auth.uid()
        AND p.account_id = marcaciones_estado.account_id
        AND p.account_role IN ('owner', 'admin', 'analista')
    )
  );

-- PostgREST: que la API vea la tabla nueva sin esperar.
NOTIFY pgrst, 'reload schema';
