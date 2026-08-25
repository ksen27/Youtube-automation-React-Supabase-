import { describe, expect, it } from "vitest";
import { queuePriority } from "./queue";

const MAX = 2 ** 21 - 1;

describe("queuePriority", () => {
  it("ranks a more recent dispatch ahead of an older one", () => {
    const older = queuePriority("2026-08-25T00:00:00Z");
    const newer = queuePriority("2026-08-25T09:00:00Z");
    expect(newer).toBeLessThan(older); // lower number = served first
  });

  it("gives blocks dispatched in the same instant the same rank", () => {
    const at = "2026-08-25T08:40:07.703Z";
    expect(queuePriority(at)).toBe(queuePriority(new Date(at)));
  });

  it("never returns 0 — that is BullMQ's 'unprioritized' and skips the ZSET", () => {
    // A dispatch far in the future would otherwise drive the value to or past 0
    // and silently land in the wait list, ahead of everything prioritized.
    expect(queuePriority("2999-01-01T00:00:00Z")).toBeGreaterThanOrEqual(1);
  });

  it("stays inside BullMQ's accepted range for old dispatches", () => {
    expect(queuePriority("2020-01-01T00:00:00Z")).toBeLessThanOrEqual(MAX);
  });

  it("sorts an unparseable date last rather than throwing", () => {
    expect(queuePriority("not a date")).toBe(MAX);
  });

  it("defaults to now, so a caller dispatching this instant ranks ahead of the past", () => {
    expect(queuePriority()).toBeLessThan(queuePriority("2026-08-25T00:00:00Z"));
  });
});
