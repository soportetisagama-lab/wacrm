-- ============================================================
-- Flows: 'returning_message' entry trigger.
--
-- Problem: 'first_inbound_message' fires literally once per contact
-- (isFirstInboundMessage in the webhook checks for zero prior customer
-- messages). Once that flow's run reaches a terminal status
-- (completed / handed_off / timed_out / failed / paused_by_agent),
-- nothing re-triggers it — any later message from the same contact
-- falls through with no bot response unless it happens to match a
-- 'keyword' trigger on some other active flow.
--
-- Fix: a new trigger_type, 'returning_message', matches ANY inbound
-- text message when the contact has no active flow_run — a strict
-- superset of 'first_inbound_message' (which only matches when it's
-- literally the first message ever). A flow can switch to this trigger
-- to make itself restart every time the contact writes after finishing
-- a previous run.
--
-- Safety: findEntryFlow (src/lib/flows/engine.ts) now also refuses to
-- match ANY entry trigger — keyword, first_inbound_message, and this
-- new one alike — while the contact's conversation is 'pending' or has
-- assigned_agent_id set. That gate is enforced in application code
-- (a conversation lookup right before matching), not here; this
-- migration only widens the trigger_type vocabulary.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE flows
  DROP CONSTRAINT IF EXISTS flows_trigger_type_check;

ALTER TABLE flows
  ADD CONSTRAINT flows_trigger_type_check
  CHECK (trigger_type IN ('keyword', 'first_inbound_message', 'manual', 'returning_message'));
