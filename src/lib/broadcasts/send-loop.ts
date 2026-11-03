import type { BroadcastStatus, MessageTemplate, RecipientStatus } from '@/types'

/** Image/video/document headers need a media URL on every send. */
export function isMediaHeaderType(headerType: MessageTemplate['header_type'] | null | undefined): boolean {
  return headerType === 'image' || headerType === 'video' || headerType === 'document'
}

/**
 * Keeps only the batch members whose current DB status is still
 * 'pending'. Rows missing from `statusById` (deleted, or not visible)
 * are dropped too: when in doubt, do not send twice.
 */
export function filterStillPending<T extends { id: string }>(
  batch: T[],
  statusById: Map<string, RecipientStatus | string>,
): T[] {
  return batch.filter((r) => statusById.get(r.id) === 'pending')
}

/** Progress bar value for the send phase: `base` + share of `span`. */
export function sendPhaseProgress(base: number, span: number, done: number, total: number): number {
  if (total <= 0) return base + span
  return base + Math.round((Math.min(done, total) / total) * span)
}

/** Live counters after a batch. Skipped recipients leave the total. */
export function loopCounters(
  totalAll: number,
  processed: number,
  failed: number,
  skipped: number,
): { total: number; sent: number; failed: number } {
  return { total: totalAll - skipped, sent: processed - failed - skipped, failed }
}

/**
 * Final status after a resume: 'failed' only when no recipient of the
 * whole broadcast got the message (none left in a delivered-ish state).
 */
export function resumeFinalStatus(deliveredLikeCount: number): Extract<BroadcastStatus, 'sent' | 'failed'> {
  return deliveredLikeCount > 0 ? 'sent' : 'failed'
}

/** Recipient statuses that mean the message left WhatsApp's side OK. */
export const DELIVERED_LIKE_STATUSES: readonly RecipientStatus[] = ['sent', 'delivered', 'read', 'replied']

/** http(s) URL check used for header media. */
export function isValidHttpUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/** Why a media header URL can't be used yet (null when it is fine). */
export function headerMediaProblem(isMediaHeader: boolean, url: string): 'missing' | 'invalid' | null {
  if (!isMediaHeader) return null
  const value = url.trim()
  if (!value) return 'missing'
  if (!isValidHttpUrl(value)) return 'invalid'
  return null
}

/** URL saved with the broadcast (audience_filter.headerMediaUrl), if any. */
export function storedHeaderMediaUrl(audienceFilter: unknown): string | null {
  if (!audienceFilter || typeof audienceFilter !== 'object') return null
  const v = (audienceFilter as Record<string, unknown>).headerMediaUrl
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/**
 * Header media for a resume, in priority order: what the user typed in
 * the resume dialog, the URL saved with the broadcast, the template's
 * stored URL. Null when none exists (the dialog must ask for it).
 */
export function pickResumeHeaderMediaUrl(
  override: string | null | undefined,
  stored: string | null | undefined,
  templateUrl: string | null | undefined,
): string | null {
  for (const v of [override, stored, templateUrl]) {
    const t = v?.trim()
    if (t) return t
  }
  return null
}
