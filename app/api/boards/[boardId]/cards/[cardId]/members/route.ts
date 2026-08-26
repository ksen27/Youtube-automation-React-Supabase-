import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { setCardMember } from "@/lib/boards/card-service";
import { assertCardOnBoard } from "@/lib/boards/access";
import { authorizeBoardRequest, handleRouteError, parseBody, parseUuid } from "@/lib/boards/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Assign/unassign toggle — same shape and reasoning as the labels route. */
const ToggleMember = z.object({
  memberId: z.string().uuid(),
  assigned: z.boolean(),
});

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ boardId: string; cardId: string }> },
) {
  try {
    const { boardId, cardId } = await ctx.params;
    const access = await authorizeBoardRequest(req, boardId, "card.write");
    const id = parseUuid(cardId, "card id");
    await assertCardOnBoard(access.boardId, id);
    const input = await parseBody(req, ToggleMember);
    await setCardMember(access.boardId, id, input.memberId, input.assigned, access.actor?.id ?? null);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
