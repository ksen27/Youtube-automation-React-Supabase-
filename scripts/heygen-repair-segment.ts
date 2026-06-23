// One-off repair: re-fetch the FULL-LENGTH HeyGen render for a single avatar
// segment and replace the stale (too-short) file already stored in R2.
//
// Why this exists: retrieveRenderedVideo previously could download a stale,
// shorter render of a regenerated segment (see memory: avatar-retrieval-stale-
// item-bug). HeyGen still holds the correct full-length render; this script uses
// the authed browser context to call HeyGen's project-list API, pick the item
// whose duration matches the segment's planned window, download it, re-upload to
// the segment's existing R2 key, and refresh the DB durations.
//
// Usage: npx tsx --env-file=.env.local scripts/heygen-repair-segment.ts <segmentId>

import { createClient } from "@supabase/supabase-js";
import { getAccountByEmail } from "@/lib/synthetic/heygen-accounts";
import { openAuthedContext } from "@/lib/synthetic/heygen-auth";
import { uploadBuffer } from "@/lib/storage";
import { r2Keys } from "@/lib/synthetic/constants";

const HEYGEN_ITEMS_API =
  "https://api2.heygen.com/v1/project/items?limit=40&filter_groups=avatar_video&sort_key=created_ts&sort_order=desc";

const segmentId = process.argv[2];
if (!segmentId) {
  console.error("usage: heygen-repair-segment.ts <segmentId>");
  process.exit(1);
}

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function main() {
const { data: seg, error: segErr } = await sb
  .from("synthetic_segments")
  .select("id, project_id, start_time, end_time, duration, video_url")
  .eq("id", segmentId)
  .single();
if (segErr || !seg) throw new Error(`segment ${segmentId} not found: ${segErr?.message}`);

const expected = Number(seg.end_time) - Number(seg.start_time);
console.log(`segment ${segmentId} | project ${seg.project_id} | planned ${expected.toFixed(2)}s`);

// Use the same account that the worker uses. Single-account pool here.
const { data: accRow } = await sb.from("heygen_accounts").select("email").eq("status", "active").limit(1).single();
if (!accRow?.email) throw new Error("no active heygen account");
const account = await getAccountByEmail(accRow.email);
if (!account) throw new Error(`could not load/decrypt account ${accRow.email}`);

const { browser, context } = await openAuthedContext(account);
try {
  const resp = await context.request.get(HEYGEN_ITEMS_API, { timeout: 60_000 });
  if (!resp.ok()) throw new Error(`project items API HTTP ${resp.status()}`);
  const json = (await resp.json()) as { data?: { items?: Array<{ video_id: string; status: string; duration?: number; video_url?: string; video_download_url?: string; created_ts?: number }> } };
  const items = json.data?.items ?? [];
  console.log(`fetched ${items.length} project items`);

  const completed = items.filter((it) => ["completed", "success", "done"].includes((it.status ?? "").toLowerCase()));
  // Pick the NEWEST completed item whose duration matches the planned window.
  const tol = Math.max(2, expected * 0.15);
  const matches = completed
    .filter((it) => typeof it.duration === "number" && it.duration! >= expected - tol)
    .sort((a, b) => (b.created_ts ?? 0) - (a.created_ts ?? 0));
  console.log("completed durations:", completed.map((it) => Math.round((it.duration ?? 0) * 10) / 10).join(", "));

  const pick = matches[0];
  if (!pick) {
    throw new Error(`no completed HeyGen item with duration >= ${(expected - tol).toFixed(1)}s found — cannot repair`);
  }
  console.log(`matched item ${pick.video_id} duration=${pick.duration}s`);

  const url = pick.video_url || pick.video_download_url;
  if (!url) throw new Error("matched item has no downloadable url");
  const dl = await context.request.get(url, { timeout: 120_000 });
  if (!dl.ok()) throw new Error(`download HTTP ${dl.status()}`);
  const buf = Buffer.from(await dl.body());
  console.log(`downloaded ${(buf.length / 1e6).toFixed(2)} MB`);
  if (buf.length < 1024) throw new Error("downloaded file implausibly small");

  const up = await uploadBuffer(buf, r2Keys.avatarVideo(seg.project_id as string, segmentId), "video/mp4");
  console.log(`uploaded -> ${up.publicUrl}`);

  // Refresh DB: segment + any timeline_item materialized from it back to planned.
  await sb.from("synthetic_segments").update({ video_url: up.publicUrl, duration: expected, status: "ready" }).eq("id", segmentId);
  await sb.from("timeline_items").update({ duration: expected, video_url: up.publicUrl }).eq("project_id", seg.project_id).contains("metadata", { synthetic_segment_id: segmentId });
  console.log(`DB updated: duration -> ${expected.toFixed(2)}s. Done.`);
} finally {
  await browser.close().catch(() => {});
}
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
