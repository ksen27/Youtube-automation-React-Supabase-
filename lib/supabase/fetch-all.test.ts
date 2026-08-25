import { describe, expect, it } from "vitest";
import { fetchAllRows, SUPABASE_PAGE_SIZE } from "./fetch-all";

// A fake PostgREST endpoint: holds `total` rows and refuses to return more than
// `maxRows` per request, exactly like a server-side max-rows cap.
function table(total: number, maxRows = SUPABASE_PAGE_SIZE) {
  const rows = Array.from({ length: total }, (_, i) => ({ id: i }));
  const calls: Array<[number, number]> = [];
  const page = async (from: number, to: number) => {
    calls.push([from, to]);
    const size = Math.min(to - from + 1, maxRows);
    return { data: rows.slice(from, from + size), error: null, count: total };
  };
  return { page, calls };
}

describe("fetchAllRows", () => {
  it("returns every row past the page cap, in order", async () => {
    const t = table(3116);
    const { data, error } = await fetchAllRows(t.page);
    expect(error).toBeNull();
    expect(data).toHaveLength(3116);
    expect(data.map((r) => r.id)).toEqual(data.map((_, i) => i));
    // The bug being guarded: a single unbounded read stopped at 1000.
    expect(t.calls.length).toBeGreaterThan(1);
  });

  it("stops on the exact count without an extra empty read", async () => {
    const t = table(2000);
    const { data } = await fetchAllRows(t.page);
    expect(data).toHaveLength(2000);
    expect(t.calls).toHaveLength(2);
  });

  it("drains fully when the server caps pages below the requested size", async () => {
    // An instance with max-rows lower than ours must not be mistaken for the
    // end of the table — the loop follows `count`, not the page length.
    const t = table(1200, 500);
    const { data } = await fetchAllRows(t.page);
    expect(data).toHaveLength(1200);
  });

  it("terminates on an empty page when count is unavailable", async () => {
    const rows = Array.from({ length: 1500 }, (_, i) => ({ id: i }));
    let calls = 0;
    const { data } = await fetchAllRows(async (from, to) => {
      calls++;
      return { data: rows.slice(from, to + 1), error: null, count: null };
    });
    expect(data).toHaveLength(1500);
    expect(calls).toBe(3); // 1000 + 500 + the empty read that ends it
  });

  it("surfaces an error with whatever it had, instead of a silent short read", async () => {
    const err = { message: "boom", details: "", hint: "", code: "500", name: "PostgrestError" };
    let calls = 0;
    const { data, error } = await fetchAllRows(async () => {
      calls++;
      if (calls === 1) return { data: [{ id: 1 }], error: null, count: 5000 };
      return { data: null, error: err as never, count: null };
    });
    expect(error).toBe(err);
    expect(data).toHaveLength(1);
  });

  it("handles an empty table in one read", async () => {
    const t = table(0);
    const { data } = await fetchAllRows(t.page);
    expect(data).toEqual([]);
    expect(t.calls).toHaveLength(1);
  });
});
