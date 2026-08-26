import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { presignPutUrl } from "@/lib/storage";
import { assertCardOnBoard } from "@/lib/boards/access";
import { authorizeBoardRequest, handleRouteError, parseBody, parseUuid } from "@/lib/boards/http";
import { safeFilename } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Same pattern as the voiceover/pitch-video uploads: the browser PUTs straight
// to R2 with a short-lived URL, so a 200MB design mock never has to travel
// through a Next.js route handler (and never hits its body-size limit). The
// attachment ROW is created afterwards by POSTing to ../attachments with the
// returned publicUrl + storageKey.
const Presign = z.object({
  filename: z.string().trim().min(1).max(255),
  contentType: z.string().min(1).max(120),
  size: z.number().int().positive().max(200 * 1024 * 1024), // 200MB ceiling
});

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ boardId: string; cardId: string }> },
) {
  try {
    const { boardId, cardId } = await ctx.params;
    // Authorised BEFORE a write URL is handed out: without the card check, this
    // would issue upload credentials for any uuid a caller cared to invent.
    const access = await authorizeBoardRequest(req, boardId, "card.write");
    const id = parseUuid(cardId, "card id");
    await assertCardOnBoard(access.boardId, id);

    const input = await parseBody(req, Presign);
    const key = `boards/${access.boardId}/cards/${id}/${Date.now()}-${safeFilename(input.filename)}`;
    const presigned = await presignPutUrl(key, input.contentType, 900);

    return NextResponse.json({
      uploadUrl: presigned.url,
      storageKey: presigned.path,
      publicUrl: presigned.publicUrl,
      expiresInSeconds: 900,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
