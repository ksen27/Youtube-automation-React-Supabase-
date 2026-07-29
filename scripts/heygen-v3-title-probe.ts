import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local" });
loadDotenv();

import { getEnv } from "@/lib/env";

// PROBE 2 — the TWO blocking questions for the V1→V3 retrieval migration
// (see scripts/heygen-v3-list-probe.ts for the first probe and the full context).
//
// Q1 (linchpin): does `GET /v3/videos?title=<substring>` filter SERVER-SIDE?
//     Our renders are titled "synthetic <projectId> <segmentId>" and segmentId is a
//     unique UUID. If the title filter works, retrieval polls ~1 row instead of
//     paging 4000 — this is what makes the migration efficient AND keeps pinning
//     unambiguous. If it does NOT filter (returns the full unfiltered list), the
//     whole pinning strategy has to change.
//
// Q2: does v3 list a render BEFORE it completes (a pending/processing row), or only
//     once completed? Decides whether the fragile null-id "placeholder row" logic in
//     lib/synthetic/heygen.ts can be dropped (best case: v3 shows an early row WITH an
//     id) or must be replaced by poll-until-complete + a loosened appear-deadline.
//
//   npm run heygen:v3-title-probe -- [segmentId]
//
// With no arg, the probe auto-discovers a segmentId from the newest "synthetic ..."
// title on page 1, then tests the title filter with it. Read-only; nothing billed.

const AUTH_HEADER = "x-api-key";

interface Row {
  id?: string;
  status?: string;
  title?: string | null;
  created_at?: number | null;
  [k: string]: unknown;
}
interface ListResp {
  data?: Row[];
  has_more?: boolean;
  next_token?: string | null;
}

function keyOrExit(): string {
  const k = getEnv().HEYGEN_API_KEY;
  if (!k) {
    console.error("\n  ❌ HEYGEN_API_KEY not set in .env.local\n");
    process.exit(1);
  }
  return k;
}

async function list(base: string, key: string, params: Record<string, string>): Promise<{ status: number; body: ListResp }> {
  const q = new URLSearchParams(params);
  const res = await fetch(`${base}/v3/videos?${q}`, { headers: { [AUTH_HEADER]: key } });
  const body = (await res.json().catch(() => ({}))) as ListResp;
  return { status: res.status, body };
}

// Extract the segmentId (last space-delimited token) from a "synthetic <proj> <seg>" title.
function segIdFromTitle(title?: string | null): string | null {
  if (!title) return null;
  const m = /^synthetic\s+\S+\s+(\S+)/.exec(title);
  return m ? m[1] : null;
}

(async () => {
  const env = getEnv();
  const base = env.HEYGEN_API_BASE_URL;
  const key = keyOrExit();
  let segmentId = process.argv[2]?.trim();

  // ---- Q2 + discovery: scan a few pages, tally statuses, find a segmentId to test.
  const statusTally: Record<string, number> = {};
  const nonCompletedExamples: Array<{ id?: string; status?: string; title?: string | null }> = [];
  let token: string | undefined;
  for (let p = 0; p < 5; p++) {
    const params: Record<string, string> = { limit: "100" };
    if (token) params.token = token;
    const { status, body } = await list(base, key, params);
    if (status !== 200) {
      console.error(`\n  ❌ GET /v3/videos returned HTTP ${status}\n`);
      process.exit(1);
    }
    for (const r of body.data ?? []) {
      const st = String(r.status ?? "?");
      statusTally[st] = (statusTally[st] ?? 0) + 1;
      if (st !== "completed" && nonCompletedExamples.length < 8) {
        nonCompletedExamples.push({ id: r.id, status: r.status, title: r.title });
      }
      if (!segmentId) {
        const sid = segIdFromTitle(r.title);
        if (sid) segmentId = sid;
      }
    }
    if (!body.has_more || !body.next_token) break;
    token = String(body.next_token);
  }

  console.log(
    JSON.stringify(
      {
        msg: "q2.pre_completion_listing",
        statusTally,
        // If any pending/processing rows exist, v3 DOES list renders before completion.
        listsNonCompleted: Object.keys(statusTally).some((s) => s !== "completed" && s !== "?"),
        nonCompletedExamples,
        note:
          "listsNonCompleted=true ⇒ v3 shows in-flight renders (placeholder logic can likely be dropped). " +
          "false here is INCONCLUSIVE unless a render was in flight during this probe — re-run while one renders.",
      },
      null,
      2,
    ),
  );

  // ---- Q1: does title= filter server-side?
  if (!segmentId) {
    console.log("\n  ⚠️  No 'synthetic <proj> <seg>' title found to derive a segmentId; pass one explicitly.\n");
    process.exit(0);
  }
  const { status, body } = await list(base, key, { limit: "100", title: segmentId });
  const rows = body.data ?? [];
  const allMatch = rows.length > 0 && rows.every((r) => (r.title ?? "").includes(segmentId!));
  const anyMatch = rows.some((r) => (r.title ?? "").includes(segmentId!));

  console.log(
    JSON.stringify(
      {
        msg: "q1.title_filter",
        testedSegmentId: segmentId,
        httpStatus: status,
        rowsReturned: rows.length,
        allRowsContainSegmentId: allMatch, // true ⇒ server-side filtering CONFIRMED
        anyRowContainsSegmentId: anyMatch,
        sample: rows.slice(0, 5).map((r) => ({ id: r.id, status: r.status, title: r.title })),
      },
      null,
      2,
    ),
  );

  if (allMatch && rows.length > 0 && rows.length < 50) {
    console.log(
      "\n  ✅ Q1: title= filters SERVER-SIDE (returned only this segment's rows).\n" +
        "     → retrieval can poll GET /v3/videos?title=<segmentId> and get ~1 row, no 4000-page scan.\n",
    );
  } else if (rows.length >= 100) {
    console.log(
      "\n  ⚠️  Q1: title= returned a FULL page (100) — likely NOT filtering (ignored the param).\n" +
        "     → pinning strategy must NOT rely on the title filter; page+created_ts fallback needed.\n",
    );
  } else if (!anyMatch) {
    console.log(
      "\n  ⚠️  Q1: title= returned rows that DON'T match the segmentId — param ignored or fuzzy.\n" +
        "     Inspect sample above; do not rely on server-side title filtering.\n",
    );
  }
  process.exit(0);
})();
