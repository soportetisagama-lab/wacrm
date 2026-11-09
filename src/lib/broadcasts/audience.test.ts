import { describe, expect, it } from 'vitest';
import {
  PAGE_SIZE,
  chunk,
  createdAtBounds,
  fetchAllPages,
  isCreatedRangeInverted,
  isCreatedWithin,
} from './audience';

describe('fetchAllPages', () => {
  it('keeps paging until a short page', async () => {
    const total = PAGE_SIZE * 2 + 5;
    const calls: [number, number][] = [];
    const rows = await fetchAllPages<number>(async (from, to) => {
      calls.push([from, to]);
      const data = [];
      for (let i = from; i <= Math.min(to, total - 1); i++) data.push(i);
      return { data, error: null };
    });
    expect(rows).toHaveLength(total);
    expect(calls).toHaveLength(3);
  });

  it('throws on a page error', async () => {
    await expect(
      fetchAllPages(async () => ({ data: null, error: { message: 'boom' } })),
    ).rejects.toThrow('boom');
  });
});

describe('chunk', () => {
  it('splits into fixed-size slices', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});

describe('createdAtBounds (Lima days)', () => {
  it('returns null without dates', () => {
    expect(createdAtBounds({})).toBeNull();
    expect(createdAtBounds({ createdFrom: '', createdTo: 'bad' })).toBeNull();
  });

  it('maps Lima midnight to UTC and makes "to" inclusive', () => {
    expect(createdAtBounds({ createdFrom: '2026-03-01', createdTo: '2026-03-31' })).toEqual({
      gte: '2026-03-01T05:00:00.000Z',
      lt: '2026-04-01T05:00:00.000Z',
    });
  });

  it('allows open ends', () => {
    expect(createdAtBounds({ createdFrom: '2026-03-01' })).toEqual({
      gte: '2026-03-01T05:00:00.000Z',
    });
    expect(createdAtBounds({ createdTo: '2026-03-01' })).toEqual({
      lt: '2026-03-02T05:00:00.000Z',
    });
  });
});

describe('isCreatedRangeInverted', () => {
  it('flags only from > to', () => {
    expect(isCreatedRangeInverted({ createdFrom: '2026-03-02', createdTo: '2026-03-01' })).toBe(true);
    expect(isCreatedRangeInverted({ createdFrom: '2026-03-01', createdTo: '2026-03-01' })).toBe(false);
    expect(isCreatedRangeInverted({ createdFrom: '2026-03-02' })).toBe(false);
  });
});

describe('isCreatedWithin', () => {
  const bounds = createdAtBounds({ createdFrom: '2026-03-01', createdTo: '2026-03-01' });

  it('includes the whole Lima day', () => {
    expect(isCreatedWithin('2026-03-01T05:00:00Z', bounds)).toBe(true);
    // 23:59 in Lima = 04:59 UTC next day.
    expect(isCreatedWithin('2026-03-02T04:59:59Z', bounds)).toBe(true);
  });

  it('excludes outside the day', () => {
    expect(isCreatedWithin('2026-03-01T04:59:59Z', bounds)).toBe(false);
    expect(isCreatedWithin('2026-03-02T05:00:00Z', bounds)).toBe(false);
    expect(isCreatedWithin(null, bounds)).toBe(false);
  });

  it('passes everything without bounds', () => {
    expect(isCreatedWithin(null, null)).toBe(true);
  });
});
