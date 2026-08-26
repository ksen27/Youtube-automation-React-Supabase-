import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { deleteChecklist, updateChecklist } from "@/lib/boards/card-service";
import {
  authorizeBoardRequest,
  handleRouteError,
  parseBody,
  parseUuid,
  TitleSchema,
} from "@/lib/boards/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Checklists are addressed under the board (not the card) because the service
// re-derives the card from the checklist anyway — and doing so is what proves
// the checklist belongs to a card on THIS board before anything is written.
const RenameChecklist = z.object({ title: TitleSchema });

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ boardId: string; checklistId: string }> },
) {
  try {
    const { boardId, checklistId } = await ctx.params;
    const access = await authorizeBoardRequest(req, boardId, "card.write");
    const { title } = await parseBody(req, RenameChecklist);
    const checklist = await updateChecklist(
      access.boardId,
      parseUuid(checklistId, "checklist id"),
      title,
      access.actor?.id ?? null,
    );
    return NextResponse.json({ checklist });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ boardId: string; checklistId: string }> },
) {
  try {
    const { boardId, checklistId } = await ctx.params;
    const access = await authorizeBoardRequest(req, boardId, "card.write");
    await deleteChecklist(
      access.boardId,
      parseUuid(checklistId, "checklist id"),
      access.actor?.id ?? null,
    );
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
