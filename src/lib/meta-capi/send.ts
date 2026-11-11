import type { SupabaseClient } from '@supabase/supabase-js';

import { supabaseAdmin } from '@/lib/flows/admin-client';
import { decrypt } from '@/lib/whatsapp/encryption';

import { buildEventId } from './event-id';
import {
  MAX_EVENT_AGE_MS,
  buildEventPayload,
  buttonMetaEvent,
  clampEventTime,
  cotizacionesUrlFromEnv,
  datasetCreateBody,
  datasetNameFromEnv,
  datasetRenameNeeded,
  decideAwaitingPurchase,
  dedupKeyFor,
  eventsForTag,
  nextRetryDelayMs,
  parseQualifiedTags,
  parseCotizacionesResponse,
  parseVentasResponse,
  isPurchaseCovered,
  isUnsendablePurchase,
  pickCotizacion,
  pickVenta,
  purchaseCoveringVenta,
  purchaseValueDeadline,
  type MetaCapiEventName,
  type Xlr8Cotizacion,
  type Xlr8Venta,
} from './events';

// ============================================================
// Meta Conversions API for Business Messaging — I/O.
//
// Every entry point here is best-effort and NEVER throws: a failure is
// stored on the meta_capi_events row (migration 093) and retried by
// runMetaCapiSweepIfDue (flows cron). Nothing here may block the
// webhook or the xlr8 sync.
//
// Per-line config lives only in env:
//   META_CAPI_ENABLED=true        master switch (anything else → off)
//   META_CAPI_QUALIFIED_TAGS=...  type tags that mean QualifiedLead
//   XLR8_VENTAS_URL=...           ventas_xlr9.php (Purchase value)
//   XLR8_COTIZACIONES_URL=...     cotizaciones_xlr9.php (InitiateCheckout);
//                                 default: XLR8_VENTAS_URL's folder
//   META_CAPI_DATASET_NAME=...    dataset name, e.g. "XLR9 Inox" (optional)
// Logs never carry tokens, phone numbers or ctwa_clid values.
// ============================================================

// Same Graph version the rest of the project uses (lib/whatsapp/meta-api.ts).
const GRAPH_BASE = 'https://graph.facebook.com/v21.0';
const FETCH_TIMEOUT_MS = 15_000;
const CONFIG_TTL_MS = 10 * 60_000;
const VENTAS_TTL_MS = 5 * 60_000;
const SWEEP_EVERY_MS = 5 * 60_000;
/** Safety net for a send that died mid-flight: the sweep picks it up after this. */
const PENDING_GRACE_MS = 2 * 60_000;
/** A pending row with neither next_attempt_at nor awaiting_value_until for this long is stuck. */
const STALE_PENDING_MS = 10 * 60_000;
const REFERRAL_LOOKBACK_DAYS = 90;
const CHUNK = 200;

export function isMetaCapiEnabled(): boolean {
  return process.env.META_CAPI_ENABLED?.trim().toLowerCase() === 'true';
}

function qualifiedTags(): Set<string> {
  return parseQualifiedTags(process.env.META_CAPI_QUALIFIED_TAGS);
}

function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

// ------------------------------------------------------------
// Process-wide state (cron and webhook share the Node process)
// ------------------------------------------------------------

interface LineConfig {
  wabaId: string;
  accessToken: string;
  datasetId: string;
}

interface CapiState {
  configs: Map<string, { at: number; config: LineConfig | null }>;
  ventas: { at: number; items: Xlr8Venta[] | null } | null;
  cotizaciones: { at: number; items: Xlr8Cotizacion[] | null } | null;
  sweepRunning: boolean;
  lastSweepAt: number;
}

const g = globalThis as { __wacrmMetaCapi?: CapiState };
function state(): CapiState {
  g.__wacrmMetaCapi ??= { configs: new Map(), ventas: null, cotizaciones: null, sweepRunning: false, lastSweepAt: 0 };
  return g.__wacrmMetaCapi;
}

// ------------------------------------------------------------
// Dataset (get or create from the line's WABA)
// ------------------------------------------------------------

async function graphFetch(path: string, accessToken: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // non-JSON body
  }
  if (!res.ok) {
    const msg = (body as { error?: { message?: string } } | null)?.error?.message;
    throw new Error(`Meta HTTP ${res.status}${msg ? `: ${msg}` : ''}`);
  }
  return body;
}

function datasetOf(body: unknown): { id: string; name: string | null } | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { id?: unknown; name?: unknown; data?: Array<{ id?: unknown; name?: unknown }> };
  const hit = typeof b.id === 'string' && b.id ? b : Array.isArray(b.data) ? b.data[0] : null;
  if (!hit || typeof hit.id !== 'string' || !hit.id) return null;
  return { id: hit.id, name: typeof hit.name === 'string' ? hit.name : null };
}

/** Best-effort rename; a failure is only a warning and never blocks events. */
async function renameDataset(datasetId: string, name: string, accessToken: string): Promise<void> {
  try {
    await graphFetch(`/${datasetId}`, accessToken, { method: 'POST', body: JSON.stringify({ name }) });
  } catch (err) {
    console.warn('[meta-capi] no se pudo poner nombre al dataset:', errText(err));
  }
}

async function ensureDataset(wabaId: string, accessToken: string): Promise<string> {
  const name = datasetNameFromEnv(process.env.META_CAPI_DATASET_NAME);
  const existing = datasetOf(await graphFetch(`/${wabaId}/dataset`, accessToken));
  if (existing) {
    if (datasetRenameNeeded(existing.name, name)) await renameDataset(existing.id, name!, accessToken);
    return existing.id;
  }
  let created: { id: string; name: string | null } | null = null;
  let namedOnCreate = false;
  const body = datasetCreateBody(name);
  if (body) {
    try {
      created = datasetOf(await graphFetch(`/${wabaId}/dataset`, accessToken, { method: 'POST', body: JSON.stringify(body) }));
      namedOnCreate = Boolean(created);
    } catch (err) {
      // Meta may not take a name on create: retry without it, rename after.
      console.warn('[meta-capi] crear dataset con nombre falló, se crea sin nombre:', errText(err));
    }
  }
  created ??= datasetOf(await graphFetch(`/${wabaId}/dataset`, accessToken, { method: 'POST' }));
  if (!created) throw new Error('Meta no devolvió el id del dataset');
  if (!namedOnCreate && datasetRenameNeeded(created.name, name)) await renameDataset(created.id, name!, accessToken);
  return created.id;
}

async function loadLineConfig(admin: SupabaseClient, accountId: string): Promise<LineConfig | null> {
  const s = state();
  const cached = s.configs.get(accountId);
  if (cached && Date.now() - cached.at < CONFIG_TTL_MS) return cached.config;

  const { data, error } = await admin
    .from('whatsapp_config')
    .select('id, waba_id, access_token, meta_capi_dataset_id')
    .eq('account_id', accountId)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`whatsapp_config: ${error.message}`);
  const row = data as
    | { id: string; waba_id: string | null; access_token: string | null; meta_capi_dataset_id: string | null }
    | null;
  if (!row?.waba_id || !row.access_token) {
    s.configs.set(accountId, { at: Date.now(), config: null });
    return null;
  }
  const accessToken = decrypt(row.access_token);
  let datasetId = row.meta_capi_dataset_id;
  if (!datasetId) {
    datasetId = await ensureDataset(row.waba_id, accessToken);
    const { error: upErr } = await admin
      .from('whatsapp_config')
      .update({ meta_capi_dataset_id: datasetId })
      .eq('id', row.id);
    if (upErr) console.error('[meta-capi] no se pudo guardar el dataset:', upErr.message);
    else console.log('[meta-capi] dataset listo para la cuenta', accountId);
  }
  const config = { wabaId: row.waba_id, accessToken, datasetId };
  s.configs.set(accountId, { at: Date.now(), config });
  return config;
}

// ------------------------------------------------------------
// XLR8 sales (monto_venta), optional
// ------------------------------------------------------------

function ventasConfigured(): boolean {
  return Boolean(
    process.env.XLR8_VENTAS_URL?.trim() && process.env.XLR8_TOKEN?.trim() && process.env.XLR8_LINEA?.trim(),
  );
}

/** null = feed not configured or the fetch failed (see ventasConfigured). */
async function loadVentas(): Promise<Xlr8Venta[] | null> {
  const url = process.env.XLR8_VENTAS_URL?.trim();
  const token = process.env.XLR8_TOKEN?.trim();
  const linea = process.env.XLR8_LINEA?.trim().toUpperCase();
  if (!url || !token || !linea) return null;
  const s = state();
  if (s.ventas && Date.now() - s.ventas.at < VENTAS_TTL_MS) return s.ventas.items;
  let items: Xlr8Venta[] | null = null;
  try {
    const u = new URL(url);
    u.searchParams.set('linea', linea);
    const res = await fetch(u, {
      headers: { 'X-Xlr9-Token': token, Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`ventas respondió HTTP ${res.status}`);
    items = parseVentasResponse(await res.json());
  } catch (err) {
    console.error('[meta-capi] lectura de ventas falló:', errText(err));
  }
  s.ventas = { at: Date.now(), items };
  return items;
}

/** null = feed not configured or the fetch failed. Same token and line as the sales feed. */
async function loadCotizaciones(): Promise<Xlr8Cotizacion[] | null> {
  const url = cotizacionesUrlFromEnv(process.env.XLR8_COTIZACIONES_URL, process.env.XLR8_VENTAS_URL);
  const token = process.env.XLR8_TOKEN?.trim();
  const linea = process.env.XLR8_LINEA?.trim().toUpperCase();
  if (!url || !token || !linea) return null;
  const s = state();
  if (s.cotizaciones && Date.now() - s.cotizaciones.at < VENTAS_TTL_MS) return s.cotizaciones.items;
  let items: Xlr8Cotizacion[] | null = null;
  try {
    const u = new URL(url);
    u.searchParams.set('linea', linea);
    const res = await fetch(u, {
      headers: { 'X-Xlr9-Token': token, Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`cotizaciones respondió HTTP ${res.status}`);
    items = parseCotizacionesResponse(await res.json());
  } catch (err) {
    console.error('[meta-capi] lectura de cotizaciones falló:', errText(err));
  }
  s.cotizaciones = { at: Date.now(), items };
  return items;
}

function phoneKey(phone: string | null | undefined): string {
  const digits = (phone ?? '').replace(/\D/g, '');
  return digits.length === 9 ? `51${digits}` : digits;
}

// ------------------------------------------------------------
// Rows: record once, send, retry
// ------------------------------------------------------------

interface EventRow {
  id: string;
  account_id: string;
  contact_id: string;
  event_name: MetaCapiEventName;
  event_id: string;
  ctwa_clid: string | null;
  /** NUMERIC comes back from PostgREST as number or string. */
  value: number | string | null;
  currency: string | null;
  event_time: string;
  status: 'pending' | 'sent' | 'failed' | 'skipped';
  attempts: number;
}

const ROW_COLUMNS =
  'id, account_id, contact_id, event_name, event_id, ctwa_clid, value, currency, event_time, status, attempts';

const NO_CLID_ERROR = 'sin ctwa_clid (no llegó desde un anuncio)';

/** Status update of one row; a DB error is logged (never thrown) so the caller goes on. */
async function updateRow(admin: SupabaseClient, id: string, patch: Record<string, unknown>): Promise<boolean> {
  const { error } = await admin.from('meta_capi_events').update(patch).eq('id', id);
  if (error) {
    console.error('[meta-capi] no se pudo actualizar el evento', id, ':', error.message);
    return false;
  }
  return true;
}

async function latestCtwaClid(admin: SupabaseClient, accountId: string, contactId: string): Promise<string | null> {
  const { data, error } = await admin
    .from('conversation_referrals')
    .select('ctwa_clid')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .not('ctwa_clid', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`conversation_referrals: ${error.message}`);
  const v = (data as { ctwa_clid?: string | null } | null)?.ctwa_clid;
  return v && v.trim() ? v.trim() : null;
}

interface RecordArgs {
  accountId: string;
  contactId: string;
  eventName: MetaCapiEventName;
  dedupKey: string;
  source: 'message' | 'tag' | 'quote' | 'button' | 'venta';
  eventTime: Date;
  ctwaClid: string | null;
  buttonReplyId?: string | null;
  projectId?: string | null;
  value?: number | null;
  /** Store a 'skipped' row when there is no ctwa_clid (button taps). */
  recordSkipped?: boolean;
  /**
   * Purchase waiting for its amount: stored as pending, not sent now;
   * resolveAwaitingPurchases (cron) sends it, at the latest at this time.
   */
  awaitValueUntil?: Date | null;
}

/**
 * Inserts the row unless (contact, dedup key) already exists, then sends
 * it. A 'skipped' row (no ctwa_clid back then) is upgraded and sent once
 * the contact does carry a ctwa_clid.
 */
async function recordAndSend(admin: SupabaseClient, args: RecordArgs): Promise<void> {
  const eventTime = clampEventTime(args.eventTime);
  if (!eventTime) return; // older than Meta's 7-day window
  if (!args.ctwaClid && !args.recordSkipped) return;

  const status = args.ctwaClid ? 'pending' : 'skipped';
  const row = {
    account_id: args.accountId,
    contact_id: args.contactId,
    event_name: args.eventName,
    dedup_key: args.dedupKey,
    event_id: buildEventId(args.accountId, args.contactId, args.dedupKey),
    source: args.source,
    button_reply_id: args.buttonReplyId ?? null,
    project_id: args.projectId ?? null,
    ctwa_clid: args.ctwaClid,
    value: args.value ?? null,
    currency: args.value ? 'PEN' : null,
    event_time: eventTime.toISOString(),
    status,
    error: args.ctwaClid ? null : NO_CLID_ERROR,
    next_attempt_at:
      args.ctwaClid && !args.awaitValueUntil ? new Date(Date.now() + PENDING_GRACE_MS).toISOString() : null,
    awaiting_value_until: args.ctwaClid && args.awaitValueUntil ? args.awaitValueUntil.toISOString() : null,
  };

  const { data: inserted, error } = await admin
    .from('meta_capi_events')
    .upsert(row, { onConflict: 'contact_id,dedup_key', ignoreDuplicates: true })
    .select(ROW_COLUMNS);
  if (error) {
    // 23505 on the per-account project index (migration 093): that sale's
    // Purchase already exists for another contact with the same phone.
    if (error.code === '23505') return;
    throw new Error(`meta_capi_events: ${error.message}`);
  }

  let toSend = ((inserted ?? []) as EventRow[])[0] ?? null;
  if (!toSend && args.ctwaClid) {
    // Already there: only a row skipped for lack of ctwa_clid gets a second
    // chance. A row skipped for another reason ('sin monto', 'misma venta')
    // stays skipped: reviving it left it pending with no schedule, stuck.
    const { data: upgraded, error: upErr } = await admin
      .from('meta_capi_events')
      .update({
        status: 'pending',
        ctwa_clid: args.ctwaClid,
        source: args.source,
        button_reply_id: args.buttonReplyId ?? null,
        event_time: eventTime.toISOString(),
        error: null,
        next_attempt_at: row.next_attempt_at,
        awaiting_value_until: row.awaiting_value_until,
      })
      .eq('contact_id', args.contactId)
      .eq('dedup_key', args.dedupKey)
      .eq('status', 'skipped')
      .is('ctwa_clid', null)
      .select(ROW_COLUMNS);
    if (upErr) throw new Error(`meta_capi_events: ${upErr.message}`);
    toSend = ((upgraded ?? []) as EventRow[])[0] ?? null;
  }
  if (toSend && toSend.status === 'pending' && !row.awaiting_value_until) await sendRow(admin, toSend);
}

async function sendRow(admin: SupabaseClient, row: EventRow): Promise<void> {
  const attempts = row.attempts + 1;
  // Meta requires value + currency on Purchase: without an amount it is
  // never sent (no retries). Covers the 48 h deadline, no sales feed and
  // a "Compra realizada" button.
  if (isUnsendablePurchase(row.event_name, row.value)) {
    await updateRow(admin, row.id, {
      status: 'skipped',
      error: 'sin monto',
      next_attempt_at: null,
      awaiting_value_until: null,
    });
    return;
  }
  try {
    if (!row.ctwa_clid) throw new Error('sin ctwa_clid');
    if (Date.now() - new Date(row.event_time).getTime() > MAX_EVENT_AGE_MS) {
      await updateRow(admin, row.id, {
        status: 'failed',
        attempts,
        error: 'evento con más de 7 días; Meta ya no lo acepta',
        next_attempt_at: null,
        awaiting_value_until: null,
      });
      return;
    }
    const config = await loadLineConfig(admin, row.account_id);
    if (!config) throw new Error('la cuenta no tiene WABA id o token de WhatsApp');
    const payload = buildEventPayload({
      eventName: row.event_name,
      eventTime: new Date(row.event_time),
      eventId: row.event_id,
      wabaId: config.wabaId,
      ctwaClid: row.ctwa_clid,
      value: row.value == null ? null : Number(row.value),
      currency: row.currency,
    });
    const response = await graphFetch(`/${config.datasetId}/events`, config.accessToken, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    // Outside the catch on purpose: a failed write must not mark a delivered
    // event as failed. The row keeps its due next_attempt_at; a resend is
    // harmless (Meta deduplicates by event_id).
    await updateRow(admin, row.id, {
      status: 'sent',
      attempts,
      response: response as Record<string, unknown> | null,
      error: null,
      sent_at: new Date().toISOString(),
      next_attempt_at: null,
      awaiting_value_until: null,
    });
  } catch (err) {
    const delay = nextRetryDelayMs(attempts);
    const message = errText(err);
    console.error(`[meta-capi] ${row.event_name} falló (intento ${attempts}):`, message);
    await updateRow(admin, row.id, {
      status: 'failed',
      attempts,
      error: message,
      next_attempt_at: delay == null ? null : new Date(Date.now() + delay).toISOString(),
      awaiting_value_until: null,
    });
  }
}

function guard(label: string, fn: () => Promise<void>): Promise<void> {
  if (!isMetaCapiEnabled()) return Promise.resolve();
  return fn().catch((err: unknown) => {
    console.error(`[meta-capi] ${label}:`, errText(err));
  });
}

// ------------------------------------------------------------
// Entry points
// ------------------------------------------------------------

/**
 * Customer tapped a button / list row. If the interactive message it
 * answers configured "Enviar señal a Meta" on that option, send it.
 * `parentMessageId` = our messages.id of the replied message, when known;
 * otherwise the latest outbound interactive message offering `replyId`.
 */
export function metaCapiOnButtonTap(args: {
  accountId: string;
  contactId: string;
  conversationId: string;
  parentMessageId: string | null;
  replyId: string;
  at: Date;
}): Promise<void> {
  return guard('botón', async () => {
    if (!args.replyId) return;
    const admin = supabaseAdmin();
    let query = admin
      .from('messages')
      .select('interactive_payload')
      .eq('conversation_id', args.conversationId)
      .eq('content_type', 'interactive')
      .neq('sender_type', 'customer');
    query = args.parentMessageId
      ? query.eq('id', args.parentMessageId)
      : query.order('created_at', { ascending: false }).limit(5);
    const { data, error } = await query;
    if (error) throw new Error(`messages: ${error.message}`);
    let eventName: MetaCapiEventName | null = null;
    for (const m of (data ?? []) as { interactive_payload: unknown }[]) {
      eventName = buttonMetaEvent(m.interactive_payload, args.replyId);
      if (eventName) break;
    }
    if (!eventName) return;
    const ctwaClid = await latestCtwaClid(admin, args.accountId, args.contactId);
    await recordAndSend(admin, {
      accountId: args.accountId,
      contactId: args.contactId,
      eventName,
      dedupKey: dedupKeyFor(eventName),
      source: 'button',
      eventTime: args.at,
      ctwaClid,
      buttonReplyId: args.replyId,
      recordSkipped: true,
    });
  });
}

async function adContacts(
  admin: SupabaseClient,
  accountId: string,
  contactIds?: string[],
): Promise<Map<string, string>> {
  const since = new Date(Date.now() - REFERRAL_LOOKBACK_DAYS * 86_400_000).toISOString();
  const out = new Map<string, string>();
  const lists = contactIds ? chunk(contactIds, CHUNK) : [null];
  for (const ids of lists) {
    for (let from = 0; ; from += 1000) {
      let q = admin
        .from('conversation_referrals')
        .select('contact_id, ctwa_clid, created_at')
        .eq('account_id', accountId)
        .not('ctwa_clid', 'is', null)
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .range(from, from + 999);
      if (ids) q = q.in('contact_id', ids);
      const { data, error } = await q;
      if (error) throw new Error(`conversation_referrals: ${error.message}`);
      const rows = (data ?? []) as { contact_id: string; ctwa_clid: string | null }[];
      for (const r of rows) {
        // Newest first: keep the latest click per contact.
        if (r.ctwa_clid && !out.has(r.contact_id)) out.set(r.contact_id, r.ctwa_clid);
      }
      if (rows.length < 1000) break;
    }
  }
  return out;
}

function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

async function contactPhones(admin: SupabaseClient, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const part of chunk(ids, CHUNK)) {
    const { data, error } = await admin.from('contacts').select('id, phone').in('id', part);
    if (error) throw new Error(`contacts: ${error.message}`);
    for (const c of (data ?? []) as { id: string; phone: string | null }[]) {
      const k = phoneKey(c.phone);
      if (k) out.set(c.id, k);
    }
  }
  return out;
}

interface PurchaseRef {
  id: string;
  projectId: string | null;
  createdAt: Date;
  /** The closure it reports (CERRADO time or sale date). */
  eventTime: Date;
}

/** Non-skipped Purchase rows per contact (sent, waiting or retrying). */
async function purchaseRows(admin: SupabaseClient, contactIds: string[]): Promise<Map<string, PurchaseRef[]>> {
  const out = new Map<string, PurchaseRef[]>();
  for (const part of chunk(contactIds, CHUNK)) {
    const { data, error } = await admin
      .from('meta_capi_events')
      .select('id, contact_id, project_id, created_at, event_time')
      .eq('event_name', 'Purchase')
      .neq('status', 'skipped')
      .in('contact_id', part);
    if (error) throw new Error(`meta_capi_events: ${error.message}`);
    for (const r of (data ?? []) as {
      id: string;
      contact_id: string;
      project_id: string | null;
      created_at: string;
      event_time: string;
    }[]) {
      const list = out.get(r.contact_id) ?? [];
      list.push({
        id: r.id,
        projectId: r.project_id,
        createdAt: new Date(r.created_at),
        eventTime: new Date(r.event_time),
      });
      out.set(r.contact_id, list);
    }
  }
  return out;
}

/**
 * A Purchase recorded without project turned out to be this sale: tie the
 * project to it (no resend; event_id is kept) so later sweeps see the sale
 * as reported. A clash on the per-project index means another row already
 * has it: nothing else to do either way.
 */
async function adoptProject(admin: SupabaseClient, ref: PurchaseRef, projectId: string): Promise<void> {
  const { error } = await admin
    .from('meta_capi_events')
    .update({ project_id: projectId, dedup_key: dedupKeyFor('Purchase', { projectId }) })
    .eq('id', ref.id)
    .is('project_id', null);
  if (error && error.code !== '23505') {
    console.error('[meta-capi] no se pudo asignar el proyecto al Purchase', ref.id, ':', error.message);
    return;
  }
  ref.projectId = projectId;
}

/**
 * Tags just put on contacts (xlr8 sync, an admin by hand, the sweep).
 * Only ad contacts (with ctwa_clid) produce anything. A tag may fire
 * several events (e.g. CERRADO → LeadSubmitted + Purchase); `events`,
 * when given, limits them to those (the sweep passes the ones not yet
 * recorded).
 */
async function handleTagsAdded(
  admin: SupabaseClient,
  accountId: string,
  added: ReadonlyArray<{ contact_id: string; tag_name: string; at?: Date; events?: MetaCapiEventName[] }>,
): Promise<void> {
  const qualified = qualifiedTags();
  const wanted = added.flatMap((a) =>
    (a.events ?? eventsForTag(a.tag_name, qualified)).map((event) => ({
      contact_id: a.contact_id,
      tag_name: a.tag_name,
      at: a.at,
      event,
    })),
  );
  if (wanted.length === 0) return;

  const clids = await adContacts(admin, accountId, [...new Set(wanted.map((w) => w.contact_id))]);
  const relevant = wanted.filter((w) => clids.has(w.contact_id));
  if (relevant.length === 0) return;

  const buyers = [...new Set(relevant.filter((w) => w.event === 'Purchase').map((w) => w.contact_id))];
  const ventas = buyers.length ? await loadVentas() : null;
  const phones = buyers.length && ventas ? await contactPhones(admin, buyers) : new Map<string, string>();
  const purchases = buyers.length ? await purchaseRows(admin, buyers) : new Map<string, PurchaseRef[]>();

  for (const w of relevant) {
    const ctwaClid = clids.get(w.contact_id)!;
    const closedAt = w.at ?? new Date();
    let dedupKey = dedupKeyFor(w.event);
    let projectId: string | null = null;
    let value: number | null = null;
    let awaitValueUntil: Date | null = null;
    if (w.event === 'Purchase') {
      const sent = purchases.get(w.contact_id) ?? [];
      const phone = phones.get(w.contact_id);
      const mine = ventas && phone ? ventas.filter((v) => v.celular === phone) : [];
      // The sale's window is measured from the closure (tag time), not now.
      const venta = pickVenta(
        mine,
        new Set(sent.map((s) => s.projectId).filter((p): p is string => !!p)),
        closedAt,
      );
      // Same sale already reported by a Purchase without project (e.g. sent
      // before the sale showed up): never a second one, just tie the project.
      const covering = venta ? purchaseCoveringVenta(venta, sent) : null;
      if (venta && covering) {
        await adoptProject(admin, covering, venta.projectId);
        continue;
      }
      if (venta && venta.monto != null) {
        projectId = venta.projectId;
        value = venta.monto;
        dedupKey = dedupKeyFor('Purchase', { projectId });
      } else if (sent.length > 0) {
        continue; // this sale was already reported (or is already waiting)
      } else if (ventasConfigured()) {
        // No amount yet: wait for it in the cron sweep (max 48 h, inside
        // Meta's 7 days). Never sent without it (skipped 'sin monto').
        const deadline = purchaseValueDeadline(closedAt);
        // Backfilled tag whose wait already ran out: the sale was looked up
        // above, so with the feed read there is nothing left to wait for and
        // sendRow skips it now. Feed unreadable → keep waiting for it.
        awaitValueUntil = deadline.getTime() > Date.now() || ventas === null ? deadline : null;
      }
    }
    try {
      await recordAndSend(admin, {
        accountId,
        contactId: w.contact_id,
        eventName: w.event,
        dedupKey,
        source: 'tag',
        eventTime: closedAt,
        ctwaClid,
        projectId,
        value,
        awaitValueUntil,
      });
    } catch (err) {
      console.error(`[meta-capi] ${w.event} por etiqueta:`, errText(err));
    }
  }
}

/** Hook for the xlr8 sync: contact_tags rows it just inserted. Never throws. */
export function metaCapiOnTagsInserted(
  admin: SupabaseClient,
  accountId: string,
  rows: ReadonlyArray<{ contact_id: string; tag_id: string }>,
  tagNameById: ReadonlyMap<string, string>,
): Promise<void> {
  return guard('etiquetas', async () => {
    const added = rows
      .map((r) => ({ contact_id: r.contact_id, tag_name: tagNameById.get(r.tag_id) ?? '' }))
      .filter((r) => r.tag_name);
    await handleTagsAdded(admin, accountId, added);
  });
}

// ------------------------------------------------------------
// Sweep (flows cron, every 5 min): retries, hand-added tags, sales
// ------------------------------------------------------------

/**
 * Safety net: a 'pending' row with neither next_attempt_at nor
 * awaiting_value_until is reached by nothing. After STALE_PENDING_MS it is
 * made due now, so sendRow decides (send, skip 'sin monto', or 'failed'
 * when older than 7 days).
 */
async function rescheduleStuckPending(admin: SupabaseClient): Promise<void> {
  const nowIso = new Date().toISOString();
  const { data, error } = await admin
    .from('meta_capi_events')
    .update({ next_attempt_at: nowIso })
    .eq('status', 'pending')
    .is('next_attempt_at', null)
    .is('awaiting_value_until', null)
    .lt('updated_at', new Date(Date.now() - STALE_PENDING_MS).toISOString())
    .select('id');
  if (error) throw new Error(`meta_capi_events: ${error.message}`);
  const n = (data ?? []).length;
  if (n) console.warn(`[meta-capi] ${n} evento(s) pendiente(s) sin programar; se reintentan ahora`);
}

async function retryDue(admin: SupabaseClient): Promise<void> {
  const { data, error } = await admin
    .from('meta_capi_events')
    .select(ROW_COLUMNS)
    .in('status', ['pending', 'failed'])
    .not('next_attempt_at', 'is', null)
    .lte('next_attempt_at', new Date().toISOString())
    .order('next_attempt_at', { ascending: true })
    .limit(50);
  if (error) throw new Error(`meta_capi_events: ${error.message}`);
  for (const row of (data ?? []) as EventRow[]) await sendRow(admin, row);
}

/**
 * Purchases waiting for their amount (status pending + awaiting_value_until):
 * with the sale's monto → sent with value (and its project_id); feed off,
 * or deadline reached → sent without value. Otherwise they keep waiting.
 */
async function resolveAwaitingPurchases(admin: SupabaseClient): Promise<void> {
  const { data, error } = await admin
    .from('meta_capi_events')
    .select(`${ROW_COLUMNS}, project_id, awaiting_value_until`)
    .eq('status', 'pending')
    .not('awaiting_value_until', 'is', null)
    .order('awaiting_value_until', { ascending: true })
    .limit(200);
  if (error) throw new Error(`meta_capi_events: ${error.message}`);
  const rows = (data ?? []) as (EventRow & { awaiting_value_until: string })[];
  if (rows.length === 0) return;

  const configured = ventasConfigured();
  const ventas = configured ? await loadVentas() : null;
  const ids = [...new Set(rows.map((r) => r.contact_id))];
  const phones = ventas ? await contactPhones(admin, ids) : new Map<string, string>();
  // Always loaded: a waiting row may be covered by another Purchase.
  const purchases = await purchaseRows(admin, ids);

  for (const row of rows) {
    try {
      const phone = phones.get(row.contact_id);
      const ownProject = (row as EventRow & { project_id?: string | null }).project_id ?? null;
      // Sync and cron can both see one closure: a waiting row without
      // project yields to any other recent Purchase of the contact.
      if (!ownProject && isPurchaseCovered(row.id, purchases.get(row.contact_id) ?? [])) {
        await updateRow(admin, row.id, {
          status: 'skipped',
          error: 'misma venta ya registrada',
          awaiting_value_until: null,
          next_attempt_at: null,
        });
        continue;
      }
      let venta: Xlr8Venta | null = null;
      if (ventas && ownProject) {
        // Already tied to a project (from the sales feed): wait for its amount.
        venta = ventas.find((v) => v.projectId === ownProject) ?? null;
      } else if (ventas && phone) {
        const sentProjects = new Set(
          (purchases.get(row.contact_id) ?? []).map((p) => p.projectId).filter((p): p is string => !!p),
        );
        // Window measured from the closure (the row's event_time), not now.
        venta = pickVenta(ventas.filter((v) => v.celular === phone), sentProjects, new Date(row.event_time));
      }
      // Feed configured but unreadable this sweep: keep waiting while Meta
      // would still take the event, instead of giving up without a lookup.
      if (configured && !ventas && Date.now() - new Date(row.event_time).getTime() < MAX_EVENT_AGE_MS) continue;
      const decision = decideAwaitingPurchase({
        venta,
        ventasConfigured: configured,
        deadline: new Date(row.awaiting_value_until),
      });
      if (decision === 'wait') continue;

      // Leaves the wait with a due next_attempt_at: if sendRow below dies,
      // retryDue picks the row up instead of it staying pending forever.
      const patch: Record<string, unknown> = { awaiting_value_until: null, next_attempt_at: new Date().toISOString() };
      if (venta) {
        const dedupKey = dedupKeyFor('Purchase', { projectId: venta.projectId });
        patch.dedup_key = dedupKey;
        patch.event_id = buildEventId(row.account_id, row.contact_id, dedupKey);
        patch.project_id = venta.projectId;
        if (decision === 'with_value') {
          patch.value = venta.monto;
          patch.currency = 'PEN';
        }
      }
      const { data: updated, error: upErr } = await admin
        .from('meta_capi_events')
        .update(patch)
        .eq('id', row.id)
        .eq('status', 'pending')
        .select(ROW_COLUMNS);
      if (upErr) {
        // 23505: that project's Purchase already exists → this one is redundant.
        if (upErr.code === '23505') {
          const { error: delErr } = await admin.from('meta_capi_events').delete().eq('id', row.id);
          if (delErr) console.error('[meta-capi] no se pudo borrar el Purchase repetido', row.id, ':', delErr.message);
          continue;
        }
        throw new Error(`meta_capi_events: ${upErr.message}`);
      }
      const toSend = ((updated ?? []) as EventRow[])[0];
      if (toSend) await sendRow(admin, toSend);
    } catch (err) {
      console.error('[meta-capi] Purchase en espera:', errText(err));
    }
  }
}

/**
 * InitiateCheckout from xlr8 quotations: for each ad contact whose phone has
 * a quotation dated inside Meta's 7 days, the oldest one goes out with its
 * amount (PEN) and date. Only one per contact (dedup key 'InitiateCheckout':
 * a contact that already has that row, in any status, gets nothing more),
 * and one per xlr8 project in the account (two contacts with the same phone
 * do not report the same quotation twice).
 */
async function sweepCotizaciones(
  admin: SupabaseClient,
  accountId: string,
  clids: ReadonlyMap<string, string>,
  ids: string[],
): Promise<void> {
  const cotizaciones = await loadCotizaciones();
  if (!cotizaciones?.length) return;
  const recent = cotizaciones.filter((c) => clampEventTime(c.fecha) !== null);
  if (!recent.length) return;

  const phones = await contactPhones(admin, ids);
  const quotedPhones = new Set(recent.map((c) => c.celular));
  const candidates = ids.filter((id) => quotedPhones.has(phones.get(id) ?? ''));
  if (!candidates.length) return;

  const withRow = new Set<string>();
  for (const part of chunk(candidates, CHUNK)) {
    const { data, error } = await admin
      .from('meta_capi_events')
      .select('contact_id')
      .eq('event_name', 'InitiateCheckout')
      .in('contact_id', part);
    if (error) throw new Error(`meta_capi_events: ${error.message}`);
    for (const r of (data ?? []) as { contact_id: string }[]) withRow.add(r.contact_id);
  }
  const todo = candidates.filter((id) => !withRow.has(id));
  if (!todo.length) return;

  // Projects already reported by an InitiateCheckout of this account.
  const reported = new Set<string>();
  for (const part of chunk([...new Set(recent.map((c) => c.projectId))], CHUNK)) {
    const { data, error } = await admin
      .from('meta_capi_events')
      .select('project_id')
      .eq('account_id', accountId)
      .eq('event_name', 'InitiateCheckout')
      .in('project_id', part);
    if (error) throw new Error(`meta_capi_events: ${error.message}`);
    for (const r of (data ?? []) as { project_id: string | null }[]) if (r.project_id) reported.add(r.project_id);
  }

  for (const contactId of todo) {
    const phone = phones.get(contactId)!;
    const cot = pickCotizacion(
      recent.filter((c) => c.celular === phone),
      reported,
    );
    if (!cot) continue;
    try {
      await recordAndSend(admin, {
        accountId,
        contactId,
        eventName: 'InitiateCheckout',
        dedupKey: dedupKeyFor('InitiateCheckout'),
        source: 'quote',
        eventTime: cot.fecha,
        ctwaClid: clids.get(contactId)!,
        projectId: cot.projectId,
        value: cot.monto,
      });
      reported.add(cot.projectId);
    } catch (err) {
      console.error('[meta-capi] InitiateCheckout por cotización:', errText(err));
    }
  }
}

async function sweepAccount(admin: SupabaseClient, accountId: string): Promise<void> {
  const clids = await adContacts(admin, accountId);
  if (clids.size === 0) return;
  const ids = [...clids.keys()];
  const since = new Date(Date.now() - MAX_EVENT_AGE_MS).toISOString();

  // Tags put by hand (or by anything else) in the last 7 days.
  const added: { contact_id: string; tag_name: string; at: Date }[] = [];
  for (const part of chunk(ids, CHUNK)) {
    const { data, error } = await admin
      .from('contact_tags')
      .select('contact_id, created_at, tags!inner(name, is_shared, is_broadcast)')
      .in('contact_id', part)
      .gte('created_at', since);
    if (error) throw new Error(`contact_tags: ${error.message}`);
    for (const r of (data ?? []) as unknown as {
      contact_id: string;
      created_at: string | null;
      tags: { name: string; is_shared: boolean | null; is_broadcast?: boolean | null } | null;
    }[]) {
      if (!r.tags || r.tags.is_shared === false || r.tags.is_broadcast === true) continue;
      added.push({ contact_id: r.contact_id, tag_name: r.tags.name, at: new Date(r.created_at ?? Date.now()) });
    }
  }
  if (added.length) {
    // Skip what is already recorded, so the sweep stays cheap.
    const done = new Set<string>();
    for (const part of chunk(ids, CHUNK)) {
      const { data, error } = await admin
        .from('meta_capi_events')
        .select('contact_id, event_name')
        .in('contact_id', part)
        .neq('status', 'skipped');
      if (error) throw new Error(`meta_capi_events: ${error.message}`);
      for (const r of (data ?? []) as { contact_id: string; event_name: string }[]) {
        done.add(`${r.contact_id}:${r.event_name}`);
      }
    }
    const qualified = qualifiedTags();
    const todo = added
      .map((a) => ({
        ...a,
        events: eventsForTag(a.tag_name, qualified).filter((ev) => !done.has(`${a.contact_id}:${ev}`)),
      }))
      .filter((a) => a.events.length > 0);
    await handleTagsAdded(admin, accountId, todo);
  }

  // First xlr8 quotation (with its amount) → InitiateCheckout, once per
  // contact. A failure here must not stop the sales pass below.
  try {
    await sweepCotizaciones(admin, accountId, clids, ids);
  } catch (err) {
    console.error('[meta-capi] InitiateCheckout por cotización:', errText(err));
  }

  // Sales closed in xlr8 in the last 7 days → one Purchase per project.
  const ventas = await loadVentas();
  if (!ventas?.length) return;
  const recent = ventas.filter((v) => v.fecha && Date.now() - v.fecha.getTime() < MAX_EVENT_AGE_MS);
  if (!recent.length) return;
  const phones = await contactPhones(admin, ids);
  const byPhone = new Map<string, string[]>();
  for (const [cid, p] of phones) byPhone.set(p, [...(byPhone.get(p) ?? []), cid]);
  const buyers = [...new Set(recent.flatMap((v) => byPhone.get(v.celular) ?? []))];
  if (!buyers.length) return;
  const purchases = await purchaseRows(admin, buyers);
  for (const v of recent) {
    for (const contactId of byPhone.get(v.celular) ?? []) {
      const sent = purchases.get(contactId) ?? [];
      if (sent.some((s) => s.projectId === v.projectId)) continue;
      // A Purchase without project already covers this contact's sale:
      // tie the project to it when it is this very closure.
      if (sent.some((s) => !s.projectId)) {
        const covering = purchaseCoveringVenta(v, sent);
        if (covering) await adoptProject(admin, covering, v.projectId);
        continue;
      }
      try {
        const eventTime = v.fecha ?? new Date();
        await recordAndSend(admin, {
          accountId,
          contactId,
          eventName: 'Purchase',
          dedupKey: dedupKeyFor('Purchase', { projectId: v.projectId }),
          source: 'venta',
          eventTime,
          ctwaClid: clids.get(contactId)!,
          projectId: v.projectId,
          value: v.monto,
          // No monto yet: wait for it (max 48 h, inside Meta's 7 days).
          awaitValueUntil: v.monto == null ? purchaseValueDeadline(eventTime) : null,
        });
      } catch (err) {
        console.error('[meta-capi] Purchase por venta:', errText(err));
      }
    }
  }
}

/** Flows cron hook. Throttled to every 5 min, never throws. */
export async function runMetaCapiSweepIfDue(admin: SupabaseClient): Promise<void> {
  if (!isMetaCapiEnabled()) return;
  const s = state();
  if (s.sweepRunning || Date.now() - s.lastSweepAt < SWEEP_EVERY_MS) return;
  s.sweepRunning = true;
  s.lastSweepAt = Date.now();
  try {
    try {
      await rescheduleStuckPending(admin);
    } catch (err) {
      console.error('[meta-capi] red de seguridad de pendientes falló:', errText(err));
    }
    await retryDue(admin);
    await resolveAwaitingPurchases(admin);
    const { data, error } = await admin.from('accounts').select('id');
    if (error) throw new Error(`accounts: ${error.message}`);
    for (const acc of (data ?? []) as { id: string }[]) {
      try {
        await sweepAccount(admin, acc.id);
      } catch (err) {
        console.error('[meta-capi] barrido de cuenta falló:', errText(err));
      }
    }
  } catch (err) {
    console.error('[meta-capi] barrido falló:', errText(err));
  } finally {
    s.sweepRunning = false;
  }
}
