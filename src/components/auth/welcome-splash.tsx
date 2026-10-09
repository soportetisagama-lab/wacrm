'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';

import { cn } from '@/lib/utils';
import styles from '@/components/auth/auth-visuals.module.css';

const LOGO_SRC = '/branding/SAGAMA_CASTOR.png';
const LINE_NAME = 'Sagama Castor';
// Same photo the login screen uses behind its card (AuthShell), so the
// curtain opening reveals the form on the very same background.
const BACKGROUND_SRC = '/branding/loginfondo_castor.png';

// How long the splash holds fully visible before it starts its exit,
// and how long the exit takes (card fade 0.35s, then the 0.9s curtain
// starting 0.15s in — see .splashHalf in auth-visuals.module.css).
const SPLASH_HOLD_MS = 2500;
const SPLASH_EXIT_MS = 1050;

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

  const half = (position: string) => (
    <div className={cn(styles.splashHalf, position)} aria-hidden="true">
      <div className={styles.splashPhoto}>
        <Image
          src={BACKGROUND_SRC}
          alt=""
          fill
          priority
          sizes="100vw"
          className="object-cover object-center"
        />
      </div>
      <div className={styles.splashTint} />
    </div>
  );

  return (
    <div
      className={cn(
        'fixed inset-0 z-50 flex items-center justify-center overflow-hidden px-6',
        exiting && styles.splashExit
      )}
      role="status"
      aria-live="polite"
      aria-label={`Cargando ${LINE_NAME} CRM`}
    >
      {half(styles.splashHalfTop)}
      {half(styles.splashHalfBottom)}

      <div className={cn('relative z-10', styles.splashCard)}>
        <Image
          src={LOGO_SRC}
          alt={LINE_NAME}
          width={300}
          height={93}
          priority
          className="h-auto w-[200px] sm:w-[260px]"
        />
      </div>
    </div>
  );
}
