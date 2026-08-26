import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createComment, listComments } from "@/lib/boards/card-service";
import { assertCardOnBoard } from "@/lib/boards/access";
import { authorizeBoardRequest, handleRouteError, parseBody, parseUuid } from "@/lib/boards/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CreateComment = z.object({ content: z.string().trim().min(1).max(10_000) });

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ boardId: string; cardId: string }> },
) {
  try {
    const { boardId, cardId } = await ctx.params;
    const access = await authorizeBoardRequest(req, boardId, "board.view");
    const id = parseUuid(cardId, "card id");
    await assertCardOnBoard(access.boardId, id);
    return NextResponse.json({ comments: await listComments(id) });
  } catch (error) {
    return handleRouteError(error);
  }
}

/**
 * POST — viewers may comment too (see permissions.ts), which is why this
 * authorises `comment.write` rather than `card.write`.
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ boardId: string; cardId: string }> },
) {
  try {
    const { boardId, cardId } = await ctx.params;
    const access = await authorizeBoardRequest(req, boardId, "comment.write");
    const id = parseUuid(cardId, "card id");
    await assertCardOnBoard(access.boardId, id);
    const { content } = await parseBody(req, CreateComment);
    const comment = await createComment(access.boardId, id, content, access.actor?.id ?? null);
    return NextResponse.json({ comment }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
