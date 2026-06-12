// Pool-verification wrapper (Slice 4c of the closed-world matching refactor).
//
// One function per asset, one verdict back. Wires together:
//   - face-references.lookupReference()   -- "do we have a canonical
//                                            reference for this entity?"
//   - verify.verifyPersonImage()          -- "is this candidate the same
//                                            person as the reference?"
//   - verify.verifyEntityImage()          -- "is this candidate actually
//                                            a logo/poster/cover/place
//                                            photo of this entity?"
//
// Plus a per-process LRU cache so we don't pay for the same Gemini call
// twice when the same image URL appears in two different segments' pools.
//
// The wrapper centralises three decisions the caller would otherwise have
// to make at every fetch site:
//   1. Which verify function to use (person vs entity vs none).
//   2. What to do when no reference is available — fail open with verdict
//      "skipped" so caller policy is consistent across image and clip
//      pools. We never silently accept-with-low-confidence — that was the
//      original bug.
//   3. Which verdicts mean "include in the pool" vs "drop on the floor".
//      Default policy: accept "yes" and "skipped"; reject "no"; treat
//      "uncertain" as accept-with-warning so we don't gut the pool on
//      Gemini hiccups. Callers can override via opts.acceptUncertain.

import type { BlockEntityType } from "@/lib/ai/segments";
import {
  lookupReference,
  type ReferenceEntityType,
} from "@/lib/ai/face-references";
import {
  verifyPersonImageClean,
  verifyEntityImage,
  type EntityVerifyType,
} from "@/lib/ai/verify";

export type PoolVerdict = "yes" | "no" | "uncertain" | "skipped";

export interface PoolVerifyResult {
  accept: boolean;
  verdict: PoolVerdict;
  reason: string;
  confidence: number;
  // Whether we actually called Gemini. False means we fast-pathed
  // (no reference available, celebrity_default fallback pool, or cached
  // verdict). Useful for accounting / cost reporting.
  geminiCalled: boolean;
}

export interface VerifyAssetInput {
  projectId: string;
  // The entity this asset is supposed to represent. The matcher passes
  // the block's resolved block_entity here.
  entityType: BlockEntityType;
  entityName: string;
  // The candidate image URL we're considering for the pool. For clips,
  // this is the clip's thumbnail (or a sampled keyframe) — verification
  // works on stills regardless of whether the underlying asset is video.
  candidateUrl: string;
}

export interface VerifyAssetOptions {
  // When true, "uncertain" verdicts are dropped (strict mode). Default
  // false — we keep uncertain candidates because rejecting them gut the
  // pool every time Gemini is rate-limited.
  rejectUncertain?: boolean;
  // When true, ONLY a confirmed "yes" is accepted — "uncertain", "no", AND
  // "skipped" are all rejected. This is the strictest mode: an asset enters
  // the pool only when Gemini POSITIVELY confirmed it depicts the entity.
  // Use for the client's "only the correct celebrity" image requirement.
  // Note: "skipped" means no reference photo was available, so we could not
  // confirm identity — under requireConfirmed that is a reject, which is the
  // whole point (an unverifiable image must not ship as the celebrity).
  requireConfirmed?: boolean;
}

// In-process LRU cache. Keyed by
//   `${projectId}:${entityType}:${entityName.toLowerCase()}:${candidateUrl}`
// so the same image considered for the same entity in two segments only
// pays one Gemini call. Cap is generous (5000 entries) because verdicts
// are tiny strings and projects rarely have more than a few hundred
// candidates × entities.
const CACHE_MAX = 5000;
const cache = new Map<string, PoolVerifyResult>();

function cacheGet(key: string): PoolVerifyResult | undefined {
  const v = cache.get(key);
  if (!v) return undefined;
  // Refresh LRU position.
  cache.delete(key);
  cache.set(key, v);
  return v;
}
function cacheSet(key: string, val: PoolVerifyResult): void {
  cache.set(key, val);
  if (cache.size > CACHE_MAX) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
}

function policyAccept(verdict: PoolVerdict, opts: VerifyAssetOptions): boolean {
  // Strictest mode: only a positive "yes" passes.
  if (opts.requireConfirmed) return verdict === "yes";
  if (verdict === "no") return false;
  if (verdict === "uncertain" && opts.rejectUncertain) return false;
  return true; // "yes", "skipped", and "uncertain" (when not strict)
}

// celebrity_default assets never get gated — they ARE the fallback. Slice 5/6
// only call this function for non-celebrity_default entities, but we
// short-circuit defensively here too.
function isFallbackEntity(t: BlockEntityType): boolean {
  return t === "celebrity_default";
}

function toEntityVerifyType(t: BlockEntityType): EntityVerifyType | null {
  switch (t) {
    case "company":
    case "tv_show":
    case "movie":
    case "song":
    case "place":
      return t;
    default:
      return null;
  }
}

function toReferenceEntityType(t: BlockEntityType): ReferenceEntityType | null {
  if (t === "celebrity_default") return null;
  return t;
}

// Verify ONE asset against ONE entity. Returns accept/reject + audit
// detail. Safe to call concurrently for different assets; cache is
// per-process so two parallel calls for the same key may double-fetch
// (acceptable — it's an optimisation, not a correctness requirement).
export async function verifyPoolAsset(
  input: VerifyAssetInput,
  opts: VerifyAssetOptions = {},
): Promise<PoolVerifyResult> {
  const entityName = input.entityName.trim();
  // Celebrity-default pool is the unconditional fallback — accept without
  // gating so the matcher can always fill a block with the celebrity's
  // own footage / image when no entity-specific asset survives.
  if (isFallbackEntity(input.entityType) || !entityName) {
    return {
      accept: true,
      verdict: "skipped",
      reason: "celebrity_default fallback (no gate)",
      confidence: 1,
      geminiCalled: false,
    };
  }

  const cacheKey = `${input.projectId}:${input.entityType}:${entityName.toLowerCase()}:${input.candidateUrl}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    return { ...cached, accept: policyAccept(cached.verdict, opts) };
  }

  const refType = toReferenceEntityType(input.entityType);
  if (!refType) {
    // Shouldn't happen — celebrity_default was handled above. Defensive
    // fast-path so a future enum addition doesn't crash the matcher.
    const out: PoolVerifyResult = {
      accept: true,
      verdict: "skipped",
      reason: `unknown entity type ${input.entityType}`,
      confidence: 0,
      geminiCalled: false,
    };
    cacheSet(cacheKey, out);
    return out;
  }

  const ref = await lookupReference(input.projectId, refType, entityName);

  // PERSON path — needs both a reference (Wikipedia photo of the person)
  // AND the candidate. If we have no reference we cannot face-verify; skip
  // gracefully and let the caller's text-match scoring decide.
  if (input.entityType === "person") {
    if (!ref?.reference_url) {
      const out: PoolVerifyResult = {
        // Without a reference we can't confirm identity. Normally we fail
        // open (accept) so a missing reference doesn't gut the pool — but
        // requireConfirmed callers ("only the correct celebrity") must reject
        // anything we couldn't positively confirm, including this case.
        accept: opts.requireConfirmed ? false : true,
        verdict: "skipped",
        reason: "no reference image for person",
        confidence: 0,
        geminiCalled: false,
      };
      cacheSet(cacheKey, out);
      return out;
    }
    const result = await verifyPersonImageClean({
      candidateUrl: input.candidateUrl,
      referenceUrl: ref.reference_url,
      personName: entityName,
    });
    // Overlay gate (person images only). Three-tier severity:
    //   "dirty"  — BIG/intrusive overlay (headline banner, lower-third,
    //              collage, magazine/book/product cover). Collapses the verdict
    //              to "no" so policyAccept drops it — same as the clickbait
    //              thumbnail look we never want.
    //   "minor"  — only a small corner stock watermark / credit on an
    //              otherwise-clean photo of the correct person. ACCEPTED: real
    //              archival photos of historical figures almost always carry a
    //              Getty/iStock corner bug, and rejecting them starved the pool
    //              (e.g. Diana, where nearly every clean photo is watermarked).
    //   "clean" / "uncertain" — pass through to the identity verdict; an
    //              "uncertain" overlay fails open so a Gemini hiccup doesn't
    //              gut the pool.
    // Entity/logo pools never reach this branch.
    const verdict: PoolVerdict = result.overlay === "dirty" ? "no" : result.verdict;
    const reason =
      result.overlay === "dirty"
        ? `overlay/text on person image: ${result.overlayArtifact || "added graphics"}`
        : result.reason;
    const out: PoolVerifyResult = {
      accept: policyAccept(verdict, opts),
      verdict,
      reason,
      confidence: result.confidence,
      geminiCalled: true,
    };
    cacheSet(cacheKey, out);
    return out;
  }

  // ENTITY path (company / tv_show / movie / song / place) — Gemini knows
  // these from training data, no reference image needed.
  const entityType = toEntityVerifyType(input.entityType);
  if (!entityType) {
    const out: PoolVerifyResult = {
      accept: true,
      verdict: "skipped",
      reason: `entity type ${input.entityType} has no verify path`,
      confidence: 0,
      geminiCalled: false,
    };
    cacheSet(cacheKey, out);
    return out;
  }
  const result = await verifyEntityImage({
    candidateUrl: input.candidateUrl,
    entityType,
    entityName,
  });
  const verdict: PoolVerdict = result.verdict;
  const out: PoolVerifyResult = {
    accept: policyAccept(verdict, opts),
    verdict,
    reason: result.reason,
    confidence: result.confidence,
    geminiCalled: true,
  };
  cacheSet(cacheKey, out);
  return out;
}

// Test/operations helper — clears the per-process cache. Not used by the
// matcher; exported so tests and admin endpoints can force re-verification.
export function clearVerificationCache(): void {
  cache.clear();
}
