import { z } from "zod";
import { planTimeline } from "@/lib/ai/timeline-plan";

// Server-only env. Never import this from a "use client" file.
const ServerEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  // Shared-password access gate (CelebForge only). CELEBFORGE_PASSWORD is the
  // single password the client team types to sign in; AUTH_SECRET is the random
  // server-only key used to HMAC-sign the session cookie. See lib/auth.ts. When
  // AUTH_SECRET is unset, the session signer falls back to
  // SUPABASE_SERVICE_ROLE_KEY. Login is disabled (503) until CELEBFORGE_PASSWORD
  // is set.
  CELEBFORGE_PASSWORD: z.string().optional(),
  AUTH_SECRET: z.string().optional(),
  // Cloudflare R2 (S3-compatible). The bucket should be public via r2.dev
  // subdomain or a custom domain. R2_PUBLIC_BASE_URL must NOT include a
  // trailing slash; uploadFile/uploadBuffer concatenate it as `${base}/${key}`.
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().default("video-automation"),
  R2_PUBLIC_BASE_URL: z.string().url().optional(),
  YOUTUBE_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  // Brave Image Search API. Primary image source — get a key at
  // https://api-dashboard.search.brave.com/. Free tier: 1 qps, 2000/month.
  BRAVE_SEARCH_API_KEY: z.string().optional(),
  // Google Programmable Search (Custom Search JSON API). Fallback when Brave
  // returns nothing. Cloud Console → enable Custom Search API → create key.
  // CX is the Programmable Search Engine ID from programmablesearchengine.google.com.
  GOOGLE_SEARCH_API_KEY: z.string().optional(),
  GOOGLE_SEARCH_CX: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-2.5-flash"),
  DEEPGRAM_API_KEY: z.string().optional(),
  DEEPGRAM_MODEL: z.string().default("nova-3"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(2),
  DOWNLOAD_CONCURRENCY: z.coerce.number().int().positive().default(1),
  // Toggle for the per-clip Gemini Vision labeler. Costs ~$0.001 per clip;
  // disable when running cost-sensitive tests.
  CLIP_LABELING_ENABLED: z.coerce.boolean().default(true),
  // Toggle for per-clip face-reference verification. After each clip is cut,
  // compare its thumbnail against the project celebrity's Wikipedia photo
  // via verifyPoolAsset. Clips that fail get tagged subject_present:no so
  // the matcher's existing person-gate drops them from person_default
  // blocks. Costs one Gemini Vision call per clip (~$0.001) and stops the
  // "wrong person in the clip" failure mode where the source thumbnail
  // shows the celebrity but a cut mid-video shows only a co-host.
  CLIP_FACE_VERIFY_ENABLED: z.coerce.boolean().default(true),
  // "Clear footage only" gate. When on, each cut clip's sampled frames
  // (start/mid/end) are checked for logos, watermarks, on-screen text/captions,
  // title cards and end-screens; a clip is DROPPED if any frame is dirty. This
  // is stricter than the single-frame labeler junk check (which only looks at
  // the first frame and tolerates lower-third text). Costs up to 3 extra Gemini
  // Vision calls per clip — reuses the frames already sampled for face verify.
  CLIP_CLEAN_FOOTAGE_ENABLED: z.coerce.boolean().default(true),
  // "Celebrity images only" mode. When on, the image pool fetches ONLY the
  // main celebrity's images — no buildings, places, company/show logos, posters,
  // or even related people. Blocks that would otherwise show a non-person image
  // fall back to celebrity footage/image instead. Client requirement: the final
  // video shows only the celebrity, never off-person imagery.
  IMAGE_CELEBRITY_ONLY: z.coerce.boolean().default(true),
  // Master toggle for analyze-time face verification. When false, both the
  // thumbnail check AND the body-frame check are skipped — candidates are
  // accepted based on rankCandidate score alone. The verify code path is
  // kept (modules + DB table + per-call wiring) so this flag can be
  // flipped back on without code changes. Default false: the new
  // narration-aware query construction below targets the story beat
  // specifically (e.g. "David Walliams Britain's Got Talent transcript
  // 2022" instead of generic "David Walliams interview"), so on-topic
  // candidates land first and the verify gate's value drops. Re-enable
  // when face-recognition is needed to filter look-alike thumbnails.
  ANALYZE_FACE_VERIFY_ENABLED: z.coerce.boolean().default(false),
  // Toggle for analyze-time body-frame verification. In addition to the
  // single mqdefault.jpg check, sample YouTube's auto-generated frames
  // 1.jpg / 2.jpg / 3.jpg (taken at 25%/50%/75% of the video) and verify
  // each against the celebrity reference. Rejects "thumbnail bait" sources
  // where the custom thumbnail shows the celebrity but the body doesn't —
  // reaction videos, "what really happened" explainers, BGT audition
  // montages, etc. Costs ~3 extra Gemini Vision calls per candidate
  // (~$0.003) but stops the user from selecting source videos that will
  // produce zero useful clips. Only consulted when
  // ANALYZE_FACE_VERIFY_ENABLED is true.
  ANALYZE_BODY_VERIFY_ENABLED: z.coerce.boolean().default(true),
  // Toggle for the character-anchored query lane at analyze time. In
  // addition to script-aware queries (which target the story's specific
  // events), run a fixed set of templated queries against the project
  // celebrity: "{name} interview", "{name} talk show", "{name} red
  // carpet", etc. These return videos where the celebrity is the
  // on-screen subject (clean person footage) rather than the topic of
  // discussion — exactly the content the matcher needs to fill abstract
  // "celebrity_default" blocks. Results merge into every segment's pool
  // and compete with story-aware candidates via the existing ranker.
  ANALYZE_CHARACTER_LANE_ENABLED: z.coerce.boolean().default(true),
  MAX_VIDEOS_PER_PROJECT: z.coerce.number().int().positive().default(5),
  // Upper bound on the fraction of content blocks (image + footage) that may
  // be images. Gemini's per-sentence visual-type call lands ~50% images,
  // which over-uses the verified image pool (same photo repeats) and reads as
  // a slideshow. The transcript-driven builder caps images at this ratio and
  // converts the lowest visual_priority image blocks to footage. 0.30 = 30:70
  // image:footage; set 0.40 for 40:60. Range (0,1). Client direction
  // (2026-06): shift ~10% from stills to footage, so 0.40 → 0.30.
  MAX_IMAGE_RATIO: z.coerce.number().gt(0).lt(1).default(0.30),
  // Subject-first source-video target. The number of source videos we aim to
  // SELECT scales with voiceover duration instead of a flat constant: the
  // longer the narration, the more distinct footage sources it needs. Client
  // direction: 8 source videos per 5 minutes of audio. computeSourceVideoTarget
  // below turns these knobs into a per-project count.
  //   PER_WINDOW   – source videos per SOURCE_TARGET_WINDOW_SECONDS of audio.
  //   WINDOW       – the window the rate is expressed over (300s = 5min).
  //   FLOOR/CEIL   – clamp so very short clips still get a few sources and very
  //                  long ones don't explode the download/clip workload.
  SOURCE_TARGET_PER_WINDOW: z.coerce.number().int().positive().default(8),
  SOURCE_TARGET_WINDOW_SECONDS: z.coerce.number().int().positive().default(300),
  SOURCE_TARGET_FLOOR: z.coerce.number().int().positive().default(3),
  SOURCE_TARGET_CEILING: z.coerce.number().int().positive().default(30),
  // How many candidates to surface for review per the selected target. The
  // review pool is larger than the target so the user has real choice when
  // pruning wrong-person / off-topic videos. 1.5× the target by default.
  SOURCE_REVIEW_POOL_FACTOR: z.coerce.number().positive().default(1.5),
  MIN_SUCCESSFUL_VIDEOS_PER_PROJECT: z.coerce.number().int().nonnegative().default(2),
  // Appearance-count gate for downloading SOURCE VIDEOS / making CLIPS of a
  // SECONDARY person (anyone other than the project celebrity). A secondary
  // person earns the clip-search + download + clip path only when they are the
  // resolved subject of at least this many narration segments (totalBlocks from
  // the coreference ranking). Below the threshold they get STILL IMAGES only
  // (Wikipedia / Brave / Google CSE), which run for everyone regardless. The
  // main celebrity always qualifies and ignores this gate. Tune UP to spend
  // YouTube quota + clip-making only on frequently-appearing people; tune DOWN
  // to give more of the supporting cast real footage. Default 4 (≈28s of
  // narration at the typical block cadence).
  SECONDARY_PERSON_VIDEO_THRESHOLD: z.coerce.number().int().positive().default(4),
  // Person-image pool variety. The main celebrity's photo pool is sized by
  // audio duration — target ≈ voiceoverSeconds / 10 — so longer videos get
  // more unique images and no single photo repeats under the reuse cooldown.
  // PERSON_PHOTO_HARD_CAP clamps that duration-scaled target so very long
  // audios don't trigger thousands of Gemini face-verify calls (each pool
  // image costs one verify call). Raise the cap to allow MORE variety on long
  // videos at the cost of a slower match step. Default 80 (was an inline 40):
  // a 13-min+ video can now reach the cap instead of being clamped at 40.
  PERSON_PHOTO_HARD_CAP: z.coerce.number().int().positive().default(80),
  // How many image-search results each query pulls into the candidate pool
  // before dedup + face-verify. Higher = more candidates per query (pool
  // fills in fewer queries) but more verify calls per query. Pool SIZE is
  // governed by PERSON_PHOTO_HARD_CAP / the duration target, not this — this
  // only affects how fast the pool fills. Default 12.
  IMAGES_PER_ENTITY: z.coerce.number().int().positive().default(12),
  // Concurrency for the matcher's person-photo pool builder. Each fetched
  // candidate gets one Gemini face-verify (verifyPoolAsset) before it can
  // enter the cache; serially that is up to ~120 round-trips per person and
  // is the dominant cost of the match step on image-heavy projects. The
  // verifies are network-bound (Gemini Vision) and independent per URL, so
  // running a batch concurrently cuts wall-time roughly by this factor.
  // verifyPoolAsset has its own per-process LRU cache, so concurrent calls
  // for the same URL are safe. Default 6 — comfortably under Gemini's
  // per-key rate limit while collapsing the serial verify chain.
  MATCH_POOL_VERIFY_CONCURRENCY: z.coerce.number().int().positive().default(6),
  MAX_FALLBACK_PROMOTIONS_PER_PROJECT: z.coerce.number().int().nonnegative().default(5),
  MAX_CLIPS_PER_VIDEO: z.coerce.number().int().positive().default(20),
  // Per-clip pipeline concurrency inside one source. Each "lane" runs
  // cut+thumbnail+label+upload for one clip. Bumping this from 1 (serial)
  // to 4 cuts wall-time roughly proportionally because the steps are
  // I/O- or Gemini-bound, not CPU-bound. Drop to 2 on machines with
  // limited CPU/RAM if ffmpeg starts losing the race.
  CLIP_PIPELINE_CONCURRENCY: z.coerce.number().int().positive().default(4),
  // Render-stage parallelism. Render is encode-heavy (every clip gets a full
  // libx264 pass in normalize, every image↔image boundary triggers an
  // xfade re-encode, and every image↔video boundary triggers a fadeblack
  // xfade re-encode). Rule of thumb: RENDER_PIPELINE_CONCURRENCY *
  // FFMPEG_THREADS ≤ vCPU count. The production worker runs on Fly
  // shared-cpu-4x (4 vCPUs, see fly.toml), so the defaults 2 × 2 = 4 are
  // already the sweet spot — going higher makes ffmpeg processes fight for
  // cores and wall-time stays flat or gets worse. If you move to an 8-vCPU
  // host, bump FFMPEG_THREADS to 4 first (single-clip wall-time wins more
  // than extra lanes when the per-clip work is libx264).
  RENDER_PIPELINE_CONCURRENCY: z.coerce.number().int().positive().default(2),
  // How many candidate clips to generate per footage block in the timeline.
  // Higher = matcher has more options to pick from = better matches, but more
  // storage/processing. 1 = no choice, 2 = balanced, 3+ = quality-first.
  CLIP_OVERSAMPLING_FACTOR: z.coerce.number().positive().default(2),
  // Backfill reserve. Clip cuts are lost three ways — ffmpeg failure, the
  // clean-footage gate (logo/watermark), and the face gate (wrong person) —
  // and none are retried, so a source that aims for N clips often ends up
  // with fewer. To keep the surviving count per source stable, the clip
  // processor cuts a reserve of EXTRA candidate windows beyond the target
  // and keeps cutting from the reserve until `target` clips survive (or the
  // reserve / the source's physical capacity is exhausted). This factor
  // sizes that reserve as a fraction of the target: 0.5 = +50% extra windows
  // held in reserve (enough to absorb a ~33% drop rate). Set 0 to disable
  // backfill (cut exactly the target, no reserve — the old behaviour).
  CLIP_BACKFILL_BUFFER_FACTOR: z.coerce.number().nonnegative().default(0.5),
  // Hard ceiling on the candidate-window pool, expressed as a multiple of the
  // per-source survivor target (`cappedCount`). The clip processor first cuts
  // the proportional reserve pool (CLIP_BACKFILL_BUFFER_FACTOR, ~1.5× the
  // target); only when that pool exhausts with the target unmet does it
  // ESCALATE — generating a second batch of windows up to
  // `cappedCount × CLIP_MAX_POOL_FACTOR` total attempts. Default 3 = a
  // heavy-drop source attempts up to 3× the target before giving up (absorbs
  // a ~66% drop rate), while clean sources early-stop at the target and never
  // pay for the escalation. The ceiling exists because each window costs an
  // ffmpeg cut + up to 4 Gemini Vision calls — the old "use the whole source"
  // behaviour ground through hundreds of windows on long sources.
  CLIP_MAX_POOL_FACTOR: z.coerce.number().positive().default(3),
  // Lower bound on the project clip cap — prevents under-clipping for very
  // short voiceovers or when voiceover duration isn't known yet.
  MIN_CLIP_CAP: z.coerce.number().int().positive().default(20),
  // Upper bound on the project clip cap — prevents storage explosion for
  // very long voiceovers.
  MAX_CLIP_CAP: z.coerce.number().int().positive().default(400),
  MAX_SOURCE_DURATION_SECONDS: z.coerce.number().int().positive().default(1500),
  YTDLP_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(300),
  // Bumped from 120s — on shared-CPU hosts (Fly shared-cpu-2x) several
  // concurrent ffmpegs can starve each other and a single short clip cut
  // ends up taking >2 min. The fix is `-threads` capping + lower
  // CLIP_PIPELINE_CONCURRENCY, but we leave headroom for the slowest clip.
  FFMPEG_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(240),
  // Scene-detect runs once per source before clip cuts and decodes (downscaled)
  // every frame. It should fail fast: a slow scene-detect means the clip job
  // has to wait that long before its first lane starts, even though the
  // fallback (uniform sampling) produces perfectly usable clips. Keep this
  // well below FFMPEG_TIMEOUT_SECONDS so a pathological source can't burn
  // 4 minutes of dead time before we give up.
  SCENE_DETECT_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(90),
  // Hard cap on how many seconds of source we ask scene-detect to analyze.
  // 0 = no cap, scan the entire source. The previous 600s default caused a
  // real editorial bug: every clip extracted from a 30-min Dave interview
  // came from minutes 0–10, so the matcher had nothing from the back half
  // of the source. We now default to no cap and rely on downscale=320 +
  // SCENE_DETECT_TIMEOUT_SECONDS to keep wall-time in check. Operators can
  // set a positive value to re-enable the cap on cost-sensitive hosts.
  SCENE_DETECT_MAX_INPUT_SECONDS: z.coerce.number().int().nonnegative().default(0),
  // Scene-change sensitivity for ffmpeg's `select=gt(scene,T)` filter. Range
  // 0..1 where 0 = identical frames, 1 = totally different. 0.40 catches
  // hard cuts on long sources without flooding on minor lighting flicker;
  // dropping to 0.35 returns more boundaries (good for short, slow-cut
  // sources). Bumped from 0.35 when we lifted the 10-min input cap — a
  // 60-min source at 0.35 returned thousands of boundaries and slowed the
  // post-detect filtering work materially.
  SCENE_DETECT_THRESHOLD: z.coerce.number().min(0).max(1).default(0.4),
  // Per-ffmpeg thread cap. Multiplied by CLIP_PIPELINE_CONCURRENCY this is
  // the worst-case number of cores ffmpeg will try to use. Tune so the
  // product stays at or below the host's vCPU count to avoid thrash.
  FFMPEG_THREADS: z.coerce.number().int().positive().default(2),
  HTTP_DOWNLOAD_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(120),
  // Number of EXTRA attempts (beyond the first) a render-path download makes
  // when it hits a transient failure — a timeout, a 5xx/429 from the CDN, or a
  // mid-stream network drop. A single slow clip download (e.g. media.celebforge
  // .org stalling past the 120s timeout) used to fail its clip outright and
  // stall the whole render until the watchdog reaped it. 4xx (except 429) is
  // permanent and is NOT retried. 0 disables retries (legacy one-shot behavior).
  HTTP_DOWNLOAD_RETRIES: z.coerce.number().int().nonnegative().default(2),
  FFMPEG_PATH: z.string().default("ffmpeg"),
  FFPROBE_PATH: z.string().default("ffprobe"),
  YTDLP_PATH: z.string().default("yt-dlp"),
  // Global full-video effect overlay. A single effect clip (e.g. floating
  // dust/particle specks on a pure-black background) is screen-blended over
  // EVERY frame of the finished video — across intro clips, the opening
  // title card, and all body content — as a one-shot post-pass on the
  // concat output. Client direction (2026-06): the same effect overlays the
  // entire video for every project, so it lives in config, not per-project
  // state (no DB column, no UI).
  //
  //   EFFECT_OVERLAY_ENABLED — master toggle. Off by default so a deploy
  //     without the asset behaves exactly as before.
  //   EFFECT_OVERLAY_PATH    — absolute or worker-relative path to the
  //     effect video. The overlay is silently skipped (best-effort, logged)
  //     when the file is missing, so a misconfigured path never fails a
  //     render.
  //   EFFECT_OVERLAY_OPACITY — 0..1 strength of the screen blend. Particles
  //     on black wash nothing out even near 1.0, so 0.7 is a strong-but-safe
  //     default. Lower it to make the effect subtler.
  //
  // The overlay forces a full re-encode of the finished MP4 (compositing two
  // video layers is impossible with the concat's -c:v copy fast path), so it
  // adds one libx264 pass over the whole timeline. Audio is stream-copied —
  // the voiceover/music/SFX mix is already baked into the concat output.
  EFFECT_OVERLAY_ENABLED: z.coerce.boolean().default(false),
  EFFECT_OVERLAY_PATH: z.string().default("./assets/effect-overlay.mp4"),
  EFFECT_OVERLAY_OPACITY: z.coerce.number().min(0).max(1).default(0.85),
  // Pre-blend brightness gain on the effect layer. Multiplies the particle
  // luminance BEFORE the screen blend, so specks read brighter/whiter and
  // stay visible even on bright scenes (where plain screen blend washes out —
  // screen vanishes as the base approaches white no matter how high opacity
  // goes). 1.0 = no boost (original brightness). 2.0 = double. The black
  // background is unaffected (0 × gain = 0), so boosting gain never re-adds a
  // veil. Combine with OPACITY for overall strength: GAIN controls how bright
  // each particle is, OPACITY controls how much of the (brightened) effect
  // mixes in. Client direction (2026-06): effect was "too transparent" — the
  // 0.85 opacity + 2.0 gain defaults make it clearly visible across both dark
  // and bright content. Tune both as Fly secrets without a redeploy.
  EFFECT_OVERLAY_GAIN: z.coerce.number().min(1).max(8).default(2.0),
  // Run heavy subprocesses (ffmpeg, yt-dlp) at lower scheduling priority on
  // Linux. On shared-CPU hosts, full-throttle ffmpeg can starve Redis of CPU
  // long enough for idle TCP keepalives to time out, surfacing as
  // intermittent worker ECONNRESET logs even though Redis itself is fine.
  // `nice -n N` lets the kernel preempt the encoder whenever Redis/node
  // need a slice. 0 = disabled (default for local dev / Windows where the
  // binary doesn't exist). 10 = cooperative on Fly.
  NICE_LEVEL: z.coerce.number().int().min(0).max(19).default(0),
  // Service-account JSON for the Google Docs API. The Docs API does NOT
  // accept plain API keys (returns 401 UNAUTHENTICATED), so we authenticate
  // with a service-account-minted OAuth2 access token instead. Setup:
  //   1. Google Cloud Console → enable "Google Docs API"
  //   2. IAM & Admin → Service Accounts → Create service account
  //   3. Keys → Add key → JSON → download
  //   4. Paste the entire downloaded JSON into this env var (single line is
  //      fine; the parser handles newlines either way)
  //   5. Share each script doc with the service account's email
  //      (something@<project>.iam.gserviceaccount.com), OR set the doc to
  //      "Anyone with the link can view" — either works.
  // Without this set, the script-doc intake returns 503.
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  // Residential proxy pool for yt-dlp. YouTube blocks downloads from cloud
  // IPs (Fly/AWS/GCP) with a "Sign in to confirm you're not a bot" wall, so
  // every yt-dlp call has to egress through a residential proxy. Format is
  // newline- or comma-separated `ip:port:user:pass` entries (Webshare's
  // standard list export). Empty = no proxy (local/dev only).
  YTDLP_PROXIES: z.string().optional(),
  TMP_DIR: z.string().default("./tmp"),
  // Persistent render cache. Per-clip normalized outputs are written here keyed
  // by a content hash so a render that is interrupted (Fly machine reboot, OOM,
  // redeploy) can RESUME on retry instead of re-encoding all ~400 clips from
  // scratch. MUST point at a durable volume — on the worker that's the /data
  // mount (see fly.toml [[mounts]]), which survives restarts. Defaults to a
  // local ./tmp subdir for dev. The cache for a project is deleted after its
  // final video uploads successfully; a stale-entry sweep also bounds growth.
  RENDER_CACHE_DIR: z.string().default("./tmp/render-cache"),
  // Max age (hours) for a render-cache entry before the periodic sweep deletes
  // it. Sized so an in-progress render's clips are never reaped mid-flight but
  // orphans from a project that was abandoned/failed don't accumulate on /data.
  RENDER_CACHE_TTL_HOURS: z.coerce.number().positive().default(24),
});

export type ServerEnv = z.infer<typeof ServerEnvSchema>;

let cached: ServerEnv | null = null;

export function getEnv(): ServerEnv {
  if (cached) return cached;
  const parsed = ServerEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // We don't throw — many surfaces (e.g. settings page) need to render even
    // when keys are missing. Individual call sites validate the keys they need.
    cached = ServerEnvSchema.parse({});
    return cached;
  }
  cached = parsed.data;
  return cached;
}

// Clip duration is variable: when scene-detect provides both a start
// boundary and a next-boundary, we cut the clip to land exactly on that
// next boundary so the user never sees a mid-clip scene change. The result
// is clamped to [MIN, MAX]. Uniform-fallback clips (when scene-detect fails)
// stay at DEFAULT.
//
// Per client direction, clips now target ~6s instead of the previous 9s.
// The planner also splits long sentences into multiple sub-blocks (see
// FOOTAGE_HOLD_SECONDS in timeline-plan.ts), so even a 12s narration
// sentence produces two ~6s clips from different sources instead of one
// long talking-head hold. MAX is 7s — gives the scene-detect snapping a
// small margin of headroom without re-introducing 10-12s clips.
export const CLIP_DURATION_MIN_SECONDS = 5;
export const CLIP_DURATION_MAX_SECONDS = 7;
export const CLIP_DURATION_DEFAULT_SECONDS = 6;
// Back-compat alias — anything that still imports this gets the default.
export const CLIP_DURATION_SECONDS = CLIP_DURATION_DEFAULT_SECONDS;

// Total clips a project should generate, sized to the voiceover length so the
// final video has enough footage candidates without overshooting. Reads env
// for oversampling factor + floor/ceiling so operators can tune without code
// changes. Returns the floor when voiceover duration isn't available yet
// (e.g. clip job races voiceover generation).
export function computeProjectClipCap(voiceoverSeconds: number | null | undefined): number {
  const env = getEnv();
  if (!voiceoverSeconds || voiceoverSeconds <= 0) return env.MIN_CLIP_CAP;
  const plan = planTimeline(voiceoverSeconds);
  const target = Math.ceil(plan.footageBlocks * env.CLIP_OVERSAMPLING_FACTOR);
  return Math.min(env.MAX_CLIP_CAP, Math.max(env.MIN_CLIP_CAP, target));
}

// How many SOURCE VIDEOS to target for a project, sized to voiceover length.
// This replaces the flat MAX_VIDEOS_PER_PROJECT for the subject-first
// discovery/review flow: the count scales at SOURCE_TARGET_PER_WINDOW per
// SOURCE_TARGET_WINDOW_SECONDS (default 8 per 5 min), clamped to
// [FLOOR, CEILING]. Falls back to the floor when duration isn't known yet.
//
// Returns BOTH the target (how many to select) and the review pool size (how
// many candidates to surface for pruning, = target × SOURCE_REVIEW_POOL_FACTOR).
export function computeSourceVideoTarget(
  voiceoverSeconds: number | null | undefined,
): { target: number; reviewPoolSize: number } {
  const env = getEnv();
  let target: number;
  if (!voiceoverSeconds || voiceoverSeconds <= 0) {
    target = env.SOURCE_TARGET_FLOOR;
  } else {
    const raw = Math.round(
      (voiceoverSeconds / env.SOURCE_TARGET_WINDOW_SECONDS) * env.SOURCE_TARGET_PER_WINDOW,
    );
    target = Math.min(env.SOURCE_TARGET_CEILING, Math.max(env.SOURCE_TARGET_FLOOR, raw));
  }
  const reviewPoolSize = Math.max(target, Math.round(target * env.SOURCE_REVIEW_POOL_FACTOR));
  return { target, reviewPoolSize };
}
