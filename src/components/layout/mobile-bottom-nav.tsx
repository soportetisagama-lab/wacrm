"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Bell, MessageSquare, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTotalUnread } from "@/hooks/use-total-unread";
import { useUnreadNotifications } from "@/hooks/use-unread-notifications";
import { useTranslations } from "next-intl";

/**
 * Bottom tab bar for the Android WebView wrapper (see dashboard-shell.tsx's
 * `embedded` branch) — a "liquid glass" floating pill, styled after the
 * reference mobile design: frosted/translucent background, rounded, a
 * few icon tabs instead of the desktop sidebar's full list. Deliberately
 * NOT the same items as the (already role-filtered) desktop sidebar —
 * Panel doesn't belong in a phone-only field-agent tool; Bandeja is the
 * point of the app, Contactos and Notificaciones are the two things an
 * agent visiting a client on-site would actually reach for next.
 */
const TABS = [
  { href: "/inbox", labelKey: "inbox", icon: MessageSquare },
  { href: "/contacts", labelKey: "contacts", icon: Users },
  { href: "/notifications", labelKey: "notifications", icon: Bell },
] as const;

export function MobileBottomNav() {
  const t = useTranslations("Sidebar");
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const totalUnread = useTotalUnread();
  const unreadNotifications = useUnreadNotifications();

  // Inside an open conversation thread (/inbox?c=<id>) the thread takes
  // over the whole screen, like a real chat app — a persistent tab bar
  // here would sit on top of (or steal height from) the message
  // composer. Hide it entirely and give the thread the full viewport;
  // its own back arrow returns to the list, where the bar reappears.
  const isInboxThreadOpen = pathname === "/inbox" && !!searchParams.get("c");
  if (isInboxThreadOpen) return null;

  return (
    <nav
      aria-label={t("primaryNav")}
      className="shrink-0 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2"
    >
      <div className="border-border/40 bg-card/70 mx-auto flex max-w-sm items-center justify-around rounded-full border py-2 shadow-lg backdrop-blur-xl">
        {TABS.map((tab) => {
          const isActive =
            pathname === tab.href || pathname.startsWith(`${tab.href}/`);
          const badgeCount =
            tab.href === "/inbox"
              ? totalUnread
              : tab.href === "/notifications"
                ? unreadNotifications
                : 0;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={cn(
                "relative flex flex-1 flex-col items-center gap-0.5 rounded-full py-1.5 text-[10px] font-medium tracking-wide uppercase transition-colors",
                isActive
                  ? "text-primary"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <span className="relative">
                <tab.icon className="h-5 w-5" />
                {badgeCount > 0 && (
                  <span className="bg-primary text-primary-foreground absolute -top-1.5 -right-2 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-semibold normal-case">
                    {badgeCount > 9 ? "9+" : badgeCount}
                  </span>
                )}
              </span>
              {t(tab.labelKey)}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
