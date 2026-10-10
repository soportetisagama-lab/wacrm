'use client';

import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import Image from 'next/image';

import { cn } from '@/lib/utils';
import styles from '@/components/auth/auth-visuals.module.css';
import { SplashScene } from '@/components/auth/splash-scene';

const LOGO_SRC = '/branding/SAGAMA_INDUSTRIAL.png';
const LINE_NAME = 'Sagama Industrial';
// Same photo the login screen uses behind its card (AuthShell), so the
// curtain opening reveals the form on the very same background.
const BACKGROUND_SRC = '/branding/loginfondo_industrial.png';

// How long the splash holds fully visible before it starts its exit,
// and how long the exit takes (card fade 0.25s, then the 0.6s curtain
// starting 0.1s in — see .splashHalf in auth-visuals.module.css).
// Long enough for the animated scene (splash-scene.tsx) to play out.
const SPLASH_HOLD_MS = 2000;
const SPLASH_EXIT_MS = 700;
// On a cold first load the background photo and the scene's images take
// a moment to download. The hold timer only starts once both are in, so
// the scene plays complete; this cap keeps a very slow connection from
// sitting on the splash forever.
const SPLASH_MAX_WAIT_MS = 4000;

export function WelcomeSplash({ onFinish }: { onFinish: () => void }) {
  const [exiting, setExiting] = useState(false);
  const [photoReady, setPhotoReady] = useState(false);
  const [sceneReady, setSceneReady] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const ready = (photoReady && sceneReady) || timedOut;
  const handleSceneReady = useCallback(() => setSceneReady(true), []);

  useEffect(() => {
    const cap = setTimeout(() => setTimedOut(true), SPLASH_MAX_WAIT_MS);
    return () => clearTimeout(cap);
  }, []);

  // Holds the card's BIENVENIDO entrance (auth-logo-header.module.css)
  // paused while the splash covers it, so it plays as the curtain
  // opens. Layout effect so the flag is set before the first paint.
  useLayoutEffect(() => {
    if (exiting) return;
    document.documentElement.dataset.splash = 'on';
    return () => {
      delete document.documentElement.dataset.splash;
    };
  }, [exiting]);

  useEffect(() => {
    if (!ready) return;
    const startExit = setTimeout(() => setExiting(true), SPLASH_HOLD_MS);
    const finish = setTimeout(onFinish, SPLASH_HOLD_MS + SPLASH_EXIT_MS);
    return () => {
      clearTimeout(startExit);
      clearTimeout(finish);
    };
  }, [ready, onFinish]);

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
          onLoad={() => setPhotoReady(true)}
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

      <div className={cn('relative z-10', styles.splashCard, !ready && styles.splashWaiting)}>
        <SplashScene onReady={handleSceneReady} line="industrial" logoSrc={LOGO_SRC} alt={LINE_NAME} />
      </div>
    </div>
  );
}
