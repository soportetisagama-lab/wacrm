-- ============================================================
-- Flows: allow 'collect_ai' in flow_nodes.node_type.
--
-- 'collect_ai' (engine.ts, this build) runs a multi-turn LLM sub-loop
-- that fills a config-defined set of fields from free-text
-- conversation, asking only about what's still missing each turn,
-- then advances — see CollectAiNodeConfig in src/lib/flows/types.ts.
--
-- The engine and the CollectAiNodeConfig TS type already exist as of
-- this migration; without this CHECK update, inserting a flow_nodes
-- row with node_type='collect_ai' (from the builder UI, still to be
-- built, or from a direct API/SQL insert) would be rejected at the DB
-- layer. This migration and the engine/types work land in the same
-- step so the TS type and the DB constraint never drift apart.
--
-- flow_nodes.node_type's CHECK was defined inline in migration 010
-- (`node_type TEXT NOT NULL CHECK (node_type IN (...))`), which
-- Postgres names automatically as `<table>_<column>_check` —
-- `flow_nodes_node_type_check` here. Migration 043 used the same
-- DROP + re-ADD idiom to widen flows.trigger_type's inline CHECK.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE flow_nodes
  DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check;

ALTER TABLE flow_nodes
  ADD CONSTRAINT flow_nodes_node_type_check
  CHECK (node_type IN (
    'start',
    'send_buttons',
    'send_list',
    'send_message',
    'collect_input',
    'collect_ai',
    'condition',
    'set_tag',
    'handoff',
    'http_fetch',
    'end'
  ));
