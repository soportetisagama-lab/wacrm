// ============================================================
// Meta Conversions API for Business Messaging — pure helpers.
//
// action_source "business_messaging", messaging_channel "whatsapp".
// Signals are sent only for contacts that arrived from a Click-to-
// WhatsApp ad (they carry a ctwa_clid); user_data holds ONLY that
// ctwa_clid and the line's WABA id, never a phone number.
//
// Safe to import from client components (button-action selector):
// no Node APIs here. The I/O lives in ./send.ts.
// ============================================================

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

/** UI labels (neutral Spanish) for the "Enviar señal a Meta" selector. */
export const META_CAPI_EVENT_LABELS: Record<MetaCapiEventName, string> = {
  LeadSubmitted: 'Cliente potencial registrado',
  QualifiedLead: 'Cliente potencial calificado',
  ViewContent: 'Vio contenido',
  AddToCart: 'Agregó al carrito',
  InitiateCheckout: 'Inició la compra (cotización)',
  OrderCreated: 'Pedido creado (anticipo)',
  Purchase: 'Compra realizada',
  OrderShipped: 'Pedido enviado',
  OrderDelivered: 'Pedido entregado',
  OrderCanceled: 'Pedido cancelado',
  OrderReturned: 'Pedido devuelto',
  CartAbandoned: 'Carrito abandonado',
  RatingProvided: 'Dio una calificación',
  ReviewProvided: 'Dejó una reseña',
};

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
 * Which event a newly added tag fires, or null. Status tags: ANTICIPO →
 * OrderCreated, CERRADO → Purchase (CERRADO 0, CAIDO, SPAM… → nothing).
 * Type tags listed in META_CAPI_QUALIFIED_TAGS → QualifiedLead.
 */
export function eventForTag(
  tagName: string,
  qualifiedTags: ReadonlySet<string>,
): MetaCapiEventName | null {
  const k = tagKey(tagName);
  if (k === 'ANTICIPO') return 'OrderCreated';
  if (k === 'CERRADO') return 'Purchase';
  if (qualifiedTags.has(k)) return 'QualifiedLead';
  return null;
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

/** Meta rejects events older than 7 days; clamp future times to now. */
export const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60_000;

export function clampEventTime(at: Date, now: Date = new Date()): Date | null {
  const t = at.getTime();
  if (!Number.isFinite(t)) return now;
  if (t > now.getTime()) return now;
  if (now.getTime() - t > MAX_EVENT_AGE_MS - 60_000) return null;
  return at;
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
    const fecha = typeof r.fecha === 'string' && r.fecha ? new Date(r.fecha.replace(' ', 'T')) : null;
    out.push({
      celular,
      projectId,
      monto: parseMonto(r.monto_venta),
      fecha: fecha && Number.isFinite(fecha.getTime()) ? fecha : null,
    });
  }
  return out;
}

/**
 * The project a new CERRADO tag should report: the most recent sale of
 * that phone not yet sent. null → no known project (Purchase without value).
 */
export function pickVenta(
  ventas: ReadonlyArray<Xlr8Venta>,
  alreadySentProjectIds: ReadonlySet<string>,
): Xlr8Venta | null {
  const pending = ventas.filter((v) => !alreadySentProjectIds.has(v.projectId));
  pending.sort((a, b) => (b.fecha?.getTime() ?? 0) - (a.fecha?.getTime() ?? 0));
  return pending[0] ?? null;
}
