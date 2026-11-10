import { describe, expect, it } from 'vitest';
import { limaDayRange, limaDiaHora, resumirHorarios, type MarcacionRow } from './horarios';

const row = (estado: string, tiempo: string, aproximado = false): MarcacionRow => ({
  estado_inicial: estado,
  tiempo_estado: tiempo,
  asesor: 'Ana',
  aproximado,
});

describe('limaDiaHora', () => {
  it('uses Lima time, Monday first', () => {
    // 2026-11-10 is a Tuesday; 03:30 UTC is Monday 22:30 in Lima.
    expect(limaDiaHora('2026-11-10T03:30:00Z')).toEqual({ dia: 0, hora: 22 });
    expect(limaDiaHora('2026-11-10T09:03:48-05:00')).toEqual({ dia: 1, hora: 9 });
    expect(limaDiaHora('2026-11-15T23:59:00-05:00')).toEqual({ dia: 6, hora: 23 });
    expect(limaDiaHora('2026-11-16T00:10:00-05:00')).toEqual({ dia: 0, hora: 0 });
    expect(limaDiaHora('nope')).toBeNull();
  });
});

describe('limaDayRange', () => {
  it('turns Lima days into a half-open UTC range', () => {
    expect(limaDayRange('2026-11-01', '2026-11-10')).toEqual({
      gte: '2026-11-01T05:00:00.000Z',
      lt: '2026-11-11T05:00:00.000Z',
    });
    expect(limaDayRange('2026-11-10', '2026-11-01')).toBeNull();
    expect(limaDayRange('', '2026-11-01')).toBeNull();
  });
});

describe('resumirHorarios', () => {
  it('counts by hour and weekday, skipping SPAM / ASIGNADO', () => {
    const r = resumirHorarios([
      row('CONTESTADO', '2026-11-10T09:00:00-05:00'),
      row('CERRADO', '2026-11-10T09:30:00-05:00', true),
      row('NO CONTESTADO', '2026-11-10T09:45:00-05:00'),
      row('NO CONTESTADO', '2026-11-11T15:00:00-05:00'),
      row('SPAM', '2026-11-10T09:00:00-05:00'),
      row('ASIGNADO', '2026-11-10T09:00:00-05:00'),
    ]);
    expect(r.total).toBe(4);
    expect(r.contestados).toBe(2);
    expect(r.noContestados).toBe(2);
    expect(r.celdas).toEqual([
      { dia: 1, hora: 9, contestados: 2, noContestados: 1 },
      { dia: 2, hora: 15, contestados: 0, noContestados: 1 },
    ]);
    expect(r.horas).toHaveLength(24);
    expect(r.horas[9]).toEqual({ hora: 9, contestados: 2, noContestados: 1 });
    expect(r.hayAproximados).toBe(true);
    // Fewer than 10 marcaciones per hour: no ranking.
    expect(r.mejor).toBeNull();
    expect(r.peor).toBeNull();
  });

  it('ranks only hours with at least 10 marcaciones', () => {
    const rows: MarcacionRow[] = [];
    for (let i = 0; i < 10; i++) rows.push(row(i < 8 ? 'CONTESTADO' : 'NO CONTESTADO', '2026-11-10T09:00:00-05:00'));
    for (let i = 0; i < 10; i++) rows.push(row(i < 3 ? 'CONTESTADO' : 'NO CONTESTADO', '2026-11-10T14:00:00-05:00'));
    for (let i = 0; i < 9; i++) rows.push(row('NO CONTESTADO', '2026-11-10T17:00:00-05:00'));
    const r = resumirHorarios(rows);
    expect(r.mejor).toEqual({ hora: 9, total: 10, pct: 80 });
    expect(r.peor).toEqual({ hora: 14, total: 10, pct: 30 });
    expect(r.hayAproximados).toBe(false);
  });
});
