-- ============================================================
-- 075_message_usage_report.sql — Analista access + "Mensajes" report
--
-- 1. Rank 'analista' in is_account_member() at the same level as
--    'viewer' (1): read-only, never passes an 'agent' write check.
-- 2. Give analista the same read-only, account-wide visibility as
--    viewer in can_view_conversation() / can_view_contact(), so the
--    Panel metrics aren't all zero for them.
-- 3. message_usage(p_from, p_to): outbound messages per sender in a
--    date range, split into templates vs. everything else. Restricted
--    to owner / admin / analista. SECURITY DEFINER so it can count
--    across the whole account regardless of the caller's RLS scope.
--
--    Attribution: messages.sender_id (who pressed send — recorded by
--    the app from this release on). Older rows have no sender_id, so
--    they fall back to the conversation's current assigned_agent_id —
--    same rule that decides which Asesor sees the chat. Bot / flow /
--    automation sends come back as source 'bot', broadcast templates
--    (broadcast_recipients) as source 'broadcast'. Failed sends are
--    excluded (Meta doesn't bill them).
--
-- Idempotent.
-- ============================================================

-- ---- 1. is_account_member() -----------------------------------------
CREATE OR REPLACE FUNCTION is_account_member(
  target_account_id UUID,
  min_role account_role_enum DEFAULT 'viewer'
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM profiles p
    WHERE p.user_id = auth.uid()
      AND p.account_id = target_account_id
      AND CASE p.account_role
            WHEN 'owner'      THEN 7
            WHEN 'admin'      THEN 6
            WHEN 'gerencia'   THEN 5
            WHEN 'jefe_linea' THEN 4
            WHEN 'atc'        THEN 3
            WHEN 'agent'      THEN 2
            WHEN 'viewer'     THEN 1
            WHEN 'analista'   THEN 1
          END
        >=
          CASE min_role
            WHEN 'owner'      THEN 7
            WHEN 'admin'      THEN 6
            WHEN 'gerencia'   THEN 5
            WHEN 'jefe_linea' THEN 4
            WHEN 'atc'        THEN 3
            WHEN 'agent'      THEN 2
            WHEN 'viewer'     THEN 1
            WHEN 'analista'   THEN 1
          END
  );
$$;

-- ---- 2. read visibility -----------------------------------------------
CREATE OR REPLACE FUNCTION can_view_conversation(
  target_account_id UUID,
  target_assigned_agent_id UUID
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM profiles p
    WHERE p.user_id = auth.uid()
      AND p.account_id = target_account_id
      AND (
        p.account_role IN ('owner', 'admin', 'gerencia', 'atc', 'viewer', 'jefe_linea', 'analista')
        OR (p.account_role = 'agent' AND target_assigned_agent_id = auth.uid())
      )
  );
$$;

CREATE OR REPLACE FUNCTION can_view_contact(
  target_account_id UUID,
  target_contact_id UUID
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM profiles p
    WHERE p.user_id = auth.uid()
      AND p.account_id = target_account_id
      AND (
        p.account_role IN ('owner', 'admin', 'gerencia', 'atc', 'viewer', 'jefe_linea', 'analista')
        OR (
          p.account_role = 'agent'
          AND EXISTS (
            SELECT 1 FROM conversations c
            WHERE c.contact_id = target_contact_id
              AND c.assigned_agent_id = auth.uid()
          )
        )
      )
  );
$$;

-- ---- 3. message_usage() -----------------------------------------------
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);

CREATE OR REPLACE FUNCTION message_usage(p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
RETURNS TABLE (
  source TEXT,        -- 'agent' | 'bot' | 'broadcast'
  user_id UUID,       -- the Asesor for 'agent' rows (NULL = unattributed)
  templates BIGINT,
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
  )
  SELECT
    m.sender_type,
    CASE WHEN m.sender_type = 'agent'
         THEN COALESCE(m.sender_id, c.assigned_agent_id) END,
    COUNT(*) FILTER (WHERE m.content_type = 'template'),
    COUNT(*) FILTER (WHERE m.content_type <> 'template')
  FROM messages m
  JOIN conversations c ON c.id = m.conversation_id
  JOIN me ON me.account_id = c.account_id
  WHERE m.sender_type IN ('agent', 'bot')
    AND m.status <> 'failed'
    AND m.created_at >= p_from
    AND m.created_at < p_to
  GROUP BY 1, 2
  UNION ALL
  -- Broadcasts send templates straight to Meta without a messages row.
  SELECT 'broadcast', NULL::UUID, COUNT(*), 0
  FROM broadcast_recipients r
  JOIN broadcasts b ON b.id = r.broadcast_id
  JOIN me ON me.account_id = b.account_id
  WHERE r.status IN ('sent', 'delivered', 'read', 'replied')
    AND r.sent_at >= p_from
    AND r.sent_at < p_to
  HAVING COUNT(*) > 0;
$$;

ALTER FUNCTION message_usage(TIMESTAMPTZ, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION message_usage(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION message_usage(TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;
