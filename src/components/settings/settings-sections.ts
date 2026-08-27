import {
  Coins,
  FileText,
  KeyRound,
  LayoutGrid,
  Palette,
  PlugZap,
  Shield,
  Tags,
  User,
  UsersRound,
  Zap,
  type LucideIcon,
} from 'lucide-react';

/**
 * Settings information architecture for the redesigned page.
 *
 * The flat tab strip became a grouped left rail with a new Overview
 * landing. The URL query param stays `?tab=` (deep-linkable, and it
 * keeps the existing links in sidebar.tsx / header.tsx working) — we
 * just map the old values onto the new sections.
 */
export const SETTINGS_SECTIONS = [
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
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export const DEFAULT_SECTION: SettingsSection = 'overview';

/** Rail grouping. See `isSectionVisible` below for role-based hiding. */
export interface SectionMeta {
  id: SettingsSection;
  label: string;
  icon: LucideIcon;
  group: 'top' | 'account' | 'workspace';
}

export const SECTION_META: Record<SettingsSection, SectionMeta> = {
  overview: { id: 'overview', label: 'Overview', icon: LayoutGrid, group: 'top' },
  profile: { id: 'profile', label: 'Your profile', icon: User, group: 'account' },
  security: { id: 'security', label: 'Login & security', icon: Shield, group: 'account' },
  appearance: { id: 'appearance', label: 'Appearance', icon: Palette, group: 'account' },
  whatsapp: { id: 'whatsapp', label: 'WhatsApp', icon: PlugZap, group: 'workspace' },
  templates: { id: 'templates', label: 'Templates', icon: FileText, group: 'workspace' },
  'quick-replies': { id: 'quick-replies', label: 'Quick replies', icon: Zap, group: 'workspace' },
  fields: { id: 'fields', label: 'Fields & tags', icon: Tags, group: 'workspace' },
  deals: { id: 'deals', label: 'Deals & currency', icon: Coins, group: 'workspace' },
  members: { id: 'members', label: 'Team members', icon: UsersRound, group: 'workspace' },
  api: { id: 'api', label: 'API keys', icon: KeyRound, group: 'workspace' },
};

export const RAIL_GROUPS: { label: string | null; group: SectionMeta['group'] }[] = [
  { label: null, group: 'top' },
  { label: 'Account', group: 'account' },
  { label: 'Workspace', group: 'workspace' },
];

/**
 * Role-based visibility for a settings section. Pure and testable —
 * callers get the two booleans from `useCan('edit-settings')` /
 * `useCan('view-team-members')` and pass them in, rather than this
 * module reaching for React context itself.
 *
 *  - `profile` / `security` / `appearance` (group 'account'): every
 *    signed-in role sees these — they're per-user, not account-wide.
 *  - `members`: visible to `canEditSettings` (owner/admin) OR
 *    `canViewTeamMembers` (+gerencia/jefe_linea) — the one Workspace
 *    item Gerencia/Jefe de Línea get without full settings access.
 *  - Everything else (`overview` + the rest of Workspace — whatsapp,
 *    templates, quick-replies, fields, deals, api): `canEditSettings`
 *    only. Overview is a hub of links into those same sections, so it
 *    rides the same gate rather than getting its own.
 */
export function isSectionVisible(
  section: SettingsSection,
  perms: { canEditSettings: boolean; canViewTeamMembers: boolean },
): boolean {
  if (section === 'members') {
    return perms.canEditSettings || perms.canViewTeamMembers;
  }
  if (SECTION_META[section].group === 'account') return true;
  return perms.canEditSettings;
}

/** `SETTINGS_SECTIONS`, filtered to what this role may see, in order. */
export function visibleSections(perms: {
  canEditSettings: boolean;
  canViewTeamMembers: boolean;
}): SettingsSection[] {
  return SETTINGS_SECTIONS.filter((s) => isSectionVisible(s, perms));
}

function isSection(value: string | null): value is SettingsSection {
  return !!value && (SETTINGS_SECTIONS as readonly string[]).includes(value);
}

/**
 * Resolve a raw `?tab=` value to a section. Legacy tabs from the old
 * flat layout collapse onto their new home (Tags + Custom fields → the
 * merged "Fields & tags" section). Anything unknown falls back to the
 * Overview landing.
 */
export function resolveSection(raw: string | null): SettingsSection {
  if (raw === 'tags' || raw === 'custom-fields') return 'fields';
  if (isSection(raw)) return raw;
  return DEFAULT_SECTION;
}
