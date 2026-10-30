import { describe, expect, it, vi } from "vitest";
import { fetchAllPages } from "./fetch-all-pages";

const rows = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => ({ id: `r${from + i}` }));

describe("fetchAllPages", () => {
  it("keeps reading until a page comes back short", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ data: rows(0, 2), error: null })
      .mockResolvedValueOnce({ data: rows(2, 2), error: null })
      .mockResolvedValueOnce({ data: rows(4, 1), error: null });

    const result = await fetchAllPages(fetchPage, { pageSize: 2 });

    expect(result.rows.map((r) => r.id)).toEqual(["r0", "r1", "r2", "r3", "r4"]);
    expect(result.complete).toBe(true);
    expect(fetchPage.mock.calls).toEqual([[0, 1], [2, 3], [4, 5]]);
  });

  it("makes one more request when the last page is exactly full", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ data: rows(0, 2), error: null })
      .mockResolvedValueOnce({ data: [], error: null });

    const result = await fetchAllPages(fetchPage, { pageSize: 2 });

    expect(result.rows).toHaveLength(2);
    expect(result.complete).toBe(true);
  });

  it("drops rows repeated across pages", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ data: rows(0, 2), error: null })
      .mockResolvedValueOnce({ data: rows(1, 1), error: null });

    const result = await fetchAllPages(fetchPage, { pageSize: 2 });

    expect(result.rows.map((r) => r.id)).toEqual(["r0", "r1"]);
  });

  it("returns what it read when a later page fails", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ data: rows(0, 2), error: null })
      .mockResolvedValueOnce({ data: null, error: "boom" });

    const result = await fetchAllPages(fetchPage, { pageSize: 2 });

    expect(result.rows).toHaveLength(2);
    expect(result.error).toBe("boom");
    expect(result.complete).toBe(false);
  });

  it("stops between pages when cancelled", async () => {
    let cancelled = false;
    const fetchPage = vi.fn(async () => {
      cancelled = true;
      return { data: rows(0, 2), error: null };
    });

    const result = await fetchAllPages(fetchPage, {
      pageSize: 2,
      isCancelled: () => cancelled,
    });

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(result.complete).toBe(false);
  });
});
