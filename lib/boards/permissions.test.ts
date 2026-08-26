import { describe, expect, it } from "vitest";
import {
  BoardForbiddenError,
  assertCan,
  can,
  canDeleteComment,
  canEditComment,
} from "./permissions";

// Authorisation is checked server-side in every route handler, so these tests
// pin the table the handlers consult. A regression here is not a UI glitch — it
// is a viewer being able to delete someone's column.

describe("role capabilities", () => {
  it("gives the owner everything", () => {
    for (const action of [
      "board.view",
      "board.update",
      "board.delete",
      "members.manage",
      "list.manage",
      "card.write",
      "card.move",
      "comment.write",
    ] as const) {
      expect(can("owner", action)).toBe(true);
    }
  });

  it("lets a member do everyday work but not restructure the board", () => {
    expect(can("member", "card.write")).toBe(true);
    expect(can("member", "card.move")).toBe(true);
    expect(can("member", "comment.write")).toBe(true);
    expect(can("member", "list.manage")).toBe(false);
    expect(can("member", "members.manage")).toBe(false);
    expect(can("member", "board.delete")).toBe(false);
  });

  it("limits a viewer to reading and commenting", () => {
    expect(can("viewer", "board.view")).toBe(true);
    expect(can("viewer", "comment.write")).toBe(true);
    expect(can("viewer", "card.write")).toBe(false);
    expect(can("viewer", "card.move")).toBe(false);
  });
});

describe("assertCan", () => {
  it("passes silently when allowed", () => {
    expect(() => assertCan("member", "card.write")).not.toThrow();
  });

  it("throws a forbidden error the route layer maps to a 403", () => {
    expect(() => assertCan("viewer", "card.write")).toThrow(BoardForbiddenError);
  });
});

describe("comment ownership", () => {
  it("lets an author edit their own comment", () => {
    expect(canEditComment("member", "m1", "m1")).toBe(true);
  });

  it("stops anyone editing someone else's words, owner included", () => {
    expect(canEditComment("member", "m1", "m2")).toBe(false);
    // Moderation means removing a comment, never rewriting it under the
    // original author's name.
    expect(canEditComment("owner", "m1", "m2")).toBe(false);
  });

  it("lets the board owner delete anyone's comment", () => {
    expect(canDeleteComment("owner", "m1", "m2")).toBe(true);
    expect(canDeleteComment("member", "m1", "m2")).toBe(false);
  });

  it("attributes nothing to an unidentified actor", () => {
    expect(canEditComment("member", null, "m1")).toBe(false);
    expect(canDeleteComment("member", null, null)).toBe(false);
  });
});
