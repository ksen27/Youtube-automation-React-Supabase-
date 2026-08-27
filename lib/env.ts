import { z } from "zod";
import { planTimeline } from "@/lib/ai/timeline-plan";

/**
 * Boolean env var that can actually be switched OFF.
 *
 * THE BUG THIS REPLACES: every flag in this file used `z.coerce.boolean()`,
 * which is `Boolean(value)` — and `Boolean("false")` is `true`. So a flag set to
 * the string "false" in fly.toml or a Fly secret read as ON, and the only way to
 * disable anything was to UNSET the variable entirely. Two comments in this file
 * already documented the trap for individual flags without fixing it, and
 * SYNTHETIC_PLAN_ALIGN_FIRST worked around it inline.
 *
 * It was not theoretical. `SYNTHETIC_CLIP_QUOTA_RESPECT_CUTOFF = "false"` shipped
 * in fly.avatar.toml and ran as TRUE, confining the entire clip budget to the
 * first 15 minutes: on a 31-minute video (2026-08-19, project 36a374a5) minutes
 * 15-31 rendered with zero moving footage while the summary log reported a
 * perfectly correct 30.3% clip share. Wrong in a way that reads as right.
 *
 * Accepts the usual off-spellings, case- and whitespace-insensitive. An EMPTY
 * string means "not configured" and falls back to `def` — an accidentally-blank
 * var must not silently flip a flag in either direction.
 */
const boolish = (def: boolean) =>
  z
    .preprocess((v) => {
      if (typeof v !== "string") return v;
      const s = v.trim();
      if (s === "") return def;
      return !/^(0|false|no|off)$/i.test(s);
    }, z.boolean())
    .default(def);

// Names of every boolish flag whose raw env value spells "off". Populated at
// parse time and reported by getEnv() so a deploy shows exactly which flags the
// fix above turned off — the ones that were silently ON before it landed.
const FLAGS_EXPLICITLY_OFF: string[] = [];

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
  // Optional DEDICATED YouTube Data API key for the /thumbnails feature only.
  // Put it in a SEPARATE Google Cloud project to get its own 10,000/day quota,
  // so channel-style analysis never competes with the celebrity video engine's
  // YouTube search quota. Falls back to YOUTUBE_API_KEY when unset.
  YOUTUBE_API_KEY_THUMBNAILS: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  // Brave Image Search API. Primary image source — get a key at
  // https://api-dashboard.search.brave.com/. Free tier: 1 qps, 2000/month.
  BRAVE_SEARCH_API_KEY: z.string().optional(),
  // Google Programmable Search (Custom Search JSON API). Fallback when Brave
  // returns nothing. Cloud Console → enable Custom Search API → create key.
  // CX is the Programmable Search Engine ID from programmablesearchengine.google.com.
  GOOGLE_SEARCH_API_KEY: z.string().optional(),
  GOOGLE_SEARCH_CX: z.string().optional(),
  // Pinned to a model verified to accept thinkingConfig.thinkingBudget: 0. The
  // previous "-latest" alias repointed (2026-07) to a Gemini-3-generation model
  // that 400s "invalid argument" on thinkingBudget: 0 — and a 400 is
  // non-retryable, so every planner/scoreClips call hard-failed without ever
  // reaching the fallback. If Google retires this pin (404 "no longer
  // available" — happened before to gemini-2.0-flash), withGeminiModelFallback
  // treats the retirement as fallback-eligible and moves to the alias below.
  GEMINI_MODEL: z.string().default("gemini-2.5-flash"),
  // Secondary model for primary-model outages (503/429 after the full retry
  // budget) and retirements (404). The -latest alias always resolves to a live
  // model; when that model rejects thinkingConfig, getModel retries the call
  // once with the thinkingConfig stripped. Set empty to disable the fallback.
  GEMINI_FALLBACK_MODEL: z.string().default("gemini-flash-latest"),
  DEEPGRAM_API_KEY: z.string().optional(),
  DEEPGRAM_MODEL: z.string().default("nova-3"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(2),
  DOWNLOAD_CONCURRENCY: z.coerce.number().int().positive().default(1),
  // Toggle for the per-clip Gemini Vision labeler. Costs ~$0.001 per clip;
  // disable when running cost-sensitive tests.
  CLIP_LABELING_ENABLED: boolish(true),
  // Toggle for per-clip face-reference verification. After each clip is cut,
  // compare its thumbnail against the project celebrity's Wikipedia photo
  // via verifyPoolAsset. Clips that fail get tagged subject_present:no so
  // the matcher's existing person-gate drops them from person_default
  // blocks. Costs one Gemini Vision call per clip (~$0.001) and stops the
  // "wrong person in the clip" failure mode where the source thumbnail
  // shows the celebrity but a cut mid-video shows only a co-host.
  CLIP_FACE_VERIFY_ENABLED: boolish(true),
  // "Clear footage only" gate. When on, each cut clip's sampled frames
  // (start/mid/end) are checked for logos, watermarks, on-screen text/captions,
  // title cards and end-screens; a clip is DROPPED if any frame is dirty. This
  // is stricter than the single-frame labeler junk check (which only looks at
  // the first frame and tolerates lower-third text). Costs up to 3 extra Gemini
  // Vision calls per clip — reuses the frames already sampled for face verify.
  CLIP_CLEAN_FOOTAGE_ENABLED: boolish(true),
  // "Celebrity images only" mode. When on, the image pool fetches ONLY the
  // main celebrity's images — no buildings, places, company/show logos, posters,
  // or even related people. Blocks that would otherwise show a non-person image
  // fall back to celebrity footage/image instead. Client requirement: the final
  // video shows only the celebrity, never off-person imagery.
  IMAGE_CELEBRITY_ONLY: boolish(true),
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
  ANALYZE_FACE_VERIFY_ENABLED: boolish(false),
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
  ANALYZE_BODY_VERIFY_ENABLED: boolish(true),
  // Toggle for the character-anchored query lane at analyze time. In
  // addition to script-aware queries (which target the story's specific
  // events), run a fixed set of templated queries against the project
  // celebrity: "{name} interview", "{name} talk show", "{name} red
  // carpet", etc. These return videos where the celebrity is the
  // on-screen subject (clean person footage) rather than the topic of
  // discussion — exactly the content the matcher needs to fill abstract
  // "celebrity_default" blocks. Results merge into every segment's pool
  // and compete with story-aware candidates via the existing ranker.
  ANALYZE_CHARACTER_LANE_ENABLED: boolish(true),
  MAX_VIDEOS_PER_PROJECT: z.coerce.number().int().positive().default(5),
  // Upper bound on the fraction of content blocks (image + footage) that may
  // be images. Gemini's per-sentence visual-type call lands ~50% images,
  // which over-uses the verified image pool (same photo repeats) and reads as
  // a slideshow. The transcript-driven builder caps images at this ratio and
  // converts the lowest visual_priority image blocks to footage. 0.30 = 30:70
  // image:footage; set 0.40 for 40:60. Range (0,1). Client direction
  // (2026-06): shift ~10% from stills to footage, so 0.40 → 0.30.
  //
  // 2026-08-10 (client): "you can do 50% footage and 50% ai images" — raised to
  // 0.50 alongside CELEB_IMAGE_ENABLED. The earlier 60:40 / 70:30 rules existed
  // because stills were SCRAPED (a small verified pool repeated and read as a
  // slideshow); AI stills are unique per block, which is what makes the higher
  // image share acceptable. If CELEB_IMAGE_ENABLED is off, consider putting this
  // back to 0.30 — 50% scraped stills would revive the repetition problem.
  MAX_IMAGE_RATIO: z.coerce.number().gt(0).lt(1).default(0.50),
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
  // 120s -> 240s -> 1200s. The 240s value was sized for the 720p/1080p canvas and
  // became a live failure the day the render canvas moved to 4K (2026-08-03):
  // every ffmpeg op carries 4x the pixels, and the FINAL AUDIO MUX — one pass over
  // the whole ~27-minute concat — landed right on the edge. Measured the same
  // night: 93s on one machine (passed) vs >240s on the other (killed the render
  // with "ffmpeg timed out after 240s" after 3 attempts). It is a watchdog for a
  // HUNG ffmpeg, not a performance budget, so it must sit far above the slowest
  // legitimate pass; 1200s keeps that role without failing honest 4K work.
  FFMPEG_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(1200),
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
  // Per-segment H.264 encode quality (libx264), chosen PER RENDER by
  // project.engine (see segmentVcodecArgsFor) — both engines render on the same
  // worker, so this can never be a per-worker setting. EVERY segment in one
  // render shares the chosen values so the final concat stays on the -c:v copy
  // fast path.
  //
  // SYNTHETIC_* tunes the AI-avatar path, which renders on the 3840x2160 canvas.
  SYNTHETIC_X264_PRESET: z
    .enum(["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"])
    .default("veryfast"),
  SYNTHETIC_X264_CRF: z.coerce.number().int().min(0).max(51).default(21),
  // SOURCED_* tunes the celebrity/CelebForge path, which renders on the
  // 1920x1080 canvas (client 2026-08-08 moved it back off 4K for render speed —
  // see renderCanvasFor in lib/media/ffmpeg.ts). Split out from the SYNTHETIC_*
  // knobs on the same date so celebrity encode speed can be traded against
  // quality without changing avatar output. At 1080p, veryfast/crf21 is roughly
  // 4x cheaper per frame than the same settings at 4K; drop to superfast (or
  // raise CRF a point or two) if renders still need to be faster.
  SOURCED_X264_PRESET: z
    .enum(["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"])
    .default("veryfast"),
  SOURCED_X264_CRF: z.coerce.number().int().min(0).max(51).default(21),
  // Ken Burns supersample factor for still segments (buildStillVideo). zoompan
  // samples from this upscaled canvas, so it needs enough headroom to cover the
  // 1.12x max zoom without resampling its own output grid — but no more.
  //
  // This was 4 (hard-coded) when the render canvas was 1280x720, where 4x meant
  // a 5120x2880 intermediate. At the 3840x2160 canvas that same factor builds a
  // 15360x8640 (132 MP) yuva420p frame EVERY frame, lanczos-scaled, and zoompan
  // has no slice threading so it walks that buffer single-threaded regardless of
  // FFMPEG_THREADS. Measured on an 8-core box at 4 lanes: 4x costs 61s per 8s of
  // 4K still video, 2x costs 26s (with the bg-blur + thread fixes) for SSIM 0.93
  // against the 4x output on a worst-case noisy source — no visible difference on
  // photographic stills. 2x is still ~78% more headroom than a 1.12x zoom uses.
  //
  // Kept as a knob so it can be raised back to 4 by env alone (no deploy) if the
  // client ever reports softer motion. Do NOT set it to 1 — with zero headroom
  // zoompan resamples its own output and slow zooms visibly soften (SSIM 0.84).
  SYNTHETIC_STILL_SUPERSAMPLE: z.coerce.number().int().min(1).max(4).default(2),
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
  EFFECT_OVERLAY_ENABLED: boolish(false),
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
  PERFORMANCE_MODE: boolish(false),
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
  // Optional THIRD 69labs key (a SEPARATE account). Joins the pool exactly like
  // the backup: another own concurrency slot pool + failover target. With three
  // separate-account keys the cluster runs up to SIXTYNINE_IMAGE_CONCURRENCY × 3
  // concurrent generations. Empty = ignored.
  SIXTYNINE_LABS_API_KEY_3: z.string().optional(),
  // Future-proof: any number of EXTRA keys as one comma/newline-separated list,
  // so a 4th/5th account needs NO code change — just append here. These are
  // appended to the pool after the three named keys above (duplicates dropped).
  SIXTYNINE_LABS_API_KEYS: z.string().optional(),
  SIXTYNINE_LABS_BASE_URL: z.string().url().default("https://69labs.vip"),
  // TTS voiceProvider: elevenlabs | edgetts | minimax (wire-level value).
  SIXTYNINE_LABS_TTS_PROVIDER: z.string().default("elevenlabs"),
  // modelId default depends on provider (eleven_multilingual_v2 for elevenlabs).
  SIXTYNINE_LABS_TTS_MODEL: z.string().default("eleven_multilingual_v2"),
  // gpt-image-2, NOT nano-banana — client direction 2026-08-16 ("switch our nano
  // banana to GPT image 2 … both providers"), to match the reference channel's
  // image quality. Keep this in step with AI33_IMAGE_MODEL: the two providers
  // must render the same model, or a mid-project failover changes the look of
  // the video.
  //
  // Pair it with SIXTYNINE_LABS_IMAGE_RESOLUTION="1k" — see the note there:
  // gpt-image-2 @2k currently FAILS on 69labs (accepted at submit, then dies
  // ~4 min in). 2K on this model is served by ai33 instead, which is primary.
  SIXTYNINE_LABS_IMAGE_MODEL: z.string().default("gpt-image-2"),
  // --- CelebForge (sourced engine) AI still images -------------------------
  // Client request 2026-08-10: "add ai images for the still images … you can use
  // GROK IMAGE or GPT Image model. They can generate celebrity images."
  //
  // Measured 2026-08-10 (scripts/celeb-image-spike.ts) against the 69labs model
  // list: gpt-image-2 renders NAMED public figures with true likeness at press
  // quality (Musk / Charles / Ronaldo verified by eye). grok-imagine-image was
  // reporting health "major_issues / temporarily_unavailable" and, unlike the
  // nano-banana family, exposes qualityOptions instead of a `resolutions` array —
  // so it would 400 on the `resolution` field we send. gpt-image-2 is therefore
  // the default; switch here if 69labs' Grok model recovers (and blank
  // CELEB_IMAGE_RESOLUTION when you do).
  CELEB_IMAGE_ENABLED: boolish(false),
  CELEB_IMAGE_MODEL: z.string().default("gpt-image-2"),
  // Dedicated 69labs key for CelebForge stills. When set, celebrity image
  // generation uses EXACTLY this key and never round-robins the shared pool —
  // which matters when this key is provisioned for CELEB_IMAGE_MODEL and the
  // avatar engine's keys are not, since the pool would otherwise send half the
  // celebrity stills out on a key that cannot serve the model.
  //
  // This does NOT add concurrency. If the key was issued from an account that
  // already has a key in the pool, set SIXTYNINE_ACCOUNT_ID so both share one
  // slot semaphore — otherwise the cluster over-subscribes the account.
  // Unset = round-robin the shared pool (previous behaviour).
  CELEB_IMAGE_API_KEY: z.string().optional(),
  // "" omits the resolution field (required for models with no resolutions[]).
  CELEB_IMAGE_RESOLUTION: z.string().default("2k"),
  // What SHARE of the planner's image blocks are AI-generated. 1.0 (default) =
  // every image block; the rest keep their scraped photo.
  //
  // This replaced a fixed per-project COUNT as the primary knob (client
  // 2026-08-12: the AI share must be a proportion, not a fixed number). A count
  // cannot express a share — at CELEB_IMAGE_MAX_PER_PROJECT=10 a 131-image
  // project shipped 10 AI stills and 121 scraped ones (observed 2026-08-11),
  // and the same number means something entirely different on a 10-minute video
  // than on a 40-minute one.
  //
  // NOTE the division of labour: the 50:50 footage:image split is decided at
  // PLAN time by MAX_IMAGE_RATIO (lib/ai/transcript-driven-builder.ts). This
  // fraction then says how many of those image blocks are AI rather than
  // scraped. Leaving it at 1.0 with MAX_IMAGE_RATIO=0.50 is what makes "50% of
  // the assets are AI-generated" true.
  CELEB_IMAGE_FRACTION: z.coerce.number().gt(0).max(1).default(1.0),
  // Absolute SPEND backstop on AI stills per project, applied after
  // CELEB_IMAGE_FRACTION. 0 (default) = unlimited — the fraction alone decides
  // coverage. Set a positive number only to bound cost on unusually long
  // videos; because it clips coverage it is logged (eligible vs target in
  // match.celeb_image_generate) rather than silently truncating.
  CELEB_IMAGE_MAX_PER_PROJECT: z.coerce.number().int().nonnegative().default(0),
  // How many AI stills generate CONCURRENTLY inside the match job. The old
  // sequential loop serialised every generation (~27s each), which is why a
  // 131-image project would have taken ~1 hour inline while the avatar engine
  // generates far more images far faster — avatar enqueues one BullMQ job per
  // image and drains them in parallel, so the difference was dispatch, not the
  // provider.
  //
  // CEILING: these lanes contend for the SAME cluster-wide per-ACCOUNT slots
  // (SIXTYNINE_ACCOUNT_CONCURRENCY) as the avatar worker on the other machine.
  // Lanes are DEMAND, not capacity: raising this past the number of free slots
  // buys no throughput, it only converts generation time into queue time. Adding
  // a key from an account that already has one does not help either — the 69labs
  // limit is per ACCOUNT (see SIXTYNINE_ACCOUNT_ID). Only a genuinely separate
  // account raises the ceiling.
  //
  // Safe to run at 4 as of 2026-08-12: the Redis semaphore now enforces the
  // account cap correctly, so excess lanes WAIT rather than earning a 403, and a
  // lane's generation deadline no longer starts until its slot is held (which is
  // what previously turned queueing into a cascade of fake 90s timeouts).
  CELEB_IMAGE_CONCURRENCY: z.coerce.number().int().positive().default(4),
  // Per-image wall clock before we give up and keep the scraped photo. A HEALTHY
  // gpt-image-2 returns in ~30-75s; a DEGRADED one sits until the provider's own
  // ~240s timeout (measured 2026-08-11, when 69labs reported the model's health
  // as "unknown" and 12 straight jobs died at ~240s with "This job failed to
  // complete"). Generation runs inline in the match job, so without this cap a
  // 40-image project on a bad day adds ~2.6 HOURS of stalling to matching.
  //
  // Measured from when the 69labs ACCOUNT SLOT IS HELD, not from the call — slot
  // wait is bounded by CELEB_IMAGE_SLOT_WAIT_MS instead. Raised 90s -> 180s
  // (2026-08-12): 90s left almost no margin over a healthy generation's ~75s
  // once the submit retry and the download (allowed 120s on its own) are inside
  // the same budget, so healthy-but-slow stills were being thrown away.
  CELEB_IMAGE_TIMEOUT_MS: z.coerce.number().int().positive().default(180_000),
  // How long an AI still may WAIT for a free 69labs account slot before giving
  // up and keeping the scraped photo. Separate from CELEB_IMAGE_TIMEOUT_MS so a
  // busy account shows up as queueing rather than as a fake generation timeout.
  // Below withAccountSlot's own 5-min default because this runs inline in the
  // match job, where a long queue is worse than a scraped photo.
  CELEB_IMAGE_SLOT_WAIT_MS: z.coerce.number().int().positive().default(120_000),
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
  //
  // "1k", NOT "2k" — 2026-08-15. 69labs REJECTS above-1k resolutions ON THE
  // NANO-BANANA FAMILY with a generic `503 {"code":"SERVICE_UNAVAILABLE"}` at
  // submit, so a "2k" default made EVERY avatar image generation fail and
  // silently fall through the Gemini/fal.ai fallback chain in generateImage().
  // Measured that day, same request with only `resolution` varied:
  //     2k -> 503 (x3)   4k -> 503   1k -> 201   omitted -> 201
  // Confirmed on nano-banana-2, nano-banana-pro AND nano-banana-2-lite.
  // NOT a blanket high-res outage: gpt-image-2 at 2k returns 201, which is why
  // CelebForge (CELEB_IMAGE_RESOLUTION="2k" on gpt-image-2) is UNAFFECTED —
  // do not "fix" that one to match this.
  // Key was valid, model health "healthy/available", credits 0/2000 used — so
  // the 503 is 69labs signalling "this resolution is not available for this
  // model", NOT the transient outage its message claims.
  // "4k" DID work on 2026-08-03 (probed: 5504×3072), so this is a change on
  // their side. Re-test with scripts/diagnose-69labs-image.ts before raising
  // this again; while it 503s, a higher value costs 100% of generations.
  //
  // The old comment justified "2k" as free quality "since 69labs bills per
  // IMAGE, not per pixel". That is WRONG — /api/v1/images/models reports
  // resolutionCosts {1k:1, 2k:3, 4k:4}, so 2k burned 3x the credits (~666
  // images/day against the 2000/day budget, vs 2000 at 1k).
  // Cost of 1k: the 3840x2160 canvas upscales these ~4x and they read soft.
  // That is the known trade — but a soft nano-banana still beats the off-model
  // fal.ai FLUX image the 503 was actually producing.
  //
  // STILL "1k" after the 2026-08-16 move to gpt-image-2, for a DIFFERENT reason:
  // gpt-image-2 @2k is accepted at submit on 69labs (201) but then FAILS ~4 min
  // into generation ("This job failed to complete", measured twice that day);
  // @1k COMPLETED. So this stays 1k on 69labs, and 2K comes from ai33
  // (AI33_IMAGE_RESOLUTION), which is the primary provider. Note this makes the
  // 69labs fallback the SOFTER of the two — acceptable, since it only runs when
  // ai33 is down.
  SIXTYNINE_LABS_IMAGE_RESOLUTION: z.string().default("1k"),
  SIXTYNINE_LABS_DEFAULT_VOICE: z.string().default("narrator"),
  // Max seconds to poll a TTS job to COMPLETED before giving up. Raised from 600
  // to 1800 on 2026-08-16: a 30,599-char voiceover consistently ran past the
  // 10-minute ceiling, and every timeout used to strand a still-rendering job on
  // 69labs that then 409'd (DUPLICATE_TTS_IN_PROGRESS) every retry. The resume
  // pointer now recovers from that, but a full-length narration should not be
  // hitting the timeout at all — 30 min covers the longest scripts we render.
  SIXTYNINE_LABS_TTS_POLL_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(1800),
  // Max seconds to poll an image job to COMPLETED before giving up.
  SIXTYNINE_LABS_IMAGE_POLL_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(300),
  // =======================================================================
  // ai33.pro (OpenSpeaker) — PRIMARY image + voiceover provider.
  //
  // Added 2026-08-16 on client direction: ai33.pro is primary, 69labs is the
  // backup. Both now run gpt-image-2 (see AI33_IMAGE_MODEL /
  // SIXTYNINE_LABS_IMAGE_MODEL) so a failover cannot change the look of a video
  // mid-project — the failure mode that made the old Gemini/fal.ai chain a
  // liability.
  //
  // WHY the switch: on 2026-08-16 69labs was degraded across the board —
  // nano-banana-2 @2k returned 503 SERVICE_UNAVAILABLE at submit (i.e. EVERY
  // production image failed, which is why uploads stopped), and gpt-image-2 @2k
  // accepted the submit then died ~4 min in with "This job failed to complete".
  // ai33 served the same prompts at 2K in ~90s.
  //
  // Wire contract (verified live 2026-08-16 — their docs page 403s to scrapers,
  // so this is the ground truth):
  //   auth   : `xi-api-key: <key>` header (NOT `Authorization: Bearer`)
  //   images : POST /v1i/task/generate-image (multipart) -> { task_id }
  //   tts    : POST /v3/text-to-speech      (multipart) -> { task_id }
  //   poll   : GET  /v1/task/:task_id       -> status doing|done|error
  //   result : images -> metadata.result_images[0].imageUrl
  //            tts    -> metadata.audio_url
  // Failed tasks are refunded automatically by the provider.
  AI33_API_KEY: z.string().optional(),
  // Master switch. Off (or unkeyed) = the engine runs 69labs-only, exactly as
  // before this provider existed. On with a key = ai33 participates in the
  // provider chain; WHICH END it sits at is set by SYNTHETIC_*_PROVIDER_PRIMARY
  // below (it is no longer implicitly first — see that note).
  AI33_ENABLED: boolish(true),
  // Per-lane override, IMAGES ONLY. Off = ai33 is dropped from the image chain
  // while its VOICEOVER role is untouched (client direction 2026-08-24: drop
  // ai33 from stills, keep it behind 69labs for TTS).
  //
  // This exists because AI33_ENABLED is a MASTER switch across both lanes, so
  // using it here would have silently taken the TTS fallback down too and left
  // voiceover single-provider — an outage on 69labs would then fail the stage
  // outright rather than ride it out.
  //
  // AI33_ENABLED still wins: off there means off everywhere, and this flag can
  // only subtract. It cannot put ai33 back into a lane the master switch closed.
  AI33_IMAGE_ENABLED: boolish(true),

  // WHICH PROVIDER LEADS the image / TTS chain. The other one becomes the
  // fallback; both still participate, so an outage on either is ridden out.
  //
  // Client direction 2026-08-17: 69labs PRIMARY, ai33 FALLBACK — a reversal of
  // the 2026-08-16 direction recorded above (which made ai33 primary after a
  // 69labs outage). The order has now changed twice in two days, so it is a
  // SETTING rather than the hardcoded array it used to be: flipping it back is
  // an env change, not a deploy.
  //
  // NOTE the operational trade when 69labs leads: its per-account generation
  // ceiling (SIXTYNINE_ACCOUNT_CONCURRENCY, the 7-slot "Concurrent image
  // generation limit reached" 403) is the binding constraint again, and the
  // Redis slot limiter / key-pool failover / zombie-resume machinery is back on
  // the hot path. ai33 has no such ceiling. If image throughput falls off a
  // cliff under load, this setting is the first thing to check.
  SYNTHETIC_IMAGE_PROVIDER_PRIMARY: z.enum(["sixtynine", "ai33"]).default("sixtynine"),
  SYNTHETIC_TTS_PROVIDER_PRIMARY: z.enum(["sixtynine", "ai33"]).default("sixtynine"),

  // ── OpenAI direct: LAST-RESORT image fallback (client direction 2026-08-24) ──
  //
  // Deliberately NOT part of SYNTHETIC_IMAGE_PROVIDER_PRIMARY. That setting is
  // an ORDERING over the two resellers and is read by the TTS lane too; OpenAI
  // serves images only, and promoting it would imply a voiceover lane that does
  // not exist. It is instead appended to the END of the image chain, so it runs
  // only when BOTH resellers have failed.
  //
  // Off by default — NOT on price grounds. At quality=low this path measured
  // CHEAPER per still than the reseller entries in cost.ts. It is off because it
  // bills a SEPARATE account the client funds directly, so switching it on moves
  // spend off the reseller accounts, and that should be a deliberate act rather
  // than something that happens silently the first time a provider wobbles.
  // Env-level so it flips without a deploy when an outage does hit.
  SYNTHETIC_IMAGE_OPENAI_FALLBACK: boolish(false),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().url().default("https://api.openai.com"),
  // MUST stay the same model family the resellers run (see AI33_IMAGE_MODEL).
  // gpt-image-2 is on the official API — verified 2026-08-24 against
  // GET /v1/models. Pointing this at a different family re-creates the
  // 2026-08-15 Gemini/fal bug, where a failover silently changed the house look.
  OPENAI_IMAGE_MODEL: z.string().default("gpt-image-2"),
  // low|medium|high|auto. LOW per client direction 2026-08-24 ("its very
  // important to use the lowest quality, otherwise its very expensive"). This
  // path pays RETAIL — there is no reseller margin absorbing the difference —
  // so it is the one place the setting matters most. Omitting the field
  // entirely would bill at the model default, which is NOT the cheap end.
  OPENAI_IMAGE_QUALITY: z.string().default("low"),
  // OpenAI takes explicit pixel sizes, not the resolution/aspect_ratio pair the
  // resellers use — hence a separate setting rather than a shared one. 1536x1024
  // is the 3:2 landscape option, the closest the API offers to the 16:9 the
  // engine composites onto its 3840x2160 canvas (lib/media/ffmpeg.ts).
  OPENAI_IMAGE_SIZE: z.string().default("1536x1024"),
  // Conservative: this is a fallback carrying an outage's whole load, and the
  // account is new, so a low ceiling keeps a burst from tripping a tier limit.
  OPENAI_IMAGE_CONCURRENCY: z.coerce.number().int().positive().default(4),
  // MEASURED 2026-08-24: gpt-image-2 at 1024x1024/low returned in ~20s, and
  // gpt-image-1 at 1024x1536/low in ~18s. 180s leaves generous headroom while
  // still bounding a stall — this call is synchronous, so a hang holds the slot.
  OPENAI_IMAGE_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(180),

  AI33_BASE_URL: z.string().url().default("https://api.ai33.pro"),
  // Client direction 2026-08-16: gpt-image-2 on BOTH providers, matching the
  // reference channel's look. Model ids come from GET /v1i/models.
  AI33_IMAGE_MODEL: z.string().default("gpt-image-2"),
  // ai33 resolutions are UPPERCASE ("1K"|"2K"|"4K") — the lowercase form 69labs
  // wants is rejected here, which is why the two providers keep SEPARATE
  // resolution settings rather than sharing the caller's value.
  // "1K" per client direction 2026-08-16. MEASURED trade (gpt-image-2, 16:9,
  // quality=high) — the saving is smaller and the quality cost larger than the
  // "half price, half time" estimate that prompted the switch:
  //
  //            pixels       credits   generation
  //     1K     1280x720      1,902      ~113s
  //     2K     2048x1152     2,574      ~130s
  //
  // i.e. 1K saves 26% of credits and ~13% of wall-clock, and costs 2.6x the
  // pixels. It matters because the SYNTHETIC engine renders on a 3840x2160
  // canvas (lib/media/ffmpeg.ts): a 1K still is upscaled 3x into the frame,
  // where 2K is upscaled 1.9x. Set "2K" here or in fly.avatar.toml [env] to
  // reverse — no code change needed.
  AI33_IMAGE_RESOLUTION: z.string().default("1K"),
  // gpt-image-2 exposes qualities low|medium|high (default medium). "" omits the
  // field for models that don't expose it.
  AI33_IMAGE_QUALITY: z.string().default("high"),
  AI33_IMAGE_ASPECT_RATIO: z.string().default("16:9"),
  // gpt-image-2 caps the prompt at 10,000 chars (GET /v1i/models
  // max_prompt_length). Longer prompts are truncated with a warning rather than
  // 400-ing the generation.
  AI33_MAX_PROMPT_CHARS: z.coerce.number().int().positive().default(10_000),
  // 600s. A gpt-image-2 still returns in ~90-115s when ai33 is unloaded, but
  // under real concurrency the tail stretches: at 16 in flight the slowest took
  // 363s and one exceeded a 300s budget (measured 2026-08-16). A 300s ceiling
  // therefore ABANDONED healthy-but-slow generations and failed them over to
  // 69labs — observed in production as "ai33 image: poll timed out". 600s covers
  // the loaded tail while still bounding a genuinely dead task.
  AI33_IMAGE_POLL_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(600),
  // Matches SIXTYNINE_LABS_TTS_POLL_TIMEOUT_SECONDS — a 30k-char narration is a
  // long render on any provider.
  AI33_TTS_POLL_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(1800),
  // ai33 voice ids carry a provider prefix (elevenlabs_ | minimax_ | clone_ |
  // edge_ | kokoro_ | vbee_ | fishaudio_). Our project rows store BARE
  // ElevenLabs ids (the form 69labs takes), so an unprefixed id is prefixed with
  // this before submitting — which is what lets the same voice id serve both
  // providers with no per-project migration.
  AI33_TTS_VOICE_PROVIDER: z.string().default("elevenlabs"),
  // Voice used when a project has none. Empty = fall back to
  // SIXTYNINE_LABS_DEFAULT_VOICE (normalised with the prefix above).
  AI33_DEFAULT_VOICE: z.string().default(""),
  // Per-language default voices, used when a non-English project does not name
  // its own tts_voice_id. Without these a German or Spanish project would
  // silently fall back to the English default voice and narrate foreign text in
  // an English-accented voice — the one failure mode of this feature that is
  // obvious to the client but invisible in the logs.
  //
  // Same id format as AI33_DEFAULT_VOICE / tts_voice_id (a bare ElevenLabs id
  // is prefixed with AI33_TTS_VOICE_PROVIDER before submit), so one value
  // serves both the ai33 primary and the 69labs backup. Empty = no default for
  // that language; such a project must then set its voice at intake.
  TTS_DEFAULT_VOICE_DE: z.string().default(""),
  TTS_DEFAULT_VOICE_ES: z.string().default(""),
  // Cluster-wide concurrent ai33 generations (Redis-coordinated, same mechanism
  // as the 69labs account cap). ai33 rate-limits per USER — every key on the
  // account shares one quota — so this is a single global ceiling.
  //
  // 8, MEASURED (2026-08-16), not guessed. Firing N gpt-image-2 generations at
  // once and timing each:
  //     8  -> 8/8 completed, slowest 110s (same as ONE image alone: 113s)
  //     16 -> 15/16 completed, slowest 363s, one exceeded the 300s poll budget
  // So 8 is free parallelism and 16 is past their capacity. The first value
  // shipped was 4, which was a placeholder — with IMAGE_GEN_CONCURRENCY=5 plus
  // the image_to_video and avatar lanes all drawing on the same pool, demand sat
  // well above 4, so images queued past AI33_SLOT_WAIT_MS and failed OVER to a
  // degraded 69labs instead of simply waiting. Raising this is what keeps work
  // on the healthy provider.
  AI33_CONCURRENCY: z.coerce.number().int().positive().default(8),
  // How long a generation may WAIT for a free ai33 slot before giving up (and,
  // for images, falling over to 69labs).
  //
  // 5 min, up from 2. A queue is NOT a provider failure: falling over because
  // our own cap is full sends the image to the slower, 429-storming provider for
  // no reason. Waiting is nearly always the better trade while ai33 is the
  // healthy one. Observed in production 2026-08-16 as a flood of
  // "slot acquire timed out for account ai33" failovers.
  AI33_SLOT_WAIT_MS: z.coerce.number().int().positive().default(300_000),
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
  // Optional EXTRA LTX accounts for a key POOL (mirrors the 69labs pool). Each
  // distinct key is a separate LTX account, and clip generations round-robin
  // across the pool with per-run failover — so N accounts render clips IN
  // PARALLEL and one account draining credits / rate-limiting hops to the next.
  // Empty = single-key behaviour (identical to before). Named 2nd/3rd keys plus
  // an optional comma/newline list for a 4th+ (no code change to extend).
  LTX_API_KEY_2: z.string().optional(),
  LTX_API_KEY_3: z.string().optional(),
  LTX_API_KEYS: z.string().optional(),
  LTX_BASE_URL: z.string().url().default("https://api.ltx.video"),
  LTX_MODEL: z.string().default("ltx-2-3-fast"),
  // DELIBERATELY 1080p even though the render canvas is 4K. Client 2026-08-03:
  // "the clips and images generated doesn't matter if the footage is 4k, the
  // export just has to be 4k" — YouTube keys off the EXPORT resolution, so the
  // renderer upscaling a 1080p clip into the 3840x2160 frame satisfies the ask.
  // Generating clips at 4K costs ~4x per second and ~6x storage (measured
  // 2026-08-03: 6s clip = 5.9MB at 1080p vs 36MB at 4K) and buys nothing he asked
  // for. Probed and CONFIRMED WORKING at "3840x2160" if real 4K clips are ever
  // wanted — flip this one value, and scale PRICE_TABLE.ltx2 in cost.ts with it.
  //
  // 1080p -> 720p (client 2026-08-21): "Can you change it to 720p / I think it
  // will make the footage look older / Thats what we are aiming for". This is an
  // AESTHETIC ask, not a cost one — it is the same goal the 2026-06 low-fi
  // degrade block below was built for (SYNTHETIC_DEGRADE_*), which the client
  // then disabled on 2026-06-29. Softness now comes from the renderer upscaling
  // 720p into the 4K export canvas (a 3x upscale) instead of from grain/blur at
  // full dimensions.
  // It is ALSO much cheaper on the self-hosted GPU, which is a side effect and
  // not the reason: measured 2026-08-21 on an RTX PRO 6000, one 6s clip took
  // 118.2s at 1080p vs 50.1s at 720p (services/ltx-selfhost/README.md).
  // Revert to "1920x1080" if the client decides the 4K export looks too soft.
  LTX_RESOLUTION: z.string().default("1280x720"),
  // LTX-2 source frame rate. Allowed values are 25 or 50 (NOT 24 — the API
  // rejects fps 24 for ltx-2-fast at 1080p). The render pipeline re-encodes
  // every clip to SYNTHETIC_FPS (30) downstream, so this only has to be a value
  // LTX accepts; 25 is the documented default for the 1080p duration tiers.
  LTX_FPS: z.coerce.number().int().positive().default(25),
  LTX_MAX_DURATION: z.coerce.number().int().positive().default(20),
  // Comma-separated clip durations to snap to, REPLACING the api.ltx.video tier
  // list (6,8,10,...). Only set this when LTX_BASE_URL points at the self-hosted
  // service, which derives frames from the duration instead of selling fixed
  // tiers — the hosted API rejects anything off its own list.
  // Client 2026-08-21 asked for 4s clips; on the API a 4s request silently
  // becomes 6s (and bills 6s), so "4,6,8,10,12,14,16,18,20" is the self-hosted
  // setting that actually delivers it. Empty = the API's tiers.
  LTX_DURATION_TIERS_OVERRIDE: z.string().optional(),
  // Negative prompt for clip generation. Three states:
  //   unset/""  -> send NO negative_prompt field (api.ltx.video-safe, unchanged
  //                request shape; this is the default so rollback stays clean)
  //   "default" -> send CLIP_NEGATIVE_PROMPT from lib/synthetic/constants.ts
  //   any text  -> send that literal string
  // Set to "default" together with LTX_BASE_URL when cutting over to the
  // self-hosted service: the tuned list fixes the between-frame hand artifacts
  // the client reported on 2026-08-22, and stops the library default from
  // suppressing the grain the house style explicitly asks for.
  LTX_NEGATIVE_PROMPT: z.string().optional(),
  // Hard timeout (seconds) for a single LTX image-to-video job (poll loop).
  LTX_POLL_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(600),
  // fal.ai — image-to-video FALLBACK (Veo 3 Fast, then Kling). Tried only
  // when LTX-2 fails or is unconfigured. See generateClipWithFallback.
  FAL_AI_API_KEY: z.string().optional(),
  FAL_AI_BASE_URL: z.string().url().default("https://queue.fal.run"),
  FAL_AI_VEO_MODEL: z.string().default("fal-ai/veo3/fast/image-to-video"),
  FAL_AI_KLING_MODEL: z.string().default("fal-ai/kling-video/v1/standard/image-to-video"),
  // fal.ai TEXT-TO-IMAGE model — the FALLBACK still provider used only when
  // 69labs (nano-banana) fails past its retry budget or all accounts are down/
  // blocked. FLUX schnell is fast + cheap for a fallback still; swap the model id
  // to trade quality for cost. Uses the same FAL_AI_API_KEY as the video lane.
  FAL_AI_IMAGE_MODEL: z.string().default("fal-ai/flux/schnell"),
  // Hard timeout (seconds) for a single fal.ai image-to-video job (poll loop).
  FAL_AI_POLL_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(600),
  // Gemini TEXT-TO-IMAGE — the still-image FALLBACK used when the 69labs
  // (nano-banana) pool is exhausted, in place of fal.ai FLUX. 69labs resells
  // Google's nano-banana model, so calling Gemini's own image model directly
  // yields the SAME look as 69labs (unlike FLUX, which reads differently) while
  // sidestepping 69labs' per-account credit/slot limits. Reuses GEMINI_API_KEY.
  // Enabled only when GEMINI_IMAGE_ENABLED is on AND GEMINI_API_KEY is set; when
  // off, the fallback stays fal.ai. Preferred over fal when both are configured.
  GEMINI_IMAGE_ENABLED: boolish(true),
  // Image model id. Default is the established "nano-banana" (gemini-2.5-flash-
  // image). Bump to a newer image model (e.g. gemini-3-pro-image) via env once
  // confirmed live on the key — no code change needed. The "-latest"-style
  // aliases used for text models do not exist for image models, so this is pinned.
  GEMINI_IMAGE_MODEL: z.string().default("gemini-2.5-flash-image"),
  // The Gemini IMAGE API is geo-restricted (UK/EU return 400 "User location is
  // not supported"), and the workers run in lhr (London). So the image call must
  // egress through a proxy whose exit IP is in a SUPPORTED region (e.g. US).
  // Format is a single `ip:port:user:pass` entry (Webshare-style), same as the
  // other proxy pools. When unset, the code falls back to the FIRST entry of
  // YTDLP_PROXIES — BUT only reuse that if those IPs are US/supported-region;
  // a UK residential proxy will NOT lift the block. Empty + no pool = direct
  // egress (works only from a supported region, e.g. local dev in the US).
  GEMINI_IMAGE_PROXY: z.string().optional(),
  // HARD monthly cap on Gemini-fallback image generations (client cost guard,
  // 2026-07-22: a Gemini billing spike while the 69labs pool was out of credits
  // — the client asked for a ~300-image ceiling with a warning). Counted in
  // Redis per calendar month across the whole cluster; only SUCCESSFUL
  // generations consume budget. At the cap the Gemini fallback refuses (the
  // caller then tries fal.ai / surfaces the 69labs error), and a loud
  // "gemini.image.budget" log fires from 80% onward. 0 disables the Gemini
  // fallback outright; raise the value (and redeploy) to lift the cap.
  GEMINI_IMAGE_MONTHLY_CAP: z.coerce.number().int().nonnegative().default(300),
  // THE NARRATOR APPEARS IN THE STORY (client 2026-08-26). A few b-roll shots
  // per video are generated with the project's uploaded avatar photo as an
  // IDENTITY REFERENCE, so the presenter's own face turns up as a character in
  // the story instead of an anonymous stranger. See character-blocks.ts.
  //
  // These generations route through Gemini because it is the only configured
  // model that accepts a reference image at all — the active chain (ai33 /
  // 69labs, both gpt-image-2) is text-to-image only. They are metered by
  // SYNTHETIC_CHARACTER_BLOCKS_MONTHLY_CAP below, NOT by the fallback's
  // GEMINI_IMAGE_MONTHLY_CAP above; see that entry for why the two are split.
  // MATCH VERIFICATION (client 2026-08-27: "all project should be matched with
  // script correctly"). Before this, nothing in the pipeline ever checked that
  // a block's picture belonged to its line — the planner's rules made a wrong
  // prompt less likely and a bench could measure how much less likely, but a
  // wrong prompt was still generated, animated and rendered at full cost.
  //
  // With this on, every visual block is judged against its own narration before
  // anything is generated, and MISMATCH blocks are rewritten (keeping the
  // rewrite only when it judges better). Costs one text call per ~10 blocks
  // plus a rewrite per failure — cheap against the image and video generations
  // it prevents being spent on the wrong shot.
  SYNTHETIC_MATCH_VERIFY_ENABLED: boolish(true),
  // Ceiling on rewrites per plan, so a bad-day plan cannot turn into hundreds
  // of extra model calls. Failures are repaired worst-first, so the cap spends
  // itself on the blocks that read as most broken.
  SYNTHETIC_MATCH_VERIFY_MAX_REPAIRS: z.coerce.number().int().nonnegative().default(60),
  // Also rewrite WEAK blocks ("right world, wrong detail"), not just outright
  // MISMATCH. Off by default: for an abstract line a weak shot is often the
  // best available answer, and re-rolling it risks trading a sensible picture
  // for a wrong one. Turn on when a video's weak share is the complaint.
  SYNTHETIC_MATCH_VERIFY_STRICT: boolish(false),
  SYNTHETIC_CHARACTER_BLOCKS_ENABLED: boolish(true),
  // Deliberately SMALL — the client asked for "the small count", and a large
  // number would rebuild the every-frame-same-person repetition that
  // sanitizeBasePrompt exists to prevent. This is a ceiling, not a target: a
  // video whose narration is never in the presenter's own voice gets none.
  SYNTHETIC_CHARACTER_BLOCKS_MAX: z.coerce.number().int().nonnegative().default(4),
  // Monthly ceiling for character-block generations, counted in its OWN Redis
  // bucket — deliberately NOT shared with GEMINI_IMAGE_MONTHLY_CAP above. That
  // cap guards against an outage turning into an unbounded Gemini bill; this
  // one is a planned per-video feature cost. They were briefly shared, and the
  // first end-to-end run (2026-08-26) found the fallback bucket already at its
  // 300 ceiling, which would have silently disabled the feature for the rest of
  // the month. At MAX 4 per video, 400 covers ~100 videos.
  SYNTHETIC_CHARACTER_BLOCKS_MONTHLY_CAP: z.coerce.number().int().nonnegative().default(400),
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
  HEYGEN_USE_YTDLP_PROXIES: boolish(false),
  // Run the browser headful (false) for local debugging of HeyGen automation.
  HEYGEN_HEADLESS: boolish(true),
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
  // How long (seconds) an account is LEASED to one avatar job for parallel
  // generation (migration 0026). While leased, no other concurrent job can claim
  // it (public.claim_heygen_account, FOR UPDATE SKIP LOCKED), and the keep-alive
  // sweep skips it. Must comfortably EXCEED one attempt's worst case
  // (HEYGEN_RENDER_TIMEOUT_MS = 600s plus composer setup/upload/retrieval), so a
  // normal render never outlives its lease; generateAvatar also renews the lease
  // before each attempt. If a worker crashes the lease auto-expires after this
  // window and the account becomes claimable again — so keep it long enough to
  // avoid a live render's account being stolen, but not so long that a crash
  // strands the account for ages. Default 900s (15 min).
  HEYGEN_ACCOUNT_LEASE_SECONDS: z.coerce.number().int().positive().default(900),
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
  HEYGEN_DEBUG: boolish(false),
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
  HEYGEN_CONNECT_USES_PROXY: boolish(false),
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
  HEYGEN_USE_STEALTH: boolish(false),
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
  //   'all'       (default) — every engine, single-worker setup (unchanged).
  //   'sourced'   — only the celebrity queues (search/download/clip/match/render/scriptClip).
  //   'synthetic' — only the AI-avatar queues (tts/planner/image/video/avatar).
  //   'ebook'     — only the ebook-generator queues (the 18 stages of the
  //                 channel→book pipeline). Mostly LLM-bound and cheap on CPU,
  //                 so it can share a machine — but `whisper-transcribe` and
  //                 `export` (Puppeteer) are memory-hungry, which is why it can
  //                 also be pinned to its own app.
  // The synthetic worker can be a separate Fly app with auto_stop (scales to
  // zero when idle) since avatar generation is bursty, not 24/7.
  WORKER_ROLE: z.enum(["all", "sourced", "synthetic", "ebook"]).default("all"),

  // Scales EVERY ebook queue's concurrency (packages/ebook-infra/queue/queues.ts).
  // The upstream table was tuned for dedicated pods and sums to ~135 concurrent
  // jobs; the whole video pipeline runs at ~13, so an unscaled ebook worker
  // sharing a machine would starve it. 0.25 → ~34, a reasonable co-tenant.
  // Set to 1 on a dedicated ebook machine (WORKER_ROLE=ebook) for full throughput.
  // Read directly from process.env in queues.ts (that package has its own env
  // schema); declared here so it is documented alongside the other knobs.
  EBOOK_CONCURRENCY_SCALE: z.coerce.number().positive().default(0.25),

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
  //
  // NOTE (2026-07-09): this is now a FALLBACK cap only. The real limiter is the
  // Redis-backed GLOBAL per-account semaphore (SIXTYNINE_ACCOUNT_CONCURRENCY),
  // which coordinates across BOTH worker machines. The old per-process semaphore
  // multiplied by machine count and overshot 69labs' 7-per-account ceiling.
  SIXTYNINE_IMAGE_CONCURRENCY: z.coerce.number().int().positive().default(4),

  // GLOBAL (cluster-wide, Redis-coordinated) concurrent-generation cap PER 69labs
  // ACCOUNT. 69labs' real per-account ceiling is 7; we stay one under it so a
  // stray status/other call never tips an account over. This is the true throttle
  // that lets MULTIPLE videos generate at once and SHARE the fixed slots (this ×
  // number of accounts) without the "Concurrent image generation limit reached
  // (7)" 403 — enforced across all machines/lanes, not per-process. Add more
  // 69labs accounts (SIXTYNINE_LABS_API_KEY_*) to raise total throughput.
  SIXTYNINE_ACCOUNT_CONCURRENCY: z.coerce.number().int().positive().default(6),

  // DECLARED account identity for the cap above. Set this to any stable label
  // (e.g. "main") when EVERY configured 69labs key belongs to ONE account: all
  // keys then share a single semaphore, so the cap is enforced once for the
  // account instead of once per key.
  //
  // Set it whenever you issue a second key from an existing account rather than
  // opening a new one. Without it, key identity is inferred from the key's first
  // 10 characters — which reads two keys of ONE account as two accounts and
  // hands out cap × 2 slots against a single 7-slot ceiling (observed 2026-08-12
  // with a dedicated CelebForge key issued from the avatar account: 12 slots for
  // 7, i.e. guaranteed 403 "Concurrent image generation limit reached (7)").
  //
  // Leave UNSET when the keys are genuinely separate accounts — setting it then
  // collapses them into one pool and throws away the extra account's capacity.
  SIXTYNINE_ACCOUNT_ID: z.string().optional(),

  // GLOBAL (cluster-wide) 69labs STATUS-poll rate budget, in requests/second and
  // burst size. The status endpoint is rate-limited SEPARATELY from generation
  // and returns 429 "TOO_MANY_REQUESTS" when too many polls arrive — which, with
  // ~74 in-flight jobs each polling on its own timer, is what tripped the 429
  // storm. This token bucket caps the CLUSTER's combined poll rate regardless of
  // how many jobs are in flight. ~8/s with a burst of 12 keeps a large batch's
  // polls under budget while still checking each job every few seconds.
  SIXTYNINE_POLL_RATE_PER_SEC: z.coerce.number().positive().default(8),
  SIXTYNINE_POLL_BURST: z.coerce.number().int().positive().default(12),

  // Synthetic visual-block pacing. The client's reference video paces every
  // visual block (image / ai_clip / split_2) at ~3-8s. Gemini's planner emits
  // blocks of arbitrary length (a long sentence can yield a 13-21s block),
  // which (a) reads as a static hold against the reference and (b) exceeds
  // what LTX-2 can generate in a single image-to-video call. The planner's
  // duration-split pass divides any visual block longer than
  // SYNTHETIC_BLOCK_SPLIT_THRESHOLD into round(duration / TARGET) back-to-back
  // even sub-blocks (each keeping the parent's FULL script and prompts, with an
  // even slice of the spoken-time window), so every block lands in the 3-8s window
  // and inside LTX's single-generation tier. 'avatar' blocks are exempt — a
  // talking head holds for the full sentence and is generated by HeyGen, not
  // LTX.
  // ALIGN-FIRST planner (2026-07-31). When on, the synthetic planner times the
  // transcript's own sentences against the word stream FIRST and then asks
  // Gemini only to GROUP those sentences by index — instead of asking Gemini to
  // segment the transcript and afterwards searching the audio for Gemini's
  // (paraphrased) block text. The old order made block timing a text search that
  // could fail, and its failure mode was silent: on a 32-minute voiceover
  // alignment died at sentence 53/127 and the plan finished ~725s behind the
  // audio, which surfaced only as a "Timeline duration must match voiceover"
  // render rejection and 12 minutes of visuals derived from one sentence.
  //
  // Default ON — the legacy path is the bug. Set SYNTHETIC_PLAN_ALIGN_FIRST=0
  // to fall back to it. (This flag used to spell its own off-switch parse out
  // inline, because the file's z.coerce.boolean() convention could not express
  // one; boolish() is that same parse, now used by every flag here.)
  SYNTHETIC_PLAN_ALIGN_FIRST: boolish(true),
  // Minimum share of transcript sentences that must anchor to real word
  // timings for an align-first plan to be trusted. Below this the plan is
  // rejected instead of silently shipping interpolated timings — the missing
  // alarm that let the 2026-07-31 failure reach the review screen.
  //
  // Calibration: a healthy plan anchors ~0.68 of sentences (measured on the
  // 32-min Jubilees voiceover; the un-anchored third is mostly number wording
  // — "nineteen eighty-seven" vs "1987" — and interpolates to within 1.1s at
  // p90 because it is pinned between real anchors on both sides). A genuine
  // transcript/audio mismatch collapses this toward 0, so 0.4 leaves healthy
  // plans plenty of headroom while still catching the catastrophic case.
  SYNTHETIC_PLAN_MIN_ANCHOR_FRACTION: z.coerce.number().min(0).max(1).default(0.4),
  // Skip the manual review gate (client request 2026-08-10: after step 1 the
  // AI Avatar flow should go straight to "generate assets"). When true, the
  // planner fans the freshly-built plan out to the asset queues itself instead
  // of parking the project at 'plan_ready' and waiting for the review screen's
  // "Generate assets" click. The button/route stay in place either way — they
  // are idempotent and still needed to re-dispatch after a partial failure.
  // Set to false to restore the gate (inspect/edit blocks before paid calls) —
  // which now actually works: this flag used to carry a warning that "false"
  // coerced to TRUE and the var had to be UNSET to disable it. boolish() fixed
  // that for every flag in this file.
  SYNTHETIC_AUTO_DISPATCH: boolish(true),
  // ADMISSION CONTROL: how many synthetic projects may be generating assets at
  // once. Auto-dispatch (above) removed the human review gate that used to
  // serialise this, so every project that finished planning fanned its whole
  // segment list into the image queue at once — observed 2026-08-11: 12 projects
  // in generating_images and 2,666 queued image_gen jobs.
  //
  // BullMQ is ONE FIFO queue with no per-project fairness, so those 2,666 jobs
  // interleave and every project finishes at roughly the same (very late) time:
  // ~13h at 8 concurrent × ~140s/image, with NO completed video until the end.
  // Capping admitted projects converts that into "one finished video every ~40
  // min" for the same total throughput — same work, far better delivery.
  //
  // Projects over the cap WAIT at 'plan_ready' (the existing gate status) and
  // are promoted automatically as earlier ones finish. Raising this does NOT
  // make images generate faster: the real throughput limit is the 69labs
  // account slots (SIXTYNINE_ACCOUNT_CONCURRENCY × keys), not this number.
  SYNTHETIC_MAX_GENERATING_PROJECTS: z.coerce.number().int().positive().default(3),
  // Auto-render (client request 2026-08-10: "if all assets are generated, the
  // rendering should be done"). When true, finalize enqueues the render itself
  // instead of parking at 'ready_for_review' for the Render click.
  //
  // CLEAN-ONLY: auto-render fires only when EVERY segment is 'ready'. A project
  // finalizes with failed/skipped blocks too (they're terminal states), and
  // auto-rendering those would silently ship a video with blocks missing — so
  // any failure falls back to the manual gate for a human to retry first.
  // See SYNTHETIC_AUTO_RENDER_ALLOW_FAILED to override that.
  SYNTHETIC_AUTO_RENDER: boolish(true),
  // Escape hatch: auto-render even when some blocks failed/were skipped. Off by
  // default — a failed block means a gap in the delivered video.
  SYNTHETIC_AUTO_RENDER_ALLOW_FAILED: boolish(false),
  // 6 -> 4 (client 2026-08-21: "wants to generate the only 4 sec clip"). This is
  // the knob that decides how long each visual block is, and therefore what
  // duration the clip lane asks LTX for.
  // ONLY EFFECTIVE ON THE SELF-HOSTED SERVICE: api.ltx.video's tier floor is 6s,
  // so against the hosted API a 4s block still snaps up to a 6s clip (and bills
  // 6s) — see LTX_DURATION_TIERS_OVERRIDE and snapDuration() in
  // lib/synthetic/ltx.ts. Shorter blocks also mean MORE of them per video, so
  // clip COUNT rises even as each clip gets cheaper.
  SYNTHETIC_BLOCK_TARGET_SECONDS: z.coerce.number().positive().default(4),
  // 8 -> 6 -> 5. Any visual block longer than this splits into
  // max(2, round(duration / TARGET)) even sub-blocks.
  //
  // 5, NOT 6, so EVERY clip lands on the 4s tier (client 2026-08-22: "always
  // generate the 4s clip"). snapDuration picks the nearest of 4 and 6, so the
  // decision boundary is 5s: a block <=5s becomes a 4s clip, >5s becomes 6s.
  // At 6 the (5,6] band survived unsplit and produced 6s clips.
  // Worst-case piece length after a split is dur/round(dur/4), which peaks just
  // under 5s (4 + 1.96/k for k>=2 slots) -- still inside the 4s tier.
  SYNTHETIC_BLOCK_SPLIT_THRESHOLD: z.coerce.number().positive().default(5),
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
  // 5 -> 4 (client 2026-08-22, "always generate the 4s clip"). The merge target
  // must match SYNTHETIC_BLOCK_TARGET_SECONDS, not sit above it: at 5 the merge
  // produced blocks of exactly 5.0s, which is the EXACT TIE between the 4s and
  // 6s tiers in snapDuration -- the tie resolves to 4 today only because the
  // scan keeps the first-seen tier on an equal distance, so a hair over 5.0 from
  // floating-point timing would silently yield a 6s clip. 4 keeps merged blocks
  // clear of that boundary.
  SYNTHETIC_BLOCK_MIN_HOLD: z.coerce.number().nonnegative().default(4),
  // Mixed clip/image window (client 2026-07-22 via Joey: "30% clips - 70%
  // images for the first 15 mins, and then the rest all images — no more LTX
  // after 15 minutes", LTX cost reduction). Visual blocks whose spoken window
  // STARTS before this many seconds get the intro clip:image mix below; after
  // the cutoff only SYNTHETIC_POST_INTRO_CLIP_FRACTION (0 = all stills) stay
  // clips. 0 disables the window entirely (whole video uses the post fraction).
  SYNTHETIC_CLIP_HEAVY_SECONDS: z.coerce.number().nonnegative().default(900),
  // Fraction of visual blocks INSIDE the clip-heavy window that are ai_clip,
  // spaced evenly (client 2026-07-22: 30% clips / 70% images). Takes precedence
  // over the run pattern below when > 0; set to 0 to fall back to the
  // CLIP_RUN/IMAGE_RUN pattern.
  SYNTHETIC_INTRO_CLIP_FRACTION: z.coerce.number().min(0).max(1).default(0.3),
  // LEGACY intro clip/image run pattern (client 2026-07-03: "ai clip - ai clip
  // - image - image"), used only when SYNTHETIC_INTRO_CLIP_FRACTION is 0.
  // Within the clip-heavy window, visual blocks follow a repeating pattern of
  // CLIP_RUN ai_clips then IMAGE_RUN images. IMAGE_RUN 0 = all-clip intro.
  SYNTHETIC_INTRO_CLIP_RUN: z.coerce.number().int().positive().default(2),
  SYNTHETIC_INTRO_IMAGE_RUN: z.coerce.number().int().nonnegative().default(2),

  // ---------------------------------------------------------------------
  // CLIP BUDGET BY DURATION, IN TWO PHASES (client direction 2026-08-20 via
  // Joey): "The first 3 min, 65 % ltx clips and 35 % images. After 3 mins, 70%
  // images and 30% clips."
  //
  // COST TRIM of the 2026-08-18 direction (4 min @ 80/20, then 70/20/10), which
  // itself superseded the flat 2026-08-17 one ("25% LTX / 5% VEO across the
  // video"). Joey: "the ltx cost is a bit high [...] I think we need to lower it
  // a bit." Only PHASE 1 moved — the window shortened 4 min -> 3 min and the LTX
  // share dropped 80% -> 65%. PHASE 2 is UNCHANGED because the new ask already
  // describes it exactly: 20% LTX + 10% VEO is the "30% clips" it asks for,
  // leaving the 70% images.
  //
  // The opening window is still deliberately clip-heavy: the reference channel
  // Joey linked opens on motion, and a still-heavy first minute is where his
  // videos lose retention. 65% keeps that character at ~39% less phase-1 spend.
  //
  // BASIS — read the percentages the way the client states them. Both phases
  // quote clips-vs-images and both sum to 100 (65+35, 70+20+10), so they are
  // shares of the ASSIGNABLE VISUAL time (image + ai_clip blocks) in that
  // phase, NOT of total screen time. Avatar and split_2 blocks come from the
  // Google Doc highlights and cannot be reassigned (see assignClipDurationQuota),
  // so measuring against total time would make "80%" unreachable on any
  // normally-highlighted doc and silently under-deliver the whole window. Set
  // SYNTHETIC_CLIP_FRACTION_BASIS=total for the pre-2026-08-18 behaviour, where
  // the fractions are shares of total video duration.
  //
  // These are shares of DURATION (seconds of screen time), NOT of block count.
  // That distinction is the whole point: the older SYNTHETIC_*_CLIP_FRACTION
  // knobs above balance by COUNT and by POSITION, and a count share does not
  // produce a duration share when blocks differ in length. The duration pass
  // (assignClipDurationQuota) runs AFTER those and is authoritative for the
  // final mix.
  //
  // COST NOTE: LTX-2 bills per second (~$0.04/s). The phase-1 window is still
  // the expensive one, and it is the lever the 2026-08-20 trim pulled: 65% of 3
  // minutes is ~2.0 min of LTX (~$4.70) per video, down from ~3.2 min (~$7.70)
  // at 4 min / 80%. Phase 2 absorbs the 60s the opening gave up (+~$0.50 at its
  // 20% LTX share), so the net is ~$2.50 off a 20-minute video — roughly -16% of
  // its LTX spend. Shorten SYNTHETIC_CLIP_PHASE1_SECONDS or drop
  // SYNTHETIC_CLIP_PHASE1_CLIP_FRACTION further to pull back more. The pre-existing
  // SYNTHETIC_CLIP_HEAVY_SECONDS window exists for the same reason ("no more LTX
  // after 15 minutes"); set SYNTHETIC_CLIP_QUOTA_RESPECT_CUTOFF to keep the
  // whole budget inside it.

  // End of the clip-heavy OPENING window, in seconds of video time. Blocks whose
  // spoken window STARTS before this use the PHASE1 fractions below; everything
  // at or after it uses the phase-2 fractions. 0 disables phasing entirely (the
  // phase-2 fractions then apply to the whole video, i.e. pre-2026-08-18
  // behaviour).
  // NOTE: this value ALSO bounds the split_2 no-promotion window (see the
  // ensureMinSplit2 caller in lib/synthetic/planner.ts) — shortening it to 180
  // lets split_2 blocks start appearing from 3:00 rather than 4:00, which is
  // intended: it gives the separate "80% of splitscreens in the first 12 min"
  // ask a wider runway.
  SYNTHETIC_CLIP_PHASE1_SECONDS: z.coerce.number().nonnegative().default(180),
  // PHASE 1 (first SYNTHETIC_CLIP_PHASE1_SECONDS): LTX share. Client 2026-08-20:
  // 65% clips / 35% images, with no VEO called for in the opening window.
  SYNTHETIC_CLIP_PHASE1_CLIP_FRACTION: z.coerce.number().min(0).max(1).default(0.65),
  // PHASE 1 VEO share, on top of the LTX share above. 0 = the opening window is
  // all-LTX (the client specified only "clips" for the first 3 minutes, and VEO
  // bills per generation, so spending it here buys less than in the long tail).
  SYNTHETIC_CLIP_PHASE1_VEO_FRACTION: z.coerce.number().min(0).max(1).default(0.0),
  // PER-BUCKET ANIMATION SCHEDULE (client 2026-08-22). Supersedes the two-phase
  // model above WHEN SET: the client supplied a per-minute table of "animated
  // seconds out of 60" that DECAYS across the video rather than stepping once at
  // 3 minutes, and a two-window model cannot express a curve.
  //
  // Format: "startSeconds:animatedFraction" pairs, ascending. Each entry runs
  // until the next entry's start; the last runs to the end of the video.
  // Empty = keep the two-phase behaviour (SYNTHETIC_CLIP_PHASE1_* above).
  //
  // The client's table, as fractions of each bucket (animatedSeconds / bucket):
  //   0-1m 51/60=.85   1-2m 48/60=.80   2-3m 45/60=.75   3-4m 50/60=.83
  //   4-5m 30/60=.50   5-6m 24/60=.40   6-7m 20/60=.33   7-8m 15/60=.25
  //   8-9m 10/60=.17   9-10m 10/60=.17  10-11m 5/60=.083
  //   11-12.3m 7/80=.088  12.3-13.3m 3/60=.05  13.3-14.3m 3/60=.05  14.3m+ 0
  // (The 80-second buckets are the client's own irregular boundaries, preserved
  // rather than normalised so the schedule matches the table they measured.)
  //
  // This totals ~321 animated seconds/video, up from ~261 under the two-phase
  // config — MORE animation, not less, so it raises clip volume ~23%.
  SYNTHETIC_CLIP_SCHEDULE: z.string().optional(),
  // VEO's share of each scheduled bucket's animated seconds; the remainder is
  // LTX. Default 0 because the client's table says only "animated" and does not
  // distinguish providers, and LTX is now self-hosted (near-free) while veo
  // still bills per generation. Set to e.g. 0.1 to keep a veo look-mix.
  SYNTHETIC_CLIP_SCHEDULE_VEO_FRACTION: z.coerce.number().min(0).max(1).default(0.0),
  // PHASE 2 (after the window): LTX share. Client 2026-08-18: 20% LTX. Left
  // untouched by the 2026-08-20 trim — 20 LTX + 10 VEO is that ask's "30% clips".
  //
  // 0.20 -> 0.30 (client 2026-08-22: "remove the veo3 clip entirely / generate
  // the only ltx clip"). The 10% that veo used to cover is ABSORBED here rather
  // than dropped, because targetClip below is computed as
  // (clipFraction + veoFraction) — the veo share is part of the ANIMATION
  // budget, not an addition to it. Turning veo off without this hands those
  // seconds back to still images and quietly cuts phase-2 animation from 30% to
  // 20%, which is not what "only LTX clips" asks for.
  SYNTHETIC_CLIP_DURATION_FRACTION: z.coerce.number().min(0).max(1).default(0.30),
  // PHASE 2 VEO share, on top of the LTX share above (20% + 10% = 30% clips,
  // leaving the client's 70% images). Veo bills per GENERATION (1 credit), not
  // per second, so this fraction controls clip COUNT rather than spend. Set to 0
  // to disable the veo lane without touching SYNTHETIC_VEO_ENABLED.
  // 0.10 -> 0 (client 2026-08-22, veo removed entirely). Its share moved into
  // SYNTHETIC_CLIP_DURATION_FRACTION above so total animation is unchanged.
  SYNTHETIC_VEO_DURATION_FRACTION: z.coerce.number().min(0).max(1).default(0.0),
  // What the fractions above are a share OF. "visual" (default, 2026-08-18) =
  // the image + ai_clip seconds in that phase — the pool the pass can actually
  // reassign, and the reading that makes 80/20 and 70/20/10 sum to 100. "total"
  // = total screen time in that phase including avatar / split_2 (the
  // 2026-08-17 behaviour).
  SYNTHETIC_CLIP_FRACTION_BASIS: z.enum(["visual", "total"]).default("visual"),
  // When true, the clip budget is drawn only from blocks starting before
  // SYNTHETIC_CLIP_HEAVY_SECONDS (preserving the "no LTX after 15 min" cost
  // guard); the percentages are then met within that window rather than across
  // the whole video. False (default) applies the client's percentages to the
  // WHOLE video as literally stated.
  SYNTHETIC_CLIP_QUOTA_RESPECT_CUTOFF: boolish(false),
  // Master switch for the veo clip lane. Off = every clip renders on LTX and
  // the veo quota is ignored (useful to fall back instantly if Veo output is
  // judged unusable, which the client has flagged as a risk).
  //
  // true -> false (client 2026-08-22: "remove the veo3 clip entirely / generate
  // the only ltx clip"). This is the belt to the braces of
  // SYNTHETIC_VEO_DURATION_FRACTION=0: the fraction stops veo being PLANNED,
  // this stops it being HONOURED even if a stale env or an old plan still
  // carries a veo share. Note it only gates the veo QUOTA — 69labs Veo is also
  // still reachable as a fal.ai-chain fallback when an LTX clip fails, which is
  // deliberate: a dead GPU should degrade to a working provider, not to a
  // missing block.
  SYNTHETIC_VEO_ENABLED: boolish(false),
  // 69labs video lane (lib/synthetic/sixtynine-video.ts). Model ids come from
  // GET /api/v1/videos/models — "veo-video" is Veo 3.1 Lite (1 credit),
  // "veo-3.1-fast" is Veo Fast BETA (2 credits).
  SIXTYNINE_LABS_VIDEO_MODEL: z.string().default("veo-video"),
  SIXTYNINE_LABS_VIDEO_POLL_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(900),
  // split_2 cap (client feedback 2026-06: "too many split_2 parts, I don't want
  // many split_2 part video"). split_2 (a talking presenter beside an
  // illustrative still) is chosen freely by Gemini and routinely overruns — one
  // 115-block plan came back with 50 split_2 (~43%). This caps split_2 at this
  // FRACTION of total blocks; the excess (lowest-priority first) is demoted to a
  // plain 'image'. Client 2026-07-07 asked for ~10-15%; client 2026-07-22 asked
  // to REDUCE split_2 again, so the band is now 5-8%: this CEILING is 0.08 and
  // SYNTHETIC_SPLIT2_MIN_FRACTION below is the 0.05 floor.
  // Set to 0 to demote EVERY split_2 to image (no presenter-beside-image layout);
  // set to 1 to disable the cap (back to Gemini's unrestricted choice).
  SYNTHETIC_SPLIT2_MAX_FRACTION: z.coerce.number().min(0).max(1).default(0.08),
  // FLOOR of the 5-8% band (client 2026-07-22). The cap KEEPS this fraction of
  // total blocks as split_2 rather than demoting below it, so a plan with plenty
  // of split_2 lands at ~10-15%, not scraped down to a token few. NOTE: the capper
  // only DEMOTES excess split_2; it never PROMOTES images, so this is a
  // "don't-demote-below" guarantee — if Gemini chose fewer than 10%, the plan keeps
  // whatever it chose (we don't force the layout onto unsuitable content). 0
  // disables the fractional floor (fall back to the fixed MIN_KEEP count).
  SYNTHETIC_SPLIT2_MIN_FRACTION: z.coerce.number().min(0).max(1).default(0.05),
  // Minimum split_2 blocks to KEEP when Gemini chose at least one (client:
  // "why is split_2 not appeared?"). The cap above trims excess split_2; this
  // floor guarantees a few survive the later passes so the layout still shows
  // up. Combined with SYNTHETIC_SPLIT2_MIN_FRACTION as max(count, fraction*total)
  // so a short video still keeps a couple even when 10% rounds below 2.
  // 0 = no fixed floor (a video can have zero split_2 if Gemini chose none).
  SYNTHETIC_SPLIT2_MIN_KEEP: z.coerce.number().int().nonnegative().default(2),
  // Minimum number of blocks between two kept split_2 (client 2026-07: a
  // step-by-step walkthrough section came back as 15+ consecutive split_2 —
  // the count cap above has no spacing rule, so an in-budget clump survived).
  // A split_2 is kept only when at least this many non-split_2 blocks sit
  // between it and the previously kept one; the ones in between are demoted to
  // plain 'image'. 0 disables spacing (count cap only); 1 = never back-to-back.
  // Raised 3 → 5 with the 2026-07-22 band reduction so the fewer kept split_2
  // also spread further apart instead of pairing up in one section.
  SYNTHETIC_SPLIT2_MIN_GAP: z.coerce.number().int().nonnegative().default(5),
  // SPLIT_2 FRONT-LOADING (client 2026-08-18 via Joey: "i want more split
  // screens in the 12 min of the video. Put 80% of the splitscreens in the
  // first 12 min and the 20% to the rest").
  //
  // The band knobs above set HOW MANY split_2 a video gets; these set WHERE they
  // sit. The allowed count is divided into two zones by video time — the first
  // SYNTHETIC_SPLIT2_FRONT_SECONDS gets SYNTHETIC_SPLIT2_FRONT_SHARE of the
  // allowance and the tail gets the remainder — and both the cap pass (which
  // demotes excess) and the floor pass (which promotes images) work to those
  // per-zone quotas. Without this the passes only balance across the whole
  // timeline, which is how a 40-minute video ended up with its split_2 spread
  // thin and almost none in the opening stretch the client cares about.
  //
  // NOTE: front-loading is a REDISTRIBUTION, not an increase — the total still
  // obeys SYNTHETIC_SPLIT2_MAX_FRACTION / MIN_FRACTION. Raise the band if the
  // client wants more split_2 overall, not this share.
  // 0 disables zoning (single whole-video quota, pre-2026-08-18 behaviour).
  SYNTHETIC_SPLIT2_FRONT_SECONDS: z.coerce.number().nonnegative().default(720),
  // Share of the total split_2 allowance placed inside the front window.
  SYNTHETIC_SPLIT2_FRONT_SHARE: z.coerce.number().min(0).max(1).default(0.80),
  // Spacing rule INSIDE the front window, in blocks — the SYNTHETIC_SPLIT2_MIN_GAP
  // equivalent for the front zone, applied when both neighbours are in it.
  //
  // Why it has to differ: MIN_GAP (5) was tuned for split_2 spread across a whole
  // video. Concentrating 80% of them into 12 minutes is a much higher density by
  // construction, and at gap 5 the window simply cannot hold the requested share
  // — the front target then silently under-delivers no matter what the share is
  // set to. 3 keeps the client's actual objection intact (they rejected
  // CONSECUTIVE split_2, and 3 still means 3 other blocks in between, ~20-25s of
  // other footage) while roughly doubling what the window can hold. Raise it
  // toward 5 if the front stretch starts to feel split_2-heavy; the front share
  // will then fall short and log it rather than pack them tighter.
  SYNTHETIC_SPLIT2_FRONT_MIN_GAP: z.coerce.number().int().nonnegative().default(3),
  // Maximum DURATION for a single split_2 block (client 2026-07-03: a 38s
  // split_2 — Gemini lumped 5 sentences into one block and, unlike image /
  // ai_clip, nothing carves a split_2, so the same still held beside the
  // presenter for 38s). A split_2 over this cap keeps its FIRST sentence as the
  // split_2 and the remaining sentences become a plain 'image' block, which the
  // duration-split pass then paces into normal ~target-second visuals. A
  // single-sentence split_2 that alone exceeds the cap is demoted entirely to
  // 'image' (there is no sentence boundary to carve on). 0 disables the cap.
  SYNTHETIC_SPLIT2_MAX_SECONDS: z.coerce.number().nonnegative().default(12),
  // Target fraction of POST-clip-heavy-cutoff visual blocks that stay ai_clip,
  // the rest demoted to image, spaced evenly. Default 0 (client 2026-07-22:
  // "then the rest all images — no more LTX after 15 minutes", LTX cost
  // reduction; previously 0.25 ≈ 1 in 4 after a 3-min intro). 1 = keep all
  // clips (disable), 0.5 = even split.
  SYNTHETIC_POST_INTRO_CLIP_FRACTION: z.coerce.number().min(0).max(1).default(0),
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
  SYNTHETIC_DEGRADE_ENABLED: boolish(false),
  SYNTHETIC_DEGRADE_BLUR_SIGMA: z.coerce.number().nonnegative().default(0.8),
  SYNTHETIC_DEGRADE_IMAGE_NOISE: z.coerce.number().nonnegative().default(22),
  SYNTHETIC_DEGRADE_IMAGE_JPEG_QUALITY: z.coerce.number().int().min(1).max(100).default(60),
  SYNTHETIC_DEGRADE_VIDEO_NOISE: z.coerce.number().nonnegative().default(18),
  SYNTHETIC_DEGRADE_VIDEO_CRF_DELTA: z.coerce.number().int().nonnegative().default(6),

  // SALES-PITCH QR OVERLAY (client 2026-08-03). The pitch's final window scroll-
  // records the client's real website; this pins a scannable QR card over THAT
  // window (and only that window — never the avatar half) linking to the same
  // site. Nothing new is asked of the user: the QR encodes the pitch's existing
  // website_url.
  //
  // Size/margin are FRACTIONS OF FRAME WIDTH, not pixels, deliberately. The
  // pitch canvas is SYNTHETIC_WIDTH/HEIGHT (1280x720 today) and the client has
  // an open 4K request — hardcoded pixel offsets would land at the wrong scale
  // the moment the canvas changes. The defaults resolve to ~179px inset 48px at
  // 1280 wide, which is ~14% of frame width: big enough for a phone to lock on
  // to from a screen, small enough not to cover the page being scrolled.
  //
  // Off by default so deploying this is a no-op until the client confirms the
  // placement on a real pitch.
  PITCH_QR_ENABLED: boolish(false),
  PITCH_QR_SIZE_FRACTION: z.coerce.number().min(0.02).max(0.5).default(0.14),
  PITCH_QR_MARGIN_FRACTION: z.coerce.number().min(0).max(0.4).default(0.0375),
  PITCH_QR_POSITION: z
    .enum(["top-right", "top-left", "bottom-right", "bottom-left"])
    .default("top-right"),
  // White padding between the card edge and the QR, as a fraction of card size.
  // On top of the QR's own 4-module quiet zone. ~0.09 of a 179px card ≈ 16px.
  PITCH_QR_PADDING_FRACTION: z.coerce.number().min(0).max(0.3).default(0.09),

  // Voiceover QC (client 2026-07: "sometimes the audio file is corrupted —
  // check if the audio has any low volume and if so, regenerate"). 69labs
  // occasionally renders a MIDDLE stretch of a long TTS job with the wrong
  // voice / a dropped level (observed: ~5 min at a lower volume from 9:12 on a
  // 31-min voiceover). Our pipeline plays back whatever 69labs produced, so we
  // detect the defect right after generation and re-run the TTS.
  //
  // Detection (see detectLoudnessDropout): ffmpeg ebur128 emits momentary
  // loudness every ~100ms; we take the median of the VOICED samples as the
  // track's normal level, then flag a CONTIGUOUS span that sits far below it.
  //   _DROP_DB    — how far below the median counts as a dropout (LU). A real
  //                 wrong-voice/level section runs many LU quieter; natural
  //                 sentence gaps are excluded by the span floor below.
  //   _MIN_SPAN_S — minimum length of the low span to flag (seconds). Long
  //                 enough that ordinary pauses/breaths never trip it, short
  //                 enough to catch a multi-second corrupted stretch.
  //   _MAX_REGEN  — how many times to re-generate before giving up and shipping
  //                 the least-bad take (0 disables the whole QC pass).
  SYNTHETIC_VOICEOVER_QC_DROP_DB: z.coerce.number().positive().default(9),
  SYNTHETIC_VOICEOVER_QC_MIN_SPAN_S: z.coerce.number().positive().default(4),
  SYNTHETIC_VOICEOVER_QC_MAX_REGEN: z.coerce.number().int().nonnegative().default(2),

  // =======================================================================
  // THUMBNAILS ENGINE (migration 0027). A third top-level product, separate
  // from the sourced/synthetic VIDEO engines. Generates YouTube thumbnails
  // from 1–5 reference thumbnails + a title/prompt via the Pikzels API
  // (https://docs.pikzels.com). All optional — when PIKZELS_API_KEY is unset,
  // the /api/thumbnails/generate route 503s and the video engines are
  // unaffected.
  //
  // Auth is the `X-Api-Key` header (keys look like `pkz_...`). The reference
  // endpoint (POST {base}/v2/thumbnail/image) returns { output, request_id }
  // where `output` is a CDN URL that EXPIRES in ~24h — so the route downloads
  // it and re-hosts to R2 for a permanent link.
  PIKZELS_API_KEY: z.string().optional(),
  PIKZELS_BASE_URL: z.string().url().default("https://api.pikzels.com"),
  // Generation model. Enum per Pikzels docs: pkz_2 | pkz_3 | pkz_4 | pkz_4_5.
  // The optional style reference (support_image_url) is honored ONLY by pkz_4
  // and pkz_4_5, so we default to pkz_4_5 to keep the two-reference flow usable.
  PIKZELS_MODEL: z.enum(["pkz_2", "pkz_3", "pkz_4", "pkz_4_5"]).default("pkz_4_5"),
  // Aspect ratio. Enum per docs: 16:9 (YouTube) | 9:16 | 1:1.
  PIKZELS_FORMAT: z.enum(["16:9", "9:16", "1:1"]).default("16:9"),
  // PERSONA (identity lock). When a user uploads a face, we build a Pikzels
  // "persona" (POST /v2/pikzonality/persona, 3 face images) and pass its id to
  // the generate call so the EXACT face is preserved (instead of Pikzels
  // regenerating a new person). Persona creation is ASYNC — we poll
  // GET /v2/pikzonality/{id} until status='completed'. These knobs bound the
  // poll; a probe measured ~60s to completed, so ~4 min of budget is ample.
  // Set PIKZELS_PERSONA_ENABLED=false to disable the face-lock path and fall
  // back to the plain uploaded-face-as-base behavior.
  PIKZELS_PERSONA_ENABLED: boolish(true),
  PIKZELS_PERSONA_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  PIKZELS_PERSONA_POLL_TIMEOUT_MS: z.coerce.number().int().positive().default(240000),

  // =======================================================================
  // HEYGEN API FALLBACK. When the headless-browser HeyGen automation exhausts
  // its whole account pool WITHOUT producing an avatar clip, generateAvatar can
  // fall back to the OFFICIAL HeyGen API (upload photo + audio assets -> create
  // a talking-photo video -> poll -> download). It is a LAST RESORT because the
  // API bills API credits, which cost more than the interactive-plan renders the
  // browser automation drives (the whole reason this project automates the web
  // UI). Fully OFF by default: the fallback only runs when HEYGEN_API_FALLBACK is
  // true AND HEYGEN_API_KEY is set — otherwise the pool-exhausted error throws
  // exactly as before, so production behavior is unchanged until a key + flag are
  // provisioned. Auth is the `x-api-key` header; assets + video endpoints are v3.
  HEYGEN_API_KEY: z.string().optional(),
  HEYGEN_API_FALLBACK: boolish(false),
  HEYGEN_API_BASE_URL: z.string().url().default("https://api.heygen.com"),
  // RETRIEVAL SOURCE (V1→V3 migration). When false (default) the post-Generate
  // render retrieval polls HeyGen's INTERNAL web-app API
  // (api2.heygen.com/v1/project/items, cookie-authed via the browser context) —
  // the legacy path. That constant /v1/ traffic is what trips HeyGen's "still on
  // V1/V2 APIs" deprecation notice even though our public REST client is already
  // v3. When true, retrieval instead polls the PUBLIC v3 endpoint
  // GET {HEYGEN_API_BASE_URL}/v3/videos?title=<segmentId> (x-api-key authed) — a
  // live probe (scripts/heygen-v3-title-probe.ts) confirmed the title filter runs
  // server-side and returns exactly our segment's render, so retrieval no longer
  // needs the browser cookie NOR a 4000-row scan. REQUIRES HEYGEN_API_KEY. Kept
  // behind a flag so v3 retrieval can be canaried on the Fly avatar worker before
  // the v1 path is removed. See lib/synthetic/heygen.ts fetchProjectItems.
  HEYGEN_RETRIEVAL_V3: boolish(false),
  // Rendered resolution for the API fallback.
  //
  // 4K IS NOT REACHABLE HERE. Probed live 2026-08-03 with a real photo-avatar
  // look: POST /v3/videos resolution:"4k" returns 400
  //   "Photo Avatar (engine 'avatar_iii' with a photo avatar) does not support
  //    4K output."
  // while the identical 1080p request rendered fine. It is an ENGINE limit, not a
  // plan limit (the account is billing_type "wallet", subscription null). Since
  // every avatar goes through Avatar III + a per-project photo avatar (see the
  // va-<proj8>-<sha6> flow), 1080p is the hard ceiling for avatar blocks and the
  // 3840×2160 canvas upscales them. "4k" stays in the enum because the API accepts
  // it for OTHER engines (Avatar IV) — do not set it on this path.
  HEYGEN_API_RESOLUTION: z.enum(["720p", "1080p", "4k"]).default("1080p"),
  // NOTE on the render ENGINE (client 2026-07-20: Avatar IV too expensive, wants
  // Avatar III everywhere): probed live 2026-07-21 — POST /v3/videos with
  // type:"image" (one-shot uploaded photo) REJECTS an `engine` field and always
  // renders Avatar IV; engine selection exists ONLY on type:"avatar" (a saved
  // avatar_id). The API fallback therefore resolves/creates a saved photo-avatar
  // (named va-<proj8>-<sha6>, shared with the browser flow) and renders it with
  // engine avatar_iii — see heygen-api.ts.
  // Ceiling (seconds) on waiting for a newly created photo avatar's TRAINING to
  // complete before the render can start. Only hit when no browser-created
  // avatar exists to reuse; photo-avatar training is usually well under a minute.
  HEYGEN_API_AVATAR_TRAIN_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(600),
  // Hard ceiling (seconds) on the API render poll loop, so a stuck HeyGen-side
  // render fails in bounded time instead of hanging the avatar job.
  HEYGEN_API_RENDER_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(900),
  // SPEED SWITCH (client 2026-07-06): don't wait for the WHOLE browser pool to
  // exhaust before trying the API. Switch to the API early when EITHER trigger
  // fires, so a slow/failing clip recovers fast instead of grinding through every
  // account + BullMQ retry:
  //   * after this many failed browser accounts in one generateAvatar run
  //     (client rule "after 2 tries"), or
  //   * after this much wall-clock has elapsed on the clip (client rule "after 30
  //     min"), checked between browser attempts.
  // Both are gated by HEYGEN_API_FALLBACK — when the flag/key are unset the
  // browser path still runs to full pool-exhaustion exactly as before. Set the
  // account threshold to 0 to disable the count trigger (time-only), or the
  // minutes to 0 to disable the time trigger (count-only).
  HEYGEN_API_SWITCH_AFTER_ACCOUNTS: z.coerce.number().int().nonnegative().default(2),
  HEYGEN_API_SWITCH_AFTER_MINUTES: z.coerce.number().nonnegative().default(30),
  // POOL-WAIT (client 2026-07-07). When a burst enqueues MORE avatar clips than
  // there are HeyGen accounts, the overflow clips find every account busy. Instead
  // of hard-failing, the worker RE-DELAYS the clip so it WAITS for an account to
  // free (a browser render is ~150s, so one usually frees within a cycle → the
  // clip then renders on the cheap browser path). It re-checks every
  // HEYGEN_POOL_WAIT_INTERVAL_SECONDS, up to HEYGEN_POOL_WAIT_MAX_CYCLES times;
  // once that many cycles pass (client's "after 2 tries") OR
  // HEYGEN_API_SWITCH_AFTER_MINUTES elapses (client's "after 30 min"), the clip
  // switches to the API. Set MAX_CYCLES to 0 to wait purely on the 30-min timer.
  HEYGEN_POOL_WAIT_INTERVAL_SECONDS: z.coerce.number().int().positive().default(90),
  HEYGEN_POOL_WAIT_MAX_CYCLES: z.coerce.number().int().nonnegative().default(2),
  // Hard timeout (seconds) for one Pikzels generation request. The image
  // endpoint responds synchronously (~<30s per Pikzels), so this is a
  // fetch-abort backstop, not a poll loop.
  PIKZELS_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(120),

  // =======================================================================
  // REUSABLE ASSET LIBRARY (migration 0030). A cross-project index of every
  // generated still / ai_clip keyed by its clean semantic prompt, so a NEW
  // segment whose prompt closely matches something we already generated can
  // REUSE that asset instead of paying a provider (69labs image, LTX clip)
  // to make it again. The client's explicit cost-reduction ask: "store
  // everything we've generated so the AI can fetch older generations."
  // =======================================================================
  // Master toggle. Off = the image / ai_clip processors behave exactly as
  // before (always generate fresh; nothing is indexed). On = check the library
  // before generating and index every fresh asset after generating. Default
  // false so a deploy without the migration applied (or before backfill) is a
  // pure no-op.
  ASSET_LIBRARY_ENABLED: boolish(false),
  // Cosine-SIMILARITY threshold [0..1] a library candidate must clear to be
  // reused (1 = identical embedding). Deliberately strict — a loose match
  // reuses visibly wrong footage, which reads worse than a fresh generation.
  // 0.92 ≈ "same scene, differently worded". Raise toward 0.96 to reuse only
  // near-identical prompts; lower cautiously to widen reuse. The exact-hash
  // fast-path (normalized prompt equality) short-circuits this for verbatim
  // repeats (e.g. the planner's recurring base_prompt) at similarity 1.0.
  ASSET_LIBRARY_REUSE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.92),
  // Gemini text-embedding model for prompt vectors. gemini-embedding-001 emits
  // vectors up to 3072-dim; we request 768 (outputDimensionality) to match the
  // migration's vector(768) column. The older text-embedding-004 alias is
  // RETIRED on the current v1beta API (404 "not found for embedContent"), so it
  // is NOT a valid value here. Reuses GEMINI_API_KEY. Bump only in lockstep
  // with ASSET_LIBRARY_EMBED_DIMS + the migration's column width.
  ASSET_LIBRARY_EMBED_MODEL: z.string().default("gemini-embedding-001"),
  // Dimensionality of the embedding vectors. MUST equal the migration's
  // vector(N) column width AND a size the embed model can output. 768 is
  // text-embedding-004's native size. Changing this requires a new migration
  // that re-creates the column + index at the new width (and a re-backfill).
  ASSET_LIBRARY_EMBED_DIMS: z.coerce.number().int().positive().default(768),
  // How many nearest neighbours the match query returns before variety
  // filtering picks one. A small pool (default 8) is enough for the
  // least-recently-used rotation to avoid always returning the single closest
  // match (which would recycle the same asset into every video). Raise to
  // widen rotation, lower to cut query cost.
  ASSET_LIBRARY_MATCH_LIMIT: z.coerce.number().int().positive().default(8),
  // Per-project reuse ceiling, as a fraction of the project's segment count.
  // Once floor(total_segments * this) segments carry a reused marker, lookups
  // return null and every remaining segment generates fresh. Set to 1 to lift
  // the cap, 0 to disable reuse entirely without touching ASSET_LIBRARY_ENABLED.
  //
  // LOWERED 0.5 → 0.15 (client 2026-08-19 via Joey: "the images are quite
  // repetitive […] can you hardcode it in that its not too repetitive and it
  // matches the script better. Because it negatively influences the performance
  // if the video is too repetitive"). At 0.5 half of a video could be assets
  // recycled from earlier projects, which is what made a spoon script come back
  // as the same handful of spoon shots over and over. 0.15 keeps the cost win of
  // reuse on genuinely repeated subject matter while forcing the bulk of a video
  // to be generated for ITS script.
  //
  // This is the CROSS-VIDEO half of the repetition fix. The WITHIN-video half —
  // near-identical prompts inside one script — is the planner's scene-dedupe
  // pass (SYNTHETIC_SCENE_DEDUPE_* below); both were needed.
  ASSET_LIBRARY_MAX_REUSE_FRACTION: z.coerce.number().min(0).max(1).default(0.15),

  // ---------------------------------------------------------------------
  // WITHIN-VIDEO SCENE DEDUPE (client 2026-08-19 via Joey: "for example the
  // german video, it is showing spoons a lot, very similar images and similar
  // footages. I want more variation").
  //
  // The planner already de-duplicates the EXTRA visuals of a SINGLE sentence
  // (the distinct-second-visual pass). It did nothing across sentences — so a
  // script that says "spoon" in forty places got forty near-identical spoon
  // prompts, each individually reasonable. This pass compares every visual
  // block's prompt against the ones already accepted and regenerates the ones
  // that are too close, telling Gemini which scenes are already taken.
  SYNTHETIC_SCENE_DEDUPE_ENABLED: boolish(true),
  // Jaccard similarity over content words, above which two prompts count as the
  // same scene. 0.5 is deliberately loose — "close-up of a wooden spoon on a
  // marble counter" vs "a wooden spoon resting on a marble countertop" scores
  // well under a strict threshold yet renders as the same picture.
  SYNTHETIC_SCENE_DEDUPE_SIMILARITY: z.coerce.number().min(0).max(1).default(0.5),
  // How far back to compare. Repetition reads as repetition when the viewer can
  // still remember the earlier shot, and comparing every block against every
  // other on a 300-block plan is both quadratic and over-strict (a callback to a
  // subject 20 minutes later is fine). 0 = compare against the whole video.
  SYNTHETIC_SCENE_DEDUPE_WINDOW: z.coerce.number().int().nonnegative().default(40),
  // Hard ceiling on regenerations per plan. Each one is a Gemini call, so an
  // extremely repetitive script must not turn planning into hundreds of extra
  // round-trips. Blocks past the cap keep their original prompt and the overflow
  // is logged (synthetic.plan.scene_dedupe.capped) rather than silently dropped.
  SYNTHETIC_SCENE_DEDUPE_MAX_REGEN: z.coerce.number().int().nonnegative().default(80),
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
  reportFlagsExplicitlyOff(cached);
  return cached;
}

/**
 * Log every boolean flag whose env value spells "off".
 *
 * Before boolish(), those flags all evaluated to TRUE — so this list is exactly
 * the set of behaviours that CHANGED when the fix landed. Printed once per
 * process so a deploy makes the flip visible instead of leaving it to be
 * discovered in a rendered video, which is how the clip-cutoff bug was found.
 *
 * Fly SECRETS override [env] and are not visible in the repo, so this is the
 * only place a secret-set "false" shows up.
 *
 * Detection is by RESULT, not by a hand-maintained list: a key is a boolean flag
 * iff its parsed value is a boolean, so a flag added later is covered for free.
 */
function reportFlagsExplicitlyOff(env: ServerEnv): void {
  const parsedValues = env as unknown as Record<string, unknown>;
  for (const [key, raw] of Object.entries(process.env)) {
    if (typeof raw !== "string" || !/^(0|false|no|off)$/i.test(raw.trim())) continue;
    if (typeof parsedValues[key] !== "boolean") continue;
    FLAGS_EXPLICITLY_OFF.push(key);
  }
  if (FLAGS_EXPLICITLY_OFF.length === 0) return;
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    msg: "env.flags_explicitly_off",
    note:
      "these flags are OFF because their env value spells off — before the " +
      "boolish() fix every one of them would have read as ON",
    flags: FLAGS_EXPLICITLY_OFF.slice().sort(),
  }));
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
