-- ============================================================
-- 040_member_status_and_admin_edits.sql — active/inactive member
-- status + admin-driven name edits
--
-- Adds `profiles.status` ('active' | 'inactive') so an admin/owner
-- can lock a teammate out of the app without removing them from the
-- account (removal spins up a brand-new personal account for them —
-- overkill for "this person is on leave" or "offboarding pending").
--
-- Two new SECURITY DEFINER RPCs, same shape as `set_member_role`
-- (migration 018) and for the same reason: the `profiles_update` RLS
-- policy only lets a user edit their own row, so an admin editing a
-- teammate's name or status needs a supervised escape hatch that
-- self-checks the caller's authority.
--
--   - set_member_status(p_user_id, p_status)
--   - set_member_full_name(p_user_id, p_full_name)
--
-- Both: caller must be admin+, target must be a non-owner member of
-- the caller's account, target can't be the caller. Same SQLSTATE
-- contract as migration 018 (42501 forbidden / 22023 bad input) so
-- the existing `rpcErrorToResponse` mapping in the members API route
-- keeps working unmodified.
--
-- `status` is added to the privilege-column guard from migration 034
-- for the same reason `account_role`/`account_id` are guarded: without
-- it, the self-service PATCH path (profiles_update, auth.uid() =
-- user_id) would let a user flip their own status back to 'active'
-- after an admin deactivated them.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- profiles.status
-- ============================================================
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_status_check'
  ) THEN
    ALTER TABLE profiles ADD CONSTRAINT profiles_status_check
      CHECK (status IN ('active', 'inactive'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_profiles_account_status ON profiles(account_id, status);

-- ============================================================
-- Extend the privilege-column guard (034) to cover `status`
-- ============================================================
CREATE OR REPLACE FUNCTION public.enforce_profile_privilege_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (NEW.account_role IS DISTINCT FROM OLD.account_role
      OR NEW.account_id IS DISTINCT FROM OLD.account_id
      OR NEW.status IS DISTINCT FROM OLD.status)
     AND current_user = 'authenticated'
  THEN
    RAISE EXCEPTION
      'account_role, account_id and status cannot be changed directly; use the account member RPCs'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

-- Trigger already points at this function name (created in 034) —
-- CREATE OR REPLACE above is enough, no need to re-attach.

-- ============================================================
-- set_member_status(p_user_id, p_status)
-- ============================================================
CREATE OR REPLACE FUNCTION public.set_member_status(
  p_user_id UUID,
  p_status TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_target_account_id UUID;
  v_target_role account_role_enum;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  IF p_status NOT IN ('active', 'inactive') THEN
    RAISE EXCEPTION 'status must be active or inactive' USING ERRCODE = '22023';
  END IF;

  SELECT account_id, account_role
  INTO v_caller_account_id, v_caller_role
  FROM profiles
  WHERE user_id = auth.uid();

  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  IF v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher'
      USING ERRCODE = '42501';
  END IF;

  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot change your own status'
      USING ERRCODE = '22023';
  END IF;

  SELECT account_id, account_role
  INTO v_target_account_id, v_target_role
  FROM profiles
  WHERE user_id = p_user_id;

  IF v_target_account_id IS NULL THEN
    RAISE EXCEPTION 'Target user not found' USING ERRCODE = '22023';
  END IF;

  IF v_target_account_id <> v_caller_account_id THEN
    RAISE EXCEPTION 'Target user is not a member of your account'
      USING ERRCODE = '42501';
  END IF;

  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION 'Cannot change the account owner''s status'
      USING ERRCODE = '22023';
  END IF;

  UPDATE profiles SET status = p_status WHERE user_id = p_user_id;
END;
$$;

ALTER FUNCTION public.set_member_status(UUID, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_member_status(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_member_status(UUID, TEXT) TO authenticated;

-- ============================================================
-- set_member_full_name(p_user_id, p_full_name)
-- ============================================================
CREATE OR REPLACE FUNCTION public.set_member_full_name(
  p_user_id UUID,
  p_full_name TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_target_account_id UUID;
  v_target_role account_role_enum;
  v_trimmed TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  v_trimmed := trim(p_full_name);
  IF v_trimmed = '' THEN
    RAISE EXCEPTION 'full_name cannot be empty' USING ERRCODE = '22023';
  END IF;

  SELECT account_id, account_role
  INTO v_caller_account_id, v_caller_role
  FROM profiles
  WHERE user_id = auth.uid();

  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  IF v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher'
      USING ERRCODE = '42501';
  END IF;

  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Use your own profile settings to change your name'
      USING ERRCODE = '22023';
  END IF;

  SELECT account_id, account_role
  INTO v_target_account_id, v_target_role
  FROM profiles
  WHERE user_id = p_user_id;

  IF v_target_account_id IS NULL THEN
    RAISE EXCEPTION 'Target user not found' USING ERRCODE = '22023';
  END IF;

  IF v_target_account_id <> v_caller_account_id THEN
    RAISE EXCEPTION 'Target user is not a member of your account'
      USING ERRCODE = '42501';
  END IF;

  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION 'Cannot change the account owner''s name'
      USING ERRCODE = '22023';
  END IF;

  UPDATE profiles SET full_name = v_trimmed WHERE user_id = p_user_id;
END;
$$;

ALTER FUNCTION public.set_member_full_name(UUID, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_member_full_name(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_member_full_name(UUID, TEXT) TO authenticated;
