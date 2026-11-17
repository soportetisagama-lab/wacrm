-- ============================================================
-- 098_rls_bandeja_rapida.sql — RLS más barata para la Bandeja
--
-- Problema: la Bandeja pide conversations con
-- `*, contact:contacts(*, contact_tags(tags(*)))`. Cada política de
-- SELECT llamaba por FILA a una función SECURITY DEFINER que consulta
-- profiles (can_view_conversation, can_view_contact, is_account_member).
-- Una función SECURITY DEFINER no se "inlinea": son miles de llamadas
-- por página.
--
-- Solución: funciones auxiliares que devuelven, UNA vez por consulta,
-- las cuentas del usuario por grupo de rol (arreglos de uuid). Las
-- políticas las llaman envueltas en subselect `(SELECT ...)`, así
-- Postgres las evalúa como InitPlan (una vez) y por fila solo compara
-- `account_id = ANY($n)`.
--
-- Misma visibilidad que antes (vigentes: 083/087, 064, 069, 091, 080):
--   * owner, admin, gerencia, atc, viewer, jefe_linea, analista: todo
--     lo de su cuenta.
--   * agent: conversaciones asignadas a él; contactos con alguna
--     conversación asignada a él (igual que can_view_contact, sin
--     filtro de cuenta en la conversación).
--   * community_manager: canales sociales. La lista de canales se toma
--     de la can_view_conversation() vigente en ESTA línea: con 087
--     (solo Inox) messenger/instagram/tiktok; sin 087 messenger/instagram.
--   * Varias cuentas: cada arreglo trae todas las cuentas donde el
--     usuario tiene ese rol, y se compara con la cuenta de la fila,
--     igual que `p.account_id = target_account_id` en las funciones.
--
-- Políticas que se recrean (solo SELECT):
--   conversations_select, messages_select, contacts_select,
--   contact_tags_select, tags_select.
-- Solo donde existen (Inox, 080): conversations_channel_visibility,
--   contacts_channel_visibility, messages_channel_visibility (FOR ALL,
--   RESTRICTIVE): se antepone el atajo "owner/admin de la cuenta" y se
--   conserva can_view_social_channel() como última condición, así el
--   resultado es idéntico.
-- No se tocan: can_view_conversation(), can_view_contact(),
--   is_account_member() ni las políticas de INSERT/UPDATE/DELETE.
--
-- Si más adelante cambia la regla de visibilidad (otro rol, otro canal
-- del Community Manager), hay que cambiarla también aquí: vuelve a
-- ejecutar este archivo después de la migración que la cambie.
--
-- Idempotente: CREATE OR REPLACE, DROP POLICY IF EXISTS,
-- CREATE INDEX IF NOT EXISTS. Todo en una transacción.
-- ============================================================

BEGIN;

-- ---- 1. Funciones auxiliares ------------------------------------------

-- Cuentas donde el usuario actual tiene alguno de los roles dados.
CREATE OR REPLACE FUNCTION public.rls_account_ids(p_roles TEXT[])
RETURNS UUID[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(array_agg(DISTINCT p.account_id), '{}'::UUID[])
  FROM profiles p
  WHERE p.user_id = auth.uid()
    AND p.account_id IS NOT NULL
    AND p.account_role::TEXT = ANY (p_roles);
$$;

ALTER FUNCTION public.rls_account_ids(TEXT[]) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.rls_account_ids(TEXT[]) TO authenticated, service_role;

-- Contactos con alguna conversación asignada al usuario actual (regla del
-- agent en can_view_contact). Vacío si el usuario no es agent en ninguna
-- cuenta, para no recorrer conversations sin necesidad.
CREATE OR REPLACE FUNCTION public.rls_assigned_contact_ids()
RETURNS UUID[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(array_agg(DISTINCT c.contact_id), '{}'::UUID[])
  FROM conversations c
  WHERE c.assigned_agent_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.user_id = auth.uid()
        AND p.account_role = 'agent'
    );
$$;

ALTER FUNCTION public.rls_assigned_contact_ids() OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.rls_assigned_contact_ids() TO authenticated, service_role;

-- Canales del Community Manager: los mismos que la can_view_conversation()
-- vigente en esta línea (087 agrega tiktok). Si can_view_contact() no
-- coincide, se aborta para no cambiar la visibilidad.
DO $$
DECLARE
  v_conv TEXT := pg_get_functiondef(to_regprocedure('public.can_view_conversation(uuid,uuid,text)'));
  v_cont TEXT := pg_get_functiondef(to_regprocedure('public.can_view_contact(uuid,uuid)'));
  v_tiktok BOOLEAN;
BEGIN
  IF v_conv IS NULL OR v_cont IS NULL THEN
    RAISE EXCEPTION '098: faltan can_view_conversation(3) o can_view_contact (requiere 083)';
  END IF;

  v_tiktok := position('''tiktok''' IN v_conv) > 0;

  IF v_tiktok <> (position('''tiktok''' IN v_cont) > 0) THEN
    RAISE EXCEPTION '098: can_view_conversation y can_view_contact no coinciden en tiktok; revisa 083/087';
  END IF;

  EXECUTE format($f$
    CREATE OR REPLACE FUNCTION public.rls_cm_channels()
    RETURNS TEXT[]
    LANGUAGE sql
    IMMUTABLE
    AS $b$SELECT %L::TEXT[]$b$
  $f$, CASE WHEN v_tiktok THEN '{messenger,instagram,tiktok}' ELSE '{messenger,instagram}' END);
END;
$$;

GRANT EXECUTE ON FUNCTION public.rls_cm_channels() TO authenticated, service_role;

-- ---- 2. Índices ---------------------------------------------------------
-- Regla del agent (asignadas a él) y primera carga (más recientes).
CREATE INDEX IF NOT EXISTS idx_conversations_assigned_agent
  ON conversations(assigned_agent_id);
CREATE INDEX IF NOT EXISTS idx_conversations_last_message_at
  ON conversations(last_message_at DESC NULLS LAST);

-- ---- 3. conversations (vigente: 083) ------------------------------------
DROP POLICY IF EXISTS conversations_select ON conversations;
CREATE POLICY conversations_select ON conversations FOR SELECT
  USING (
    account_id = ANY ((SELECT public.rls_account_ids('{owner,admin,gerencia,atc,viewer,jefe_linea,analista}'))::uuid[])
    OR (
      assigned_agent_id = (SELECT auth.uid())
      AND account_id = ANY ((SELECT public.rls_account_ids('{agent}'))::uuid[])
    )
    OR (
      channel = ANY ((SELECT public.rls_cm_channels())::text[])
      AND account_id = ANY ((SELECT public.rls_account_ids('{community_manager}'))::uuid[])
    )
  );

-- ---- 4. messages (vigente: 083) -----------------------------------------
-- El subselect sobre conversations corre además con la RLS de
-- conversations (como antes).
DROP POLICY IF EXISTS messages_select ON messages;
CREATE POLICY messages_select ON messages FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = messages.conversation_id
      AND (
        c.account_id = ANY ((SELECT public.rls_account_ids('{owner,admin,gerencia,atc,viewer,jefe_linea,analista}'))::uuid[])
        OR (
          c.assigned_agent_id = (SELECT auth.uid())
          AND c.account_id = ANY ((SELECT public.rls_account_ids('{agent}'))::uuid[])
        )
        OR (
          c.channel = ANY ((SELECT public.rls_cm_channels())::text[])
          AND c.account_id = ANY ((SELECT public.rls_account_ids('{community_manager}'))::uuid[])
        )
      )
  )
);

-- ---- 5. contacts (vigente: 064 + can_view_contact de 087/083) -----------
DROP POLICY IF EXISTS contacts_select ON contacts;
CREATE POLICY contacts_select ON contacts FOR SELECT
  USING (
    account_id = ANY ((SELECT public.rls_account_ids('{owner,admin,gerencia,atc,viewer,jefe_linea,analista}'))::uuid[])
    OR (
      account_id = ANY ((SELECT public.rls_account_ids('{agent}'))::uuid[])
      AND id = ANY ((SELECT public.rls_assigned_contact_ids())::uuid[])
    )
    OR (
      account_id = ANY ((SELECT public.rls_account_ids('{community_manager}'))::uuid[])
      AND channel = ANY ((SELECT public.rls_cm_channels())::text[])
    )
  );

-- ---- 6. contact_tags (vigente: 069) -------------------------------------
-- is_account_member(account) = cualquier rol de la cuenta. Los
-- subselects siguen aplicando la RLS de contacts y tags, como antes.
DROP POLICY IF EXISTS contact_tags_select ON contact_tags;
CREATE POLICY contact_tags_select ON contact_tags FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM contacts c
    WHERE c.id = contact_tags.contact_id
      AND c.account_id = ANY ((SELECT public.rls_account_ids('{owner,admin,gerencia,jefe_linea,atc,agent,community_manager,viewer,analista}'))::uuid[])
  )
  AND EXISTS (SELECT 1 FROM tags t WHERE t.id = contact_tags.tag_id)
);

-- ---- 7. tags (vigente: 091) ---------------------------------------------
DROP POLICY IF EXISTS tags_select ON tags;
CREATE POLICY tags_select ON tags FOR SELECT
  USING (
    account_id = ANY ((SELECT public.rls_account_ids('{owner,admin,gerencia,jefe_linea,atc,agent,community_manager,viewer,analista}'))::uuid[])
    AND (
      account_id = ANY ((SELECT public.rls_account_ids('{owner,admin}'))::uuid[])
      OR (
        NOT is_broadcast
        AND (is_shared OR user_id = (SELECT auth.uid()))
      )
    )
  );

-- ---- 8. Visibilidad por canal social (solo si existe: Inox, 080) --------
-- Mismo resultado: can_view_social_channel() ya devuelve true para
-- owner/admin; el atajo solo evita la llamada por fila.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
             AND tablename = 'conversations' AND policyname = 'conversations_channel_visibility') THEN
    DROP POLICY conversations_channel_visibility ON conversations;
    CREATE POLICY conversations_channel_visibility ON conversations
      AS RESTRICTIVE FOR ALL
      USING (
        channel = 'whatsapp'
        OR account_id = ANY ((SELECT public.rls_account_ids('{owner,admin}'))::uuid[])
        OR can_view_social_channel(account_id, channel)
      )
      WITH CHECK (
        channel = 'whatsapp'
        OR account_id = ANY ((SELECT public.rls_account_ids('{owner,admin}'))::uuid[])
        OR can_view_social_channel(account_id, channel)
      );
  END IF;

  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
             AND tablename = 'contacts' AND policyname = 'contacts_channel_visibility') THEN
    DROP POLICY contacts_channel_visibility ON contacts;
    CREATE POLICY contacts_channel_visibility ON contacts
      AS RESTRICTIVE FOR ALL
      USING (
        channel = 'whatsapp'
        OR account_id = ANY ((SELECT public.rls_account_ids('{owner,admin}'))::uuid[])
        OR can_view_social_channel(account_id, channel)
      )
      WITH CHECK (
        channel = 'whatsapp'
        OR account_id = ANY ((SELECT public.rls_account_ids('{owner,admin}'))::uuid[])
        OR can_view_social_channel(account_id, channel)
      );
  END IF;

  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
             AND tablename = 'messages' AND policyname = 'messages_channel_visibility') THEN
    DROP POLICY messages_channel_visibility ON messages;
    CREATE POLICY messages_channel_visibility ON messages
      AS RESTRICTIVE FOR ALL
      USING (
        EXISTS (
          SELECT 1 FROM conversations c
          WHERE c.id = messages.conversation_id
            AND (
              c.channel = 'whatsapp'
              OR c.account_id = ANY ((SELECT public.rls_account_ids('{owner,admin}'))::uuid[])
              OR can_view_social_channel(c.account_id, c.channel)
            )
        )
      )
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM conversations c
          WHERE c.id = messages.conversation_id
            AND (
              c.channel = 'whatsapp'
              OR c.account_id = ANY ((SELECT public.rls_account_ids('{owner,admin}'))::uuid[])
              OR can_view_social_channel(c.account_id, c.channel)
            )
        )
      );
  END IF;
END;
$$;

COMMIT;

-- ============================================================
-- MEDICIÓN (antes y después). No es parte de la migración: copia el
-- bloque entre /* y */ y ejecútalo aparte, una vez ANTES de aplicar este
-- archivo y otra DESPUÉS. Solo lee; termina en ROLLBACK.
-- Para medir como asesor, cambia 'owner' por 'agent' (y por
-- 'community_manager' para ese rol).
-- ============================================================
/*
BEGIN;

-- Claims del usuario a medir (se leen como postgres, antes de cambiar de rol).
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub',  (SELECT user_id FROM profiles WHERE account_role = 'owner' LIMIT 1),
    'role', 'authenticated'
  )::TEXT,
  true
);

-- Control de visibilidad: filas según la regla antigua (funciones de 083/087),
-- calculadas como postgres. En Inox, la RLS añade además el filtro por canal
-- social de 080, así que ahí el número puede ser algo mayor que el de abajo.
SELECT
  (SELECT count(*) FROM conversations
    WHERE can_view_conversation(account_id, assigned_agent_id, channel)) AS conv_regla_antigua,
  (SELECT count(*) FROM contacts
    WHERE can_view_contact(account_id, id))                               AS contactos_regla_antigua;

SET LOCAL ROLE authenticated;

-- Lo que ve el usuario con la RLS vigente (debe coincidir con lo de arriba).
SELECT
  (SELECT count(*) FROM conversations) AS conv_visibles,
  (SELECT count(*) FROM contacts)      AS contactos_visibles;

-- Equivalente a una página de la Bandeja:
-- conversations?select=*,contact:contacts(*,contact_tags(tags(*)))&order=id&limit=1000
EXPLAIN (ANALYZE, BUFFERS)
SELECT conv.*,
       to_jsonb(ct) || jsonb_build_object(
         'contact_tags',
         (SELECT COALESCE(jsonb_agg(jsonb_build_object('tags', to_jsonb(t))), '[]'::jsonb)
            FROM contact_tags x
            LEFT JOIN LATERAL (SELECT * FROM tags WHERE tags.id = x.tag_id) t ON true
           WHERE x.contact_id = ct.id)
       ) AS contact
FROM conversations conv
LEFT JOIN LATERAL (SELECT * FROM contacts WHERE contacts.id = conv.contact_id) ct ON true
ORDER BY conv.id
LIMIT 1000;

ROLLBACK;
*/
