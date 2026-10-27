-- ============================================================
-- 084_community_manager_social_channels.sql — el Community Manager
--                                            pasa el filtro de 080
--
-- Requiere 080 y 083. Las políticas RESTRICTIVE de 080 dejan ver los
-- chats de Instagram/Messenger solo a owner/admin, salvo que la cuenta
-- active "Mostrar estos chats también a los asesores". El Community
-- Manager existe justamente para esos chats: los ve siempre, con el
-- interruptor encendido o apagado. Para WhatsApp no cambia nada (y 083
-- ya le cierra WhatsApp por can_view_conversation/can_view_contact).
--
-- Parte de la versión vigente (080) y solo agrega el Community Manager.
-- Si en una línea se vuelve a ejecutar 080 después de este archivo,
-- vuelve a ejecutar este también.
--
-- Idempotente: CREATE OR REPLACE.
-- ============================================================

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
    -- Community Manager: siempre Messenger e Instagram (nunca TikTok).
    OR (
      target_channel IN ('messenger', 'instagram')
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
