import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createLabel, listLabels } from "@/lib/boards/card-service";
import { authorizeBoardRequest, handleRouteError, parseBody } from "@/lib/boards/http";
import { LABEL_COLORS } from "@/lib/boards/theme";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Colour is an enum of design-system keys, not a hex string: a free-form colour
// would let a label render illegibly on the app's dark surfaces.
const CreateLabel = z.object({
  name: z.string().trim().max(80).default(""),
  color: z.enum(LABEL_COLORS),
});

export async function GET(req: NextRequest, ctx: { params: Promise<{ boardId: string }> }) {
  try {
    const { boardId } = await ctx.params;
    const access = await authorizeBoardRequest(req, boardId, "board.view");
    return NextResponse.json({ labels: await listLabels(access.boardId) });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ boardId: string }> }) {
  try {
    const { boardId } = await ctx.params;
    const access = await authorizeBoardRequest(req, boardId, "labels.manage");
    const input = await parseBody(req, CreateLabel);
    return NextResponse.json({ label: await createLabel(access.boardId, input) }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
