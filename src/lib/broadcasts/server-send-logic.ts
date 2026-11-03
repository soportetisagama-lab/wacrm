// Pure rules of the server-side broadcast worker (server-worker.ts):
// batch selection, the send lease stored in audience_filter, and the
// final status. No I/O here so it can be unit-tested.

import { resumeFinalStatus } from '@/lib/broadcasts/send-loop'
import type { BroadcastStatus } from '@/types'

/** Recipients per batch, and pause between batches (prudent for Meta). */
export const SERVER_BATCH_SIZE = 10
export const SERVER_BATCH_PAUSE_MS = 1000

/**
 * A lease whose heartbeat is younger than this belongs to a live worker
 * (another replica, or the old container during an overlapping deploy):
 * nobody else takes the broadcast.
 */
export const LEASE_TTL_MS = 2 * 60_000
/** How often the owner renews the heartbeat (well under the TTL). */
export const LEASE_RENEW_MS = 30_000

/** Key inside broadcasts.audience_filter (no dedicated column needed). */
export const LEASE_KEY = 'sendLease'

export interface SendLease {
  /** Random id of the owning server process. */
  owner: string
  /** ISO time of the last heartbeat. */
  heartbeatAt: string
  /** ISO time the current run started. */
  startedAt: string
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

/** The lease stored in audience_filter, or null if absent / malformed. */
export function readLease(audienceFilter: unknown): SendLease | null {
  const raw = asObject(audienceFilter)[LEASE_KEY]
  if (!raw || typeof raw !== 'object') return null
  const { owner, heartbeatAt, startedAt } = raw as Record<string, unknown>
  if (typeof owner !== 'string' || !owner || typeof heartbeatAt !== 'string') return null
  return {
    owner,
    heartbeatAt,
    startedAt: typeof startedAt === 'string' ? startedAt : heartbeatAt,
  }
}

/**
 * True when another live worker holds the broadcast: the lease belongs
 * to a different owner and its heartbeat is within the TTL. A missing,
 * unparsable or expired lease, or one of our own, does not block.
 * |age| guards against a heartbeat in the future (clock skew or bad
 * data) blocking the broadcast forever.
 */
export function leaseBlocks(lease: SendLease | null, owner: string, nowMs: number): boolean {
  if (!lease || lease.owner === owner) return false
  const hb = Date.parse(lease.heartbeatAt)
  if (!Number.isFinite(hb)) return false
  return Math.abs(nowMs - hb) < LEASE_TTL_MS
}

/** audience_filter with `lease` set (other keys kept). */
export function withLease(audienceFilter: unknown, lease: SendLease): Record<string, unknown> {
  return { ...asObject(audienceFilter), [LEASE_KEY]: lease }
}

/** audience_filter without the lease (other keys kept). */
export function withoutLease(audienceFilter: unknown): Record<string, unknown> {
  const rest = { ...asObject(audienceFilter) }
  delete rest[LEASE_KEY]
  return rest
}

/**
 * Next batch from the freshly re-read 'pending' rows: skips rows this
 * run already attempted (their status update must have failed — never
 * send them twice) and takes at most `size`.
 */
export function selectBatch<T extends { id: string }>(
  pending: T[],
  attempted: ReadonlySet<string>,
  size: number = SERVER_BATCH_SIZE,
): T[] {
  return pending.filter((r) => !attempted.has(r.id)).slice(0, Math.max(0, size))
}

/** Final status: 'failed' only when nobody in the broadcast received it. */
export function finalBroadcastStatus(deliveredLikeCount: number): Extract<BroadcastStatus, 'sent' | 'failed'> {
  return resumeFinalStatus(deliveredLikeCount)
}
