import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { addMember, listMembers } from "@/lib/boards/card-service";
import { authorizeBoardRequest, handleRouteError, parseBody } from "@/lib/boards/http";
import { LABEL_COLORS } from "@/lib/boards/theme";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AddMember = z.object({
  displayName: z.string().trim().min(1).max(80),
  role: z.enum(["owner", "member", "viewer"]).optional(),
  color: z.enum(LABEL_COLORS).optional(),
});

export async function GET(req: NextRequest, ctx: { params: Promise<{ boardId: string }> }) {
  try {
    const { boardId } = await ctx.params;
    const access = await authorizeBoardRequest(req, boardId, "board.view");
    return NextResponse.json({ members: await listMembers(access.boardId) });
  } catch (error) {
    return handleRouteError(error);
  }
}

/**
 * POST — add someone to the board.
 *
 * Authorised as `card.write` (everyday work), not `members.manage`, and the
 * reason is the identity model: with one shared password, a teammate opening a
 * board for the first time has no member row yet, so requiring an owner to
 * pre-register them would lock the board's first visitor out of doing anything.
 * Granting a ROLE is still privileged — anyone who is not an owner gets a plain
 * `member` regardless of what they asked for, and only PATCH (owner-only) can
 * change a role afterwards.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ boardId: string }> }) {
  try {
    const { boardId } = await ctx.params;
    const access = await authorizeBoardRequest(req, boardId, "card.write");
    const input = await parseBody(req, AddMember);
    const member = await addMember(access.boardId, {
      displayName: input.displayName,
      role: access.role === "owner" ? input.role : "member",
      color: input.color,
    });
    return NextResponse.json({ member }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
