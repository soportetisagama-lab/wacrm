import type { CSSProperties } from "react";

const TINTS = 5;

/**
 * Stable per-contact avatar colors (the --avatar-N-* tokens in
 * globals.css, light and dark) so a contact is recognizable at a glance
 * in the list, the thread header and the contact panel alike.
 */
export function avatarTintStyle(seed: string | null | undefined): CSSProperties {
  let h = 0;
  for (const ch of seed ?? "") h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const n = (h % TINTS) + 1;
  return { backgroundColor: `var(--avatar-${n}-bg)`, color: `var(--avatar-${n}-fg)` };
}
