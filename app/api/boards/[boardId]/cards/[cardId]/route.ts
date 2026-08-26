import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { deleteCard, updateCard } from "@/lib/boards/service";
import { getCardDetail } from "@/lib/boards/card-service";
import { assertCardOnBoard } from "@/lib/boards/access";
import {
  authorizeBoardRequest,
  handleRouteError,
  LongTextSchema,
  parseBody,
  parseUuid,
  TitleSchema,
} from "@/lib/boards/http";
import { LABEL_COLORS } from "@/lib/boards/theme";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UpdateCard = z.object({
  title: TitleSchema.optional(),
  description: LongTextSchema.optional(),
  completed: z.boolean().optional(),
  // Dates are nullable-optional on purpose: `undefined` leaves the field alone,
  // an explicit `null` clears it. Collapsing the two would make "remove the due
  // date" impossible to express.
  startAt: z.string().datetime({ offset: true }).nullable().optional(),
  dueAt: z.string().datetime({ offset: true }).nullable().optional(),
  coverColor: z.enum(LABEL_COLORS).nullable().optional(),
  coverImageUrl: z.string().url().max(2000).nullable().optional(),
  archived: z.boolean().optional(),
});

/** GET — the full detail payload (checklists, comments, attachments, activity). */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ boardId: string; cardId: string }> },
) {
  try {
    const { boardId, cardId } = await ctx.params;
    const access = await authorizeBoardRequest(req, boardId, "board.view");
    const id = parseUuid(cardId, "card id");
    await assertCardOnBoard(access.boardId, id);
    return NextResponse.json(await getCardDetail(access.boardId, id));
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ boardId: string; cardId: string }> },
) {
  try {
    const { boardId, cardId } = await ctx.params;
    const access = await authorizeBoardRequest(req, boardId, "card.write");
    const id = parseUuid(cardId, "card id");
    const input = await parseBody(req, UpdateCard);
    const card = await updateCard(access.boardId, id, input, access.actor?.id ?? null);
    return NextResponse.json({ card });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ boardId: string; cardId: string }> },
) {
  try {
    const { boardId, cardId } = await ctx.params;
    const access = await authorizeBoardRequest(req, boardId, "card.write");
    await deleteCard(access.boardId, parseUuid(cardId, "card id"), access.actor?.id ?? null);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
