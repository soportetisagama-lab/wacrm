-- ============================================================
-- 073_outbound_calls.sql
--
-- Business-initiated (outbound) WhatsApp calls, on top of 071.
-- For an outbound call the agent's browser sends the SDP *offer*; the
-- customer's WhatsApp answers and Meta delivers the SDP *answer* on the
-- `calls` webhook, stored here so the caller's browser (subscribed over
-- realtime) can complete the WebRTC handshake. answered_by = the
-- teammate who placed the call.
--
-- Idempotent.
-- ============================================================

ALTER TABLE whatsapp_calls ADD COLUMN IF NOT EXISTS answer_sdp TEXT;

CREATE INDEX IF NOT EXISTS idx_whatsapp_calls_account_created
  ON whatsapp_calls(account_id, created_at DESC);
