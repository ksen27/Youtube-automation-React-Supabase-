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
// AVATAR III (orange) flow — needs the saved-avatar NAME + an audio file:
//
//   npm run heygen:debug-gen --model avatar_iii --name "Japan" --audio ./slice.mp3 --image <url>
//
// (Avatar III ignores the uploaded image at generation time — it drives the SAVED
// avatar found by --name — but --image is still required to satisfy the shared
// setup; pass any small image. --portrait renders 9:16, else 16:9 landscape.)
//
// PIN A SPECIFIC ACCOUNT — the saved avatar exists on ONE HeyGen account, so the
// test must run there (not a random pool pick). --account <email> bypasses the
// pool and drives exactly that account:
//
//   npm run heygen:debug-gen --model avatar_iii --name "Japan" --account you@x.com --audio ./slice.mp3 --image <url>
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
import { generateAvatar, attemptOnAccount } from "@/lib/synthetic/heygen";
import { getAccountByEmail } from "@/lib/synthetic/heygen-accounts";

function parseArgs(argv: string[]) {
  const out: {
    projectId?: string;
    segmentId?: string;
    image?: string;
    script?: string;
    model?: string;
    name?: string;
    audio?: string;
    portrait?: boolean;
    account?: string;
  } = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--image") out.image = argv[++i];
    else if (a === "--script") out.script = argv[++i];
    else if (a === "--model") out.model = argv[++i];
    else if (a === "--name") out.name = argv[++i];
    else if (a === "--audio") out.audio = argv[++i];
    else if (a === "--account") out.account = argv[++i];
    else if (a === "--portrait") out.portrait = true;
    else positional.push(a);
  }
  // npm strips leading "--flags" (it treats them as npm config) UNLESS you use
  // `npm run <script> -- --flag`. Users forget the `--`, so npm hands us the flag
  // VALUES as bare positionals (e.g. "avatar_iii Japan ./slice.mp3 https://…").
  // Recover them by SHAPE so the command works either way: recognizable tokens
  // are pulled out of the positional list before falling back to projectId/segmentId.
  const leftover: string[] = [];
  for (const a of positional) {
    if (!out.model && (a === "avatar_iii" || a === "avatar_iv")) out.model = a;
    else if (!out.audio && /\.(mp3|wav|m4a)$/i.test(a)) out.audio = a;
    else if (!out.image && /^https?:\/\//i.test(a)) out.image = a;
    else if (!out.account && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a)) out.account = a;
    else if (!out.portrait && (a === "portrait" || a === "landscape")) out.portrait = a === "portrait";
    else leftover.push(a);
  }
  // A bare word left over (e.g. "Japan") is the avatar name for the Avatar III flow.
  if (!out.name && out.model === "avatar_iii" && leftover.length > 0) {
    out.name = leftover.shift();
  }
  out.projectId = out.projectId ?? leftover[0];
  out.segmentId = out.segmentId ?? leftover[1];
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let projectId = args.projectId ?? "debug";
  let segmentId = args.segmentId ?? "debug-segment";
  let avatarImageUrl = args.image;
  let script = args.script;
  let heygenAvatarName = args.name ?? null;
  const avatarModel: "avatar_iii" | "avatar_iv" = args.model === "avatar_iii" ? "avatar_iii" : "avatar_iv";

  // If a real project+segment was given, load its avatar image + script so the
  // run reproduces the exact failing job.
  if (args.projectId && args.segmentId && !args.image) {
    const sb = getServerSupabase();
    const [{ data: seg, error: segErr }, { data: project, error: projErr }] = await Promise.all([
      sb.from("synthetic_segments").select("id, script").eq("id", args.segmentId).single(),
      sb.from("projects").select("avatar_image_url, heygen_avatar_name").eq("id", args.projectId).single(),
    ]);
    if (segErr || !seg) throw new Error(`segment ${args.segmentId} not found: ${segErr?.message}`);
    if (projErr || !project?.avatar_image_url) {
      throw new Error(`project ${args.projectId} has no avatar_image_url: ${projErr?.message}`);
    }
    avatarImageUrl = project.avatar_image_url as string;
    script = (seg.script as string) ?? "";
    heygenAvatarName =
      heygenAvatarName ?? ((project as { heygen_avatar_name?: string | null }).heygen_avatar_name ?? null);
  }

  if (avatarModel === "avatar_iii") {
    // --name is NO LONGER required: Avatar III now enters the composer from any
    // seed avatar and overrides the look with the project photo, so it ignores
    // heygenAvatarName. Kept optional only for logging.
    if (!args.audio) throw new Error("Avatar III needs --audio <path-to-mp3> (the lip-sync audio).");
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
  console.log(`  model     : ${avatarModel}`);
  if (avatarModel === "avatar_iii") {
    console.log(`  name      : ${heygenAvatarName}`);
    console.log(`  audio     : ${args.audio}`);
    console.log(`  aspect    : ${args.portrait ? "portrait (9:16)" : "landscape (16:9)"}`);
  }
  console.log(`  image     : ${avatarImageUrl}`);
  console.log(`  script    : ${script.slice(0, 80)}${script.length > 80 ? "…" : ""}`);
  console.log("\nFetching image bytes…");

  const imgRes = await fetchOrThrow(avatarImageUrl, { timeoutMs: 60_000 });
  const imageBytes = Buffer.from(await imgRes.arrayBuffer());
  console.log(`  ${imageBytes.length} bytes. Launching browser…\n`);

  const genInput = {
    projectId,
    segmentId,
    jobId: `debug-${segmentId}`,
    avatarImageUrl,
    script,
    avatarModel,
    heygenAvatarName,
    audioFilePath: args.audio,
    aspectRatio: (args.portrait ? "portrait" : "landscape") as "portrait" | "landscape",
  };

  try {
    let result;
    if (args.account) {
      // Pinned account: bypass the pool and drive EXACTLY this account (the one
      // that holds the named saved avatar). Fetch by email and run one attempt
      // directly. No lease is taken — safe for a single manual debug run.
      const account = await getAccountByEmail(args.account);
      if (!account) throw new Error(`no HeyGen account found for ${args.account} (connect it first).`);
      result = await attemptOnAccount(account, genInput, imageBytes, false);
    } else {
      result = await generateAvatar(
        genInput,
        imageBytes,
        1, // single account — don't burn the whole pool while debugging
      );
    }
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
