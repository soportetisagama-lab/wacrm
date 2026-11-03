import type { BroadcastSendStats } from '@/hooks/use-broadcast-sending'

/** Minimum processed recipients before judging the failure rate. */
const MIN_SAMPLE = 20

/** Minutes left, from the average pace so far; null until there is a pace. */
export function sendEtaMinutes(stats: BroadcastSendStats, now: number): number | null {
  const done = stats.sent + stats.failed
  if (!stats.startedAt || done === 0 || done >= stats.total) return null
  const msPerRecipient = (now - stats.startedAt) / done
  return Math.round(((stats.total - done) * msPerRecipient) / 60_000)
}

/** True when most of a meaningful sample is failing: something is wrong. */
export function sendLooksWrong(stats: BroadcastSendStats): boolean {
  const done = stats.sent + stats.failed
  return done >= MIN_SAMPLE && stats.failed / done > 0.5
}
