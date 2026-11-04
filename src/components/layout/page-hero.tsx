import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Boxed section header shared by the dashboard pages (same look as the
 * Automatizaciones and broadcast-detail headers): icon + title +
 * subtitle on the left, actions on the right, soft brand glow on top.
 * Uses only theme tokens, so each line keeps its own color.
 */
export function PageHero({
  icon: Icon,
  title,
  subtitle,
  actions,
  children,
  className,
}: {
  icon: LucideIcon;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /** Extra row under the subtitle (counters, chips). */
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "relative isolate flex flex-wrap items-center justify-between gap-3 overflow-hidden rounded-3xl border border-border bg-card px-5 py-5 shadow-sm sm:px-8",
        className,
      )}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-32"
        style={{
          background:
            "radial-gradient(60% 100% at 50% 0%, color-mix(in oklab, var(--primary) 14%, transparent), transparent 75%)",
        }}
      />
      <div className="flex min-w-0 items-center gap-4">
        <span
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"
          aria-hidden
        >
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h1 className="text-2xl leading-tight font-extrabold tracking-tight text-foreground">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
          {children}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </section>
  );
}
