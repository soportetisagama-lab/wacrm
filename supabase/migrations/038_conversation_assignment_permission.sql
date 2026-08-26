-- ============================================================
-- 038_conversation_assignment_permission.sql — who may set
--                                                assigned_agent_id
--
-- The problem
--
--   conversations_update (017) only checks account membership at
--   'agent' rank — it does not distinguish *which column* is being
--   written. Reassignment in the UI is a plain client-side
--   `supabase.from('conversations').update({ assigned_agent_id })`
--   (src/components/inbox/message-thread.tsx) with no API route in
--   front of it, so RLS is the only real enforcement point. Without
--   this migration, any Asesor (agent) could reassign any
--   conversation to anyone, which contradicts the business rule
--   "Asesor ve únicamente sus conversaciones asignadas, sin poder
--   reasignar nada [a otra persona]".
--
--   A rank check alone can't express this: the new roles (gerencia /
--   jefe_linea / atc) must sit at or above 'agent' rank so they keep
--   inheriting the existing operational-write policies (contacts,
--   deals, broadcasts, ...), but 'agent' itself must be EXCLUDED from
--   just this one capability. That needs an explicit allow-list, not
--   a >= comparison — mirrors canManageMembers/canDeleteAccount in
--   src/lib/auth/roles.ts, which are already allow-lists rather than
--   rank checks for the same reason.
--
-- The fix — and the exemption that was NOT in the first draft of
-- this migration
--
--   A BEFORE UPDATE trigger, same shape as
--   enforce_profile_privilege_columns (034): only fires when
--   assigned_agent_id actually changes, only restricts the browser/
--   PostgREST 'authenticated' role (current_user check — service-role
--   writers like the automations engine, the flows engine, and the
--   AI auto-reply handoff in src/lib/ai/auto-reply.ts all go through
--   supabaseAdmin(), so current_user is 'service_role' there, not
--   'authenticated' — exactly like 034 documents for profiles).
--
--   BUT: the inbox's AI "Take over" banner
--   (src/components/inbox/ai-thread-banner.tsx →
--   POST /api/ai/autoreply/[conversationId]) self-assigns the caller
--   via the RLS-scoped SSR client (its own comment says so verbatim:
--   "Writes go through the RLS-scoped SSR client"), and "Resume AI"
--   on that same route releases ANY existing assignment back to NULL
--   so the bot isn't left muted by a stale assignee. Both of those
--   run as an Asesor in the normal course of using the product. A
--   flat "agent can never touch this column" rule would break both.
--
--   So the restriction is narrowed to exactly the case the business
--   rule is actually about — assigning to SOMEONE ELSE:
--     - NEW.assigned_agent_id = auth.uid()  (claiming it for yourself)
--       → always allowed, any role.
--     - NEW.assigned_agent_id IS NULL       (releasing it)
--       → always allowed, any role.
--     - NEW.assigned_agent_id = <a different, specific user>
--       → only owner / admin / gerencia / jefe_linea / atc.
--
-- Scoped to UPDATE only (not INSERT), matching 034's own scope — new
-- conversations arrive unassigned via the webhook (service role,
-- bypasses this entirely).
--
-- Allow-list: owner, admin, gerencia, jefe_linea, atc.
-- Excluded (for third-party assignment only): agent (Asesor), viewer.
-- Keep this list in sync with canAssignConversations() in
-- src/lib/auth/roles.ts — that function is the single source of
-- truth the UI reads; this trigger is the DB-side backstop so the
-- rule holds even if a client bypasses the UI gate entirely.
--
-- Idempotent — CREATE OR REPLACE + DROP TRIGGER IF EXISTS.
-- ============================================================

CREATE OR REPLACE FUNCTION public.enforce_conversation_assignment_column()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_role account_role_enum;
BEGIN
  IF NEW.assigned_agent_id IS DISTINCT FROM OLD.assigned_agent_id
     AND current_user = 'authenticated'
     AND NEW.assigned_agent_id IS NOT NULL
     AND NEW.assigned_agent_id <> auth.uid()
  THEN
    SELECT account_role INTO v_role
    FROM profiles
    WHERE user_id = auth.uid();

    IF v_role IS NULL OR v_role NOT IN ('owner', 'admin', 'gerencia', 'jefe_linea', 'atc') THEN
      RAISE EXCEPTION 'Your role cannot assign this conversation to someone else'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_conversation_assignment_column() OWNER TO postgres;

DROP TRIGGER IF EXISTS enforce_conversation_assignment_column ON public.conversations;
CREATE TRIGGER enforce_conversation_assignment_column
  BEFORE UPDATE ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.enforce_conversation_assignment_column();

-- ============================================================
-- Manual validation (run against a live instance — no automated SQL
-- test harness exists in this repo, same caveat as 034):
--
--   1. As an Asesor (agent) JWT via PostgREST, this must return 42501
--      (insufficient_privilege):
--        PATCH /rest/v1/conversations?id=eq.<one assigned to someone else>
--        { "assigned_agent_id": "<a third teammate's user id>" }
--   2. As the same Asesor, claiming an unassigned conversation for
--      themselves must succeed:
--        PATCH /rest/v1/conversations?id=eq.<unassigned>
--        { "assigned_agent_id": "<their own user id>" }
--   3. As the same Asesor, releasing their own conversation (or any
--      conversation they can UPDATE at all per 039's conversations_update)
--      back to NULL must succeed.
--   4. As the same Asesor, updating a non-assignment column (status)
--      on their own conversation must still succeed.
--   5. As ATC / Jefe de Línea / Gerencia / admin / owner, assigning to
--      a specific third party must still succeed.
--   6. End-to-end: as an Asesor in the actual inbox UI, click "Take
--      over" on an AI-active conversation, then "Resume AI" — both
--      must succeed exactly as before this migration.
--   7. The automations engine action ("assign to agent") and the
--      flows engine's `assign_to` node action must still succeed —
--      they run through supabaseAdmin(), so current_user is
--      'service_role', not 'authenticated'.
-- ============================================================
