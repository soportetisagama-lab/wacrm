// ============================================================
// "Needs the advisor's attention" fields for a conversation that was
// just handed off / (re)assigned to someone.
//
// Advisors asked that a chat derived to them behave like a new WhatsApp
// message: jump to the top of the inbox and show the unread badge.
// The inbox orders by `last_message_at` and the badge reads
// `unread_count`, so a handoff bumps the former to now and makes sure
// the latter is at least 1 (never lowers an existing count).
// ============================================================

export function attentionFields(currentUnread: number | null | undefined): {
  last_message_at: string
  unread_count: number
} {
  return {
    last_message_at: new Date().toISOString(),
    unread_count: Math.max(1, currentUnread ?? 0),
  }
}
