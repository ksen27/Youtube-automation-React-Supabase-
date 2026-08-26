// Route-handler plumbing shared by every /api/boards endpoint: identity
// extraction, uniform error responses, and the guard that runs before any
// mutation.
//
// Centralising this is what keeps the handlers themselves down to "validate,
// authorise, call the service" — and, more importantly, makes it impossible to
// ship a board route that forgot the access check, because the check is part of
// the same helper that gives you the board id.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { resolveBoardAccess, assertWritable, type BoardAccess } from "./access";
import { assertCan, BoardForbiddenError, type BoardAction } from "./permissions";
import { BoardError } from "./errors";
import { ACTOR_HEADER } from "./constants";

// A header rather than a body field so GET, DELETE and multipart requests can
// all identify the actor the same way. It lives in ./constants so the browser
// client can import it without dragging this server-only module along.
export { ACTOR_HEADER } from "./constants";

export function getActorId(req: NextRequest): string | null {
  const raw = req.headers.get(ACTOR_HEADER) ?? new URL(req.url).searchParams.get("actorId");
  if (!raw) return null;
  return z.string().uuid().safeParse(raw).success ? raw : null;
}

export function jsonError(message: string, status: number, code?: string) {
  return NextResponse.json({ error: message, ...(code ? { code } : {}) }, { status });
}

/**
 * Map any thrown value to a response. Board errors carry their own status;
 * anything else is a bug, so it is logged server-side and reported as a generic
 * 500 rather than leaking an internal message to the client.
 */
export function handleRouteError(error: unknown) {
  if (error instanceof BoardForbiddenError) return jsonError(error.message, 403, "forbidden");
  if (error instanceof BoardError) return jsonError(error.message, error.status, error.code);
  console.error("[boards] unhandled route error:", error);
  return jsonError("Something went wrong.", 500, "internal_error");
}

/** Reject a malformed id before it reaches the database. */
export function parseBoardId(id: string): string {
  if (!z.string().uuid().safeParse(id).success) {
    throw new BoardError("Invalid board id.", 400, "invalid_id");
  }
  return id;
}

export function parseUuid(value: string, label: string): string {
  if (!z.string().uuid().safeParse(value).success) {
    throw new BoardError(`Invalid ${label}.`, 400, "invalid_id");
  }
  return value;
}

/**
 * The single entry point for a board route: validates the id, proves the board
 * exists, resolves the claimed identity to a member of THAT board, and checks
 * the action against the resulting role. Mutating actions additionally require
 * the board not to be archived.
 */
export async function authorizeBoardRequest(
  req: NextRequest,
  boardId: string,
  action: BoardAction,
  options: { allowArchived?: boolean } = {},
): Promise<BoardAccess> {
  const id = parseBoardId(boardId);
  const access = await resolveBoardAccess(id, getActorId(req));
  // `allowArchived` exists for exactly one case: un-archiving. Restoring a
  // board is a write TO an archived board, so the guard that otherwise makes
  // archived boards read-only has to be opt-out rather than absolute.
  if (action !== "board.view" && !options.allowArchived) assertWritable(access);
  assertCan(access.role, action);
  return access;
}

/** Parse and validate a JSON body, or throw a 400 the client can act on. */
export async function parseBody<S extends z.ZodTypeAny>(req: NextRequest, schema: S): Promise<z.infer<S>> {
  const raw = await req.json().catch(() => null);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new BoardError(
      `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".") || "body"} ${i.message}`).join("; ")}`,
      400,
      "invalid_input",
    );
  }
  return parsed.data;
}

// Field schemas reused across routes, so limits (and the messages a user sees
// when they hit one) stay identical everywhere.
export const TitleSchema = z.string().trim().min(1, "is required").max(300);
export const LongTextSchema = z.string().max(20_000);
export const IsoDateSchema = z.string().datetime({ offset: true }).nullable();
export const TargetIndexSchema = z.number().int().min(0).max(100_000);
