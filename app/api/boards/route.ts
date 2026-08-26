import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createBoard, listBoards } from "@/lib/boards/service";
import { handleRouteError, parseBody, TitleSchema } from "@/lib/boards/http";
import { BOARD_THEMES } from "@/lib/boards/theme";

// Boards collection. Like the rest of this app's API, Node runtime and always
// dynamic — the board list is live data, never a build-time snapshot.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CreateBoard = z.object({
  name: TitleSchema,
  description: z.string().max(2000).optional(),
  // Whoever creates the board becomes its owner. There are no user accounts, so
  // the creator types their name once and it becomes their board identity —
  // see the identity note in migration 0037.
  ownerName: z.string().trim().min(1).max(80),
  theme: z.enum(BOARD_THEMES).optional(),
  visibility: z.enum(["workspace", "private"]).optional(),
  // Optional link to an existing video project, so a board can track the work
  // around a specific video rather than duplicating the project concept.
  projectId: z.string().uuid().nullable().optional(),
  listTitles: z.array(TitleSchema).max(20).optional(),
});

export async function GET(req: NextRequest) {
  try {
    const includeArchived = new URL(req.url).searchParams.get("archived") === "true";
    return NextResponse.json({ boards: await listBoards(includeArchived) });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    const input = await parseBody(req, CreateBoard);
    const board = await createBoard(input);
    return NextResponse.json({ board }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
