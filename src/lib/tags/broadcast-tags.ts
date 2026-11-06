// ============================================================
// Difusiones-only tags (migration 091, `tags.is_broadcast`). Marketing
// puts them on the contacts that reply to a broadcast; they exist only
// inside Difusiones. RLS already hides them from non-admins; these
// helpers hide them from every other screen, admins included.
//
// Filtering happens in code (not `.eq('is_broadcast', false)`) so the
// screens keep working before 091 is applied: a row without the column
// counts as a normal tag.
// ============================================================

interface MaybeBroadcastTag {
  is_broadcast?: boolean | null;
}

/** true only for tags explicitly marked as Difusiones tags. */
export function isBroadcastTag(tag: MaybeBroadcastTag | null | undefined): boolean {
  return tag?.is_broadcast === true;
}

/** Normal (commercial/personal) tags — what every screen outside Difusiones shows. */
export function withoutBroadcastTags<T extends MaybeBroadcastTag>(
  tags: readonly T[] | null | undefined,
): T[] {
  return (tags ?? []).filter((tag) => !isBroadcastTag(tag));
}

/** Only the Difusiones tags. */
export function onlyBroadcastTags<T extends MaybeBroadcastTag>(
  tags: readonly T[] | null | undefined,
): T[] {
  return (tags ?? []).filter((tag) => isBroadcastTag(tag));
}

/**
 * Tags for the Difusiones audience step: team tags (shared, not
 * Difusiones — personal ones are per advisor, migration 069) and, in a
 * separate group, the Difusiones tags.
 */
export function groupAudienceTags<T extends MaybeBroadcastTag & { is_shared?: boolean | null }>(
  tags: readonly T[] | null | undefined,
): { team: T[]; broadcast: T[] } {
  const team: T[] = [];
  const broadcast: T[] = [];
  for (const tag of tags ?? []) {
    if (isBroadcastTag(tag)) broadcast.push(tag);
    else if (tag.is_shared !== false) team.push(tag);
  }
  return { team, broadcast };
}
