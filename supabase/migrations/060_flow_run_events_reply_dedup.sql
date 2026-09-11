-- ============================================================
-- flow_run_events: partial unique index to dedup 'reply_received' by
-- Meta message id, per run.
--
-- Problem: the engine's existing duplicate-inbound check
-- (isDuplicateInbound, lib/flows/engine.ts) is a plain SELECT-then-act
-- — it reads whether a 'reply_received' event with this meta_message_id
-- already exists, and only much later (inside handleReplyForActiveRun)
-- does it actually WRITE that event. If Meta redelivers the same
-- webhook (its documented at-least-once delivery) closely enough in
-- time, two concurrent deliveries can both pass the read-check before
-- either has written — a classic check-then-act race — and BOTH
-- proceed to advance the run and send the node's message. Every
-- suspending node type (collect_input, send_buttons, send_list) sends
-- its WhatsApp message BEFORE the optimistic-concurrency guard on
-- flow_runs.current_node_key runs, so even though that guard correctly
-- stops the run's STATE from double-advancing, it can't stop the
-- duplicate SEND — the message has already gone out by then.
--
-- Fix: make the 'reply_received' write itself the atomic claim,
-- instead of a separate read beforehand. This unique index is what
-- makes that possible — the engine now INSERTs 'reply_received' FIRST
-- (before any matching/advancing/sending), and a unique_violation
-- (23505) on a concurrent duplicate is treated as authoritative
-- "already claimed", short-circuiting before anything customer-facing
-- happens. Same idiom as idx_one_active_run_per_contact (migration
-- 017) protecting run creation.
--
-- Partial (WHERE event_type = 'reply_received') — every other event
-- type (started, node_entered, message_sent, handoff, ...) has no
-- meta_message_id and must not be constrained by this index.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_flow_run_events_reply_dedup
  ON flow_run_events (flow_run_id, (payload->>'meta_message_id'))
  WHERE event_type = 'reply_received';
