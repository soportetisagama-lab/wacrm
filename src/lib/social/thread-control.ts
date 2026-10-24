// ============================================================
// Who controls a Messenger / Instagram thread (handover protocol /
// conversation routing). When a customer's message reaches us as
// `standby`, another app (Meta's inbox, Meta Business AI…) owns the
// thread and our Send API calls would be refused, so the next send
// takes thread control first.
//
// In memory on purpose: the webhook and the bot's reply run in the same
// process, seconds apart. If the mark is lost (restart), the send still
// recovers through the thread-control error retry in send.ts.
// ============================================================

import type { SocialChannel } from '@/lib/channels/types'

const STANDBY_TTL_MS = 24 * 60 * 60 * 1000
const standbyAt = new Map<string, number>()

function key(channel: SocialChannel, userId: string) {
  return `${channel}:${userId}`
}

/** Record whether the person's latest message arrived as standby. */
export function noteInboundControl(channel: SocialChannel, userId: string, standby: boolean): void {
  if (standby) standbyAt.set(key(channel, userId), Date.now())
  else standbyAt.delete(key(channel, userId))
}

/** True when the person's latest message arrived as standby (and not long ago). */
export function lastInboundWasStandby(channel: SocialChannel, userId: string): boolean {
  const at = standbyAt.get(key(channel, userId))
  if (at === undefined) return false
  if (Date.now() - at > STANDBY_TTL_MS) {
    standbyAt.delete(key(channel, userId))
    return false
  }
  return true
}

/** We own the thread now. */
export function clearStandby(channel: SocialChannel, userId: string): void {
  standbyAt.delete(key(channel, userId))
}
