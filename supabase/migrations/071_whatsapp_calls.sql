-- ============================================================
-- 071_whatsapp_calls.sql
--
-- WhatsApp Business Calling API — customer → business voice calls
-- answered from the inbox (browser / Android WebView over WebRTC).
--
-- One row per call. The webhook (service role) inserts it on Meta's
-- `connect` event with the customer's SDP offer and who should ring:
--
--   ring_user_id = the conversation's assigned Asesor, or NULL when the
--   conversation is unassigned (then the broad-visibility roles — ATC,
--   admins… — ring). Clients subscribe via realtime; RLS below reuses
--   can_view_conversation() so an Asesor only ever receives calls from
--   their own conversations.
--
-- Status: ringing → accepted → ended, or ringing → missed / rejected.
-- Only the service role writes (API route + webhook); members read.
--
-- Idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS whatsapp_calls (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  -- Meta's call id (wacid.…) — the key every call action uses.
  wa_call_id TEXT NOT NULL UNIQUE,
  phone_number_id TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'inbound'
    CHECK (direction IN ('inbound', 'outbound')),
  status TEXT NOT NULL DEFAULT 'ringing'
    CHECK (status IN ('ringing', 'accepted', 'ended', 'missed', 'rejected', 'failed')),
  offer_sdp TEXT,
  ring_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  answered_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  answered_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  duration_seconds INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_calls_conversation
  ON whatsapp_calls(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_whatsapp_calls_ringing
  ON whatsapp_calls(account_id, created_at)
  WHERE status = 'ringing';

-- Realtime UPDATEs must carry the full row so every ringing client
-- sees who answered / that it ended.
ALTER TABLE whatsapp_calls REPLICA IDENTITY FULL;

ALTER TABLE whatsapp_calls ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS whatsapp_calls_select ON whatsapp_calls;
CREATE POLICY whatsapp_calls_select ON whatsapp_calls FOR SELECT
  USING (can_view_conversation(account_id, ring_user_id));

REVOKE INSERT, UPDATE, DELETE ON whatsapp_calls FROM authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'whatsapp_calls'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE whatsapp_calls;
  END IF;
END $$;
