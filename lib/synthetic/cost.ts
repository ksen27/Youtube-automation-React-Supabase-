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
  | "flux_image"
  | "ltx2"
  | "fal_veo3_fast"
  | "fal_kling"
  | "heygen_avatar";

// Rough per-unit USD price list. Tunable here as provider pricing changes;
// kept in code (not env) so a missing override can't silently zero out costs.
// Units differ per provider — see estimateCost() for how each is applied.
const PRICE_TABLE: Record<SyntheticProvider, { unit: string; usd: number }> = {
  sixtynine_tts:   { unit: "per_1k_chars", usd: 0.015 },
  sixtynine_image: { unit: "per_image",    usd: 0.04 },
  flux_image:      { unit: "per_image",    usd: 0.05 },
  // LTX-2 bills per second of generated video. Rate tracks LTX_MODEL/resolution:
  // ltx-2-fast @ 1080p = $0.04/sec (current). Was $0.08 (ltx-2-3-pro @ 1080p);
  // bump this back if LTX_MODEL/LTX_RESOLUTION changes.
  ltx2:            { unit: "per_second",   usd: 0.04 },
  fal_veo3_fast:   { unit: "per_second",   usd: 0.10 },
  fal_kling:       { unit: "per_second",   usd: 0.06 },
  heygen_avatar:   { unit: "per_second",   usd: 0.02 },
};

export interface CostInput {
  provider: SyntheticProvider;
  // Supply whichever dimension the provider bills on; the rest are ignored.
  chars?: number;     // TTS
  images?: number;    // image gen
  seconds?: number;   // video / avatar (output duration)
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
      // A nano-banana still + an LTX-2 clip (the clip bills at its tier, but the
      // segment only stores the played duration; tier-snap is close enough for a
      // coarse summary).
      return (
        estimateCost({ provider: "sixtynine_image", images: 1 }) +
        estimateCost({ provider: "ltx2", seconds: secs })
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
