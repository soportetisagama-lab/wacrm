import type { SupabaseClient } from '@supabase/supabase-js'
import { sendPushToUser } from '@/lib/notifications/push-send'

// ============================================================
// Tell the account's admins — and nobody else — that the AI stopped
// for lack of credit. Customers only ever get the normal "un asesor te
// escribe" line and agents a neutral handoff note; the reason lives
// here (a push to owner/admin devices) and in the server log.
// ============================================================

/** At most one push per account in this window, however many
 *  messages arrive while the AI is down. */
const NOTIFY_EVERY_MS = 24 * 60 * 60_000

const lastNotifiedAt = new Map<string, number>()

/** Best-effort, never throws — callers fire and forget. */
export async function notifyAdminsAiUnavailable(
  db: SupabaseClient,
  accountId: string,
  now: number = Date.now(),
): Promise<void> {
  const last = lastNotifiedAt.get(accountId)
  if (last !== undefined && now - last < NOTIFY_EVERY_MS) return
  lastNotifiedAt.set(accountId, now)

  try {
    const { data, error } = await db
      .from('profiles')
      .select('user_id')
      .eq('account_id', accountId)
      .in('account_role', ['owner', 'admin'])
    if (error) throw error
    await Promise.all(
      (data ?? []).map((p: { user_id: string }) =>
        sendPushToUser(p.user_id, {
          title: '⚠️ IA sin saldo',
          body: 'El bot sigue atendiendo y pasa los chats a los asesores. Recarga el saldo de la IA y se reactiva sola.',
        }),
      ),
    )
  } catch (err) {
    console.error('[ai availability] admin notification failed:', err)
  }
}

/** Test-only: forget the per-account throttle. */
export function resetAiUnavailableNotifications(): void {
  lastNotifiedAt.clear()
}
