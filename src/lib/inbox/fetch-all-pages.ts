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
 */
export async function fetchAllPages<T extends { id: string }, E>(
  fetchPage: (from: number, to: number) => PromiseLike<PageResult<T, E>>,
  options: { pageSize?: number; isCancelled?: () => boolean } = {},
): Promise<FetchAllPagesResult<T, E>> {
  const { pageSize = LIST_PAGE_SIZE, isCancelled } = options;
  const byId = new Map<string, T>();

  for (let from = 0; ; from += pageSize) {
    if (isCancelled?.()) {
      return { rows: [...byId.values()], error: null, complete: false };
    }
    const { data, error } = await fetchPage(from, from + pageSize - 1);
    if (error) {
      return { rows: [...byId.values()], error, complete: false };
    }
    for (const row of data ?? []) byId.set(row.id, row);
    if (!data || data.length < pageSize) {
      return { rows: [...byId.values()], error: null, complete: true };
    }
  }
}
