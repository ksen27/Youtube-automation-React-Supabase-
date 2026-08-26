import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createChecklist, listChecklists } from "@/lib/boards/card-service";
import { assertCardOnBoard } from "@/lib/boards/access";
import {
  authorizeBoardRequest,
  handleRouteError,
  parseBody,
  parseUuid,
  TitleSchema,
} from "@/lib/boards/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CreateChecklist = z.object({ title: TitleSchema.default("Checklist") });

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ boardId: string; cardId: string }> },
) {
  try {
    const { boardId, cardId } = await ctx.params;
    const access = await authorizeBoardRequest(req, boardId, "board.view");
    const id = parseUuid(cardId, "card id");
    await assertCardOnBoard(access.boardId, id);
    return NextResponse.json({ checklists: await listChecklists(id) });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ boardId: string; cardId: string }> },
) {
  try {
    const { boardId, cardId } = await ctx.params;
    const access = await authorizeBoardRequest(req, boardId, "card.write");
    const id = parseUuid(cardId, "card id");
    await assertCardOnBoard(access.boardId, id);
    const { title } = await parseBody(req, CreateChecklist);
    const checklist = await createChecklist(access.boardId, id, title, access.actor?.id ?? null);
    return NextResponse.json({ checklist }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
