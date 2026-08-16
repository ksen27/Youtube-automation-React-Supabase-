import { getEnv } from "@/lib/env";
import {
  fetchOrThrow,
  withHttpRetry,
  isAuthForbidden,
  isAbortError,
  sleepUnlessAborted,
  HttpError,
} from "@/lib/synthetic/http";
import { withStylePrompt } from "@/lib/synthetic/constants";
import { withAccountSlot, acquirePollToken } from "@/lib/synthetic/rate-limit";
import {
  isAi33Configured,
  generateAi33Image,
  generateAi33Voice,
  isAi33Pointer,
  toAi33Pointer,
  fromAi33Pointer,
  AI33_STALE_RESUME,
} from "@/lib/synthetic/ai33";

// Stable per-account id for the Redis slot pool. The slot cap this feeds is
// enforced by 69labs PER ACCOUNT, not per key — so this id must identify the
// ACCOUNT, and two keys issued by the SAME account must map to the SAME id.
//
// The default (the key's short prefix — never the full secret, so the key value
// never lands in a Redis key name or a log) silently assumes one key = one
// account. That assumption breaks in BOTH directions:
//   - two keys from ONE account with different prefixes look like two accounts,
//     so the cluster hands out cap × 2 slots against a single real ceiling of 7
//     → chronic 403 "Concurrent image generation limit reached (7)" + cooldowns.
//     (Observed 2026-08-12: a dedicated CelebForge key issued from the same
//     account as the avatar key, giving 6 + 6 = 12 slots for a 7-slot account.)
//   - two keys from DIFFERENT accounts that share a prefix collapse into one
//     semaphore, wasting the second account's capacity.
// Neither is detectable from the key text, so account identity has to be
// DECLARED. Set SIXTYNINE_ACCOUNT_ID when every configured 69labs key belongs to
// one account: all keys then share one semaphore and the cap means what it says.
// Leave it unset only when the keys really are separate accounts.
function accountIdFor(key: string): string {
  const declared = (getEnv().SIXTYNINE_ACCOUNT_ID || "").trim();
  if (declared) return declared;
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
  // Which provider rendered the audio (ai33 is primary, 69labs the backup) —
  // used for cost attribution and so a failover is visible in the job log.
  provider: "sixtynine_tts" | "ai33_tts";
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
  // Provider-side reason on a FAILED job. 69labs is inconsistent about which
  // field carries it (images use userMessage), so read all three — a bare
  // "job FAILED (job <uuid>)" with the reason thrown away is undebuggable.
  userMessage?: string;
  error?: string;
  message?: string;
}

// The reason text off a status payload, if 69labs supplied one.
function ttsFailureReason(st: TtsStatusResponse): string {
  return (st.userMessage || st.error || st.message || "").trim();
}

// Cross-attempt resume for 69labs TTS — the same zombie-loop fix images already
// have (see ImageResume), added 2026-08-16 after a 30k-char voiceover blew the
// poll timeout at 603s while the provider job kept rendering. Without a resume
// pointer, BullMQ attempt N+1 POSTs /tts/generate again with IDENTICAL text +
// voice, and 69labs rejects it:
//   409 {"error":"A matching TTS job is already in progress.",
//        "code":"DUPLICATE_TTS_IN_PROGRESS"}
// Every remaining attempt then 409s in ~300ms, the job dies, and the project is
// LOCKED OUT until the provider-side render ages out — even though the audio was
// rendering fine the whole time. Recording (jobId, keyIdx) on submit lets the
// retry RE-POLL that exact render instead of colliding with it.
export interface VoiceResume {
  // The 69labs job id recorded by a PRIOR attempt, if any.
  jobId?: string;
  // Index into keyPool() of the key that job was submitted on (0 = primary).
  // -1 when unknown; resume only happens when this still addresses a live key,
  // since a TTS job is only visible to the account that created it.
  keyIdx: number;
  // Called with a freshly-submitted (jobId, keyIdx) BEFORE polling begins so the
  // caller can persist it and resume this exact render on the next attempt.
  onSubmit?: (jobId: string, keyIdx: number) => Promise<void> | void;
}

// True for 69labs' duplicate-submit rejection. Terminal for the attempt: the
// text is ALREADY rendering on that account, so retrying the submit collides
// again. The cure is to resume the in-flight job (VoiceResume), not to retry.
export function isDuplicateTtsInProgress(err: unknown): boolean {
  const text = err instanceof HttpError ? (err.body ?? err.message) : ((err as Error)?.message ?? "");
  return /DUPLICATE_TTS_IN_PROGRESS|matching TTS job is already in progress/i.test(text);
}

// A recorded resume pointer that 69labs no longer knows about (job expired or
// was swept). Internal: generateVoiceWithKey raises it so the caller can drop
// the stale pointer and fall through to a normal fresh submit, rather than
// failing the job forever on an id that will never resolve.
const STALE_RESUME = "69labs tts: recorded job no longer exists";

// Internal: one TTS run (submit→poll→download) with a SPECIFIC api key. The key
// is passed in (not read from cfg) so generateVoice can re-run this on the backup
// key when the primary hits a permanent auth 403 — mirroring generateImage.
async function generateVoiceWithKey(
  c: ReturnType<typeof cfg>,
  text: string,
  voiceId: string | undefined,
  key: string,
  opts: { resumeJobId?: string; onSubmit?: (jobId: string) => Promise<void> | void } = {},
): Promise<GenerateVoiceResult> {
  const authJson = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  const authOnly = { Authorization: `Bearer ${key}` };

  // 1) Submit the job — UNLESS a prior attempt already submitted this exact
  // render on this account (opts.resumeJobId), in which case we skip straight to
  // polling it. Resubmitting is what earns the 409 DUPLICATE_TTS_IN_PROGRESS.
  let jobId: string;
  if (opts.resumeJobId) {
    jobId = opts.resumeJobId;
    // Probe the recorded job before committing to the poll loop. Two ways a
    // pointer can be dead, and BOTH must fall through to a fresh submit:
    //   - 404/410: the job expired or was swept.
    //   - 200 with a TERMINAL status: the render already FAILED/CANCELLED. This
    //     is the common one — 69labs fails a render, we record the id, and every
    //     later attempt would re-poll that corpse and re-throw "job FAILED"
    //     instantly, never resubmitting. That turns a one-off provider failure
    //     into a permanent dead project, which is the same class of lockout the
    //     resume pointer exists to prevent.
    // CENSORED is the exception: a resubmit of the same text is censored again,
    // so surface it rather than paying for a guaranteed second refusal.
    try {
      const probe = await withHttpRetry("69labs.tts.resume_probe", () =>
        fetchOrThrow(`${c.base}/api/v1/tts/status/${jobId}`, { headers: authOnly, timeoutMs: 30_000 }),
      );
      const st = (await probe.json()) as TtsStatusResponse;
      if (st.status === "CENSORED") {
        const blocked = (st.blockedChunks ?? []).map((b) => b.index).join(",");
        throw new Error(`69labs tts: CENSORED (blocked chunks: ${blocked || "?"}) — edit the script and retry`);
      }
      if (st.status === "FAILED" || st.status === "CANCELLED") {
        throw new Error(`${STALE_RESUME} (job ${jobId} is ${st.status})`);
      }
      console.log(
        JSON.stringify({
          msg: "69labs.tts.resume",
          note: "re-polling the TTS job submitted by a prior attempt instead of resubmitting",
          jobId,
          status: st.status,
        }),
      );
    } catch (e) {
      if (e instanceof HttpError && (e.status === 404 || e.status === 410)) {
        throw new Error(`${STALE_RESUME} (job ${jobId})`);
      }
      throw e;
    }
  } else {
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
    const parsed = (await submit.json()) as { id: string; status: TtsStatus };
    if (!parsed.id) throw new Error("69labs tts: submit returned no job id");
    jobId = parsed.id;
    // Persist BEFORE polling so a poll-timeout retry resumes THIS render rather
    // than colliding with it.
    if (opts.onSubmit) await opts.onSubmit(jobId);
  }

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
      const reason = ttsFailureReason(st);
      throw new Error(
        `69labs tts: job ${st.status} (job ${jobId})${reason ? ` — ${reason}` : ""}` +
          `${st.chunksTotal ? ` [chunks ${st.chunksCompleted ?? 0}/${st.chunksTotal}]` : ""}`,
      );
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
    provider: "sixtynine_tts",
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
async function generate69labsVoice(
  input: GenerateVoiceInput,
  resume?: VoiceResume,
): Promise<GenerateVoiceResult> {
  const c = cfg();
  const text = input.text.trim();
  if (!text) throw new Error("generateVoice: empty text");
  const limit = getEnv().SIXTYNINE_IMAGE_CONCURRENCY;

  // RESUME PATH: a prior attempt already submitted this render on a specific
  // account. Re-poll THAT job on THAT key — a fresh round-robin submit would
  // either collide with it (409 DUPLICATE_TTS_IN_PROGRESS on the same account)
  // or pay a second time for identical audio on another one. Falls through to a
  // normal round-robin submit when the recorded key is no longer in the pool.
  const pool = keyPool();
  const canResume = !!resume?.jobId && resume.keyIdx >= 0 && resume.keyIdx < pool.length;
  const order = canResume ? [pool[resume!.keyIdx]] : nextKeyOrder(pool);
  let lastErr: unknown;
  for (let i = 0; i < order.length; i++) {
    const key = order[i];
    const keyIdx = pool.indexOf(key);
    const resumeJobId = canResume && keyIdx === resume!.keyIdx ? resume!.jobId : undefined;
    await ttsSemaphoreFor(key).acquire(limit);
    try {
      return await generateVoiceWithKey(c, text, input.voiceId, key, {
        resumeJobId,
        onSubmit: resume?.onSubmit ? (jobId) => resume.onSubmit!(jobId, keyIdx) : undefined,
      });
    } catch (err) {
      lastErr = err;
      // The recorded resume pointer is dead (job expired/swept on 69labs' side).
      // Drop it and retry this same key with a FRESH submit — the duplicate
      // guard has nothing to collide with once the old render is gone.
      if (new RegExp(STALE_RESUME, "i").test((err as Error)?.message ?? "")) {
        console.warn(
          JSON.stringify({
            msg: "69labs.tts.resume_stale",
            note: "recorded tts job no longer exists; submitting a fresh render",
            err: (err as Error).message?.slice(0, 200),
          }),
        );
        // Reuse the slot we already hold — the outer `finally` releases it once.
        return await generateVoiceWithKey(c, text, input.voiceId, key, {
          onSubmit: resume?.onSubmit ? (jobId) => resume.onSubmit!(jobId, keyIdx) : undefined,
        });
      }
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

/**
 * Generate a voiceover MP3 — ai33.pro PRIMARY, 69labs BACKUP (client direction
 * 2026-08-16).
 *
 * The stored voice id needs no migration: project rows hold BARE ElevenLabs ids
 * (what 69labs takes), and ai33 serves the same ElevenLabs catalogue under
 * `elevenlabs_<id>`, which normalizeAi33VoiceId adds on the way out. So the two
 * providers render the SAME voice and a failover is inaudible.
 *
 * Resume pointers are provider-tagged (see AI33_KEY_IDX / isAi33Pointer), so a
 * retry re-polls the render its own provider actually started instead of
 * submitting a duplicate — the 409 DUPLICATE_TTS_IN_PROGRESS lockout that the
 * 69labs resume path exists to prevent.
 */
export async function generateVoice(
  input: GenerateVoiceInput,
  resume?: VoiceResume,
): Promise<GenerateVoiceResult> {
  const resumeIsAi33 = isAi33Pointer(resume?.jobId);
  const resumeIsSixtyNine = Boolean(resume?.jobId) && !resumeIsAi33;

  const providers: Array<"ai33" | "sixtynine"> = [];
  if (isAi33Configured()) providers.push("ai33");
  if (isSixtyNineConfigured()) providers.push("sixtynine");
  // An in-flight 69labs render is already paid for and may be nearly done — go
  // back to it before starting a fresh one anywhere else.
  if (resumeIsSixtyNine && providers.length > 1 && providers[0] === "ai33") providers.reverse();
  if (providers.length === 0) {
    throw new Error("SIXTYNINE_LABS_API_KEY not configured (synthetic engine)");
  }

  let lastErr: unknown;
  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i];
    try {
      if (provider === "ai33") {
        const onSubmit = resume?.onSubmit
          ? (taskId: string) => resume.onSubmit!(toAi33Pointer(taskId), AI33_KEY_IDX)
          : undefined;
        const resumeTaskId = fromAi33Pointer(resume?.jobId);
        try {
          const out = await generateAi33Voice(input, {
            resumeTaskId: resumeTaskId || undefined,
            onSubmit,
          });
          return { ...out, provider: "ai33_tts" };
        } catch (err) {
          // A dead pointer must not fail the voiceover forever — drop it and
          // render fresh (same contract as the 69labs stale-resume path).
          if (resumeTaskId && new RegExp(AI33_STALE_RESUME, "i").test((err as Error)?.message ?? "")) {
            console.warn(
              JSON.stringify({
                msg: "ai33.tts.resume_stale",
                note: "recorded ai33 task no longer exists; submitting a fresh render",
                err: (err as Error).message?.slice(0, 200),
              }),
            );
            const out = await generateAi33Voice(input, { onSubmit });
            return { ...out, provider: "ai33_tts" };
          }
          throw err;
        }
      }
      // 69labs only understands its own resume pointers.
      return await generate69labsVoice(
        input,
        resumeIsAi33 ? { ...resume!, jobId: undefined, keyIdx: -1 } : resume,
      );
    } catch (err) {
      lastErr = err;
      // A moderation refusal is about the SCRIPT, not the vendor — every
      // provider blocks the same text, so re-rendering elsewhere just spends
      // money to fail again. The script has to be edited.
      if (/CENSORED|moderation|content polic/i.test((err as Error)?.message ?? "")) throw err;
      const hasNext = i < providers.length - 1;
      if (hasNext) {
        console.warn(
          JSON.stringify({
            msg: "tts.provider_failover",
            note: `${provider} tts failed; falling over to ${providers[i + 1]}`,
            from: provider,
            to: providers[i + 1],
            err: (err as Error).message?.slice(0, 300),
          }),
        );
        continue;
      }
      throw err;
    }
  }
  throw lastErr ?? new Error("generateVoice: no tts provider configured");
}

// NOTE: 69labs has no documented voice-catalog endpoint — a voice is referenced
// by a specific voiceId the user supplies (e.g. Gr7mLjPA3HhuWxZidxPW), so there
// is no listVoices() here. The intake screen takes the voiceId as text input.

export interface GenerateImageResult {
  image: Buffer;
  contentType: string;
  // Which provider actually produced the image, for cost attribution and so the
  // logs show a failover plainly.
  //
  // "ai33_image" was added 2026-08-16 when ai33.pro became the PRIMARY provider
  // and 69labs the backup. This is NOT a return to the old silent Gemini/fal.ai
  // fallback chain that was removed on 2026-08-15: that chain swapped in a
  // DIFFERENT MODEL (FLUX) whose output looked nothing like the house style, so
  // an outage showed up as an unexplained quality regression instead of a
  // failure. Both providers here run gpt-image-2, so a failover changes the
  // vendor and nothing the viewer can see.
  //
  // cost.ts still knows "gemini_image" / "fal_flux_image" because historical job
  // rows recorded them; nothing NEW can produce those values.
  provider: "sixtynine_image" | "ai33_image";
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
  // Present on FAILED jobs. Carries provider-side moderation refusals, which
  // 69labs surfaces as FAILED rather than CENSORED — see the poll loop.
  userMessage?: string;
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
    // Per-call model/resolution override (CelebForge uses gpt-image-2 for real
    // celebrity likeness; the synthetic engine stays on nano-banana). Omitted =
    // the SIXTYNINE_LABS_IMAGE_MODEL / _RESOLUTION env defaults.
    model?: string;
    // "" (empty string) deliberately OMITS the resolution field — required for
    // models that expose qualityOptions instead of a resolutions[] array, which
    // 400 when sent `resolution`. Distinct from undefined (= use env default).
    resolution?: string;
    // Caller cancellation. When this aborts we stop polling and return
    // immediately, which is what lets the CALLER's slot be released instead of
    // being held by a generation nobody is waiting for (see generate69labsImage).
    signal?: AbortSignal;
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
  // 5-attempt budget) just holds our slot doing nothing. Fail fast so the key
  // failover can try another account, instead of burning the retry budget on one
  // we can't unstick. (Before 2026-08-15 the thing being hurried along was the
  // fal.ai fallback; that is gone, but failing fast still matters for failover.)
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
          model: opts.model || c.imageModel,
          aspectRatio: "16:9",
          // Request a higher resolution (1K/2K/4K, Nano Banana Pro) so stills are
          // sharp at the 1080p render. Omitted when the value is empty so the
          // provider default applies. Field name per 69labs' generate contract.
          // opts.resolution === "" means "omit" (see the option's doc comment).
          ...(() => {
            const res = opts.resolution !== undefined ? opts.resolution : c.imageResolution;
            return res ? { resolution: res } : {};
          })(),
        }),
        timeoutMs: 60_000,
        signal: opts.signal,
      }),
      { attempts: 2, baseMs: 1000, signal: opts.signal },
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
  // 5s cadence (was 2s). The status endpoint's rate limit is PER API KEY and
  // separate from the generation tier: on the single mega account (2026-07-22)
  // the whole cluster's polls land on one key, so demand must be a fraction of
  // what the 3-key pool sustained. Images take ~40s+ on this tier — a 5s tick
  // adds negligible latency while cutting poll demand by 60%.
  const pollIntervalMs = 5000;
  while (Date.now() < deadline) {
    // The caller gave up (its own generation deadline expired). Stop polling at
    // once so the account slot held around this call is released NOW rather than
    // at the 300s provider poll timeout — the slot-starvation cascade fix.
    if (opts.signal?.aborted) {
      throw opts.signal.reason ?? new Error(`69labs image: aborted (job ${jobId})`);
    }
    // CRITICAL: a 429 on the STATUS endpoint must NOT fail a job that is still
    // generating — and must not STALL the lane either. The old strategy (8
    // withHttpRetry attempts, exponential backoff to ~12 min) parked every
    // in-flight job in escalating sleeps during a sustained 429 window, which
    // read as "generation stopped" (2026-07-22 mega-cutover storm). Strategy
    // now: the retry budget handles transient 5xx/network blips only (3
    // attempts), and a 429 that survives it is treated as a MISSED TICK — wait
    // one cadence and poll again, bounded by the overall deadline. A healthy
    // generation is never failed or back-off-parked because the poll window is
    // momentarily full.
    const env = getEnv();
    // The token is taken INSIDE the retried closure so every attempt — retries
    // included — pays the global rate gate. With it outside (the same storm),
    // a 429'd poll's retries hit the endpoint UNTHROTTLED and kept the 429s
    // alive long after the bucket had drained.
    let statusRes: Awaited<ReturnType<typeof fetchOrThrow>>;
    try {
      statusRes = await withHttpRetry("69labs.image.status", async () => {
        await acquirePollToken("image.status", env.SIXTYNINE_POLL_RATE_PER_SEC, env.SIXTYNINE_POLL_BURST);
        return fetchOrThrow(`${c.base}/api/v1/images/status/${jobId}`, {
          headers: authOnly,
          timeoutMs: 30_000,
          signal: opts.signal,
        });
      },
        { attempts: 3, baseMs: 1000, signal: opts.signal },
      );
    } catch (e) {
      // An abort is the caller cancelling, not a missed tick — surface it.
      if (isAbortError(e) || opts.signal?.aborted) throw e;
      if (/-> 429/.test((e as Error).message ?? "")) {
        await sleepUnlessAborted(
          Math.round(pollIntervalMs * (0.75 + Math.random() * 0.5)),
          opts.signal,
        );
        continue;
      }
      throw e;
    }
    const st = (await statusRes.json()) as ImageStatusResponse;
    if (st.status === "COMPLETED") break;
    if (st.status === "FAILED" || st.status === "CANCELLED") {
      // A provider-side MODERATION refusal arrives as FAILED — not CENSORED —
      // with the reason only in userMessage (verified 2026-08-10 on gpt-image-2:
      // "This image request was blocked by the model's safety checks."). Without
      // this branch such a job looks like a transient failure, so the key-failover
      // loop sweeps every account — minutes of paid calls that CANNOT succeed,
      // since every account refuses the same content. Re-label it as CENSORED so
      // isCensored() short-circuits the sweep.
      const userMessage = (st as { userMessage?: string }).userMessage ?? "";
      if (/safety check|blocked by|restricted content|content polic/i.test(userMessage)) {
        throw new Error(`69labs image: CENSORED (job ${jobId}) — ${userMessage}`);
      }
      throw new Error(
        `69labs image: job ${st.status} (job ${jobId})${userMessage ? ` — ${userMessage}` : ""}`,
      );
    }
    if (st.status === "CENSORED") {
      throw new Error(`69labs image: CENSORED (job ${jobId}) — edit the prompt and retry`);
    }
    // Jitter the cadence (±50%) so concurrent jobs don't lock-step their status
    // calls into a synchronized burst that trips the request-rate 429.
    await sleepUnlessAborted(
      Math.round(pollIntervalMs * (0.75 + Math.random() * 0.5)),
      opts.signal,
    );
  }
  if (Date.now() >= deadline) throw new Error(`69labs image: poll timed out (job ${jobId})`);

  // 3) Download the finished image. The endpoint returns a 302 redirect to a
  // presigned R2 URL; fetch follows redirects by default.
  const dl = await withHttpRetry("69labs.image.download", () =>
    fetchOrThrow(`${c.base}/api/v1/images/download/${jobId}`, {
      headers: authOnly,
      timeoutMs: 120_000,
      signal: opts.signal,
    }),
    { signal: opts.signal },
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
// A 69labs CENSORED (content-policy) failure. This must NOT trigger the KEY
// FAILOVER sweep: every account rejects the same content, so trying the next one
// just spends money to fail again. The real fix is to edit the prompt (see the
// de-naming rule). Match the CENSORED reason text generateNanoBananaImage throws.
function isCensored(err: unknown): boolean {
  const text = (err as Error)?.message ?? "";
  // 69labs labels it CENSORED (or reports a moderation refusal as FAILED with a
  // safety userMessage, which generateNanoBananaImage re-labels). ai33 surfaces
  // the same class of refusal as a task `error` whose error_message carries the
  // model's safety text — match that too, so a refusal doesn't send the image
  // round the provider list to be refused again by the same model.
  return /CENSORED|safety check|blocked by the model|content polic|moderation/i.test(text);
}

// The caller's own per-image generation deadline expired (generationTimeoutMs).
// Distinct from 69labs' internal poll timeout: it means WE ran out of patience,
// so hopping to the next account or falling back to another provider would only
// spend more of a budget that is already gone. Terminal — surface it.
const DEADLINE_MSG = "image generation deadline exceeded";
export function isGenerationDeadline(err: unknown): boolean {
  return new RegExp(DEADLINE_MSG, "i").test((err as Error)?.message ?? "");
}

// Run the 69labs (nano-banana) pool: round-robin across keys, each under the
// GLOBAL per-account slot cap. Throws when every key is exhausted (all accounts
// down/blocked, persistent rate-limit, poll timeout). This is the ONLY path —
// generateImage is a thin wrapper over it and no longer catches its errors.
async function generate69labsImage(
  prompt: string,
  resume?: ImageResume,
  modelOpts: {
    model?: string;
    resolution?: string;
    generationTimeoutMs?: number;
    acquireTimeoutMs?: number;
    apiKey?: string;
  } = {},
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
  // PINNED KEY: the caller supplied the exact key to use (CelebForge pins its
  // dedicated gpt-image-2 key). Round-robin is wrong there — it would send half
  // the celebrity stills out on the avatar's key, which may not be entitled to
  // the same model, and half the avatar's images out on the celebrity key. A
  // pinned key is used ALONE, with no failover: the point of pinning is that the
  // other keys are not interchangeable for this call.
  const pinned = (modelOpts.apiKey || "").trim();
  const canResume =
    !pinned && !!resume?.jobId && resume.keyIdx >= 0 && resume.keyIdx < pool.length;
  const order = pinned
    ? [pinned]
    : canResume
      ? [pool[resume!.keyIdx]]
      : nextKeyOrder(pool);
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
      //
      // The caller's generation deadline is armed INSIDE this callback — i.e.
      // only once the slot is actually held. Charging slot-wait to the per-image
      // budget is what made every celeb still die at exactly its timeout without
      // ever reaching 69labs: with the lanes oversubscribed against the account
      // cap, the whole budget was spent in withAccountSlot's acquire loop.
      // Slot-wait is bounded separately by acquireTimeoutMs.
      const { image, contentType } = await withAccountSlot(
        accountIdFor(key),
        cap,
        async () => {
          const ac = new AbortController();
          const ms = modelOpts.generationTimeoutMs;
          const timer = ms
            ? setTimeout(
                () => ac.abort(new Error(`69labs image: ${DEADLINE_MSG} after ${ms}ms`)),
                ms,
              )
            : undefined;
          // unref so a pending timer never holds the worker process open.
          timer?.unref?.();
          try {
            return await generateNanoBananaImage(prompt, key, {
              resumeJobId,
              onSubmit: resume?.onSubmit
                ? (jobId) => resume.onSubmit!(jobId, keyIdx)
                : undefined,
              model: modelOpts.model,
              resolution: modelOpts.resolution,
              signal: ms ? ac.signal : undefined,
            });
          } catch (e) {
            // Normalise every downstream shape OUR abort can take (the poll-loop
            // check, a fetch AbortError, a rejected backoff sleep) into one
            // recognisable deadline error the key-failover loop treats as
            // terminal. Keyed strictly on ac.signal.aborted, never on
            // isAbortError(e): fetchOrThrow's own per-request timeouts also raise
            // AbortError, and mislabelling one of those as a caller deadline
            // would wrongly suppress the failover that should ride it out.
            if (ac.signal.aborted) {
              throw ac.signal.reason instanceof Error
                ? ac.signal.reason
                : new Error(`69labs image: ${DEADLINE_MSG} after ${ms}ms`);
            }
            throw e;
          } finally {
            if (timer) clearTimeout(timer);
          }
        },
        { acquireTimeoutMs: modelOpts.acquireTimeoutMs },
      );
      return { image, contentType, provider: "sixtynine_image" };
    } catch (err) {
      lastErr = err;
      // CENSORED is a content rejection — do NOT try other keys (every account
      // rejects it) and do NOT fall back to fal (see generateImage). Surface it.
      if (isCensored(err)) throw err;
      // Our own generation deadline expired — do NOT sweep the remaining
      // accounts. The budget that would pay for the next attempt is already
      // spent, so a failover here just multiplies the stall by the pool size.
      if (isGenerationDeadline(err)) throw err;
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

/**
 * Options for callers that are NOT the synthetic engine. Defaults keep
 * generateImage byte-identical to its previous behaviour.
 */
export interface GenerateImageOptions {
  // Skip the mandatory synthetic STYLE_PROMPT ("amateur smartphone photo …
  // slightly low quality"). That look is deliberate for the AI Avatar product
  // but wrong for CelebForge, whose stills are intercut with real broadcast
  // footage and must read as press photography. When true, basePrompt is sent
  // verbatim — the caller owns the whole prompt including its own style.
  rawPrompt?: boolean;
  // Per-call model / resolution override (see generateNanoBananaImage opts).
  model?: string;
  resolution?: string;
  // Wall clock for ONE generation (submit → poll → download), measured from the
  // moment the per-account slot is held — NOT from the call, so time spent
  // queueing for a slot is not charged to it. On expiry the poll is ABORTED and
  // the slot released immediately, instead of being held to the provider's own
  // 300s poll timeout for an image no one will read. Omitted = no caller
  // deadline (the provider poll timeout is the only bound, as before).
  generationTimeoutMs?: number;
  // Cap on how long to WAIT for a free per-account slot before giving up.
  // Defaults to withAccountSlot's own 5 min.
  acquireTimeoutMs?: number;
  // Use EXACTLY this 69labs key instead of round-robining the pool, and do not
  // fail over to the others. For a caller whose key is provisioned differently
  // from the rest (CelebForge's gpt-image-2 key), the pool's keys are not
  // interchangeable, so spreading its calls across them is a correctness bug,
  // not load balancing. The key still shares its ACCOUNT's slot cap — see
  // accountIdFor / SIXTYNINE_ACCOUNT_ID.
  apiKey?: string;
}

// Sentinel keyIdx persisted alongside an ai33 resume pointer. The pointer's
// "ai33:" prefix is what actually identifies the provider (see isAi33Pointer);
// this value only has to stay OUT of the 69labs key-pool index range so the
// 69labs resume guards (`keyIdx >= 0 && < pool.length`) reject it on sight.
const AI33_KEY_IDX = -2;

/**
 * Run ONE ai33 generation, transparently recovering from a dead resume pointer.
 * A recorded task that ai33 no longer knows about must not fail the image
 * forever, so a STALE pointer falls through to a fresh submit — the same
 * contract the 69labs resume path has.
 */
async function generateAi33ImageWithResume(
  prompt: string,
  resume: ImageResume | undefined,
  modelOpts: { model?: string; generationTimeoutMs?: number; acquireTimeoutMs?: number },
): Promise<GenerateImageResult> {
  // NOTE: the caller's `resolution` is deliberately NOT forwarded. It is spelled
  // for 69labs (lowercase "1k"); ai33 wants "2K" and 422s on the other form, so
  // ai33 always uses its own AI33_IMAGE_RESOLUTION / AI33_IMAGE_QUALITY.
  const onSubmit = resume?.onSubmit
    ? (taskId: string) => resume.onSubmit!(toAi33Pointer(taskId), AI33_KEY_IDX)
    : undefined;
  const opts = { ...modelOpts, onSubmit };

  const resumeTaskId = fromAi33Pointer(resume?.jobId);
  try {
    const out = await generateAi33Image(prompt, { ...opts, resumeTaskId: resumeTaskId || undefined });
    return { ...out, provider: "ai33_image" };
  } catch (err) {
    if (resumeTaskId && new RegExp(AI33_STALE_RESUME, "i").test((err as Error)?.message ?? "")) {
      console.warn(
        JSON.stringify({
          msg: "ai33.image.resume_stale",
          note: "recorded ai33 task no longer exists; submitting a fresh generation",
          err: (err as Error).message?.slice(0, 200),
        }),
      );
      const out = await generateAi33Image(prompt, opts);
      return { ...out, provider: "ai33_image" };
    }
    throw err;
  }
}

export async function generateImage(
  basePrompt: string,
  resume?: ImageResume,
  options: GenerateImageOptions = {},
): Promise<GenerateImageResult> {
  const prompt = options.rawPrompt ? basePrompt : withStylePrompt(basePrompt);
  const modelOpts = {
    model: options.model,
    resolution: options.resolution,
    generationTimeoutMs: options.generationTimeoutMs,
    acquireTimeoutMs: options.acquireTimeoutMs,
    apiKey: options.apiKey,
  };

  // ---------------------------------------------------------------------
  // PROVIDER ORDER (client direction 2026-08-16): ai33.pro PRIMARY, 69labs
  // BACKUP. Both run gpt-image-2, so a failover changes the vendor and nothing
  // the viewer can see — which is the condition that makes a fallback chain
  // safe here at all (the 2026-08-15 removal of the Gemini/fal.ai chain was
  // about a fallback that silently swapped in a DIFFERENT-LOOKING model; see
  // GenerateImageResult.provider).
  //
  // Two cases deliberately do NOT lead with ai33:
  //   - A PINNED 69labs key (CelebForge). Pinning exists because that key is
  //     provisioned differently from the pool; sending its stills elsewhere
  //     would ignore the caller's whole reason for pinning.
  //   - A 69labs RESUME pointer. That generation is already paid for and may
  //     be seconds from finishing, so re-polling it beats starting fresh
  //     elsewhere. ai33 stays available behind it if the resume fails.
  // ---------------------------------------------------------------------
  const pinnedSixtyNine = Boolean(options.apiKey?.trim());
  const resumeIsAi33 = isAi33Pointer(resume?.jobId);
  const resumeIsSixtyNine = Boolean(resume?.jobId) && !resumeIsAi33;

  const providers: Array<"ai33" | "sixtynine"> = [];
  if (isAi33Configured() && !pinnedSixtyNine) providers.push("ai33");
  if (isSixtyNineConfigured()) providers.push("sixtynine");
  // A 69labs resume pointer jumps 69labs to the front (see above).
  if (resumeIsSixtyNine && providers.length > 1 && providers[0] === "ai33") providers.reverse();
  if (providers.length === 0) {
    // Preserves the old error text for an unconfigured engine.
    throw new Error("SIXTYNINE_LABS_API_KEY not configured (synthetic engine)");
  }

  let lastErr: unknown;
  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i];
    try {
      if (provider === "ai33") {
        return await generateAi33ImageWithResume(prompt, resume, modelOpts);
      }
      // 69labs only understands its OWN resume pointers; an ai33 one would be
      // submitted as a job id it has never seen.
      return await generate69labsImage(
        prompt,
        resumeIsAi33 ? { ...resume!, jobId: "", keyIdx: -1 } : resume,
        modelOpts,
      );
    } catch (err) {
      lastErr = err;
      // A content refusal is decided by the MODEL, and both providers serve the
      // same one — trying the other just pays to be refused again. Terminal.
      if (isCensored(err)) throw err;
      // Our own generation deadline is already spent; a second provider would
      // only multiply the stall.
      if (isGenerationDeadline(err)) throw err;
      const hasNext = i < providers.length - 1;
      if (hasNext) {
        console.warn(
          JSON.stringify({
            msg: "image.provider_failover",
            note: `${provider} image generation failed; falling over to ${providers[i + 1]}`,
            from: provider,
            to: providers[i + 1],
            err: (err as Error).message?.slice(0, 300),
          }),
        );
        continue;
      }
      throw err;
    }
  }
  throw lastErr ?? new Error("generateImage: no image provider configured");
}
