import { NextResponse, type NextRequest } from "next/server";
import { deleteAttachment } from "@/lib/boards/card-service";
import { authorizeBoardRequest, handleRouteError, parseUuid } from "@/lib/boards/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ boardId: string; attachmentId: string }> },
) {
  try {
    const { boardId, attachmentId } = await ctx.params;
    const access = await authorizeBoardRequest(req, boardId, "card.write");
    await deleteAttachment(
      access.boardId,
      parseUuid(attachmentId, "attachment id"),
      access.actor?.id ?? null,
    );
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
