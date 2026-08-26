import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { deleteComment, getComment, updateComment } from "@/lib/boards/card-service";
import { canDeleteComment, canEditComment } from "@/lib/boards/permissions";
import { authorizeBoardRequest, handleRouteError, jsonError, parseBody, parseUuid } from "@/lib/boards/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UpdateComment = z.object({ content: z.string().trim().min(1).max(10_000) });

/**
 * PATCH — authors only. The role check alone is not enough here: "can comment"
 * says nothing about WHOSE comment, so ownership is checked against the stored
 * author id, server-side, before the update.
 */
export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ boardId: string; commentId: string }> },
) {
  try {
    const { boardId, commentId } = await ctx.params;
    const access = await authorizeBoardRequest(req, boardId, "comment.write");
    const id = parseUuid(commentId, "comment id");
    const existing = await getComment(access.boardId, id);

    if (!canEditComment(access.role, access.actor?.id ?? null, existing.authorMemberId)) {
      return jsonError("You can only edit your own comments.", 403, "forbidden");
    }

    const { content } = await parseBody(req, UpdateComment);
    return NextResponse.json({ comment: await updateComment(access.boardId, id, content) });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** DELETE — the author, or the board owner acting as moderator. */
export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ boardId: string; commentId: string }> },
) {
  try {
    const { boardId, commentId } = await ctx.params;
    const access = await authorizeBoardRequest(req, boardId, "comment.write");
    const id = parseUuid(commentId, "comment id");
    const existing = await getComment(access.boardId, id);

    if (!canDeleteComment(access.role, access.actor?.id ?? null, existing.authorMemberId)) {
      return jsonError("You can only delete your own comments.", 403, "forbidden");
    }

    await deleteComment(access.boardId, id, access.actor?.id ?? null);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
