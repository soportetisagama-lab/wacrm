import { describe, expect, it } from 'vitest';
import { estadoKey } from './estados';
import {
  APROXIMADO_MS,
  clasificarMarcacion,
  limaToIso,
  parseMarcaciones,
  planMarcaciones,
} from './marcaciones';

describe('limaToIso', () => {
  it('adds the Lima offset', () => {
    expect(limaToIso('2026-11-10 09:03:48')).toBe('2026-11-10T09:03:48-05:00');
    expect(new Date(limaToIso('2026-11-10 09:03:48')!).toISOString()).toBe('2026-11-10T14:03:48.000Z');
  });
  it('rejects malformed values', () => {
    expect(limaToIso('2026-11-10')).toBeNull();
    expect(limaToIso('2026-13-45 99:00:00')).toBeNull();
  });
});

describe('parseMarcaciones', () => {
  it('returns null when the PHP does not send marcaciones', () => {
    expect(parseMarcaciones({ linea: 'INOX', items: [] })).toBeNull();
    expect(parseMarcaciones(null)).toBeNull();
  });

  it('validates rows and keeps the last row per lead', () => {
    const out = parseMarcaciones({
      marcaciones: [
        { lead_id: 1, celular: '929564362', estado: 'contestado', tiempo_estado: '2026-11-10 09:03:48', asesor: ' Ana ' },
        { lead_id: '2', celular: '', estado: 'NO CONTESTADO', tiempo_estado: '2026-11-10 10:00:00', asesor: '' },
        { lead_id: 3, estado: 'OTRO', tiempo_estado: '2026-11-10 10:00:00' },
        { lead_id: 4, estado: 'CERRADO', tiempo_estado: null },
        { lead_id: 0, estado: 'CERRADO', tiempo_estado: '2026-11-10 10:00:00' },
        { lead_id: 1, celular: '51929564362', estado: 'SEGUIMIENTO', tiempo_estado: '2026-11-10 09:03:48', asesor: 'Ana' },
      ],
    });
    expect(out).toEqual([
      { lead_id: 1, celular: '51929564362', estado: 'SEGUIMIENTO', tiempo_estado: '2026-11-10T09:03:48-05:00', asesor: 'Ana' },
      { lead_id: 2, celular: null, estado: 'NO CONTESTADO', tiempo_estado: '2026-11-10T10:00:00-05:00', asesor: null },
    ]);
  });
});

describe('clasificarMarcacion', () => {
  it('classifies by the initial status', () => {
    expect(clasificarMarcacion('NO CONTESTADO')).toBe('no_contestado');
    expect(clasificarMarcacion('SPAM')).toBe('excluido');
    expect(clasificarMarcacion('ASIGNADO')).toBe('excluido');
    expect(clasificarMarcacion(null)).toBe('excluido');
    expect(clasificarMarcacion('OTRO')).toBe('excluido');
    const contacto = [
      'CONTESTADO',
      'SEGUIMIENTO',
      'CERRADO',
      'ANTICIPO',
      'VISITA',
      'VENTA FUTURA',
      'SERVICIO',
      'EN EVALUACION',
      'CERRADO 0',
      'CAIDO',
    ];
    for (const e of contacto) expect(clasificarMarcacion(estadoKey(e))).toBe('contestado');
  });
});

describe('planMarcaciones', () => {
  const now = Date.parse('2026-11-10T15:00:00Z'); // 10:00 in Lima
  const m = (lead_id: number, estado: string, tiempo: string, asesor: string | null = 'Ana') => ({
    lead_id,
    celular: null,
    estado,
    tiempo_estado: tiempo,
    asesor,
  });

  it('inserts new leads, flagging old ones as aproximado', () => {
    const plan = planMarcaciones({
      accountId: 'acc',
      marcaciones: [m(1, 'CONTESTADO', '2026-11-10T09:55:00-05:00'), m(2, 'CERRADO', '2026-11-09T09:00:00-05:00')],
      existing: new Map(),
      now,
    });
    expect(plan.toUpdate).toEqual([]);
    expect(plan.toInsert.map((r) => [r.lead_id, r.estado_inicial, r.estado_actual, r.aproximado])).toEqual([
      [1, 'CONTESTADO', 'CONTESTADO', false],
      [2, 'CERRADO', 'CERRADO', true],
    ]);
    expect(APROXIMADO_MS).toBe(15 * 60_000);
  });

  it('only updates estado_actual / asesor of known leads, grouped', () => {
    const plan = planMarcaciones({
      accountId: 'acc',
      marcaciones: [
        m(1, 'SEGUIMIENTO', '2026-11-10T09:00:00-05:00'),
        m(2, 'SEGUIMIENTO', '2026-11-10T09:00:00-05:00'),
        m(3, 'CONTESTADO', '2026-11-10T09:00:00-05:00'),
        m(4, 'CONTESTADO', '2026-11-10T09:00:00-05:00', 'Luis'),
      ],
      existing: new Map([
        [1, { estado_actual: 'CONTESTADO', asesor: 'Ana' }],
        [2, { estado_actual: 'NO CONTESTADO', asesor: 'Ana' }],
        [3, { estado_actual: 'CONTESTADO', asesor: 'Ana' }],
        [4, { estado_actual: 'CONTESTADO', asesor: 'Ana' }],
      ]),
      now,
    });
    expect(plan.toInsert).toEqual([]);
    expect(plan.toUpdate).toEqual([
      { estado_actual: 'SEGUIMIENTO', asesor: 'Ana', lead_ids: [1, 2] },
      { estado_actual: 'CONTESTADO', asesor: 'Luis', lead_ids: [4] },
    ]);
  });
});
