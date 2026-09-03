"use client";

import { PanelLeftClose, PanelLeftOpen } from "lucide-react";

import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";

/**
 * Toggles the desktop sidebar between full (icon + label) and
 * icon-only rail mode. Mirrors <ModeToggle>'s shape — the actual
 * collapsed state lives in the dashboard shell (shared with
 * <Sidebar>), this is just the trigger.
 */
export function SidebarCollapseToggle({
  collapsed,
  onToggle,
  className,
}: {
  collapsed: boolean;
  onToggle: () => void;
  className?: string;
}) {
  const t = useTranslations("Header");
  const label = t(collapsed ? "expandSidebar" : "collapseSidebar");

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={label}
      title={label}
      className={cn(
        "flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
        className,
      )}
    >
      {collapsed ? (
        <PanelLeftOpen className="h-5 w-5" />
      ) : (
        <PanelLeftClose className="h-5 w-5" />
      )}
    </button>
  );
}
