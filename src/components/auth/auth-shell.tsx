import Image from 'next/image';
import type { ReactNode } from 'react';

// Shared page chrome for the three auth screens (login, signup,
// forgot-password): full-bleed background photo, centered column for
// the card. Previously a CSS gradient + <LoginBackground /> (orbs /
// dot grid / spinning geometric outlines) — that decorative layer is
// intentionally not rendered anymore now that the background is a
// real photo with its own visual detail; the component itself stays
// in the tree (unused for now) in case a future screen wants it back.
export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-10">
      {/* `absolute`, not `fixed` — a `fixed` + negative-z-index element
          is positioned/stacked at the *root* of the page, where it
          competes with <body>'s own opaque `bg-background` and loses
          (body's background is a plain in-flow paint step that lands
          on top of a negative-z-index fixed descendant). `absolute`
          keeps it scoped to this `relative` wrapper instead, so it
          stacks purely against the card below — no solid layer ever
          gets a chance to sit between them, which the backdrop-filter
          on the card relies on to have something real to blur. */}
      <div className="absolute inset-0 -z-10" aria-hidden="true">
        <Image
          src="/branding/loginfondo-retail.png"
          alt=""
          fill
          priority
          sizes="100vw"
          className="object-cover object-center"
        />
      </div>
      <div className="relative z-10 w-full max-w-md">{children}</div>
    </div>
  );
}
