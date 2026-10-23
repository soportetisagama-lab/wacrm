// ============================================================
// Lead statuses from the legacy "xlr8" CRM (PHP/MySQL), mirrored as
// shared contact tags so broadcasts can filter by them. Pure helpers
// only — the I/O lives in ./sync.ts.
// ============================================================

/** The 13 xlr8 statuses (tag name → color), exactly as xlr8 shows them. */
export const XLR8_ESTADOS: ReadonlyArray<{ name: string; color: string }> = [
  { name: 'ASIGNADO', color: '#c0c0c0' },
  { name: 'NO CONTESTADO', color: '#212121' },
  { name: 'CONTESTADO', color: '#ffeb3b' },
  { name: 'SEGUIMIENTO', color: '#2196f3' },
  { name: 'CAIDO', color: '#f44336' },
  { name: 'CERRADO', color: '#4caf50' },
  { name: 'ANTICIPO', color: '#9c27b0' },
  { name: 'VISITA', color: '#ff9800' },
  { name: 'VENTA FUTURA', color: '#0097a7' },
  { name: 'SERVICIO', color: '#795548' },
  { name: 'EN EVALUACION', color: '#cdff00' },
  { name: 'SPAM', color: '#f44336' },
  { name: 'CERRADO 0', color: '#9ec400' },
];

/** Case/space-insensitive key used to match tag names. */
export function estadoKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toUpperCase();
}

const ESTADO_KEYS = new Set(XLR8_ESTADOS.map((e) => estadoKey(e.name)));

export function isEstado(name: string): boolean {
  return ESTADO_KEYS.has(estadoKey(name));
}

/**
 * True for the shared tags the xlr8 sync manages. A personal tag that
 * happens to share a status name is NOT one (the sync only uses shared
 * tags). Only admin/owner may put these on or take them off a contact —
 * see canManageEstadoTags and supabase/migrations/077 + 078.
 */
export function isEstadoTag(tag: { name: string; is_shared?: boolean | null }): boolean {
  return tag.is_shared !== false && isEstado(tag.name);
}

/**
 * Digits-only phone, with Peru's 51 prepended to bare 9-digit mobiles —
 * the same rule estado_xlr9.php applies, so both sides compare equal.
 */
export function phoneKey(phone: string | null | undefined): string {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (digits.length === 9) return `51${digits}`;
  return digits;
}

export interface Xlr8Item {
  celular: string;
  estado: string;
}

/** Validates the PHP response; drops malformed rows and unknown statuses. */
export function parseXlr8Response(body: unknown): Xlr8Item[] {
  if (!body || typeof body !== 'object') throw new Error('respuesta no es un objeto');
  const items = (body as { items?: unknown }).items;
  if (!Array.isArray(items)) throw new Error('respuesta sin "items"');
  const out: Xlr8Item[] = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const { celular, estado } = it as { celular?: unknown; estado?: unknown };
    if (typeof celular !== 'string' && typeof celular !== 'number') continue;
    if (typeof estado !== 'string' || !isEstado(estado)) continue;
    const key = phoneKey(String(celular));
    if (!key) continue;
    out.push({ celular: key, estado: estadoKey(estado) });
  }
  return out;
}

export interface EstadoDiffInput {
  items: Xlr8Item[];
  /** phoneKey → contact ids with that phone (usually one). */
  contactsByPhone: Map<string, string[]>;
  /** estadoKey → canonical tag id to assign. */
  tagIdByEstado: Map<string, string>;
  /** Existing contact_tags rows whose tag is any status tag. */
  currentRows: ReadonlyArray<{ id: string; contact_id: string; tag_id: string }>;
}

export interface EstadoDiff {
  toInsert: { contact_id: string; tag_id: string }[];
  /** contact_tags ids to delete. */
  toDelete: string[];
  revisados: number;
  sinContacto: number;
}

/**
 * For every xlr8 phone that matches a contact, the contact must end up
 * with exactly one status tag: the xlr8 one. Non-status tags are never
 * in `currentRows`, so they're never touched. Contacts absent from the
 * feed keep whatever status tag they have.
 */
export function computeEstadoDiff(input: EstadoDiffInput): EstadoDiff {
  const rowsByContact = new Map<string, { id: string; tag_id: string }[]>();
  for (const r of input.currentRows) {
    const list = rowsByContact.get(r.contact_id);
    if (list) list.push(r);
    else rowsByContact.set(r.contact_id, [r]);
  }

  const toInsert: EstadoDiff['toInsert'] = [];
  const toDelete: string[] = [];
  const handled = new Set<string>();
  let sinContacto = 0;

  for (const item of input.items) {
    const tagId = input.tagIdByEstado.get(item.estado);
    if (!tagId) continue;
    const contactIds = input.contactsByPhone.get(item.celular);
    if (!contactIds?.length) {
      sinContacto += 1;
      continue;
    }
    for (const contactId of contactIds) {
      // Same contact reached twice (duplicate phones in the feed): first wins.
      if (handled.has(contactId)) continue;
      handled.add(contactId);
      const rows = rowsByContact.get(contactId) ?? [];
      let has = false;
      for (const r of rows) {
        if (r.tag_id === tagId && !has) has = true;
        else toDelete.push(r.id);
      }
      if (!has) toInsert.push({ contact_id: contactId, tag_id: tagId });
    }
  }

  return { toInsert, toDelete, revisados: input.items.length, sinContacto };
}
