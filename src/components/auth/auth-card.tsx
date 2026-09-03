import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';
import styles from '@/components/auth/auth-visuals.module.css';

export function AuthCard({
  children,
  shake,
  className,
}: {
  children: ReactNode;
  shake?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-[32px] px-8 py-10 sm:px-12 sm:py-14',
        styles.glassCard,
        styles.cardEntrance,
        shake && styles.shake,
        className
      )}
    >
      {/* `relative` (no z-index needed) lifts the real content above
          `.glassCard::before` — the decorative sheen overlay in
          auth-visuals.module.css. Without this, that overlay (a
          radial white wash centered near the top-left, right where
          the BIENVENIDO logo sits) paints on top of everything here
          instead of behind it, since plain non-positioned children
          lose to any positioned sibling in paint order regardless of
          DOM order. */}
      <div className="relative">{children}</div>
    </div>
  );
}
