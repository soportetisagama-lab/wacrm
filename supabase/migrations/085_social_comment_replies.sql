-- ============================================================
-- 085_social_comment_replies.sql — respuesta automática a comentarios
--                                  de Facebook e Instagram
--
-- Requiere 080. Cuando alguien comenta una publicación o un anuncio de
-- la página de Facebook o de la cuenta de Instagram, el webhook responde
-- en público en el comentario y le manda un mensaje privado (Private
-- Replies de Meta). Cuando la persona contesta, el chat entra a la
-- bandeja como cualquier DM.
--
-- 1. social_channel_configs: interruptor (apagado por defecto) y los dos
--    textos editables. NULL = texto por defecto de la app.
-- 2. social_comment_replies: un registro por comentario procesado.
--    - PRIMARY KEY (channel, comment_id): Meta reintenta entregas y el
--      mismo comentario no se contesta dos veces.
--    - Límites: un mensaje privado por persona y publicación, y una
--      respuesta pública por persona y publicación cada 24 h.
--    Solo el service role (webhook) escribe; owner/admin pueden leer.
--
-- Idempotente: IF NOT EXISTS, DROP ... IF EXISTS.
-- ============================================================

-- ---- 1. Configuración ------------------------------------------------
ALTER TABLE social_channel_configs
  ADD COLUMN IF NOT EXISTS comment_replies_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE social_channel_configs
  ADD COLUMN IF NOT EXISTS comment_public_reply TEXT;
ALTER TABLE social_channel_configs
  ADD COLUMN IF NOT EXISTS comment_private_reply TEXT;

-- ---- 2. Registro de comentarios procesados ------------------------------
CREATE TABLE IF NOT EXISTS social_comment_replies (
  channel TEXT NOT NULL CHECK (channel IN ('instagram', 'messenger')),
  comment_id TEXT NOT NULL,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Publicación o anuncio (post_id en Facebook, media.id en Instagram).
  post_id TEXT,
  -- Quien comentó (id con alcance de la app; no es un teléfono).
  commenter_id TEXT NOT NULL,
  -- Momento en que se reservó / envió cada respuesta (NULL = no se envió).
  public_sent_at TIMESTAMPTZ,
  public_reply_id TEXT,
  public_error TEXT,
  private_sent_at TIMESTAMPTZ,
  private_message_id TEXT,
  private_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (channel, comment_id)
);

CREATE INDEX IF NOT EXISTS idx_social_comment_replies_person_post
  ON social_comment_replies (account_id, channel, post_id, commenter_id);

CREATE INDEX IF NOT EXISTS idx_social_comment_replies_created
  ON social_comment_replies (created_at);

ALTER TABLE social_comment_replies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS social_comment_replies_select ON social_comment_replies;
CREATE POLICY social_comment_replies_select ON social_comment_replies FOR SELECT
  USING (is_account_member(account_id, 'admin'));
-- Sin políticas de escritura: solo el service role (webhook) inserta y actualiza.
