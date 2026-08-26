import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { setCardLabel } from "@/lib/boards/card-service";
import { assertCardOnBoard } from "@/lib/boards/access";
import { authorizeBoardRequest, handleRouteError, parseBody, parseUuid } from "@/lib/boards/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One toggle endpoint rather than POST-to-add / DELETE-to-remove: the UI is a
// checkbox list, and a toggle is idempotent in both directions, so a double
// click or a retry cannot land the card in a state the user did not ask for.
const ToggleLabel = z.object({
  labelId: z.string().uuid(),
  attached: z.boolean(),
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
    const input = await parseBody(req, ToggleLabel);
    await setCardLabel(access.boardId, id, input.labelId, input.attached, access.actor?.id ?? null);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
