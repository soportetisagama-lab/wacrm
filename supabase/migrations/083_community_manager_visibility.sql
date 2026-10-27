-- ============================================================
-- 083_community_manager_visibility.sql — qué ve y qué hace el
--                                         Community Manager
--
-- Requiere 082 (valor del enum ya confirmado).
--
-- Regla: el Community Manager ve y responde TODAS las conversaciones de
-- Facebook Messenger e Instagram de la cuenta, y sus contactos. NUNCA ve
-- conversaciones ni contactos de WhatsApp (ni de TikTok).
--
-- 0. Columna `channel` en contacts y conversations. Ya existe desde 080
--    (Inox); en una línea sin canales sociales se crea aquí con
--    'whatsapp' por defecto, así este archivo no depende de 080. 080
--    usa ADD COLUMN IF NOT EXISTS, así que después sigue aplicando.
-- 1. Rango en is_account_member(): 2, igual que 'agent' (Asesor). Así
--    pasa todos los controles de escritura de rango 'agent' (enviar
--    mensajes, crear y editar contactos y conversaciones) y ninguno de
--    supervisor (atc o más: plantillas, accesos rápidos, borrar
--    contactos — 068 exige 'gerencia' —, configuración). Lo que tiene
--    de más (asignar, reanudar IA, borrador con IA) va por listas
--    explícitas, no por rango.
-- 2. can_view_conversation(account, asignado, canal): versión nueva con
--    canal. La de 2 argumentos (039/075) NO cambia y sigue devolviendo
--    false para el Community Manager: así no ve llamadas de WhatsApp
--    (whatsapp_calls, 071) ni nada que la use sin canal. Las políticas
--    de conversations, messages y message_reactions pasan a la de 3.
-- 3. can_view_contact(): el Community Manager ve los contactos cuyo
--    canal es Messenger o Instagram.
-- 4. Políticas RESTRICTIVE solo para el Community Manager (para los
--    demás roles no cambian nada):
--      - INSERT en contacts y conversations: solo de Messenger/Instagram
--        (no puede crear contactos ni chats de WhatsApp).
--      - contact_notes (lectura plana por cuenta desde 017) y
--        conversation_referrals (041): solo las de sus canales.
--    contact_tags y contact_custom_values ya se filtran solos: sus
--    políticas consultan contacts, que aplica su RLS.
-- 5. Trigger enforce_conversation_assignment_column (038): el Community
--    Manager puede asignar/reasignar a otra persona las conversaciones
--    que ve.
--
-- En Inox, además, 084 lo agrega a can_view_social_channel() (080).
--
-- Idempotente: ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE,
-- DROP ... IF EXISTS.
-- ============================================================

-- ---- 0. Columna de canal (no-op si ya corrió 080) ---------------------
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'whatsapp';
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'whatsapp';

-- ---- 1. is_account_member() (vigente: 075) ----------------------------
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
            WHEN 'owner'             THEN 7
            WHEN 'admin'             THEN 6
            WHEN 'gerencia'          THEN 5
            WHEN 'jefe_linea'        THEN 4
            WHEN 'atc'               THEN 3
            WHEN 'agent'             THEN 2
            WHEN 'community_manager' THEN 2
            WHEN 'viewer'            THEN 1
            WHEN 'analista'          THEN 1
          END
        >=
          CASE min_role
            WHEN 'owner'             THEN 7
            WHEN 'admin'             THEN 6
            WHEN 'gerencia'          THEN 5
            WHEN 'jefe_linea'        THEN 4
            WHEN 'atc'               THEN 3
            WHEN 'agent'             THEN 2
            WHEN 'community_manager' THEN 2
            WHEN 'viewer'            THEN 1
            WHEN 'analista'          THEN 1
          END
  );
$$;

-- ¿El usuario actual es Community Manager en esta cuenta?
CREATE OR REPLACE FUNCTION is_community_manager(target_account_id UUID)
RETURNS BOOLEAN
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
      AND p.account_role = 'community_manager'
  );
$$;

ALTER FUNCTION is_community_manager(UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION is_community_manager(UUID) TO authenticated, service_role;

-- ---- 2. can_view_conversation() con canal -------------------------------
-- Misma regla que la de 2 argumentos (075) + el Community Manager para
-- Messenger e Instagram.
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
          AND target_channel IN ('messenger', 'instagram')
        )
      )
  );
$$;

ALTER FUNCTION can_view_conversation(UUID, UUID, TEXT) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION can_view_conversation(UUID, UUID, TEXT) TO authenticated, service_role;

-- conversations (vigente: 039)
DROP POLICY IF EXISTS conversations_select ON conversations;
CREATE POLICY conversations_select ON conversations FOR SELECT
  USING (can_view_conversation(account_id, assigned_agent_id, channel));

DROP POLICY IF EXISTS conversations_update ON conversations;
CREATE POLICY conversations_update ON conversations FOR UPDATE
  USING (is_account_member(account_id, 'agent') AND can_view_conversation(account_id, assigned_agent_id, channel));

DROP POLICY IF EXISTS conversations_delete ON conversations;
CREATE POLICY conversations_delete ON conversations FOR DELETE
  USING (is_account_member(account_id, 'agent') AND can_view_conversation(account_id, assigned_agent_id, channel));

-- messages (vigente: 039)
DROP POLICY IF EXISTS messages_select ON messages;
CREATE POLICY messages_select ON messages FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = messages.conversation_id
      AND can_view_conversation(c.account_id, c.assigned_agent_id, c.channel)
  )
);

DROP POLICY IF EXISTS messages_modify ON messages;
CREATE POLICY messages_modify ON messages FOR ALL USING (
  EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = messages.conversation_id
      AND is_account_member(c.account_id, 'agent')
      AND can_view_conversation(c.account_id, c.assigned_agent_id, c.channel)
  )
) WITH CHECK (
  EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = messages.conversation_id
      AND is_account_member(c.account_id, 'agent')
      AND can_view_conversation(c.account_id, c.assigned_agent_id, c.channel)
  )
);

-- message_reactions (vigente: 039)
DROP POLICY IF EXISTS message_reactions_select ON message_reactions;
CREATE POLICY message_reactions_select ON message_reactions FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = message_reactions.message_id
      AND can_view_conversation(c.account_id, c.assigned_agent_id, c.channel)
  )
);

DROP POLICY IF EXISTS message_reactions_modify ON message_reactions;
CREATE POLICY message_reactions_modify ON message_reactions FOR ALL USING (
  EXISTS (
    SELECT 1 FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = message_reactions.message_id
      AND is_account_member(c.account_id, 'agent')
      AND can_view_conversation(c.account_id, c.assigned_agent_id, c.channel)
  )
) WITH CHECK (
  EXISTS (
    SELECT 1 FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = message_reactions.message_id
      AND is_account_member(c.account_id, 'agent')
      AND can_view_conversation(c.account_id, c.assigned_agent_id, c.channel)
  )
);

-- ---- 3. can_view_contact() (vigente: 075) -------------------------------
-- contacts_select / contacts_update (064) y contacts_delete (068) ya la
-- usan; no hace falta recrear esas políticas.
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
        -- Community Manager: contactos de Messenger e Instagram.
        OR (
          p.account_role = 'community_manager'
          AND EXISTS (
            SELECT 1 FROM contacts ct
            WHERE ct.id = target_contact_id
              AND ct.channel IN ('messenger', 'instagram')
          )
        )
      )
  );
$$;

-- ---- 4. Restricciones solo para el Community Manager ---------------------
-- No crea contactos ni conversaciones de WhatsApp. En conversations el
-- canal lo pone el trigger de 080 (BEFORE INSERT) antes de este control.
DROP POLICY IF EXISTS contacts_community_manager_insert ON contacts;
CREATE POLICY contacts_community_manager_insert ON contacts
  AS RESTRICTIVE FOR INSERT
  WITH CHECK (NOT is_community_manager(account_id) OR channel IN ('messenger', 'instagram'));

DROP POLICY IF EXISTS conversations_community_manager_insert ON conversations;
CREATE POLICY conversations_community_manager_insert ON conversations
  AS RESTRICTIVE FOR INSERT
  WITH CHECK (NOT is_community_manager(account_id) OR channel IN ('messenger', 'instagram'));

-- Notas de contacto: solo las de contactos de sus canales.
DROP POLICY IF EXISTS contact_notes_community_manager ON contact_notes;
CREATE POLICY contact_notes_community_manager ON contact_notes
  AS RESTRICTIVE FOR ALL
  USING (
    NOT is_community_manager(account_id)
    OR EXISTS (
      SELECT 1 FROM contacts ct
      WHERE ct.id = contact_notes.contact_id
        AND ct.channel IN ('messenger', 'instagram')
    )
  )
  WITH CHECK (
    NOT is_community_manager(account_id)
    OR EXISTS (
      SELECT 1 FROM contacts ct
      WHERE ct.id = contact_notes.contact_id
        AND ct.channel IN ('messenger', 'instagram')
    )
  );

-- Referidos de anuncios: solo los de conversaciones de sus canales.
DROP POLICY IF EXISTS conversation_referrals_community_manager ON conversation_referrals;
CREATE POLICY conversation_referrals_community_manager ON conversation_referrals
  AS RESTRICTIVE FOR ALL
  USING (
    NOT is_community_manager(account_id)
    OR EXISTS (
      SELECT 1 FROM conversations c
      WHERE c.id = conversation_referrals.conversation_id
        AND c.channel IN ('messenger', 'instagram')
    )
  )
  WITH CHECK (
    NOT is_community_manager(account_id)
    OR EXISTS (
      SELECT 1 FROM conversations c
      WHERE c.id = conversation_referrals.conversation_id
        AND c.channel IN ('messenger', 'instagram')
    )
  );

-- ---- 5. Asignación (vigente: 038) ---------------------------------------
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

    IF v_role IS NULL
       OR v_role NOT IN ('owner', 'admin', 'gerencia', 'jefe_linea', 'atc', 'community_manager')
    THEN
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
-- Validación manual (no hay arnés de tests SQL en el repo):
--   1. Como Community Manager: GET /rest/v1/conversations devuelve solo
--      channel = messenger/instagram (todas, asignadas o no); lo mismo
--      en contacts, messages, message_reactions y contact_notes.
--   2. Con el id de una conversación o contacto de WhatsApp: 0 filas en
--      lectura, PATCH y DELETE.
--   3. Enviar un mensaje en un chat de Instagram/Messenger: funciona.
--      Crear un contacto (WhatsApp) desde PostgREST: falla por RLS.
--   4. Asignar un chat de Instagram a un Asesor: funciona. Borrar un
--      contacto: falla (068 exige 'gerencia').
--   5. whatsapp_calls: 0 filas.
--   6. Los demás roles: sin cambios.
-- ============================================================
