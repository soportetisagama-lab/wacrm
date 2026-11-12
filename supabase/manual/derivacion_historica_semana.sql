-- ============================================================
-- Carga histórica a la cola de derivación automática (MANUAL, no es
-- migración). Requiere la 096.
--
-- Pone en la cola las conversaciones de WhatsApp de los últimos 7 días
-- que nunca se derivaron ni se asignaron. El cron de flujos las deriva
-- dentro de horario, de la más antigua a la más reciente, con
-- `historico: true` en el JSON al PHP.
--
-- Fecha de llegada del lead: el PRIMER mensaje del cliente dentro de los
-- últimos 7 días (las conversaciones se reutilizan por contacto, así que
-- conversations.created_at puede ser mucho más antigua).
--
-- Celular válido: el mismo criterio que celularDerivacion() en
-- lib/derivacion-auto.ts (9 a 15 dígitos).
--
-- Ojo: mientras siga el MODO PRUEBA (NUMEROS_PRUEBA), la cola saca estas
-- conversaciones sin derivarlas ('no_es_prueba'). Ejecutar el UPDATE
-- solo cuando la derivación esté abierta a todos los números.
--
-- Paso 1: ejecutar solo el SELECT y revisar el total.
-- Paso 2: ejecutar el UPDATE.
-- ============================================================

-- Paso 1: cuántas entrarían, y el rango de fechas.
WITH candidatas AS (
  SELECT c.id, MIN(m.created_at) AS llegada
  FROM conversations c
  JOIN contacts ct ON ct.id = c.contact_id
  JOIN messages m ON m.conversation_id = c.id
  WHERE c.channel = 'whatsapp'
    AND c.status IN ('pending', 'open')
    AND c.assigned_agent_id IS NULL
    AND c.derivado_auto_at IS NULL
    AND c.derivacion_pendiente_at IS NULL
    AND length(regexp_replace(coalesce(ct.phone, ''), '\D', '', 'g')) BETWEEN 9 AND 15
    AND m.sender_type = 'customer'
    AND m.created_at >= now() - interval '7 days'
  GROUP BY c.id
)
SELECT count(*) AS total, min(llegada) AS mas_antigua, max(llegada) AS mas_reciente
FROM candidatas;

-- Paso 2: cargarlas a la cola.
WITH candidatas AS (
  SELECT c.id, MIN(m.created_at) AS llegada
  FROM conversations c
  JOIN contacts ct ON ct.id = c.contact_id
  JOIN messages m ON m.conversation_id = c.id
  WHERE c.channel = 'whatsapp'
    AND c.status IN ('pending', 'open')
    AND c.assigned_agent_id IS NULL
    AND c.derivado_auto_at IS NULL
    AND c.derivacion_pendiente_at IS NULL
    AND length(regexp_replace(coalesce(ct.phone, ''), '\D', '', 'g')) BETWEEN 9 AND 15
    AND m.sender_type = 'customer'
    AND m.created_at >= now() - interval '7 days'
  GROUP BY c.id
)
UPDATE conversations c
SET derivacion_pendiente_at = cand.llegada,
    derivacion_pendiente_agente = NULL,
    derivacion_historica = true
FROM candidatas cand
WHERE c.id = cand.id
  AND c.derivado_auto_at IS NULL
  AND c.derivacion_pendiente_at IS NULL;
