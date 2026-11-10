// ============================================================
// Meta Conversions API for Business Messaging — pure helpers.
//
// action_source "business_messaging", messaging_channel "whatsapp".
// Signals are sent only for contacts that arrived from a Click-to-
// WhatsApp ad (they carry a ctwa_clid); user_data holds ONLY that
// ctwa_clid and the line's WABA id, never a phone number.
//
// Safe to import from client components (button-action selector):
// no Node APIs here. UI labels live in messages/*.json (MetaCapi.events). The I/O lives in ./send.ts.
// ============================================================

import { clasificarMarcacion } from '../xlr8/marcaciones';

/** Event names Meta accepts for action_source = business_messaging. */
export const META_CAPI_EVENT_NAMES = [
  'LeadSubmitted',
  'QualifiedLead',
  'ViewContent',
  'AddToCart',
  'InitiateCheckout',
  'OrderCreated',
  'Purchase',
  'OrderShipped',
  'OrderDelivered',
  'OrderCanceled',
  'OrderReturned',
  'CartAbandoned',
  'RatingProvided',
  'ReviewProvided',
] as const;

export type MetaCapiEventName = (typeof META_CAPI_EVENT_NAMES)[number];

const EVENT_SET = new Set<string>(META_CAPI_EVENT_NAMES);

export function isMetaCapiEventName(v: unknown): v is MetaCapiEventName {
  return typeof v === 'string' && EVENT_SET.has(v);
}

/** Case/space-insensitive tag key (same rule as xlr8/estados.estadoKey). */
function tagKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toUpperCase();
}

/** META_CAPI_QUALIFIED_TAGS ("PRODUCTO,PROYECTO") → normalized set. Empty → none. */
export function parseQualifiedTags(raw: string | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const part of (raw ?? '').split(',')) {
    const k = tagKey(part);
    if (k) out.add(k);
  }
  return out;
}

/**
 * Events a newly added tag fires (empty → none), LeadSubmitted first.
 * Status tags that imply contact (CONTESTADO or later: the same rule as
 * "Horarios de contacto", clasificarMarcacion → 'contestado') → LeadSubmitted;
 * ASIGNADO, NO CONTESTADO and SPAM → nothing. On top of that: ANTICIPO →
 * OrderCreated, CERRADO → Purchase. Type tags listed in
 * META_CAPI_QUALIFIED_TAGS → QualifiedLead. LeadSubmitted is deduped per
 * contact, so it goes out once, with the first contact status.
 */
export function eventsForTag(
  tagName: string,
  qualifiedTags: ReadonlySet<string>,
): MetaCapiEventName[] {
  const k = tagKey(tagName);
  const out: MetaCapiEventName[] = [];
  if (clasificarMarcacion(k) === 'contestado') out.push('LeadSubmitted');
  if (k === 'ANTICIPO') out.push('OrderCreated');
  else if (k === 'CERRADO') out.push('Purchase');
  else if (qualifiedTags.has(k)) out.push('QualifiedLead');
  return out;
}

/**
 * Dedup key stored per contact (unique with contact_id): one event of
 * each type per contact, except Purchase, which is one per xlr8 project
 * when the project is known.
 */
export function dedupKeyFor(
  eventName: MetaCapiEventName,
  opts: { projectId?: string | number | null } = {},
): string {
  if (eventName === 'Purchase' && opts.projectId != null && String(opts.projectId).trim()) {
    return `Purchase:${String(opts.projectId).trim()}`;
  }
  return eventName;
}

export interface MetaCapiEventInput {
  eventName: MetaCapiEventName;
  eventTime: Date;
  eventId: string;
  wabaId: string;
  ctwaClid: string;
  value?: number | null;
  currency?: string | null;
}

/** Body for POST /{dataset_id}/events. */
export function buildEventPayload(input: MetaCapiEventInput): {
  data: Array<Record<string, unknown>>;
} {
  const event: Record<string, unknown> = {
    event_name: input.eventName,
    event_time: Math.floor(input.eventTime.getTime() / 1000),
    event_id: input.eventId,
    action_source: 'business_messaging',
    messaging_channel: 'whatsapp',
    user_data: {
      whatsapp_business_account_id: input.wabaId,
      ctwa_clid: input.ctwaClid,
    },
  };
  if (typeof input.value === 'number' && Number.isFinite(input.value) && input.value > 0) {
    event.custom_data = { value: input.value, currency: input.currency || 'PEN' };
  }
  return { data: [event] };
}

/** Meta requires value + currency on Purchase: one without value > 0 is never sent. */
export function isUnsendablePurchase(eventName: MetaCapiEventName, value: number | string | null | undefined): boolean {
  if (eventName !== 'Purchase') return false;
  const n = value == null ? NaN : Number(value);
  return !(Number.isFinite(n) && n > 0);
}

/** Meta rejects events older than 7 days; clamp future times to now. */
export const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60_000;

export function clampEventTime(at: Date, now: Date = new Date()): Date | null {
  const t = at.getTime();
  if (!Number.isFinite(t)) return now;
  if (t > now.getTime()) return now;
  if (now.getTime() - t > MAX_EVENT_AGE_MS - 60_000) return null;
  return at;
}

/** How long a Purchase waits for its amount from XLR8 before going out without it. */
export const PURCHASE_VALUE_WAIT_MS = 48 * 60 * 60_000;
/** Margin kept before Meta's 7-day limit so the event still gets through. */
const PURCHASE_DEADLINE_MARGIN_MS = 6 * 60 * 60_000;

/** Latest moment a waiting Purchase may be held: 48 h, never past ~7 days. */
export function purchaseValueDeadline(eventTime: Date): Date {
  const t = eventTime.getTime();
  return new Date(Math.min(t + PURCHASE_VALUE_WAIT_MS, t + MAX_EVENT_AGE_MS - PURCHASE_DEADLINE_MARGIN_MS));
}

/**
 * What to do with a Purchase waiting for its amount: send it with the
 * sale found, send it without value (no sales feed, or deadline reached),
 * or keep waiting.
 */
export function decideAwaitingPurchase(args: {
  venta: Xlr8Venta | null;
  ventasConfigured: boolean;
  deadline: Date;
  now?: Date;
}): 'with_value' | 'without_value' | 'wait' {
  // A sale found without monto_venta yet keeps waiting (its project_id is
  // still used if the deadline comes first).
  if (args.venta && args.venta.monto != null) return 'with_value';
  if (!args.ventasConfigured) return 'without_value';
  return (args.now ?? new Date()).getTime() >= args.deadline.getTime() ? 'without_value' : 'wait';
}

/** Retry schedule after a failed send (attempt = attempts made so far). */
const RETRY_DELAYS_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000];
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

export function nextRetryDelayMs(attempts: number): number | null {
  if (attempts < 1 || attempts >= MAX_ATTEMPTS) return null;
  return RETRY_DELAYS_MS[attempts - 1] ?? null;
}

/** An outbound document that is a quotation (filename or caption). */
export function isQuoteDocument(filename?: string | null, caption?: string | null): boolean {
  const text = `${filename ?? ''} ${caption ?? ''}`
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
  return /cotiz|proforma|presupuesto/.test(text);
}

/**
 * The event configured on the tapped button / list row of an interactive
 * message payload (as stored in messages.interactive_payload), or null.
 */
export function buttonMetaEvent(payload: unknown, replyId: string): MetaCapiEventName | null {
  if (!payload || typeof payload !== 'object' || !replyId) return null;
  const p = payload as {
    buttons?: Array<{ id?: unknown; meta_event?: unknown }>;
    sections?: Array<{ rows?: Array<{ id?: unknown; meta_event?: unknown }> }>;
  };
  const candidates = [
    ...(Array.isArray(p.buttons) ? p.buttons : []),
    ...(Array.isArray(p.sections) ? p.sections.flatMap((s) => (Array.isArray(s?.rows) ? s.rows : [])) : []),
  ];
  const hit = candidates.find((b) => b && b.id === replyId);
  return hit && isMetaCapiEventName(hit.meta_event) ? hit.meta_event : null;
}

// ------------------------------------------------------------
// XLR8 sales feed (ventas_xlr9.php)
// ------------------------------------------------------------

export interface Xlr8Venta {
  /** phoneKey-normalized (51 + 9 digits). */
  celular: string;
  projectId: string;
  monto: number | null;
  fecha: Date | null;
}

/** "S/ 1,234.50" / "1234,5" / 1234 → number; anything else → null. */
export function parseMonto(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  if (typeof v !== 'string') return null;
  // "S/. 1,234.50": drop the currency and any leading separator.
  let s = v.replace(/[^\d.,]/g, '').replace(/^[.,]+/, '');
  if (!s) return null;
  if (s.includes(',') && s.includes('.')) s = s.replace(/,/g, '');
  else if (s.includes(',')) s = /,\d{1,2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

function phoneKey(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.length === 9 ? `51${digits}` : digits;
}

/**
 * XLR8 dates are Lima time (UTC-5, no DST). "YYYY-MM-DD" alone → noon
 * Lima; "YYYY-MM-DD HH:MM[:SS]" → that Lima time. Anything else → null.
 */
export function parseXlr8Fecha(v: unknown): Date | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  let iso: string | null = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) iso = `${s}T12:00:00-05:00`;
  else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(s)) iso = `${s.replace(' ', 'T')}-05:00`;
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d : null;
}

export function parseVentasResponse(body: unknown): Xlr8Venta[] {
  if (!body || typeof body !== 'object') throw new Error('respuesta no es un objeto');
  const items = (body as { items?: unknown }).items;
  if (!Array.isArray(items)) throw new Error('respuesta sin "items"');
  const out: Xlr8Venta[] = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const r = it as Record<string, unknown>;
    if (typeof r.celular !== 'string' && typeof r.celular !== 'number') continue;
    const celular = phoneKey(String(r.celular));
    const projectId = r.project_id == null ? '' : String(r.project_id).trim();
    if (!celular || !projectId) continue;
    const fecha = parseXlr8Fecha(r.fecha);
    out.push({
      celular,
      projectId,
      monto: parseMonto(r.monto_venta),
      fecha,
    });
  }
  return out;
}

/** A sale may be dated up to this long after the CERRADO tag (late entry in XLR8). */
export const VENTA_AFTER_CLOSURE_MS = 2 * 24 * 60 * 60_000;

/**
 * Whether a sale belongs to a closure (CERRADO tag at `closedAt`): dated
 * within the 7 days before it, or up to 2 days after. Measured against the
 * closure, never against now, so a backfilled tag still finds its sale.
 * A sale without date is accepted.
 */
export function ventaMatchesClosure(fecha: Date | null, closedAt: Date): boolean {
  if (!fecha) return true;
  const diff = closedAt.getTime() - fecha.getTime();
  return diff < MAX_EVENT_AGE_MS && diff > -VENTA_AFTER_CLOSURE_MS;
}

/**
 * The project a CERRADO tag (closed at `closedAt`) should report: the most
 * recent sale of that phone, of this closure, not yet sent. null → no
 * known project (the Purchase waits for its amount or is skipped).
 */
export function pickVenta(
  ventas: ReadonlyArray<Xlr8Venta>,
  alreadySentProjectIds: ReadonlySet<string>,
  closedAt: Date = new Date(),
): Xlr8Venta | null {
  // Only sales of this closure: one dated > 7 days before it is a past one.
  const pending = ventas.filter(
    (v) => !alreadySentProjectIds.has(v.projectId) && ventaMatchesClosure(v.fecha, closedAt),
  );
  pending.sort((a, b) => (b.fecha?.getTime() ?? 0) - (a.fecha?.getTime() ?? 0));
  return pending[0] ?? null;
}

/**
 * A Purchase of the contact already recorded without project (sent,
 * pending or waiting) whose closure (event_time) is the closure of this
 * sale: it already reports the sale, so no second Purchase is created.
 */
export function purchaseCoveringVenta<T extends { projectId: string | null; eventTime: Date }>(
  venta: Pick<Xlr8Venta, 'fecha'>,
  purchases: ReadonlyArray<T>,
): T | null {
  return purchases.find((p) => !p.projectId && ventaMatchesClosure(venta.fecha, p.eventTime)) ?? null;
}

/**
 * A Purchase still without project (CERRADO seen, amount pending) is the
 * same closure as any other Purchase of that contact recorded in the last
 * 7 days: it must not become a second one.
 */
export function isPurchaseCovered(
  rowId: string,
  others: ReadonlyArray<{ id: string; createdAt: Date }>,
  now: Date = new Date(),
): boolean {
  return others.some((o) => o.id !== rowId && now.getTime() - o.createdAt.getTime() < MAX_EVENT_AGE_MS);
}

// ------------------------------------------------------------
// Dataset name (META_CAPI_DATASET_NAME, e.g. "XLR9 Inox")
// ------------------------------------------------------------

/** Trimmed env value; unset/blank → null (no name is sent). */
export function datasetNameFromEnv(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim();
  return v ? v.slice(0, 100) : null;
}

/** Body for POST /{waba_id}/dataset: with the name when there is one. */
export function datasetCreateBody(name: string | null): { dataset_name: string } | null {
  return name ? { dataset_name: name } : null;
}

/** Rename only when a name is configured and the dataset doesn't have it. */
export function datasetRenameNeeded(current: string | null | undefined, desired: string | null): boolean {
  return Boolean(desired) && (current ?? '').trim() !== desired;
}
