import { z } from "zod";
import { planTimeline } from "@/lib/ai/timeline-plan";

// Server-only env. Never import this from a "use client" file.
const ServerEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
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
  MIN_SUCCESSFUL_VIDEOS_PER_PROJECT: z.coerce.number().int().nonnegative().default(2),
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
  FFMPEG_PATH: z.string().default("ffmpeg"),
  FFPROBE_PATH: z.string().default("ffprobe"),
  YTDLP_PATH: z.string().default("yt-dlp"),
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
