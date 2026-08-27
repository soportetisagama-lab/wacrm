'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/use-auth';
import { useTotalUnread } from '@/hooks/use-total-unread';
import { useUnreadNotifications } from '@/hooks/use-unread-notifications';
import {
  Bell,
  Bot,
  Briefcase,
  Crown,
  GitBranch,
  Headphones,
  LayoutDashboard,
  LogOut,
  MessageSquare,
  Radio,
  Settings,
  Shield,
  User,
  UserCog,
  Users,
  UsersRound,
  Workflow,
  X,
  Zap,
} from 'lucide-react';
import type { AccountRole } from '@/lib/auth/roles';

// Per-role chip metadata used in the sidebar's account strip + the
// Members tab roster. Keeping this near both consumers in a single
// place avoids drift between the two surfaces — when a designer
// wants to recolour "agent" rows, this is the one diff.
const ROLE_CHIP: Record<
  AccountRole,
  { icon: typeof Crown; labelKey: string; className: string }
> = {
  owner: {
    icon: Crown,
    labelKey: 'roleOwner',
    // Amber: scarce, immutable, "the boss" — gets visual emphasis.
    className: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  },
  admin: {
    icon: Shield,
    labelKey: 'roleAdmin',
    // Brand-blue tinted: significant but not as scarce as owner.
    className: 'border-sidebar-primary/40 bg-sidebar-primary/10 text-sidebar-primary',
  },
  gerencia: {
    icon: Briefcase,
    labelKey: 'roleGerencia',
    className: 'border-indigo-500/40 bg-indigo-500/10 text-indigo-300',
  },
  jefe_linea: {
    icon: UsersRound,
    labelKey: 'roleJefeLinea',
    className: 'border-teal-500/40 bg-teal-500/10 text-teal-300',
  },
  atc: {
    icon: Headphones,
    labelKey: 'roleAtc',
    className: 'border-orange-500/40 bg-orange-500/10 text-orange-300',
  },
  agent: {
    icon: UserCog,
    labelKey: 'roleAgent',
    // Neutral: the operational default.
    className: 'border-white/15 bg-white/5 text-sidebar-foreground/80',
  },
  viewer: {
    icon: User,
    labelKey: 'roleViewer',
    // Muted: read-only role; visually quieter than agent.
    className: 'border-white/10 bg-white/[0.03] text-sidebar-foreground/50',
  },
};
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface NavItem {
  href: string;
  labelKey: string;
  icon: typeof LayoutDashboard;
  /**
   * When true, the nav row renders a small "Beta" chip after the label.
   * Purely informational — doesn't affect routing or access.
   */
  beta?: boolean;
  /**
   * Optional sub-items (e.g. Settings sections). Rendered indented,
   * icon-less, prefixed with "›" — the same treeview pattern used by
   * the old AdminLTE-style sidebar this design is based on. No item
   * currently sets this; it's here so a section can grow sub-navigation
   * later without a rewrite.
   */
  children?: { href: string; labelKey: string }[];
}

const navItems: NavItem[] = [
  { href: '/dashboard', labelKey: 'dashboard', icon: LayoutDashboard },
  { href: '/inbox', labelKey: 'inbox', icon: MessageSquare },
  { href: '/notifications', labelKey: 'notifications', icon: Bell },
  { href: '/contacts', labelKey: 'contacts', icon: Users },
  { href: '/pipelines', labelKey: 'pipelines', icon: GitBranch },
  { href: '/broadcasts', labelKey: 'broadcasts', icon: Radio },
  { href: '/automations', labelKey: 'automations', icon: Zap },
  { href: '/flows', labelKey: 'flows', icon: Workflow, beta: true },
  { href: '/agents', labelKey: 'aiAgents', icon: Bot },
];

const bottomNavItems: NavItem[] = [
  { href: '/settings', labelKey: 'settings', icon: Settings },
];

interface SidebarProps {
  /** Controlled on mobile by the Header's hamburger button. Ignored on lg+. */
  open?: boolean;
  onClose?: () => void;
}

import { useTranslations } from 'next-intl';

export function Sidebar({ open = false, onClose }: SidebarProps) {
  const t = useTranslations('Sidebar');
  const pathname = usePathname();
  const { profile, profileLoading, account, accountRole, signOut } = useAuth();
  const totalUnread = useTotalUnread();
  const unreadNotifications = useUnreadNotifications();
  // Only surface the account-name strip when it actually carries
  // information. A solo user's personal account is named after them
  // (the 017 signup trigger seeds it from `full_name`), so showing it
  // here would just duplicate the user name in the footer below. Once
  // the account is renamed or the user joins a shared account, the
  // name diverges and the strip becomes meaningful — that's the signal
  // we gate on. Wait for the profile fetch to settle first, otherwise
  // the strip flashes in once the row resolves (a layout jump).
  const showAccountStrip =
    !profileLoading && !!account?.name && account.name !== profile?.full_name;

  // Close the drawer when route changes — users opened it to navigate,
  // so once they pick a destination the drawer should get out of the way.
  useEffect(() => {
    onClose?.();
    // Only pathname drives this — onClose identity doesn't need to re-run it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // Lock body scroll and allow Escape to close while the drawer is open on
  // mobile. No-ops on desktop because the sidebar isn't positioned there.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  // Shared row renderer for both the main nav list and the bottom
  // (Settings) list — same active/hover/badge treatment either way.
  const renderNavItem = (item: NavItem) => {
    const isActive =
      pathname === item.href ||
      (item.href !== '/dashboard' && pathname.startsWith(item.href));

    const childActive =
      item.children?.some(
        (child) => pathname === child.href || pathname.startsWith(child.href)
      ) ?? false;

    const showUnreadDot =
      item.href === '/inbox' && totalUnread > 0 && !isActive;

    // Unlike the inbox dot, the notifications count stays visible
    // even while the page is active — it reflects unread state
    // (cleared by marking notifications read), not "currently
    // viewing this section".
    const showNotificationBadge =
      item.href === '/notifications' && unreadNotifications > 0;

    return (
      <li key={item.href}>
        <Link
          href={item.href}
          className={cn(
            'group relative flex items-center gap-3 border-l-[3px] border-transparent px-4 py-2.5 text-xs font-medium tracking-[0.08em] uppercase transition-colors duration-150 lg:py-2.5',
            isActive || childActive
              ? 'bg-[var(--sidebar-accent-dim)] text-sidebar-primary border-sidebar-primary'
              : 'text-sidebar-foreground/85 hover:bg-sidebar-accent hover:text-sidebar-foreground hover:border-sidebar-primary/40'
          )}
        >
          <item.icon
            className={cn(
              'h-4 w-4 shrink-0 transition-colors',
              isActive || childActive
                ? 'text-sidebar-primary'
                : 'text-sidebar-foreground/60 group-hover:text-sidebar-foreground'
            )}
          />
          <span className="flex-1 truncate">{t(item.labelKey as string)}</span>
          {item.beta && (
            <span
              aria-label={t('beta')}
              className="rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-semibold tracking-wider text-amber-300 normal-case"
            >
              {t('beta')}
            </span>
          )}
          {showUnreadDot && (
            <span
              aria-label={t('unreadConversations', {
                count: totalUnread,
              })}
              className="relative flex h-2 w-2 shrink-0"
            >
              <span className="bg-sidebar-primary absolute inline-flex h-full w-full animate-ping rounded-full opacity-75" />
              <span className="bg-sidebar-primary relative inline-flex h-2 w-2 rounded-full" />
            </span>
          )}
          {showNotificationBadge && (
            <span
              aria-label={t('unreadNotifications', {
                count: unreadNotifications,
              })}
              className="bg-sidebar-primary text-sidebar-primary-foreground flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1 text-[10px] font-semibold normal-case"
            >
              {unreadNotifications > 9 ? '9+' : unreadNotifications}
            </span>
          )}
        </Link>
        {item.children && item.children.length > 0 && (
          <ul className="bg-[var(--sidebar-sub)]">
            {item.children.map((child) => {
              const isChildActive =
                pathname === child.href || pathname.startsWith(child.href);
              return (
                <li key={child.href}>
                  <Link
                    href={child.href}
                    className={cn(
                      "flex items-center border-l-[3px] border-transparent py-3 pr-4 pl-[3.1rem] text-[11px] font-normal tracking-[0.08em] uppercase transition-colors duration-150",
                      "before:content-['›'] before:mr-2 before:text-base before:leading-none before:text-white/20 before:transition-colors before:duration-150",
                      isChildActive
                        ? 'text-sidebar-primary border-sidebar-primary before:text-sidebar-primary'
                        : 'text-sidebar-foreground/70 hover:bg-white/[0.03] hover:text-sidebar-foreground/90 hover:border-sidebar-primary/40 hover:before:text-sidebar-primary'
                    )}
                  >
                    {t(child.labelKey as string)}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </li>
    );
  };

  return (
    <>
      {/* Backdrop — only exists on mobile and only when open. Clicking
          it closes the drawer. Hidden from lg+ since the sidebar is
          part of the main flex row there. */}
      <button
        type="button"
        aria-label={t('closeMenu')}
        onClick={onClose}
        className={cn(
          'bg-background/70 fixed inset-0 z-30 backdrop-blur-sm transition-opacity lg:hidden',
          open
            ? 'pointer-events-auto opacity-100'
            : 'pointer-events-none opacity-0'
        )}
      />

      <aside
        className={cn(
          // Mobile: fixed drawer that slides in from the left.
          'bg-sidebar border-sidebar-border fixed inset-y-0 left-0 z-40 flex h-full w-64 flex-col border-r',
          'transition-transform duration-200 ease-out will-change-transform',
          open ? 'translate-x-0' : '-translate-x-full',
          // Desktop: static, always visible — reset all the mobile framing.
          'lg:static lg:z-0 lg:w-72 lg:translate-x-0 lg:transition-none'
        )}
        aria-label="Primary"
      >
        {/* Logo row — the Sagama wordmark, centered, with a mobile-only
            close button overlaid on top so it doesn't skew the centering. */}
        <div className="border-sidebar-border relative flex h-20 shrink-0 items-center justify-center border-b px-5">
          <Link href="/dashboard" className="flex items-center justify-center">
            <Image
              src="/branding/SAGAMAMENU.png"
              alt="Sagama Inox CRM"
              width={882}
              height={283}
              priority
              className="h-auto w-full max-w-[240px]"
            />
          </Link>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('closeMenu')}
            className="text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground absolute top-1/2 right-3 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-md lg:hidden"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Main navigation */}
        <nav className="flex-1 overflow-y-auto py-3">
          <ul className="flex flex-col">{navItems.map(renderNavItem)}</ul>

          <div className="border-sidebar-border my-3 border-t" />

          <ul className="flex flex-col">{bottomNavItems.map(renderNavItem)}</ul>
        </nav>

        {/* User section */}
        <div className="border-sidebar-border shrink-0 border-t p-3">
          {/* Account name display — surfaced only when the account
              name differs from the user's own name (see
              `showAccountStrip`). For a default solo account the two
              match, so we hide it to avoid duplicating the user name
              below; for renamed or shared accounts it tells the user
              which account they're acting in. */}
          {showAccountStrip && account?.name ? (
            <div className="text-sidebar-foreground/60 mb-2 flex items-center gap-2 px-1 text-xs">
              <UsersRound className="size-3.5 shrink-0" />
              {/* `title=` exposes the full name on hover when it
                  gets truncated (long account names + narrow
                  sidebars). Cheap a11y win. */}
              <span className="truncate" title={account.name}>
                {account.name}
              </span>
              {accountRole
                ? // Always render the chip — owners used to be
                  // invisible here, which made them indistinguishable
                  // from admins at a glance. Now everyone sees their
                  // role (with a colour cue) regardless of tier.
                  (() => {
                    const meta = ROLE_CHIP[accountRole];
                    const Icon = meta.icon;
                    return (
                      <span
                        className={`ml-auto inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium tracking-wider uppercase ${meta.className}`}
                      >
                        <Icon className="size-3" />
                        {t(meta.labelKey as string)}
                      </span>
                    );
                  })()
                : null}
            </div>
          ) : null}
          {/* Credential-card style trigger: avatar on top, name + email
              centered below, inside a bordered card that reads as an
              ID badge rather than a plain menu row. */}
          <DropdownMenu>
            <DropdownMenuTrigger className="border-sidebar-border bg-white/[0.03] hover:bg-sidebar-accent focus-visible:ring-sidebar-ring flex w-full flex-col items-center gap-2 rounded-lg border px-3 py-4 text-center transition-colors focus:outline-none focus-visible:ring-2">
              <Avatar className="after:rounded-xl size-16 shrink-0 rounded-xl">
                {profile?.avatar_url ? (
                  <AvatarImage
                    src={profile.avatar_url}
                    alt={profile.full_name ?? t('defaultAvatar')}
                    className="rounded-xl"
                  />
                ) : null}
                <AvatarFallback className="bg-sidebar-primary/15 text-sidebar-primary rounded-xl text-lg font-semibold">
                  {profile?.full_name?.charAt(0)?.toUpperCase() ??
                    profile?.email?.charAt(0)?.toUpperCase() ??
                    'U'}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 w-full">
                <p className="text-sidebar-foreground truncate text-sm font-semibold">
                  {profile?.full_name ?? t('defaultUser')}
                </p>
                <p className="text-sidebar-foreground/50 truncate text-xs">
                  {profile?.email ?? ''}
                </p>
              </div>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="center"
              side="top"
              sideOffset={8}
              className="bg-popover text-popover-foreground ring-border min-w-56"
            >
              <DropdownMenuItem
                render={
                  <Link
                    href="/settings?tab=profile"
                    onClick={onClose}
                    className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
                  />
                }
              >
                <User className="size-4" />
                {t('menuProfile')}
              </DropdownMenuItem>
              <DropdownMenuItem
                render={
                  <Link
                    href="/settings?tab=whatsapp"
                    onClick={onClose}
                    className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
                  />
                }
              >
                <Settings className="size-4" />
                {t('menuSettings')}
              </DropdownMenuItem>
              <DropdownMenuSeparator className="bg-border" />
              <DropdownMenuItem
                onClick={signOut}
                className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
              >
                <LogOut className="size-4" />
                {t('menuSignOut')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </aside>
    </>
  );
}
