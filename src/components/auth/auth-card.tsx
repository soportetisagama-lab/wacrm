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
        'border-border/60 bg-card/90 relative overflow-hidden rounded-[32px] border px-8 py-10 shadow-2xl backdrop-blur-xl sm:px-12 sm:py-14',
        styles.cardEntrance,
        shake && styles.shake,
        className
      )}
    >
      {children}
    </div>
  );
}
