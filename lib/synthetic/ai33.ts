import { getEnv } from "@/lib/env";
import {
  fetchOrThrow,
  withHttpRetry,
  isAbortError,
  sleepUnlessAborted,
  HttpError,
} from "@/lib/synthetic/http";
import { withAccountSlot } from "@/lib/synthetic/rate-limit";

// ai33.pro (OpenSpeaker) provider — PRIMARY image generation + TTS voiceover.
//
// Client direction 2026-08-16: ai33.pro primary, 69labs backup, gpt-image-2 on
// both. The orchestration (which provider runs first, and the failover between
// them) lives in lib/synthetic/sixtynine-labs.ts — generateImage/generateVoice
// there are still the ONLY entry points every caller uses. This module is just
// the wire layer for one provider.
//
// Wire contract, verified live on 2026-08-16 (their /app/api-document page 403s
// to non-browser clients, so this was read out of the app bundle and then each
// call was exercised against the real API):
//
//   auth      xi-api-key: <key>          NOT `Authorization: Bearer <key>`
//   images    POST /v1i/task/generate-image   multipart  -> { success, task_id }
//   tts       POST /v3/text-to-speech         multipart  -> { success, task_id }
//   poll      GET  /v1/task/:task_id  -> { status: doing|done|error, metadata }
//   result    images -> metadata.result_images[0].imageUrl
//             tts    -> metadata.audio_url
//
// Both generation APIs are ASYNC TASK APIs with ONE shared poll endpoint, so
// pollTask below serves images and TTS alike. A task that ends in `error` is
// refunded by the provider, so a failure costs nothing but time.

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function cfg() {
  const env = getEnv();
  if (!env.AI33_API_KEY) throw new Error("AI33_API_KEY not configured (ai33 provider)");
  return {
    key: env.AI33_API_KEY,
    base: env.AI33_BASE_URL.replace(/\/$/, ""),
    imageModel: env.AI33_IMAGE_MODEL,
    imageResolution: env.AI33_IMAGE_RESOLUTION,
    imageQuality: env.AI33_IMAGE_QUALITY,
    imageAspectRatio: env.AI33_IMAGE_ASPECT_RATIO,
    maxPromptChars: env.AI33_MAX_PROMPT_CHARS,
    imagePollTimeoutMs: env.AI33_IMAGE_POLL_TIMEOUT_SECONDS * 1000,
    ttsPollTimeoutMs: env.AI33_TTS_POLL_TIMEOUT_SECONDS * 1000,
    ttsVoiceProvider: env.AI33_TTS_VOICE_PROVIDER,
    defaultVoice: env.AI33_DEFAULT_VOICE || env.SIXTYNINE_LABS_DEFAULT_VOICE,
    concurrency: env.AI33_CONCURRENCY,
    slotWaitMs: env.AI33_SLOT_WAIT_MS,
  };
}

/** True when ai33 is keyed AND enabled — i.e. it should be tried as primary. */
export function isAi33Configured(): boolean {
  const env = getEnv();
  return env.AI33_ENABLED && Boolean(env.AI33_API_KEY);
}

// ai33 meters by USER, not by key: every credential on the account draws from
// one quota, so a single cluster-wide slot pool is the correct model (unlike
// 69labs, where each ACCOUNT gets its own). Constant id = one shared pool.
const AI33_ACCOUNT_ID = "ai33";

function authHeader(c: ReturnType<typeof cfg>): Record<string, string> {
  return { "xi-api-key": c.key };
}

// ---------------------------------------------------------------------------
// Cross-attempt resume
// ---------------------------------------------------------------------------

// A recorded resume pointer the provider no longer knows about (task expired or
// swept). Callers drop the pointer and submit fresh rather than failing forever
// on an id that will never resolve — same contract as the 69labs STALE_RESUME.
export const AI33_STALE_RESUME = "ai33: recorded task no longer exists";

// Resume pointers are persisted in the SAME media_job metadata field the 69labs
// ones use, so a pointer has to say which provider it belongs to. We tag ai33
// task ids with this prefix instead of adding a column: the processors treat the
// pointer as an opaque string, so no schema or processor change is needed.
const AI33_POINTER_PREFIX = "ai33:";

/** True when a persisted resume pointer addresses an ai33 task (not a 69labs job). */
export function isAi33Pointer(jobId: string | undefined | null): boolean {
  return Boolean(jobId && jobId.startsWith(AI33_POINTER_PREFIX));
}

/** Wrap a raw ai33 task id as a persistable, provider-tagged resume pointer. */
export function toAi33Pointer(taskId: string): string {
  return `${AI33_POINTER_PREFIX}${taskId}`;
}

/** The raw task id inside a tagged pointer (empty when it isn't an ai33 one). */
export function fromAi33Pointer(jobId: string | undefined | null): string {
  return isAi33Pointer(jobId) ? jobId!.slice(AI33_POINTER_PREFIX.length) : "";
}

// ---------------------------------------------------------------------------
// Shared task polling
// ---------------------------------------------------------------------------

interface Ai33Task {
  id: string;
  // "pending" | "doing" | "done" | "error" (lowercase, unlike 69labs).
  status: string;
  progress?: number;
  error_message?: string | null;
  credit_cost?: number;
  metadata?: Record<string, unknown> | null;
}

// Poll GET /v1/task/:id to a terminal state.
//
// 429 handling mirrors the 69labs image poller and exists for the same reason:
// the provider rate-limits polling by request rate (X-RateLimit-* headers,
// Retry-After on 429), and a 429 must NOT fail a task that is still rendering.
// The short retry budget absorbs 5xx/network blips; a 429 that survives it is
// treated as a MISSED TICK — wait one cadence and poll again, bounded by the
// overall deadline.
async function pollTask(
  c: ReturnType<typeof cfg>,
  taskId: string,
  opts: { timeoutMs: number; label: string; signal?: AbortSignal },
): Promise<Ai33Task> {
  const deadline = Date.now() + opts.timeoutMs;
  // 5s cadence: task-detail polling costs 1 rate-limit token, and several lanes
  // poll concurrently. Generations take 30s+, so a tighter tick buys nothing.
  const pollIntervalMs = 5000;

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) {
      throw opts.signal.reason ?? new Error(`ai33: aborted (task ${taskId})`);
    }

    let res: Response;
    try {
      res = await withHttpRetry(
        `ai33.${opts.label}.status`,
        () =>
          fetchOrThrow(`${c.base}/v1/task/${taskId}`, {
            headers: authHeader(c),
            timeoutMs: 30_000,
            signal: opts.signal,
          }),
        { attempts: 3, baseMs: 1000, signal: opts.signal },
      );
    } catch (e) {
      if (isAbortError(e) || opts.signal?.aborted) throw e;
      // A vanished task can never resolve — surface it as STALE so the caller
      // submits fresh instead of polling a corpse to the deadline.
      if (e instanceof HttpError && (e.status === 404 || e.status === 410)) {
        throw new Error(`${AI33_STALE_RESUME} (task ${taskId})`);
      }
      if (e instanceof HttpError && e.status === 429) {
        await sleepUnlessAborted(
          Math.round(pollIntervalMs * (0.75 + Math.random() * 0.5)),
          opts.signal,
        );
        continue;
      }
      throw e;
    }

    const task = (await res.json()) as Ai33Task;
    if (task.status === "done") return task;
    if (task.status === "error") {
      throw new Error(
        `ai33 ${opts.label}: task error (task ${taskId})${
          task.error_message ? ` — ${task.error_message}` : ""
        }`,
      );
    }
    // Jitter so concurrent lanes don't lock-step their polls into a burst that
    // trips the request-rate limit.
    await sleepUnlessAborted(
      Math.round(pollIntervalMs * (0.75 + Math.random() * 0.5)),
      opts.signal,
    );
  }
  throw new Error(`ai33 ${opts.label}: poll timed out (task ${taskId})`);
}

// ---------------------------------------------------------------------------
// Image generation
// ---------------------------------------------------------------------------

export interface GenerateAi33ImageOptions {
  // Per-call overrides; omitted = the AI33_IMAGE_* env defaults.
  model?: string;
  // NOTE these are ai33's OWN value shapes (resolution is UPPERCASE "2K"), not
  // 69labs'. The orchestrator deliberately does NOT forward a caller's 69labs
  // resolution here — the two providers reject each other's spelling.
  resolution?: string;
  quality?: string;
  aspectRatio?: string;
  // A task id from a PRIOR attempt. Present = skip the submit and resume polling
  // that generation, so a retry after a poll timeout doesn't pay twice.
  resumeTaskId?: string;
  // Called with a freshly-submitted task id BEFORE polling begins, so the caller
  // can persist it and resume this exact generation on the next attempt.
  onSubmit?: (taskId: string) => Promise<void> | void;
  // Wall clock for ONE generation, armed only once the concurrency slot is held
  // (queueing is not charged to it — same contract as the 69labs path).
  generationTimeoutMs?: number;
  // Cap on how long to WAIT for a free slot before giving up.
  acquireTimeoutMs?: number;
}

interface Ai33ResultImage {
  id?: string;
  imageUrl?: string;
  previewUrl?: string;
  mimeType?: string;
  width?: number;
  height?: number;
}

/**
 * Generate one still from a text prompt. The prompt must ALREADY carry its style
 * text — this mirrors the 69labs generator and is a drop-in for it.
 */
export async function generateAi33Image(
  prompt: string,
  opts: GenerateAi33ImageOptions = {},
): Promise<{ image: Buffer; contentType: string }> {
  const c = cfg();

  // gpt-image-2 rejects prompts past max_prompt_length. Truncating beats a 400:
  // the style text sits at the END of a composed prompt, but the scene text at
  // the front is what actually differs between stills.
  let body = prompt;
  if (body.length > c.maxPromptChars) {
    console.warn(
      JSON.stringify({
        msg: "ai33.image.prompt_truncated",
        from: body.length,
        to: c.maxPromptChars,
      }),
    );
    body = body.slice(0, c.maxPromptChars);
  }

  return await withAccountSlot(
    AI33_ACCOUNT_ID,
    c.concurrency,
    async () => {
      const ac = new AbortController();
      const ms = opts.generationTimeoutMs;
      const timer = ms
        ? setTimeout(() => ac.abort(new Error(`ai33: image generation deadline exceeded after ${ms}ms`)), ms)
        : undefined;
      timer?.unref?.();
      const signal = ms ? ac.signal : undefined;

      try {
        // 1) Submit — unless resuming a prior attempt's task.
        let taskId = opts.resumeTaskId ?? "";
        if (!taskId) {
          const resolution = opts.resolution ?? c.imageResolution;
          const quality = opts.quality ?? c.imageQuality;
          const modelParameters: Record<string, string> = {
            aspect_ratio: opts.aspectRatio ?? c.imageAspectRatio,
          };
          // Both fields are model-dependent (GET /v1i/models): a model with no
          // resolutions[]/qualities[] 422s on them, so "" omits.
          if (resolution) modelParameters.resolution = resolution;
          if (quality) modelParameters.quality = quality;

          const form = new FormData();
          form.append("prompt", body);
          form.append("model_id", opts.model || c.imageModel);
          form.append("generations_count", "1");
          form.append("model_parameters", JSON.stringify(modelParameters));

          // Short submit budget: a 429/503 here means the queue is full, and the
          // orchestrator's failover to 69labs is a better use of the time than
          // sitting in backoff holding a slot.
          const submit = await withHttpRetry(
            "ai33.image.submit",
            () =>
              fetchOrThrow(`${c.base}/v1i/task/generate-image`, {
                method: "POST",
                headers: authHeader(c),
                body: form,
                timeoutMs: 60_000,
                signal,
              }),
            { attempts: 2, baseMs: 1000, signal },
          );
          const parsed = (await submit.json()) as { success?: boolean; task_id?: string };
          if (!parsed.task_id) throw new Error("ai33 image: submit returned no task_id");
          taskId = parsed.task_id;
          // Persist BEFORE polling so a poll-timeout retry resumes THIS render.
          if (opts.onSubmit) await opts.onSubmit(taskId);
        }

        // 2) Poll to done.
        const task = await pollTask(c, taskId, {
          timeoutMs: c.imagePollTimeoutMs,
          label: "image",
          signal,
        });

        // 3) Download the finished still from the CDN url in the result.
        const images = ((task.metadata?.result_images as Ai33ResultImage[] | undefined) ?? []);
        const url = images[0]?.imageUrl;
        if (!url) throw new Error(`ai33 image: task done but no result image (task ${taskId})`);
        const dl = await withHttpRetry(
          "ai33.image.download",
          () => fetchOrThrow(url, { timeoutMs: 120_000, signal }),
          { signal },
        );
        return {
          image: Buffer.from(await dl.arrayBuffer()),
          contentType: images[0]?.mimeType || dl.headers.get("content-type") || "image/png",
        };
      } catch (e) {
        // Normalise every shape OUR deadline abort can take into one recognisable
        // error. Keyed on ac.signal.aborted, never isAbortError(e): fetchOrThrow's
        // own per-request timeouts also raise AbortError.
        if (ac.signal.aborted) {
          throw ac.signal.reason instanceof Error
            ? ac.signal.reason
            : new Error(`ai33: image generation deadline exceeded after ${ms}ms`);
        }
        throw e;
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    { acquireTimeoutMs: opts.acquireTimeoutMs ?? c.slotWaitMs },
  );
}

// ---------------------------------------------------------------------------
// TTS
// ---------------------------------------------------------------------------

// ai33 voice ids are provider-prefixed. Our project rows store BARE ElevenLabs
// ids (what 69labs takes), so an unprefixed id gets the configured prefix —
// this is what lets one stored voice id serve both providers unchanged. Mirrors
// the provider's own client-side helper.
const AI33_VOICE_PREFIXES = [
  "elevenlabs_",
  "minimax_",
  "clone_",
  "edge_",
  "kokoro_",
  "vbee_",
  "fishaudio_",
];

export function normalizeAi33VoiceId(voiceId: string, provider: string): string {
  const id = (voiceId || "").trim();
  if (!id) return "";
  if (AI33_VOICE_PREFIXES.some((p) => id.startsWith(p))) return id;
  return `${provider}_${id}`;
}

export interface GenerateAi33VoiceOptions {
  resumeTaskId?: string;
  onSubmit?: (taskId: string) => Promise<void> | void;
  speed?: number;
}

/** Generate a voiceover MP3 from transcript text. */
export async function generateAi33Voice(
  input: { text: string; voiceId?: string },
  opts: GenerateAi33VoiceOptions = {},
): Promise<{ audio: Buffer; contentType: string; chars: number }> {
  const c = cfg();
  const text = input.text.trim();
  if (!text) throw new Error("generateAi33Voice: empty text");
  const voiceId = normalizeAi33VoiceId(input.voiceId || c.defaultVoice, c.ttsVoiceProvider);
  if (!voiceId) throw new Error("generateAi33Voice: no voiceId (set AI33_DEFAULT_VOICE)");

  return await withAccountSlot(
    AI33_ACCOUNT_ID,
    c.concurrency,
    async () => {
      // 1) Submit — unless resuming a prior attempt's render.
      let taskId = opts.resumeTaskId ?? "";
      if (!taskId) {
        const form = new FormData();
        form.append("text", text);
        form.append("voice_id", voiceId);
        form.append("speed", String(opts.speed ?? 1));
        form.append("with_transcript", "false");

        const submit = await withHttpRetry("ai33.tts.submit", () =>
          fetchOrThrow(`${c.base}/v3/text-to-speech`, {
            method: "POST",
            headers: authHeader(c),
            body: form,
            timeoutMs: 60_000,
          }),
        );
        const parsed = (await submit.json()) as { success?: boolean; task_id?: string };
        if (!parsed.task_id) throw new Error("ai33 tts: submit returned no task_id");
        taskId = parsed.task_id;
        // Persist BEFORE polling: a 30k-char narration can outlive the poll
        // budget, and resuming beats paying for the same audio twice.
        if (opts.onSubmit) await opts.onSubmit(taskId);
      }

      // 2) Poll to done.
      const task = await pollTask(c, taskId, {
        timeoutMs: c.ttsPollTimeoutMs,
        label: "tts",
      });

      // 3) Download the finished mp3.
      const url = task.metadata?.audio_url as string | undefined;
      if (!url) throw new Error(`ai33 tts: task done but no audio_url (task ${taskId})`);
      const dl = await withHttpRetry("ai33.tts.download", () =>
        fetchOrThrow(url, { timeoutMs: 300_000 }),
      );
      return {
        audio: Buffer.from(await dl.arrayBuffer()),
        contentType: dl.headers.get("content-type") || "audio/mpeg",
        chars: text.length,
      };
    },
    { acquireTimeoutMs: c.slotWaitMs },
  );
}
