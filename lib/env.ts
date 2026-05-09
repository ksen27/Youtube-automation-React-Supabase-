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
  // For a 30-minute source, the first 10 minutes have plenty of scene
  // boundaries to pick clip timestamps from — analyzing the whole thing is
  // wasted CPU. Combined with downscale=320, this keeps scene-detect under
  // ~20s on shared-CPU hosts.
  SCENE_DETECT_MAX_INPUT_SECONDS: z.coerce.number().int().positive().default(600),
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

export const CLIP_DURATION_SECONDS = 5; // 4–5s window; we standardize on 5

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
