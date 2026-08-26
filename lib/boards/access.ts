// Server-side board access resolution.
//
// EVERY board route calls `resolveBoardAccess` before touching data. It does
// three things, in this order:
//   1. proves the board exists (a 404 here is what stops id-probing from
//      revealing which uuids are real);
//   2. resolves the claimed actor to a real member OF THIS BOARD — an actor id
//      belonging to another board's member is rejected, not silently ignored;
//   3. hands back the role, which `assertCan` then checks per action.
//
// The identity itself is client-supplied (there are no per-user accounts — see
// the header of migration 0037). That is exactly why step 2 exists: the claim
// is never trusted as given, it is validated against the board's own membership
// before it can be used to attribute an activity entry or pass a role check.

import { getServerSupabase } from "@/lib/supabase/server";
import { BoardError, BoardNotFoundError, unwrap } from "./errors";
import type { BoardMember, BoardRole } from "./types";
import { mapMember, type BoardMemberRow } from "./rows";

export interface BoardAccess {
  boardId: string;
  /** Null when the request did not claim an identity. */
  actor: BoardMember | null;
  role: BoardRole;
  archived: boolean;
}

/**
 * Role used when a request claims no identity. "member" — everyday work is
 * allowed (this is an internal tool behind a shared password, and blocking it
 * would make the board unusable before anyone picks a name), but the structural
 * and destructive actions still require identifying as an owner.
 */
const ANONYMOUS_ROLE: BoardRole = "member";

export async function resolveBoardAccess(
  boardId: string,
  actorId: string | null,
): Promise<BoardAccess> {
  const sb = getServerSupabase();

  const { data: board, error } = await sb
    .from("boards")
    .select("id, archived_at")
    .eq("id", boardId)
    .maybeSingle();
  if (error) throw new BoardError(error.message, 500, "database_error");
  if (!board) throw new BoardNotFoundError();

  let actor: BoardMember | null = null;
  if (actorId) {
    const { data: row, error: memberError } = await sb
      .from("board_members")
      .select("*")
      .eq("id", actorId)
      .eq("board_id", boardId)
      .maybeSingle();
    if (memberError) throw new BoardError(memberError.message, 500, "database_error");
    if (!row) {
      throw new BoardError(
        "The identity on this request is not a member of this board.",
        403,
        "actor_not_member",
      );
    }
    actor = mapMember(row as BoardMemberRow);
  }

  return {
    boardId,
    actor,
    role: actor?.role ?? ANONYMOUS_ROLE,
    archived: board.archived_at != null,
  };
}

/**
 * Guard for writes. An archived board is read-only: it stays visible for
 * history, but letting cards move around inside it would quietly resurrect work
 * the team has deliberately put away.
 */
export function assertWritable(access: BoardAccess): void {
  if (access.archived) {
    throw new BoardError("This board is archived and cannot be modified.", 409, "board_archived");
  }
}

/**
 * Confirm a card really belongs to the board in the URL before acting on it.
 * Without this, `/api/boards/<board-i-can-see>/cards/<someone-elses-card>` would
 * pass the board check and then operate on the other board's card.
 */
export async function assertCardOnBoard(boardId: string, cardId: string): Promise<void> {
  const sb = getServerSupabase();
  // `unwrap` turns both a query error and a missing row into a throw, so the
  // absence of a card on this board never reads as success here.
  unwrap(
    await sb.from("board_cards").select("id").eq("id", cardId).eq("board_id", boardId).maybeSingle(),
    "Card",
  );
}
