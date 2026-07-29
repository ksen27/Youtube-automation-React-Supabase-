import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local" });
loadDotenv();

import { getEnv } from "@/lib/env";

// PROBE: does the V3 REST endpoint GET /v3/videos list our BROWSER/Studio-created
// avatar renders — or only videos created via the API?
//
// WHY THIS EXISTS
// HeyGen emailed the account (2026-07-24) that it is "still using V1/V2 APIs". Our
// public REST client (lib/synthetic/heygen-api.ts) is already 100% V3; the ONLY
// remaining /v1/ call is the render-retrieval poll against the INTERNAL web-app API
// `https://api2.heygen.com/v1/project/items` (lib/synthetic/heygen.ts), authed by
// the logged-in browser COOKIE, not x-api-key. That call runs on every render (the
// browser pool is the happy path), so it is the likely trigger for the flag.
//
// The candidate V3 replacement is the public, x-api-key-authed `GET /v3/videos`
// (docs: developers.heygen.com/reference/list-videos). It returns id/status/
// video_url/created_at/duration — MOST of what retrieval needs. But the docs do NOT
// state whether it lists renders created in the WEB APP / Studio (our happy path) or
// only API-created videos. If it is API-only, it CANNOT replace the /v1/ poll and the
// migration is a dead end for the happy path. This script settles that — read-only,
// no renders billed.
//
//   npm run heygen:v3-list-probe -- [known_browser_video_id ...]
//
// Pass zero or more video_ids you KNOW were created in the web app (e.g. copied from
// api2 /v1/project/items, or from a recent DB timeline row). The probe pages through
// GET /v3/videos and reports, for each, whether it appears. With no ids it just dumps
// the first pages so you can eyeball whether web-app avatar renders are present.
//
// Requires HEYGEN_API_KEY. HEYGEN_API_FALLBACK is irrelevant (read-only, direct call).

const AUTH_HEADER = "x-api-key";

interface V3VideoRow {
  id?: string;
  status?: string;
  title?: string | null;
  created_at?: number | null;
  video_url?: string | null;
  duration?: number | null;
  // documented as ABSENT on v3 — we surface them so a live probe can confirm/deny
  // whether HeyGen actually returns them (the aspect pre-filter depends on these):
  aspect_ratio?: string;
  orientation?: string;
  type?: string;
  [k: string]: unknown;
}

interface V3ListResponse {
  data?: V3VideoRow[];
  has_more?: boolean;
  next_token?: string | null;
  error?: unknown;
}

function keyOrExit(): string {
  const key = getEnv().HEYGEN_API_KEY;
  if (!key) {
    console.error("\n  ❌ HEYGEN_API_KEY is not set — add it to .env.local first.\n");
    process.exit(1);
  }
  return key;
}

async function fetchPage(base: string, key: string, token?: string): Promise<V3ListResponse> {
  const q = new URLSearchParams({ limit: "100" });
  if (token) q.set("token", token);
  const res = await fetch(`${base}/v3/videos?${q}`, {
    method: "GET",
    headers: { [AUTH_HEADER]: key },
  });
  const body = (await res.json().catch(() => ({}))) as V3ListResponse;
  if (!res.ok) {
    console.error(
      `\n  ❌ GET /v3/videos returned HTTP ${res.status}: ${JSON.stringify(body).slice(0, 500)}\n`,
    );
    process.exit(1);
  }
  return body;
}

(async () => {
  const wanted = new Set(process.argv.slice(2).map((s) => s.trim()).filter(Boolean));
  const env = getEnv();
  const base = env.HEYGEN_API_BASE_URL; // https://api.heygen.com (the V3 host)
  const key = keyOrExit();

  console.log(
    JSON.stringify({
      msg: "heygen-v3-list-probe.start",
      base,
      lookingFor: [...wanted],
      note: wanted.size
        ? "will report whether each known browser-created id appears in GET /v3/videos"
        : "no ids passed — dumping first pages so you can eyeball web-app renders",
    }),
  );

  // Field-presence tally across the sampled rows: proves whether v3 actually returns
  // aspect_ratio/orientation/type (docs say no) — the fields our aspect pre-filter needs.
  const fieldSeen = { aspect_ratio: 0, orientation: 0, type: 0, video_url: 0 };
  const statusCount: Record<string, number> = {};
  const found = new Set<string>();
  let scanned = 0;
  let page = 0;
  let token: string | undefined;
  const MAX_PAGES = 40; // 40 * 100 = up to 4000 recent videos

  const sample: V3VideoRow[] = [];
  while (page < MAX_PAGES) {
    const body = await fetchPage(base, key, token);
    const rows = body.data ?? [];
    for (const r of rows) {
      scanned++;
      if (r.aspect_ratio != null) fieldSeen.aspect_ratio++;
      if (r.orientation != null) fieldSeen.orientation++;
      if (r.type != null) fieldSeen.type++;
      if (r.video_url != null) fieldSeen.video_url++;
      const st = String(r.status ?? "?");
      statusCount[st] = (statusCount[st] ?? 0) + 1;
      if (r.id && wanted.has(r.id)) found.add(r.id);
      if (sample.length < 5) sample.push(r);
    }
    page++;
    // Stop early once every wanted id is located.
    if (wanted.size && found.size === wanted.size) break;
    if (!body.has_more || !body.next_token) break;
    token = String(body.next_token);
  }

  console.log(
    JSON.stringify(
      {
        msg: "heygen-v3-list-probe.done",
        pagesScanned: page,
        videosScanned: scanned,
        statusBreakdown: statusCount,
        fieldPresence: fieldSeen, // 0 for aspect_ratio/orientation/type ⇒ NOT returned by v3
        sampleRows: sample.map((r) => ({
          id: r.id,
          status: r.status,
          title: r.title,
          created_at: r.created_at,
          hasVideoUrl: r.video_url != null,
          duration: r.duration,
          aspect_ratio: r.aspect_ratio ?? null,
          orientation: r.orientation ?? null,
          type: r.type ?? null,
        })),
      },
      null,
      2,
    ),
  );

  if (wanted.size) {
    const missing = [...wanted].filter((id) => !found.has(id));
    console.log(
      JSON.stringify({
        msg: "heygen-v3-list-probe.match",
        wanted: [...wanted],
        found: [...found],
        missing,
      }),
    );
    if (missing.length === 0) {
      console.log(
        "\n  ✅ ALL known browser/Studio renders APPEAR in GET /v3/videos.\n" +
          "     → /v3/videos CAN replace the /v1/project/items poll for retrieval.\n" +
          "     Remaining gap: aspect_ratio/orientation not returned (fieldPresence above) —\n" +
          "     the wrong-aspect PRE-filter would rely on the file probe instead.\n",
      );
    } else {
      console.log(
        "\n  ⚠️  Some known browser renders are MISSING from GET /v3/videos:\n" +
          `     ${missing.join(", ")}\n` +
          "     → v3 list is likely API-only; it CANNOT replace the /v1/ retrieval poll.\n" +
          "     Keep the internal /v1/project/items call (it is NOT the deprecated public API).\n",
      );
    }
  } else {
    console.log(
      "\n  ℹ️  No ids passed. Inspect statusBreakdown/sampleRows above: if you recognize\n" +
        "     web-app avatar renders here, /v3/videos includes them. Re-run with known\n" +
        "     browser video_ids for a definitive yes/no:\n" +
        "        npm run heygen:v3-list-probe -- <video_id> <video_id> ...\n",
    );
  }
  process.exit(0);
})();
