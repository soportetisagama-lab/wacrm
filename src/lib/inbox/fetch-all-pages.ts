/** PostgREST caps a response at 1000 rows, so long lists are read in pages. */
export const LIST_PAGE_SIZE = 1000;

interface PageResult<T, E> {
  data: T[] | null;
  error: E | null;
}

export interface FetchAllPagesResult<T, E> {
  /** Every row read so far, without repeats. */
  rows: T[];
  /** The error that stopped the reading, if any. */
  error: E | null;
  /** True only when the last page was reached with no error or cancel. */
  complete: boolean;
}

/**
 * Reads every page until one comes back short. The query behind `fetchPage`
 * must have a stable order. A row can still repeat if another one is inserted
 * between two pages, so rows are de-duplicated by id. Rows already read are
 * returned on failure: what to do with a partial list is the caller's call.
 *
 * `concurrency` > 1 asks for that many pages at once (the inbox list: each
 * page is slow because of the row-level checks, so waiting for them one by
 * one added up). Pages are still applied in order.
 */
export async function fetchAllPages<T extends { id: string }, E>(
  fetchPage: (from: number, to: number) => PromiseLike<PageResult<T, E>>,
  options: { pageSize?: number; isCancelled?: () => boolean; concurrency?: number } = {},
): Promise<FetchAllPagesResult<T, E>> {
  const { pageSize = LIST_PAGE_SIZE, isCancelled } = options;
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
  const byId = new Map<string, T>();

  for (let from = 0; ; from += pageSize * concurrency) {
    if (isCancelled?.()) {
      return { rows: [...byId.values()], error: null, complete: false };
    }
    const batch = await Promise.all(
      Array.from({ length: concurrency }, (_, k) => {
        const start = from + k * pageSize;
        return fetchPage(start, start + pageSize - 1);
      }),
    );
    for (const { data, error } of batch) {
      if (error) {
        return { rows: [...byId.values()], error, complete: false };
      }
      for (const row of data ?? []) byId.set(row.id, row);
      if (!data || data.length < pageSize) {
        return { rows: [...byId.values()], error: null, complete: true };
      }
    }
  }
}
