import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { deleteList, moveList, updateList } from "@/lib/boards/service";
import {
  authorizeBoardRequest,
  handleRouteError,
  parseBody,
  parseUuid,
  TargetIndexSchema,
  TitleSchema,
} from "@/lib/boards/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UpdateList = z.object({
  title: TitleSchema.optional(),
  archived: z.boolean().optional(),
  // Reordering is a PATCH on the list rather than a bulk endpoint because a
  // drag moves exactly one column: the client sends where it landed, and the
  // server derives the position from the board's current order.
  targetIndex: TargetIndexSchema.optional(),
});

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ boardId: string; listId: string }> },
) {
  try {
    const { boardId, listId } = await ctx.params;
    const access = await authorizeBoardRequest(req, boardId, "list.manage");
    const id = parseUuid(listId, "list id");
    const input = await parseBody(req, UpdateList);
    const actorId = access.actor?.id ?? null;

    let list =
      input.title !== undefined || input.archived !== undefined
        ? await updateList(access.boardId, id, input, actorId)
        : null;

    if (input.targetIndex !== undefined) {
      list = await moveList(access.boardId, id, input.targetIndex, actorId);
    }

    // Neither field supplied: report the list unchanged rather than pretending
    // something happened.
    if (!list) list = await updateList(access.boardId, id, {}, actorId);
    return NextResponse.json({ list });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** DELETE — removes the column and, by cascade, the cards inside it. */
export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ boardId: string; listId: string }> },
) {
  try {
    const { boardId, listId } = await ctx.params;
    const access = await authorizeBoardRequest(req, boardId, "list.manage");
    await deleteList(access.boardId, parseUuid(listId, "list id"), access.actor?.id ?? null);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
