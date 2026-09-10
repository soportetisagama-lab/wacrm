-- ============================================================
-- 058_ai_debounce.sql — debounce de ráfagas para el asistente
-- general de auto-reply (texto únicamente; collect_ai y los demás
-- nodos de Flows no pasan por acá — ver dispatchInboundToAiReply,
-- que solo entra a este camino cuando isTextMessage=true).
--
-- Problema: dos mensajes del mismo cliente separados por segundos
-- llegan como DOS entregas de webhook independientes (procesos
-- serverless distintos, cada uno con su propio `after()`) y cada una
-- dispara su propia respuesta del modelo por separado, en vez de
-- esperar y responder a la ráfaga completa junta.
--
-- Solución: un timestamp compartido por conversación
-- (ai_debounce_until) que actúa como ventana de espera Y, luego de
-- vencer, como lock de "procesando" (ver PROCESSING_LOCK_SECONDS en
-- src/lib/ai/auto-reply.ts). `claim_ai_debounce_window` es la única
-- forma segura de leer-y-extender ese timestamp sin condición de
-- carrera: usa SELECT ... FOR UPDATE (bloqueo de fila) para que dos
-- webhooks concurrentes en la MISMA conversación se serialicen — el
-- segundo ve el valor que acaba de escribir el primero, no uno viejo.
--
-- A diferencia de claim_ai_reply_slot (029/031), acá no alcanza un
-- solo UPDATE...RETURNING: necesitamos el valor VIEJO (para decidir
-- si el caller es dueño de la ventana) y el valor NUEVO (hasta cuándo
-- esperar) en la misma operación atómica — de ahí el PL/pgSQL con
-- bloqueo explícito en vez de una sola sentencia SQL.
--
-- Recuperación: si la instancia "owner" muere a mitad de la espera y
-- nunca limpia ai_debounce_until, un sweep en /api/flows/cron
-- (sweepOrphanedDebounceWindows) recupera esas ventanas huérfanas
-- pasado un tiempo de gracia — ver DEBOUNCE_SWEEP_GRACE_SECONDS. Esa
-- parte no necesita SQL propio: reutiliza un UPDATE...RETURNING
-- simple vía supabase-js, sin necesidad de otra función.
--
-- GRANT EXECUTE explícito incluido en ESTA misma migración — ver el
-- error documentado en 031 (claim_ai_reply_slot quedó sin grant y el
-- bot nunca contestaba, issue #345). No se repite acá.
--
-- Idempotente — segura de correr más de una vez.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_debounce_until timestamptz;

-- La única consulta que escanea por este campo es el cron sweep
-- (WHERE ai_debounce_until IS NOT NULL AND ai_debounce_until < cutoff).
-- Parcial: la inmensa mayoría de las filas tiene esto en NULL en todo
-- momento (fuera de una ráfaga activa), así que el índice se mantiene
-- chico.
CREATE INDEX IF NOT EXISTS idx_conversations_ai_debounce_until
  ON conversations(ai_debounce_until)
  WHERE ai_debounce_until IS NOT NULL;

CREATE OR REPLACE FUNCTION public.claim_ai_debounce_window(
  p_conversation_id uuid,
  p_window_seconds integer
)
RETURNS TABLE(is_owner boolean, wait_until timestamptz) AS $$
DECLARE
  v_prior timestamptz;
  v_new timestamptz;
BEGIN
  -- Bloqueo de fila: si dos inbounds para la MISMA conversación llegan
  -- casi al mismo tiempo, el segundo espera acá hasta que el primero
  -- confirme su transacción, y entonces lee el valor YA actualizado
  -- por el primero — así nunca hay dos "owners" para la misma ráfaga.
  SELECT c.ai_debounce_until INTO v_prior
  FROM conversations c
  WHERE c.id = p_conversation_id
  FOR UPDATE;

  v_new := GREATEST(COALESCE(v_prior, now()), now())
           + make_interval(secs => p_window_seconds);

  UPDATE conversations
  SET ai_debounce_until = v_new
  WHERE id = p_conversation_id;

  RETURN QUERY SELECT
    (v_prior IS NULL OR v_prior <= now()),
    v_new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Solo el service role (webhook, sin auth.uid()) llama esto.
GRANT EXECUTE ON FUNCTION public.claim_ai_debounce_window(uuid, integer) TO service_role;
