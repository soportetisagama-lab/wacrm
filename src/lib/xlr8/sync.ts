import type { SupabaseClient } from '@supabase/supabase-js';
import { withoutBroadcastTags } from '@/lib/tags/broadcast-tags';
import { metaCapiOnTagsInserted } from '@/lib/meta-capi/send';

import {
  XLR8_ESTADOS,
  XLR8_TIPOS,
  computeEstadoDiff,
  estadoKey,
  parseXlr8Response,
  phoneKey,
  type Xlr8Item,
} from './estados';
import { parseMarcaciones, planMarcaciones, type Marcacion } from './marcaciones';

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
/** Lead ids per `.in()` lookup/update (keeps the URL short). */
const LEAD_CHUNK = 200;
/** Usual window for marcaciones; the cron runs every 5 min. */
const MARCACIONES_DIAS = 2;
/** First load of an account: the whole history. */
const MARCACIONES_DIAS_HISTORICO = 3650;

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

/** GET estado_xlr9.php; `dias` limits how far back `marcaciones` go. */
async function fetchXlr8Body(
  config: { url: string; token: string; linea: string },
  dias: number,
): Promise<unknown> {
  const url = new URL(config.url);
  url.searchParams.set('linea', config.linea);
  url.searchParams.set('dias', String(dias));
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
  return body;
}

export async function syncXlr8Estados(
  admin: SupabaseClient,
  config: { url: string; token: string; linea: string },
): Promise<Xlr8SyncSummary> {
  const body = await fetchXlr8Body(config, MARCACIONES_DIAS);
  const items = parseXlr8Response(body);
  // null = the PHP doesn't send marcaciones yet: skip that part.
  const marcaciones = parseMarcaciones(body);
  // Full history, fetched at most once per run and only for an account
  // whose marcaciones_estado is still empty.
  let historico: Promise<Marcacion[] | null> | null = null;
  const loadHistorico = () =>
    (historico ??= fetchXlr8Body(config, MARCACIONES_DIAS_HISTORICO).then(parseMarcaciones));

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
    if (marcaciones) {
      // Best effort: a failure here (e.g. migration 094 not run yet)
      // never breaks the tag sync above.
      try {
        await syncMarcaciones(admin, acc.id, marcaciones, loadHistorico);
      } catch (err) {
        console.warn('[xlr8-sync] marcaciones:', err instanceof Error ? err.message : err);
      }
    }
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
    .select('*')
    .eq('account_id', accountId)
    .eq('is_shared', true)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`tags: ${error.message}`);

  const tagIdByEstado = new Map<string, string>();
  const allEstadoTagIds: string[] = [];
  const estadoKeys = new Set(defs.map((e) => estadoKey(e.name)));
  // A Difusiones tag (migration 091) is never a status tag, even when
  // marketing named it like one.
  const shared = withoutBroadcastTags(tags as { id: string; name: string; is_broadcast?: boolean }[] | null);
  for (const t of shared) {
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

  // Meta Conversions API (lib/meta-capi): QualifiedLead / OrderCreated /
  // Purchase for ad contacts that just got a type or status tag.
  // Fire-and-forget: it never throws and must never hold up the sync.
  if (diff.toInsert.length > 0) {
    const tagNameById = new Map<string, string>();
    for (const [name, id] of [...estados.tagIdByEstado, ...tipos.tagIdByEstado]) tagNameById.set(id, name);
    void metaCapiOnTagsInserted(admin, accountId, diff.toInsert, tagNameById);
  }

  return { revisados: diff.revisados, agregados, quitados, sinContacto: diff.sinContacto };
}

/**
 * Mirrors xlr8's per-lead first status change into marcaciones_estado
 * (migration 094) for "Horarios de contacto". New leads are inserted;
 * known ones only get estado_actual / asesor refreshed.
 */
async function syncMarcaciones(
  admin: SupabaseClient,
  accountId: string,
  recientes: Marcacion[],
  loadHistorico: () => Promise<Marcacion[] | null>,
): Promise<void> {
  const { count, error: countError } = await admin
    .from('marcaciones_estado')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', accountId);
  if (countError) throw new Error(`marcaciones_estado: ${countError.message}`);
  const marcaciones = (count ?? 0) === 0 ? ((await loadHistorico()) ?? recientes) : recientes;
  if (marcaciones.length === 0) return;

  const now = Date.now();
  for (let i = 0; i < marcaciones.length; i += LEAD_CHUNK) {
    const chunk = marcaciones.slice(i, i + LEAD_CHUNK);
    const { data, error } = await admin
      .from('marcaciones_estado')
      .select('lead_id, estado_actual, asesor')
      .eq('account_id', accountId)
      .in(
        'lead_id',
        chunk.map((m) => m.lead_id),
      );
    if (error) throw new Error(`marcaciones_estado: ${error.message}`);
    const existing = new Map<number, { estado_actual: string | null; asesor: string | null }>();
    for (const r of (data ?? []) as { lead_id: number | string; estado_actual: string | null; asesor: string | null }[]) {
      existing.set(Number(r.lead_id), { estado_actual: r.estado_actual, asesor: r.asesor });
    }

    const plan = planMarcaciones({ accountId, marcaciones: chunk, existing, now });
    if (plan.toInsert.length > 0) {
      const { error: insertError } = await admin
        .from('marcaciones_estado')
        .upsert(plan.toInsert, { onConflict: 'account_id,lead_id', ignoreDuplicates: true });
      if (insertError) throw new Error(`insertar marcaciones_estado: ${insertError.message}`);
    }
    for (const group of plan.toUpdate) {
      const { error: updateError } = await admin
        .from('marcaciones_estado')
        .update({ estado_actual: group.estado_actual, asesor: group.asesor })
        .eq('account_id', accountId)
        .in('lead_id', group.lead_ids);
      if (updateError) throw new Error(`actualizar marcaciones_estado: ${updateError.message}`);
    }
  }
}
