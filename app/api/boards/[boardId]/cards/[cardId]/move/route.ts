import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { moveCard } from "@/lib/boards/service";
import {
  authorizeBoardRequest,
  handleRouteError,
  parseBody,
  parseUuid,
  TargetIndexSchema,
} from "@/lib/boards/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The one endpoint drag-and-drop calls, and only once per drag — on drop, not
// during the drag. `targetIndex` is what the drag library knows; the server
// turns it into a fractional position against the destination column as it
// exists at that moment (see lib/boards/position.ts).
const MoveCard = z.object({
  listId: z.string().uuid(),
  targetIndex: TargetIndexSchema,
});

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ boardId: string; cardId: string }> },
) {
  try {
    const { boardId, cardId } = await ctx.params;
    const access = await authorizeBoardRequest(req, boardId, "card.move");
    const input = await parseBody(req, MoveCard);
    const card = await moveCard(
      access.boardId,
      parseUuid(cardId, "card id"),
      input,
      access.actor?.id ?? null,
    );
    return NextResponse.json({ card });
  } catch (error) {
    return handleRouteError(error);
  }
}
