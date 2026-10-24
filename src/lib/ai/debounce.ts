import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// Per-conversation debounce shared by the general auto-reply
// (lib/ai/auto-reply.ts) and the collect_ai node (lib/flows/engine.ts):
// a burst of messages arriving seconds apart gets ONE reply covering
// all of them. Built on `conversations.ai_debounce_until` (migration
// 058) and `claim_ai_debounce_window`, the only safe way to read-and-
// extend that shared timestamp without a race between two concurrent
// webhook deliveries for the same conversation.
//
// Only the first message of a burst ("owner") waits and processes;
// every later one ("follower") just extends the window and returns —
// its row is already in `messages` when the owner reads the context.
// A follower that lands while the owner is already processing (the
// window is then the owner's processing lock) extends the lock; the
// owner notices and runs once more, so that message is never lost.
// ============================================================

/** Ventana inicial de espera tras el primer mensaje de una posible ráfaga. */
export const DEBOUNCE_WINDOW_SECONDS = 6
/** Tope duro: el owner nunca espera más que esto en total, sin importar
 *  cuántos mensajes sigan extendiendo la ventana. */
export const MAX_DEBOUNCE_WAIT_SECONDS = 15
/** Tras dejar de esperar, el owner re-extiende ai_debounce_until por esto
 *  ANTES de procesar — actúa como lock de "procesando" para que un
 *  mensaje que llegue durante la llamada al modelo no se elija como
 *  segundo owner de la misma ráfaga. */
export const PROCESSING_LOCK_SECONDS = 30
/** El sweep de /api/flows/cron solo recupera ventanas más viejas que esto —
 *  tiene que ser mayor que MAX_DEBOUNCE_WAIT_SECONDS + PROCESSING_LOCK_SECONDS
 *  para no competir con un owner que sigue vivo y trabajando normalmente. */
export const DEBOUNCE_SWEEP_GRACE_SECONDS = 90
/** Cuántas veces más procesa el owner si siguen llegando mensajes mientras
 *  responde. Pasado este tope deja la ventana puesta y el sweep la recoge. */
const MAX_RERUNS = 2

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export type DebounceClaim =
  | { role: 'owner'; waitUntil: string }
  | { role: 'follower' }
  /** The RPC failed (migration missing, grant missing…): fail OPEN —
   *  better to answer without debounce than not to answer. */
  | { role: 'unavailable' }

export async function claimDebounceWindow(
  db: SupabaseClient,
  conversationId: string,
): Promise<DebounceClaim> {
  try {
    const { data, error } = await db.rpc('claim_ai_debounce_window', {
      p_conversation_id: conversationId,
      p_window_seconds: DEBOUNCE_WINDOW_SECONDS,
    })
    if (error) {
      console.error('[ai debounce] claim_ai_debounce_window failed:', error)
      return { role: 'unavailable' }
    }
    const claim = (data as { is_owner: boolean; wait_until: string }[] | null)?.[0]
    if (!claim) return { role: 'unavailable' } // no row back — anomaly, fail open
    if (!claim.is_owner) return { role: 'follower' }
    return { role: 'owner', waitUntil: claim.wait_until }
  } catch (err) {
    console.error('[ai debounce] claim threw:', err)
    return { role: 'unavailable' }
  }
}

async function readWindow(db: SupabaseClient, conversationId: string): Promise<number | null> {
  const { data, error } = await db
    .from('conversations')
    .select('ai_debounce_until')
    .eq('id', conversationId)
    .maybeSingle()
  if (error) return null
  return data?.ai_debounce_until ? new Date(data.ai_debounce_until as string).getTime() : 0
}

/**
 * Sleep until `initialWaitUntil`, then recheck whether a follower
 * extended the window further — loop until it stabilizes or
 * `MAX_DEBOUNCE_WAIT_SECONDS` total have elapsed, whichever comes first.
 * Never throws — a read failure just ends the wait early.
 */
export async function waitForDebounceWindowToSettle(
  db: SupabaseClient,
  conversationId: string,
  initialWaitUntil: string,
): Promise<void> {
  const hardDeadline = Date.now() + MAX_DEBOUNCE_WAIT_SECONDS * 1000
  let deadline = new Date(initialWaitUntil).getTime()
  for (;;) {
    const target = Math.min(deadline, hardDeadline)
    const ms = target - Date.now()
    if (ms > 0) await sleep(ms)
    if (Date.now() >= hardDeadline) return
    let current: number | null
    try {
      current = await readWindow(db, conversationId)
    } catch {
      return
    }
    if (current === null || current <= Date.now()) return
    deadline = current
  }
}

async function setProcessingLock(db: SupabaseClient, conversationId: string): Promise<string> {
  const lockUntil = new Date(Date.now() + PROCESSING_LOCK_SECONDS * 1000).toISOString()
  await db.from('conversations').update({ ai_debounce_until: lockUntil }).eq('id', conversationId)
  return lockUntil
}

/**
 * Run `process` once per burst. Returns 'follower' when another
 * delivery owns the burst (the caller must not answer), 'done' after
 * this call processed it. `process` errors are logged, never thrown.
 */
export async function runDebounced(
  db: SupabaseClient,
  conversationId: string,
  process: () => Promise<void>,
): Promise<'follower' | 'done'> {
  const claim = await claimDebounceWindow(db, conversationId)
  if (claim.role === 'follower') return 'follower'
  if (claim.role === 'unavailable') {
    try {
      await process()
    } catch (err) {
      console.error('[ai debounce] process failed:', err)
    }
    return 'done'
  }

  let lockUntil: string | null = null
  try {
    await waitForDebounceWindowToSettle(db, conversationId, claim.waitUntil)
    for (let round = 0; ; round++) {
      lockUntil = await setProcessingLock(db, conversationId)
      await process()
      // A message that arrived while we were answering extended the lock
      // (claim_ai_debounce_window adds its window on top of it): answer
      // it too instead of clearing the window and dropping it.
      const current = await readWindow(db, conversationId).catch(() => null)
      if (!current || current <= new Date(lockUntil).getTime()) break
      if (round >= MAX_RERUNS) {
        lockUntil = null // leave it set — the cron sweep recovers it
        break
      }
      await waitForDebounceWindowToSettle(db, conversationId, new Date(current).toISOString())
    }
  } catch (err) {
    console.error('[ai debounce] debounce wrapper failed:', err)
  } finally {
    // Signal "resolved" so the cron sweep never treats a normally
    // finished window as orphaned — only while it still holds OUR lock:
    // if a message extended it in the last instant, it stays set and the
    // sweep answers it instead of it being lost.
    if (lockUntil) {
      try {
        await db
          .from('conversations')
          .update({ ai_debounce_until: null })
          .eq('id', conversationId)
          .lte('ai_debounce_until', lockUntil)
      } catch (err) {
        console.error('[ai debounce] release failed:', err)
      }
    }
  }
  return 'done'
}

export interface PendingBurst {
  /** Typed text, a menu tap, a shared location or a transcribed voice note. */
  hasText: boolean
  /** A real photo (not a sticker). */
  hasImage: boolean
}

/** Only messages this recent count as part of the burst being answered. */
const BURST_MAX_AGE_MS = 10 * 60_000

/**
 * What the customer sent since the business last wrote — the burst the
 * owner is about to answer. Returns null on any read failure (callers
 * then fall back to what they know about their own message).
 */
export async function summarizePendingBurst(
  db: SupabaseClient,
  conversationId: string,
): Promise<PendingBurst | null> {
  try {
    const { data, error } = await db
      .from('messages')
      .select('sender_type, content_type, content_text, transcript, is_sticker, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(15)
    if (error || !data) return null
    const since = Date.now() - BURST_MAX_AGE_MS
    const burst: PendingBurst = { hasText: false, hasImage: false }
    for (const m of data as {
      sender_type: string
      content_type: string
      content_text: string | null
      transcript: string | null
      is_sticker: boolean | null
      created_at: string
    }[]) {
      if (m.sender_type !== 'customer') break
      if (new Date(m.created_at).getTime() < since) break
      if (
        (m.content_type === 'text' || m.content_type === 'interactive' || m.content_type === 'location') &&
        m.content_text?.trim()
      ) {
        burst.hasText = true
      } else if (m.content_type === 'audio' && m.transcript?.trim()) {
        burst.hasText = true
      } else if (m.content_type === 'image' && !m.is_sticker) {
        burst.hasImage = true
      }
    }
    return burst
  } catch {
    return null
  }
}

/** A fixed notice older than this may be sent again. */
const REPEAT_NOTICE_WINDOW_MS = 30 * 60_000

/**
 * True when the most recent message the business sent is exactly
 * `text` (within the last 30 min) — used so a fixed notice (e.g. "Recibí tu archivo…") is sent
 * once, not again for every photo of the same batch. Fails toward
 * sending (false) on any read error.
 */
export async function lastBusinessMessageIs(
  db: SupabaseClient,
  conversationId: string,
  text: string,
): Promise<boolean> {
  try {
    const { data, error } = await db
      .from('messages')
      .select('content_text, created_at')
      .eq('conversation_id', conversationId)
      .neq('sender_type', 'customer')
      .order('created_at', { ascending: false })
      .limit(1)
    if (error || !data) return false
    const last = (data as { content_text: string | null; created_at: string }[])[0]
    if (!last || Date.now() - new Date(last.created_at).getTime() > REPEAT_NOTICE_WINDOW_MS) return false
    return last.content_text?.trim() === text.trim()
  } catch {
    return false
  }
}
