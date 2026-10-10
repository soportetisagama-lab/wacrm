import Image from 'next/image';

import styles from '@/components/auth/auth-logo-header.module.css';

// Shared header for the "form" state of each auth screen: the Sagama
// Maxi wordmark, an optional bold heading, and an optional description
// line. The wordmark plays a one-time "light scanner" entrance —
// see auth-logo-header.module.css.
export function AuthLogoHeader({
  title,
  subtitle,
}: {
  title?: string;
  subtitle?: string;
}) {
  return (
    <div className="mb-8 flex flex-col items-center gap-2 text-center">
      {/* The card's own padding (AuthCard's px-8/sm:px-12), not this
          max-w cap, is what actually bounds the rendered width today —
          352px on desktop, well under the 380px cap. A small negative
          margin lets the wordmark bleed past that padding so it can
          actually grow (~10-14%) instead of the cap silently doing
          nothing. */}
      <div
        className={`${styles.wordmark} -mx-4 w-[calc(100%+2rem)] sm:-mx-6 sm:w-[calc(100%+3rem)]`}
      >
        <Image
          src="/branding/BIENVENIDO_MAXI.png"
          alt="Bienvenido a Sagama Maxi"
          width={862}
          height={134}
          priority
          className={`${styles.wordmarkImage} h-auto w-full`}
        />
        <span className={styles.bar} aria-hidden="true" />
      </div>
      {title && (
        <h1 className="text-foreground text-lg font-semibold">{title}</h1>
      )}
      {subtitle && <p className="text-muted-foreground text-sm">{subtitle}</p>}
    </div>
  );
}
