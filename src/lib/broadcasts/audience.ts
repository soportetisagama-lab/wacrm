import type { SupabaseClient } from '@supabase/supabase-js';

// ============================================================
// Paged reads for broadcast audiences. PostgREST caps every select at
// 1000 rows by default, and a long `.in('id', [...])` blows past URL
// limits — so a broadcast to thousands of contacts must page reads with
// .range() and chunk id lists. Shared by the send hook and the wizard's
// audience estimates so both count the same contacts.
// ============================================================

export const PAGE_SIZE = 1000;
/** UUIDs per `.in()` filter — ~7 KB of URL, safely under proxy limits. */
export const ID_CHUNK = 200;

interface PageResult<T> {
  data: T[] | null;
  error: { message: string } | null;
}

/**
 * Calls `page(from, to)` until a short page comes back. The query must
 * have a stable `.order()` (usually by id) or rows can repeat/skip.
 */
export async function fetchAllPages<T>(
  page: (from: number, to: number) => PromiseLike<PageResult<T>>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return out;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Unique ids of the contacts carrying any of `tagIds`. */
export async function fetchTaggedContactIds(
  supabase: SupabaseClient,
  tagIds: string[],
): Promise<Set<string>> {
  if (tagIds.length === 0) return new Set();
  const rows = await fetchAllPages<{ contact_id: string }>((from, to) =>
    supabase
      .from('contact_tags')
      .select('contact_id')
      .in('tag_id', tagIds)
      .order('id', { ascending: true })
      .range(from, to),
  );
  return new Set(rows.map((r) => r.contact_id));
}

export type CustomFieldOperator = 'is' | 'is_not' | 'contains';

/** Unique ids of the contacts matching a custom-field rule. */
export async function fetchCustomFieldContactIds(
  supabase: SupabaseClient,
  filter: { fieldId: string; operator: CustomFieldOperator; value: string },
): Promise<Set<string>> {
  const { fieldId, operator, value } = filter;
  const rows = await fetchAllPages<{ contact_id: string }>((from, to) => {
    let q = supabase
      .from('contact_custom_values')
      .select('contact_id')
      .eq('custom_field_id', fieldId);
    if (operator === 'is') q = q.eq('value', value);
    else if (operator === 'is_not') q = q.neq('value', value);
    else q = q.ilike('value', `%${value}%`);
    return q.order('id', { ascending: true }).range(from, to);
  });
  return new Set(rows.map((r) => r.contact_id));
}

export interface EstimateAudience {
  type: string;
  tagIds?: string[];
  customField?: { fieldId: string; operator: CustomFieldOperator; value: string };
  csvContacts?: unknown[];
  excludeTagIds?: string[];
}

/**
 * Unique contacts the audience reaches, exclusions applied. `null` when
 * the audience isn't fully configured yet.
 */
export async function estimateAudienceCount(
  supabase: SupabaseClient,
  audience: EstimateAudience,
): Promise<number | null> {
  if (audience.type === 'csv') {
    return audience.csvContacts?.length ? audience.csvContacts.length : null;
  }

  let baseIds: Set<string> | null = null; // null = all contacts
  if (audience.type === 'tags') {
    if (!audience.tagIds?.length) return null;
    baseIds = await fetchTaggedContactIds(supabase, audience.tagIds);
  } else if (audience.type === 'custom_field') {
    if (!audience.customField?.fieldId || !audience.customField.value) return null;
    baseIds = await fetchCustomFieldContactIds(supabase, audience.customField);
  } else if (audience.type !== 'all') {
    return null;
  }

  const excluded = audience.excludeTagIds?.length
    ? await fetchTaggedContactIds(supabase, audience.excludeTagIds)
    : null;

  if (baseIds) {
    if (!excluded) return baseIds.size;
    let n = 0;
    for (const id of baseIds) if (!excluded.has(id)) n += 1;
    return n;
  }

  const { count, error } = await supabase
    .from('contacts')
    .select('id', { count: 'exact', head: true });
  if (error) throw new Error(error.message);
  // Every excluded id is itself an account contact, so this is exact.
  return Math.max(0, (count ?? 0) - (excluded?.size ?? 0));
}
