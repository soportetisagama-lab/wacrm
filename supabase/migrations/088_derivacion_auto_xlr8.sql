-- ============================================================
-- Derivación automática de leads de WhatsApp al sistema PHP XLR8.
--
--   - profiles.xlr8_user_id: ID del usuario en XLR8 (opcional), único
--     por cuenta cuando no es null. El PHP responde con este ID y el CRM
--     asigna la conversación al perfil que lo tenga.
--   - conversations.derivado_auto_at: marca de idempotencia (una sola
--     derivación automática por conversación; lib/derivacion-auto.ts).
--   - set_member_xlr8_user_id(p_user_id, p_xlr8_user_id): solo owner o
--     admin, mismo contrato de SQLSTATE que la migración 040.
--   - El guard de columnas de privilegio (034/040) también cubre
--     xlr8_user_id: un usuario no puede ponerse un ID XLR8 a sí mismo.
--
-- Idempotente: se puede ejecutar varias veces.
-- ============================================================

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS xlr8_user_id INTEGER NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_xlr8_user_id_check'
  ) THEN
    ALTER TABLE profiles ADD CONSTRAINT profiles_xlr8_user_id_check
      CHECK (xlr8_user_id IS NULL OR xlr8_user_id > 0);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS profiles_account_xlr8_user_id_key
  ON profiles(account_id, xlr8_user_id)
  WHERE xlr8_user_id IS NOT NULL;

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS derivado_auto_at TIMESTAMPTZ NULL;

-- ============================================================
-- Guard de columnas de privilegio (034 → 040) + xlr8_user_id
-- ============================================================
CREATE OR REPLACE FUNCTION public.enforce_profile_privilege_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (NEW.account_role IS DISTINCT FROM OLD.account_role
      OR NEW.account_id IS DISTINCT FROM OLD.account_id
      OR NEW.status IS DISTINCT FROM OLD.status
      OR NEW.xlr8_user_id IS DISTINCT FROM OLD.xlr8_user_id)
     AND current_user = 'authenticated'
  THEN
    RAISE EXCEPTION
      'account_role, account_id, status and xlr8_user_id cannot be changed directly; use the account member RPCs'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

-- ============================================================
-- set_member_xlr8_user_id(p_user_id, p_xlr8_user_id)
-- NULL borra el ID. Owner/admin pueden editar cualquier miembro de su
-- cuenta (incluido el owner y a sí mismos: un admin también atiende).
-- ============================================================
CREATE OR REPLACE FUNCTION public.set_member_xlr8_user_id(
  p_user_id UUID,
  p_xlr8_user_id INTEGER
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_target_account_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  IF p_xlr8_user_id IS NOT NULL AND p_xlr8_user_id <= 0 THEN
    RAISE EXCEPTION 'xlr8_user_id must be a positive integer' USING ERRCODE = '22023';
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

  SELECT account_id INTO v_target_account_id
  FROM profiles
  WHERE user_id = p_user_id;

  IF v_target_account_id IS NULL THEN
    RAISE EXCEPTION 'Target user not found' USING ERRCODE = '22023';
  END IF;

  IF v_target_account_id <> v_caller_account_id THEN
    RAISE EXCEPTION 'Target user is not a member of your account'
      USING ERRCODE = '42501';
  END IF;

  -- Un ID repetido en la cuenta falla con 23505 (índice único parcial).
  UPDATE profiles SET xlr8_user_id = p_xlr8_user_id WHERE user_id = p_user_id;
END;
$$;

ALTER FUNCTION public.set_member_xlr8_user_id(UUID, INTEGER) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_member_xlr8_user_id(UUID, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_member_xlr8_user_id(UUID, INTEGER) TO authenticated;
