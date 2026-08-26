// ============================================================
// Account role helpers — pure, unit-testable, no I/O.
//
// Mirrors the `account_role_enum` Postgres type from migration
// 017_account_sharing.sql (extended in 037 with gerencia / jefe_linea
// / atc). The hierarchy is intentionally a flat ordinal (owner=7 …
// viewer=1) — it matches the same CASE expression the
// `is_account_member(account_id, min_role)` SQL helper uses, so
// server-side TypeScript guards and database-side RLS speak the same
// language.
//
// Predicates (`canManageMembers`, `canEditSettings`, …) are the
// single source of truth for "what can this role do?" — both
// API route guards and UI gates should call them rather than
// open-coding their own role checks. That keeps role-policy
// changes a one-file diff.
//
// Business role mapping (see migration 037 for the full rationale):
//   Administrador -> owner        Gerencia -> gerencia
//   Jefe de Línea -> jefe_linea   ATC      -> atc
//   Asesor        -> agent
// `admin` and `viewer` are not part of that 5-role business mapping
// but remain valid, functioning roles (admin = generic technical
// power role, not offered at invite time; viewer = unrestricted
// read-only, unchanged).
// ============================================================

export type AccountRole =
  'owner' | 'admin' | 'gerencia' | 'jefe_linea' | 'atc' | 'agent' | 'viewer';

/**
 * Ordered list of every valid role, lowest privilege first.
 *
 * gerencia / jefe_linea / atc sit BETWEEN agent and admin on purpose:
 * that placement is what lets every existing agent-gated policy
 * (contacts/deals/broadcasts/automations/flows) and every existing
 * admin-gated policy (tags/pipelines/whatsapp_config/message_templates/
 * custom_fields) keep working for the new roles with no SQL changes —
 * see the header comment on supabase/migrations/037_extend_account_roles.sql.
 *
 * jefe_linea currently has the exact same effective scope as gerencia
 * (both account-wide) — there is no teams/lines table yet to give
 * Jefe de Línea real per-team scoping. Its rank position here is a
 * placeholder for when that lands; it does not currently do anything
 * on its own (see the jefe_linea branch of can_view_conversation in
 * supabase/migrations/039_conversation_visibility_by_role.sql).
 */
export const ACCOUNT_ROLES: readonly AccountRole[] = [
  'viewer',
  'agent',
  'atc',
  'jefe_linea',
  'gerencia',
  'admin',
  'owner',
] as const;

/**
 * Numeric rank of a role. Higher = more privileged. Mirrors the
 * CASE expression in `is_account_member` so JS/SQL stay aligned.
 */
export function roleRank(role: AccountRole): number {
  switch (role) {
    case 'owner':
      return 7;
    case 'admin':
      return 6;
    case 'gerencia':
      return 5;
    case 'jefe_linea':
      return 4;
    case 'atc':
      return 3;
    case 'agent':
      return 2;
    case 'viewer':
      return 1;
  }
}

/**
 * True iff `role` is at least as privileged as `min`. Use this
 * for any "user has at least admin" / "at least agent" checks.
 */
export function hasMinRole(role: AccountRole, min: AccountRole): boolean {
  return roleRank(role) >= roleRank(min);
}

/** Type-narrow an unknown string into a valid `AccountRole`. */
export function isAccountRole(value: unknown): value is AccountRole {
  return (
    typeof value === 'string' &&
    (ACCOUNT_ROLES as readonly string[]).includes(value)
  );
}

// ============================================================
// Capability predicates
//
// Every UI gate and API route guard should call one of these
// instead of comparing role strings inline. Adding a capability
// = one new predicate here + one call site change per consumer.
// ============================================================

/** Owner / admin: invite, remove, change roles. */
export function canManageMembers(role: AccountRole): boolean {
  return hasMinRole(role, 'admin');
}

/**
 * Owner / admin: edit account-wide settings (WhatsApp config,
 * message templates, pipelines, tags, custom fields, account
 * name). Excludes per-user settings like avatar or own password.
 *
 * gerencia / jefe_linea / atc are deliberately NOT admin+ (see
 * roleRank) so this stays false for all three — they get operational
 * write access without settings access.
 */
export function canEditSettings(role: AccountRole): boolean {
  return hasMinRole(role, 'admin');
}

/**
 * Owner / admin / gerencia / jefe_linea / atc / agent: write
 * operational data — send messages, create contacts, move deals, run
 * broadcasts, edit automations. Viewers are read-only.
 */
export function canSendMessages(role: AccountRole): boolean {
  return hasMinRole(role, 'agent');
}

/**
 * Viewer: read-only across everything. Provided as a positive
 * predicate so UI gates read naturally (`if (canViewOnly(role))`
 * shows the "Read-only" tooltip without inverting `canSendMessages`).
 */
export function canViewOnly(role: AccountRole): boolean {
  return role === 'viewer';
}

/** Owner only: irreversible destructive operations. */
export function canDeleteAccount(role: AccountRole): boolean {
  return role === 'owner';
}

/** Owner only: hand the account to another member. */
export function canTransferOwnership(role: AccountRole): boolean {
  return role === 'owner';
}

/**
 * Owner / admin / gerencia / jefe_linea / atc: may assign or
 * reassign a conversation's `assigned_agent_id`. Deliberately NOT a
 * `hasMinRole` check — agent (Asesor) must keep every other
 * agent-rank capability (canSendMessages) while being excluded from
 * this one, which a single ordinal rank can't express. Keep this
 * allow-list in sync with the DB-side backstop in
 * `enforce_conversation_assignment_column()`
 * (supabase/migrations/038_conversation_assignment_permission.sql) —
 * that trigger is what actually enforces this, since the UI writes
 * `assigned_agent_id` straight from the browser with no API route in
 * front of it. This predicate only drives what the UI shows/enables.
 */
const ASSIGN_CONVERSATION_ROLES: readonly AccountRole[] = [
  'owner',
  'admin',
  'gerencia',
  'jefe_linea',
  'atc',
];

export function canAssignConversations(role: AccountRole): boolean {
  return ASSIGN_CONVERSATION_ROLES.includes(role);
}
