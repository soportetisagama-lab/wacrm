-- ============================================================
-- Repair flow_nodes.node_type's CHECK constraint.
--
-- Discovered live: an INSERT of node_type='send_media' failed against
-- flow_nodes_node_type_check on this project's database, even though
-- migration 016 (a much OLDER migration than this session's 045)
-- already adds 'send_media' to that same CHECK. That means this
-- project's schema has drifted from the migrations/ folder somewhere
-- before 016 — not just missing this session's 045/046 — so this
-- migration doesn't assume anything about what's currently live. It
-- DROPs and re-ADDs the constraint with the FULL list every node_type
-- the application code supports today, so the end state is correct
-- regardless of which prior migrations did or didn't actually run
-- here.
--
-- Run the three diagnostic SELECTs (node_type CHECK definition,
-- flow_runs.ai_turn_count existence, ai_usage_log.mode CHECK
-- definition) BEFORE this one — if any of them show more drift than
-- expected, stop and reconcile before applying more migrations blind.
--
-- Idempotent — safe to run multiple times, and safe to run whether or
-- not 016 / 045 already landed here.
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
    'send_media',
    'collect_input',
    'collect_ai',
    'condition',
    'set_tag',
    'handoff',
    'http_fetch',
    'end'
  ));
