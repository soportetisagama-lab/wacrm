-- ============================================================
-- 074_analista_role.sql — new account_role_enum value 'analista'
--
-- Analista: read-only role whose job is the "Mensajes" report (how many
-- messages each Asesor sends, to estimate Meta's per-message cost). The
-- sidebar shows them only Panel + Mensajes.
--
-- ONLY the ADD VALUE lives here: a new enum label can't be referenced
-- in the same transaction that adds it (see 037). 075 uses it.
--
-- Idempotent.
-- ============================================================

ALTER TYPE account_role_enum ADD VALUE IF NOT EXISTS 'analista';
