import type { SupabaseClient } from '@supabase/supabase-js';

import {
  XLR8_ESTADOS,
  XLR8_TIPOS,
  computeEstadoDiff,
  estadoKey,
  parseXlr8Response,
  phoneKey,
  type Xlr8Item,
} from './estados';

// ============================================================
// Mirrors each phone's xlr8 status and type as shared contact tags (see
// ./estados.ts). Runs from the flows cron (every 5 min) and from
// POST /api/xlr8/sync (on demand, min 30 s apart). Which line to read
// comes from XLR8_LINEA, so the same code serves all 5 lines.
// ============================================================

export interface Xlr8SyncSummary {
  revisados: number;
  agregados: number;
  quitados: number;
  sinContacto: number;
}

const FETCH_TIMEOUT_MS = 20_000;
const PAGE_SIZE = 1000;
const INSERT_CHUNK = 500;
const DELETE_CHUNK = 200;

interface Xlr8SyncState {
  running: Promise<Xlr8SyncSummary | null> | null;
  lastStartedAt: number;
  lastSummary: Xlr8SyncSummary | null;
  warnedMissingEnv: boolean;
}

// globalThis: the cron route and the manual route are bundled separately
// but share the Node process (same trick as lib/cron/internal.ts).
const g = globalThis as { __wacrmXlr8Sync?: Xlr8SyncState };
function state(): Xlr8SyncState {
  g.__wacrmXlr8Sync ??= {
    running: null,
    lastStartedAt: 0,
    lastSummary: null,
    warnedMissingEnv: false,
  };
  return g.__wacrmXlr8Sync;
}

function readConfig(): { url: string; token: string; linea: string } | null {
  const url = process.env.XLR8_ESTADOS_URL?.trim();
  const token = process.env.XLR8_TOKEN?.trim();
  const linea = process.env.XLR8_LINEA?.trim().toUpperCase();
  if (!url || !token || !linea) return null;
  return { url, token, linea };
}

export function isXlr8SyncConfigured(): boolean {
  return readConfig() !== null;
}

export type Xlr8SyncResult =
  | { status: 'ok'; summary: Xlr8SyncSummary }
  | { status: 'throttled'; summary: Xlr8SyncSummary | null }
  | { status: 'disabled' }
  | { status: 'error' };

/**
 * Runs the sync unless one started less than `minIntervalMs` ago. A run
 * already in flight is joined instead of starting a second one. Never
 * throws — failures are logged and reported as `error`.
 */
export async function runXlr8SyncIfDue(
  admin: SupabaseClient,
  minIntervalMs: number,
): Promise<Xlr8SyncResult> {
  const config = readConfig();
  const s = state();
  if (!config) {
    if (!s.warnedMissingEnv) {
      s.warnedMissingEnv = true;
      console.warn(
        '[xlr8-sync] XLR8_ESTADOS_URL / XLR8_TOKEN / XLR8_LINEA not set — status sync disabled.',
      );
    }
    return { status: 'disabled' };
  }

  if (s.running) {
    const summary = await s.running;
    return summary ? { status: 'ok', summary } : { status: 'error' };
  }
  if (Date.now() - s.lastStartedAt < minIntervalMs) {
    return { status: 'throttled', summary: s.lastSummary };
  }

  s.lastStartedAt = Date.now();
  s.running = syncXlr8Estados(admin, config)
    .then((summary) => {
      s.lastSummary = summary;
      if (summary.agregados || summary.quitados) {
        console.log('[xlr8-sync] done:', JSON.stringify(summary));
      }
      return summary;
    })
    .catch((err: unknown) => {
      console.error('[xlr8-sync] failed:', err instanceof Error ? err.message : err);
      return null;
    })
    .finally(() => {
      s.running = null;
    });

  const summary = await s.running;
  return summary ? { status: 'ok', summary } : { status: 'error' };
}

async function fetchXlr8Items(config: { url: string; token: string; linea: string }): Promise<Xlr8Item[]> {
  const url = new URL(config.url);
  url.searchParams.set('linea', config.linea);
  const res = await fetch(url, {
    headers: { 'X-Xlr9-Token': config.token, Accept: 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`xlr8 respondió HTTP ${res.status}`);
  const body: unknown = await res.json();
  const linea = (body as { linea?: unknown } | null)?.linea;
  if (typeof linea === 'string' && linea.toUpperCase() !== config.linea) {
    throw new Error(`xlr8 devolvió la línea ${linea}, se esperaba ${config.linea}`);
  }
  return parseXlr8Response(body);
}

export async function syncXlr8Estados(
  admin: SupabaseClient,
  config: { url: string; token: string; linea: string },
): Promise<Xlr8SyncSummary> {
  const items = await fetchXlr8Items(config);

  const { data: accounts, error } = await admin.from('accounts').select('id, owner_user_id');
  if (error) throw new Error(`accounts: ${error.message}`);

  const total: Xlr8SyncSummary = { revisados: 0, agregados: 0, quitados: 0, sinContacto: 0 };
  for (const acc of (accounts ?? []) as { id: string; owner_user_id: string }[]) {
    // An account without contacts has nothing to sync. Creating the status
    // tags there would also make a fresh signup account look "used", and
    // accept_invitation then refuses to move that user into a team.
    if (!(await hasContacts(admin, acc.id))) continue;
    const r = await syncAccount(admin, acc.id, acc.owner_user_id, items);
    total.revisados += r.revisados;
    total.agregados += r.agregados;
    total.quitados += r.quitados;
    total.sinContacto += r.sinContacto;
  }
  return total;
}

async function hasContacts(admin: SupabaseClient, accountId: string): Promise<boolean> {
  const { count, error } = await admin
    .from('contacts')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', accountId);
  if (error) throw new Error(`contacts: ${error.message}`);
  return (count ?? 0) > 0;
}

/** Shared tags of the account for `defs`, creating the missing ones (owner as author). */
async function ensureEstadoTags(
  admin: SupabaseClient,
  accountId: string,
  ownerUserId: string,
  defs: ReadonlyArray<{ name: string; color: string }>,
): Promise<{ tagIdByEstado: Map<string, string>; allEstadoTagIds: string[] }> {
  const { data: tags, error } = await admin
    .from('tags')
    .select('id, name, created_at')
    .eq('account_id', accountId)
    .eq('is_shared', true)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`tags: ${error.message}`);

  const tagIdByEstado = new Map<string, string>();
  const allEstadoTagIds: string[] = [];
  const estadoKeys = new Set(defs.map((e) => estadoKey(e.name)));
  for (const t of (tags ?? []) as { id: string; name: string }[]) {
    const key = estadoKey(t.name);
    if (!estadoKeys.has(key)) continue;
    // Duplicated names: the oldest is the one assigned; the rest still
    // count as status tags so they get cleaned off contacts.
    allEstadoTagIds.push(t.id);
    if (!tagIdByEstado.has(key)) tagIdByEstado.set(key, t.id);
  }

  const missing = defs.filter((e) => !tagIdByEstado.has(estadoKey(e.name)));
  if (missing.length > 0) {
    const { data: created, error: createError } = await admin
      .from('tags')
      .insert(
        missing.map((e) => ({
          user_id: ownerUserId,
          account_id: accountId,
          name: e.name,
          color: e.color,
          is_shared: true,
        })),
      )
      .select('id, name');
    if (createError) throw new Error(`crear tags: ${createError.message}`);
    for (const t of (created ?? []) as { id: string; name: string }[]) {
      tagIdByEstado.set(estadoKey(t.name), t.id);
      allEstadoTagIds.push(t.id);
    }
  }

  return { tagIdByEstado, allEstadoTagIds };
}

async function loadContactsByPhone(
  admin: SupabaseClient,
  accountId: string,
): Promise<Map<string, string[]>> {
  const byPhone = new Map<string, string[]>();
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await admin
      .from('contacts')
      .select('id, phone')
      .eq('account_id', accountId)
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`contacts: ${error.message}`);
    const rows = (data ?? []) as { id: string; phone: string | null }[];
    for (const c of rows) {
      const key = phoneKey(c.phone);
      if (!key) continue;
      const list = byPhone.get(key);
      if (list) list.push(c.id);
      else byPhone.set(key, [c.id]);
    }
    if (rows.length < PAGE_SIZE) break;
  }
  return byPhone;
}

async function loadEstadoRows(
  admin: SupabaseClient,
  tagIds: string[],
): Promise<{ id: string; contact_id: string; tag_id: string }[]> {
  const out: { id: string; contact_id: string; tag_id: string }[] = [];
  if (tagIds.length === 0) return out;
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await admin
      .from('contact_tags')
      .select('id, contact_id, tag_id')
      .in('tag_id', tagIds)
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`contact_tags: ${error.message}`);
    const rows = (data ?? []) as { id: string; contact_id: string; tag_id: string }[];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return out;
}

async function syncAccount(
  admin: SupabaseClient,
  accountId: string,
  ownerUserId: string,
  items: Xlr8Item[],
): Promise<Xlr8SyncSummary> {
  const estados = await ensureEstadoTags(admin, accountId, ownerUserId, XLR8_ESTADOS);
  const tipos = await ensureEstadoTags(admin, accountId, ownerUserId, XLR8_TIPOS);
  const contactsByPhone = await loadContactsByPhone(admin, accountId);
  const currentRows = await loadEstadoRows(admin, [
    ...estados.allEstadoTagIds,
    ...tipos.allEstadoTagIds,
  ]);
  const tipoTagIds = new Set(tipos.allEstadoTagIds);

  const estadoDiff = computeEstadoDiff({
    items,
    contactsByPhone,
    tagIdByEstado: estados.tagIdByEstado,
    currentRows: currentRows.filter((r) => !tipoTagIds.has(r.tag_id)),
  });
  const tipoDiff = computeEstadoDiff({
    items,
    contactsByPhone,
    tagIdByEstado: tipos.tagIdByEstado,
    field: 'tipo',
    currentRows: currentRows.filter((r) => tipoTagIds.has(r.tag_id)),
  });
  const diff = {
    ...estadoDiff,
    toInsert: [...estadoDiff.toInsert, ...tipoDiff.toInsert],
    toDelete: [...estadoDiff.toDelete, ...tipoDiff.toDelete],
  };

  // Delete first so a contact never shows two statuses for long.
  let quitados = 0;
  for (let i = 0; i < diff.toDelete.length; i += DELETE_CHUNK) {
    const chunk = diff.toDelete.slice(i, i + DELETE_CHUNK);
    const { error } = await admin.from('contact_tags').delete().in('id', chunk);
    if (error) throw new Error(`borrar contact_tags: ${error.message}`);
    quitados += chunk.length;
  }

  let agregados = 0;
  for (let i = 0; i < diff.toInsert.length; i += INSERT_CHUNK) {
    const chunk = diff.toInsert.slice(i, i + INSERT_CHUNK);
    const { error } = await admin
      .from('contact_tags')
      .upsert(chunk, { onConflict: 'contact_id,tag_id', ignoreDuplicates: true });
    if (error) throw new Error(`insertar contact_tags: ${error.message}`);
    agregados += chunk.length;
  }

  return { revisados: diff.revisados, agregados, quitados, sinContacto: diff.sinContacto };
}
