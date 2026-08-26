import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createCard } from "@/lib/boards/service";
import {
  authorizeBoardRequest,
  handleRouteError,
  LongTextSchema,
  parseBody,
  TargetIndexSchema,
  TitleSchema,
} from "@/lib/boards/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CreateCard = z.object({
  listId: z.string().uuid(),
  title: TitleSchema,
  description: LongTextSchema.optional(),
  /** Omit to append — what "+ Add a card" does. */
  targetIndex: TargetIndexSchema.optional(),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ boardId: string }> }) {
  try {
    const { boardId } = await ctx.params;
    const access = await authorizeBoardRequest(req, boardId, "card.write");
    const input = await parseBody(req, CreateCard);
    const card = await createCard(access.boardId, input, access.actor?.id ?? null);
    return NextResponse.json({ card }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
