"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { useTranslations } from "next-intl";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { PresenceHeartbeat } from "@/components/presence/presence-heartbeat";
import { TotalUnreadProvider } from "@/hooks/use-total-unread";
import { UnreadNotificationsProvider } from "@/hooks/use-unread-notifications";
import { isEmbeddedApp } from "@/lib/mobile-app";
import { MobileBottomNav } from "@/components/layout/mobile-bottom-nav";

// Auth-gated dashboard shell. Extracted from the layout so the layout
// itself can stay a server component and export metadata (noindex) —
// client components can't export Next's metadata object.

const SIDEBAR_COLLAPSED_KEY = 'wacrm.sidebarCollapsed';

function DashboardShellInner({ children }: { children: React.ReactNode }) {
  const t = useTranslations("Common");
  const { user, loading } = useAuth();
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
  // a slim centered-logo bar on top, the page's own content (already
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
          <div className="flex h-screen flex-col overflow-hidden bg-background">
            <PresenceHeartbeat />
            {/* Same dark brand panel the desktop Sidebar uses (bg-sidebar) —
                the logo is a light/white wordmark, so it needs that dark
                background to read at all; on the page's own bg-background
                it was rendering nearly invisible. */}
            <div className="bg-sidebar border-sidebar-border flex shrink-0 items-center justify-center border-b py-3 shadow-sm">
              <Image
                src="/branding/SAGAMAMENU.png"
                alt="Sagama CRM"
                width={882}
                height={283}
                priority
                className="h-auto w-full max-w-[120px]"
              />
            </div>
            <main className="min-h-0 flex-1 overflow-hidden">{children}</main>
            <MobileBottomNav />
          </div>
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

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <DashboardShellInner>{children}</DashboardShellInner>
    </AuthProvider>
  );
}
