// Server-side board data access: boards, lists, cards, ordering and activity.
//
// This is the ONLY layer that talks to Supabase for the board feature. Route
// handlers validate input and check permissions, then call in here; components
// never see a table name. Card-detail relations (checklists, comments,
// attachments, labels, assignments) live in ./card-service.ts to keep both
// files readable.
//
// Two rules this module exists to enforce:
//
//   * NO N+1. Every read that returns many cards gathers its relations with a
//     fixed number of `.in(...)` queries and joins them in memory, rather than
//     one query per card. The count of round trips is constant in the size of
//     the board.
//
//   * POSITIONS ARE RESOLVED SERVER-SIDE. Clients send a target index; the
//     server re-reads the column and turns that into a fractional position (see
//     ./position.ts). A stale client therefore lands where the column actually
//     is now, and cannot write a position derived from rows that have moved.

import { getServerSupabase } from "@/lib/supabase/server";
import { BoardError, BoardNotFoundError, BoardValidationError, unwrap, unwrapVoid } from "./errors";
import { neighborsForIndex, needsNormalize, positionBetween, POSITION_STEP } from "./position";
import { BOARD_ACTIONS } from "./activity";
import {
  mapActivity,
  mapBoard,
  mapCard,
  mapLabel,
  mapList,
  mapMember,
  type BoardActivityRow,
  type BoardCardRow,
  type BoardLabelRow,
  type BoardListRow,
  type BoardMemberRow,
  type BoardRow,
  type CardAggregates,
} from "./rows";
import type {
  Board,
  BoardActivityEntry,
  BoardCard,
  BoardList,
  BoardSnapshot,
  BoardSummary,
} from "./types";

/**
 * PostgREST puts `.in(...)` values in the URL, so an unbounded id list would
 * eventually blow the request line. Chunking keeps the query count constant in
 * practice (one per ~200 cards) while staying safely under any URL limit.
 */
const IN_CHUNK = 200;

async function chunked<T>(ids: string[], run: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  if (ids.length === 0) return [];
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    out.push(...(await run(ids.slice(i, i + IN_CHUNK))));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

export interface ActivityInput {
  boardId: string;
  cardId?: string | null;
  actorId?: string | null;
  actionType: string;
  metadata?: Record<string, unknown>;
}

/**
 * Record an event. Deliberately best-effort: a failure to write the audit trail
 * must not fail (or worse, half-fail) the user's actual edit, which has already
 * been committed by the time we get here. The error is surfaced on the server
 * log instead of the response.
 */
export async function logActivity(input: ActivityInput): Promise<void> {
  const sb = getServerSupabase();
  const { error } = await sb.from("board_activity").insert({
    board_id: input.boardId,
    card_id: input.cardId ?? null,
    actor_member_id: input.actorId ?? null,
    action_type: input.actionType,
    metadata: input.metadata ?? {},
  });
  if (error) console.error("[boards] activity write failed:", error.message);
}

// ---------------------------------------------------------------------------
// Boards
// ---------------------------------------------------------------------------

export async function listBoards(includeArchived = false): Promise<BoardSummary[]> {
  const sb = getServerSupabase();

  let query = sb.from("boards").select("*").order("updated_at", { ascending: false }).limit(200);
  if (!includeArchived) query = query.is("archived_at", null);
  const boards = ((await query).data ?? []) as BoardRow[];
  if (boards.length === 0) return [];

  const ids = boards.map((b) => b.id);

  // Three grouped counts. PostgREST cannot GROUP BY, so we pull the (small)
  // id columns and tally in memory — still three round trips regardless of how
  // many boards exist, which is the property that matters.
  const [listRows, cardRows, memberRows] = await Promise.all([
    chunked(ids, async (chunk) =>
      ((
        await sb.from("board_lists").select("board_id").in("board_id", chunk).is("archived_at", null)
      ).data ?? []) as { board_id: string }[],
    ),
    chunked(ids, async (chunk) =>
      ((
        await sb.from("board_cards").select("board_id").in("board_id", chunk).is("archived_at", null)
      ).data ?? []) as { board_id: string }[],
    ),
    chunked(ids, async (chunk) =>
      ((await sb.from("board_members").select("board_id").in("board_id", chunk)).data ??
        []) as { board_id: string }[],
    ),
  ]);

  const tally = (rows: { board_id: string }[]): Map<string, number> => {
    const map = new Map<string, number>();
    for (const row of rows) map.set(row.board_id, (map.get(row.board_id) ?? 0) + 1);
    return map;
  };
  const lists = tally(listRows);
  const cards = tally(cardRows);
  const members = tally(memberRows);

  return boards.map((row) => ({
    ...mapBoard(row),
    listCount: lists.get(row.id) ?? 0,
    cardCount: cards.get(row.id) ?? 0,
    memberCount: members.get(row.id) ?? 0,
  }));
}

export interface CreateBoardInput {
  name: string;
  description?: string;
  ownerName: string;
  theme?: string;
  visibility?: "workspace" | "private";
  projectId?: string | null;
  listTitles?: string[];
}

/**
 * Create a board with its owner, starter columns and label palette. Delegates
 * to the `board_create` SQL function so all of that is one transaction — see
 * the note in migration 0037 about why a half-created board is unrecoverable.
 */
export async function createBoard(input: CreateBoardInput): Promise<Board> {
  const sb = getServerSupabase();
  const { data, error } = await sb.rpc("board_create", {
    p_name: input.name,
    p_description: input.description ?? "",
    p_owner_name: input.ownerName,
    p_theme: input.theme ?? "indigo",
    p_visibility: input.visibility ?? "workspace",
    p_project_id: input.projectId ?? null,
    ...(input.listTitles ? { p_list_titles: input.listTitles } : {}),
  });
  if (error) throw new BoardError(`Could not create board: ${error.message}`, 500, "database_error");

  const boardId = data as string;
  return getBoard(boardId);
}

export async function getBoard(boardId: string): Promise<Board> {
  const sb = getServerSupabase();
  const row = unwrap(await sb.from("boards").select("*").eq("id", boardId).maybeSingle(), "Board");
  return mapBoard(row as BoardRow);
}

/** The counter the SSE stream polls. Cheap by design — one column, one row. */
export async function getBoardRevision(boardId: string): Promise<number | null> {
  const sb = getServerSupabase();
  const { data } = await sb.from("boards").select("revision").eq("id", boardId).maybeSingle();
  return data ? Number((data as { revision: number }).revision) : null;
}

export interface UpdateBoardInput {
  name?: string;
  description?: string;
  theme?: string;
  visibility?: "workspace" | "private";
  archived?: boolean;
}

export async function updateBoard(
  boardId: string,
  input: UpdateBoardInput,
  actorId: string | null,
): Promise<Board> {
  const sb = getServerSupabase();
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  if (input.theme !== undefined) patch.theme = input.theme;
  if (input.visibility !== undefined) patch.visibility = input.visibility;
  if (input.archived !== undefined) patch.archived_at = input.archived ? new Date().toISOString() : null;
  if (Object.keys(patch).length === 0) return getBoard(boardId);

  const row = unwrap(
    await sb.from("boards").update(patch).eq("id", boardId).select("*").maybeSingle(),
    "Board",
  );

  await logActivity({
    boardId,
    actorId,
    actionType: input.archived ? BOARD_ACTIONS.boardArchived : BOARD_ACTIONS.boardUpdated,
    metadata: { name: input.name ?? null },
  });

  return mapBoard(row as BoardRow);
}

/** Hard delete. Every child table cascades from `boards`, so this is one statement. */
export async function deleteBoard(boardId: string): Promise<void> {
  const sb = getServerSupabase();
  unwrapVoid(await sb.from("boards").delete().eq("id", boardId), "Delete board");
}

// ---------------------------------------------------------------------------
// Snapshot — everything the board page renders, in a fixed number of queries.
// ---------------------------------------------------------------------------

export async function getBoardSnapshot(boardId: string): Promise<BoardSnapshot> {
  const sb = getServerSupabase();

  const boardRow = unwrap(
    await sb.from("boards").select("*").eq("id", boardId).maybeSingle(),
    "Board",
  );

  const [members, labels, lists, cards] = await Promise.all([
    sb.from("board_members").select("*").eq("board_id", boardId).order("created_at"),
    sb.from("board_labels").select("*").eq("board_id", boardId).order("position"),
    sb
      .from("board_lists")
      .select("*")
      .eq("board_id", boardId)
      .is("archived_at", null)
      .order("position"),
    sb
      .from("board_cards")
      .select("*")
      .eq("board_id", boardId)
      .is("archived_at", null)
      .order("position"),
  ]);

  const cardRows = (cards.data ?? []) as BoardCardRow[];
  const aggregates = await loadCardAggregates(
    boardId,
    cardRows.map((c) => c.id),
  );

  return {
    board: mapBoard(boardRow as BoardRow),
    members: ((members.data ?? []) as BoardMemberRow[]).map(mapMember),
    labels: ((labels.data ?? []) as BoardLabelRow[]).map(mapLabel),
    lists: ((lists.data ?? []) as BoardListRow[]).map(mapList),
    cards: cardRows.map((row) => mapCard(row, aggregates.get(row.id))),
  };
}

/**
 * Gather the preview metadata for a set of cards: labels, assignees, checklist
 * progress, comment and attachment counts.
 *
 * Six queries, whatever the card count — the alternative (per-card counts) is
 * the N+1 the brief calls out. Comments and attachments are filtered by
 * `board_id`, which is why those columns are denormalised in the schema.
 */
export async function loadCardAggregates(
  boardId: string,
  cardIds: string[],
): Promise<Map<string, CardAggregates>> {
  const sb = getServerSupabase();
  const result = new Map<string, CardAggregates>();
  if (cardIds.length === 0) return result;

  for (const id of cardIds) {
    result.set(id, {
      labelIds: [],
      memberIds: [],
      checklistTotal: 0,
      checklistDone: 0,
      commentCount: 0,
      attachmentCount: 0,
    });
  }

  const [labelLinks, memberLinks, checklists, comments, attachments] = await Promise.all([
    chunked(cardIds, async (chunk) =>
      ((await sb.from("board_card_labels").select("card_id, label_id").in("card_id", chunk)).data ??
        []) as { card_id: string; label_id: string }[],
    ),
    chunked(cardIds, async (chunk) =>
      ((await sb.from("board_card_members").select("card_id, member_id").in("card_id", chunk)).data ??
        []) as { card_id: string; member_id: string }[],
    ),
    chunked(cardIds, async (chunk) =>
      ((await sb.from("board_checklists").select("id, card_id").in("card_id", chunk)).data ??
        []) as { id: string; card_id: string }[],
    ),
    chunked(cardIds, async (chunk) =>
      ((await sb.from("board_card_comments").select("card_id").eq("board_id", boardId).in("card_id", chunk))
        .data ?? []) as { card_id: string }[],
    ),
    chunked(cardIds, async (chunk) =>
      ((
        await sb
          .from("board_card_attachments")
          .select("card_id")
          .eq("board_id", boardId)
          .in("card_id", chunk)
      ).data ?? []) as { card_id: string }[],
    ),
  ]);

  for (const link of labelLinks) result.get(link.card_id)?.labelIds.push(link.label_id);
  for (const link of memberLinks) result.get(link.card_id)?.memberIds.push(link.member_id);
  for (const row of comments) {
    const agg = result.get(row.card_id);
    if (agg) agg.commentCount += 1;
  }
  for (const row of attachments) {
    const agg = result.get(row.card_id);
    if (agg) agg.attachmentCount += 1;
  }

  // Checklist progress is two hops from a card, so it needs one more query —
  // still a single one for the whole board, not one per checklist.
  const checklistOwner = new Map(checklists.map((c) => [c.id, c.card_id]));
  const items = await chunked(
    [...checklistOwner.keys()],
    async (chunk) =>
      ((
        await sb.from("board_checklist_items").select("checklist_id, completed").in("checklist_id", chunk)
      ).data ?? []) as { checklist_id: string; completed: boolean }[],
  );
  for (const item of items) {
    const cardId = checklistOwner.get(item.checklist_id);
    const agg = cardId ? result.get(cardId) : undefined;
    if (!agg) continue;
    agg.checklistTotal += 1;
    if (item.completed) agg.checklistDone += 1;
  }

  return result;
}

/** One card with its preview metadata — used by every mutation's response. */
export async function getCard(boardId: string, cardId: string): Promise<BoardCard> {
  const sb = getServerSupabase();
  const row = unwrap(
    await sb.from("board_cards").select("*").eq("id", cardId).eq("board_id", boardId).maybeSingle(),
    "Card",
  ) as BoardCardRow;
  const aggregates = await loadCardAggregates(boardId, [cardId]);
  return mapCard(row, aggregates.get(cardId));
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

export async function createList(
  boardId: string,
  title: string,
  actorId: string | null,
): Promise<BoardList> {
  const sb = getServerSupabase();

  // Append: one step past the current last column, so adding a list never
  // narrows a gap and never needs a normalize.
  const { data: last } = await sb
    .from("board_lists")
    .select("position")
    .eq("board_id", boardId)
    .is("archived_at", null)
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();

  const position = positionBetween((last as { position: number } | null)?.position ?? null, null);
  const row = unwrap(
    await sb
      .from("board_lists")
      .insert({ board_id: boardId, title, position })
      .select("*")
      .maybeSingle(),
    "List",
  ) as BoardListRow;

  await logActivity({ boardId, actorId, actionType: BOARD_ACTIONS.listCreated, metadata: { title } });
  return mapList(row);
}

export async function updateList(
  boardId: string,
  listId: string,
  input: { title?: string; archived?: boolean },
  actorId: string | null,
): Promise<BoardList> {
  const sb = getServerSupabase();
  const existing = unwrap(
    await sb.from("board_lists").select("*").eq("id", listId).eq("board_id", boardId).maybeSingle(),
    "List",
  ) as BoardListRow;

  const patch: Record<string, unknown> = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.archived !== undefined) {
    patch.archived_at = input.archived ? new Date().toISOString() : null;
  }
  if (Object.keys(patch).length === 0) return mapList(existing);

  const row = unwrap(
    await sb.from("board_lists").update(patch).eq("id", listId).select("*").maybeSingle(),
    "List",
  ) as BoardListRow;

  if (input.title !== undefined && input.title !== existing.title) {
    await logActivity({
      boardId,
      actorId,
      actionType: BOARD_ACTIONS.listRenamed,
      metadata: { from: existing.title, to: input.title },
    });
  }
  if (input.archived) {
    await logActivity({
      boardId,
      actorId,
      actionType: BOARD_ACTIONS.listArchived,
      metadata: { title: existing.title },
    });
  }
  return mapList(row);
}

export async function deleteList(
  boardId: string,
  listId: string,
  actorId: string | null,
): Promise<void> {
  const sb = getServerSupabase();
  const existing = unwrap(
    await sb.from("board_lists").select("*").eq("id", listId).eq("board_id", boardId).maybeSingle(),
    "List",
  ) as BoardListRow;

  // Cards cascade from the list. Deleting is offered alongside archiving in the
  // UI precisely so this is a deliberate choice, not the only way to clear a
  // column.
  unwrapVoid(await sb.from("board_lists").delete().eq("id", listId), "Delete list");
  await logActivity({
    boardId,
    actorId,
    actionType: BOARD_ACTIONS.listDeleted,
    metadata: { title: existing.title },
  });
}

/**
 * Move one list to `targetIndex` among the board's visible columns.
 *
 * Index in, position out: the drag library reports an index, and this turns it
 * into a fractional position against the column order as it exists right now.
 */
export async function moveList(
  boardId: string,
  listId: string,
  targetIndex: number,
  actorId: string | null,
): Promise<BoardList> {
  const sb = getServerSupabase();
  const position = await resolveListPosition(boardId, listId, targetIndex);

  const row = unwrap(
    await sb
      .from("board_lists")
      .update({ position })
      .eq("id", listId)
      .eq("board_id", boardId)
      .select("*")
      .maybeSingle(),
    "List",
  ) as BoardListRow;

  await logActivity({
    boardId,
    actorId,
    actionType: BOARD_ACTIONS.listsReordered,
    metadata: { listId, targetIndex },
  });
  return mapList(row);
}

async function readListOrder(boardId: string): Promise<{ id: string; position: number }[]> {
  const sb = getServerSupabase();
  const { data } = await sb
    .from("board_lists")
    .select("id, position")
    .eq("board_id", boardId)
    .is("archived_at", null)
    .order("position");
  return (data ?? []) as { id: string; position: number }[];
}

async function resolveListPosition(
  boardId: string,
  listId: string,
  targetIndex: number,
): Promise<number> {
  const sb = getServerSupabase();
  let order = await readListOrder(boardId);
  let { prev, next } = neighborsForIndex(order, targetIndex, listId);

  // Gap too small to split: renumber the whole column first, then recompute
  // against the fresh spacing. Rare (it takes ~50 drops between the same pair),
  // and cheap when it happens — one UPDATE ... FROM in the database.
  if (needsNormalize(prev, next)) {
    unwrapVoid(
      await sb.rpc("board_normalize_list_positions", { p_board_id: boardId }),
      "Normalize list positions",
    );
    order = await readListOrder(boardId);
    ({ prev, next } = neighborsForIndex(order, targetIndex, listId));
  }
  return positionBetween(prev, next);
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

async function readCardOrder(listId: string): Promise<{ id: string; position: number }[]> {
  const sb = getServerSupabase();
  const { data } = await sb
    .from("board_cards")
    .select("id, position")
    .eq("list_id", listId)
    .is("archived_at", null)
    .order("position");
  return (data ?? []) as { id: string; position: number }[];
}

async function resolveCardPosition(
  listId: string,
  targetIndex: number,
  movingId?: string,
): Promise<number> {
  const sb = getServerSupabase();
  let order = await readCardOrder(listId);
  let { prev, next } = neighborsForIndex(order, targetIndex, movingId);

  if (needsNormalize(prev, next)) {
    unwrapVoid(
      await sb.rpc("board_normalize_card_positions", { p_list_id: listId }),
      "Normalize card positions",
    );
    order = await readCardOrder(listId);
    ({ prev, next } = neighborsForIndex(order, targetIndex, movingId));
  }
  return positionBetween(prev, next);
}

export interface CreateCardInput {
  listId: string;
  title: string;
  description?: string;
  /** Omitted means "append to the end of the list" — the add-a-card default. */
  targetIndex?: number;
}

export async function createCard(
  boardId: string,
  input: CreateCardInput,
  actorId: string | null,
): Promise<BoardCard> {
  const sb = getServerSupabase();

  const list = unwrap(
    await sb
      .from("board_lists")
      .select("id, title")
      .eq("id", input.listId)
      .eq("board_id", boardId)
      .maybeSingle(),
    "List",
  ) as { id: string; title: string };

  const position =
    input.targetIndex === undefined
      ? await appendCardPosition(input.listId)
      : await resolveCardPosition(input.listId, input.targetIndex);

  const row = unwrap(
    await sb
      .from("board_cards")
      .insert({
        board_id: boardId,
        list_id: input.listId,
        title: input.title,
        description: input.description ?? "",
        position,
        created_by: actorId,
      })
      .select("*")
      .maybeSingle(),
    "Card",
  ) as BoardCardRow;

  await logActivity({
    boardId,
    cardId: row.id,
    actorId,
    actionType: BOARD_ACTIONS.cardCreated,
    metadata: { title: input.title, listId: list.id, listTitle: list.title },
  });

  return mapCard(row);
}

async function appendCardPosition(listId: string): Promise<number> {
  const sb = getServerSupabase();
  const { data } = await sb
    .from("board_cards")
    .select("position")
    .eq("list_id", listId)
    .is("archived_at", null)
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();
  const last = (data as { position: number } | null)?.position ?? null;
  return last == null ? POSITION_STEP : last + POSITION_STEP;
}

export interface UpdateCardInput {
  title?: string;
  description?: string;
  completed?: boolean;
  startAt?: string | null;
  dueAt?: string | null;
  coverColor?: string | null;
  coverImageUrl?: string | null;
  archived?: boolean;
}

export async function updateCard(
  boardId: string,
  cardId: string,
  input: UpdateCardInput,
  actorId: string | null,
): Promise<BoardCard> {
  const sb = getServerSupabase();
  const existing = unwrap(
    await sb.from("board_cards").select("*").eq("id", cardId).eq("board_id", boardId).maybeSingle(),
    "Card",
  ) as BoardCardRow;

  const patch: Record<string, unknown> = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.description !== undefined) patch.description = input.description;
  if (input.completed !== undefined) patch.completed = input.completed;
  if (input.startAt !== undefined) patch.start_at = input.startAt;
  if (input.dueAt !== undefined) patch.due_at = input.dueAt;
  if (input.coverColor !== undefined) patch.cover_color = input.coverColor;
  if (input.coverImageUrl !== undefined) patch.cover_image_url = input.coverImageUrl;
  if (input.archived !== undefined) {
    patch.archived_at = input.archived ? new Date().toISOString() : null;
  }
  if (Object.keys(patch).length === 0) return getCard(boardId, cardId);

  unwrap(
    await sb.from("board_cards").update(patch).eq("id", cardId).select("id").maybeSingle(),
    "Card",
  );

  // One activity entry per meaningful change, so the feed reads as a history of
  // decisions rather than a stream of "updated the card".
  if (input.title !== undefined && input.title !== existing.title) {
    await logActivity({
      boardId,
      cardId,
      actorId,
      actionType: BOARD_ACTIONS.cardRenamed,
      metadata: { from: existing.title, to: input.title },
    });
  }
  if (input.description !== undefined && input.description !== existing.description) {
    await logActivity({ boardId, cardId, actorId, actionType: BOARD_ACTIONS.cardDescribed });
  }
  if (input.completed !== undefined && input.completed !== existing.completed) {
    await logActivity({
      boardId,
      cardId,
      actorId,
      actionType: input.completed ? BOARD_ACTIONS.cardCompleted : BOARD_ACTIONS.cardReopened,
    });
  }
  if (
    (input.dueAt !== undefined && input.dueAt !== existing.due_at) ||
    (input.startAt !== undefined && input.startAt !== existing.start_at)
  ) {
    await logActivity({
      boardId,
      cardId,
      actorId,
      actionType: BOARD_ACTIONS.cardDatesChanged,
      metadata: { dueAt: input.dueAt ?? existing.due_at, startAt: input.startAt ?? existing.start_at },
    });
  }
  if (input.archived !== undefined && input.archived !== (existing.archived_at != null)) {
    await logActivity({
      boardId,
      cardId,
      actorId,
      actionType: input.archived ? BOARD_ACTIONS.cardArchived : BOARD_ACTIONS.cardRestored,
      metadata: { title: existing.title },
    });
  }

  return getCard(boardId, cardId);
}

/**
 * Move a card within or between lists.
 *
 * The write itself goes through the `board_move_card` SQL function: it takes a
 * row lock, re-checks that the destination list is on the same board (defence
 * against a crafted request), updates position + list_id, and writes the
 * activity entry — all in one transaction.
 */
export async function moveCard(
  boardId: string,
  cardId: string,
  input: { listId: string; targetIndex: number },
  actorId: string | null,
): Promise<BoardCard> {
  const sb = getServerSupabase();

  const card = unwrap(
    await sb
      .from("board_cards")
      .select("id, list_id")
      .eq("id", cardId)
      .eq("board_id", boardId)
      .maybeSingle(),
    "Card",
  ) as { id: string; list_id: string };

  const list = unwrap(
    await sb
      .from("board_lists")
      .select("id")
      .eq("id", input.listId)
      .eq("board_id", boardId)
      .maybeSingle(),
    "List",
  );
  if (!list) throw new BoardNotFoundError("List");

  // Only exclude the card from the neighbour scan when it is already in the
  // destination list — otherwise it is not part of that column's order at all.
  const movingWithin = card.list_id === input.listId ? cardId : undefined;
  const position = await resolveCardPosition(input.listId, input.targetIndex, movingWithin);

  const { error } = await sb.rpc("board_move_card", {
    p_card_id: cardId,
    p_list_id: input.listId,
    p_position: position,
    p_actor: actorId,
  });
  if (error) {
    if (error.message.includes("list_not_on_board")) {
      throw new BoardValidationError("That list is not on this board.");
    }
    if (error.message.includes("card_not_found")) throw new BoardNotFoundError("Card");
    throw new BoardError(`Could not move card: ${error.message}`, 500, "database_error");
  }

  return getCard(boardId, cardId);
}

export async function deleteCard(
  boardId: string,
  cardId: string,
  actorId: string | null,
): Promise<void> {
  const sb = getServerSupabase();
  const existing = unwrap(
    await sb
      .from("board_cards")
      .select("id, title")
      .eq("id", cardId)
      .eq("board_id", boardId)
      .maybeSingle(),
    "Card",
  ) as { id: string; title: string };

  unwrapVoid(await sb.from("board_cards").delete().eq("id", cardId), "Delete card");
  // card_id is ON DELETE CASCADE, so this entry deliberately carries no card_id
  // — it is board history about a card that no longer exists.
  await logActivity({
    boardId,
    actorId,
    actionType: BOARD_ACTIONS.cardDeleted,
    metadata: { title: existing.title },
  });
}

// ---------------------------------------------------------------------------
// Activity feed
// ---------------------------------------------------------------------------

export async function getActivity(
  boardId: string,
  options: { cardId?: string; limit?: number } = {},
): Promise<BoardActivityEntry[]> {
  const sb = getServerSupabase();
  let query = sb
    .from("board_activity")
    .select("*")
    .eq("board_id", boardId)
    .order("created_at", { ascending: false })
    .limit(Math.min(options.limit ?? 50, 200));
  if (options.cardId) query = query.eq("card_id", options.cardId);
  const { data } = await query;
  return ((data ?? []) as BoardActivityRow[]).map(mapActivity);
}
