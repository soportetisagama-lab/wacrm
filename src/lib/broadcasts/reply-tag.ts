import type { SupabaseClient } from '@supabase/supabase-js';

import { chunk, fetchAllPages } from '@/lib/broadcasts/audience';
import { onlyBroadcastTags } from '@/lib/tags/broadcast-tags';

// ============================================================
// "Etiqueta para quienes respondan" (migration 090). A broadcast may
// carry `reply_tag_id`; every contact that replies gets that tag. The
// webhook tags one replier at a time, the detail page tags all the
// ones that already replied in bulk. Tag names are matched trimmed and
// case-insensitive, the same rule as the contact CSV import.
//
// Since migration 091 these are Difusiones-only tags (`is_broadcast`):
// the picker lists and reuses only those, and a new name is created as
// a shared Difusiones tag — never a commercial or personal tag, even
// when one has the same name.
// ============================================================

const DEFAULT_REPLY_TAG_COLOR = '#3b82f6';

interface NamedTag {
  id: string;
  name: string;
  is_broadcast?: boolean | null;
}

/** Trimmed name, or '' when there is nothing usable. */
export function normalizeReplyTagName(raw: string | null | undefined): string {
  return (raw ?? '').trim();
}

/** Existing tag whose name matches `raw` ignoring case/spaces, or null. */
export function findTagByName<T extends NamedTag>(tags: readonly T[], raw: string): T | null {
  const key = normalizeReplyTagName(raw).toLowerCase();
  if (!key) return null;
  return tags.find((t) => t.name.trim().toLowerCase() === key) ?? null;
}

export type ReplyTagChoice<T extends NamedTag = NamedTag> =
  | { kind: 'none' }
  | { kind: 'existing'; tag: T }
  | { kind: 'new'; name: string };

/**
 * What a typed name means: no tag, reuse an existing Difusiones tag, or
 * create one. Non-Difusiones tags in `tags` are ignored, so a name that
 * only matches a commercial tag means "create a Difusiones tag".
 */
export function classifyReplyTagName<T extends NamedTag>(
  tags: readonly T[],
  raw: string,
): ReplyTagChoice<T> {
  const name = normalizeReplyTagName(raw);
  if (!name) return { kind: 'none' };
  const tag = findTagByName(onlyBroadcastTags(tags), name);
  return tag ? { kind: 'existing', tag } : { kind: 'new', name };
}

/** Row to insert for a new Difusiones tag (shared, `is_broadcast`). */
export function newBroadcastTagRow(params: {
  accountId: string;
  userId: string;
  name: string;
  color?: string;
}) {
  return {
    user_id: params.userId,
    account_id: params.accountId,
    name: normalizeReplyTagName(params.name),
    color: params.color ?? DEFAULT_REPLY_TAG_COLOR,
    is_shared: true,
    is_broadcast: true,
  };
}

/** Unique, non-null contact ids of the rows already marked 'replied'. */
export function repliedContactIds(
  rows: readonly { contact_id: string | null; status: string }[],
): string[] {
  const out = new Set<string>();
  for (const r of rows) {
    if (r.status === 'replied' && r.contact_id) out.add(r.contact_id);
  }
  return [...out];
}

/**
 * Difusiones tag id for `name` in the account: reuses the existing
 * Difusiones tag (case insensitive) or creates a new shared one. Only
 * `is_broadcast` tags are considered. Creating needs admin (tags_insert
 * RLS, 091), which every Difusiones caller already is.
 */
export async function resolveReplyTagId(
  db: SupabaseClient,
  params: { accountId: string; userId: string; name: string },
): Promise<string> {
  const name = normalizeReplyTagName(params.name);
  if (!name) throw new Error('Falta el nombre de la etiqueta.');

  const { data: existing, error: fetchErr } = await db
    .from('tags')
    .select('id, name, is_broadcast, created_at')
    .eq('account_id', params.accountId)
    .eq('is_broadcast', true)
    .order('created_at', { ascending: true });
  if (fetchErr) throw new Error(fetchErr.message);

  const choice = classifyReplyTagName((existing ?? []) as NamedTag[], name);
  if (choice.kind === 'existing') return choice.tag.id;

  const { data: created, error: createErr } = await db
    .from('tags')
    .insert(newBroadcastTagRow({ accountId: params.accountId, userId: params.userId, name }))
    .select('id')
    .single();
  if (createErr || !created) {
    throw new Error(createErr?.message ?? `No se pudo crear la etiqueta «${name}».`);
  }
  return (created as { id: string }).id;
}

const TAG_UPSERT_CHUNK = 100;

/**
 * Puts `tagId` on every contact that already replied to the broadcast.
 * Duplicates are skipped by UNIQUE(contact_id, tag_id).
 * `replied` = contacts that replied, `tagged` = newly tagged ones.
 */
export async function tagBroadcastRepliers(
  db: SupabaseClient,
  broadcastId: string,
  tagId: string,
): Promise<{ replied: number; tagged: number }> {
  const rows = await fetchAllPages<{ contact_id: string | null; status: string }>((from, to) =>
    db
      .from('broadcast_recipients')
      .select('contact_id, status')
      .eq('broadcast_id', broadcastId)
      .eq('status', 'replied')
      .not('contact_id', 'is', null)
      .order('id', { ascending: true })
      .range(from, to),
  );
  const contactIds = repliedContactIds(rows);

  let tagged = 0;
  for (const slice of chunk(contactIds, TAG_UPSERT_CHUNK)) {
    const { data, error } = await db
      .from('contact_tags')
      .upsert(
        slice.map((contact_id) => ({ contact_id, tag_id: tagId })),
        { onConflict: 'contact_id,tag_id', ignoreDuplicates: true },
      )
      .select('id');
    if (error) throw new Error(error.message);
    // ON CONFLICT DO NOTHING returns only the rows actually inserted.
    tagged += data?.length ?? 0;
  }
  return { replied: contactIds.length, tagged };
}
