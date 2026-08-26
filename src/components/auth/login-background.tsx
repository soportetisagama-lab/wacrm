import { cn } from '@/lib/utils';
import styles from '@/components/auth/auth-visuals.module.css';

// Purely decorative backdrop shared by the three auth screens: a big
// low-opacity "S" watermark, floating brand-blue orbs, a drifting dot
// grid, and a handful of slowly spinning geometric outlines. No
// canvas/JS particle loop — everything here is CSS-driven so there's
// no animation frame loop to manage or leak.
//
// The watermark is a plain bold text glyph, not the real Sagama
// isotype (we don't have that as a standalone asset yet) — swap it for
// an <Image> once an isotype-only file exists, same position/opacity.
export function LoginBackground() {
  return (
    <div
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
      aria-hidden="true"
    >
      <span
        className="text-primary/[0.07] absolute -right-[6%] -bottom-[10%] leading-none font-black select-none"
        style={{ fontSize: 'clamp(220px, 42vw, 560px)' }}
      >
        S
      </span>

      <div className={cn(styles.orb, styles.orb1, 'bg-primary/55')} />
      <div className={cn(styles.orb, styles.orb2, 'bg-primary-hover/48')} />
      <div className={cn(styles.orb, styles.orb3, 'bg-primary/38')} />

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
      <div className={cn(styles.geo, styles.geo6, 'text-foreground/15')}>
        <svg width="90" height="90" viewBox="0 0 90 90" fill="none">
          <rect
            x="10"
            y="10"
            width="70"
            height="70"
            rx="14"
            stroke="currentColor"
            strokeWidth="2"
            transform="rotate(15 45 45)"
          />
        </svg>
      </div>
      <div className={cn(styles.geo, styles.geo7, 'text-foreground/15')}>
        <svg width="80" height="80" viewBox="0 0 80 80" fill="none">
          <circle
            cx="40"
            cy="40"
            r="34"
            stroke="currentColor"
            strokeWidth="2"
          />
        </svg>
      </div>
      <div className={cn(styles.geo, styles.geo8, 'text-foreground/15')}>
        <svg width="76" height="84" viewBox="0 0 76 84" fill="none">
          <polygon
            points="38,4 70,22 70,62 38,80 6,62 6,22"
            stroke="currentColor"
            strokeWidth="2"
          />
        </svg>
      </div>
    </div>
  );
}
