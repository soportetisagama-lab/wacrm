import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_ROLES,
  type AccountRole,
  canAssignConversations,
  canDeleteAccount,
  canEditSettings,
  canManageMembers,
  canSendMessages,
  canTransferOwnership,
  canViewOnly,
  hasMinRole,
  isAccountRole,
  roleRank,
} from './roles';

describe('roleRank', () => {
  it('orders owner > admin > gerencia > jefe_linea > atc > agent > viewer', () => {
    expect(roleRank('owner')).toBeGreaterThan(roleRank('admin'));
    expect(roleRank('admin')).toBeGreaterThan(roleRank('gerencia'));
    expect(roleRank('gerencia')).toBeGreaterThan(roleRank('jefe_linea'));
    expect(roleRank('jefe_linea')).toBeGreaterThan(roleRank('atc'));
    expect(roleRank('atc')).toBeGreaterThan(roleRank('agent'));
    expect(roleRank('agent')).toBeGreaterThan(roleRank('viewer'));
  });

  it("matches the SQL helper's numeric mapping", () => {
    // Keep these in lockstep with `is_account_member`'s CASE expression
    // in supabase/migrations/017_account_sharing.sql (extended by 037) —
    // any change here means the SQL helper needs the same change.
    expect(roleRank('owner')).toBe(7);
    expect(roleRank('admin')).toBe(6);
    expect(roleRank('gerencia')).toBe(5);
    expect(roleRank('jefe_linea')).toBe(4);
    expect(roleRank('atc')).toBe(3);
    expect(roleRank('agent')).toBe(2);
    expect(roleRank('viewer')).toBe(1);
  });

  it('places the new roles between agent and admin, inclusive of neither boundary', () => {
    // This is the placement that lets every existing agent-gated and
    // admin-gated RLS policy keep working for the new roles with zero
    // SQL changes — see roles.ts's ACCOUNT_ROLES comment.
    for (const role of ['atc', 'jefe_linea', 'gerencia'] as const) {
      expect(roleRank(role)).toBeGreaterThan(roleRank('agent'));
      expect(roleRank(role)).toBeLessThan(roleRank('admin'));
    }
  });
});

describe('hasMinRole', () => {
  it('returns true when role meets the threshold', () => {
    expect(hasMinRole('owner', 'viewer')).toBe(true);
    expect(hasMinRole('admin', 'agent')).toBe(true);
    expect(hasMinRole('agent', 'agent')).toBe(true);
    expect(hasMinRole('gerencia', 'agent')).toBe(true);
  });

  it('returns false when role is below the threshold', () => {
    expect(hasMinRole('viewer', 'agent')).toBe(false);
    expect(hasMinRole('agent', 'admin')).toBe(false);
    expect(hasMinRole('admin', 'owner')).toBe(false);
    expect(hasMinRole('atc', 'admin')).toBe(false);
  });

  // The full matrix — useful as a regression net if anyone reshuffles
  // the rank table.
  it.each<[AccountRole, AccountRole, boolean]>([
    ['owner', 'owner', true],
    ['owner', 'admin', true],
    ['owner', 'gerencia', true],
    ['owner', 'jefe_linea', true],
    ['owner', 'atc', true],
    ['owner', 'agent', true],
    ['owner', 'viewer', true],
    ['admin', 'owner', false],
    ['admin', 'admin', true],
    ['admin', 'gerencia', true],
    ['admin', 'agent', true],
    ['admin', 'viewer', true],
    ['gerencia', 'admin', false],
    ['gerencia', 'gerencia', true],
    ['gerencia', 'jefe_linea', true],
    ['gerencia', 'agent', true],
    ['jefe_linea', 'gerencia', false],
    ['jefe_linea', 'jefe_linea', true],
    ['jefe_linea', 'atc', true],
    ['jefe_linea', 'agent', true],
    ['atc', 'jefe_linea', false],
    ['atc', 'atc', true],
    ['atc', 'agent', true],
    ['atc', 'viewer', true],
    ['agent', 'atc', false],
    ['agent', 'owner', false],
    ['agent', 'admin', false],
    ['agent', 'agent', true],
    ['agent', 'viewer', true],
    ['viewer', 'agent', false],
    ['viewer', 'owner', false],
    ['viewer', 'admin', false],
    ['viewer', 'viewer', true],
  ])('%s vs min %s → %s', (role, min, expected) => {
    expect(hasMinRole(role, min)).toBe(expected);
  });
});

describe('isAccountRole', () => {
  it('accepts every value in ACCOUNT_ROLES', () => {
    for (const role of ACCOUNT_ROLES) {
      expect(isAccountRole(role)).toBe(true);
    }
  });

  it('rejects garbage / case mismatch / non-strings', () => {
    expect(isAccountRole('Owner')).toBe(false);
    expect(isAccountRole('')).toBe(false);
    expect(isAccountRole(null)).toBe(false);
    expect(isAccountRole(undefined)).toBe(false);
    expect(isAccountRole(123)).toBe(false);
    expect(isAccountRole('superuser')).toBe(false);
    expect(isAccountRole('Gerencia')).toBe(false);
  });
});

describe('capability predicates', () => {
  it('canManageMembers: admin+ only — new roles excluded', () => {
    expect(canManageMembers('owner')).toBe(true);
    expect(canManageMembers('admin')).toBe(true);
    expect(canManageMembers('gerencia')).toBe(false);
    expect(canManageMembers('jefe_linea')).toBe(false);
    expect(canManageMembers('atc')).toBe(false);
    expect(canManageMembers('agent')).toBe(false);
    expect(canManageMembers('viewer')).toBe(false);
  });

  it('canEditSettings: admin+ only — new roles excluded', () => {
    expect(canEditSettings('owner')).toBe(true);
    expect(canEditSettings('admin')).toBe(true);
    expect(canEditSettings('gerencia')).toBe(false);
    expect(canEditSettings('jefe_linea')).toBe(false);
    expect(canEditSettings('atc')).toBe(false);
    expect(canEditSettings('agent')).toBe(false);
    expect(canEditSettings('viewer')).toBe(false);
  });

  it('canSendMessages: agent+ only — new roles included', () => {
    expect(canSendMessages('owner')).toBe(true);
    expect(canSendMessages('admin')).toBe(true);
    expect(canSendMessages('gerencia')).toBe(true);
    expect(canSendMessages('jefe_linea')).toBe(true);
    expect(canSendMessages('atc')).toBe(true);
    expect(canSendMessages('agent')).toBe(true);
    expect(canSendMessages('viewer')).toBe(false);
  });

  it('canViewOnly: viewer only', () => {
    expect(canViewOnly('owner')).toBe(false);
    expect(canViewOnly('admin')).toBe(false);
    expect(canViewOnly('gerencia')).toBe(false);
    expect(canViewOnly('jefe_linea')).toBe(false);
    expect(canViewOnly('atc')).toBe(false);
    expect(canViewOnly('agent')).toBe(false);
    expect(canViewOnly('viewer')).toBe(true);
  });

  it('canDeleteAccount: owner only', () => {
    expect(canDeleteAccount('owner')).toBe(true);
    expect(canDeleteAccount('admin')).toBe(false);
    expect(canDeleteAccount('gerencia')).toBe(false);
    expect(canDeleteAccount('agent')).toBe(false);
    expect(canDeleteAccount('viewer')).toBe(false);
  });

  it('canTransferOwnership: owner only', () => {
    expect(canTransferOwnership('owner')).toBe(true);
    expect(canTransferOwnership('admin')).toBe(false);
    expect(canTransferOwnership('gerencia')).toBe(false);
    expect(canTransferOwnership('agent')).toBe(false);
    expect(canTransferOwnership('viewer')).toBe(false);
  });

  it('canAssignConversations: owner/admin/gerencia/jefe_linea/atc only — agent and viewer excluded', () => {
    expect(canAssignConversations('owner')).toBe(true);
    expect(canAssignConversations('admin')).toBe(true);
    expect(canAssignConversations('gerencia')).toBe(true);
    expect(canAssignConversations('jefe_linea')).toBe(true);
    expect(canAssignConversations('atc')).toBe(true);
    expect(canAssignConversations('agent')).toBe(false);
    expect(canAssignConversations('viewer')).toBe(false);
  });
});
