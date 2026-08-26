// What each board role may do.
//
// SCOPE — read this before treating it as security. The app has no per-user
// accounts: one shared password gates every request (proxy.ts), so anyone who
// can reach these routes is already inside the organisation. These roles are a
// COLLABORATION guardrail — they stop a viewer from restructuring someone's
// board by accident — not an isolation boundary between untrusted parties.
//
// What they are, though, is server-enforced: `assertCan` runs in the route
// handler against the identity the request claims, and the UI merely mirrors
// the same table so disabled buttons match what the server would allow. Client
// checks are never the check.
//
// Pure module: no imports, so it is unit-testable and safe in both bundles.

import type { BoardRole } from "./types";

export type BoardAction =
  | "board.view"
  | "board.update"
  | "board.delete"
  | "members.manage"
  | "labels.manage"
  | "list.manage"
  | "card.write"
  | "card.move"
  | "comment.write";

const RULES: Record<BoardRole, ReadonlySet<BoardAction>> = {
  // Full control, including the destructive and structural operations.
  owner: new Set<BoardAction>([
    "board.view",
    "board.update",
    "board.delete",
    "members.manage",
    "labels.manage",
    "list.manage",
    "card.write",
    "card.move",
    "comment.write",
  ]),
  // Everyday work. Cannot restructure the board itself (columns, membership,
  // settings) — that is the owner's call.
  member: new Set<BoardAction>([
    "board.view",
    "labels.manage",
    "card.write",
    "card.move",
    "comment.write",
  ]),
  // Read-only, but may still take part in the conversation.
  viewer: new Set<BoardAction>(["board.view", "comment.write"]),
};

export function can(role: BoardRole, action: BoardAction): boolean {
  return RULES[role]?.has(action) ?? false;
}

/**
 * Ownership rule for a comment: the author may edit or delete their own; the
 * board owner may delete anyone's (moderation), but may NOT edit anyone else's
 * words — rewriting another person's comment under their name is never a
 * moderation action.
 */
export function canEditComment(role: BoardRole, actorId: string | null, authorId: string | null): boolean {
  return actorId != null && authorId != null && actorId === authorId;
}

export function canDeleteComment(role: BoardRole, actorId: string | null, authorId: string | null): boolean {
  if (role === "owner") return true;
  return canEditComment(role, actorId, authorId);
}

/** Thrown by assertCan; mapped to a 403 by the route error handler. */
export class BoardForbiddenError extends Error {
  readonly action: BoardAction;
  constructor(action: BoardAction, role: BoardRole) {
    super(`Role "${role}" cannot perform "${action}" on this board.`);
    this.name = "BoardForbiddenError";
    this.action = action;
  }
}

export function assertCan(role: BoardRole, action: BoardAction): void {
  if (!can(role, action)) throw new BoardForbiddenError(action, role);
}
