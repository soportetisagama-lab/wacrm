-- ============================================================
-- API de Conversiones de Meta para mensajería (business_messaging).
--
--   - whatsapp_config.meta_capi_dataset_id: conjunto de datos (dataset)
--     de la cuenta de WhatsApp Business. Lo obtiene o crea el servidor
--     solo (GET/POST /{waba_id}/dataset) con el token de la línea.
--   - meta_capi_events: una fila por señal (contacto + evento), para
--     no duplicar, reintentar y auditar. Solo guarda ctwa_clid, nunca
--     teléfonos. status: pending | sent | failed | skipped (skipped =
--     botón tocado por un contacto sin ctwa_clid; no se envió).
--
-- RLS: lectura solo admin+ de la cuenta; escritura solo service role
-- (el servidor usa la clave de servicio, que no pasa por RLS).
--
-- Idempotente: se puede ejecutar varias veces.
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS meta_capi_dataset_id TEXT NULL;

CREATE TABLE IF NOT EXISTS meta_capi_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  event_name TEXT NOT NULL,
  -- Evento, o "Purchase:<project_id>" para una compra de un proyecto.
  dedup_key TEXT NOT NULL,
  event_id TEXT NOT NULL,
  -- message | tag | quote | button | venta
  source TEXT NOT NULL,
  button_reply_id TEXT NULL,
  project_id TEXT NULL,
  ctwa_clid TEXT NULL,
  value NUMERIC(14, 2) NULL,
  currency TEXT NULL,
  event_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NULL,
  response JSONB NULL,
  error TEXT NULL,
  sent_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (contact_id, dedup_key),
  UNIQUE (event_id)
);

CREATE INDEX IF NOT EXISTS idx_meta_capi_events_account
  ON meta_capi_events(account_id, created_at DESC);

-- Reintentos pendientes (barrido del cron).
CREATE INDEX IF NOT EXISTS idx_meta_capi_events_retry
  ON meta_capi_events(next_attempt_at)
  WHERE status IN ('pending', 'failed') AND next_attempt_at IS NOT NULL;

DROP TRIGGER IF EXISTS set_updated_at ON meta_capi_events;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON meta_capi_events
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE meta_capi_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS meta_capi_events_select ON meta_capi_events;
CREATE POLICY meta_capi_events_select ON meta_capi_events FOR SELECT
  USING (is_account_member(account_id, 'admin'));

-- PostgREST: que la API vea la tabla y la columna nuevas sin esperar.
NOTIFY pgrst, 'reload schema';
