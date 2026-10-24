-- ============================================================
-- 079_ai_learning.sql — IA que aprende (todas las fases)
--
-- Una sola migración para las 5 fases, para no volver a pedir SQL:
--   1. Memoria por cliente           → contact_ai_memory
--   2. Aprendizaje de asesores       → ai_learning_candidates + status/source
--                                      en ai_knowledge_documents, active en chunks
--   3. Autorrevisión nocturna        → ai_learning_candidates (source='self_review')
--   4. Exámenes                      → ai_eval_cases + ai_eval_runs
--   5. Reportes                      → ai_daily_reports
--   Candado / auditoría de trabajos  → ai_job_runs
--
-- Seguridad: todas las tablas nuevas con RLS; SELECT solo admin+
-- (los asesores no ven nada del aprendizaje) y SIN políticas de
-- escritura para `authenticated`: escribe solo el service_role
-- (cron del servidor y rutas admin que usan el cliente admin).
--
-- Idempotente: se puede ejecutar más de una vez.
-- ============================================================

-- ------------------------------------------------------------
-- Trigger genérico de updated_at para estas tablas.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ai_learning_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- ai_job_runs — candado + bitácora de cada trabajo automático.
-- UNIQUE (job, run_key) es el candado: el primer INSERT gana y una
-- segunda instancia del servidor recibe un conflicto y no corre.
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_job_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  job          text NOT NULL CHECK (job IN (
                 'memory_sweep', 'advisor_learning', 'self_review',
                 'eval', 'daily_report', 'rollback')),
  run_key      text NOT NULL,
  status       text NOT NULL DEFAULT 'running' CHECK (status IN (
                 'running', 'done', 'failed', 'skipped', 'rolled_back')),
  stats        jsonb NOT NULL DEFAULT '{}'::jsonb,
  error        text,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  UNIQUE (job, run_key)
);

CREATE INDEX IF NOT EXISTS ai_job_runs_account_job_idx
  ON ai_job_runs (account_id, job, started_at DESC);

ALTER TABLE ai_job_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_job_runs_select ON ai_job_runs;
CREATE POLICY ai_job_runs_select ON ai_job_runs FOR SELECT
  USING (is_account_member(account_id, 'admin'));

-- ============================================================
-- Base de conocimiento: origen y estado de cada documento.
--   source: manual (lo carga el admin) | advisor_learning | self_review
--   status: active | candidate | archived | rolled_back
-- Los chunks llevan `active` desnormalizado para que las RPC de
-- búsqueda filtren sin JOIN. Lo existente queda manual + active.
-- ============================================================
ALTER TABLE ai_knowledge_documents
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS learning_run_id uuid REFERENCES ai_job_runs(id) ON DELETE SET NULL;

ALTER TABLE ai_knowledge_documents DROP CONSTRAINT IF EXISTS ai_knowledge_documents_source_check;
ALTER TABLE ai_knowledge_documents
  ADD CONSTRAINT ai_knowledge_documents_source_check
  CHECK (source IN ('manual', 'advisor_learning', 'self_review'));

ALTER TABLE ai_knowledge_documents DROP CONSTRAINT IF EXISTS ai_knowledge_documents_status_check;
ALTER TABLE ai_knowledge_documents
  ADD CONSTRAINT ai_knowledge_documents_status_check
  CHECK (status IN ('active', 'candidate', 'archived', 'rolled_back'));

CREATE INDEX IF NOT EXISTS ai_knowledge_documents_source_idx
  ON ai_knowledge_documents (account_id, source, status);

-- Los documentos aprendidos no se listan a los asesores: miembros ven
-- solo los manuales; admin+ ve todos.
DROP POLICY IF EXISTS ai_knowledge_documents_select ON ai_knowledge_documents;
CREATE POLICY ai_knowledge_documents_select ON ai_knowledge_documents FOR SELECT
  USING (
    is_account_member(account_id)
    AND (source = 'manual' OR is_account_member(account_id, 'admin'))
  );

ALTER TABLE ai_knowledge_chunks
  ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS ai_knowledge_chunks_account_active_idx
  ON ai_knowledge_chunks (account_id) WHERE active;

-- Búsqueda: mismo cuerpo que 032 (SECURITY INVOKER) + AND c.active.
CREATE OR REPLACE FUNCTION public.match_ai_knowledge_fts(
  p_account_id  uuid,
  p_query       text,
  p_match_count integer
)
RETURNS TABLE (id uuid, content text, rank real) AS $$
  SELECT c.id,
         c.content,
         ts_rank(c.fts, plainto_tsquery('simple', p_query)) AS rank
  FROM ai_knowledge_chunks c
  WHERE c.account_id = p_account_id
    AND c.active
    AND c.fts @@ plainto_tsquery('simple', p_query)
  ORDER BY rank DESC
  LIMIT GREATEST(p_match_count, 0);
$$ LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public;

CREATE OR REPLACE FUNCTION public.match_ai_knowledge_semantic(
  p_account_id      uuid,
  p_query_embedding text,
  p_match_count     integer
)
RETURNS TABLE (id uuid, content text, distance real) AS $$
  SELECT c.id,
         c.content,
         (c.embedding <=> p_query_embedding::vector(1536)) AS distance
  FROM ai_knowledge_chunks c
  WHERE c.account_id = p_account_id
    AND c.active
    AND c.embedding IS NOT NULL
  ORDER BY c.embedding <=> p_query_embedding::vector(1536)
  LIMIT GREATEST(p_match_count, 0);
$$ LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public;

REVOKE ALL ON FUNCTION public.match_ai_knowledge_fts(uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.match_ai_knowledge_fts(uuid, text, integer) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.match_ai_knowledge_semantic(uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.match_ai_knowledge_semantic(uuid, text, integer) TO authenticated, service_role;

-- ============================================================
-- contact_ai_memory — memoria por cliente (fase 1).
-- `memory` = JSON {busca, medidas, tipo_negocio, enviado, tono, notas},
-- sin precios ni datos personales (lo filtra el código antes y después
-- del modelo). `last_message_at_seen` marca hasta dónde se resumió;
-- "Borrar memoria" vacía `memory` y fija `cleared_at`: lo anterior a
-- esa hora ya no se vuelve a resumir.
-- SELECT solo admin+: el gerente no quiere que los asesores la vean.
-- ============================================================
CREATE TABLE IF NOT EXISTS contact_ai_memory (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id              uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id              uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  memory                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_conversation_id  uuid REFERENCES conversations(id) ON DELETE SET NULL,
  last_message_at_seen    timestamptz,
  cleared_at              timestamptz,
  model                   text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, contact_id)
);

CREATE INDEX IF NOT EXISTS contact_ai_memory_account_updated_idx
  ON contact_ai_memory (account_id, updated_at DESC);

ALTER TABLE contact_ai_memory ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contact_ai_memory_select ON contact_ai_memory;
CREATE POLICY contact_ai_memory_select ON contact_ai_memory FOR SELECT
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS contact_ai_memory_updated_at ON contact_ai_memory;
CREATE TRIGGER contact_ai_memory_updated_at
  BEFORE UPDATE ON contact_ai_memory
  FOR EACH ROW EXECUTE FUNCTION public.ai_learning_touch_updated_at();

-- ============================================================
-- ai_learning_candidates — respuestas de asesores (fase 2) y
-- autorrevisión del bot (fase 3), con la decisión del juez.
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_learning_candidates (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id             uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  job_run_id             uuid REFERENCES ai_job_runs(id) ON DELETE SET NULL,
  conversation_id        uuid REFERENCES conversations(id) ON DELETE SET NULL,
  message_id             uuid REFERENCES messages(id) ON DELETE SET NULL,
  source                 text NOT NULL CHECK (source IN ('advisor', 'self_review')),
  customer_text          text NOT NULL,
  reply_text             text NOT NULL,
  improved_text          text,
  verdict                text NOT NULL DEFAULT 'pending' CHECK (verdict IN (
                           'pending', 'accepted', 'rejected', 'rolled_back')),
  score                  numeric(5,2),
  reason                 text,
  rejected_by            text CHECK (rejected_by IS NULL OR rejected_by IN (
                           'guard_price', 'guard_personal_data', 'judge',
                           'duplicate', 'eval_regression')),
  knowledge_document_id  uuid REFERENCES ai_knowledge_documents(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  decided_at             timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_learning_candidates_message_source_uidx
  ON ai_learning_candidates (account_id, message_id, source)
  WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_learning_candidates_account_created_idx
  ON ai_learning_candidates (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_learning_candidates_run_idx
  ON ai_learning_candidates (job_run_id);

ALTER TABLE ai_learning_candidates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_learning_candidates_select ON ai_learning_candidates;
CREATE POLICY ai_learning_candidates_select ON ai_learning_candidates FOR SELECT
  USING (is_account_member(account_id, 'admin'));

-- ============================================================
-- ai_eval_cases — examen fijo por línea (fase 4).
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_eval_cases (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  question       text NOT NULL,
  expected       text NOT NULL,
  must_not       text,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_eval_cases_account_idx
  ON ai_eval_cases (account_id) WHERE active;

ALTER TABLE ai_eval_cases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_eval_cases_select ON ai_eval_cases;
CREATE POLICY ai_eval_cases_select ON ai_eval_cases FOR SELECT
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS ai_eval_cases_updated_at ON ai_eval_cases;
CREATE TRIGGER ai_eval_cases_updated_at
  BEFORE UPDATE ON ai_eval_cases
  FOR EACH ROW EXECUTE FUNCTION public.ai_learning_touch_updated_at();

-- ============================================================
-- ai_eval_runs — nota del examen antes / después de aprender.
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_eval_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  job_run_id    uuid REFERENCES ai_job_runs(id) ON DELETE SET NULL,
  phase         text NOT NULL CHECK (phase IN ('baseline', 'before', 'after')),
  score         numeric(5,2) NOT NULL,
  cases_total   integer NOT NULL DEFAULT 0,
  cases_passed  integer NOT NULL DEFAULT 0,
  details       jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_eval_runs_account_created_idx
  ON ai_eval_runs (account_id, created_at DESC);

ALTER TABLE ai_eval_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_eval_runs_select ON ai_eval_runs;
CREATE POLICY ai_eval_runs_select ON ai_eval_runs FOR SELECT
  USING (is_account_member(account_id, 'admin'));

-- ============================================================
-- ai_daily_reports — qué aprendió, nota antes/después, descartes,
-- retrocesos (fase 5). Uno por línea y día.
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_daily_reports (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  report_date      date NOT NULL,
  learned_count    integer NOT NULL DEFAULT 0,
  discarded_count  integer NOT NULL DEFAULT 0,
  memory_count     integer NOT NULL DEFAULT 0,
  eval_before      numeric(5,2),
  eval_after       numeric(5,2),
  rolled_back      boolean NOT NULL DEFAULT false,
  summary          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, report_date)
);

ALTER TABLE ai_daily_reports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_daily_reports_select ON ai_daily_reports;
CREATE POLICY ai_daily_reports_select ON ai_daily_reports FOR SELECT
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS ai_daily_reports_updated_at ON ai_daily_reports;
CREATE TRIGGER ai_daily_reports_updated_at
  BEFORE UPDATE ON ai_daily_reports
  FOR EACH ROW EXECUTE FUNCTION public.ai_learning_touch_updated_at();

-- ============================================================
-- ai_usage_log: nuevos modos de costo para el aprendizaje.
-- Mismo DROP + ADD que 046 / 059.
-- ============================================================
ALTER TABLE ai_usage_log
  DROP CONSTRAINT IF EXISTS ai_usage_log_mode_check;
ALTER TABLE ai_usage_log
  ADD CONSTRAINT ai_usage_log_mode_check
  CHECK (mode IN (
    'auto_reply', 'draft', 'flow_collect', 'context_classification',
    'memory', 'learning', 'self_review', 'eval'));
