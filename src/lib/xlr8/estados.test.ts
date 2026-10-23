import { describe, expect, it } from 'vitest';
import { computeEstadoDiff, parseXlr8Response, phoneKey } from './estados';

describe('phoneKey', () => {
  it('keeps digits only and adds 51 to 9-digit mobiles', () => {
    expect(phoneKey('+51 929 564 362')).toBe('51929564362');
    expect(phoneKey('929564362')).toBe('51929564362');
    expect(phoneKey(null)).toBe('');
  });
});

describe('parseXlr8Response', () => {
  it('normalizes statuses and drops unknown ones', () => {
    const items = parseXlr8Response({
      linea: 'INOX',
      items: [
        { celular: '51929564362', estado: 'no contestado' },
        { celular: '51900000000', estado: 'OTRO' },
        { celular: '', estado: 'CONTESTADO' },
      ],
    });
    expect(items).toEqual([{ celular: '51929564362', estado: 'NO CONTESTADO', tipo: null }]);
  });

  it('normalizes types; unknown or empty → no type', () => {
    const items = parseXlr8Response({
      items: [
        { celular: '51911111111', estado: 'CERRADO', tipo: 'diseño' },
        { celular: '51922222222', estado: 'CERRADO', tipo: '' },
        { celular: '51933333333', estado: 'CERRADO', tipo: 'OTRO' },
      ],
    });
    expect(items.map((i) => i.tipo)).toEqual(['DISEÑO', '', '']);
  });

  it('throws without items', () => {
    expect(() => parseXlr8Response({ error: 'unauthorized' })).toThrow();
  });
});

describe('computeEstadoDiff', () => {
  const tagIdByEstado = new Map([
    ['CONTESTADO', 't-c'],
    ['NO CONTESTADO', 't-nc'],
  ]);

  it('swaps the status tag and skips unknown phones', () => {
    const diff = computeEstadoDiff({
      items: [
        { celular: '51911111111', estado: 'CONTESTADO' },
        { celular: '51922222222', estado: 'NO CONTESTADO' },
        { celular: '51933333333', estado: 'CONTESTADO' },
      ],
      contactsByPhone: new Map([
        ['51911111111', ['c1']],
        ['51922222222', ['c2']],
      ]),
      tagIdByEstado,
      currentRows: [
        { id: 'r1', contact_id: 'c1', tag_id: 't-nc' },
        { id: 'r2', contact_id: 'c2', tag_id: 't-nc' },
      ],
    });
    expect(diff.toInsert).toEqual([{ contact_id: 'c1', tag_id: 't-c' }]);
    expect(diff.toDelete).toEqual(['r1']);
    expect(diff.revisados).toBe(3);
    expect(diff.sinContacto).toBe(1);
  });

  it('mirrors the type field; an empty type removes the type tag', () => {
    const diff = computeEstadoDiff({
      items: [
        { celular: '51911111111', estado: 'CERRADO', tipo: 'INFO' },
        { celular: '51922222222', estado: 'CERRADO', tipo: '' },
        { celular: '51933333333', estado: 'CERRADO' },
      ],
      contactsByPhone: new Map([
        ['51911111111', ['c1']],
        ['51922222222', ['c2']],
        ['51933333333', ['c3']],
      ]),
      tagIdByEstado: new Map([['INFO', 't-i'], ['PRODUCTO', 't-p']]),
      field: 'tipo',
      currentRows: [
        { id: 'r1', contact_id: 'c1', tag_id: 't-p' },
        { id: 'r2', contact_id: 'c2', tag_id: 't-p' },
        { id: 'r3', contact_id: 'c3', tag_id: 't-p' },
      ],
    });
    expect(diff.toInsert).toEqual([{ contact_id: 'c1', tag_id: 't-i' }]);
    expect(diff.toDelete).toEqual(['r1', 'r2']);
  });
});
