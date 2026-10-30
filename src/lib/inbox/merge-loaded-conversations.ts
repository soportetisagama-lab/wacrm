import type { Conversation } from "@/types";

const time = (iso: string | null | undefined): number => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(ms) ? 0 : ms;
};

/**
 * Is the row on screen newer than the one the list just read? The read takes
 * several requests, so a row may be old by the time it arrives.
 *
 * `updated_at` decides: the database sets it on every UPDATE (trigger
 * set_updated_at, migration 001) and realtime UPDATEs bring it. A new message
 * patches the local preview before its conversation UPDATE lands, without
 * touching `updated_at`, so on a tie the later `last_message_at` wins.
 */
function isLocalNewer(local: Conversation, loaded: Conversation): boolean {
  const localUpdated = time(local.updated_at);
  const loadedUpdated = time(loaded.updated_at);
  if (localUpdated !== loadedUpdated) return localUpdated > loadedUpdated;
  return time(local.last_message_at) > time(loaded.last_message_at);
}

/**
 * Combines a finished list read with what happened on screen meanwhile:
 * - in both: the newer row (see isLocalNewer).
 * - only on screen, and it appeared after the read started: kept, the read may
 *   have passed its place already.
 * - only on screen, and it was there before the read started: dropped, it was
 *   deleted or is no longer visible to this user.
 * - the chat open by its own assigned agent stays at 0 unread, same rule as the
 *   realtime handler: the reset to 0 may be newer than the row read.
 */
export function mergeLoadedConversations(args: {
  local: Conversation[];
  loaded: Conversation[];
  /** Ids on screen when the read started. */
  knownAtStart: ReadonlySet<string>;
  activeConversationId: string | null;
  viewerId: string | null | undefined;
}): Conversation[] {
  const { local, loaded, knownAtStart, activeConversationId, viewerId } = args;
  const localById = new Map(local.map((c) => [c.id, c]));
  const loadedIds = new Set(loaded.map((c) => c.id));

  const merged = loaded.map((row) => {
    const current = localById.get(row.id);
    if (!current) return row;
    return isLocalNewer(current, row)
      ? { ...current, contact: current.contact ?? row.contact }
      : { ...row, contact: row.contact ?? current.contact };
  });
  const appeared = local.filter((c) => !loadedIds.has(c.id) && !knownAtStart.has(c.id));

  return [...appeared, ...merged].map((c) =>
    c.id === activeConversationId &&
    !!viewerId &&
    c.assigned_agent_id === viewerId &&
    c.unread_count !== 0
      ? { ...c, unread_count: 0 }
      : c,
  );
}
