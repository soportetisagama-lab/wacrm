import { cn } from '@/lib/utils';
import styles from '@/app/(auth)/login/login.module.css';

// Purely decorative backdrop for the login screen: floating brand-blue
// orbs, a drifting dot grid, and a handful of slowly spinning geometric
// outlines. No canvas/JS particle loop — everything here is CSS-driven so
// there's no animation frame loop to manage or leak.
export function LoginBackground() {
  return (
    <div
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
      aria-hidden="true"
    >
      <div className={cn(styles.orb, styles.orb1, 'bg-primary/50')} />
      <div className={cn(styles.orb, styles.orb2, 'bg-primary-hover/40')} />
      <div className={cn(styles.orb, styles.orb3, 'bg-primary/30')} />

      <div className={styles.dotGrid} />

      <div className={cn(styles.geo, styles.geo1, 'text-foreground/25')}>
        <svg width="60" height="60" viewBox="0 0 60 60" fill="none">
          <rect
            x="5"
            y="5"
            width="50"
            height="50"
            rx="10"
            stroke="currentColor"
            strokeWidth="2.5"
          />
          <rect
            x="18"
            y="18"
            width="24"
            height="24"
            rx="5"
            stroke="currentColor"
            strokeWidth="1.5"
            opacity="0.6"
          />
        </svg>
      </div>
      <div className={cn(styles.geo, styles.geo2, 'text-foreground/25')}>
        <svg width="50" height="58" viewBox="0 0 50 58" fill="none">
          <polygon
            points="25,3 47,55 3,55"
            stroke="currentColor"
            strokeWidth="2.5"
          />
        </svg>
      </div>
      <div className={cn(styles.geo, styles.geo3, 'text-foreground/25')}>
        <svg width="55" height="55" viewBox="0 0 55 55" fill="none">
          <circle
            cx="27.5"
            cy="27.5"
            r="23"
            stroke="currentColor"
            strokeWidth="2.5"
          />
          <circle
            cx="27.5"
            cy="27.5"
            r="10"
            stroke="currentColor"
            strokeWidth="1.5"
            opacity="0.6"
          />
        </svg>
      </div>
      <div className={cn(styles.geo, styles.geo4, 'text-foreground/25')}>
        <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
          <polygon
            points="24,4 44,14 44,34 24,44 4,34 4,14"
            stroke="currentColor"
            strokeWidth="2.5"
          />
        </svg>
      </div>
      <div className={cn(styles.geo, styles.geo5, 'text-foreground/25')}>
        <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
          <rect
            x="5"
            y="5"
            width="30"
            height="30"
            rx="4"
            stroke="currentColor"
            strokeWidth="2"
            transform="rotate(45 20 20)"
          />
        </svg>
      </div>
    </div>
  );
}
