import { getEnv } from "@/lib/env";
import { CLIP_NEGATIVE_PROMPT } from "@/lib/synthetic/constants";
import { fetchOrThrow, withHttpRetry, isAuthForbidden } from "@/lib/synthetic/http";
import type { GenerateClipInput, GenerateClipResult } from "@/lib/synthetic/falai";

// LTX-2 (api.ltx.video) image-to-video provider. PRIMARY clip provider for the
// synthetic engine's ai_clip blocks (fal.ai Veo/Kling is the fallback chain —
// see generateClipWithFallback in falai.ts). Animates a still image (the
// nano-banana output) into a short motion clip WITHOUT audio — the voiceover is
// the master track, and the renderer strips clip audio anyway (keepAudio:false).
//
// LTX-2's async job lifecycle (matches fal.ai / 69labs):
//   1. POST /v2/image-to-video         -> { id, created_at }
//   2. GET  /v2/image-to-video/{id}    -> status pending|processing|completed|failed
//   3. on completed: download result.video_url
//
// Duration is a DISCRETE tier, not arbitrary. At 1080p/25fps LTX-2 accepts
// 6/8/10/12/14/16/18/20s (max 20s). We request 1920x1080 (16:9 — LTX's only
// supported aspect) and snap each requested duration to the nearest allowed
// tier, clamped to LTX_MAX_DURATION. The planner caps blocks at ~8s, so in
// practice we land on 6 or 8.

// Allowed duration tiers at 1080p/25fps. We pick the nearest tier <= the
// configured max so a requested 7s lands on 6 or 8, never an unsupported value.
//
// THE 6s FLOOR IS AN api.ltx.video CONSTRAINT, NOT A MODEL ONE. The hosted API
// only accepts these discrete tiers, so a 4s request there rounds UP to 6 and we
// pay for 6. The self-hosted service (services/ltx-selfhost) derives frames from
// the requested duration directly (snapped to the 8n+1 the latent format needs),
// so it can render 4s clips the API simply cannot sell us — client 2026-08-21
// asked for 4s clips, which is only reachable on our own GPU.
//
// LTX_DURATION_TIERS_OVERRIDE therefore exists to widen this list when
// LTX_BASE_URL points at the self-hosted service. Leave it unset while pointing
// at api.ltx.video or every clip fails with an unsupported-duration error.
export const LTX_DEFAULT_DURATION_TIERS = [6, 8, 10, 12, 14, 16, 18, 20];

export function ltxDurationTiers(): number[] {
  const raw = (getEnv().LTX_DURATION_TIERS_OVERRIDE || "").trim();
  if (!raw) return LTX_DEFAULT_DURATION_TIERS;
  const tiers = raw
    .split(",")
    .map((t) => Number(t.trim()))
    .filter((t) => Number.isFinite(t) && t > 0)
    .sort((a, b) => a - b);
  return tiers.length > 0 ? tiers : LTX_DEFAULT_DURATION_TIERS;
}

/** @deprecated use ltxDurationTiers() — kept so existing imports keep compiling. */
export const LTX_DURATION_TIERS = LTX_DEFAULT_DURATION_TIERS;

function cfg() {
  const env = getEnv();
  if (!env.LTX_API_KEY) throw new Error("LTX_API_KEY not configured (synthetic engine)");
  // NOTE: the api key is NOT returned here. Key selection (round-robin + failover
  // across the pool) lives in keyPool()/nextKeyOrder() and is passed explicitly to
  // generateLtxVideoWithKey. cfg() only carries the non-secret request config.
  return {
    base: env.LTX_BASE_URL.replace(/\/$/, ""),
    model: env.LTX_MODEL,
    // "" (the default) means "send no negative_prompt at all" -- see the submit
    // body. Set to "default" to use the tuned CLIP_NEGATIVE_PROMPT, or to any
    // literal string to override it.
    negativePrompt:
      env.LTX_NEGATIVE_PROMPT === "default"
        ? CLIP_NEGATIVE_PROMPT
        : (env.LTX_NEGATIVE_PROMPT || ""),
    resolution: env.LTX_RESOLUTION,
    fps: env.LTX_FPS,
    maxDuration: env.LTX_MAX_DURATION,
    pollTimeoutMs: env.LTX_POLL_TIMEOUT_SECONDS * 1000,
  };
}

// The ordered LTX key pool: primary first, then the optional 2nd/3rd named keys,
// then any extra keys from the LTX_API_KEYS list. Empties filtered, duplicates
// dropped — a single configured key yields a 1-element pool (identical to the old
// single-key behaviour: no round-robin, no failover). Each DISTINCT key is a
// separate LTX account, so N keys render clips in parallel across N accounts.
function keyPool(): string[] {
  const env = getEnv();
  const extra = (env.LTX_API_KEYS || "").split(/[\n,]/).map((k) => k.trim());
  const seen = new Set<string>();
  const pool: string[] = [];
  for (const k of [env.LTX_API_KEY, env.LTX_API_KEY_2, env.LTX_API_KEY_3, ...extra]) {
    const key = (k || "").trim();
    if (key.length > 0 && !seen.has(key)) {
      seen.add(key);
      pool.push(key);
    }
  }
  return pool;
}

// Round-robin cursor for balancing clip generations across the key pool. A plain
// process-wide counter is enough: it just spreads starts across keys. Each call
// reads-then-increments, so consecutive clips start on alternating accounts; the
// remaining keys follow as ordered failover candidates.
let rrCursor = 0;
function nextKeyOrder(pool: string[]): string[] {
  if (pool.length <= 1) return pool;
  const start = rrCursor++ % pool.length;
  return [...pool.slice(start), ...pool.slice(0, start)];
}

export function isLtxConfigured(): boolean {
  return Boolean(getEnv().LTX_API_KEY);
}

// The LTX model the clip lane will actually request (from LTX_MODEL). Exposed so
// the processor can log which model each clip ran with — the provider label
// ("ltx2") doesn't distinguish ltx-2-fast from ltx-2-3-fast.
export function ltxModel(): string {
  return getEnv().LTX_MODEL;
}

// Number of distinct LTX accounts configured (pool size). Logged so ops can see
// how many accounts are actually load-balancing clips.
export function ltxPoolSize(): number {
  return keyPool().length;
}

// A PERMANENT LTX failure that retrying cannot fix: the account is out of money
// or over quota. Retrying just burns the upstream image-gen cost (a fresh
// nano-banana still per attempt) on a clip that can never succeed, so the
// processor should fail fast on the first attempt instead of exhausting its
// retry budget. Matched on the reason text LTX returns
// ("Insufficient funds. Required: 48 cents", quota/credit walls).
export function isLtxPermanentFailure(err: unknown): boolean {
  const msg = (err as Error)?.message ?? String(err ?? "");
  return /insufficient funds|out of (credits?|funds)|no credits|quota|payment required|billing/i.test(msg);
}

// Coerce LTX's inconsistent failure payload into a human-readable string. The
// reason can arrive as a plain string, a nested {error|message|detail}, or an
// arbitrary object — JSON.stringify the object form so we never print
// "[object Object]". Returns "" when there is genuinely nothing to report.
function ltxErrorReason(st: { error?: unknown; message?: unknown; detail?: unknown }): string {
  const candidate = st.error ?? st.message ?? st.detail;
  if (candidate == null) return "";
  if (typeof candidate === "string") return candidate.slice(0, 300);
  // Nested object: pull a message-ish field if present, else stringify the whole.
  const obj = candidate as Record<string, unknown>;
  const nested = obj.message ?? obj.error ?? obj.detail ?? obj.reason;
  if (typeof nested === "string") return nested.slice(0, 300);
  try {
    return JSON.stringify(candidate).slice(0, 300);
  } catch {
    return String(candidate).slice(0, 300);
  }
}

// Snap an arbitrary requested duration (seconds) to the nearest available tier
// that does not exceed maxDuration. With the default (api.ltx.video) tiers the
// floor is 6s, so anything shorter rounds UP to 6; with a self-hosted override
// that includes 4, a 4s request stays 4.
export function snapDuration(requested: number, maxDuration: number): number {
  const all = ltxDurationTiers();
  const allowed = all.filter((t) => t <= maxDuration);
  const tiers = allowed.length > 0 ? allowed : [all[0]];
  let best = tiers[0];
  let bestDist = Math.abs(requested - best);
  for (const t of tiers) {
    const d = Math.abs(requested - t);
    if (d < bestDist) {
      best = t;
      bestDist = d;
    }
  }
  return best;
}

/**
 * LTX-2 image-to-video (no audio). Primary clip provider; on failure the caller
 * (generateClipWithFallback) falls through to fal.ai Veo, then Kling.
 *
 * KEY-POOL ROUND-ROBIN + FAILOVER (mirrors the 69labs image pool): clip jobs are
 * load-balanced across the LTX key pool, so multiple LTX accounts render clips in
 * parallel. If the chosen account is DEAD or BROKE — a permanent auth failure
 * (401/403) or an "insufficient funds"/quota wall (isLtxPermanentFailure) — the
 * run retries on the next key in the pool. Any other error (transient, poll
 * timeout, content-policy job failure) propagates unchanged so generateClipWith-
 * Fallback can fall over to fal.ai. A single configured key = no failover (the
 * pool has one element), identical to the old behaviour.
 */
export async function generateLtxVideo(input: GenerateClipInput): Promise<GenerateClipResult> {
  const order = nextKeyOrder(keyPool());
  if (order.length === 0) throw new Error("LTX_API_KEY not configured (synthetic engine)");
  let lastErr: unknown;
  for (let i = 0; i < order.length; i++) {
    const key = order[i];
    try {
      return await generateLtxVideoWithKey(input, key);
    } catch (err) {
      lastErr = err;
      // Only hop to the next account when THIS one is unusable: a dead key
      // (permanent auth 401/403) or a broke/over-quota account (insufficient
      // funds). A transient failure or a content-policy job failure would fail on
      // every account too, so let it propagate to the fal.ai fallback instead.
      const deadAccount = isAuthForbidden(err) || isLtxPermanentFailure(err);
      const hasNext = i < order.length - 1;
      if (hasNext && deadAccount) {
        console.warn(
          JSON.stringify({
            msg: "ltx.key_failover",
            note: "LTX account unusable (auth/funds); retrying on next key in pool",
            err: (err as Error).message?.slice(0, 200),
          }),
        );
        continue;
      }
      throw err;
    }
  }
  throw lastErr ?? new Error("generateLtxVideo: no LTX key configured");
}

// One LTX image-to-video run (submit -> poll -> download) on a SPECIFIC account
// key. The key is passed in (not read from cfg) so generateLtxVideo can re-run
// this on the next pool key when an account is dead/broke.
async function generateLtxVideoWithKey(
  input: GenerateClipInput,
  key: string,
): Promise<GenerateClipResult> {
  const c = cfg();
  const auth = { Authorization: `Bearer ${key}` };
  const requested = input.durationSeconds ?? 6;
  const duration = snapDuration(requested, c.maxDuration);

  // 1) Submit the job. image_uri is the public R2 still URL; LTX accepts any
  // publicly reachable URL here (no separate upload step needed).
  const submit = await withHttpRetry("ltx.submit", () =>
    fetchOrThrow(`${c.base}/v2/image-to-video`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        image_uri: input.imageUrl,
        prompt: input.prompt,
        // Only sent when configured. The SELF-HOSTED service reads this and
        // falls back to the diffusers default when it is absent; api.ltx.video
        // has no documented negative_prompt field, so leaving LTX_NEGATIVE_PROMPT
        // unset keeps the hosted-API request byte-identical to before and makes
        // a rollback risk-free.
        ...(c.negativePrompt ? { negative_prompt: c.negativePrompt } : {}),
        model: c.model,
        duration,
        resolution: c.resolution,
        // ltx-2-fast rejects the API's default fps 24 at 1080p; send an allowed
        // value (25/50) explicitly. Downstream render re-encodes to 30 anyway.
        fps: c.fps,
      }),
      timeoutMs: 60_000,
    }),
  );
  const { id: jobId } = (await submit.json()) as { id: string; created_at?: string };
  if (!jobId) throw new Error("ltx: submit returned no job id");

  // 2) Poll status every 5s (per docs) until completed / failed / timeout.
  const deadline = Date.now() + c.pollTimeoutMs;
  let result: { video_url?: string } | undefined;
  while (Date.now() < deadline) {
    const statusRes = await fetchOrThrow(`${c.base}/v2/image-to-video/${jobId}`, {
      headers: auth,
      timeoutMs: 30_000,
    });
    const st = (await statusRes.json()) as {
      status?: string;
      result?: { video_url?: string };
      error?: unknown;
      message?: unknown;
      detail?: unknown;
    };
    if (st.status === "completed") {
      result = st.result;
      break;
    }
    if (st.status === "failed") {
      // LTX reports the failure reason inconsistently: sometimes a string under
      // `error`, sometimes an object, sometimes under `message`/`detail`. The old
      // code interpolated it directly, yielding an undiagnosable "[object Object]".
      // Serialize whatever we got so the real reason (content policy, bad image,
      // unsupported duration) is visible in the job.failed log.
      const reason = ltxErrorReason(st);
      throw new Error(`ltx: job failed${reason ? ` :: ${reason}` : ""} (job ${jobId})`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  if (!result) throw new Error(`ltx: poll timed out (job ${jobId})`);

  const videoUrl = result.video_url;
  if (!videoUrl) throw new Error(`ltx: no result.video_url in completed job ${jobId}`);

  // 3) Download the finished mp4.
  const dl = await withHttpRetry("ltx.download", () =>
    fetchOrThrow(videoUrl, { timeoutMs: 120_000 }),
  );
  return {
    video: Buffer.from(await dl.arrayBuffer()),
    contentType: dl.headers.get("content-type") || "video/mp4",
    provider: "ltx2",
    seconds: duration,
  };
}
