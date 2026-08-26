import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { removeMember, updateMember } from "@/lib/boards/card-service";
import { authorizeBoardRequest, handleRouteError, parseBody, parseUuid } from "@/lib/boards/http";
import { LABEL_COLORS } from "@/lib/boards/theme";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UpdateMember = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  role: z.enum(["owner", "member", "viewer"]).optional(),
  color: z.enum(LABEL_COLORS).optional(),
});

/** PATCH — rename, recolour or change a role. Owner only. */
export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ boardId: string; memberId: string }> },
) {
  try {
    const { boardId, memberId } = await ctx.params;
    const access = await authorizeBoardRequest(req, boardId, "members.manage");
    const input = await parseBody(req, UpdateMember);
    const member = await updateMember(access.boardId, parseUuid(memberId, "member id"), input);
    return NextResponse.json({ member });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ boardId: string; memberId: string }> },
) {
  try {
    const { boardId, memberId } = await ctx.params;
    const access = await authorizeBoardRequest(req, boardId, "members.manage");
    // Removing the owner is refused by the service — a board with no owner is
    // one nobody can ever restructure again.
    await removeMember(access.boardId, parseUuid(memberId, "member id"));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
