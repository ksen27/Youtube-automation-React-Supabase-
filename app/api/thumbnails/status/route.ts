import { NextResponse, type NextRequest } from "next/server";
import { getServerSupabase, isSupabaseConfigured } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Fire-and-poll status endpoint. The batch UI polls this with the ids it got
// back from /generate/batch and flips each card pending → completed/failed as
// the detached renders finish. Kept deliberately small (id + status + output +
// error) so polling is cheap.
//
// It also carries the STUCK-ROW SAFEGUARD: a thumbnail left `pending` longer
// than STUCK_AFTER_MS almost certainly lost its detached render to a web-server
// restart (the render runs in `after()`, in-process, so it doesn't survive a
// crash/redeploy). Rather than spin forever, mark those failed with a clear,
// retryable message — the user re-runs via the gallery's Edit/regenerate. This
// runs on read so no worker/cron is needed.

const MAX_IDS = 50;
// A thumbnail render is ~30–60s; 5 min is comfortably past the slowest real
// render (incl. a first-time persona build) yet short enough that an
// interrupted row surfaces quickly instead of spinning.
const STUCK_AFTER_MS = 5 * 60_000;

export async function GET(req: NextRequest) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });
  }

  const raw = req.nextUrl.searchParams.get("ids") ?? "";
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_IDS);
  if (ids.length === 0) {
    return NextResponse.json({ thumbnails: [] });
  }

  const sb = getServerSupabase();

  // Fail any row that has been `pending` too long — its detached render was
  // almost certainly lost to a restart. Scoped to the polled ids and guarded on
  // status so a live render is never touched. Best-effort: a failure here just
  // means the row keeps polling until the next tick.
  const cutoff = new Date(Date.now() - STUCK_AFTER_MS).toISOString();
  await sb
    .from("thumbnails")
    .update({
      status: "failed",
      error: "Generation was interrupted before it finished. Edit and regenerate to retry.",
      updated_at: new Date().toISOString(),
    })
    .in("id", ids)
    .eq("status", "pending")
    .lt("created_at", cutoff);

  const { data, error } = await sb
    .from("thumbnails")
    .select("id, title, prompt, reference_urls, output_url, status, error, created_at")
    .in("id", ids);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ thumbnails: data ?? [] });
}
