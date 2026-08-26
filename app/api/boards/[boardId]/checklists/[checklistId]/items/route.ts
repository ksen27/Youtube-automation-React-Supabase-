import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createChecklistItem } from "@/lib/boards/card-service";
import {
  authorizeBoardRequest,
  handleRouteError,
  parseBody,
  parseUuid,
  TitleSchema,
} from "@/lib/boards/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CreateItem = z.object({
  title: TitleSchema,
  assigneeMemberId: z.string().uuid().nullable().optional(),
  dueAt: z.string().datetime({ offset: true }).nullable().optional(),
});

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ boardId: string; checklistId: string }> },
) {
  try {
    const { boardId, checklistId } = await ctx.params;
    const access = await authorizeBoardRequest(req, boardId, "card.write");
    const input = await parseBody(req, CreateItem);
    const item = await createChecklistItem(
      access.boardId,
      parseUuid(checklistId, "checklist id"),
      input,
      access.actor?.id ?? null,
    );
    return NextResponse.json({ item }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
