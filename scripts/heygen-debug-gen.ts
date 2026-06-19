import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local" });
loadDotenv();

// Watch ONE avatar generation in a VISIBLE browser, end to end, on your own
// machine — independent of the queue and the Fly worker. Use this to debug
// failures like "rendered video never appeared in Projects": you see the real
// page the headless worker would see, including the Projects-poll step.
//
//   npm run heygen:debug-gen <projectId> <segmentId>
//
// or, to use an ad-hoc image + script instead of a real segment:
//
//   npm run heygen:debug-gen --image <url> --script "some narration"
//
// Forces HEYGEN_DEBUG=true so the browser is headed + slow-mo (heygen-auth.ts
// reads this), then calls the SAME generateAvatar() the worker calls — so what
// you watch is exactly the production flow, selectors and all.
//
// NOTE: this pulls one account from the pool and may flip its status on failure
// (same disposition logic as the worker). That's intentional — it's the real
// path. Re-connect with `npm run heygen:connect <email>` if it needs re-auth.

// Force the headed/slow-mo browser regardless of .env.local.
process.env.HEYGEN_DEBUG = "true";

import { getServerSupabase } from "@/lib/supabase/server";
import { fetchOrThrow } from "@/lib/synthetic/http";
import { generateAvatar } from "@/lib/synthetic/heygen";

function parseArgs(argv: string[]) {
  const out: { projectId?: string; segmentId?: string; image?: string; script?: string } = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--image") out.image = argv[++i];
    else if (a === "--script") out.script = argv[++i];
    else positional.push(a);
  }
  out.projectId = out.projectId ?? positional[0];
  out.segmentId = out.segmentId ?? positional[1];
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let projectId = args.projectId ?? "debug";
  let segmentId = args.segmentId ?? "debug-segment";
  let avatarImageUrl = args.image;
  let script = args.script;

  // If a real project+segment was given, load its avatar image + script so the
  // run reproduces the exact failing job.
  if (args.projectId && args.segmentId && !args.image) {
    const sb = getServerSupabase();
    const [{ data: seg, error: segErr }, { data: project, error: projErr }] = await Promise.all([
      sb.from("synthetic_segments").select("id, script").eq("id", args.segmentId).single(),
      sb.from("projects").select("avatar_image_url").eq("id", args.projectId).single(),
    ]);
    if (segErr || !seg) throw new Error(`segment ${args.segmentId} not found: ${segErr?.message}`);
    if (projErr || !project?.avatar_image_url) {
      throw new Error(`project ${args.projectId} has no avatar_image_url: ${projErr?.message}`);
    }
    avatarImageUrl = project.avatar_image_url as string;
    script = (seg.script as string) ?? "";
  }

  if (!avatarImageUrl) {
    throw new Error(
      "Need an image. Pass a real <projectId> <segmentId>, or --image <url> [--script <text>].",
    );
  }
  if (!script) script = "Hello, this is a debug avatar generation test.";

  console.log("Debug avatar generation (HEADED browser — watch it):");
  console.log(`  projectId : ${projectId}`);
  console.log(`  segmentId : ${segmentId}`);
  console.log(`  image     : ${avatarImageUrl}`);
  console.log(`  script    : ${script.slice(0, 80)}${script.length > 80 ? "…" : ""}`);
  console.log("\nFetching image bytes…");

  const imgRes = await fetchOrThrow(avatarImageUrl, { timeoutMs: 60_000 });
  const imageBytes = Buffer.from(await imgRes.arrayBuffer());
  console.log(`  ${imageBytes.length} bytes. Launching browser…\n`);

  try {
    const result = await generateAvatar(
      { projectId, segmentId, jobId: `debug-${segmentId}`, avatarImageUrl, script },
      imageBytes,
      1, // single account — don't burn the whole pool while debugging
    );
    console.log("\n✓ SUCCESS");
    console.log(`  videoUrl : ${result.videoUrl}`);
    console.log(`  account  : ${result.accountId}`);
    console.log(`  seconds  : ${result.seconds}`);
    process.exit(0);
  } catch (err) {
    console.error("\n✗ FAILED");
    console.error(`  ${(err as Error).message}`);
    console.error(
      "\nThe browser window showed where it stalled. Diagnostics (screenshot + HTML)\n" +
        "were also captured to HEYGEN_LOG_DIR / R2 under heygen-shots & heygen-diagnostics.",
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
