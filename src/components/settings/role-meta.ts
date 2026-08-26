import {
  Briefcase,
  Crown,
  Headphones,
  Shield,
  UserCog,
  UserIcon,
  UsersRound,
  type LucideIcon,
} from 'lucide-react';

import type { AccountRole } from '@/lib/auth/roles';
import type { ChipVariant } from './settings-chip';

/**
 * Single source of truth for per-role chip metadata across settings
 * surfaces (the Overview identity chip and the Members roster/invite
 * chips). Previously duplicated in both files; hoisted here so a label,
 * icon, or colour change lands once.
 *
 * `variant` drives the token-based <SettingsChip>; `className` is the
 * inline Tailwind string the Members tab applies to its own spans.
 *
 * The actual display TEXT comes from `useTranslations("Settings.roles")`
 * at each call site, not from this file — `label` here is a plain
 * English fallback/dev-facing name, kept for parity with the original
 * shape. See messages/en.json + messages/ko.json for the real strings
 * (Asesor / ATC / Jefe de Línea / Gerencia).
 */
export const ROLE_META: Record<
  AccountRole,
  { icon: LucideIcon; label: string; variant: ChipVariant; className: string }
> = {
  owner: {
    icon: Crown,
    label: 'owner',
    variant: 'owner',
    className: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  },
  admin: {
    icon: Shield,
    label: 'admin',
    variant: 'admin',
    className: 'border-primary/40 bg-primary/10 text-primary',
  },
  gerencia: {
    icon: Briefcase,
    label: 'gerencia',
    variant: 'gerencia',
    className: 'border-indigo-500/40 bg-indigo-500/10 text-indigo-300',
  },
  jefe_linea: {
    icon: UsersRound,
    label: 'jefe_linea',
    variant: 'jefe_linea',
    className: 'border-teal-500/40 bg-teal-500/10 text-teal-300',
  },
  atc: {
    icon: Headphones,
    label: 'atc',
    variant: 'atc',
    className: 'border-orange-500/40 bg-orange-500/10 text-orange-300',
  },
  agent: {
    icon: UserCog,
    label: 'agent',
    variant: 'muted',
    className: 'border-border bg-muted text-muted-foreground',
  },
  viewer: {
    icon: UserIcon,
    label: 'viewer',
    variant: 'muted',
    // Outline-only so it stays quieter than the filled Agent chip in
    // both modes — bg-card would blend into a card surface in light mode.
    className: 'border-border bg-transparent text-muted-foreground',
  },
};
