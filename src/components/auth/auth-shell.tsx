import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';
import { LoginBackground } from '@/components/auth/login-background';
import styles from '@/components/auth/auth-visuals.module.css';

// Shared page chrome for the three auth screens (login, signup,
// forgot-password): gradient wash + decorative background, centered
// column for the card.
export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div
      className={cn(
        'relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-10',
        styles.pageGradient
      )}
    >
      <LoginBackground />
      <div className="relative z-10 w-full max-w-md">{children}</div>
    </div>
  );
}
