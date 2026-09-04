-- ============================================================
-- CTWA (Click-To-WhatsApp Ads) referral tracking.
--
-- Meta attaches a `referral` object to the first — and potentially any
-- later — inbound message from a lead who tapped a "Click to WhatsApp"
-- ad. Each occurrence is stored as its own row (not upserted) so a
-- contact who arrives via one ad and later messages again from a
-- different ad keeps both attributions instead of the second silently
-- overwriting the first.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS conversation_referrals (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  -- Meta's ad id (referral.source_id). The webhook payload does not
  -- include the Ads Manager campaign/ad-set name — only this id plus
  -- the ad creative fields below.
  source_id TEXT,
  source_url TEXT,
  headline TEXT,
  body TEXT,
  media_type TEXT,
  image_url TEXT,
  video_url TEXT,
  ctwa_clid TEXT,
  -- Mirrors the inbound message's own timestamp (not insert time) so
  -- history ordering matches when the lead actually clicked through,
  -- even if webhook processing is delayed or retried.
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Sidebar lookup: all referrals for a conversation, most recent first.
CREATE INDEX IF NOT EXISTS idx_conversation_referrals_conversation
  ON conversation_referrals(conversation_id, created_at DESC);

-- Report grouping: leads by ad, scoped per account.
CREATE INDEX IF NOT EXISTS idx_conversation_referrals_account_source
  ON conversation_referrals(account_id, source_id);

ALTER TABLE conversation_referrals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS conversation_referrals_select ON conversation_referrals;
DROP POLICY IF EXISTS conversation_referrals_modify ON conversation_referrals;

-- Read: any account member. Write: service role only (the webhook uses
-- the service-role client, which bypasses RLS) plus admins, in case a
-- referral row ever needs manual correction/removal.
CREATE POLICY conversation_referrals_select ON conversation_referrals FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY conversation_referrals_modify ON conversation_referrals FOR ALL
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

-- ============================================================
-- Reporting: leads grouped by ad.
--
-- Meta's webhook payload only gives us the ad id (source_id) and the
-- ad creative text (headline/body) — not the Ads Manager campaign or
-- ad-set name. This view groups on what we actually have; resolving
-- campaign/ad-set names would require a separate call to the Marketing
-- Graph API keyed off source_id.
-- ============================================================
-- security_invoker: without it, the view runs with the *owner's*
-- privileges and would bypass conversation_referrals' RLS entirely,
-- leaking every account's leads to any authenticated caller.
CREATE OR REPLACE VIEW leads_by_ad
WITH (security_invoker = true) AS
SELECT
  account_id,
  source_id,
  headline,
  body,
  source_url,
  COUNT(*) AS referral_count,
  COUNT(DISTINCT contact_id) AS distinct_leads,
  MIN(created_at) AS first_seen_at,
  MAX(created_at) AS last_seen_at
FROM conversation_referrals
GROUP BY account_id, source_id, headline, body, source_url;
