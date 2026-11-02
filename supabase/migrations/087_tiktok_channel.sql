-- ============================================================
-- 087_tiktok_channel.sql — mensajes directos de TikTok (TikTok Business)
--
-- Requiere 080, 083 y 084. 'tiktok' ya está permitido en los CHECK de 080
-- (contacts, conversations y social_channel_configs). Aquí:
--
-- 1. social_channel_configs: el token de TikTok vence (a diferencia del
--    token de página de Meta) y se renueva con un refresh token. Columnas
--    nuevas, opcionales, cifradas por la app igual que access_token. Para
--    TikTok, external_id = page_id = id de la cuenta Business (open_id).
-- 2. Community Manager: por coherencia con Messenger e Instagram, también
--    ve, responde y puede ser asignado a los chats de TikTok. Se recrean
--    con 'tiktok' en la lista de canales:
--      - can_view_social_channel()        (vigente: 084)
--      - can_view_conversation(3 args)    (vigente: 083)
--      - can_view_contact()               (vigente: 083)
--      - políticas RESTRICTIVE del CM: insert de contacts/conversations,
--        contact_notes y conversation_referrals (vigente: 083)
--      - enforce_conversation_assignment_column() (vigente: 083)
--    Para los demás roles no cambia nada: los chats de TikTok siguen
--    siendo solo de owner/admin salvo "Mostrar estos chats también a los
--    asesores" (show_to_agents de la fila de TikTok), igual que en 080.
--
-- Si en esta línea se vuelve a ejecutar 083 o 084 después de este
-- archivo, vuelve a ejecutar este también.
--
-- Idempotente: ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE,
-- DROP ... IF EXISTS.
-- ============================================================

-- ---- 1. Tokens de TikTok ------------------------------------------------
ALTER TABLE social_channel_configs ADD COLUMN IF NOT EXISTS refresh_token TEXT;
ALTER TABLE social_channel_configs ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMPTZ;
ALTER TABLE social_channel_configs ADD COLUMN IF NOT EXISTS refresh_token_expires_at TIMESTAMPTZ;

-- ---- 2a. can_view_social_channel() (vigente: 084) ------------------------
CREATE OR REPLACE FUNCTION can_view_social_channel(
  target_account_id UUID,
  target_channel TEXT
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    target_channel IS NULL
    OR target_channel = 'whatsapp'
    OR is_account_member(target_account_id, 'admin')
    -- Community Manager: siempre Messenger, Instagram y TikTok.
    OR (
      target_channel IN ('messenger', 'instagram', 'tiktok')
      AND is_community_manager(target_account_id)
    )
    OR EXISTS (
      SELECT 1
      FROM social_channel_configs s
      WHERE s.account_id = target_account_id
        AND s.channel = target_channel
        AND s.show_to_agents
    );
$$;

ALTER FUNCTION can_view_social_channel(UUID, TEXT) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION can_view_social_channel(UUID, TEXT) TO authenticated, service_role;

-- ---- 2b. can_view_conversation() con canal (vigente: 083) ----------------
CREATE OR REPLACE FUNCTION can_view_conversation(
  target_account_id UUID,
  target_assigned_agent_id UUID,
  target_channel TEXT
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
        OR (
          p.account_role = 'community_manager'
          AND target_channel IN ('messenger', 'instagram', 'tiktok')
        )
      )
  );
$$;

ALTER FUNCTION can_view_conversation(UUID, UUID, TEXT) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION can_view_conversation(UUID, UUID, TEXT) TO authenticated, service_role;

-- ---- 2c. can_view_contact() (vigente: 083) --------------------------------
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
        -- Community Manager: contactos de Messenger, Instagram y TikTok.
        OR (
          p.account_role = 'community_manager'
          AND EXISTS (
            SELECT 1 FROM contacts ct
            WHERE ct.id = target_contact_id
              AND ct.channel IN ('messenger', 'instagram', 'tiktok')
          )
        )
      )
  );
$$;

-- ---- 2d. Restricciones solo para el Community Manager (vigente: 083) ------
DROP POLICY IF EXISTS contacts_community_manager_insert ON contacts;
CREATE POLICY contacts_community_manager_insert ON contacts
  AS RESTRICTIVE FOR INSERT
  WITH CHECK (NOT is_community_manager(account_id) OR channel IN ('messenger', 'instagram', 'tiktok'));

DROP POLICY IF EXISTS conversations_community_manager_insert ON conversations;
CREATE POLICY conversations_community_manager_insert ON conversations
  AS RESTRICTIVE FOR INSERT
  WITH CHECK (NOT is_community_manager(account_id) OR channel IN ('messenger', 'instagram', 'tiktok'));

DROP POLICY IF EXISTS contact_notes_community_manager ON contact_notes;
CREATE POLICY contact_notes_community_manager ON contact_notes
  AS RESTRICTIVE FOR ALL
  USING (
    NOT is_community_manager(account_id)
    OR EXISTS (
      SELECT 1 FROM contacts ct
      WHERE ct.id = contact_notes.contact_id
        AND ct.channel IN ('messenger', 'instagram', 'tiktok')
    )
  )
  WITH CHECK (
    NOT is_community_manager(account_id)
    OR EXISTS (
      SELECT 1 FROM contacts ct
      WHERE ct.id = contact_notes.contact_id
        AND ct.channel IN ('messenger', 'instagram', 'tiktok')
    )
  );

DROP POLICY IF EXISTS conversation_referrals_community_manager ON conversation_referrals;
CREATE POLICY conversation_referrals_community_manager ON conversation_referrals
  AS RESTRICTIVE FOR ALL
  USING (
    NOT is_community_manager(account_id)
    OR EXISTS (
      SELECT 1 FROM conversations c
      WHERE c.id = conversation_referrals.conversation_id
        AND c.channel IN ('messenger', 'instagram', 'tiktok')
    )
  )
  WITH CHECK (
    NOT is_community_manager(account_id)
    OR EXISTS (
      SELECT 1 FROM conversations c
      WHERE c.id = conversation_referrals.conversation_id
        AND c.channel IN ('messenger', 'instagram', 'tiktok')
    )
  );

-- ---- 2e. Asignación (vigente: 083) ----------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_conversation_assignment_column()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_role account_role_enum;
  v_check_cm BOOLEAN := false;
BEGIN
  -- a) Quién puede asignar a otra persona (038), solo en UPDATE desde el
  --    navegador.
  IF TG_OP = 'UPDATE' THEN
    IF NEW.assigned_agent_id IS DISTINCT FROM OLD.assigned_agent_id
       AND current_user = 'authenticated'
       AND NEW.assigned_agent_id IS NOT NULL
       AND NEW.assigned_agent_id <> auth.uid()
    THEN
      SELECT account_role INTO v_role
      FROM profiles
      WHERE user_id = auth.uid();

      IF v_role IS NULL
         OR v_role NOT IN ('owner', 'admin', 'gerencia', 'jefe_linea', 'atc', 'community_manager')
      THEN
        RAISE EXCEPTION 'Your role cannot assign this conversation to someone else'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;

    v_check_cm := NEW.assigned_agent_id IS NOT NULL
      AND (NEW.assigned_agent_id IS DISTINCT FROM OLD.assigned_agent_id
           OR NEW.channel IS DISTINCT FROM OLD.channel);
  ELSE
    v_check_cm := NEW.assigned_agent_id IS NOT NULL;
  END IF;

  -- b) Un Community Manager solo puede ser el asignado de Messenger,
  --    Instagram o TikTok, sea quien sea current_user (también service role).
  IF v_check_cm
     AND COALESCE(NEW.channel, 'whatsapp') NOT IN ('messenger', 'instagram', 'tiktok')
     AND public.user_is_community_manager(NEW.assigned_agent_id)
  THEN
    RAISE EXCEPTION 'A Community Manager can only be assigned Messenger, Instagram or TikTok conversations'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_conversation_assignment_column() OWNER TO postgres;
-- El trigger de 083 ya apunta a esta función: no hace falta recrearlo.

-- ============================================================
-- Validación manual (no hay arnés de tests SQL en el repo):
--   1. SELECT refresh_token, token_expires_at, refresh_token_expires_at
--      FROM social_channel_configs LIMIT 0;  → sin error.
--   2. Como Community Manager: GET /rest/v1/conversations?channel=eq.tiktok
--      devuelve los chats de TikTok (todos); WhatsApp sigue en 0 filas.
--   3. Como Asesor con show_to_agents = false en la fila de TikTok: 0
--      filas de TikTok, aunque estén asignadas a él.
--   4. Asignar un chat de TikTok a un Community Manager: funciona; uno
--      de WhatsApp: falla con check_violation.
--   5. Los demás roles y canales: sin cambios.
-- ============================================================
