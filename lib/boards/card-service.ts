// Card-detail data access: labels, assignments, checklists, comments and
// attachments — plus board membership, which is managed from the same screens.
//
// Split out of ./service.ts purely for size; the same rules apply (this is the
// only layer that names a table, every relation read is bounded, and every
// mutation records structured activity).

import { getServerSupabase } from "@/lib/supabase/server";
import { BoardError, BoardNotFoundError, unwrap, unwrapVoid } from "./errors";
import { positionBetween, neighborsForIndex, needsNormalize, POSITION_STEP } from "./position";
import { BOARD_ACTIONS } from "./activity";
import { getActivity, getCard, logActivity } from "./service";
import { colorForName } from "./theme";
import {
  mapAttachment,
  mapChecklist,
  mapChecklistItem,
  mapComment,
  mapLabel,
  mapMember,
  type BoardAttachmentRow,
  type BoardChecklistItemRow,
  type BoardChecklistRow,
  type BoardCommentRow,
  type BoardLabelRow,
  type BoardMemberRow,
} from "./rows";
import type {
  BoardAttachment,
  BoardCardDetail,
  BoardChecklist,
  BoardChecklistItem,
  BoardComment,
  BoardLabel,
  BoardMember,
  BoardRole,
} from "./types";

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

export async function listMembers(boardId: string): Promise<BoardMember[]> {
  const sb = getServerSupabase();
  const { data } = await sb
    .from("board_members")
    .select("*")
    .eq("board_id", boardId)
    .order("created_at");
  return ((data ?? []) as BoardMemberRow[]).map(mapMember);
}

export async function addMember(
  boardId: string,
  input: { displayName: string; role?: BoardRole; color?: string },
): Promise<BoardMember> {
  const sb = getServerSupabase();
  const { data, error } = await sb
    .from("board_members")
    .insert({
      board_id: boardId,
      display_name: input.displayName,
      role: input.role ?? "member",
      color: input.color ?? colorForName(input.displayName),
    })
    .select("*")
    .maybeSingle();

  // 23505 = the (board_id, lower(display_name)) unique index. Surfaced as a 409
  // with a readable message rather than a raw constraint name.
  if (error) {
    if (error.code === "23505") {
      throw new BoardError("Someone with that name is already on this board.", 409, "duplicate_member");
    }
    throw new BoardError(error.message, 500, "database_error");
  }
  return mapMember(data as BoardMemberRow);
}

export async function updateMember(
  boardId: string,
  memberId: string,
  input: { displayName?: string; role?: BoardRole; color?: string },
): Promise<BoardMember> {
  const sb = getServerSupabase();
  const patch: Record<string, unknown> = {};
  if (input.displayName !== undefined) patch.display_name = input.displayName;
  if (input.role !== undefined) patch.role = input.role;
  if (input.color !== undefined) patch.color = input.color;

  const row = unwrap(
    await sb
      .from("board_members")
      .update(patch)
      .eq("id", memberId)
      .eq("board_id", boardId)
      .select("*")
      .maybeSingle(),
    "Member",
  );
  return mapMember(row as BoardMemberRow);
}

export async function removeMember(boardId: string, memberId: string): Promise<void> {
  const sb = getServerSupabase();

  // The owner is the board's last line of governance — removing them would
  // leave a board nobody can restructure, since roles cannot be reassigned
  // without an owner.
  const { data: board } = await sb
    .from("boards")
    .select("owner_member_id")
    .eq("id", boardId)
    .maybeSingle();
  if ((board as { owner_member_id: string | null } | null)?.owner_member_id === memberId) {
    throw new BoardError("Transfer ownership before removing the board owner.", 409, "owner_required");
  }

  unwrapVoid(
    await sb.from("board_members").delete().eq("id", memberId).eq("board_id", boardId),
    "Remove member",
  );
}

// ---------------------------------------------------------------------------
// Labels (board palette)
// ---------------------------------------------------------------------------

export async function listLabels(boardId: string): Promise<BoardLabel[]> {
  const sb = getServerSupabase();
  const { data } = await sb.from("board_labels").select("*").eq("board_id", boardId).order("position");
  return ((data ?? []) as BoardLabelRow[]).map(mapLabel);
}

export async function createLabel(
  boardId: string,
  input: { name: string; color: string },
): Promise<BoardLabel> {
  const sb = getServerSupabase();
  const { data: last } = await sb
    .from("board_labels")
    .select("position")
    .eq("board_id", boardId)
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();

  const row = unwrap(
    await sb
      .from("board_labels")
      .insert({
        board_id: boardId,
        name: input.name,
        color: input.color,
        position: ((last as { position: number } | null)?.position ?? 0) + POSITION_STEP,
      })
      .select("*")
      .maybeSingle(),
    "Label",
  );
  return mapLabel(row as BoardLabelRow);
}

export async function updateLabel(
  boardId: string,
  labelId: string,
  input: { name?: string; color?: string },
): Promise<BoardLabel> {
  const sb = getServerSupabase();
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.color !== undefined) patch.color = input.color;

  const row = unwrap(
    await sb
      .from("board_labels")
      .update(patch)
      .eq("id", labelId)
      .eq("board_id", boardId)
      .select("*")
      .maybeSingle(),
    "Label",
  );
  return mapLabel(row as BoardLabelRow);
}

/** Deleting a label detaches it from every card via the junction's cascade. */
export async function deleteLabel(boardId: string, labelId: string): Promise<void> {
  const sb = getServerSupabase();
  unwrapVoid(
    await sb.from("board_labels").delete().eq("id", labelId).eq("board_id", boardId),
    "Delete label",
  );
}

// ---------------------------------------------------------------------------
// Card ↔ label / member links
// ---------------------------------------------------------------------------

export async function setCardLabel(
  boardId: string,
  cardId: string,
  labelId: string,
  attached: boolean,
  actorId: string | null,
): Promise<void> {
  const sb = getServerSupabase();
  const label = unwrap(
    await sb
      .from("board_labels")
      .select("id, name, color")
      .eq("id", labelId)
      .eq("board_id", boardId)
      .maybeSingle(),
    "Label",
  ) as { id: string; name: string; color: string };

  if (attached) {
    // Idempotent: re-adding a label a teammate added a second earlier is a
    // no-op, not a 409 in the middle of someone's click.
    const { error } = await sb
      .from("board_card_labels")
      .upsert({ card_id: cardId, label_id: labelId }, { onConflict: "card_id,label_id" });
    if (error) throw new BoardError(error.message, 500, "database_error");
  } else {
    unwrapVoid(
      await sb.from("board_card_labels").delete().eq("card_id", cardId).eq("label_id", labelId),
      "Remove label",
    );
  }

  await logActivity({
    boardId,
    cardId,
    actorId,
    actionType: attached ? BOARD_ACTIONS.labelAdded : BOARD_ACTIONS.labelRemoved,
    metadata: { labelId, labelName: label.name, labelColor: label.color },
  });
}

export async function setCardMember(
  boardId: string,
  cardId: string,
  memberId: string,
  assigned: boolean,
  actorId: string | null,
): Promise<void> {
  const sb = getServerSupabase();
  const member = unwrap(
    await sb
      .from("board_members")
      .select("id, display_name")
      .eq("id", memberId)
      .eq("board_id", boardId)
      .maybeSingle(),
    "Member",
  ) as { id: string; display_name: string };

  if (assigned) {
    const { error } = await sb
      .from("board_card_members")
      .upsert({ card_id: cardId, member_id: memberId }, { onConflict: "card_id,member_id" });
    if (error) throw new BoardError(error.message, 500, "database_error");
  } else {
    unwrapVoid(
      await sb.from("board_card_members").delete().eq("card_id", cardId).eq("member_id", memberId),
      "Unassign member",
    );
  }

  await logActivity({
    boardId,
    cardId,
    actorId,
    actionType: assigned ? BOARD_ACTIONS.memberAssigned : BOARD_ACTIONS.memberUnassigned,
    metadata: { memberId, memberName: member.display_name },
  });
}

// ---------------------------------------------------------------------------
// Checklists
// ---------------------------------------------------------------------------

export async function listChecklists(cardId: string): Promise<BoardChecklist[]> {
  const sb = getServerSupabase();
  const { data: lists } = await sb
    .from("board_checklists")
    .select("*")
    .eq("card_id", cardId)
    .order("position");
  const rows = (lists ?? []) as BoardChecklistRow[];
  if (rows.length === 0) return [];

  // One query for every item on the card, grouped in memory — not one per
  // checklist.
  const { data: items } = await sb
    .from("board_checklist_items")
    .select("*")
    .in(
      "checklist_id",
      rows.map((r) => r.id),
    )
    .order("position");

  const grouped = new Map<string, BoardChecklistItem[]>();
  for (const row of (items ?? []) as BoardChecklistItemRow[]) {
    const bucket = grouped.get(row.checklist_id) ?? [];
    bucket.push(mapChecklistItem(row));
    grouped.set(row.checklist_id, bucket);
  }
  return rows.map((row) => mapChecklist(row, grouped.get(row.id) ?? []));
}

export async function createChecklist(
  boardId: string,
  cardId: string,
  title: string,
  actorId: string | null,
): Promise<BoardChecklist> {
  const sb = getServerSupabase();
  const { data: last } = await sb
    .from("board_checklists")
    .select("position")
    .eq("card_id", cardId)
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();

  const row = unwrap(
    await sb
      .from("board_checklists")
      .insert({
        card_id: cardId,
        title,
        position: ((last as { position: number } | null)?.position ?? 0) + POSITION_STEP,
      })
      .select("*")
      .maybeSingle(),
    "Checklist",
  ) as BoardChecklistRow;

  await logActivity({
    boardId,
    cardId,
    actorId,
    actionType: BOARD_ACTIONS.checklistCreated,
    metadata: { title },
  });
  return mapChecklist(row, []);
}

/** Confirms a checklist hangs off a card that is on this board. */
async function assertChecklistOnBoard(boardId: string, checklistId: string): Promise<string> {
  const sb = getServerSupabase();
  const row = unwrap(
    await sb.from("board_checklists").select("id, card_id").eq("id", checklistId).maybeSingle(),
    "Checklist",
  ) as { id: string; card_id: string };
  const card = unwrap(
    await sb
      .from("board_cards")
      .select("id")
      .eq("id", row.card_id)
      .eq("board_id", boardId)
      .maybeSingle(),
    "Card",
  );
  if (!card) throw new BoardNotFoundError("Checklist");
  return row.card_id;
}

export async function updateChecklist(
  boardId: string,
  checklistId: string,
  title: string,
  actorId: string | null,
): Promise<BoardChecklist> {
  const sb = getServerSupabase();
  const cardId = await assertChecklistOnBoard(boardId, checklistId);
  const row = unwrap(
    await sb
      .from("board_checklists")
      .update({ title })
      .eq("id", checklistId)
      .select("*")
      .maybeSingle(),
    "Checklist",
  ) as BoardChecklistRow;

  await logActivity({
    boardId,
    cardId,
    actorId,
    actionType: BOARD_ACTIONS.checklistRenamed,
    metadata: { to: title },
  });
  return mapChecklist(row, []);
}

export async function deleteChecklist(
  boardId: string,
  checklistId: string,
  actorId: string | null,
): Promise<void> {
  const sb = getServerSupabase();
  const cardId = await assertChecklistOnBoard(boardId, checklistId);
  const { data: existing } = await sb
    .from("board_checklists")
    .select("title")
    .eq("id", checklistId)
    .maybeSingle();

  unwrapVoid(await sb.from("board_checklists").delete().eq("id", checklistId), "Delete checklist");
  await logActivity({
    boardId,
    cardId,
    actorId,
    actionType: BOARD_ACTIONS.checklistDeleted,
    metadata: { title: (existing as { title: string } | null)?.title ?? "" },
  });
}

export async function createChecklistItem(
  boardId: string,
  checklistId: string,
  input: { title: string; assigneeMemberId?: string | null; dueAt?: string | null },
  actorId: string | null,
): Promise<BoardChecklistItem> {
  const sb = getServerSupabase();
  const cardId = await assertChecklistOnBoard(boardId, checklistId);

  const { data: last } = await sb
    .from("board_checklist_items")
    .select("position")
    .eq("checklist_id", checklistId)
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();

  const row = unwrap(
    await sb
      .from("board_checklist_items")
      .insert({
        checklist_id: checklistId,
        title: input.title,
        assignee_member_id: input.assigneeMemberId ?? null,
        due_at: input.dueAt ?? null,
        position: ((last as { position: number } | null)?.position ?? 0) + POSITION_STEP,
      })
      .select("*")
      .maybeSingle(),
    "Checklist item",
  ) as BoardChecklistItemRow;

  await logActivity({
    boardId,
    cardId,
    actorId,
    actionType: BOARD_ACTIONS.checklistItemAdded,
    metadata: { title: input.title },
  });
  return mapChecklistItem(row);
}

export async function updateChecklistItem(
  boardId: string,
  itemId: string,
  input: {
    title?: string;
    completed?: boolean;
    assigneeMemberId?: string | null;
    dueAt?: string | null;
    targetIndex?: number;
  },
  actorId: string | null,
): Promise<BoardChecklistItem> {
  const sb = getServerSupabase();
  const existing = unwrap(
    await sb.from("board_checklist_items").select("*").eq("id", itemId).maybeSingle(),
    "Checklist item",
  ) as BoardChecklistItemRow;
  const cardId = await assertChecklistOnBoard(boardId, existing.checklist_id);

  const patch: Record<string, unknown> = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.completed !== undefined) patch.completed = input.completed;
  if (input.assigneeMemberId !== undefined) patch.assignee_member_id = input.assigneeMemberId;
  if (input.dueAt !== undefined) patch.due_at = input.dueAt;
  if (input.targetIndex !== undefined) {
    patch.position = await resolveChecklistItemPosition(existing.checklist_id, input.targetIndex, itemId);
  }
  if (Object.keys(patch).length === 0) return mapChecklistItem(existing);

  const row = unwrap(
    await sb.from("board_checklist_items").update(patch).eq("id", itemId).select("*").maybeSingle(),
    "Checklist item",
  ) as BoardChecklistItemRow;

  if (input.completed !== undefined && input.completed !== existing.completed) {
    await logActivity({
      boardId,
      cardId,
      actorId,
      actionType: input.completed
        ? BOARD_ACTIONS.checklistItemCompleted
        : BOARD_ACTIONS.checklistItemReopened,
      metadata: { title: row.title },
    });
  }
  return mapChecklistItem(row);
}

async function resolveChecklistItemPosition(
  checklistId: string,
  targetIndex: number,
  movingId: string,
): Promise<number> {
  const sb = getServerSupabase();
  const { data } = await sb
    .from("board_checklist_items")
    .select("id, position")
    .eq("checklist_id", checklistId)
    .order("position");
  const order = (data ?? []) as { id: string; position: number }[];
  const { prev, next } = neighborsForIndex(order, targetIndex, movingId);

  // Checklists are short enough that renumbering them costs nothing, so unlike
  // cards they are rewritten in place rather than going through a SQL function.
  if (needsNormalize(prev, next)) {
    const renumbered = order.map((row, i) => ({ id: row.id, position: (i + 1) * POSITION_STEP }));
    await Promise.all(
      renumbered.map((row) =>
        sb.from("board_checklist_items").update({ position: row.position }).eq("id", row.id),
      ),
    );
    const after = neighborsForIndex(renumbered, targetIndex, movingId);
    return positionBetween(after.prev, after.next);
  }
  return positionBetween(prev, next);
}

export async function deleteChecklistItem(
  boardId: string,
  itemId: string,
  actorId: string | null,
): Promise<void> {
  const sb = getServerSupabase();
  const existing = unwrap(
    await sb.from("board_checklist_items").select("*").eq("id", itemId).maybeSingle(),
    "Checklist item",
  ) as BoardChecklistItemRow;
  const cardId = await assertChecklistOnBoard(boardId, existing.checklist_id);

  unwrapVoid(await sb.from("board_checklist_items").delete().eq("id", itemId), "Delete item");
  await logActivity({
    boardId,
    cardId,
    actorId,
    actionType: BOARD_ACTIONS.checklistItemDeleted,
    metadata: { title: existing.title },
  });
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

export async function listComments(cardId: string): Promise<BoardComment[]> {
  const sb = getServerSupabase();
  const { data } = await sb
    .from("board_card_comments")
    .select("*")
    .eq("card_id", cardId)
    .order("created_at", { ascending: false })
    .limit(200);
  return ((data ?? []) as BoardCommentRow[]).map(mapComment);
}

export async function createComment(
  boardId: string,
  cardId: string,
  content: string,
  actorId: string | null,
): Promise<BoardComment> {
  const sb = getServerSupabase();
  const row = unwrap(
    await sb
      .from("board_card_comments")
      .insert({ board_id: boardId, card_id: cardId, author_member_id: actorId, content })
      .select("*")
      .maybeSingle(),
    "Comment",
  ) as BoardCommentRow;

  await logActivity({ boardId, cardId, actorId, actionType: BOARD_ACTIONS.commentCreated });
  return mapComment(row);
}

/** Read a comment for the permission check in the route handler. */
export async function getComment(boardId: string, commentId: string): Promise<BoardComment> {
  const sb = getServerSupabase();
  const row = unwrap(
    await sb
      .from("board_card_comments")
      .select("*")
      .eq("id", commentId)
      .eq("board_id", boardId)
      .maybeSingle(),
    "Comment",
  );
  return mapComment(row as BoardCommentRow);
}

export async function updateComment(
  boardId: string,
  commentId: string,
  content: string,
): Promise<BoardComment> {
  const sb = getServerSupabase();
  const row = unwrap(
    await sb
      .from("board_card_comments")
      .update({ content })
      .eq("id", commentId)
      .eq("board_id", boardId)
      .select("*")
      .maybeSingle(),
    "Comment",
  );
  return mapComment(row as BoardCommentRow);
}

export async function deleteComment(
  boardId: string,
  commentId: string,
  actorId: string | null,
): Promise<void> {
  const sb = getServerSupabase();
  const existing = await getComment(boardId, commentId);
  unwrapVoid(
    await sb.from("board_card_comments").delete().eq("id", commentId).eq("board_id", boardId),
    "Delete comment",
  );
  await logActivity({
    boardId,
    cardId: existing.cardId,
    actorId,
    actionType: BOARD_ACTIONS.commentDeleted,
  });
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

export async function listAttachments(cardId: string): Promise<BoardAttachment[]> {
  const sb = getServerSupabase();
  const { data } = await sb
    .from("board_card_attachments")
    .select("*")
    .eq("card_id", cardId)
    .order("created_at", { ascending: false });
  return ((data ?? []) as BoardAttachmentRow[]).map(mapAttachment);
}

export async function createAttachment(
  boardId: string,
  cardId: string,
  input: {
    name: string;
    url: string;
    storageKey?: string | null;
    contentType?: string | null;
    sizeBytes?: number | null;
  },
  actorId: string | null,
): Promise<BoardAttachment> {
  const sb = getServerSupabase();
  const row = unwrap(
    await sb
      .from("board_card_attachments")
      .insert({
        board_id: boardId,
        card_id: cardId,
        name: input.name,
        url: input.url,
        storage_key: input.storageKey ?? null,
        content_type: input.contentType ?? null,
        size_bytes: input.sizeBytes ?? null,
        added_by: actorId,
      })
      .select("*")
      .maybeSingle(),
    "Attachment",
  ) as BoardAttachmentRow;

  await logActivity({
    boardId,
    cardId,
    actorId,
    actionType: BOARD_ACTIONS.attachmentAdded,
    metadata: { name: input.name, url: input.url },
  });
  return mapAttachment(row);
}

export async function deleteAttachment(
  boardId: string,
  attachmentId: string,
  actorId: string | null,
): Promise<void> {
  const sb = getServerSupabase();
  const existing = unwrap(
    await sb
      .from("board_card_attachments")
      .select("*")
      .eq("id", attachmentId)
      .eq("board_id", boardId)
      .maybeSingle(),
    "Attachment",
  ) as BoardAttachmentRow;

  unwrapVoid(
    await sb.from("board_card_attachments").delete().eq("id", attachmentId),
    "Delete attachment",
  );
  // NOTE: the R2 object behind `storage_key` is intentionally left in place —
  // deleting it here would break any other card or comment that links the same
  // URL. A sweeper can reclaim orphans later.
  await logActivity({
    boardId,
    cardId: existing.card_id,
    actorId,
    actionType: BOARD_ACTIONS.attachmentRemoved,
    metadata: { name: existing.name },
  });
}

// ---------------------------------------------------------------------------
// The detail payload
// ---------------------------------------------------------------------------

/**
 * Everything the card detail view shows. Fetched only when a card is opened, so
 * a board with a thousand comments still renders instantly.
 */
export async function getCardDetail(boardId: string, cardId: string): Promise<BoardCardDetail> {
  const [card, checklists, comments, attachments, activity] = await Promise.all([
    getCard(boardId, cardId),
    listChecklists(cardId),
    listComments(cardId),
    listAttachments(cardId),
    getActivity(boardId, { cardId, limit: 50 }),
  ]);
  return { card, checklists, comments, attachments, activity };
}
