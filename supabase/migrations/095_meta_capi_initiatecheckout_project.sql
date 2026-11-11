-- ============================================================
-- Un solo InitiateCheckout por proyecto de XLR8 en toda la cuenta.
--
-- Igual que uq_meta_capi_events_purchase_project (migración 093) para
-- Purchase: si dos contactos tienen el mismo celular, la misma cotización
-- de XLR8 no se reporta dos veces a Meta. El servidor ya trata el error
-- 23505 de este índice como "ya registrado".
--
-- Antes de ejecutar, comprueba que no haya duplicados (si los hay, el
-- CREATE falla y no se crea nada). Esta migración no borra datos.
--
-- Idempotente: se puede ejecutar varias veces.
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS uq_meta_capi_events_checkout_project
  ON meta_capi_events(account_id, project_id)
  WHERE event_name = 'InitiateCheckout' AND project_id IS NOT NULL;

-- PostgREST: que la API vea el cambio sin esperar.
NOTIFY pgrst, 'reload schema';
