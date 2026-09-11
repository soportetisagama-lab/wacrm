-- ============================================================
-- flow_contact_state — per-contact memory across separate flow_runs.
--
-- Problem: every new flow_run starts with `vars: {}` and no notion of
-- what the customer already told a PRIOR run, or which menu options
-- they've already picked. That means:
--   1. A customer who already answered "ciudad"/"rubro" in an earlier
--      run gets asked the exact same questions again the next time
--      they go through collect_ai/collect_input.
--   2. A "topics" menu keeps re-showing an option the customer already
--      resolved (e.g. "Catálogo digital" after they already got it).
--
-- Fix: one row per (account_id, contact_id) accumulating two things,
-- SHARED across every flow this contact ever touches (the AI flow and
-- its manual clone ask the same questions under the same var_key/
-- reply_id names, so sharing means switching between them doesn't
-- lose what the customer already said):
--   - known_vars: { [var_key]: value } — merged into a NEW run's
--     `vars` at creation (insertAndAdvanceRun) so collect_ai's
--     "already known, don't ask again" logic and collect_input's
--     skip-if-known check both see it immediately.
--   - selected_options: { [node_key]: reply_id[] } — every button/list
--     row this contact has ever picked on that node, across all runs.
--     send_buttons/send_list nodes filter their own options against
--     this before sending (sendButtonsAndSuspend/sendListAndSuspend,
--     engine.ts) — the customer never sees an option twice.
--
-- Two SECURITY DEFINER functions (not a bare UPDATE from the app) so
-- the two write patterns — merge a jsonb object, append to a jsonb
-- array keyed by node_key — are atomic single statements, matching
-- claim_ai_reply_slot's own reasoning (029) rather than a client-side
-- read-modify-write that a concurrent inbound could race. GRANT
-- EXECUTE included in THIS migration — see the documented 031 mistake
-- (claim_ai_reply_slot shipped without it and silently never fired).
--
-- RLS: service-role-only, mirrors ai_usage_log (033) — this is
-- internal engine bookkeeping, not a customer-facing CRM concept (kept
-- deliberately separate from `tags`/`custom_fields`, which agents see
-- and manage themselves).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS flow_contact_state (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id        uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  known_vars        jsonb NOT NULL DEFAULT '{}'::jsonb,
  selected_options  jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_flow_contact_state_contact
  ON flow_contact_state(contact_id);

ALTER TABLE flow_contact_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS flow_contact_state_select ON flow_contact_state;
CREATE POLICY flow_contact_state_select ON flow_contact_state FOR SELECT
  USING (is_account_member(account_id, 'admin'));
-- No INSERT/UPDATE/DELETE policy for `authenticated` — written
-- exclusively by the service role via the two functions below.

CREATE OR REPLACE FUNCTION public.merge_flow_known_vars(
  p_account_id uuid,
  p_contact_id uuid,
  p_vars jsonb
)
RETURNS void AS $$
  INSERT INTO flow_contact_state (account_id, contact_id, known_vars)
  VALUES (p_account_id, p_contact_id, p_vars)
  ON CONFLICT (account_id, contact_id) DO UPDATE SET
    known_vars = flow_contact_state.known_vars || p_vars,
    updated_at = now();
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.record_flow_option_selected(
  p_account_id uuid,
  p_contact_id uuid,
  p_node_key text,
  p_reply_id text
)
RETURNS void AS $$
  INSERT INTO flow_contact_state (account_id, contact_id, selected_options)
  VALUES (p_account_id, p_contact_id, jsonb_build_object(p_node_key, jsonb_build_array(p_reply_id)))
  ON CONFLICT (account_id, contact_id) DO UPDATE SET
    selected_options = jsonb_set(
      flow_contact_state.selected_options,
      ARRAY[p_node_key],
      COALESCE(flow_contact_state.selected_options->p_node_key, '[]'::jsonb) || jsonb_build_array(p_reply_id),
      true
    ),
    updated_at = now();
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.merge_flow_known_vars(uuid, uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_flow_option_selected(uuid, uuid, text, text) TO service_role;
