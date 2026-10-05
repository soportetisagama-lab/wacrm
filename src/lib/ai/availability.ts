import { AiError } from './types'

// ============================================================
// "Sin saldo" circuit breaker for the BYO provider key.
//
// When the provider says the key can't be used at all — no credit left
// (OpenAI `insufficient_quota`, Anthropic "credit balance is too low")
// or the key was rejected — every following call would fail the same
// way. Instead of paying a round-trip per customer message, the key is
// paused for PAUSE_MS: provider adapters fail fast with a `no_credit`
// AiError, and every caller already treats a provider failure as "no
// AI" (auto-reply and collect_ai hand off to a human, the first-inbound
// classifier shows the menu). After the pause the next call is a real
// one again, so recharging the account brings the AI back on its own;
// the settings "Test key" button resumes it immediately.
//
// In-memory and per process on purpose: losing it on a restart only
// costs one more failed call to re-trip, and no migration is needed.
// ============================================================

export const AI_PAUSE_MS = 15 * 60_000

const pausedUntil = new Map<string, number>()

/** Provider errors that mean "this key won't work until a human acts"
 *  — as opposed to a timeout or a rate limit, which pass on their own. */
export function isAiOutOfServiceError(err: unknown): boolean {
  return err instanceof AiError && (err.code === 'no_credit' || err.code === 'invalid_key')
}

/** Throws the fail-fast `no_credit` error while `apiKey` is paused. */
export function assertAiKeyAvailable(apiKey: string, now: number = Date.now()): void {
  const until = pausedUntil.get(apiKey)
  if (until === undefined) return
  if (now >= until) {
    pausedUntil.delete(apiKey)
    return
  }
  throw new AiError('AI paused: the provider key has no credit or was rejected.', {
    code: 'no_credit',
  })
}

export function isAiKeyPaused(apiKey: string, now: number = Date.now()): boolean {
  const until = pausedUntil.get(apiKey)
  return until !== undefined && now < until
}

/** Record a failed provider call — pauses the key only for out-of-service errors. */
export function noteAiKeyFailure(apiKey: string, err: unknown, now: number = Date.now()): void {
  if (!isAiOutOfServiceError(err)) return
  if (!isAiKeyPaused(apiKey, now)) {
    console.error(
      `[ai availability] provider key unusable (${(err as AiError).message}) — AI paused for ${AI_PAUSE_MS / 60_000} min, continuing without AI.`,
    )
  }
  pausedUntil.set(apiKey, now + AI_PAUSE_MS)
}

/** Test-only: forget every pause (module state outlives a test). */
export function resetAiAvailability(): void {
  pausedUntil.clear()
}

/** Record a successful provider call (or a manual "Test key"). */
export function resumeAiKey(apiKey: string): void {
  if (pausedUntil.delete(apiKey)) {
    console.log('[ai availability] provider key working again — AI resumed.')
  }
}
