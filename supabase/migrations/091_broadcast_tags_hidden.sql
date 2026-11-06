-- ============================================================
-- 091_broadcast_tags_hidden.sql
--
-- Difusiones: las etiquetas que MKT pone a quienes responden una
-- difusión (090, broadcasts.reply_tag_id) son "etiquetas de difusión"
-- y solo existen dentro de Difusiones. Los comerciales (asesores, ATC,
-- jefe_linea, gerencia, community_manager, analista, viewer) no las
-- ven nunca.
--
--   * tags.is_broadcast = true → etiqueta de difusión. Solo la ven y
--     la gestionan admin/owner. La app además la oculta en toda pantalla
--     fuera de Difusiones (también al admin).
--   * El resto de reglas de 069 (personales / compartidas) no cambia.
--
-- contact_tags: no se tocan sus políticas (069 select, 078
-- insert/update/delete). Todas exigen EXISTS (SELECT 1 FROM tags ...),
-- que corre con el RLS de quien llama: si no puede ver la etiqueta de
-- difusión, tampoco puede ver, poner ni quitar esa fila. Es decir,
-- poner/quitar una etiqueta de difusión ya exige admin.
--
-- El webhook (service role) se salta el RLS: sigue etiquetando, pero
-- el código solo acepta un reply_tag_id cuyo tag sea is_broadcast.
-- Las automatizaciones no se disparan con estas etiquetas (el webhook
-- inserta directo, sin addContactTagAndDispatch).
--
-- Backfill (criterio prudente): se marca is_broadcast = true SOLO una
-- etiqueta que cumpla TODO esto:
--   1. está referenciada por algún broadcasts.reply_tag_id;
--   2. es compartida (is_shared) y NO es etiqueta de estado/tipo xlr8
--      (is_xlr8_estado_tag, 078);
--   3. se creó para esto: su created_at no es anterior en más de 1 hora
--      a la primera difusión que la usa (el asistente la crea justo
--      antes de guardar la difusión; el detalle, después);
--   4. no se usa fuera de difusiones: cada contacto que la tiene es un
--      destinatario 'replied' de una difusión con esa reply_tag_id.
-- Una etiqueta comercial que se eligió como etiqueta de respuesta NO se
-- marca (seguiría oculta a los comerciales si se marcara); esas
-- difusiones dejan de etiquetar a nuevos que respondan hasta que se
-- elija una etiqueta de difusión en su detalle. No se revisan las
-- referencias en la configuración JSON de automatizaciones/flujos: el
-- punto 3 ya descarta etiquetas preexistentes.
--
-- Idempotente: ADD COLUMN IF NOT EXISTS, DROP POLICY IF EXISTS, y el
-- backfill solo pasa filas a true.
-- ============================================================

ALTER TABLE tags
  ADD COLUMN IF NOT EXISTS is_broadcast BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_tags_account_broadcast
  ON tags(account_id)
  WHERE is_broadcast;

-- ---- Backfill -----------------------------------------------------
UPDATE tags t
SET is_broadcast = true
WHERE NOT t.is_broadcast
  AND t.is_shared
  AND NOT is_xlr8_estado_tag(t.id)
  AND EXISTS (SELECT 1 FROM broadcasts b WHERE b.reply_tag_id = t.id)
  AND t.created_at >= (
    SELECT min(b.created_at) - interval '1 hour'
    FROM broadcasts b
    WHERE b.reply_tag_id = t.id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM contact_tags ct
    WHERE ct.tag_id = t.id
      AND NOT EXISTS (
        SELECT 1
        FROM broadcast_recipients r
        JOIN broadcasts b ON b.id = r.broadcast_id
        WHERE b.reply_tag_id = t.id
          AND r.contact_id = ct.contact_id
          AND r.status = 'replied'
      )
  );

-- ---- RLS de tags (reemplaza las de 069) ---------------------------
DROP POLICY IF EXISTS tags_select ON tags;
DROP POLICY IF EXISTS tags_insert ON tags;
DROP POLICY IF EXISTS tags_update ON tags;
DROP POLICY IF EXISTS tags_delete ON tags;

CREATE POLICY tags_select ON tags FOR SELECT
  USING (
    is_account_member(account_id)
    AND (
      is_account_member(account_id, 'admin')
      OR (
        NOT is_broadcast
        AND (is_shared OR user_id = auth.uid())
      )
    )
  );

CREATE POLICY tags_insert ON tags FOR INSERT
  WITH CHECK (
    is_account_member(account_id, 'admin')
    OR (
      is_account_member(account_id, 'agent')
      AND user_id = auth.uid()
      AND NOT is_shared
      AND NOT is_broadcast
    )
  );

CREATE POLICY tags_update ON tags FOR UPDATE
  USING (
    is_account_member(account_id, 'admin')
    OR (
      is_account_member(account_id, 'agent')
      AND user_id = auth.uid()
      AND NOT is_shared
      AND NOT is_broadcast
    )
  )
  WITH CHECK (
    is_account_member(account_id, 'admin')
    OR (
      is_account_member(account_id, 'agent')
      AND user_id = auth.uid()
      AND NOT is_shared
      AND NOT is_broadcast
    )
  );

CREATE POLICY tags_delete ON tags FOR DELETE
  USING (
    is_account_member(account_id, 'admin')
    OR (
      is_account_member(account_id, 'agent')
      AND user_id = auth.uid()
      AND NOT is_shared
      AND NOT is_broadcast
    )
  );

-- PostgREST: que la API vea la columna nueva sin esperar.
NOTIFY pgrst, 'reload schema';
