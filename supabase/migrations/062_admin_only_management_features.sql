-- ============================================================
-- 062_admin_only_management_features.sql
--
-- Two changes, bundled because the second depends on the first being
-- correct:
--
-- 1. BUGFIX — is_account_member() never actually ranked gerencia /
--    jefe_linea / atc.
--
--    037_extend_account_roles.sql added those three enum values and
--    said (in its own header comment) that placing them "between
--    agent and admin in the ordinal hierarchy used by
--    is_account_member()" would let every existing rank-gated policy
--    keep working for them with zero further SQL changes. That's true
--    IF is_account_member() actually ranks them — but its CASE
--    expression (017_account_sharing.sql) only ever had branches for
--    owner/admin/agent/viewer. A Postgres CASE with no matching WHEN
--    and no ELSE evaluates to NULL, and `NULL >= anything` is NULL,
--    which a WHERE clause treats as false. Concretely: for any
--    profile whose account_role is 'gerencia', 'jefe_linea', or
--    'atc', is_account_member(account_id) — even at the default
--    min_role 'viewer', the lowest possible bar — has always
--    evaluated to false. Every policy built on it (conversations,
--    messages, contacts, deals, pipelines, flows, automations,
--    broadcasts, ...) has been silently denying those three roles
--    access to data they were designed to have.
--
--    Fix: CREATE OR REPLACE with all seven roles ranked, matching
--    roleRank() in src/lib/auth/roles.ts exactly (owner=7 downward to
--    viewer=1) so the TS and SQL hierarchies read the same way.
--    Existing owner/admin/agent/viewer comparisons are unaffected —
--    relative order is preserved, only the three new roles go from
--    "always denied" to correctly ranked between agent and admin.
--
-- 2. Lock the six Administrador-only feature areas down at the RLS
--    layer, not just app code.
--
--    src/components/layout/sidebar.tsx now hides Embudos (pipelines),
--    Difusiones (broadcasts), Automatizaciones (automations), Flujos,
--    Agentes IA, and Configuración for every role except
--    Administrador (owner/admin) — Gerencia, Jefe de Línea, ATC,
--    Asesor and Visor keep only Panel/Bandeja/Notificaciones/
--    Contactos. Hiding the nav item is cosmetic on its own; the
--    routes and tables behind it need their own enforcement:
--
--      - automations / flows (+ flow_nodes / flow_runs /
--        flow_run_events / automation_steps): every API route under
--        /api/automations and /api/flows now calls
--        requireRole('admin') directly (service-role client, bypasses
--        RLS — the app-layer check is what actually matters there).
--        The SELECT/INSERT/UPDATE/DELETE policies here are bumped
--        from '' (any member) / 'agent' to 'admin' anyway, as
--        defense in depth and so the DB-level policy reflects the
--        real access rule instead of contradicting it.
--      - pipelines / pipeline_stages / deals / broadcasts /
--        broadcast_recipients: these are read directly from the
--        client (no API route in front of them), so RLS is the ONLY
--        enforcement layer for them — this migration is the actual
--        fix, not just hardening.
--
--    pipelines_insert/update/delete and pipeline_stages_modify were
--    already 'admin'; only their SELECT policies were open to every
--    member. deals / broadcasts / broadcast_recipients / automations /
--    automation_steps / flows / flow_nodes were 'agent' (or open, for
--    SELECT) across the board — all bumped to 'admin' here.
--
-- Idempotent — CREATE OR REPLACE FUNCTION, DROP POLICY IF EXISTS +
-- CREATE POLICY for every table touched.
-- ============================================================

-- ---- 1. is_account_member() bugfix ------------------------------

CREATE OR REPLACE FUNCTION is_account_member(
  target_account_id UUID,
  min_role account_role_enum DEFAULT 'viewer'
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM profiles p
    WHERE p.user_id = auth.uid()
      AND p.account_id = target_account_id
      AND CASE p.account_role
            WHEN 'owner'      THEN 7
            WHEN 'admin'      THEN 6
            WHEN 'gerencia'   THEN 5
            WHEN 'jefe_linea' THEN 4
            WHEN 'atc'        THEN 3
            WHEN 'agent'      THEN 2
            WHEN 'viewer'     THEN 1
          END
        >=
          CASE min_role
            WHEN 'owner'      THEN 7
            WHEN 'admin'      THEN 6
            WHEN 'gerencia'   THEN 5
            WHEN 'jefe_linea' THEN 4
            WHEN 'atc'        THEN 3
            WHEN 'agent'      THEN 2
            WHEN 'viewer'     THEN 1
          END
  );
$$;

-- ---- 2. Administrador-only feature areas ------------------------

-- pipelines: only SELECT was open to every member.
DROP POLICY IF EXISTS pipelines_select ON pipelines;
CREATE POLICY pipelines_select ON pipelines FOR SELECT USING (is_account_member(account_id, 'admin'));

-- pipeline_stages: only SELECT was open to every member.
DROP POLICY IF EXISTS pipeline_stages_select ON pipeline_stages;
CREATE POLICY pipeline_stages_select ON pipeline_stages FOR SELECT USING (
  EXISTS (SELECT 1 FROM pipelines p WHERE p.id = pipeline_stages.pipeline_id AND is_account_member(p.account_id, 'admin'))
);

-- deals: SELECT was open; INSERT/UPDATE/DELETE were 'agent'.
DROP POLICY IF EXISTS deals_select ON deals;
DROP POLICY IF EXISTS deals_insert ON deals;
DROP POLICY IF EXISTS deals_update ON deals;
DROP POLICY IF EXISTS deals_delete ON deals;
CREATE POLICY deals_select ON deals FOR SELECT USING (is_account_member(account_id, 'admin'));
CREATE POLICY deals_insert ON deals FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY deals_update ON deals FOR UPDATE USING (is_account_member(account_id, 'admin'));
CREATE POLICY deals_delete ON deals FOR DELETE USING (is_account_member(account_id, 'admin'));

-- broadcasts: SELECT was open; INSERT/UPDATE/DELETE were 'agent'.
DROP POLICY IF EXISTS broadcasts_select ON broadcasts;
DROP POLICY IF EXISTS broadcasts_insert ON broadcasts;
DROP POLICY IF EXISTS broadcasts_update ON broadcasts;
DROP POLICY IF EXISTS broadcasts_delete ON broadcasts;
CREATE POLICY broadcasts_select ON broadcasts FOR SELECT USING (is_account_member(account_id, 'admin'));
CREATE POLICY broadcasts_insert ON broadcasts FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY broadcasts_update ON broadcasts FOR UPDATE USING (is_account_member(account_id, 'admin'));
CREATE POLICY broadcasts_delete ON broadcasts FOR DELETE USING (is_account_member(account_id, 'admin'));

-- broadcast_recipients: SELECT was open; modify (ALL) was 'agent'.
DROP POLICY IF EXISTS broadcast_recipients_select ON broadcast_recipients;
DROP POLICY IF EXISTS broadcast_recipients_modify ON broadcast_recipients;
CREATE POLICY broadcast_recipients_select ON broadcast_recipients FOR SELECT USING (
  EXISTS (SELECT 1 FROM broadcasts b WHERE b.id = broadcast_recipients.broadcast_id AND is_account_member(b.account_id, 'admin'))
);
CREATE POLICY broadcast_recipients_modify ON broadcast_recipients FOR ALL USING (
  EXISTS (SELECT 1 FROM broadcasts b WHERE b.id = broadcast_recipients.broadcast_id AND is_account_member(b.account_id, 'admin'))
) WITH CHECK (
  EXISTS (SELECT 1 FROM broadcasts b WHERE b.id = broadcast_recipients.broadcast_id AND is_account_member(b.account_id, 'admin'))
);

-- automations: SELECT was open; INSERT/UPDATE/DELETE were 'agent'.
-- Defense in depth — every /api/automations route already enforces
-- requireRole('admin') at the app layer (service-role client bypasses
-- RLS for writes), this just keeps the DB policy consistent.
DROP POLICY IF EXISTS automations_select ON automations;
DROP POLICY IF EXISTS automations_insert ON automations;
DROP POLICY IF EXISTS automations_update ON automations;
DROP POLICY IF EXISTS automations_delete ON automations;
CREATE POLICY automations_select ON automations FOR SELECT USING (is_account_member(account_id, 'admin'));
CREATE POLICY automations_insert ON automations FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY automations_update ON automations FOR UPDATE USING (is_account_member(account_id, 'admin'));
CREATE POLICY automations_delete ON automations FOR DELETE USING (is_account_member(account_id, 'admin'));

-- automation_steps: SELECT was open; modify (ALL) was 'agent'.
DROP POLICY IF EXISTS automation_steps_select ON automation_steps;
DROP POLICY IF EXISTS automation_steps_modify ON automation_steps;
CREATE POLICY automation_steps_select ON automation_steps FOR SELECT USING (
  EXISTS (SELECT 1 FROM automations a WHERE a.id = automation_steps.automation_id AND is_account_member(a.account_id, 'admin'))
);
CREATE POLICY automation_steps_modify ON automation_steps FOR ALL USING (
  EXISTS (SELECT 1 FROM automations a WHERE a.id = automation_steps.automation_id AND is_account_member(a.account_id, 'admin'))
) WITH CHECK (
  EXISTS (SELECT 1 FROM automations a WHERE a.id = automation_steps.automation_id AND is_account_member(a.account_id, 'admin'))
);

-- flows: SELECT was open; INSERT/UPDATE/DELETE were 'agent'. Defense
-- in depth — same reasoning as automations above.
DROP POLICY IF EXISTS flows_select ON flows;
DROP POLICY IF EXISTS flows_insert ON flows;
DROP POLICY IF EXISTS flows_update ON flows;
DROP POLICY IF EXISTS flows_delete ON flows;
CREATE POLICY flows_select ON flows FOR SELECT USING (is_account_member(account_id, 'admin'));
CREATE POLICY flows_insert ON flows FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY flows_update ON flows FOR UPDATE USING (is_account_member(account_id, 'admin'));
CREATE POLICY flows_delete ON flows FOR DELETE USING (is_account_member(account_id, 'admin'));

-- flow_nodes: SELECT was open; modify (ALL) was 'agent'.
DROP POLICY IF EXISTS flow_nodes_select ON flow_nodes;
DROP POLICY IF EXISTS flow_nodes_modify ON flow_nodes;
CREATE POLICY flow_nodes_select ON flow_nodes FOR SELECT USING (
  EXISTS (SELECT 1 FROM flows f WHERE f.id = flow_nodes.flow_id AND is_account_member(f.account_id, 'admin'))
);
CREATE POLICY flow_nodes_modify ON flow_nodes FOR ALL USING (
  EXISTS (SELECT 1 FROM flows f WHERE f.id = flow_nodes.flow_id AND is_account_member(f.account_id, 'admin'))
) WITH CHECK (
  EXISTS (SELECT 1 FROM flows f WHERE f.id = flow_nodes.flow_id AND is_account_member(f.account_id, 'admin'))
);

-- flow_runs: SELECT was open (service-role driven, no client writes).
DROP POLICY IF EXISTS flow_runs_select ON flow_runs;
CREATE POLICY flow_runs_select ON flow_runs FOR SELECT USING (is_account_member(account_id, 'admin'));

-- flow_run_events: SELECT was open (service-role driven, no client writes).
DROP POLICY IF EXISTS flow_run_events_select ON flow_run_events;
CREATE POLICY flow_run_events_select ON flow_run_events FOR SELECT USING (
  EXISTS (SELECT 1 FROM flow_runs r WHERE r.id = flow_run_events.flow_run_id AND is_account_member(r.account_id, 'admin'))
);
