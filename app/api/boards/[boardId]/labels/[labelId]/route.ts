import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { deleteLabel, updateLabel } from "@/lib/boards/card-service";
import { authorizeBoardRequest, handleRouteError, parseBody, parseUuid } from "@/lib/boards/http";
import { LABEL_COLORS } from "@/lib/boards/theme";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UpdateLabel = z.object({
  name: z.string().trim().max(80).optional(),
  color: z.enum(LABEL_COLORS).optional(),
});

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ boardId: string; labelId: string }> },
) {
  try {
    const { boardId, labelId } = await ctx.params;
    const access = await authorizeBoardRequest(req, boardId, "labels.manage");
    const input = await parseBody(req, UpdateLabel);
    const label = await updateLabel(access.boardId, parseUuid(labelId, "label id"), input);
    return NextResponse.json({ label });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** DELETE — detaches the label from every card it was on, via the junction's cascade. */
export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ boardId: string; labelId: string }> },
) {
  try {
    const { boardId, labelId } = await ctx.params;
    const access = await authorizeBoardRequest(req, boardId, "labels.manage");
    await deleteLabel(access.boardId, parseUuid(labelId, "label id"));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
