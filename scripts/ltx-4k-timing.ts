// Is 4K ai_clip generation actually viable? Submits ONE clip the way production
// does — a short public image URL, not a data: URI — at both 4K and 1080p, and
// times each end to end. Answers: does 4K work, how much slower is it, and does
// our 6s duration tier still apply at 4K.
//
//   npx tsx --env-file=.env.local scripts/ltx-4k-timing.ts
import { getServerSupabase } from "@/lib/supabase/server";

const BASE = (process.env.LTX_BASE_URL || "https://api.ltx.video").replace(/\/$/, "");
const KEY = process.env.LTX_API_KEY || "";
const MODEL = process.env.LTX_MODEL || "ltx-2-3-fast";
const FPS = Number(process.env.LTX_FPS || 25);

async function pickImageUrl(): Promise<string> {
  const sb = getServerSupabase();
  const { data, error } = await sb
    .from("timeline_items")
    .select("image_url")
    .not("image_url", "is", null)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  const url = data?.[0]?.image_url as string | undefined;
  if (!url) throw new Error("no image_url found to animate");
  return url;
}

async function submit(imageUrl: string, resolution: string): Promise<string> {
  const res = await fetch(`${BASE}/v2/image-to-video`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      prompt: "Slow subtle push-in. No camera shake.",
      image_uri: imageUrl,
      resolution,
      fps: FPS,
      duration: 6,
    }),
  });
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok || !json.id) {
    throw new Error(`submit ${resolution} -> ${res.status} ${JSON.stringify(json).slice(0, 400)}`);
  }
  return json.id;
}

async function poll(id: string, resolution: string, budgetMs: number) {
  const t0 = Date.now();
  for (;;) {
    const res = await fetch(`${BASE}/v2/image-to-video/${id}`, {
      headers: { Authorization: `Bearer ${KEY}` },
    });
    const j = (await res.json().catch(() => ({}))) as any;
    const elapsed = Math.round((Date.now() - t0) / 1000);
    if (j.status === "completed" || j.status === "failed") {
      console.log(`  ${resolution}: ${j.status} after ${elapsed}s`);
      if (j.status === "failed") console.log(`    error: ${JSON.stringify(j.error).slice(0, 300)}`);
      else console.log(`    video: ${String(j.result?.video_url ?? j.video_url ?? "").slice(0, 120)}`);
      return { status: j.status, elapsed };
    }
    if (Date.now() - t0 > budgetMs) {
      console.log(`  ${resolution}: STILL ${j.status} after ${elapsed}s — exceeded ${budgetMs / 1000}s budget`);
      return { status: "timeout", elapsed };
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

async function main() {
  const imageUrl = await pickImageUrl();
  console.log(`model=${MODEL} fps=${FPS} duration=6`);
  console.log(`image: ${imageUrl.slice(0, 110)}\n`);

  // Submit both up front so they queue in parallel and the comparison is fair.
  const id4k = await submit(imageUrl, "3840x2160");
  const id1080 = await submit(imageUrl, "1920x1080");
  console.log(`submitted 4K=${id4k} 1080p=${id1080}\n`);

  const r1080 = await poll(id1080, "1080p", 20 * 60_000);
  const r4k = await poll(id4k, "4K", 20 * 60_000);

  console.log(`\nSUMMARY  1080p=${r1080.status}/${r1080.elapsed}s   4K=${r4k.status}/${r4k.elapsed}s`);
  console.log(`current LTX_POLL_TIMEOUT_SECONDS=${process.env.LTX_POLL_TIMEOUT_SECONDS || 600}`);
}

void main().catch((e) => { console.error("FAILED:", e?.message || e); process.exitCode = 1; });
