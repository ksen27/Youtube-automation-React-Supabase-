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

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createClient } from "@supabase/supabase-js";
import { getAccountByEmail } from "@/lib/synthetic/heygen-accounts";
import { openAuthedContext } from "@/lib/synthetic/heygen-auth";
import { uploadBuffer } from "@/lib/storage";
import { probeFile } from "@/lib/media/probe";
import { r2Keys } from "@/lib/synthetic/constants";
import { getEnv } from "@/lib/env";

const HEYGEN_ITEMS_API =
  "https://api2.heygen.com/v1/project/items?limit=40&filter_groups=avatar_video&sort_key=created_ts&sort_order=desc";

// A project-list item in the shape this script consumes, source-agnostic.
type RepairItem = {
  video_id: string;
  status: string;
  duration?: number;
  video_url?: string;
  video_download_url?: string;
  created_ts?: number;
};

// V3 (public REST) fetch of THIS segment's renders via the server-side title
// filter — no browser needed. Titles are "synthetic <projectId> <segmentId>", so
// title=<segmentId> returns just this segment's render(s). Mapped into RepairItem
// and sorted newest-first (v3 has no sort param).
async function fetchItemsV3(seg: string): Promise<RepairItem[]> {
  const e = getEnv();
  if (!e.HEYGEN_API_KEY) throw new Error("HEYGEN_RETRIEVAL_V3 is on but HEYGEN_API_KEY is unset");
  const q = new URLSearchParams({ limit: "100", title: seg });
  const resp = await fetch(`${e.HEYGEN_API_BASE_URL}/v3/videos?${q}`, {
    headers: { "x-api-key": e.HEYGEN_API_KEY },
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) throw new Error(`GET /v3/videos HTTP ${resp.status}`);
  const json = (await resp.json()) as {
    data?: Array<{ id?: string; status?: string; duration?: number | null; video_url?: string | null; created_at?: number | null }>;
  };
  return (json.data ?? [])
    .filter((r): r is { id: string } & typeof r => typeof r.id === "string" && r.id.length > 0)
    .map((r) => ({
      video_id: r.id,
      status: String(r.status ?? ""),
      duration: typeof r.duration === "number" ? r.duration : undefined,
      video_url: r.video_url ?? undefined,
      created_ts: typeof r.created_at === "number" ? r.created_at : undefined,
    }))
    .sort((a, b) => (b.created_ts ?? 0) - (a.created_ts ?? 0));
}

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
  .select("id, project_id, block_type, start_time, end_time, duration, video_url")
  .eq("id", segmentId)
  .single();
if (segErr || !seg) throw new Error(`segment ${segmentId} not found: ${segErr?.message}`);

const expected = Number(seg.end_time) - Number(seg.start_time);
// Full-frame avatar = landscape; split_2 avatar-half = portrait.
const expectedAspect: "landscape" | "portrait" = seg.block_type === "split_2" ? "portrait" : "landscape";
console.log(`segment ${segmentId} | project ${seg.project_id} | block_type ${seg.block_type} | planned ${expected.toFixed(2)}s | expect ${expectedAspect}`);

const useV3 = getEnv().HEYGEN_RETRIEVAL_V3;

// On v3 we don't need the browser at all — the signed video_url + title filter are
// public/x-api-key. On v1 we open the authed browser context (cookie) as before.
let browser: Awaited<ReturnType<typeof openAuthedContext>>["browser"] | null = null;
let context: Awaited<ReturnType<typeof openAuthedContext>>["context"] | null = null;
if (!useV3) {
  // Use the same account that the worker uses. Single-account pool here.
  const { data: accRow } = await sb.from("heygen_accounts").select("email").eq("status", "active").limit(1).single();
  if (!accRow?.email) throw new Error("no active heygen account");
  const account = await getAccountByEmail(accRow.email);
  if (!account) throw new Error(`could not load/decrypt account ${accRow.email}`);
  ({ browser, context } = await openAuthedContext(account));
}

// Download a signed URL as bytes, source-appropriately (plain fetch on v3, authed
// browser context on v1).
async function download(url: string): Promise<Buffer | null> {
  if (useV3) {
    const dl = await fetch(url, { signal: AbortSignal.timeout(120_000) }).catch(() => null);
    if (!dl || !dl.ok) return null;
    return Buffer.from(await dl.arrayBuffer());
  }
  const dl = await context!.request.get(url, { timeout: 120_000 }).catch(() => null);
  if (!dl || !dl.ok()) return null;
  return Buffer.from(await dl.body());
}

try {
  let items: RepairItem[];
  if (useV3) {
    items = await fetchItemsV3(segmentId);
  } else {
    const resp = await context!.request.get(HEYGEN_ITEMS_API, { timeout: 60_000 });
    if (!resp.ok()) throw new Error(`project items API HTTP ${resp.status()}`);
    const json = (await resp.json()) as { data?: { items?: RepairItem[] } };
    items = json.data?.items ?? [];
  }
  console.log(`fetched ${items.length} project items (${useV3 ? "v3" : "v1"})`);

  const completed = items.filter((it) => ["completed", "success", "done"].includes((it.status ?? "").toLowerCase()));
  // Candidates whose duration matches the planned window, newest first. The
  // match is TWO-SIDED: skip items materially SHORTER (a stale partial) AND
  // materially LONGER (a pre-coalesce multi-part or different-segment render —
  // e.g. a 48s item for a 25.3s segment) than the planned length.
  const tol = Math.max(2, expected * 0.15);
  const durMatches = completed
    .filter((it) => typeof it.duration === "number" && it.duration! >= expected - tol && it.duration! <= expected + tol)
    .sort((a, b) => (b.created_ts ?? 0) - (a.created_ts ?? 0));
  console.log("completed durations:", completed.map((it) => Math.round((it.duration ?? 0) * 10) / 10).join(", "));

  // Probe each duration-matching candidate and pick the one whose ACTUAL
  // orientation matches the expected aspect (both 16:9 and 9:16 renders of the
  // same segment have the same duration, so duration alone can't disambiguate).
  // The probe ALSO re-checks the real file length two-sided — HeyGen's reported
  // duration can be wrong, so bytes are authoritative.
  let buf: Buffer | null = null;
  for (const cand of durMatches) {
    const url = cand.video_url || cand.video_download_url;
    if (!url) continue;
    const b = await download(url);
    if (!b || b.length < 1024) continue;
    const tmp = path.join(os.tmpdir(), `repair_${cand.video_id}.mp4`);
    let aspect: "landscape" | "portrait" | null = null;
    let probedSeconds = 0;
    try {
      await fs.writeFile(tmp, b);
      const p = await probeFile(tmp);
      aspect = !p.width || !p.height || p.width === p.height ? null : p.width > p.height ? "landscape" : "portrait";
      probedSeconds = p.durationSeconds;
      console.log(`  candidate ${cand.video_id}: ${p.width}x${p.height} (${aspect}) dur=${p.durationSeconds.toFixed(1)}s`);
    } finally {
      await fs.unlink(tmp).catch(() => {});
    }
    // Authoritative file-length gate (two-sided): reject if the real file is
    // materially off the planned length even when HeyGen's metadata looked ok.
    if (probedSeconds > 0 && (probedSeconds < expected - tol || probedSeconds > expected + tol)) {
      console.log(`  rejected ${cand.video_id}: real length ${probedSeconds.toFixed(1)}s outside ${(expected - tol).toFixed(1)}–${(expected + tol).toFixed(1)}s`);
      continue;
    }
    if (aspect === expectedAspect) {
      buf = b;
      console.log(`matched item ${cand.video_id} (${aspect}, ${probedSeconds.toFixed(1)}s)`);
      break;
    }
  }
  if (!buf) {
    throw new Error(`no completed HeyGen item matching duration ${(expected - tol).toFixed(1)}–${(expected + tol).toFixed(1)}s AND aspect=${expectedAspect} — cannot repair`);
  }
  console.log(`downloaded ${(buf.length / 1e6).toFixed(2)} MB`);

  // Versioned key so the repaired file lands at a FRESH URL (no stale CDN copy).
  const up = await uploadBuffer(buf, r2Keys.avatarVideo(seg.project_id as string, segmentId, Date.now()), "video/mp4");
  console.log(`uploaded -> ${up.publicUrl}`);

  // Refresh DB: segment + any timeline_item materialized from it back to planned.
  await sb.from("synthetic_segments").update({ video_url: up.publicUrl, duration: expected, status: "ready" }).eq("id", segmentId);
  await sb.from("timeline_items").update({ duration: expected, video_url: up.publicUrl }).eq("project_id", seg.project_id).contains("metadata", { synthetic_segment_id: segmentId });
  console.log(`DB updated: duration -> ${expected.toFixed(2)}s. Done.`);
} finally {
  await browser?.close().catch(() => {});
}
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
