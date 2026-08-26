import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getActivity } from "@/lib/boards/service";
import { authorizeBoardRequest, handleRouteError } from "@/lib/boards/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET — the board's activity feed, or one card's when `?cardId=` is given.
 * Returns structured events; the sentences are rendered client-side by
 * lib/boards/activity.ts.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ boardId: string }> }) {
  try {
    const { boardId } = await ctx.params;
    const access = await authorizeBoardRequest(req, boardId, "board.view");

    const params = new URL(req.url).searchParams;
    const cardId = params.get("cardId");
    const limit = Number(params.get("limit") ?? 50);

    const activity = await getActivity(access.boardId, {
      cardId: cardId && z.string().uuid().safeParse(cardId).success ? cardId : undefined,
      limit: Number.isFinite(limit) ? limit : 50,
    });
    return NextResponse.json({ activity });
  } catch (error) {
    return handleRouteError(error);
  }
}
