"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/hooks/use-auth";
import { useUnreadNotifications } from "@/hooks/use-unread-notifications";
import { Bell, LogOut, Menu, Settings as SettingsIcon, User } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ModeToggle } from "@/components/layout/mode-toggle";
import { FullscreenToggle } from "@/components/layout/fullscreen-toggle";
import { SidebarCollapseToggle } from "@/components/layout/sidebar-collapse-toggle";

const pageTitles: Record<string, string> = {
  "/dashboard": "dashboard",
  "/inbox": "inbox",
  "/notifications": "notifications",
  "/contacts": "contacts",
  "/pipelines": "pipelines",
  "/broadcasts": "broadcasts",
  "/automations": "automations",
  "/settings": "settings",
};

function getPageTitleKey(pathname: string): string {
  if (pageTitles[pathname]) return pageTitles[pathname];
  const match = Object.entries(pageTitles).find(([path]) =>
    pathname.startsWith(path),
  );
  return match ? match[1] : "dashboard";
}

interface HeaderProps {
  /** Wired to the shell's drawer state. Used only on mobile — the
   *  hamburger button is hidden on lg+. */
  onOpenSidebar?: () => void;
  /** Desktop icon-rail state, lifted to the shell so both the header
   *  button and the sidebar itself read the same value. */
  sidebarCollapsed?: boolean;
  onToggleSidebarCollapsed?: () => void;
}

import { useTranslations } from "next-intl";

export function Header({
  onOpenSidebar,
  sidebarCollapsed = false,
  onToggleSidebarCollapsed,
}: HeaderProps) {
  const t = useTranslations("Header");
  const tSidebar = useTranslations("Sidebar");
  const pathname = usePathname();
  const { profile, signOut } = useAuth();
  const titleKey = getPageTitleKey(pathname);
  const unreadNotifications = useUnreadNotifications();
  const hasUnread = unreadNotifications > 0;

  const initial =
    profile?.full_name?.charAt(0)?.toUpperCase() ??
    profile?.email?.charAt(0)?.toUpperCase() ??
    "U";

  return (
    <header className="flex h-16 shrink-0 items-center justify-between gap-3 border-b border-white/10 bg-[linear-gradient(135deg,var(--header-bg)_0%,var(--header-bg-2)_100%)] px-4 lg:px-6">
      <div className="flex min-w-0 items-center gap-2">
        {/* Hamburger — mobile only. 44×44 hit target per Apple HIG. */}
        <button
          type="button"
          onClick={onOpenSidebar}
          aria-label={t("openMenu")}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-white/90 transition-colors hover:bg-white/15 hover:text-white lg:hidden"
        >
          <Menu className="h-5 w-5" />
        </button>

        {/* Fullscreen + sidebar-collapse — same pill styling as the
            ModeToggle override below (white circle on the blue header
            background). Hidden below sm alongside the rest of the
            header's secondary controls; the mobile header is already
            tight with the hamburger + title. */}
        <div className="hidden shrink-0 items-center gap-1.5 sm:flex">
          <FullscreenToggle className="h-10 w-10 shrink-0 rounded-full border-2 border-white/15 bg-white text-[#247afa] shadow-[0_3px_10px_rgba(0,0,0,0.25)] transition-all duration-300 hover:scale-[1.07] hover:border-white/30 hover:bg-[#162028] hover:text-white" />
          {onToggleSidebarCollapsed && (
            <SidebarCollapseToggle
              collapsed={sidebarCollapsed}
              onToggle={onToggleSidebarCollapsed}
              className="h-10 w-10 shrink-0 rounded-full border-2 border-white/15 bg-white text-[#247afa] shadow-[0_3px_10px_rgba(0,0,0,0.25)] transition-all duration-300 hover:scale-[1.07] hover:border-white/30 hover:bg-[#162028] hover:text-white"
            />
          )}
        </div>

        <h1 className="truncate text-base font-semibold text-white sm:text-lg">
          {t(titleKey as string)}
        </h1>
      </div>

      <div className="flex items-center gap-1.5 sm:gap-2.5">
        <ModeToggle className="h-10 w-10 shrink-0 rounded-full border-2 border-white/15 bg-white text-[#247afa] shadow-[0_3px_10px_rgba(0,0,0,0.25)] transition-all duration-300 hover:scale-[1.07] hover:border-white/30 hover:bg-[#162028] hover:text-white" />

        {/* Notifications — same unread count the sidebar's nav item
            surfaces, mirrored here as a quick-glance bell. */}
        <Link
          href="/notifications"
          aria-label={
            hasUnread
              ? tSidebar("unreadNotifications", { count: unreadNotifications })
              : t("notifications")
          }
          title={t("notifications")}
          className="relative flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-full border-2 border-white/40 bg-white/20 transition-all duration-300 hover:-translate-y-0.5 hover:bg-white/30 hover:shadow-[0_6px_18px_rgba(0,0,0,0.2)]"
        >
          {hasUnread && (
            <span
              aria-hidden
              className="absolute inset-0 rounded-full bg-[#ff2d55]/35 [animation:ring-pulse_1.5s_ease-out_infinite]"
            />
          )}
          <Bell
            className={cn(
              "relative z-10 h-4 w-4 transition-colors",
              hasUnread
                ? "text-[#ff4757] [animation:bell-ring_1.2s_ease-in-out_infinite] drop-shadow-[0_0_4px_rgba(255,255,255,0.6)]"
                : "text-white",
            )}
          />
          {hasUnread && (
            <span
              aria-hidden
              className="absolute -top-1.5 -right-1.5 z-20 flex h-[18px] min-w-[18px] items-center justify-center rounded-full border-2 border-white bg-[#ff2d55] px-1 text-[10px] font-extrabold text-white shadow-[0_2px_8px_rgba(255,45,85,0.6)] [animation:badge-bounce_1.5s_ease-in-out_infinite]"
            >
              {unreadNotifications > 9 ? "9+" : unreadNotifications}
            </span>
          )}
        </Link>

        <DropdownMenu>
        <DropdownMenuTrigger
          className="flex shrink-0 items-center gap-2 rounded-full border border-white/40 bg-white/15 px-2 py-1.5 backdrop-blur-md transition-all duration-200 hover:bg-white/25 hover:shadow-[0_4px_12px_rgba(0,0,0,0.15)] focus:outline-none data-popup-open:bg-white/25 sm:gap-3 sm:px-3.5"
          aria-label={t("openAccountMenu")}
        >
          <Avatar className="size-8 border-2 border-white/90 shadow-[0_2px_8px_rgba(0,0,0,0.15)] after:border-white/70">
            {profile?.avatar_url ? (
              <AvatarImage
                src={profile.avatar_url}
                alt={profile.full_name ?? t("defaultAvatar")}
              />
            ) : null}
            <AvatarFallback className="bg-white text-sm font-medium text-[#247afa]">
              {initial}
            </AvatarFallback>
          </Avatar>
          <span className="hidden text-sm font-semibold text-white sm:inline">
            {profile?.full_name ?? t("defaultUser")}
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          sideOffset={6}
          className="min-w-56 bg-popover text-popover-foreground ring-border"
        >
          <div className="px-2 py-1.5">
            <p className="truncate text-sm font-medium text-foreground">
              {profile?.full_name ?? t("defaultUser")}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {profile?.email ?? ""}
            </p>
          </div>
          <DropdownMenuSeparator className="bg-border" />
          <DropdownMenuItem
            render={
              <Link
                href="/settings?tab=profile"
                className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
              />
            }
          >
            <User className="size-4" />
            {t("menuProfile")}
          </DropdownMenuItem>
          <DropdownMenuItem
            render={
              <Link
                href="/settings?tab=whatsapp"
                className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
              />
            }
          >
            <SettingsIcon className="size-4" />
            {t("menuSettings")}
          </DropdownMenuItem>
          <DropdownMenuSeparator className="bg-border" />
          <DropdownMenuItem
            onClick={signOut}
            className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
          >
            <LogOut className="size-4" />
            {t("menuSignOut")}
          </DropdownMenuItem>
        </DropdownMenuContent>
        </DropdownMenu>

        {/* Quick sign-out — same action as the dropdown's item above,
            just promoted to a one-click circle per the reference navbar. */}
        <button
          type="button"
          onClick={signOut}
          aria-label={t("menuSignOut")}
          title={t("menuSignOut")}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-white/30 bg-white/15 backdrop-blur-md transition-all duration-200 hover:bg-[#ff4757]/25 hover:shadow-[0_4px_12px_rgba(255,71,87,0.3)] sm:h-12 sm:w-12"
        >
          <LogOut className="h-4 w-4 text-white/95 sm:h-[18px] sm:w-[18px]" />
        </button>
      </div>
    </header>
  );
}
