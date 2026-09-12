"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import Image from "next/image";
import { useTranslations } from "next-intl";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { ModeToggle } from "@/components/layout/mode-toggle";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { PresenceHeartbeat } from "@/components/presence/presence-heartbeat";
import { TotalUnreadProvider } from "@/hooks/use-total-unread";
import { UnreadNotificationsProvider } from "@/hooks/use-unread-notifications";
import { isEmbeddedApp, isInboxThreadRoute } from "@/lib/mobile-app";
import { MobileBottomNav } from "@/components/layout/mobile-bottom-nav";
import { App } from "@capacitor/app";

// Auth-gated dashboard shell. Extracted from the layout so the layout
// itself can stay a server component and export metadata (noindex) —
// client components can't export Next's metadata object.

const SIDEBAR_COLLAPSED_KEY = 'wacrm.sidebarCollapsed';

function DashboardShellInner({ children }: { children: React.ReactNode }) {
  const t = useTranslations("Common");
  const { user, profile, loading } = useAuth();
  const router = useRouter();

  // Set once on mount — the Android WebView wrapper's User-Agent never
  // changes mid-session, and reading `navigator` during render would
  // mismatch the server-rendered HTML (SSR always sees `false`).
  const [embedded, setEmbedded] = useState(false);
  useEffect(() => {
    setEmbedded(isEmbeddedApp());
  }, []);

  // Sidebar drawer state — only used on mobile. On lg+ the sidebar is
  // always visible and this stays at `false` (ignored by the component).
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  // Desktop-only "icon rail" mode, toggled from the header. Starts
  // `false` so server and first client render match (avoids a
  // hydration mismatch); the persisted preference is applied right
  // after mount via the effect below, same pattern as the theme
  // boot script but for a value that isn't render-blocking-critical.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  useEffect(() => {
    try {
      setSidebarCollapsed(localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1');
    } catch {
      // localStorage unavailable — just keep the default (expanded).
    }
  }, []);

  const toggleSidebarCollapsed = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? '1' : '0');
      } catch {
        // Ignore — the toggle still works for this session.
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (!loading && !user) {
      router.push("/login");
    }
  }, [user, loading, router]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">{t("loading")}</p>
        </div>
      </div>
    );
  }

  if (!user) return null;

  // Android WebView wrapper: the app IS a small, phone-first tool — no
  // desktop Sidebar/Header — in favor of a WhatsApp-style bare shell:
  // a slim top bar on list screens, the page's own content (already
  // responsive down to phone width — see /inbox's list/thread panes)
  // filling the middle, and a floating "liquid glass" bottom tab bar
  // (Bandeja/Contactos/Notificaciones — deliberately not the full,
  // already role-filtered desktop nav; Panel doesn't belong in a
  // phone-only field tool) instead of a side rail. Both realtime
  // providers stay: the inbox's own unread badges and the bottom
  // bar's badge dots both read them.
  if (embedded) {
    return (
      <UnreadNotificationsProvider>
        <TotalUnreadProvider>
          <Suspense fallback={null}>
            <EmbeddedShell
              advisorName={profile?.full_name || profile?.email || null}
              avatarUrl={profile?.avatar_url ?? null}
            >
              {children}
            </EmbeddedShell>
          </Suspense>
        </TotalUnreadProvider>
      </UnreadNotificationsProvider>
    );
  }

  return (
    // Sidebar and Header both read these two realtime counts — one
    // provider each keeps a single Supabase channel behind them
    // instead of every consumer opening its own (see the providers'
    // doc comments for why a second subscription on the same fixed
    // channel name used to crash).
    <UnreadNotificationsProvider>
      <TotalUnreadProvider>
        <div className="flex h-screen overflow-hidden bg-background">
          {/* Reports this tab's online/away presence once we know a user is
              signed in. Headless — renders nothing. */}
          <PresenceHeartbeat />
          <Sidebar
            open={sidebarOpen}
            onClose={closeSidebar}
            collapsed={sidebarCollapsed}
          />
          <div className="flex flex-1 flex-col overflow-hidden">
            <Header
              onOpenSidebar={() => setSidebarOpen(true)}
              sidebarCollapsed={sidebarCollapsed}
              onToggleSidebarCollapsed={toggleSidebarCollapsed}
            />
            {/* Thinner horizontal padding on mobile so cards have room to breathe. */}
            <main className="flex-1 overflow-y-auto p-4 sm:p-6">{children}</main>
          </div>
        </div>
      </TotalUnreadProvider>
    </UnreadNotificationsProvider>
  );
}

/**
 * The embedded (Android wrapper) shell's own route-aware bits —
 * split out from DashboardShellInner because useSearchParams()
 * requires a Suspense boundary, and only this branch needs it.
 */
function EmbeddedShell({
  children,
  advisorName,
  avatarUrl,
}: {
  children: React.ReactNode;
  advisorName: string | null;
  avatarUrl: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const isThreadOpen = isInboxThreadRoute(pathname, searchParams);

  // Keep the latest route in a ref so the back-button listener (set up
  // once below) always reads current state instead of the closure from
  // whenever it was registered — avoids tearing the native listener
  // down and re-adding it on every navigation.
  const routeRef = useRef({ pathname, searchParams });
  useEffect(() => {
    routeRef.current = { pathname, searchParams };
  });

  // Hardware back button (Android): inside an open conversation thread,
  // go back to the list — same place the in-app back arrow goes.
  // Anywhere else (any list screen — Bandeja/Contactos/Notificaciones)
  // is "root" for this phone-only shell, so back there exits the app,
  // same as pressing back on WhatsApp's own chat list. Without this
  // listener the WebView's default behaviour is to just close the
  // activity outright, even from inside a chat.
  useEffect(() => {
    let listenerHandle: { remove: () => void } | undefined;
    let cancelled = false;
    App.addListener("backButton", () => {
      const { pathname: currentPath, searchParams: currentParams } = routeRef.current;
      if (isInboxThreadRoute(currentPath, currentParams)) {
        router.replace("/inbox", { scroll: false });
      } else {
        App.exitApp();
      }
    }).then((handle) => {
      if (cancelled) {
        handle.remove();
      } else {
        listenerHandle = handle;
      }
    });
    return () => {
      cancelled = true;
      listenerHandle?.remove();
    };
  }, [router]);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <PresenceHeartbeat />
      {/* The logo/brand bar only belongs on the list screens — inside an
          open chat, MessageThread renders its own header (contact name,
          status, back arrow) and every pixel of height matters, same as
          WhatsApp never doubling up its chat-list header inside a chat. */}
      {!isThreadOpen && (
        <div className="relative flex shrink-0 items-center justify-between gap-3 overflow-hidden border-b border-white/10 bg-[linear-gradient(135deg,var(--header-bg)_0%,var(--header-bg-2)_100%)] px-4 pb-6 pt-[max(1.25rem,env(safe-area-inset-top))] shadow-[0_4px_14px_rgba(0,0,0,0.18)]">
          {/* w-[116px] with h-auto only scales the logo's own box —
              next/image's width/height attrs keep it at its real 882:283
              ratio, so it can't stretch/distort no matter what width is
              picked here. */}
          <Image
            src="/branding/SAGAMAMENU.png"
            alt="Sagama CRM"
            width={882}
            height={283}
            priority
            className="h-auto w-[116px] shrink-0 drop-shadow-sm"
          />
          <div className="flex min-w-0 items-center gap-2.5">
            {advisorName && (
              <>
                <Avatar className="size-9 shrink-0 rounded-lg ring-1 ring-white/25">
                  {avatarUrl ? (
                    <AvatarImage src={avatarUrl} alt={advisorName} className="rounded-lg" />
                  ) : null}
                  <AvatarFallback className="rounded-lg bg-white/15 text-sm font-semibold text-white">
                    {advisorName.charAt(0).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <span className="flex min-w-0 max-w-[92px] items-center gap-1 truncate text-xs font-semibold text-white/95">
                  <span className="truncate">{advisorName}</span>
                  <Image
                    src="/branding/Verificado.png"
                    alt=""
                    width={18}
                    height={18}
                    className="h-3.5 w-3.5 shrink-0"
                  />
                </span>
              </>
            )}
            <ModeToggle className="h-9 w-9 shrink-0 rounded-full text-white/90 hover:bg-white/15 hover:text-white" />
          </div>
        </div>
      )}
      <main className="min-h-0 flex-1 overflow-hidden">
        {/* Keyed by pathname only (not by thread-open state) — switching
            Bandeja/Contactos/Notificaciones is a real route change that
            remounts the page anyway, so the fade rides along for free.
            Opening/closing a conversation does NOT change `pathname`
            (still /inbox, just a different `?c=` search param) and the
            list/thread panes underneath already coexist mounted with
            their own CSS show/hide — keying on isThreadOpen here forced
            an extra, unwanted remount of the whole inbox page every time
            a thread opened (full state reset + refetch), which is what
            caused the search bar/chips to flash before the chat
            appeared. No fade on that specific transition now — the
            correct fix is not reintroducing the remount for it. */}
        <div key={pathname} className="h-full animate-in fade-in duration-200">
          {children}
        </div>
      </main>
      {!isThreadOpen && <MobileBottomNav />}
    </div>
  );
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <DashboardShellInner>{children}</DashboardShellInner>
    </AuthProvider>
  );
}
