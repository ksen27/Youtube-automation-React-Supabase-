import { logJob } from "@/lib/jobs/db";

// Cost tracking + structured provider logging for the synthetic engine.
//
// Every provider call (TTS, image, image-to-video, avatar) routes its
// request/response/duration/cost through here so we get one consistent,
// greppable log line per call and a per-segment cost estimate accumulated in
// synthetic_segments.metadata.cost. Estimates are intentionally coarse — the
// goal is operator visibility ("this project cost ~$3.10"), not invoicing.

export type SyntheticProvider =
  | "sixtynine_tts"
  | "sixtynine_image"
  // ai33.pro (OpenSpeaker) — PRIMARY image + TTS provider since 2026-08-16;
  // 69labs is the backup. Both render gpt-image-2 / the same ElevenLabs voices.
  | "ai33_image"
  | "ai33_tts"
  // OpenAI direct — LAST-RESORT image fallback since 2026-08-24. Same
  // gpt-image-2 the two resellers proxy, bought at retail instead of through
  // them, which is why it is attributed separately.
  | "openai_image"
  | "gemini_image"
  | "flux_image"
  | "fal_flux_image"
  | "ltx2"
  // 69labs Veo 3.1 Lite — the secondary clip engine (~5% of a video).
  | "sixtynine_veo"
  | "fal_veo3_fast"
  | "fal_kling"
  | "heygen_avatar"
  | "heygen_api";

// Rough per-unit USD price list. Tunable here as provider pricing changes;
// kept in code (not env) so a missing override can't silently zero out costs.
// Units differ per provider — see estimateCost() for how each is applied.
const PRICE_TABLE: Record<SyntheticProvider, { unit: string; usd: number }> = {
  sixtynine_tts:   { unit: "per_1k_chars", usd: 0.015 },
  sixtynine_image: { unit: "per_image",    usd: 0.04 },
  // ai33 bills in CREDITS, not dollars, so these are converted from measured
  // credit costs (2026-08-16): a gpt-image-2 still at 2K/high = 2,574 credits,
  // and TTS = ~1.14 credits/char (58 credits for 51 chars). The USD figures
  // below assume the same effective rate as 69labs until the client confirms
  // what the credit pack cost — they exist for the coarse "this project cost
  // ~$X" summary, not invoicing, so a wrong rate misprices a summary and
  // nothing else.
  ai33_image:      { unit: "per_image",    usd: 0.04 },
  ai33_tts:        { unit: "per_1k_chars", usd: 0.015 },
  // MEASURED live 2026-08-24 at the exact settings the fallback runs
  // (gpt-image-2, 1536x1024, quality=low): 158 image output tokens per still.
  // At OpenAI's $40/1M image-output-token rate that is ~$0.0063.
  //
  // NOTE the counter-intuitive result: at LOW quality this retail path prices
  // BELOW the $0.04 reseller entries above — the resellers run quality=high
  // (AI33_IMAGE_QUALITY), and quality dominates the per-image price far more
  // than the reseller margin does. So this is not a "the fallback is expensive"
  // line item. Raising OPENAI_IMAGE_QUALITY is what would make it one: high at
  // this size is roughly an order of magnitude more per image.
  //
  // The $40/1M rate is gpt-image-1's published image-output rate, applied here
  // because the measurement is in tokens and gpt-image-2's own rate was not
  // confirmed against a bill. Coarse by design (see the header) — worth a
  // re-check against a real invoice before anyone quotes it to the client.
  openai_image:    { unit: "per_image",    usd: 0.0063 },
  // Gemini's own nano-banana image model — the PREFERRED still fallback when the
  // 69labs pool is exhausted (same model 69labs resells, so matching look).
  // Google bills per image; tune if GEMINI_IMAGE_MODEL changes to a Pro tier.
  gemini_image:    { unit: "per_image",    usd: 0.04 },
  flux_image:      { unit: "per_image",    usd: 0.05 },
  // fal.ai FLUX text-to-image — the fallback still when the 69labs pool is
  // exhausted. FLUX schnell is cheap; tune if FAL_AI_IMAGE_MODEL changes.
  fal_flux_image:  { unit: "per_image",    usd: 0.01 },
  // LTX-2 bills per second of generated video. Rate tracks LTX_MODEL/resolution:
  // ltx-2-3-fast @ 1080p = $0.04/sec (current). Was $0.08 (ltx-2-3-pro @ 1080p).
  // If LTX_RESOLUTION is ever moved to 4K, raise this ~4x (LTX's published ratio
  // is 10s: $0.60 at 1080p -> $2.40 at 4K).
  ltx2:            { unit: "per_second",   usd: 0.04 },
  // 69labs Veo 3.1 Lite bills 1 CREDIT PER GENERATION regardless of length, not
  // per second — so it is priced per_clip here. The daily/monthly credit
  // allowance (300/day, 24k/month as of 2026-08-17) is the real constraint; the
  // USD figure is a nominal per-credit rate for the coarse project summary, and
  // should be retuned when the client confirms what a credit pack costs.
  sixtynine_veo:   { unit: "per_clip",     usd: 0.04 },
  fal_veo3_fast:   { unit: "per_second",   usd: 0.10 },
  fal_kling:       { unit: "per_second",   usd: 0.06 },
  heygen_avatar:   { unit: "per_second",   usd: 0.02 },
  // The official HeyGen API (last-resort fallback when browser automation fails).
  // Bills API credits, which are MORE expensive than the interactive-plan renders
  // the browser automation drives — hence "last resort". Rate is an estimate;
  // tune when the client's API plan pricing is known.
  heygen_api:      { unit: "per_second",   usd: 0.10 },
};

export interface CostInput {
  provider: SyntheticProvider;
  // Supply whichever dimension the provider bills on; the rest are ignored.
  chars?: number;     // TTS
  images?: number;    // image gen
  seconds?: number;   // video / avatar (output duration)
  clips?: number;     // per-generation video billing (69labs veo credits)
}

/** Coarse USD estimate for a single provider call. Never throws. */
export function estimateCost(input: CostInput): number {
  const price = PRICE_TABLE[input.provider];
  if (!price) return 0;
  switch (price.unit) {
    case "per_1k_chars":
      return ((input.chars ?? 0) / 1000) * price.usd;
    case "per_image":
      return (input.images ?? 1) * price.usd;
    case "per_second":
      return (input.seconds ?? 0) * price.usd;
    case "per_clip":
      // Billed per generation, so LENGTH is irrelevant — one clip, one charge.
      return (input.clips ?? 1) * price.usd;
    default:
      return 0;
  }
}

// Map a finished segment (block_type + the provider that produced it + its
// duration) to a coarse USD cost, mirroring what the per-call logProviderCall
// lines recorded during generation. Used by the project cost summary so the
// total is reconstructable from the segment rows alone (the per-call logs only
// go to stdout, so we can't sum them after the fact).
//
// This reflects the FINAL asset cost, not retries: a segment that retried
// generated extra stills/renders that the final row doesn't capture. So the
// summary is a floor on actual spend — good for "this project cost ~$X", not
// invoicing. ai_clip/image counts include their nano-banana still.
export function estimateSegmentCost(seg: {
  block_type: "avatar" | "image" | "ai_clip" | "split_2";
  provider?: string | null;
  duration?: number | null;
}): number {
  const secs = Math.max(0, Number(seg.duration) || 0);
  switch (seg.block_type) {
    case "image":
      // One generated still.
      return estimateCost({ provider: "sixtynine_image", images: 1 });
    case "ai_clip":
      // A nano-banana still + the animated clip. WHICH clip engine ran is read
      // off the stored provider: the veo lane bills per generation (a flat
      // credit) while LTX bills per second, so charging a veo clip at LTX's
      // per-second rate would overstate a long block by several times.
      return (
        estimateCost({ provider: "sixtynine_image", images: 1 }) +
        (seg.provider === "sixtynine_veo"
          ? estimateCost({ provider: "sixtynine_veo", clips: 1 })
          : estimateCost({ provider: "ltx2", seconds: secs }))
      );
    case "avatar":
      // A HeyGen talking-head render, billed per second of avatar video.
      return estimateCost({ provider: "heygen_avatar", seconds: secs });
    case "split_2":
      // Avatar video (left) + a nano-banana still (right).
      return (
        estimateCost({ provider: "heygen_avatar", seconds: secs }) +
        estimateCost({ provider: "sixtynine_image", images: 1 })
      );
    default:
      return 0;
  }
}

export interface ProviderCallLog {
  projectId: string;
  jobId?: string;
  segmentId?: string;
  provider: SyntheticProvider;
  // 'request' | 'response' | 'retry' | 'fallback' | 'error'
  phase: "request" | "response" | "retry" | "fallback" | "error";
  durationMs?: number;
  attempt?: number;
  cost?: CostInput;
  // Provider request/response ids, model, http status, error message, etc.
  extra?: Record<string, unknown>;
}

/**
 * Single structured log line for a provider call. Routes through logJob so it
 * lands in the same stdout JSON stream the worker already emits. Returns the
 * estimated USD cost (0 unless a cost dimension was supplied) so callers can
 * accumulate it onto the segment.
 */
export async function logProviderCall(entry: ProviderCallLog): Promise<number> {
  const usd = entry.cost ? estimateCost(entry.cost) : 0;
  await logJob(
    { projectId: entry.projectId, jobId: entry.jobId, sourceId: entry.segmentId },
    `synthetic.${entry.provider}.${entry.phase}`,
    {
      provider: entry.provider,
      phase: entry.phase,
      attempt: entry.attempt,
      durationMs: entry.durationMs,
      costUsd: Number(usd.toFixed(4)),
      ...entry.extra,
    },
  );
  return usd;
}
