import { getEnv } from "@/lib/env";
import { fetchOrThrow, withHttpRetry, isAuthForbidden } from "@/lib/synthetic/http";
import { withStylePrompt } from "@/lib/synthetic/constants";
import { withAccountSlot, acquirePollToken } from "@/lib/synthetic/rate-limit";
import { generateFalImage, isFalImageConfigured } from "@/lib/synthetic/falai";

// Stable per-account id for the Redis slot pool. We key by the api key's short
// prefix (never the full secret) so each 69labs account gets its own global
// semaphore and the key value itself never lands in a Redis key name or a log.
function accountIdFor(key: string): string {
  return key.slice(0, 10);
}

// 69labs provider: TTS voiceover + nano-banana image generation.
//
// 69labs is configured via SIXTYNINE_LABS_* env. Both TTS and image generation
// are ASYNC JOB APIs on 69labs.vip: submit -> poll status -> download. The
// request/response shapes below follow 69labs' documented REST contract. If the
// live API differs, only the submit / poll / download blocks here need
// adjusting — every caller goes through generateVoice() / generateImage() and
// is insulated from the wire format.
//
// Images get the mandatory STYLE_PROMPT appended (withStylePrompt). The
// image-to-video and avatar steps live in separate provider modules.

// PER-KEY gate on concurrent image generations. The image_gen, image_to_video,
// and avatar/split_2 lanes each call generateImage on their own BullMQ
// concurrency, so their combined in-flight count can blow past 69labs' real
// per-account limit and earn a 403 / a 503 cooldown. 69labs allows only 1–4
// concurrent generations DEPENDING ON SUBSCRIPTION TIER, and exceeding the tier
// ceiling triggers cooldowns — see SIXTYNINE_IMAGE_CONCURRENCY (default 4).
//
// With a KEY POOL (two separate-account keys; see keyPool()), each key has its
// OWN semaphore so the two accounts run their tier limits IN PARALLEL: cluster
// concurrency is SIXTYNINE_IMAGE_CONCURRENCY × keys (e.g. 4 × 2 = 8). A single
// global counter (the old design) would have throttled both keys to ONE tier's
// worth of slots, throwing away the second account's capacity. Excess callers
// await a freed slot on THAT key (FIFO).
//
// Scope is per-process. Correct here because the burst that triggered the 403
// came from one worker running all three lanes at once, and we run ONE synthetic
// worker. With multiple worker machines the cap is per-machine, so the cluster
// total is limit × keys × machines — keep ONE synthetic worker, or size the cap
// so machines × cap stays within each tier's ceiling.
class KeySemaphore {
  private inUse = 0;
  private readonly waiters: Array<() => void> = [];
  async acquire(limit: number): Promise<void> {
    if (this.inUse < limit) {
      this.inUse++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.inUse++;
  }
  release(): void {
    this.inUse--;
    const next = this.waiters.shift();
    if (next) next();
  }
}

// NOTE: image generation no longer uses a per-process semaphore. Its concurrency
// is now bounded by the GLOBAL Redis per-account limiter (withAccountSlot in
// generateImage) so the cap holds across both worker machines. The per-process
// KeySemaphore below remains for TTS only.

// Separate per-key semaphores for TTS. 69labs meters TTS concurrency separately
// from image generation, so TTS gets its own slot pools (reusing the image
// per-key cap as a conservative ceiling) rather than sharing the image counters.
const ttsSemaphores = new Map<string, KeySemaphore>();
function ttsSemaphoreFor(key: string): KeySemaphore {
  let sem = ttsSemaphores.get(key);
  if (!sem) {
    sem = new KeySemaphore();
    ttsSemaphores.set(key, sem);
  }
  return sem;
}

// The ordered key pool: primary first, then the optional 2nd and 3rd named
// keys, then any extra keys from the SIXTYNINE_LABS_API_KEYS list. Empty values
// are filtered out and duplicates dropped, so a single configured key yields a
// 1-element pool (identical behavior to before — no parallelism, no failover).
// Each DISTINCT key gets its own SIXTYNINE_IMAGE_CONCURRENCY slot pool, so N
// separate-account keys run their tier limits in parallel (≈ N× throughput).
function keyPool(): string[] {
  const env = getEnv();
  const extra = (env.SIXTYNINE_LABS_API_KEYS || "")
    .split(/[\n,]/)
    .map((k) => k.trim());
  const seen = new Set<string>();
  const pool: string[] = [];
  for (const k of [
    env.SIXTYNINE_LABS_API_KEY,
    env.SIXTYNINE_LABS_API_KEY_BACKUP,
    env.SIXTYNINE_LABS_API_KEY_3,
    ...extra,
  ]) {
    const key = (k || "").trim();
    if (key.length > 0 && !seen.has(key)) {
      seen.add(key);
      pool.push(key);
    }
  }
  return pool;
}

// Round-robin cursor for balancing new generations across the key pool. A plain
// process-wide counter is enough: it just has to spread starts across keys, not
// be exact. Each lane reads-then-increments, so consecutive generations start on
// alternating keys.
let rrCursor = 0;
function nextKeyOrder(pool: string[]): string[] {
  if (pool.length <= 1) return pool;
  const start = rrCursor++ % pool.length;
  // Return the pool rotated so index `start` is first; the rest follow as
  // failover candidates in order.
  return [...pool.slice(start), ...pool.slice(0, start)];
}

function cfg() {
  const env = getEnv();
  if (!env.SIXTYNINE_LABS_API_KEY) {
    throw new Error("SIXTYNINE_LABS_API_KEY not configured (synthetic engine)");
  }
  // NOTE: the api key(s) are NOT returned here. Key selection (round-robin +
  // per-key failover across the pool) lives in keyPool()/nextKeyOrder() and is
  // passed explicitly to generateNanoBananaImage / generateVoiceWithKey. cfg()
  // only carries the non-secret request config. The check above still guarantees
  // a primary key is configured before any generation runs.
  return {
    base: env.SIXTYNINE_LABS_BASE_URL.replace(/\/$/, ""),
    ttsProvider: env.SIXTYNINE_LABS_TTS_PROVIDER,
    ttsModel: env.SIXTYNINE_LABS_TTS_MODEL,
    ttsPollTimeoutMs: env.SIXTYNINE_LABS_TTS_POLL_TIMEOUT_SECONDS * 1000,
    imageModel: env.SIXTYNINE_LABS_IMAGE_MODEL,
    imageResolution: env.SIXTYNINE_LABS_IMAGE_RESOLUTION,
    imagePollTimeoutMs: env.SIXTYNINE_LABS_IMAGE_POLL_TIMEOUT_SECONDS * 1000,
    defaultVoice: env.SIXTYNINE_LABS_DEFAULT_VOICE,
  };
}

export function isSixtyNineConfigured(): boolean {
  return Boolean(getEnv().SIXTYNINE_LABS_API_KEY);
}

export interface GenerateVoiceInput {
  text: string;
  voiceId?: string;     // 69labs voiceId; falls back to SIXTYNINE_LABS_DEFAULT_VOICE
  format?: "mp3";       // master_voiceover.mp3 per spec
}

export interface GenerateVoiceResult {
  audio: Buffer;
  contentType: string;
  chars: number;        // billing dimension for cost tracking
}

// 69labs TTS is an ASYNC JOB API (not a synchronous audio endpoint):
//   1. POST /api/v1/tts/generate          -> { id, status: "PENDING", queuePosition }
//   2. GET  /api/v1/tts/status/:jobId     -> PENDING|PROCESSING|FINALIZING|
//                                            COMPLETED|FAILED|CANCELLED|CENSORED
//   3. GET  /api/v1/tts/download/:jobId   -> the mp3 bytes (410 GONE if expired)
// We submit, poll to COMPLETED, then download. CENSORED/FAILED/CANCELLED are
// terminal errors surfaced to the caller (the job processor logs + retries).
type TtsStatus =
  | "PENDING" | "PROCESSING" | "FINALIZING"
  | "COMPLETED" | "FAILED" | "CANCELLED" | "CENSORED";

interface TtsStatusResponse {
  id: string;
  status: TtsStatus;
  chunksTotal?: number;
  chunksCompleted?: number;
  blockedChunks?: Array<{ index: number; text: string }>;
}

// Internal: one TTS run (submit→poll→download) with a SPECIFIC api key. The key
// is passed in (not read from cfg) so generateVoice can re-run this on the backup
// key when the primary hits a permanent auth 403 — mirroring generateImage.
async function generateVoiceWithKey(
  c: ReturnType<typeof cfg>,
  text: string,
  voiceId: string | undefined,
  key: string,
): Promise<GenerateVoiceResult> {
  const authJson = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  const authOnly = { Authorization: `Bearer ${key}` };

  // 1) Submit the job.
  const submit = await withHttpRetry("69labs.tts.submit", () =>
    fetchOrThrow(`${c.base}/api/v1/tts/generate`, {
      method: "POST",
      headers: authJson,
      body: JSON.stringify({
        text,
        voiceId: voiceId || c.defaultVoice,
        voiceProvider: c.ttsProvider,
        modelId: c.ttsModel,
      }),
      timeoutMs: 60_000,
    }),
  );
  const { id: jobId } = (await submit.json()) as { id: string; status: TtsStatus };
  if (!jobId) throw new Error("69labs tts: submit returned no job id");

  // 2) Poll status until COMPLETED (or a terminal failure / timeout).
  const deadline = Date.now() + c.ttsPollTimeoutMs;
  while (Date.now() < deadline) {
    // Wrap the poll in withHttpRetry: 69labs rate-limits the status endpoint by
    // request rate and returns 429 TOO_MANY_REQUESTS under load. A bare poll
    // would fail the whole job on a single 429; retry rides it out with backoff.
    const statusRes = await withHttpRetry("69labs.tts.status", () =>
      fetchOrThrow(`${c.base}/api/v1/tts/status/${jobId}`, {
        headers: authOnly,
        timeoutMs: 30_000,
      }),
    );
    const st = (await statusRes.json()) as TtsStatusResponse;
    if (st.status === "COMPLETED") break;
    if (st.status === "FAILED" || st.status === "CANCELLED") {
      throw new Error(`69labs tts: job ${st.status} (job ${jobId})`);
    }
    if (st.status === "CENSORED") {
      // Content moderation blocked one or more chunks. We surface this as a
      // hard error rather than auto-rewriting — the narration should be edited.
      const blocked = (st.blockedChunks ?? []).map((b) => b.index).join(",");
      throw new Error(`69labs tts: CENSORED (blocked chunks: ${blocked || "?"}) — edit the script and retry`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (Date.now() >= deadline) throw new Error(`69labs tts: poll timed out (job ${jobId})`);

  // 3) Download the finished mp3.
  const dl = await withHttpRetry("69labs.tts.download", () =>
    fetchOrThrow(`${c.base}/api/v1/tts/download/${jobId}`, {
      headers: authOnly,
      timeoutMs: 120_000,
    }),
  );
  const arrayBuf = await dl.arrayBuffer();
  return {
    audio: Buffer.from(arrayBuf),
    contentType: dl.headers.get("content-type") || "audio/mpeg",
    chars: text.length,
  };
}

/**
 * Generate a voiceover MP3 from transcript text via the 69labs job API.
 *
 * KEY-POOL ROUND-ROBIN + FAILOVER (mirrors generateImage): voiceover jobs are
 * load-balanced across the key pool with per-key TTS concurrency, so two
 * separate-account keys render in parallel. If the chosen key returns a
 * PERMANENT auth 403 ("Access denied" / FORBIDDEN — a revoked/blocked/expired
 * key), the run is retried on the next key in the pool. Any other error
 * (transient, poll timeout, censored, etc.) propagates unchanged — only a dead
 * key warrants hopping. When ALL keys are down past the retry budget, the call
 * throws and the job processor retries.
 */
export async function generateVoice(input: GenerateVoiceInput): Promise<GenerateVoiceResult> {
  const c = cfg();
  const text = input.text.trim();
  if (!text) throw new Error("generateVoice: empty text");
  const limit = getEnv().SIXTYNINE_IMAGE_CONCURRENCY;

  // Round-robin across the key pool with per-key concurrency, mirroring
  // generateImage: the first key is the load-balanced choice, the rest are
  // permanent-auth-403 failover targets. With two separate-account keys this runs
  // voiceover jobs on both accounts in parallel.
  const order = nextKeyOrder(keyPool());
  let lastErr: unknown;
  for (let i = 0; i < order.length; i++) {
    const key = order[i];
    await ttsSemaphoreFor(key).acquire(limit);
    try {
      return await generateVoiceWithKey(c, text, input.voiceId, key);
    } catch (err) {
      lastErr = err;
      const hasNext = i < order.length - 1;
      if (hasNext && isAuthForbidden(err)) {
        console.warn(
          JSON.stringify({
            msg: "69labs.tts.key_failover",
            note: "tts key returned a permanent auth 403; retrying on next key in pool",
            err: (err as Error).message?.slice(0, 200),
          }),
        );
        continue;
      }
      throw err;
    } finally {
      ttsSemaphoreFor(key).release();
    }
  }
  throw lastErr ?? new Error("generateVoice: no 69labs key configured");
}

// NOTE: 69labs has no documented voice-catalog endpoint — a voice is referenced
// by a specific voiceId the user supplies (e.g. Gr7mLjPA3HhuWxZidxPW), so there
// is no listVoices() here. The intake screen takes the voiceId as text input.

export interface GenerateImageResult {
  image: Buffer;
  contentType: string;
  // "sixtynine_image" for the primary nano-banana path; "fal_flux_image" when the
  // 69labs pool is exhausted and we fall back to fal.ai (see generateImage).
  provider: "sixtynine_image" | "fal_flux_image";
}

// Cross-attempt resume for 69labs image generation (the zombie-loop fix). When a
// prior BullMQ attempt submitted a generation but its poll timed out, the caller
// (imageGenProcessor) passes the recorded jobId + the key index it ran on so we
// RE-POLL that same generation instead of submitting a new one. onSubmit lets the
// caller persist a freshly-submitted (jobId, keyIdx) so the NEXT attempt can
// resume it. keyIdx indexes keyPool() (0 = primary), so a resume only re-polls
// the exact account the job was created on.
export interface ImageResume {
  jobId: string;
  keyIdx: number;
  onSubmit?: (jobId: string, keyIdx: number) => Promise<void> | void;
}

// 69labs image generation is an ASYNC JOB API (same lifecycle as TTS):
//   1. POST /api/v1/images/generate       -> { id, queuePosition }
//   2. GET  /api/v1/images/status/:jobId  -> PENDING|PROCESSING|...|COMPLETED|
//                                            FAILED|CANCELLED|CENSORED
//   3. GET  /api/v1/images/download/:jobId -> 302 redirect to a presigned R2
//                                             URL with the image bytes
// We submit, poll to COMPLETED, then download (fetch follows the 302 by default).
type ImageStatus = TtsStatus;

interface ImageStatusResponse {
  id: string;
  status: ImageStatus;
}

// Internal: one nano-banana attempt with a SPECIFIC api key. Returns the image
// bytes + content type. The key is passed in (not read from cfg) so generateImage
// can re-run this on the backup key when the primary hits a permanent auth 403.
async function generateNanoBananaImage(
  prompt: string,
  key: string,
  opts: {
    // A jobId from a PRIOR attempt on THIS key/account. When present we skip the
    // submit and RESUME polling that existing generation instead of creating a
    // new one — this is the zombie-loop fix. A poll timeout on attempt N leaves a
    // generation still running on 69labs' side; resubmitting on attempt N+1
    // stacks a SECOND generation on the same account and fills its 7-slot ceiling
    // (→ the chronic "Concurrent limit reached (7)" 403). Re-polling the SAME job
    // drains the account instead of filling it.
    resumeJobId?: string;
    // Called with the freshly-submitted jobId BEFORE polling begins, so the
    // caller can persist it and resume this exact generation on a retry.
    onSubmit?: (jobId: string) => Promise<void> | void;
  } = {},
): Promise<{ image: Buffer; contentType: string }> {
  const c = cfg();
  const authJson = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  const authOnly = { Authorization: `Bearer ${key}` };

  // 1) Submit the job — UNLESS we're resuming a prior attempt's generation on
  // this same account (opts.resumeJobId). 16:9 to match the synthetic canvas;
  // the renderer handles any cropping/letterboxing, so we request a wide aspect.
  //
  // SHORT submit retry budget (2 attempts, ~1s): the GLOBAL Redis limiter already
  // ensures we only submit while holding a real per-account slot, so a 403
  // "concurrent limit reached" here means 69labs' own count is full of
  // generations WE CAN'T CONTROL (zombies from a prior overload that timed out on
  // our side but keep running on theirs). Retrying in place for ~80s (the old
  // 5-attempt budget) just holds our slot doing nothing and delays the fal.ai
  // fallback by minutes. Fail fast so generateImage falls over to fal.ai quickly
  // instead of burning the retry budget on an account we can't unstick.
  let jobId: string;
  if (opts.resumeJobId) {
    jobId = opts.resumeJobId;
  } else {
    const submit = await withHttpRetry("69labs.image.submit", () =>
      fetchOrThrow(`${c.base}/api/v1/images/generate`, {
        method: "POST",
        headers: authJson,
        body: JSON.stringify({
          prompt,
          model: c.imageModel,
          aspectRatio: "16:9",
          // Request a higher resolution (1K/2K/4K, Nano Banana Pro) so stills are
          // sharp at the 1080p render. Omitted when the env value is empty so the
          // provider default applies. Field name per 69labs' generate contract.
          ...(c.imageResolution ? { resolution: c.imageResolution } : {}),
        }),
        timeoutMs: 60_000,
      }),
      { attempts: 2, baseMs: 1000 },
    );
    const parsed = (await submit.json()) as { id: string; queuePosition?: number };
    if (!parsed.id) throw new Error("69labs image: submit returned no job id");
    jobId = parsed.id;
    // Persist the jobId before polling so a poll-timeout retry resumes THIS
    // generation rather than submitting another and filling the account.
    if (opts.onSubmit) await opts.onSubmit(jobId);
  }

  // 2) Poll status until COMPLETED (or a terminal failure / timeout).
  //
  // The status GET does NOT count against the generation-concurrency cap, but
  // 69labs ALSO rate-limits this endpoint by REQUEST RATE and returns 429
  // {"error":"Too many requests","code":"TOO_MANY_REQUESTS"} when too many polls
  // arrive per minute. With several images in flight — each polling on its own
  // timer — plus TTS polling, a fixed 1s cadence blows past that budget. So:
  //   - wrap each poll in withHttpRetry so a 429/5xx/network blip is ridden out
  //     with backoff instead of failing the whole segment, and
  //   - use a 2s base cadence (up from 1s) to stay under the rate budget.
  const deadline = Date.now() + c.imagePollTimeoutMs;
  const pollIntervalMs = 2000;
  while (Date.now() < deadline) {
    // CRITICAL: a 429 on the STATUS endpoint must NOT fail a job that is still
    // generating. The status GET is rate-limited by request rate (separate from
    // the generation-concurrency cap), and with several jobs polling at once —
    // each also paying the backup-key failover round-trip — the combined poll
    // rate trips 429 {"code":"TOO_MANY_REQUESTS"}. The default 3-attempt retry
    // budget (~5s) gave up while the image was fine, BullMQ resubmitted a NEW
    // 69labs job, and the abandoned one kept holding a slot → the phantom
    // "concurrent limit reached (7)". So give the poll a budget that rides out
    // 429 for most of the poll window (8 attempts ≈ 1+3+9+27...s of backoff)
    // instead of failing a healthy generation on a transient rate-limit.
    // GLOBAL poll-rate gate (Redis token bucket). The status endpoint is rate-
    // limited by REQUEST RATE separately from generation; with many jobs polling
    // at once the combined rate tripped 429 "TOO_MANY_REQUESTS". Take a cluster-
    // wide token before each poll so total polls/sec stay under budget no matter
    // how many jobs are in flight. Blocks briefly when the bucket is empty.
    const env = getEnv();
    await acquirePollToken("image.status", env.SIXTYNINE_POLL_RATE_PER_SEC, env.SIXTYNINE_POLL_BURST);
    const statusRes = await withHttpRetry("69labs.image.status", () =>
      fetchOrThrow(`${c.base}/api/v1/images/status/${jobId}`, {
        headers: authOnly,
        timeoutMs: 30_000,
      }),
      { attempts: 8, baseMs: 1000 },
    );
    const st = (await statusRes.json()) as ImageStatusResponse;
    if (st.status === "COMPLETED") break;
    if (st.status === "FAILED" || st.status === "CANCELLED") {
      throw new Error(`69labs image: job ${st.status} (job ${jobId})`);
    }
    if (st.status === "CENSORED") {
      throw new Error(`69labs image: CENSORED (job ${jobId}) — edit the prompt and retry`);
    }
    // Jitter the cadence (±50%) so concurrent jobs don't lock-step their status
    // calls into a synchronized burst that trips the request-rate 429.
    await new Promise((r) => setTimeout(r, Math.round(pollIntervalMs * (0.75 + Math.random() * 0.5))));
  }
  if (Date.now() >= deadline) throw new Error(`69labs image: poll timed out (job ${jobId})`);

  // 3) Download the finished image. The endpoint returns a 302 redirect to a
  // presigned R2 URL; fetch follows redirects by default.
  const dl = await withHttpRetry("69labs.image.download", () =>
    fetchOrThrow(`${c.base}/api/v1/images/download/${jobId}`, {
      headers: authOnly,
      timeoutMs: 120_000,
    }),
  );
  return {
    image: Buffer.from(await dl.arrayBuffer()),
    contentType: dl.headers.get("content-type") || "image/png",
  };
}

/**
 * Generate an image from a base prompt via 69labs (nano-banana). The mandatory
 * STYLE_PROMPT is appended here so every caller gets the consistent look.
 *
 * 69labs is the ONLY image provider — there is no cross-provider fallback. Safe,
 * fast multi-image generation comes from three mechanisms:
 *   1. KEY-POOL ROUND-ROBIN + PER-KEY CONCURRENCY: each configured key (a
 *      separate account) gets its OWN slot pool (SIXTYNINE_IMAGE_CONCURRENCY per
 *      key), and new generations alternate across keys (nextKeyOrder). So two
 *      keys run their tier limits IN PARALLEL — a burst is bounded per account
 *      (no 403 "concurrent limit" / 503 cooldown) while total throughput ~2×s.
 *      A single key yields a 1-element pool: identical to the old single-key cap.
 *   2. generateNanoBananaImage's withHttpRetry rides out transient 503 "service
 *      unavailable" / 403 "concurrent limit" spikes with exponential backoff on
 *      the SAME key.
 *   3. KEY FAILOVER: when the chosen key returns a PERMANENT auth 403 ("Access
 *      denied" / FORBIDDEN — a revoked/blocked/expired key), the generation is
 *      retried on the NEXT key in the pool. The transient concurrent-limit 403 is
 *      NOT failover-worthy (mechanism 2 rides it out on the same key), so a busy
 *      key doesn't needlessly hop to the other.
 * When ALL keys are down past the retry budget, the call throws — the caller
 * (image processor) lets BullMQ retry the whole job, and the segment can be
 * re-run from the UI once 69labs recovers. The chosen provider is returned for
 * cost attribution (always "sixtynine_image").
 */
// A 69labs CENSORED (content-policy) failure. This must NOT trigger the fal.ai
// fallback: a content rejection would also be rejected by fal.ai, and the real
// fix is to edit the prompt (see the de-naming rule), not switch provider. Match
// the CENSORED reason text generateNanoBananaImage throws.
function isCensored(err: unknown): boolean {
  return /CENSORED/i.test((err as Error)?.message ?? "");
}

// Run the 69labs (nano-banana) pool: round-robin across keys, each under the
// GLOBAL per-account slot cap. Throws when every key is exhausted (all accounts
// down/blocked, persistent rate-limit, poll timeout). This is the PRIMARY path;
// generateImage wraps it with the fal.ai fallback.
async function generate69labsImage(
  prompt: string,
  resume?: ImageResume,
): Promise<GenerateImageResult> {
  // GLOBAL per-account cap (Redis-coordinated across both worker machines). The
  // old SIXTYNINE_IMAGE_CONCURRENCY was a per-PROCESS semaphore, so cap × machines
  // overshot 69labs' 7-per-account ceiling. withAccountSlot enforces the cap for
  // the WHOLE cluster and blocks (without holding anything) until a slot frees —
  // so many videos share the fixed slots fairly instead of stampeding to a 403.
  const cap = getEnv().SIXTYNINE_ACCOUNT_CONCURRENCY;
  const pool = keyPool();

  // RESUME PATH: a prior attempt already submitted a 69labs generation on a
  // specific account (resume.jobId + resume.keyIdx). Re-poll THAT job on THAT
  // key instead of round-robining a fresh submit — otherwise the retry stacks a
  // second generation on the account and fills its 7-slot ceiling (the zombie
  // loop). We only resume when a real jobId was recorded AND the recorded key
  // still exists in the pool; otherwise fall through to a normal round-robin
  // submit (onSubmit still fires so the fresh job is persisted for next time).
  const canResume =
    !!resume?.jobId && resume.keyIdx >= 0 && resume.keyIdx < pool.length;
  const order = canResume ? [pool[resume!.keyIdx]] : nextKeyOrder(pool);
  let lastErr: unknown;
  for (let i = 0; i < order.length; i++) {
    const key = order[i];
    const keyIdx = pool.indexOf(key);
    // Only pass the resume jobId when we're genuinely resuming AND on the exact
    // key it was submitted on. Otherwise this is a fresh submit.
    const resumeJobId = canResume && keyIdx === resume!.keyIdx ? resume!.jobId : undefined;
    try {
      // Hold a GLOBAL account slot for the whole submit→poll→download so each
      // account's cluster-wide in-flight image work stays under the real cap.
      const { image, contentType } = await withAccountSlot(accountIdFor(key), cap, () =>
        generateNanoBananaImage(prompt, key, {
          resumeJobId,
          onSubmit: resume?.onSubmit
            ? (jobId) => resume.onSubmit!(jobId, keyIdx)
            : undefined,
        }),
      );
      return { image, contentType, provider: "sixtynine_image" };
    } catch (err) {
      lastErr = err;
      // CENSORED is a content rejection — do NOT try other keys (every account
      // rejects it) and do NOT fall back to fal (see generateImage). Surface it.
      if (isCensored(err)) throw err;
      // Try the NEXT account on (a) a permanent auth 403 (dead key) OR (b) the
      // concurrent-limit 403 / poll timeout — another account may have a free
      // slot while this one is jammed by zombies. Each key now fails FAST (short
      // submit retry), so sweeping all 3 accounts costs seconds, not minutes.
      // When every account is exhausted, the loop throws and generateImage falls
      // over to fal.ai.
      const hasNext = i < order.length - 1;
      if (hasNext) {
        console.warn(
          JSON.stringify({
            msg: "69labs.image.key_failover",
            note: "image key unavailable (auth/limit/timeout); trying next account in pool",
            err: (err as Error).message?.slice(0, 200),
          }),
        );
        continue;
      }
      throw err;
    }
  }
  // Unreachable when the pool is non-empty (cfg() guarantees a primary), but
  // keeps the type checker happy and surfaces the real cause if it ever is.
  throw lastErr ?? new Error("generateImage: no 69labs key configured");
}

export async function generateImage(
  basePrompt: string,
  resume?: ImageResume,
): Promise<GenerateImageResult> {
  cfg(); // validates SIXTYNINE_LABS_API_KEY is configured (throws if not)
  const prompt = withStylePrompt(basePrompt);

  try {
    // The resume path re-polls a prior attempt's 69labs generation instead of
    // resubmitting (zombie-loop fix). Only the 69labs path resumes — the fal.ai
    // fallback below always submits fresh (it has no per-account concurrency wall).
    return await generate69labsImage(prompt, resume);
  } catch (err) {
    // fal.ai FALLBACK: 69labs failed past its retry budget / all accounts are
    // down or blocked. Fall back to fal.ai (FLUX) so a 69labs outage doesn't fail
    // the segment. EXCEPT on CENSORED — a content rejection would fail on fal.ai
    // too; the fix is to edit the prompt, not switch provider. Also skip if fal
    // isn't configured (then surface the original 69labs error).
    if (isCensored(err) || !isFalImageConfigured()) throw err;
    console.warn(
      JSON.stringify({
        msg: "69labs.image.fal_fallback",
        note: "69labs image pool exhausted; falling back to fal.ai FLUX",
        err: (err as Error).message?.slice(0, 200),
      }),
    );
    try {
      const out = await generateFalImage(prompt);
      return { image: out.image, contentType: out.contentType, provider: out.provider };
    } catch (falErr) {
      // Both providers failed. Surface a combined reason so the job log shows
      // WHY each one failed, not just the last.
      throw new Error(
        `image generation failed on both providers :: 69labs: ${(err as Error).message?.slice(0, 150)} :: fal.ai: ${(falErr as Error).message?.slice(0, 150)}`,
      );
    }
  }
}
