-- ============================================================
-- 076_message_usage_by_category.sql — split the "Mensajes" report's
-- templates by Meta pricing category
--
-- Meta bills per delivered template, at a different rate per category:
--   marketing       -> always billed
--   utility         -> free inside an open 24 h customer-service window
--                      (customer wrote in the last 24 h), billed outside
--   authentication  -> billed
-- Free-form ("normal") messages can only be sent inside the window and
-- are free.
--
-- message_usage() now returns marketing / utility / utility_free /
-- authentication / others instead of templates / others. The category
-- comes from message_templates (matched by account + name); a template
-- we can't match counts as marketing, Meta's most expensive rate, so
-- the estimate never comes out low. utility_free = utility templates
-- sent while the customer had written in the previous 24 h.
-- Broadcast rows are never counted as in-window.
--
-- The return type changes, so the function is dropped and recreated.
-- Idempotent.
-- ============================================================

DROP FUNCTION IF EXISTS message_usage(TIMESTAMPTZ, TIMESTAMPTZ);

CREATE FUNCTION message_usage(p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
RETURNS TABLE (
  source TEXT,          -- 'agent' | 'bot' | 'broadcast'
  user_id UUID,         -- the Asesor for 'agent' rows (NULL = unattributed)
  marketing BIGINT,
  utility BIGINT,
  utility_free BIGINT,  -- subset of utility sent inside the 24 h window
  authentication BIGINT,
  others BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH me AS (
    SELECT account_id FROM profiles
    WHERE user_id = auth.uid()
      AND account_role IN ('owner', 'admin', 'analista')
  ),
  tpl AS (
    SELECT DISTINCT ON (t.name) t.name, lower(t.category) AS category
    FROM message_templates t
    JOIN me ON me.account_id = t.account_id
    ORDER BY t.name, t.updated_at DESC
  ),
  sent AS (
    SELECT
      m.sender_type AS src,
      CASE WHEN m.sender_type = 'agent'
           THEN COALESCE(m.sender_id, c.assigned_agent_id) END AS uid,
      CASE WHEN m.content_type <> 'template' THEN 'other'
           ELSE COALESCE(tpl.category, 'marketing') END AS cat,
      m.content_type = 'template' AND EXISTS (
        SELECT 1 FROM messages cm
        WHERE cm.conversation_id = m.conversation_id
          AND cm.sender_type = 'customer'
          AND cm.created_at <= m.created_at
          AND cm.created_at > m.created_at - INTERVAL '24 hours'
      ) AS in_window
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    JOIN me ON me.account_id = c.account_id
    LEFT JOIN tpl ON tpl.name = m.template_name
    WHERE m.sender_type IN ('agent', 'bot')
      AND m.status <> 'failed'
      AND m.created_at >= p_from
      AND m.created_at < p_to

    UNION ALL

    -- Broadcasts send templates straight to Meta without a messages row.
    SELECT 'broadcast', NULL::UUID, COALESCE(tpl.category, 'marketing'), FALSE
    FROM broadcast_recipients r
    JOIN broadcasts b ON b.id = r.broadcast_id
    JOIN me ON me.account_id = b.account_id
    LEFT JOIN tpl ON tpl.name = b.template_name
    WHERE r.status IN ('sent', 'delivered', 'read', 'replied')
      AND r.sent_at >= p_from
      AND r.sent_at < p_to
  )
  SELECT
    src,
    uid,
    COUNT(*) FILTER (WHERE cat = 'marketing'),
    COUNT(*) FILTER (WHERE cat = 'utility'),
    COUNT(*) FILTER (WHERE cat = 'utility' AND in_window),
    COUNT(*) FILTER (WHERE cat = 'authentication'),
    COUNT(*) FILTER (WHERE cat = 'other')
  FROM sent
  GROUP BY src, uid;
$$;

ALTER FUNCTION message_usage(TIMESTAMPTZ, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION message_usage(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION message_usage(TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;
