import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createList } from "@/lib/boards/service";
import { authorizeBoardRequest, handleRouteError, parseBody, TitleSchema } from "@/lib/boards/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CreateList = z.object({ title: TitleSchema });

/** POST — append a column to the board. Owner-only (see permissions.ts). */
export async function POST(req: NextRequest, ctx: { params: Promise<{ boardId: string }> }) {
  try {
    const { boardId } = await ctx.params;
    const access = await authorizeBoardRequest(req, boardId, "list.manage");
    const { title } = await parseBody(req, CreateList);
    const list = await createList(access.boardId, title, access.actor?.id ?? null);
    return NextResponse.json({ list }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
