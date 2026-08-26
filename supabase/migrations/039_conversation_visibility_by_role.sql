-- ============================================================
-- 039_conversation_visibility_by_role.sql — Asesor sees only their
--                                            own assigned conversations
--
-- The problem
--
--   conversations_select (017) is a flat is_account_member(account_id)
--   check — every account member, including an Asesor (agent), can
--   read every conversation in the account. messages_select and
--   message_reactions_select have the same flatness (via a join back
--   to conversations). Restricting only conversations_select would
--   leave a gap: an Asesor blocked from listing a conversation could
--   still read its message content straight from the `messages` table,
--   since that policy doesn't check assignment either. All three need
--   to change together.
--
-- The fix
--
--   A new can_view_conversation(account_id, assigned_agent_id)
--   helper, same shape and SECURITY DEFINER rationale as
--   is_account_member (017): it reads `profiles` from inside another
--   table's policy body, which needs SECURITY DEFINER to read that
--   row reliably regardless of the caller's own RLS visibility into
--   profiles.
--
--   Visibility rule per role:
--     owner / admin / gerencia / atc / viewer  -> see every
--       conversation in the account (unchanged for all of these
--       except gerencia/atc, which are new roles with this scope by
--       design — Gerencia and ATC are both meant to see/dispatch
--       account-wide; viewer is explicitly left unrestricted per the
--       reviewed plan, same as it behaves today).
--     agent (Asesor)  -> only conversations where
--       assigned_agent_id = auth.uid(). This is the actual behavior
--       change this migration exists for.
--     jefe_linea  -> PLACEHOLDER: currently identical to gerencia
--       (account-wide), NOT scoped to "their line" yet. There is no
--       teams/lines table in this schema — Jefe de Línea's defining
--       trait (see one team's conversations only) needs one, and
--       building it was explicitly deferred (reviewed plan, "Opción
--       B"). THIS IS WHERE TO WIRE IT IN: once a `teams` table +
--       `profiles.team_id` + `conversations.team_id` exist, replace
--       the `'jefe_linea'` branch below with something like
--       `(p.account_role = 'jefe_linea' AND target_team_id = p.team_id)`
--       — mirroring how 'agent' is scoped to assigned_agent_id here.
--       Safe to defer: today there's at most one Jefe de Línea, so
--       "their line" and "every line" are the same set of rows.
--
--   Write policies (UPDATE/DELETE on conversations, ALL on messages/
--   message_reactions) combine can_view_conversation(...) — "is this
--   row in scope for you at all" — with the existing
--   is_account_member(account_id, 'agent') rank check — "do you have
--   write rank". The AND is required: can_view_conversation() alone
--   returns true for 'viewer' too (by design, for reads), and viewer
--   must stay read-only, which the rank check already guarantees
--   elsewhere and must keep guaranteeing here.
--
--   conversations_insert is untouched — creating a brand-new
--   conversation isn't "seeing an existing one", and 038 already
--   guards against inserting one with someone else's assignment via
--   the assignment-column trigger (scoped to UPDATE, per that
--   migration's own note, so this is a deliberate, narrow choice, not
--   an oversight — flag if a client-side "create conversation with
--   assignee" flow appears later and this needs revisiting).
--
-- Idempotent — CREATE OR REPLACE + DROP POLICY IF EXISTS.
-- ============================================================

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
        -- Broad-visibility roles: every conversation in the account.
        -- jefe_linea lives here as a placeholder — see header comment.
        p.account_role IN ('owner', 'admin', 'gerencia', 'atc', 'viewer', 'jefe_linea')
        -- Asesor: only conversations assigned to them.
        OR (p.account_role = 'agent' AND target_assigned_agent_id = auth.uid())
      )
  );
$$;

ALTER FUNCTION can_view_conversation(UUID, UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION can_view_conversation(UUID, UUID) TO authenticated, service_role;

-- ---- conversations ----------------------------------------------
DROP POLICY IF EXISTS conversations_select ON conversations;
CREATE POLICY conversations_select ON conversations FOR SELECT
  USING (can_view_conversation(account_id, assigned_agent_id));

DROP POLICY IF EXISTS conversations_update ON conversations;
CREATE POLICY conversations_update ON conversations FOR UPDATE
  USING (is_account_member(account_id, 'agent') AND can_view_conversation(account_id, assigned_agent_id));

DROP POLICY IF EXISTS conversations_delete ON conversations;
CREATE POLICY conversations_delete ON conversations FOR DELETE
  USING (is_account_member(account_id, 'agent') AND can_view_conversation(account_id, assigned_agent_id));

-- ---- messages ------------------------------------------------------
DROP POLICY IF EXISTS messages_select ON messages;
CREATE POLICY messages_select ON messages FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = messages.conversation_id
      AND can_view_conversation(c.account_id, c.assigned_agent_id)
  )
);

DROP POLICY IF EXISTS messages_modify ON messages;
CREATE POLICY messages_modify ON messages FOR ALL USING (
  EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = messages.conversation_id
      AND is_account_member(c.account_id, 'agent')
      AND can_view_conversation(c.account_id, c.assigned_agent_id)
  )
) WITH CHECK (
  EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = messages.conversation_id
      AND is_account_member(c.account_id, 'agent')
      AND can_view_conversation(c.account_id, c.assigned_agent_id)
  )
);
-- Service-role webhook inserts (Meta deliveries) bypass RLS as before
-- (unchanged from 017 — service_role is not subject to any policy).

-- ---- message_reactions ----------------------------------------------
DROP POLICY IF EXISTS message_reactions_select ON message_reactions;
CREATE POLICY message_reactions_select ON message_reactions FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = message_reactions.message_id
      AND can_view_conversation(c.account_id, c.assigned_agent_id)
  )
);

DROP POLICY IF EXISTS message_reactions_modify ON message_reactions;
CREATE POLICY message_reactions_modify ON message_reactions FOR ALL USING (
  EXISTS (
    SELECT 1 FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = message_reactions.message_id
      AND is_account_member(c.account_id, 'agent')
      AND can_view_conversation(c.account_id, c.assigned_agent_id)
  )
) WITH CHECK (
  EXISTS (
    SELECT 1 FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = message_reactions.message_id
      AND is_account_member(c.account_id, 'agent')
      AND can_view_conversation(c.account_id, c.assigned_agent_id)
  )
);

-- ============================================================
-- Manual validation (run against a live instance — no automated SQL
-- test harness exists in this repo):
--
--   1. As an Asesor (agent) JWT, GET /rest/v1/conversations must
--      return only rows where assigned_agent_id = their own user id.
--   2. As the same Asesor, GET /rest/v1/messages?conversation_id=eq.<id
--      of a conversation NOT assigned to them> must return zero rows,
--      even though the conversation id is guessable/known.
--   3. As ATC / Jefe de Línea / Gerencia / admin / owner, both
--      queries above must return every conversation/message in the
--      account, unchanged from today.
--   4. As viewer, both queries must still return everything
--      (read-only, unchanged from today) but any write must still
--      fail (unchanged — guaranteed by the existing 'agent' rank
--      check, not by this migration).
--   5. As an Asesor, PATCH status on their own conversation must
--      still succeed; PATCH status on a conversation not assigned to
--      them must now fail (previously succeeded).
-- ============================================================
