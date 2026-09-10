-- ============================================================
-- ai_configs: account-wide document catalog the general auto-reply
-- assistant can send on request (extends "Opción B" — real document
-- send, already shipped for collect_ai nodes via flow_nodes.config —
-- to the account-level assistant, which has no node of its own).
--
-- Deliberately its own column, not a reuse of any collect_ai node's
-- documents: a collect_ai node is scoped to one flow, and an account
-- can have several flows with different catalogs — there's no single
-- "correct" node to borrow from. Same shape as
-- CollectAiNodeConfig.documents (lib/flows/types.ts) — both reference
-- the shared AiDocument interface (lib/ai/types.ts) — but a separate
-- piece of config, same posture as system_context (collect_ai) vs
-- system_prompt (ai_configs) already being two distinct content
-- stores today.
--
-- Default '[]' — an account with no catalog configured behaves
-- exactly as before this column existed (buildSystemPrompt never
-- mentions documents, parseGeneration never has a key to validate
-- against).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS documents JSONB NOT NULL DEFAULT '[]'::jsonb;
