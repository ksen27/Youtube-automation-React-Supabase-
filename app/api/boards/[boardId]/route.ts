import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { deleteBoard, getBoardSnapshot, updateBoard } from "@/lib/boards/service";
import { authorizeBoardRequest, handleRouteError, parseBody, TitleSchema } from "@/lib/boards/http";
import { assertWritable } from "@/lib/boards/access";
import { BOARD_THEMES } from "@/lib/boards/theme";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UpdateBoard = z.object({
  name: TitleSchema.optional(),
  description: z.string().max(2000).optional(),
  theme: z.enum(BOARD_THEMES).optional(),
  visibility: z.enum(["workspace", "private"]).optional(),
  archived: z.boolean().optional(),
});

/** GET — the whole board in one response: board, members, labels, lists, cards. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ boardId: string }> }) {
  try {
    const { boardId } = await ctx.params;
    const access = await authorizeBoardRequest(req, boardId, "board.view");
    return NextResponse.json(await getBoardSnapshot(access.boardId));
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ boardId: string }> }) {
  try {
    const { boardId } = await ctx.params;
    // Archived boards are read-only everywhere else, but restoring one is
    // itself a write to an archived board — so this route opts out of the guard
    // and re-applies it below for everything except un-archiving.
    const access = await authorizeBoardRequest(req, boardId, "board.update", {
      allowArchived: true,
    });
    const input = await parseBody(req, UpdateBoard);
    if (access.archived && input.archived !== false) {
      assertWritable(access);
    }
    const board = await updateBoard(access.boardId, input, access.actor?.id ?? null);
    return NextResponse.json({ board });
  } catch (error) {
    return handleRouteError(error);
  }
}

/**
 * DELETE — permanent, and cascades to every list, card, comment and attachment
 * row. Owner only. The UI offers archiving first; this is the deliberate
 * escape hatch, not the default.
 */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ boardId: string }> }) {
  try {
    const { boardId } = await ctx.params;
    const access = await authorizeBoardRequest(req, boardId, "board.delete");
    await deleteBoard(access.boardId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
