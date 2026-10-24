-- ============================================================
-- 080_social_channels.sql — Instagram (DM) y Facebook Messenger
--
-- 1. Canal por contacto y por conversación: 'whatsapp' (por defecto,
--    todo lo existente), 'instagram', 'messenger' y 'tiktok' (reservado,
--    aún sin implementar). Los contactos de Instagram/Messenger no
--    tienen teléfono: se identifican por `channel_user_id` (IGSID /
--    PSID), único por cuenta y canal.
-- 2. `social_channel_configs`: una fila por cuenta y canal con la
--    página de Facebook, la cuenta de Instagram vinculada y el token de
--    página (cifrado por la app, igual que whatsapp_config). Solo
--    owner/admin la leen o modifican.
-- 3. `social_inbound_events`: candado de idempotencia por `mid` — Meta
--    reintenta entregas y el webhook no debe duplicar mensajes.
-- 4. Visibilidad: por defecto los chats de Instagram/Messenger solo los
--    ven owner/admin. Si el admin activa "Mostrar estos chats también a
--    los asesores" (`show_to_agents`), se aplican las reglas normales de
--    can_view_conversation()/can_view_contact(). Se implementa con
--    políticas RESTRICTIVE que se suman (AND) a las existentes, sin
--    tocarlas: para WhatsApp no cambia nada.
-- 5. Referidos de anuncios (Click-to-Instagram/Messenger): columnas
--    `channel`, `ref` y `raw` en conversation_referrals.
--
-- Idempotente: IF NOT EXISTS, CREATE OR REPLACE, DROP ... IF EXISTS.
-- ============================================================

-- ---- 1. Canal en contactos y conversaciones -------------------------
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'whatsapp';
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS channel_user_id TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS channel_username TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contacts_channel_check') THEN
    ALTER TABLE contacts ADD CONSTRAINT contacts_channel_check
      CHECK (channel IN ('whatsapp', 'instagram', 'messenger', 'tiktok'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_account_channel_user
  ON contacts (account_id, channel, channel_user_id)
  WHERE channel_user_id IS NOT NULL;

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'whatsapp';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'conversations_channel_check') THEN
    ALTER TABLE conversations ADD CONSTRAINT conversations_channel_check
      CHECK (channel IN ('whatsapp', 'instagram', 'messenger', 'tiktok'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_conversations_account_channel
  ON conversations (account_id, channel);

-- Una conversación siempre hereda el canal de su contacto, la cree quien
-- la cree (webhook, API pública, bandeja).
CREATE OR REPLACE FUNCTION conversations_inherit_channel()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  SELECT c.channel INTO NEW.channel FROM contacts c WHERE c.id = NEW.contact_id;
  IF NEW.channel IS NULL THEN
    NEW.channel := 'whatsapp';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_conversations_inherit_channel ON conversations;
CREATE TRIGGER trg_conversations_inherit_channel
  BEFORE INSERT ON conversations
  FOR EACH ROW EXECUTE FUNCTION conversations_inherit_channel();

-- ---- 2. Configuración por canal ---------------------------------------
CREATE TABLE IF NOT EXISTS social_channel_configs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Admin que guardó la configuración: autor de los inserts del webhook.
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('instagram', 'messenger', 'tiktok')),
  -- Id que Meta pone en entry.id del webhook: id de la página (Messenger)
  -- o id de la cuenta profesional de Instagram (Instagram).
  external_id TEXT NOT NULL,
  -- Página de Facebook (en Instagram, la página vinculada a la cuenta).
  page_id TEXT NOT NULL,
  -- Token de acceso de la página, cifrado por la app (AES-GCM).
  access_token TEXT NOT NULL,
  display_name TEXT,
  username TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  -- "Mostrar estos chats también a los asesores". Apagado = solo admin+.
  show_to_agents BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, channel),
  UNIQUE (channel, external_id)
);

ALTER TABLE social_channel_configs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS social_channel_configs_select ON social_channel_configs;
CREATE POLICY social_channel_configs_select ON social_channel_configs FOR SELECT
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS social_channel_configs_modify ON social_channel_configs;
CREATE POLICY social_channel_configs_modify ON social_channel_configs FOR ALL
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

-- ---- 3. Idempotencia del webhook --------------------------------------
-- Solo el service role (webhook) escribe aquí: RLS activo y sin políticas.
CREATE TABLE IF NOT EXISTS social_inbound_events (
  channel TEXT NOT NULL,
  mid TEXT NOT NULL,
  account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (channel, mid)
);

ALTER TABLE social_inbound_events ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_social_inbound_events_created
  ON social_inbound_events (created_at);

-- ---- 4. Visibilidad solo admin (con interruptor) ------------------------
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

-- conversations
DROP POLICY IF EXISTS conversations_channel_visibility ON conversations;
CREATE POLICY conversations_channel_visibility ON conversations
  AS RESTRICTIVE FOR ALL
  USING (channel = 'whatsapp' OR can_view_social_channel(account_id, channel))
  WITH CHECK (channel = 'whatsapp' OR can_view_social_channel(account_id, channel));

-- contacts
DROP POLICY IF EXISTS contacts_channel_visibility ON contacts;
CREATE POLICY contacts_channel_visibility ON contacts
  AS RESTRICTIVE FOR ALL
  USING (channel = 'whatsapp' OR can_view_social_channel(account_id, channel))
  WITH CHECK (channel = 'whatsapp' OR can_view_social_channel(account_id, channel));

-- messages (por la conversación)
DROP POLICY IF EXISTS messages_channel_visibility ON messages;
CREATE POLICY messages_channel_visibility ON messages
  AS RESTRICTIVE FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM conversations c
      WHERE c.id = messages.conversation_id
        AND (c.channel = 'whatsapp' OR can_view_social_channel(c.account_id, c.channel))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM conversations c
      WHERE c.id = messages.conversation_id
        AND (c.channel = 'whatsapp' OR can_view_social_channel(c.account_id, c.channel))
    )
  );

-- message_reactions (por el mensaje)
DROP POLICY IF EXISTS message_reactions_channel_visibility ON message_reactions;
CREATE POLICY message_reactions_channel_visibility ON message_reactions
  AS RESTRICTIVE FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE m.id = message_reactions.message_id
        AND (c.channel = 'whatsapp' OR can_view_social_channel(c.account_id, c.channel))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE m.id = message_reactions.message_id
        AND (c.channel = 'whatsapp' OR can_view_social_channel(c.account_id, c.channel))
    )
  );

-- ---- 5. Referidos de anuncios ---------------------------------------
ALTER TABLE conversation_referrals ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'whatsapp';
ALTER TABLE conversation_referrals ADD COLUMN IF NOT EXISTS ref TEXT;
ALTER TABLE conversation_referrals ADD COLUMN IF NOT EXISTS raw JSONB;

DROP POLICY IF EXISTS conversation_referrals_channel_visibility ON conversation_referrals;
CREATE POLICY conversation_referrals_channel_visibility ON conversation_referrals
  AS RESTRICTIVE FOR ALL
  USING (channel = 'whatsapp' OR can_view_social_channel(account_id, channel))
  WITH CHECK (channel = 'whatsapp' OR can_view_social_channel(account_id, channel));

-- ============================================================
-- Validación manual (no hay arnés de tests SQL en el repo):
--   1. Como Asesor (agent) con show_to_agents = false: GET
--      /rest/v1/conversations?channel=eq.instagram devuelve 0 filas,
--      aunque la conversación esté asignada a él. Lo mismo en messages
--      y contacts de ese canal.
--   2. Como owner/admin: ve todas las conversaciones de los 3 canales.
--   3. Activar show_to_agents: el Asesor ve las de Instagram/Messenger
--      asignadas a él (regla normal de can_view_conversation).
--   4. WhatsApp: sin cambios para ningún rol.
-- ============================================================
