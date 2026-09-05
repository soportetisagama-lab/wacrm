-- ============================================================
-- BSUID (Business-Scoped User ID) support.
--
-- Meta is rolling out WhatsApp usernames. Once a user adopts a
-- username, their phone number is omitted from webhooks unless we've
-- exchanged a message/call with them in the last 30 days — instead we
-- get a BSUID (`user_id` on contacts[], `from_user_id` on messages[]),
-- which is always present regardless of username adoption.
--
-- This migration only adds the storage — it does not itself decide
-- when a NULL-phone contact gets created. That's the webhook's
-- findOrCreateContact: it always creates/resolves a contact by BSUID
-- when an inbound message has no phone number, unconditionally (a
-- lead who messages in from a username with no known number still
-- lands in the inbox like any other conversation). The
-- bsuid_request_contact_info_enabled toggle above governs a separate,
-- narrower decision — see its comment.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- 1. Per-account toggle: auto-send the REQUEST_CONTACT_INFO button to
--    a BSUID-only contact (one with no phone on file) on their first
--    such inbound message.
--
--    Scope, deliberately narrow: this gates ONLY the proactive
--    button send. It does NOT gate whether a BSUID-only contact gets
--    created in the first place — that always happens (see
--    findOrCreateContact in the webhook), independent of this column,
--    so a lead who messages in without a known phone number still
--    lands in the inbox like any other conversation. With this off,
--    a human agent can still ask for the number manually; we just
--    don't prompt for it automatically. (Named accordingly —
--    bsuid_request_contact_info_enabled, not e.g. bsuid_contacts_enabled
--    — to make that scope obvious from the column name alone.)
--
--    Lives on whatsapp_config (not accounts/profiles) because:
--      - it's WhatsApp-webhook behavior, not a generic account setting
--      - whatsapp_config is already loaded once per inbound webhook
--        delivery (processWebhook's phone_number_id lookup), so
--        gating on this column costs zero extra queries
--      - it inherits whatsapp_config's existing RLS as-is: any member
--        can read it, only admin+ can change it (migration 017) —
--        exactly the right access level for a settings flag
-- ============================================================
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS bsuid_request_contact_info_enabled BOOLEAN NOT NULL DEFAULT false;

-- ============================================================
-- 2. contacts: BSUID column + relax phone to nullable.
-- ============================================================

-- The BSUID (e.g. "US.13491208655302741918"). Nullable — only
-- populated for contacts first seen via a username/BSUID-only inbound
-- message; a contact created the normal way (phone always present)
-- never gets one unless Meta later attaches it.
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS whatsapp_user_id TEXT;

-- Optional: the human-readable @username, if the contact has adopted
-- one. Not required for identification (whatsapp_user_id is the
-- stable key) — captured because we're already touching this table
-- and it's useful to show in the UI.
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS whatsapp_username TEXT;

-- Mirrors idx_contacts_account_phone_normalized (migration 022):
-- unique per account, partial so contacts without a BSUID never
-- collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_account_whatsapp_user_id
  ON contacts (account_id, whatsapp_user_id)
  WHERE whatsapp_user_id IS NOT NULL;

-- A contact can now exist with only a BSUID and no phone. Every
-- existing row already has phone NOT NULL satisfied, so this is a
-- pure relaxation — no backfill needed.
ALTER TABLE contacts
  ALTER COLUMN phone DROP NOT NULL;
