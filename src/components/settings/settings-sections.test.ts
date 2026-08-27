import { describe, expect, it } from 'vitest';
import { isSectionVisible, visibleSections } from './settings-sections';

const OWNER_ADMIN = { canEditSettings: true, canViewTeamMembers: true };
const GERENCIA_JEFE = { canEditSettings: false, canViewTeamMembers: true };
const AGENT_ATC_VIEWER = { canEditSettings: false, canViewTeamMembers: false };

describe('isSectionVisible', () => {
  it('always shows the account group (profile, security, appearance)', () => {
    for (const perms of [OWNER_ADMIN, GERENCIA_JEFE, AGENT_ATC_VIEWER]) {
      expect(isSectionVisible('profile', perms)).toBe(true);
      expect(isSectionVisible('security', perms)).toBe(true);
      expect(isSectionVisible('appearance', perms)).toBe(true);
    }
  });

  it('shows members to canEditSettings OR canViewTeamMembers', () => {
    expect(isSectionVisible('members', OWNER_ADMIN)).toBe(true);
    expect(isSectionVisible('members', GERENCIA_JEFE)).toBe(true);
    expect(isSectionVisible('members', AGENT_ATC_VIEWER)).toBe(false);
  });

  it('gates overview and the rest of Workspace behind canEditSettings only', () => {
    const workspaceOnly = [
      'overview',
      'whatsapp',
      'templates',
      'quick-replies',
      'fields',
      'deals',
      'api',
    ] as const;
    for (const section of workspaceOnly) {
      expect(isSectionVisible(section, OWNER_ADMIN)).toBe(true);
      expect(isSectionVisible(section, GERENCIA_JEFE)).toBe(false);
      expect(isSectionVisible(section, AGENT_ATC_VIEWER)).toBe(false);
    }
  });
});

describe('visibleSections', () => {
  it('owner/admin see every section', () => {
    expect(visibleSections(OWNER_ADMIN)).toEqual([
      'overview',
      'profile',
      'security',
      'appearance',
      'whatsapp',
      'templates',
      'quick-replies',
      'fields',
      'deals',
      'members',
      'api',
    ]);
  });

  it('gerencia/jefe_linea see account + members only', () => {
    expect(visibleSections(GERENCIA_JEFE)).toEqual([
      'profile',
      'security',
      'appearance',
      'members',
    ]);
  });

  it('agent/atc/viewer see account only', () => {
    expect(visibleSections(AGENT_ATC_VIEWER)).toEqual([
      'profile',
      'security',
      'appearance',
    ]);
  });
});
