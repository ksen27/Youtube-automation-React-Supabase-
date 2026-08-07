import "server-only";
import { NextResponse } from "next/server";
import type { z } from "zod";
import { getContainer } from "@ebook/config";

/**
 * Server-only helpers shared by the /api/books/* route handlers.
 *
 * PORT NOTE: upstream these lived in apps/web/lib/server/{auth,container,http}.ts.
 * `auth.ts` is deliberately NOT ported — it resolved a per-user Supabase session
 * and compared the email to ADMIN_EMAIL. This app has no user accounts: proxy.ts
 * gates every route (including /api/*) behind the shared password before a
 * handler ever runs, so an in-handler auth check would be dead code. What the
 * ported use cases still need is an ownerId, which is the fixed sentinel below.
 */

/**
 * The single owner every ebook row is written under.
 *
 * The domain layer threads ownerId through the per-owner concurrency cap,
 * queued-project promotion, and cross-project sibling checks (see the note on
 * projects.owner_id in supabase/migrations/0031_ebook_schema.sql). With one
 * tenant there is exactly one owner, so those limits act app-globally.
 */
export function ownerId(): string {
  return getContainer().env.EBOOK_OWNER_ID;
}

/** Server-only access to the DI container (process singleton: pooled DB/Redis). */
export function container() {
  return getContainer();
}

export function json<T>(data: T, status = 200): NextResponse {
  return NextResponse.json(data, { status });
}

export function error(message: string, status = 400): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Wrap a route handler so any thrown error becomes a JSON 500 instead of an
 * empty-body response. Without this, an uncaught exception (bad env, failed DB
 * query, unreachable Redis) escapes to Next's default handler and the client's
 * `res.json()` fails with "Unexpected end of JSON input".
 */
export function handle<A extends unknown[], R extends NextResponse>(
  // R is inferred from the handler rather than pinned to NextResponse. Several
  // handlers return a union built from `as const` helper results; without this
  // generic TypeScript widens that to `NextResponse | undefined` and rejects it.
  fn: (...args: A) => Promise<R>,
): (...args: A) => Promise<R | NextResponse> {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal Server Error";
      console.error("[api/books] unhandled error:", err);
      return error(message, 500);
    }
  };
}

/** Parse + validate a request body against a Zod schema (returns the parsed OUTPUT type). */
export async function parseBody<S extends z.ZodTypeAny>(
  req: Request,
  schema: S,
): Promise<{ ok: true; data: z.infer<S> } | { ok: false; res: NextResponse }> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return { ok: false, res: error("Invalid JSON body") };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, res: error(parsed.error.issues.map((i) => i.message).join("; "), 422) };
  }
  return { ok: true, data: parsed.data };
}
