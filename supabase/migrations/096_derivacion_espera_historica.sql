-- ============================================================
-- Derivación automática: espera por cupo lleno y carga histórica.
--
--   - conversations.derivacion_historica: la conversación se cargó a la
--     cola a mano (supabase/manual/derivacion_historica_semana.sql). Al
--     derivarla, el CRM envía `historico: true` al PHP para que no
--     duplique leads antiguos que ya están en XLR8.
--   - conversations.derivacion_clasificacion: clasificación lead/ATC de
--     la IA ({"tipo":"lead","motivo":""} o {"tipo":"atc","motivo":"..."}),
--     guardada la primera vez. Si el PHP responde cupo lleno
--     (sin_asesor / 503) la conversación vuelve a la cola con su turno, y
--     en los reintentos se reutiliza sin volver a llamar a la IA.
--
-- Requiere la 088 y la 089. Idempotente: se puede ejecutar varias veces.
-- ============================================================

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS derivacion_historica BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS derivacion_clasificacion JSONB NULL;
