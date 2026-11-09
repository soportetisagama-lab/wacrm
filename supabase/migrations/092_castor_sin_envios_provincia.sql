-- ============================================================
-- 092 — Castor: no hacemos envíos a provincia.
--
-- Solo para el Supabase de Castor (jhteldaqzksxbqlwtewx).
-- El código ya añade la regla a todos los prompts del bot
-- (NO_PROVINCE_SHIPPING_GUIDANCE en src/lib/ai/defaults.ts), por encima
-- de cualquier texto de la base. Esto limpia los datos para que no se
-- contradigan.
-- ============================================================

-- 1) Regla en el contexto del negocio de la IA (idempotente).
UPDATE ai_configs
SET system_prompt = concat_ws(
      E'\n\n',
      nullif(trim(system_prompt), ''),
      'Envíos: no hacemos envíos a provincia (fuera de Lima) ni despachamos por agencias (Shalom, Olva u otras). Si el cliente está en provincia, indícale con amabilidad que no realizamos envíos a provincia.'
    )
WHERE coalesce(system_prompt, '') NOT ILIKE '%no hacemos envíos a provincia%';

-- 2) Archivar lo que la IA aprendió sola y que ofrece envíos a provincia
--    o por agencia (los manuales no se tocan: ver consulta 3).
UPDATE ai_knowledge_documents
SET status = 'archived'
WHERE source IN ('self_review', 'advisor_learning')
  AND status IN ('active', 'candidate')
  AND content ~* '(provincia|todo el per[uú]|nivel nacional|shalom|olva|marvisur|agencia)'
  AND content !~* '\mno\M[^.]{0,40}(envi|despach|provincia)';

-- 3) Revisión manual (solo lectura): textos que aún mencionan envíos.
--    Corrige a mano lo que ofrezca envíos a provincia (Base de
--    conocimiento, respuestas rápidas o nodos de los menús).
SELECT 'ai_knowledge_documents' AS tabla, id::text, title AS titulo, left(content, 300) AS texto
FROM ai_knowledge_documents
WHERE status = 'active'
  AND content ~* '(provincia|todo el per[uú]|nivel nacional|shalom|olva|marvisur|agencia|env[ií]o)'
UNION ALL
SELECT 'quick_replies', id::text, title, left(coalesce(content_text, interactive_payload::text), 300)
FROM quick_replies
WHERE coalesce(content_text, interactive_payload::text) ~* '(provincia|todo el per[uú]|nivel nacional|shalom|olva|marvisur|agencia|env[ií]o)'
UNION ALL
SELECT 'flow_nodes', id::text, node_key, left(config::text, 300)
FROM flow_nodes
WHERE config::text ~* '(provincia|todo el per[uú]|nivel nacional|shalom|olva|marvisur|agencia|env[ií]o)';
