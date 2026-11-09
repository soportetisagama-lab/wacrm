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

// ── First-contact date range ─────────────────────────────────────
// `contacts.created_at` is when the contact first reached us (the
// webhook creates the row on the first inbound message). The wizard
// picks plain days (YYYY-MM-DD) in Lima time; "to" includes that whole
// day. Peru has no DST, so Lima is always UTC-05:00.

const LIMA_OFFSET = '-05:00';
const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface CreatedDateRange {
  /** First day included (YYYY-MM-DD, Lima). */
  createdFrom?: string;
  /** Last day included (YYYY-MM-DD, Lima). */
  createdTo?: string;
}

/** Epoch ms of a Lima midnight, or null if not a valid day. */
function limaDayStart(day: string | undefined): number | null {
  if (!day || !DAY_RE.test(day)) return null;
  const ms = Date.parse(`${day}T00:00:00${LIMA_OFFSET}`);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * UTC bounds for `created_at`: `gte` inclusive, `lt` exclusive (the
 * Lima midnight after `createdTo`). Missing/invalid days are open ends;
 * `null` when no bound is set at all.
 */
export function createdAtBounds(
  range: CreatedDateRange,
): { gte?: string; lt?: string } | null {
  const from = limaDayStart(range.createdFrom);
  const to = limaDayStart(range.createdTo);
  if (from === null && to === null) return null;
  return {
    ...(from !== null ? { gte: new Date(from).toISOString() } : {}),
    ...(to !== null ? { lt: new Date(to + DAY_MS).toISOString() } : {}),
  };
}

/** True when both days are set and "from" is after "to". */
export function isCreatedRangeInverted(range: CreatedDateRange): boolean {
  const from = limaDayStart(range.createdFrom);
  const to = limaDayStart(range.createdTo);
  return from !== null && to !== null && from > to;
}

/** Whether `createdAt` falls inside the bounds (no bounds = always). */
export function isCreatedWithin(
  createdAt: string | null | undefined,
  bounds: { gte?: string; lt?: string } | null,
): boolean {
  if (!bounds) return true;
  const ms = createdAt ? Date.parse(createdAt) : NaN;
  if (Number.isNaN(ms)) return false;
  if (bounds.gte && ms < Date.parse(bounds.gte)) return false;
  if (bounds.lt && ms >= Date.parse(bounds.lt)) return false;
  return true;
}

/** Ids of the contacts first seen inside `bounds`. */
export async function fetchContactIdsCreatedWithin(
  supabase: SupabaseClient,
  bounds: { gte?: string; lt?: string },
): Promise<Set<string>> {
  const rows = await fetchAllPages<{ id: string }>((from, to) => {
    let q = supabase.from('contacts').select('id');
    if (bounds.gte) q = q.gte('created_at', bounds.gte);
    if (bounds.lt) q = q.lt('created_at', bounds.lt);
    return q.order('id', { ascending: true }).range(from, to);
  });
  return new Set(rows.map((r) => r.id));
}

export interface EstimateAudience extends CreatedDateRange {
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

  // Optional first-contact range (not for CSV, handled above).
  if (isCreatedRangeInverted(audience)) return null;
  const bounds = createdAtBounds(audience);

  const excluded = audience.excludeTagIds?.length
    ? await fetchTaggedContactIds(supabase, audience.excludeTagIds)
    : null;

  if (bounds && (baseIds || excluded)) {
    const inRange = await fetchContactIdsCreatedWithin(supabase, bounds);
    let n = 0;
    for (const id of baseIds ?? inRange) {
      if (inRange.has(id) && !excluded?.has(id)) n += 1;
    }
    return n;
  }

  if (baseIds) {
    if (!excluded) return baseIds.size;
    let n = 0;
    for (const id of baseIds) if (!excluded.has(id)) n += 1;
    return n;
  }

  let countQuery = supabase.from('contacts').select('id', { count: 'exact', head: true });
  if (bounds?.gte) countQuery = countQuery.gte('created_at', bounds.gte);
  if (bounds?.lt) countQuery = countQuery.lt('created_at', bounds.lt);
  const { count, error } = await countQuery;
  if (error) throw new Error(error.message);
  // Every excluded id is itself an account contact, so this is exact
  // (with a date range and exclusions we took the branch above).
  return Math.max(0, (count ?? 0) - (excluded?.size ?? 0));
}
