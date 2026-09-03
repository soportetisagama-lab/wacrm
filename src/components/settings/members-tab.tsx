'use client';

// ============================================================
// MembersTab — Settings → Members
//
// Two stacked sections:
//   1. Roster   — every member of the account. Admin+ can change a
//                 teammate's role inline and remove them. Owner row
//                 is non-editable everywhere (transfer is its own
//                 separate flow, deferred to a later PR).
//   2. Pending  — outstanding invite links. Admin+ can revoke. The
//                 plaintext URL is gone after the create dialog
//                 closes, so we surface a "revoke + new link" hint
//                 rather than pretending we can resurface it.
//
// Role-gating
//   The tab itself is reachable by any member, but mutation buttons
//   are wrapped in `<RequireRole min="admin">` / `useCan` so an
//   agent or viewer sees the roster read-only. The server-side
//   RPCs (set_member_role, remove_account_member) double-check
//   the role anyway.
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle,
  Check,
  KeyRound,
  Loader2,
  Mail,
  MailX,
  Pencil,
  Plus,
  Search,
  Trash2,
  UsersRound,
  X,
} from 'lucide-react';

import {
  Avatar,
  AvatarBadge,
  AvatarFallback,
  AvatarImage,
} from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useTranslations } from 'next-intl';
import { RequireRole } from '@/components/auth/require-role';
import { useAuth } from '@/hooks/use-auth';
import { usePresence } from '@/hooks/use-presence';
import type { AccountRole } from '@/lib/auth/roles';
import { presenceLabel, summarize } from '@/lib/presence';
import {
  PRESENCE_DOT_CLASS,
  PresenceDot,
} from '@/components/presence/presence-dot';
import { InviteMemberDialog } from './invite-member-dialog';
import { SettingsPanelHead } from './settings-panel-head';
import { ROLE_META } from './role-meta';

interface Member {
  user_id: string;
  full_name: string;
  email: string | null;
  avatar_url: string | null;
  role: AccountRole;
  status: 'active' | 'inactive';
  joined_at: string;
}

// Accent/case-insensitive normalize so "linea" matches "Línea" and
// "GERENCIA" matches "gerencia" — live search shouldn't punish accents.
function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

interface Invitation {
  id: string;
  // Any non-owner role: invites created before the invite dialog was
  // narrowed to the 4 business roles may still be 'admin' or 'viewer'
  // pending invites, and those still need to render correctly here.
  role: Exclude<AccountRole, 'owner'>;
  label: string | null;
  created_at: string;
  expires_at: string;
}

// These roles are translated via `useTranslations("Settings.roles")` where they are used.
// 'admin' is intentionally NOT offered here (or in the invite
// dialog) — it stays a valid, functioning role (see
// src/lib/auth/roles.ts) but isn't surfaced in either role picker.
// Promoting someone to it, if ever needed, is a direct DB/API action,
// not a UI-driven one. 'viewer' IS still offered here (unlike the
// invite dialog) since existing viewers need a way to be moved to a
// different role.
const EDITABLE_ROLES: { value: AccountRole }[] = [
  { value: 'gerencia' },
  { value: 'jefe_linea' },
  { value: 'atc' },
  { value: 'agent' },
  { value: 'viewer' },
];

// Per-role chip metadata (icon / label / colour) lives in the shared
// ROLE_META module so this roster and the Overview identity chip can't
// drift. The colour scale runs amber (owner — scarce, immutable) →
// primary (admin) → muted (agent / viewer).

function fmtDate(iso: string): string {
  // Match the rest of the dashboard's locale-light formatting.
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function fmtExpiresIn(
  iso: string,
  t: (key: string, values?: Record<string, string | number>) => string
): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return t('expired');
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (days >= 1) return t('expiresInDays', { days });
  const hours = Math.max(1, Math.floor(ms / (60 * 60 * 1000)));
  return t('expiresInHours', { hours });
}

export function MembersTab() {
  const t = useTranslations('Settings.members');
  const tRoles = useTranslations('Settings.roles');
  const tCommon = useTranslations('Common');
  const { user, canManageMembers } = useAuth();
  const { getPresence, getRow, now } = usePresence();

  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(true);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [removingMember, setRemovingMember] = useState<Member | null>(null);
  const [pendingMemberAction, setPendingMemberAction] = useState<string | null>(
    null
  );

  // Live search — filters the already-loaded roster in the client.
  // No network call per keystroke: the full member list is a single
  // fetch on mount (loadEverything below) and a single account's team
  // is small enough (tens, not thousands) that filtering it in memory
  // on every render is effectively free. If that assumption changes
  // (accounts routinely running into the hundreds+), swap this for a
  // server-side search with a debounce instead.
  const [search, setSearch] = useState('');

  // Inline name editing — one row editable at a time.
  const [editingNameId, setEditingNameId] = useState<string | null>(null);
  const [editingNameValue, setEditingNameValue] = useState('');

  // Admin-set-password dialog.
  const [passwordMember, setPasswordMember] = useState<Member | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSaving, setPasswordSaving] = useState(false);

  const filteredMembers = useMemo(() => {
    const query = normalize(search);
    if (!query) return members;
    return members.filter((m) => {
      const haystack = normalize(
        `${m.full_name} ${tRoles(m.role)} ${m.role}`
      );
      return haystack.includes(query);
    });
  }, [members, search, tRoles]);

  const loadEverything = useCallback(async () => {
    try {
      const [mres, ires] = await Promise.all([
        fetch('/api/account/members', { cache: 'no-store' }),
        canManageMembers
          ? fetch('/api/account/invitations', { cache: 'no-store' })
          : Promise.resolve(null),
      ]);

      if (!mres.ok) {
        const payload = await mres.json().catch(() => ({}));
        toast.error(payload.error || t('loadFailed'));
        return;
      }
      const mdata = (await mres.json()) as { members: Member[] };
      setMembers(mdata.members);

      if (ires) {
        if (!ires.ok) {
          const payload = await ires.json().catch(() => ({}));
          toast.error(payload.error || t('loadInvitationsFailed'));
          return;
        }
        const idata = (await ires.json()) as { invitations: Invitation[] };
        setInvitations(idata.invitations);
      } else {
        setInvitations([]);
      }
    } catch (err) {
      console.error('[MembersTab] load error:', err);
      toast.error(tCommon('serverUnreachable'));
    } finally {
      setLoading(false);
    }
  }, [canManageMembers, t, tCommon]);

  useEffect(() => {
    void loadEverything();
  }, [loadEverything]);

  async function handleRoleChange(member: Member, nextRole: AccountRole) {
    if (member.role === nextRole) return;
    // Optimistic update — flip the dropdown immediately so the UI
    // feels snappy. If the server PATCH fails we revert below so
    // the dropdown doesn't lie about the persisted state.
    const previousRole = member.role;
    setPendingMemberAction(member.user_id);
    setMembers((prev) =>
      prev.map((m) =>
        m.user_id === member.user_id ? { ...m, role: nextRole } : m
      )
    );
    try {
      const res = await fetch(`/api/account/members/${member.user_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: nextRole }),
      });
      if (!res.ok) {
        // Revert the optimistic flip. The toast on its own wasn't
        // enough — the dropdown was left showing the new role
        // forever, so the next interaction operated on a wrong
        // baseline (re-trying the same change would no-op via the
        // `member.role === nextRole` guard at the top).
        setMembers((prev) =>
          prev.map((m) =>
            m.user_id === member.user_id ? { ...m, role: previousRole } : m
          )
        );
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('roleUpdateFailed'));
        return;
      }
      toast.success(
        t('updatedToast', {
          name: member.full_name || t('unnamed'),
          role: tRoles(nextRole),
        })
      );
    } catch (err) {
      // Same revert on network failure.
      setMembers((prev) =>
        prev.map((m) =>
          m.user_id === member.user_id ? { ...m, role: previousRole } : m
        )
      );
      console.error('[MembersTab] role change error:', err);
      toast.error(tCommon('serverUnreachable'));
    } finally {
      setPendingMemberAction(null);
    }
  }

  function startEditingName(member: Member) {
    setEditingNameId(member.user_id);
    setEditingNameValue(member.full_name);
  }

  async function handleNameSave(member: Member) {
    const nextName = editingNameValue.trim();
    if (!nextName || nextName === member.full_name) {
      setEditingNameId(null);
      return;
    }
    const previousName = member.full_name;
    setPendingMemberAction(member.user_id);
    setMembers((prev) =>
      prev.map((m) =>
        m.user_id === member.user_id ? { ...m, full_name: nextName } : m
      )
    );
    try {
      const res = await fetch(`/api/account/members/${member.user_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ full_name: nextName }),
      });
      if (!res.ok) {
        setMembers((prev) =>
          prev.map((m) =>
            m.user_id === member.user_id ? { ...m, full_name: previousName } : m
          )
        );
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('nameUpdateFailed'));
        return;
      }
      toast.success(t('nameUpdatedToast', { name: nextName }));
      setEditingNameId(null);
    } catch (err) {
      setMembers((prev) =>
        prev.map((m) =>
          m.user_id === member.user_id ? { ...m, full_name: previousName } : m
        )
      );
      console.error('[MembersTab] name change error:', err);
      toast.error(tCommon('serverUnreachable'));
    } finally {
      setPendingMemberAction(null);
    }
  }

  async function handleStatusChange(member: Member, nextStatus: 'active' | 'inactive') {
    if (member.status === nextStatus) return;
    const previousStatus = member.status;
    setPendingMemberAction(member.user_id);
    setMembers((prev) =>
      prev.map((m) =>
        m.user_id === member.user_id ? { ...m, status: nextStatus } : m
      )
    );
    try {
      const res = await fetch(`/api/account/members/${member.user_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus }),
      });
      if (!res.ok) {
        setMembers((prev) =>
          prev.map((m) =>
            m.user_id === member.user_id ? { ...m, status: previousStatus } : m
          )
        );
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('statusUpdateFailed'));
        return;
      }
      toast.success(
        t(nextStatus === 'active' ? 'activatedToast' : 'deactivatedToast', {
          name: member.full_name || t('unnamed'),
        })
      );
    } catch (err) {
      setMembers((prev) =>
        prev.map((m) =>
          m.user_id === member.user_id ? { ...m, status: previousStatus } : m
        )
      );
      console.error('[MembersTab] status change error:', err);
      toast.error(tCommon('serverUnreachable'));
    } finally {
      setPendingMemberAction(null);
    }
  }

  function closePasswordDialog() {
    setPasswordMember(null);
    setNewPassword('');
    setConfirmPassword('');
    setPasswordError(null);
  }

  async function handlePasswordSave() {
    if (!passwordMember) return;
    if (newPassword.length < 8) {
      setPasswordError(t('passwordTooShort', { min: 8 }));
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError(t('passwordMismatch'));
      return;
    }
    setPasswordError(null);
    setPasswordSaving(true);
    try {
      const res = await fetch(
        `/api/account/members/${passwordMember.user_id}/password`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: newPassword }),
        }
      );
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        setPasswordError(payload.error || t('passwordUpdateFailed'));
        return;
      }
      toast.success(
        t('passwordUpdatedToast', {
          name: passwordMember.full_name || t('unnamed'),
        })
      );
      closePasswordDialog();
    } catch (err) {
      console.error('[MembersTab] password change error:', err);
      setPasswordError(tCommon('serverUnreachable'));
    } finally {
      setPasswordSaving(false);
    }
  }

  async function handleRemove() {
    if (!removingMember) return;
    setPendingMemberAction(removingMember.user_id);
    try {
      const res = await fetch(
        `/api/account/members/${removingMember.user_id}`,
        { method: 'DELETE' }
      );
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('removeFailed'));
        return;
      }
      toast.success(
        t('removedToast', { name: removingMember.full_name || t('unnamed') })
      );
      setMembers((prev) =>
        prev.filter((m) => m.user_id !== removingMember.user_id)
      );
      setRemovingMember(null);
    } catch (err) {
      console.error('[MembersTab] remove error:', err);
      toast.error(tCommon('serverUnreachable'));
    } finally {
      setPendingMemberAction(null);
    }
  }

  async function handleRevoke(invite: Invitation) {
    try {
      const res = await fetch(`/api/account/invitations/${invite.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('revokeFailed'));
        return;
      }
      toast.success(t('revokedToast'));
      setInvitations((prev) => prev.filter((i) => i.id !== invite.id));
    } catch (err) {
      console.error('[MembersTab] revoke error:', err);
      toast.error(tCommon('serverUnreachable'));
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="text-primary size-6 animate-spin" />
      </div>
    );
  }

  return (
    <section className="animate-in fade-in-50 space-y-6 duration-200">
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
        action={
          <RequireRole min="admin">
            <Button onClick={() => setInviteOpen(true)}>
              <Plus className="size-4" />
              {t('inviteMember')}
            </Button>
          </RequireRole>
        }
      />

      {/* Live presence summary across the roster. Updates without a
          full refresh as heartbeats and the local re-derive tick land. */}
      {members.length > 0 &&
        (() => {
          const counts = summarize(members.map((m) => getPresence(m.user_id)));
          return (
            <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
              <span className="inline-flex items-center gap-1.5">
                <PresenceDot status="online" />
                {counts.online} {t('online')}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <PresenceDot status="away" />
                {counts.away} {t('away')}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <PresenceDot status="offline" />
                {counts.offline} {t('offline')}
              </span>
              <span className="text-muted-foreground/70">
                · {t('memberCount', { count: members.length })}
              </span>
            </div>
          );
        })()}

      {/* Live search — filters the roster already in memory, no
          "Search" button and no page reload. Matches on name, the
          translated role label, and the raw role key so typing
          "asesor" surfaces every agent-role member. */}
      {members.length > 0 && (
        <div className="relative max-w-sm">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('searchPlaceholder')}
            aria-label={t('searchPlaceholder')}
            className="pl-8"
          />
        </div>
      )}

      {/* Roster */}
      <Card>
        <CardContent className="p-0">
          {filteredMembers.length === 0 && members.length > 0 ? (
            <p className="text-muted-foreground px-4 py-8 text-center text-sm">
              {t('noResults')}
            </p>
          ) : (
          <ul className="divide-border divide-y">
            {filteredMembers.map((member) => {
              const roleMeta = ROLE_META[member.role];
              const RoleIcon = roleMeta.icon;
              const isSelf = member.user_id === user?.id;
              const isOwnerRow = member.role === 'owner';
              const isBusy = pendingMemberAction === member.user_id;
              const presence = getPresence(member.user_id);
              const presenceRow = getRow(member.user_id);
              const presenceText = presenceLabel(
                presence,
                presenceRow?.last_seen_at ?? null,
                now
              );

              return (
                <li
                  key={member.user_id}
                  // Mobile: stack identity (avatar+name+email) above the
                  // role/remove actions so the role dropdown's fixed
                  // 128px width doesn't force the name into a 50-pixel
                  // truncation. Desktop (sm+): everything inline as
                  // before.
                  className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:gap-4"
                >
                  <div className="flex min-w-0 flex-1 items-center gap-4">
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Avatar className="size-9 shrink-0">
                            {member.avatar_url ? (
                              <AvatarImage
                                src={member.avatar_url}
                                alt={member.full_name || t('unnamed')}
                              />
                            ) : null}
                            <AvatarFallback className="bg-primary/10 text-primary text-sm font-medium">
                              {(member.full_name || member.email || 'U')
                                .charAt(0)
                                .toUpperCase()}
                            </AvatarFallback>
                            {/* role+label so screen readers announce
                                presence — the hover tooltip alone isn't
                                reachable by keyboard/AT on a non-focusable
                                avatar. */}
                            <AvatarBadge
                              role="img"
                              aria-label={presenceText}
                              className={PRESENCE_DOT_CLASS[presence]}
                            />
                          </Avatar>
                        }
                      />
                      <TooltipContent>{presenceText}</TooltipContent>
                    </Tooltip>

                    <div className="min-w-0 flex-1">
                      {editingNameId === member.user_id ? (
                        <div className="flex items-center gap-1.5">
                          <Input
                            autoFocus
                            value={editingNameValue}
                            onChange={(e) => setEditingNameValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') void handleNameSave(member);
                              if (e.key === 'Escape') setEditingNameId(null);
                            }}
                            disabled={isBusy}
                            className="h-7 max-w-[200px]"
                          />
                          <Button
                            size="icon"
                            variant="ghost"
                            className="size-7 shrink-0"
                            disabled={isBusy}
                            onClick={() => handleNameSave(member)}
                            aria-label={t('save')}
                          >
                            <Check className="size-3.5" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="size-7 shrink-0"
                            disabled={isBusy}
                            onClick={() => setEditingNameId(null)}
                            aria-label={t('cancel')}
                          >
                            <X className="size-3.5" />
                          </Button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <span className="text-foreground truncate text-sm font-medium">
                            {member.full_name || t('unnamed')}
                          </span>
                          {isSelf && (
                            <Badge className="bg-muted text-muted-foreground border-border text-[10px] tracking-wide uppercase">
                              {t('you')}
                            </Badge>
                          )}
                          {/* Name edit. Admin+ only; never on the owner
                              row or your own row — self-edits go through
                              the Profile settings tab instead. */}
                          {canManageMembers && !isOwnerRow && !isSelf && (
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <Button
                                    size="icon"
                                    variant="ghost"
                                    className="text-muted-foreground hover:text-foreground size-6 shrink-0"
                                    onClick={() => startEditingName(member)}
                                    aria-label={t('editNameTooltip')}
                                  >
                                    <Pencil className="size-3" />
                                  </Button>
                                }
                              />
                              <TooltipContent>{t('editNameTooltip')}</TooltipContent>
                            </Tooltip>
                          )}
                        </div>
                      )}
                      {member.email && (
                        <p className="text-muted-foreground truncate text-xs">
                          {member.email}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Joined date stays desktop-only. The mobile row's
                      vertical density makes the joined date noise. */}
                  <div className="text-muted-foreground hidden text-right text-xs sm:block">
                    {t('joined', { date: fmtDate(member.joined_at) })}
                  </div>

                  {/* Actions cluster. On mobile this is its own row
                      below the identity block; on desktop it sits
                      inline. Items align to the start on mobile so the
                      role dropdown lines up under the avatar. */}
                  <div className="flex items-center gap-2 sm:gap-3">
                    {/* Status toggle. Admin+ only; never on the owner
                        row or your own row (you can't lock yourself
                        out). Read-only badge otherwise. */}
                    {canManageMembers && !isOwnerRow && !isSelf ? (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <div className="flex items-center gap-1.5">
                              <Switch
                                checked={member.status === 'active'}
                                disabled={isBusy}
                                onCheckedChange={(checked) =>
                                  handleStatusChange(
                                    member,
                                    checked ? 'active' : 'inactive'
                                  )
                                }
                                aria-label={
                                  member.status === 'active'
                                    ? t('deactivateAction')
                                    : t('activateAction')
                                }
                              />
                              <span className="text-muted-foreground hidden text-xs sm:inline">
                                {member.status === 'active'
                                  ? t('statusActive')
                                  : t('statusInactive')}
                              </span>
                            </div>
                          }
                        />
                        <TooltipContent>
                          {member.status === 'active'
                            ? t('deactivateAction')
                            : t('activateAction')}
                        </TooltipContent>
                      </Tooltip>
                    ) : (
                      member.status === 'inactive' && (
                        <Badge className="border-border bg-muted text-muted-foreground text-[10px] tracking-wide uppercase">
                          {t('statusInactive')}
                        </Badge>
                      )
                    )}

                    {/* Role display / editor. Inline Select is admin+
                        only AND not allowed on the owner row (owner
                        changes go through transfer, which lands later). */}
                    {canManageMembers && !isOwnerRow && !isSelf ? (
                      <Select
                        value={member.role}
                        onValueChange={(v) =>
                          // Base UI Select can emit null on clear. We
                          // don't expose a clear affordance, so the
                          // guard is defensive — but the typed
                          // signature requires it.
                          v && handleRoleChange(member, v as AccountRole)
                        }
                      >
                        <SelectTrigger
                          className="bg-muted border-border text-foreground w-32"
                          disabled={isBusy}
                        >
                          <SelectValue>{tRoles(member.role)}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {EDITABLE_ROLES.map((r) => (
                            <SelectItem key={r.value} value={r.value}>
                              {tRoles(r.value)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <span
                        className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium ${roleMeta.className}`}
                      >
                        <RoleIcon className="size-3.5" />
                        {tRoles(member.role)}
                      </span>
                    )}

                    {/* Set password. Admin+ only; never on the owner
                        row or your own row — self password changes go
                        through Settings → Security instead. Uses the
                        service role server-side (see the /password
                        route) — never touches auth.users from here. */}
                    {canManageMembers && !isOwnerRow && !isSelf && (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setPasswordMember(member)}
                              disabled={isBusy}
                              className="border-border text-muted-foreground hover:bg-muted"
                            >
                              <KeyRound className="size-4" />
                            </Button>
                          }
                        />
                        <TooltipContent>{t('changePasswordTooltip')}</TooltipContent>
                      </Tooltip>
                    )}

                    {/* Remove. Admin+ only; never on the owner row;
                        never on yourself. Pre-polish styling was
                        neutral-default + red-on-hover — the
                        destructive intent was invisible until the
                        user moused over. Now red is the default
                        state with a darker shade on hover so the
                        affordance reads at-a-glance. */}
                    {canManageMembers && !isOwnerRow && !isSelf && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setRemovingMember(member)}
                        disabled={isBusy}
                        className="border-red-500/40 bg-red-500/10 text-red-300 hover:border-red-500/60 hover:bg-red-500/20 hover:text-red-200"
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          )}
        </CardContent>
      </Card>

      {/* Pending invitations — admin+ only */}
      <RequireRole min="admin">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <UsersRound className="text-muted-foreground size-4" />
            <h3 className="text-foreground text-sm font-semibold">
              {t('pendingInvitations')}
            </h3>
            <Badge className="bg-muted text-muted-foreground border-border">
              {invitations.length}
            </Badge>
          </div>
          {/* P10 — make the no-resend design explicit. Admins were
              confused why the pending list shows roles + expiry but
              no "copy link again" button. Stating the constraint up
              front (rather than letting the user discover it by
              looking for a button) keeps it from feeling like a bug. */}
          {invitations.length > 0 ? (
            <p className="text-muted-foreground mb-3 text-xs">
              {t('inviteHint')}
            </p>
          ) : null}

          {invitations.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-8 text-center">
                <Mail className="text-muted-foreground size-6" />
                <p className="text-muted-foreground mt-2 text-sm">
                  {t('noPendingTitle')}
                </p>
                <p className="text-muted-foreground mt-1 text-xs">
                  {t.rich('noPendingDesc', {
                    bold: (chunks) => <strong>{chunks}</strong>,
                  })}
                </p>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="p-0">
                <ul className="divide-border divide-y">
                  {invitations.map((inv) => {
                    const inviteRoleMeta = ROLE_META[inv.role];
                    const InviteRoleIcon = inviteRoleMeta.icon;
                    return (
                      <li
                        key={inv.id}
                        className="flex items-center gap-4 px-4 py-3"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-foreground text-sm font-medium">
                              {inv.label || t('untitledInvite')}
                            </span>
                            <span
                              className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium ${inviteRoleMeta.className}`}
                            >
                              <InviteRoleIcon className="size-3" />
                              {tRoles(inv.role)}
                            </span>
                          </div>
                          <p className="text-muted-foreground mt-0.5 text-xs">
                            {t('created', { date: fmtDate(inv.created_at) })} ·{' '}
                            {fmtExpiresIn(inv.expires_at, t)}
                          </p>
                        </div>

                        {/* Revoke: red default state, mirrors the
                          members-tab Remove button. Pre-polish version
                          read as a neutral secondary button until
                          hover. */}
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleRevoke(inv)}
                          className="border-red-500/40 bg-red-500/10 text-red-300 hover:border-red-500/60 hover:bg-red-500/20 hover:text-red-200"
                        >
                          <MailX className="size-4" />
                          {t('revoke')}
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              </CardContent>
            </Card>
          )}
        </div>
      </RequireRole>

      <InviteMemberDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        onCreated={loadEverything}
      />

      <Dialog
        open={removingMember !== null}
        onOpenChange={(open) => {
          if (!open) setRemovingMember(null);
        }}
      >
        <DialogContent className="bg-popover border-border sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground flex items-center gap-2">
              <AlertTriangle className="size-4 text-amber-400" />
              {t('removeDialogTitle')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t.rich('removeDialogDesc', {
                name: removingMember?.full_name || t('unnamed'),
                bold: (chunks: React.ReactNode) => <strong>{chunks}</strong>,
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="bg-popover border-border">
            <Button
              variant="outline"
              onClick={() => setRemovingMember(null)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t('cancel')}
            </Button>
            <Button
              onClick={handleRemove}
              disabled={!!pendingMemberAction}
              className="bg-red-600 text-white hover:bg-red-700"
            >
              {pendingMemberAction ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('removing')}
                </>
              ) : (
                t('removeBtn')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={passwordMember !== null}
        onOpenChange={(open) => {
          if (!open) closePasswordDialog();
        }}
      >
        <DialogContent className="bg-popover border-border sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground flex items-center gap-2">
              <KeyRound className="size-4" />
              {t('setPasswordTitle')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t.rich('setPasswordDesc', {
                name: passwordMember?.full_name || t('unnamed'),
                bold: (chunks: React.ReactNode) => <strong>{chunks}</strong>,
              })}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="member-new-password" className="text-foreground">
                {t('newPasswordLabel')}
              </Label>
              <Input
                id="member-new-password"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoComplete="new-password"
                disabled={passwordSaving}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="member-confirm-password" className="text-foreground">
                {t('confirmPasswordLabel')}
              </Label>
              <Input
                id="member-confirm-password"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
                disabled={passwordSaving}
              />
            </div>
            {passwordError && (
              <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {passwordError}
              </p>
            )}
          </div>

          <DialogFooter className="bg-popover border-border">
            <Button
              variant="outline"
              onClick={closePasswordDialog}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t('cancel')}
            </Button>
            <Button
              onClick={handlePasswordSave}
              disabled={passwordSaving || !newPassword || !confirmPassword}
            >
              {passwordSaving ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('settingPassword')}
                </>
              ) : (
                t('setPasswordBtn')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
