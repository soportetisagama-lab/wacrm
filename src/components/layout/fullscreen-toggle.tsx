"use client";

import { useEffect, useState } from "react";
import { Maximize, Minimize } from "lucide-react";

import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";

/**
 * Browser fullscreen toggle — mirrors <ModeToggle>'s shape (single
 * icon button, label names the destination). Tracks the *actual*
 * fullscreen state via the `fullscreenchange` event rather than just
 * flipping a local boolean on click, so the icon stays correct if the
 * user leaves fullscreen some other way (Esc, F11, browser UI).
 */
export function FullscreenToggle({ className }: { className?: string }) {
  const t = useTranslations("Header");
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    onChange();
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggle = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      // requestFullscreen can reject (e.g. permissions policy in an
      // embedded iframe) — swallow it, there's nothing useful to show
      // the user beyond the button simply not doing anything.
      void document.documentElement.requestFullscreen().catch(() => {});
    }
  };

  const label = t(isFullscreen ? "fullscreenExit" : "fullscreenEnter");

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      title={label}
      className={cn(
        "flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
        className,
      )}
    >
      {isFullscreen ? (
        <Minimize className="h-5 w-5" />
      ) : (
        <Maximize className="h-5 w-5" />
      )}
    </button>
  );
}
