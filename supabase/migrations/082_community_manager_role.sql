-- ============================================================
-- 082_community_manager_role.sql — nuevo valor 'community_manager' en
--                                    account_role_enum
--
-- Community Manager: atiende solo los chats de Facebook Messenger e
-- Instagram (nunca WhatsApp). Ve Panel, Bandeja y Contactos.
--
-- AQUÍ SOLO va el ADD VALUE: un valor nuevo de un enum no se puede usar
-- en la misma transacción que lo agrega (ver 037). 083 lo usa, así que
-- ejecuta este archivo primero y 083 después, por separado.
--
-- Idempotente.
-- ============================================================

ALTER TYPE account_role_enum ADD VALUE IF NOT EXISTS 'community_manager';
