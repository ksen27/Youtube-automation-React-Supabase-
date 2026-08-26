import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createAttachment, listAttachments } from "@/lib/boards/card-service";
import { assertCardOnBoard } from "@/lib/boards/access";
import { authorizeBoardRequest, handleRouteError, parseBody, parseUuid } from "@/lib/boards/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Two kinds of attachment land here through the same shape: a pasted link, and
// a file the browser has already PUT to R2 via the presign route next door. The
// row is identical either way; `storageKey` is what distinguishes an object we
// own from a link we merely reference.
const CreateAttachment = z.object({
  name: z.string().trim().min(1).max(300),
  url: z.string().url().max(2000),
  storageKey: z.string().max(500).nullable().optional(),
  contentType: z.string().max(120).nullable().optional(),
  sizeBytes: z.number().int().nonnegative().max(5_000_000_000).nullable().optional(),
});

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ boardId: string; cardId: string }> },
) {
  try {
    const { boardId, cardId } = await ctx.params;
    const access = await authorizeBoardRequest(req, boardId, "board.view");
    const id = parseUuid(cardId, "card id");
    await assertCardOnBoard(access.boardId, id);
    return NextResponse.json({ attachments: await listAttachments(id) });
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
    const input = await parseBody(req, CreateAttachment);
    const attachment = await createAttachment(access.boardId, id, input, access.actor?.id ?? null);
    return NextResponse.json({ attachment }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
