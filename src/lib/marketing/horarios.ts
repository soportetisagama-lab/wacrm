// ============================================================
// "Horarios de contacto": aggregates marcaciones_estado (migration 094)
// by Lima hour of day × weekday, so Marketing sees at which hours leads
// get marked CONTESTADO vs NO CONTESTADO. Pure — the API route
// (app/api/marketing/horarios) does the I/O.
// ============================================================

import { clasificarMarcacion } from '@/lib/xlr8/marcaciones';

export const HORARIOS_TIME_ZONE = 'America/Lima';

/** An hour needs at least this many marcaciones to be "mejor"/"peor". */
export const MIN_MARCACIONES_RANKING = 10;

export interface MarcacionRow {
  estado_inicial: string | null;
  tiempo_estado: string;
  asesor: string | null;
  aproximado: boolean;
}

export interface Conteo {
  contestados: number;
  noContestados: number;
}

export interface CeldaHorario extends Conteo {
  /** 0 = lunes … 6 = domingo. */
  dia: number;
  hora: number;
}

export interface HoraRanking {
  hora: number;
  total: number;
  /** 0–100. */
  pct: number;
}

export interface HorariosResumen extends Conteo {
  total: number;
  /** Non-empty cells only. */
  celdas: CeldaHorario[];
  /** Always 24 entries, hour 0–23. */
  horas: (Conteo & { hora: number })[];
  mejor: HoraRanking | null;
  peor: HoraRanking | null;
  hayAproximados: boolean;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: 6,
};

let formatter: Intl.DateTimeFormat | null = null;

/** Weekday (0 = lunes) and hour (0–23) of `iso` in Lima. */
export function limaDiaHora(iso: string): { dia: number; hora: number } | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  formatter ??= new Intl.DateTimeFormat('en-US', {
    timeZone: HORARIOS_TIME_ZONE,
    weekday: 'short',
    hour: '2-digit',
    hourCycle: 'h23',
  });
  let dia = -1;
  let hora = -1;
  for (const part of formatter.formatToParts(ms)) {
    if (part.type === 'weekday') dia = WEEKDAY_INDEX[part.value] ?? -1;
    else if (part.type === 'hour') hora = Number(part.value) % 24;
  }
  return dia < 0 || hora < 0 ? null : { dia, hora };
}

export function pctContestados(c: Conteo): number {
  const total = c.contestados + c.noContestados;
  return total === 0 ? 0 : (c.contestados / total) * 100;
}

/** Excluded statuses (SPAM, ASIGNADO) never count. */
export function resumirHorarios(rows: readonly MarcacionRow[]): HorariosResumen {
  const celdas = new Map<number, CeldaHorario>();
  const horas = Array.from({ length: 24 }, (_, hora) => ({ hora, contestados: 0, noContestados: 0 }));
  let contestados = 0;
  let noContestados = 0;
  let hayAproximados = false;

  for (const r of rows) {
    const clase = clasificarMarcacion(r.estado_inicial);
    if (clase === 'excluido') continue;
    const dh = limaDiaHora(r.tiempo_estado);
    if (!dh) continue;
    if (r.aproximado) hayAproximados = true;
    const key = dh.dia * 24 + dh.hora;
    const celda = celdas.get(key) ?? { dia: dh.dia, hora: dh.hora, contestados: 0, noContestados: 0 };
    if (clase === 'contestado') {
      celda.contestados += 1;
      horas[dh.hora].contestados += 1;
      contestados += 1;
    } else {
      celda.noContestados += 1;
      horas[dh.hora].noContestados += 1;
      noContestados += 1;
    }
    celdas.set(key, celda);
  }

  const ranking: HoraRanking[] = horas
    .map((h) => ({ hora: h.hora, total: h.contestados + h.noContestados, pct: pctContestados(h) }))
    .filter((h) => h.total >= MIN_MARCACIONES_RANKING);
  let mejor: HoraRanking | null = null;
  let peor: HoraRanking | null = null;
  for (const h of ranking) {
    // Ties: the hour with more marcaciones wins (more reliable).
    if (!mejor || h.pct > mejor.pct || (h.pct === mejor.pct && h.total > mejor.total)) mejor = h;
    if (!peor || h.pct < peor.pct || (h.pct === peor.pct && h.total > peor.total)) peor = h;
  }

  return {
    total: contestados + noContestados,
    contestados,
    noContestados,
    celdas: [...celdas.values()].sort((a, b) => a.hora - b.hora || a.dia - b.dia),
    horas,
    mejor,
    peor: ranking.length > 1 ? peor : null,
    hayAproximados,
  };
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * [from, to] Lima calendar days → half-open ISO range. Null when either
 * date is malformed or from > to.
 */
export function limaDayRange(from: string, to: string): { gte: string; lt: string } | null {
  if (!DATE_ONLY.test(from) || !DATE_ONLY.test(to) || from > to) return null;
  const start = Date.parse(`${from}T00:00:00-05:00`);
  const end = Date.parse(`${to}T00:00:00-05:00`);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return {
    gte: new Date(start).toISOString(),
    lt: new Date(end + 24 * 60 * 60_000).toISOString(),
  };
}
