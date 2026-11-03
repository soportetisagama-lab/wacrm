import type { BroadcastSendStats } from '@/hooks/use-broadcast-sending'

/** Minimum processed recipients before judging the failure rate. */
const MIN_SAMPLE = 20

/**
 * Minutes left, from the pace since `startedAt` (only what was done
 * after `baseline`); null until there is a pace.
 */
export function sendEtaMinutes(stats: BroadcastSendStats, now: number): number | null {
  const done = stats.sent + stats.failed
  const doneSinceStart = done - (stats.baseline ?? 0)
  if (!stats.startedAt || doneSinceStart <= 0 || done >= stats.total) return null
  const msPerRecipient = (now - stats.startedAt) / doneSinceStart
  return Math.round(((stats.total - done) * msPerRecipient) / 60_000)
}

/** True when most of a meaningful sample is failing: something is wrong. */
export function sendLooksWrong(stats: BroadcastSendStats): boolean {
  const done = stats.sent + stats.failed
  return done >= MIN_SAMPLE && stats.failed / done > 0.5
}

/** Recipient counts read from the database while the server sends. */
export interface RecipientCounts {
  total: number
  pending: number
  failed: number
}

/**
 * Panel stats from the DB counts. The pace is measured from the first
 * reading of this page (`first`), so a resumed broadcast does not count
 * what was sent before as speed.
 */
export function liveSendStats(
  counts: RecipientCounts,
  first: { at: number; done: number } | null,
): BroadcastSendStats {
  const total = Math.max(0, counts.total)
  const failed = Math.min(Math.max(0, counts.failed), total)
  const done = Math.min(Math.max(0, total - counts.pending), total)
  return {
    total,
    sent: done - failed,
    failed,
    startedAt: first?.at ?? null,
    baseline: first?.done ?? 0,
  }
}

/** Whole-broadcast progress 0–100 from the stats. */
export function liveSendPercent(stats: BroadcastSendStats): number {
  if (stats.total <= 0) return 0
  return Math.round(((stats.sent + stats.failed) / stats.total) * 100)
}
