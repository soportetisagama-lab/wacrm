// ============================================================
// "Horarios de contacto": per-lead first status change in xlr8
// (project_list.tiempo_estado), mirrored into marcaciones_estado
// (migration 094). Pure helpers only — the I/O lives in ./sync.ts.
// ============================================================

import { estadoKey, isEstado, phoneKey } from './estados';

export interface Marcacion {
  lead_id: number;
  /** phoneKey of the lead, or null when xlr8 has none. */
  celular: string | null;
  /** Current xlr8 status (estadoKey). */
  estado: string;
  /** ISO timestamp with Lima's offset, e.g. 2026-11-10T09:03:48-05:00. */
  tiempo_estado: string;
  asesor: string | null;
}

/** A lead registered more than this after its tiempo_estado is "aproximado". */
export const APROXIMADO_MS = 15 * 60_000;

const LIMA_DATETIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/;

/**
 * xlr8 sends Lima wall-clock time ("YYYY-MM-DD HH:MM:SS"). Peru is UTC-5
 * all year (no DST), so the fixed offset is exact. Null when malformed.
 */
export function limaToIso(value: string): string | null {
  const m = LIMA_DATETIME.exec(value.trim());
  if (!m) return null;
  const iso = `${m[1]}T${m[2]}-05:00`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

/**
 * The `marcaciones` array of estado_xlr9.php, validated. Returns null when
 * the response has no `marcaciones` at all (older PHP) so the caller can
 * skip the feature without failing. Malformed rows are dropped; a lead
 * repeated in the feed keeps its last row.
 */
export function parseMarcaciones(body: unknown): Marcacion[] | null {
  if (!body || typeof body !== 'object') return null;
  const raw = (body as { marcaciones?: unknown }).marcaciones;
  if (!Array.isArray(raw)) return null;
  const byLead = new Map<number, Marcacion>();
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue;
    const { lead_id, celular, estado, tiempo_estado, asesor } = it as Record<string, unknown>;
    const leadId = typeof lead_id === 'string' ? Number(lead_id) : lead_id;
    if (typeof leadId !== 'number' || !Number.isSafeInteger(leadId) || leadId <= 0) continue;
    if (typeof estado !== 'string' || !isEstado(estado)) continue;
    if (typeof tiempo_estado !== 'string') continue;
    const iso = limaToIso(tiempo_estado);
    if (!iso) continue;
    const phone =
      typeof celular === 'string' || typeof celular === 'number' ? phoneKey(String(celular)) : '';
    const name = typeof asesor === 'string' ? asesor.trim() : '';
    byLead.set(leadId, {
      lead_id: leadId,
      celular: phone || null,
      estado: estadoKey(estado),
      tiempo_estado: iso,
      asesor: name || null,
    });
  }
  return [...byLead.values()];
}

export type ClaseMarcacion = 'contestado' | 'no_contestado' | 'excluido';

/**
 * NO CONTESTADO → no contestado; SPAM / ASIGNADO (or unknown) → excluded;
 * any other status means there was contact → contestado.
 */
export function clasificarMarcacion(estadoInicial: string | null | undefined): ClaseMarcacion {
  const key = estadoKey(estadoInicial ?? '');
  if (key === 'NO CONTESTADO') return 'no_contestado';
  if (!key || key === 'SPAM' || key === 'ASIGNADO' || !isEstado(key)) return 'excluido';
  return 'contestado';
}

export interface MarcacionRowInsert {
  account_id: string;
  lead_id: number;
  celular: string | null;
  estado_inicial: string;
  estado_actual: string;
  tiempo_estado: string;
  asesor: string | null;
  aproximado: boolean;
}

export interface MarcacionUpdateGroup {
  estado_actual: string;
  asesor: string | null;
  lead_ids: number[];
}

export interface MarcacionPlan {
  toInsert: MarcacionRowInsert[];
  /** Existing leads whose estado_actual/asesor changed, grouped by new values. */
  toUpdate: MarcacionUpdateGroup[];
}

/**
 * New leads are inserted with estado_inicial = estado_actual = estado;
 * existing ones only get estado_actual / asesor refreshed (never
 * estado_inicial nor aproximado). Updates are grouped by their new values
 * so the sync can run one UPDATE … WHERE lead_id IN (…) per group.
 */
export function planMarcaciones(input: {
  accountId: string;
  marcaciones: Marcacion[];
  existing: Map<number, { estado_actual: string | null; asesor: string | null }>;
  now: number;
}): MarcacionPlan {
  const toInsert: MarcacionRowInsert[] = [];
  const groups = new Map<string, MarcacionUpdateGroup>();
  for (const m of input.marcaciones) {
    const prev = input.existing.get(m.lead_id);
    if (!prev) {
      toInsert.push({
        account_id: input.accountId,
        lead_id: m.lead_id,
        celular: m.celular,
        estado_inicial: m.estado,
        estado_actual: m.estado,
        tiempo_estado: m.tiempo_estado,
        asesor: m.asesor,
        aproximado: input.now - Date.parse(m.tiempo_estado) > APROXIMADO_MS,
      });
      continue;
    }
    if (prev.estado_actual === m.estado && (prev.asesor ?? null) === m.asesor) continue;
    const key = JSON.stringify([m.estado, m.asesor]);
    const group = groups.get(key);
    if (group) group.lead_ids.push(m.lead_id);
    else groups.set(key, { estado_actual: m.estado, asesor: m.asesor, lead_ids: [m.lead_id] });
  }
  return { toInsert, toUpdate: [...groups.values()] };
}
