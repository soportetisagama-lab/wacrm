import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const h = vi.hoisted(() => ({
  added: [] as string[],
  removed: [] as string[],
  existing: [] as string[],
}));

// The account has three tags; resolveImportTagIds returns ALL of them
// as its lookup table, exactly like the real one.
vi.mock('@/lib/contacts/resolve-import-tags', () => ({
  resolveImportTagIds: async () => ({
    tagIdByKey: new Map([
      ['extranjero', 't-extranjero'],
      ['vip', 't-vip'],
      ['derivado de sagama retail', 't-derivado'],
    ]),
    skippedNames: [],
  }),
}));
vi.mock('@/lib/contacts/tag-events', () => ({
  addContactTagAndDispatch: async ({ tagId }: { tagId: string }) => {
    h.added.push(tagId);
    return { added: true, dispatched: false };
  },
}));

import { setContactTags } from './contacts';

const db = {
  from: () => ({
    select: () => ({
      eq: async () => ({ data: h.existing.map((tag_id) => ({ tag_id })), error: null }),
    }),
    delete: () => ({
      eq: () => ({
        in: async (_col: string, ids: string[]) => {
          h.removed.push(...ids);
          return { error: null };
        },
      }),
    }),
  }),
} as unknown as SupabaseClient;

describe('setContactTags', () => {
  beforeEach(() => {
    h.added = [];
    h.removed = [];
    h.existing = [];
  });

  it('adds only the requested tags, not every tag in the account', async () => {
    await setContactTags(db, 'acc', 'user', 'c1', ['Derivado de Sagama Retail']);
    expect(h.added).toEqual(['t-derivado']);
  });

  it("'replace' removes tags that weren't requested", async () => {
    h.existing = ['t-vip'];
    await setContactTags(db, 'acc', 'user', 'c1', ['Derivado de Sagama Retail'], 'replace');
    expect(h.removed).toEqual(['t-vip']);
    expect(h.added).toEqual(['t-derivado']);
  });

  it("'add' keeps the contact's existing tags", async () => {
    h.existing = ['t-vip'];
    await setContactTags(db, 'acc', 'user', 'c1', ['Derivado de Sagama Retail'], 'add');
    expect(h.removed).toEqual([]);
    expect(h.added).toEqual(['t-derivado']);
  });
});
