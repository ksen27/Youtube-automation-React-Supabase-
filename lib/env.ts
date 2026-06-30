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
  // Secondary model the planner falls back to when GEMINI_MODEL keeps throwing
  // retryable 503/429 "high demand" errors after its full retry budget. A demand
  // spike on one Gemini model (e.g. gemini-2.5-flash) usually does NOT hit a
  // different model, so re-running the call on gemini-2.0-flash turns a Google
  // outage into a slightly slower success. Set empty to disable the fallback.
  GEMINI_FALLBACK_MODEL: z.string().default("gemini-2.0-flash"),
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
  // Per-segment H.264 encode quality (libx264) for the SYNTHETIC engine only.
  // Both engines render on the same worker, so quality is chosen per-render by
  // project.engine (see renderProcessor), NOT per-worker. Celebrity (sourced)
  // renders are HARD-PINNED in code to the original ultrafast/crf25 and ignore
  // these vars entirely, so celebrity output is byte-for-byte unchanged. These
  // only tune the synthetic path; defaults give synthetic the sharper
  // veryfast/crf21. EVERY segment in one render shares the chosen values so the
  // final concat stays on the -c:v copy fast path.
  SYNTHETIC_X264_PRESET: z
    .enum(["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"])
    .default("veryfast"),
  SYNTHETIC_X264_CRF: z.coerce.number().int().min(0).max(51).default(21),
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
  // PERFORMANCE_MODE — diagnostic "no visual effects" render path for the
  // SYNTHETIC (AI avatar) engine ONLY. When true, a synthetic render skips ALL
  // clip-to-clip transitions (image↔image xfade, image↔video / video↔image
  // fade-through-black) and the global particle overlay, producing the simplest
  // possible pipeline: render clips → concat → add audio → output. Hard cuts
  // only. Clips, timing, audio, subtitles, and avatar functionality are
  // unchanged — only the visual-effect re-encode passes are removed, so the
  // render-time delta isolates exactly how much those effects cost. The sourced
  // (celebrity) engine ignores this flag entirely (byte-for-byte unchanged).
  // Off by default — a normal deploy renders with effects as before.
  PERFORMANCE_MODE: z.coerce.boolean().default(false),
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

  // =======================================================================
  // SYNTHETIC ENGINE (migration 0020). All optional — when unset, the
  // synthetic generate route 503s but the sourced engine is unaffected.
  // =======================================================================
  // 69labs — TTS voiceover + nano-banana image generation.
  // Real API (69labs.vip) is async job-based: POST /api/v1/tts/generate ->
  // poll GET /api/v1/tts/status/:jobId -> GET /api/v1/tts/download/:jobId.
  // Base URL has NO version suffix here; route paths include /api/v1/...
  SIXTYNINE_LABS_API_KEY: z.string().optional(),
  // Optional SECOND 69labs key (a SEPARATE account). When set, it joins the
  // primary in a KEY POOL: image and TTS generations are load-balanced
  // round-robin across both keys, and each key gets its OWN concurrency slot
  // pool (SIXTYNINE_IMAGE_CONCURRENCY per key), so two separate-account keys run
  // their tier limits IN PARALLEL — roughly doubling throughput. It also still
  // acts as a failover: if one key hits a permanent auth 403, the generation is
  // retried on the other. Leave empty for single-key behavior (identical to
  // before). NOTE: only worth setting if this is a DIFFERENT account — two keys
  // on the same account share one tier limit and gain no parallelism.
  SIXTYNINE_LABS_API_KEY_BACKUP: z.string().optional(),
  SIXTYNINE_LABS_BASE_URL: z.string().url().default("https://69labs.vip"),
  // TTS voiceProvider: elevenlabs | edgetts | minimax (wire-level value).
  SIXTYNINE_LABS_TTS_PROVIDER: z.string().default("elevenlabs"),
  // modelId default depends on provider (eleven_multilingual_v2 for elevenlabs).
  SIXTYNINE_LABS_TTS_MODEL: z.string().default("eleven_multilingual_v2"),
  SIXTYNINE_LABS_IMAGE_MODEL: z.string().default("nano-banana-2"),
  // Output resolution for nano-banana image generation. The 69labs UI exposes a
  // 1K/2K/4K selector (Nano Banana Pro); the API defaulted to 1K (~720p), which
  // is BELOW the 1080p synthetic render, so images were upscaled and soft.
  // Default 2K so generated stills are sharp at 1080p output. Sent as the
  // `resolution` field on the generate request ONLY when non-empty; set to ""
  // to omit it (revert to the provider default) if the API rejects the value.
  // The exact accepted value string ("2K" vs "2k" etc.) is provider-defined —
  // override here without a code change if needed. Pro resolutions may also
  // require setting SIXTYNINE_LABS_IMAGE_MODEL to the Pro model name.
  // Verified valid values for nano-banana-2: "1k" | "2k" | "4k" (LOWERCASE —
  // the API 400s on "2K"). "" omits the field (provider default = 1k).
  SIXTYNINE_LABS_IMAGE_RESOLUTION: z.string().default("2k"),
  SIXTYNINE_LABS_DEFAULT_VOICE: z.string().default("narrator"),
  // Max seconds to poll a TTS job to COMPLETED before giving up.
  SIXTYNINE_LABS_TTS_POLL_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(600),
  // Max seconds to poll an image job to COMPLETED before giving up.
  SIXTYNINE_LABS_IMAGE_POLL_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(300),
  // Flux image fallback when nano-banana fails (Black Forest Labs or a proxy).
  FLUX_API_KEY: z.string().optional(),
  FLUX_BASE_URL: z.string().url().default("https://api.bfl.ai/v1"),
  FLUX_MODEL: z.string().default("flux-pro-1.1"),
  // LTX-2 (api.ltx.video) — PRIMARY image-to-video provider. Per client
  // direction (2026-06) the synthetic ai_clip blocks animate via LTX-2's
  // async image-to-video API; fal.ai (below) is the fallback chain when LTX
  // fails. Lifecycle: POST /v2/image-to-video -> { id } -> poll
  // GET /v2/image-to-video/{id} until status 'completed' -> download
  // result.video_url. When LTX_API_KEY is unset the clip path skips straight
  // to fal.ai, so leaving it blank reverts to the old fal-only behaviour.
  //
  // LTX-2 duration is a DISCRETE tier, not arbitrary: at 1080p/25fps it
  // accepts 6/8/10/12/14/16/18/20s (max 20s). Higher res/fps caps at 10s.
  // We request 1920x1080 (16:9, LTX's only supported aspect) which unlocks
  // the full tier range, and the provider snaps each requested duration to
  // the nearest allowed tier. Since the planner now caps visual blocks at
  // ~8s (SYNTHETIC_BLOCK_SPLIT_THRESHOLD below), clips land on 6 or 8 in
  // practice and never need splitting at render time.
  LTX_API_KEY: z.string().optional(),
  LTX_BASE_URL: z.string().url().default("https://api.ltx.video"),
  LTX_MODEL: z.string().default("ltx-2-3-pro"),
  LTX_RESOLUTION: z.string().default("1920x1080"),
  // LTX-2 source frame rate. Allowed values are 25 or 50 (NOT 24 — the API
  // rejects fps 24 for ltx-2-fast at 1080p). The render pipeline re-encodes
  // every clip to SYNTHETIC_FPS (30) downstream, so this only has to be a value
  // LTX accepts; 25 is the documented default for the 1080p duration tiers.
  LTX_FPS: z.coerce.number().int().positive().default(25),
  LTX_MAX_DURATION: z.coerce.number().int().positive().default(20),
  // Hard timeout (seconds) for a single LTX image-to-video job (poll loop).
  LTX_POLL_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(600),
  // fal.ai — image-to-video FALLBACK (Veo 3 Fast, then Kling). Tried only
  // when LTX-2 fails or is unconfigured. See generateClipWithFallback.
  FAL_AI_API_KEY: z.string().optional(),
  FAL_AI_BASE_URL: z.string().url().default("https://queue.fal.run"),
  FAL_AI_VEO_MODEL: z.string().default("fal-ai/veo3/fast/image-to-video"),
  FAL_AI_KLING_MODEL: z.string().default("fal-ai/kling-video/v1/standard/image-to-video"),
  // Hard timeout (seconds) for a single fal.ai image-to-video job (poll loop).
  FAL_AI_POLL_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(600),
  // HeyGen avatar automation (Playwright — NOT the API, per spec).
  HEYGEN_BASE_URL: z.string().url().default("https://app.heygen.com"),
  // 64-hex-char (32-byte) AES-256-GCM key encrypting heygen_accounts secrets
  // and cookies. Generate with: openssl rand -hex 32. Without it, the HeyGen
  // account routes 503 (encryption refuses to run with a missing/short key).
  SECRET_BOX_KEY: z.string().optional(),
  // Newline/comma-separated residential proxy pool (ip:port:user:pass) for
  // HeyGen browser sessions. Per-account `proxy` column overrides this.
  HEYGEN_PROXIES: z.string().optional(),
  // Opt-in: let HeyGen reuse the shared YTDLP_PROXIES pool when HEYGEN_PROXIES
  // is unset. OFF by default — those proxies are tuned for yt-dlp and can
  // reject the browser with HTTP 407 (proxy auth), failing every avatar job.
  // Only enable if you've confirmed the shared pool authenticates a browser.
  HEYGEN_USE_YTDLP_PROXIES: z.coerce.boolean().default(false),
  // Run the browser headful (false) for local debugging of HeyGen automation.
  HEYGEN_HEADLESS: z.coerce.boolean().default(true),
  // Per-attempt timeout (ms) for one HeyGen avatar generation in the browser.
  HEYGEN_NAV_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  // Timeout (ms) for SETUP-phase UI-readiness waits (composer load, photo
  // preview, upload chooser) — as distinct from the long render budget. The old
  // code reused HEYGEN_NAV_TIMEOUT_MS (120s) for these, so a single slow/stale
  // selector stalled the job up to 2 min EACH and they stacked to ~6 min before
  // generation even started. A tighter budget fails a genuinely slow run fast so
  // it retries (or rotates) instead of hanging.
  //
  // Raised to 90s (was 45s) on 2026-06-26: with patchright (stealth) the
  // composer reliably LOADS — diagnostics caught the fully-rendered /avatar page
  // with the script field present — but it took ~70-90s to paint through the
  // proxy, JUST past the 45s budget, so waitFirstVisible(scriptField) timed out
  // and threw a FALSE `blank_composer` on a page that was actually fine. 90s sits
  // above the real paint time. Bump further if real loads exceed it.
  HEYGEN_SETUP_TIMEOUT_MS: z.coerce.number().int().positive().default(90_000),
  // How long verifyAuthenticated waits for the authed/sign-in marker to render
  // before judging the session. The heavy HeyGen SPA renders its nav at ~14.5s
  // through a residential proxy — the old hardcoded 15s caused FALSE expiries
  // (a valid session timed out and got flagged needs_reauth). The 45s default
  // was ALSO too tight: measured 2026-06-26 the authed marker took ~46s through
  // the residential proxy, so a still-valid session got mis-judged "expired" and
  // emptied the single-account pool ("no available accounts"). Default 90s to
  // sit comfortably above real proxy latency. Bump if real loads exceed it.
  HEYGEN_AUTH_MARKER_TIMEOUT_MS: z.coerce.number().int().positive().default(90_000),
  // How long an avatar render may take inside HeyGen before we give up (ms).
  HEYGEN_RENDER_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
  // fail_count threshold past which an account is auto-disabled (taken out of
  // rotation) rather than merely cooled down.
  HEYGEN_MAX_FAIL_COUNT: z.coerce.number().int().positive().default(3),
  // Cooldown window (minutes) applied to an account after a soft failure.
  HEYGEN_COOLDOWN_MINUTES: z.coerce.number().int().positive().default(30),
  // Where Playwright failure screenshots are written (R2-uploaded for audit).
  HEYGEN_SCREENSHOT_DIR: z.string().default("./tmp/heygen-shots"),
  // Where failure diagnostics (screenshot + HTML snapshot + url/title json) are
  // written locally before R2 upload. See lib/synthetic/heygen-auth.ts.
  HEYGEN_LOG_DIR: z.string().default("./logs/heygen"),
  // Debug mode (spec G): run the browser headful with slowMo and a page.pause()
  // so you can step through HeyGen's UI when it changes. Forces headless off
  // regardless of HEYGEN_HEADLESS. NEVER enable on a headless worker host.
  HEYGEN_DEBUG: z.coerce.boolean().default(false),
  // slowMo (ms) applied to every Playwright action when HEYGEN_DEBUG is on.
  HEYGEN_SLOWMO_MS: z.coerce.number().int().nonnegative().default(500),
  // Anti-bot hardening (Cloudflare flags datacenter IPs + headless fingerprints
  // and kills the session). A realistic desktop Chrome user-agent reduces the
  // headless fingerprint. Update the Chrome major version periodically.
  HEYGEN_USER_AGENT: z
    .string()
    .default(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    ),
  // When true, the headed connect flow ALSO routes through the worker's proxy so
  // the session's exit IP matches the IP the headless worker later uses (HeyGen
  // flags IP churn between login and use). Requires a WORKING residential proxy
  // (HEYGEN_PROXIES) — leave false until proxy auth is confirmed (the shared
  // YTDLP pool 407'd). Default false: connect from the human's own IP.
  HEYGEN_CONNECT_USES_PROXY: z.coerce.boolean().default(false),
  // Use the stealth-patched Chromium (patchright) instead of vanilla Playwright
  // for the HeyGen browser. Vanilla headless Chromium intermittently fails
  // Cloudflare's bot challenge on /home and /avatar — the page comes up blank
  // ("blank_composer") even though the session is valid (observed 2026-06-26:
  // bursts of successes interleaved with bursts of blank-composer failures, IP
  // and session both healthy). patchright removes the CDP/headless tells that
  // hand-rolled init scripts can't. When true, openAuthedContext also DROPS the
  // manual anti-automation args/UA override — those are themselves detection
  // tells that patchright strips automatically. Toggleable so we can A/B and
  // revert without a code change. Requires patchright + its Chromium installed
  // (see Dockerfile.worker). Default false (vanilla Playwright).
  HEYGEN_USE_STEALTH: z.coerce.boolean().default(false),
  // Seconds to wait before each avatar attempt, to break up burst patterns that
  // trip HeyGen's anti-bot. 0 disables. Avatar concurrency is already 1, so this
  // just spaces serial jobs apart.
  HEYGEN_JOB_SPACING_SECONDS: z.coerce.number().int().nonnegative().default(20),
  // BACKSTOP cap on how many renders the warm headless browser may drive before
  // it is preemptively torn down and rebuilt FRESH from stored cookies. As of
  // the health-based recycling refactor (lib/synthetic/heygen-health.ts) this is
  // NO LONGER the primary recycle trigger — a browser that goes bad (blank
  // composer / Cloudflare wall, failure streak, crash, disconnect) is recycled
  // by HEALTH the moment it degrades, which is faster and avoids re-driving a
  // broken session. The cap remains as a PREEMPTIVE safety net for the happy
  // path: production (2026-06-26) showed a healthy headless session still gets
  // Cloudflare-flagged after a number of renders and then walls every /avatar
  // load (the SESSION is flagged, not just the page; a page-only rebuild can't
  // recover it). Recycling BEFORE that point keeps the happy path from ever
  // hitting the wall. Set it just above the observed safe render count so
  // healthy browsers stay warm longer (the speed win) while never reaching the
  // wall; health catches anything that degrades earlier. 0 disables the cap and
  // relies on health alone.
  HEYGEN_MAX_RENDERS_PER_SESSION: z.coerce.number().int().nonnegative().default(6),
  // Minutes between session refreshes for `npm run heygen:keepalive --watch`.
  // Keep it below HeyGen's idle-session TTL so the sliding window never lapses
  // and a single account stays logged in across bursts and quiet periods.
  HEYGEN_KEEPALIVE_MINUTES: z.coerce.number().int().positive().default(30),
  // The avatar worker keeps ONE warm browser+context alive and reuses it across
  // jobs (lib/synthetic/heygen-session). Re-verifying the session by navigating
  // to /home on EVERY job is what burned the session after ~3 renders (each
  // /home hit is a fresh Cloudflare challenge). Instead we re-verify only when
  // the warm session was last verified more than this many minutes ago; back-to-
  // back jobs within the window skip the /home check and go straight to /avatar.
  // Keep it below HeyGen's idle TTL but high enough that a burst doesn't re-verify
  // each time. Default 20.
  HEYGEN_REVERIFY_AFTER_MINUTES: z.coerce.number().int().nonnegative().default(20),
  // HeyGen requires a VOICE to be selected before it will generate (otherwise
  // it errors "Please select the voice id"). This is the voice NAME to pick in
  // HeyGen's voice modal — it is HeyGen's own voice, NOT a 69labs voiceId (a
  // different provider used for the master voiceover). A substring match is
  // used, so "narrator" or a full name both work. Default targets a neutral
  // English narrator; set to whatever voice you want every avatar to speak in.
  HEYGEN_VOICE: z.string().default("narrator"),

  // Which queue group this worker process serves. Lets the celebrity
  // (sourced) and AI-avatar (synthetic) engines run on SEPARATE Fly machines:
  //   'all'       (default) — both engines, single-worker setup (unchanged).
  //   'sourced'   — only the celebrity queues (search/download/clip/match/render/scriptClip).
  //   'synthetic' — only the AI-avatar queues (tts/planner/image/video/avatar).
  // The synthetic worker can be a separate Fly app with auto_stop (scales to
  // zero when idle) since avatar generation is bursty, not 24/7.
  WORKER_ROLE: z.enum(["all", "sourced", "synthetic"]).default("all"),

  // Per-queue concurrency for the synthetic asset-generation queues. Mirrors
  // the spec: tts=2, planner=2, image=3, video=2, avatar=1. Avatar stays at 1
  // because each HeyGen browser session is heavy and account-rotation is
  // serial by design.
  TTS_CONCURRENCY: z.coerce.number().int().positive().default(2),
  SYNTHETIC_PLANNER_CONCURRENCY: z.coerce.number().int().positive().default(2),
  // Max transcript chars sent to the planner's Gemini call in ONE request. A
  // long script (e.g. a 30-min, ~27k-char voiceover) makes Gemini emit a
  // segments array that overflows its output-token budget and truncates the
  // JSON mid-stream — which JSON.parse then reports as the misleading
  // "Gemini returned non-JSON". Above this size buildSyntheticTimeline splits
  // the transcript at sentence boundaries into chunks of <= this many chars,
  // plans each chunk in its own call, and concatenates the segments — so no
  // single response is large enough to truncate. Tuned below the size that
  // truncates gemini-2.5-flash with thinkingBudget:0 + 8k output tokens; the
  // working 11k-char project planned fine in one call, the 27k-char one didn't.
  SYNTHETIC_PLANNER_MAX_CHARS_PER_CALL: z.coerce.number().int().positive().default(14000),
  // image=4 to match one 69labs account's tier ceiling (4 concurrent). The
  // PER-KEY SIXTYNINE_IMAGE_CONCURRENCY semaphore below is the real safety cap;
  // this just lets the image_gen worker feed up to 4 jobs into it. With a second
  // key (a separate account) the pool admits 8 in flight (4 per key); the feed
  // lanes combined (image_gen 4 + image_to_video 3 + avatar 1 = 8) can fill that.
  // Raise this toward 8 if you want an image-only batch (no clips/avatars) to use
  // both accounts on its own — the per-key semaphore still prevents any single
  // account from exceeding its tier.
  IMAGE_GEN_CONCURRENCY: z.coerce.number().int().positive().default(4),
  // ai_clip lane: each job generates a 69labs still then animates it via LTX-2.
  // Raised 2 -> 3 to overlap one more clip. The LTX-2 video calls have no tier
  // cap of their own, and the still-generation step is still bounded by the
  // SIXTYNINE_IMAGE_CONCURRENCY=4 semaphore below regardless of this number — so
  // 3 ai_clips' stills coexist safely under the 4-concurrent 69labs ceiling. Do
  // NOT raise so high that this lane alone could push concurrent 69labs image
  // calls past 4 (it shares that cap with image_gen and avatar/split_2 stills).
  IMAGE_TO_VIDEO_CONCURRENCY: z.coerce.number().int().positive().default(3),
  AVATAR_CONCURRENCY: z.coerce.number().int().positive().default(1),
  // Hard cap on CONCURRENT 69labs image generations PER KEY. The image_gen,
  // image_to_video (generates a still first), and avatar/split_2 (right-half
  // still) lanes all call generateImage independently, so their combined
  // in-flight count can exceed 69labs' real per-account limit, which returns a
  // 403 "Concurrent image generation limit reached" / a 503 cooldown that fails
  // the segment. A per-key semaphore bounds each account's in-flight total below
  // its tier limit, regardless of how the per-queue concurrencies add up.
  //
  // 69labs allows only 1–4 concurrent generations DEPENDING ON SUBSCRIPTION TIER
  // (per 69labs guidance), and pushing past the tier ceiling triggers cooldowns
  // — NOT the "7" an earlier comment assumed. Default 4 = the confirmed tier
  // ceiling (each account permits 4 concurrent), the fastest setting that stays
  // inside the band. Lower to 1–2 if you ever hit 503 "service unavailable" /
  // cooldowns (a lower tier / shared account); do NOT raise above 4 without
  // confirming a higher tier, or the cooldowns return.
  //
  // This is PER KEY: with a second key (SIXTYNINE_LABS_API_KEY_BACKUP) on a
  // separate account, the cluster runs up to (this × number of keys) concurrent
  // generations — e.g. 4 × 2 = 8 — because each key has its own slot pool.
  SIXTYNINE_IMAGE_CONCURRENCY: z.coerce.number().int().positive().default(4),

  // Synthetic visual-block pacing. The client's reference video paces every
  // visual block (image / ai_clip / split_2) at ~3-8s. Gemini's planner emits
  // blocks of arbitrary length (a long sentence can yield a 13-21s block),
  // which (a) reads as a static hold against the reference and (b) exceeds
  // what LTX-2 can generate in a single image-to-video call. The planner's
  // duration-split pass divides any visual block longer than
  // SYNTHETIC_BLOCK_SPLIT_THRESHOLD into round(duration / TARGET) back-to-back
  // sub-blocks (each inheriting the parent's prompts + a proportional slice of
  // script and spoken-time window), so every block lands in the 3-8s window
  // and inside LTX's single-generation tier. 'avatar' blocks are exempt — a
  // talking head holds for the full sentence and is generated by HeyGen, not
  // LTX.
  SYNTHETIC_BLOCK_TARGET_SECONDS: z.coerce.number().positive().default(6),
  SYNTHETIC_BLOCK_SPLIT_THRESHOLD: z.coerce.number().positive().default(8),
  // Minimum on-screen hold for a single visual block (client feedback 2026-06:
  // "the image switches are too often / only one second in between — slow
  // everything down, make it ~5-6s"). The synthetic timeline pins each visual
  // to its sentence's spoken window, so a short sentence yields a ~1-2s flash;
  // live data showed ~50-65% of visual blocks under 5s in long runs. The
  // planner's merge-short pass (mergeShortVisualSegments) absorbs consecutive
  // SHORT same-type visual blocks into one held visual until it reaches this
  // minimum, capped at SYNTHETIC_BLOCK_SPLIT_THRESHOLD so a merged ai_clip
  // stays inside LTX's animatable range. avatar blocks are exempt. Set to 0 to
  // disable the merge entirely (back to one-visual-per-sentence pacing).
  SYNTHETIC_BLOCK_MIN_HOLD: z.coerce.number().nonnegative().default(5),
  // Clip-heavy intro (client requirement 2026-06). The reference channel opens
  // with mostly MOVING footage and shifts to still images later to save credits.
  // Any 'image' block whose spoken window STARTS before this many seconds is
  // promoted to 'ai_clip' so the first stretch of the video is animated. After
  // this cutoff blocks keep whatever type Gemini chose (stills dominate, cheaper).
  // 0 disables the promotion entirely.
  SYNTHETIC_CLIP_HEAVY_SECONDS: z.coerce.number().nonnegative().default(180),
  // split_2 cap (client feedback 2026-06: "too many split_2 parts, I don't want
  // many split_2 part video"). split_2 (a talking presenter beside an
  // illustrative still) is chosen freely by Gemini and routinely overruns — one
  // 115-block plan came back with 50 split_2 (~43%). This caps split_2 at this
  // FRACTION of total blocks; the excess (lowest-priority first) is demoted to a
  // plain 'image'. Default 0.12 keeps a sprinkle (~1 in 8) and kills the flood.
  // Set to 0 to demote EVERY split_2 to image (no presenter-beside-image layout);
  // set to 1 to disable the cap (back to Gemini's unrestricted choice).
  SYNTHETIC_SPLIT2_MAX_FRACTION: z.coerce.number().min(0).max(1).default(0.12),
  // Low-fi "vlogging" degrade (client requirement 2026-06). The reference channel
  // looks REAL precisely because its footage is slightly LOW QUALITY — grainy,
  // soft, compressed, like a real phone vlog. Our generations come out too clean
  // / too perfect, which reads as AI. So we deliberately degrade BOTH the stills
  // (sharp, before upload) and the final rendered video (one ffmpeg pass) toward
  // that look. RESOLUTION IS UNCHANGED — the client still wants 1080p; we lower
  // texture quality (grain/softness/compression) at full dimensions, NOT the
  // pixel size. Defaults are MODERATE: real-footage feel without looking broken.
  //   SYNTHETIC_DEGRADE_ENABLED — master toggle (both image + video).
  //   *_BLUR_SIGMA  — gaussian softness (0 = none). ~0.6 is subtle.
  //   *_NOISE       — grain amount. image: sharp 0..100-ish; video: ffmpeg noise
  //                   strength (alls). ~8-12 reads as real sensor grain.
  //   IMAGE_JPEG_QUALITY — re-encode quality 1..100 (lower = more artifacts).
  //   VIDEO_CRF_DELTA    — added to SYNTHETIC_X264_CRF on the degrade pass
  //                        (higher CRF = more compression artifacts).
  // Defaults = "moderate" on the tuning ladder (client-picked 2026-06): clearly
  // low-fi and matching the reference's grain/softness while still reading as a
  // real photo, not a damaged one. Earlier defaults were too weak to see.
  // Disabled (client 2026-06-29): client wants the ORIGINAL screen quality in
  // the avatar video — no low-fi degrade. Off by default for both image + video
  // degrade; re-enable per-env if the vlog look is wanted again.
  SYNTHETIC_DEGRADE_ENABLED: z.coerce.boolean().default(false),
  SYNTHETIC_DEGRADE_BLUR_SIGMA: z.coerce.number().nonnegative().default(0.8),
  SYNTHETIC_DEGRADE_IMAGE_NOISE: z.coerce.number().nonnegative().default(22),
  SYNTHETIC_DEGRADE_IMAGE_JPEG_QUALITY: z.coerce.number().int().min(1).max(100).default(60),
  SYNTHETIC_DEGRADE_VIDEO_NOISE: z.coerce.number().nonnegative().default(18),
  SYNTHETIC_DEGRADE_VIDEO_CRF_DELTA: z.coerce.number().int().nonnegative().default(6),
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
