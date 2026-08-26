'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';

import { cn } from '@/lib/utils';
import styles from '@/components/auth/auth-visuals.module.css';

// How long the splash holds fully visible before it starts fading, and how
// long that fade transition takes — mirrors the timing of the original
// reference design (2.8s hold, 0.7s exit).
const SPLASH_HOLD_MS = 2500;
const SPLASH_EXIT_MS = 700;

export function WelcomeSplash({ onFinish }: { onFinish: () => void }) {
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    const startExit = setTimeout(() => setExiting(true), SPLASH_HOLD_MS);
    const finish = setTimeout(onFinish, SPLASH_HOLD_MS + SPLASH_EXIT_MS);
    return () => {
      clearTimeout(startExit);
      clearTimeout(finish);
    };
  }, [onFinish]);

  return (
    <div
      className={cn(
        'bg-background fixed inset-0 z-50 flex flex-col items-center justify-center overflow-hidden text-center',
        styles.splash,
        exiting && styles.splashExit
      )}
      role="status"
      aria-live="polite"
      aria-label="Cargando Sagama Inox CRM"
    >
      <div className={styles.splashBg} />
      <div className={styles.splashGlow} />

      <div className="relative z-10 flex flex-col items-center">
        <Image
          src="/branding/SAGAMA.png"
          alt="Sagama Inox"
          width={300}
          height={93}
          priority
          className={cn('h-auto w-[220px] sm:w-[280px]', styles.splashLogo)}
        />
        <div className={styles.splashLine} />
      </div>

      <div className={cn('relative z-10 mt-6 flex gap-2', styles.splashDots)}>
        <span className={styles.splashDot} />
        <span className={styles.splashDot} />
        <span className={styles.splashDot} />
      </div>
    </div>
  );
}
