import { describe, expect, it } from 'vitest';
import { PAGE_SIZE, chunk, fetchAllPages } from './audience';

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
