import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { deleteChecklistItem, updateChecklistItem } from "@/lib/boards/card-service";
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

const UpdateItem = z.object({
  title: TitleSchema.optional(),
  completed: z.boolean().optional(),
  assigneeMemberId: z.string().uuid().nullable().optional(),
  dueAt: z.string().datetime({ offset: true }).nullable().optional(),
  /** Set by the checklist's drag-and-drop reorder. */
  targetIndex: TargetIndexSchema.optional(),
});

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ boardId: string; itemId: string }> },
) {
  try {
    const { boardId, itemId } = await ctx.params;
    const access = await authorizeBoardRequest(req, boardId, "card.write");
    const input = await parseBody(req, UpdateItem);
    const item = await updateChecklistItem(
      access.boardId,
      parseUuid(itemId, "item id"),
      input,
      access.actor?.id ?? null,
    );
    return NextResponse.json({ item });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ boardId: string; itemId: string }> },
) {
  try {
    const { boardId, itemId } = await ctx.params;
    const access = await authorizeBoardRequest(req, boardId, "card.write");
    await deleteChecklistItem(access.boardId, parseUuid(itemId, "item id"), access.actor?.id ?? null);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
