// Pool-verification wrapper (Slice 4c of the closed-world matching refactor).
//
// One function per asset, one verdict back. Wires together:
//   - face-references.lookupReference()   -- "do we have a canonical
//                                            reference for this entity?"
//   - verify.verifyPersonImageClean()     -- "is this candidate the same
//                                            person as the reference, and
//                                            is the photo clean?"
//   - verify.verifyEntityImage()          -- "is this candidate actually
//                                            a logo/poster/cover/place
//                                            photo of this entity?"
//
// Plus TWO verdict caches:
//   1. A per-process LRU (fast, dies with the process).
//   2. The image_verifications table (persistent, global) — the answer to
//      "is URL X really entity Y" never changes, so verdicts survive job
//      retries, worker restarts, and are shared across projects about the
//      same person. Re-running a job after a Gemini outage is nearly free.
//
// INFRA FAILURES vs JUDGEMENTS (the Gemini-outage fix):
//   A 503 / fetch timeout / parse error means Gemini NEVER LOOKED at the
//   image. Those results carry errored:true, are NEVER cached or persisted,
//   and are meant to be parked + retried by the caller (see
//   verifyPoolAssetWithRetry and the matcher's parked-retry rounds). They
//   are still not accepted under requireConfirmed — we never ship an
//   unverified person image — but they must not be treated as a confirmed
//   rejection either. Before this distinction existed, a transient Gemini
//   outage was converted into permanent rejections of correct images
//   (refImagesFailed:188 in production) and the bogus verdicts were even
//   cached past the outage.
//
// The wrapper centralises the decisions the caller would otherwise have to
// make at every fetch site:
//   1. Which verify function to use (person vs entity vs none).
//   2. What to do when no reference is available — fail open with verdict
//      "skipped" so caller policy is consistent across image and clip
//      pools. We never silently accept-with-low-confidence — that was the
//      original bug.
//   3. Which verdicts mean "include in the pool" vs "drop on the floor".
//      Default policy: accept "yes" and "skipped"; reject "no"; treat
//      "uncertain" as accept-with-warning so we don't gut the pool on
//      Gemini hiccups. Callers can override via opts.rejectUncertain /
//      opts.requireConfirmed.

import type { BlockEntityType } from "@/lib/ai/segments";
import {
  lookupReference,
  type ReferenceEntityType,
} from "@/lib/ai/face-references";
import {
  verifyPersonImageClean,
  verifyPersonImagesCleanBatch,
  verifyEntityImage,
  PERSON_VERIFY_BATCH_MAX,
  type PersonImageCleanResult,
  type EntityVerifyType,
} from "@/lib/ai/verify";
import { getServerSupabase } from "@/lib/supabase/server";

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
  // True when the result is an INFRA FAILURE, not a judgement — see module
  // header. Never cached; callers should retry later.
  errored?: boolean;
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

// ---------------------------------------------------------------------------
// In-process LRU cache. Keyed by
//   `${projectId}:${entityType}:${entityName.toLowerCase()}:${candidateUrl}`
// so the same image considered for the same entity in two segments only
// pays one Gemini call. Cap is generous (5000 entries) because verdicts
// are tiny strings and projects rarely have more than a few hundred
// candidates × entities. Errored results are NEVER stored here.
// ---------------------------------------------------------------------------
const CACHE_MAX = 5000;
const cache = new Map<string, PoolVerifyResult>();

function cacheKeyFor(input: VerifyAssetInput): string {
  return `${input.projectId}:${input.entityType}:${input.entityName.trim().toLowerCase()}:${input.candidateUrl}`;
}

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

// ---------------------------------------------------------------------------
// Persistent verdict cache (image_verifications table). Global — keyed on
// (entity_type, lower(entity_name), candidate_url), NO project scoping: the
// same photo URL either is the person or it isn't, regardless of project.
// Both helpers fail SOFT: a DB blip degrades to "no cache", never to a
// failed verification.
// ---------------------------------------------------------------------------
interface DbVerdict {
  verdict: PoolVerdict;
  reason: string;
  confidence: number;
}

async function dbGetVerdicts(
  entityType: ReferenceEntityType,
  entityName: string,
  urls: string[],
): Promise<Map<string, DbVerdict>> {
  const out = new Map<string, DbVerdict>();
  if (urls.length === 0) return out;
  // PostgREST encodes .in() as a GET query-string filter. Hundreds of long
  // image URLs (parked-retry rounds pass 250+) overflow the request line and
  // the WHOLE read 400s ("Bad Request") — every cached verdict becomes a
  // miss and gets re-verified. Chunk the reads to keep each request small.
  const CHUNK = 50;
  try {
    const sb = getServerSupabase();
    for (let i = 0; i < urls.length; i += CHUNK) {
      const { data, error } = await sb
        .from("image_verifications")
        .select("candidate_url, verdict, reason, confidence")
        .eq("entity_type", entityType)
        .eq("entity_name", entityName.trim().toLowerCase())
        .in("candidate_url", urls.slice(i, i + CHUNK));
      if (error) throw new Error(error.message);
      for (const row of (data ?? []) as Array<{
        candidate_url: string; verdict: string; reason: string | null; confidence: number | string | null;
      }>) {
        out.set(row.candidate_url, {
          verdict: row.verdict as PoolVerdict,
          reason: row.reason ?? "",
          confidence: Number(row.confidence ?? 0),
        });
      }
    }
  } catch (e) {
    console.warn(JSON.stringify({
      msg: "image_verifications.read_failed",
      entityType, entityName,
      err: (e as Error).message?.slice(0, 200),
    }));
  }
  return out;
}

// Fire-and-forget upsert. Only REAL verdicts (yes/no/uncertain) reach this
// — "skipped" and errored results are filtered by the callers below.
function dbPutVerdicts(
  entityType: ReferenceEntityType,
  entityName: string,
  rows: Array<{ candidateUrl: string; verdict: PoolVerdict; reason: string; confidence: number }>,
): void {
  const persistable = rows.filter((r) => r.verdict !== "skipped");
  if (persistable.length === 0) return;
  void (async () => {
    try {
      const sb = getServerSupabase();
      const payload = persistable.map((r) => ({
        entity_type: entityType,
        entity_name: entityName.trim().toLowerCase(),
        candidate_url: r.candidateUrl,
        verdict: r.verdict,
        reason: r.reason.slice(0, 300),
        confidence: r.confidence,
      }));
      const { error } = await sb
        .from("image_verifications")
        .upsert(payload, { onConflict: "entity_type,entity_name,candidate_url" });
      if (error) throw new Error(error.message);
    } catch (e) {
      console.warn(JSON.stringify({
        msg: "image_verifications.write_failed",
        entityType, entityName, rows: persistable.length,
        err: (e as Error).message?.slice(0, 200),
      }));
    }
  })();
}

// ---------------------------------------------------------------------------
// Outage accounting + retry budget. The match processor resets this at job
// start and reads it before finalising: when MOST verification attempts in a
// run errored (sustained Gemini outage), the job should FAIL and re-run
// later rather than ship an all-fallback video that merely looks successful.
// ---------------------------------------------------------------------------
export interface VerifyOutageStats {
  // Verification attempts that actually went to Gemini (cache hits excluded).
  checked: number;
  // How many of those were infra failures.
  errored: number;
}
let outageStats: VerifyOutageStats = { checked: 0, errored: 0 };

// Shared wall-clock budget for retry WAITING across the whole process/job.
// Bounds how much extra time a sustained outage can add: once the budget is
// spent, errored results return immediately (and the outage stats / circuit
// breaker take over). Refreshed by resetVerifyOutageTracking at job start.
let retryWaitBudgetMs = 180_000;

export function resetVerifyOutageTracking(retryBudget = 180_000): void {
  outageStats = { checked: 0, errored: 0 };
  retryWaitBudgetMs = retryBudget;
}

export function getVerifyOutageStats(): VerifyOutageStats {
  return { ...outageStats };
}

function recordOutcome(out: PoolVerifyResult): void {
  if (!out.geminiCalled && !out.errored) return; // fast-path / cache — not an attempt
  outageStats.checked++;
  if (out.errored) outageStats.errored++;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------
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
//   "clean" / "uncertain" — pass through to the identity verdict.
function collapsePersonClean(result: PersonImageCleanResult): { verdict: PoolVerdict; reason: string } {
  if (result.overlay === "dirty") {
    return {
      verdict: "no",
      reason: `overlay/text on person image: ${result.overlayArtifact || "added graphics"}`,
    };
  }
  return { verdict: result.verdict, reason: result.reason };
}

function skippedResult(reason: string, accept: boolean, confidence = 0): PoolVerifyResult {
  return { accept, verdict: "skipped", reason, confidence, geminiCalled: false };
}

// ---------------------------------------------------------------------------
// verifyPoolAsset — verify ONE asset against ONE entity. Returns
// accept/reject + audit detail. Safe to call concurrently for different
// assets; caches are per-process / DB so two parallel calls for the same key
// may double-fetch (acceptable — it's an optimisation, not a correctness
// requirement).
// ---------------------------------------------------------------------------
export async function verifyPoolAsset(
  input: VerifyAssetInput,
  opts: VerifyAssetOptions = {},
): Promise<PoolVerifyResult> {
  const entityName = input.entityName.trim();
  // Celebrity-default pool is the unconditional fallback — accept without
  // gating so the matcher can always fill a block with the celebrity's
  // own footage / image when no entity-specific asset survives.
  if (isFallbackEntity(input.entityType) || !entityName) {
    return { ...skippedResult("celebrity_default fallback (no gate)", true, 1) };
  }

  const cacheKey = cacheKeyFor(input);
  const cached = cacheGet(cacheKey);
  if (cached) {
    return { ...cached, accept: policyAccept(cached.verdict, opts) };
  }

  const refType = toReferenceEntityType(input.entityType);
  if (!refType) {
    // Shouldn't happen — celebrity_default was handled above. Defensive
    // fast-path so a future enum addition doesn't crash the matcher.
    const out = skippedResult(`unknown entity type ${input.entityType}`, true);
    cacheSet(cacheKey, out);
    return out;
  }

  // Persistent-cache read-through. A hit skips Gemini AND the reference
  // lookup entirely — verdicts are permanent facts about (entity, url).
  const dbHit = (await dbGetVerdicts(refType, entityName, [input.candidateUrl]))
    .get(input.candidateUrl);
  if (dbHit) {
    const out: PoolVerifyResult = {
      accept: policyAccept(dbHit.verdict, opts),
      verdict: dbHit.verdict,
      reason: dbHit.reason,
      confidence: dbHit.confidence,
      geminiCalled: false,
    };
    cacheSet(cacheKey, out);
    return out;
  }

  // PERSON path — needs both a reference (Wikipedia photo of the person)
  // AND the candidate. If we have no reference we cannot face-verify; skip
  // gracefully and let the caller's policy decide.
  if (input.entityType === "person") {
    const ref = await lookupReference(input.projectId, "person", entityName);
    if (!ref?.reference_url) {
      // Without a reference we can't confirm identity. Normally we fail
      // open (accept) so a missing reference doesn't gut the pool — but
      // requireConfirmed callers ("only the correct celebrity") must reject
      // anything we couldn't positively confirm, including this case.
      const out = skippedResult("no reference image for person", opts.requireConfirmed ? false : true);
      cacheSet(cacheKey, out);
      return out;
    }
    const result = await verifyPersonImageClean({
      candidateUrl: input.candidateUrl,
      referenceUrl: ref.reference_url,
      personName: entityName,
    });
    const collapsed = collapsePersonClean(result);
    // accept comes from policyAccept even for errored results: the default
    // policy fails OPEN on an errored "uncertain" (legacy behaviour for
    // non-strict callers), while requireConfirmed rejects it (uncertain is
    // never a confirmed yes). Strict callers park errored entries and retry.
    const out: PoolVerifyResult = {
      accept: policyAccept(collapsed.verdict, opts),
      verdict: collapsed.verdict,
      reason: collapsed.reason,
      confidence: result.confidence,
      geminiCalled: true,
      errored: result.errored || undefined,
    };
    recordOutcome(out);
    if (!result.errored) {
      cacheSet(cacheKey, out);
      dbPutVerdicts("person", entityName, [{
        candidateUrl: input.candidateUrl,
        verdict: collapsed.verdict,
        reason: collapsed.reason,
        confidence: result.confidence,
      }]);
    }
    return out;
  }

  // ENTITY path (company / tv_show / movie / song / place) — Gemini knows
  // these from training data, no reference image needed.
  const entityType = toEntityVerifyType(input.entityType);
  if (!entityType) {
    const out = skippedResult(`entity type ${input.entityType} has no verify path`, true);
    cacheSet(cacheKey, out);
    return out;
  }
  const result = await verifyEntityImage({
    candidateUrl: input.candidateUrl,
    entityType,
    entityName,
  });
  const out: PoolVerifyResult = {
    // Same accept semantics as the person path: errored results follow the
    // caller's policy (fail-open by default, rejected under strict modes).
    accept: policyAccept(result.verdict, opts),
    verdict: result.verdict,
    reason: result.reason,
    confidence: result.confidence,
    geminiCalled: true,
    errored: result.errored || undefined,
  };
  recordOutcome(out);
  if (!result.errored) {
    cacheSet(cacheKey, out);
    dbPutVerdicts(entityType, entityName, [{
      candidateUrl: input.candidateUrl,
      verdict: result.verdict,
      reason: result.reason,
      confidence: result.confidence,
    }]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// verifyPoolAssetWithRetry — single-asset verify that retries INFRA FAILURES
// (errored results) with backoff, drawing waits from the shared per-job
// budget. Real verdicts (yes/no/uncertain/skipped) return immediately. Use
// at per-block gates where one candidate decides a block; pool builders
// should prefer verifyPoolAssetsBatch + their own parked-retry rounds.
// ---------------------------------------------------------------------------
const VERIFY_RETRY_DELAYS_MS = [15_000, 30_000];

export async function verifyPoolAssetWithRetry(
  input: VerifyAssetInput,
  opts: VerifyAssetOptions = {},
): Promise<PoolVerifyResult> {
  let res = await verifyPoolAsset(input, opts);
  for (const delay of VERIFY_RETRY_DELAYS_MS) {
    if (!res.errored) return res;
    // Budget exhausted — a sustained outage. Stop burning wall-time per
    // candidate; the job-level circuit breaker handles mass failure.
    if (retryWaitBudgetMs < delay) return res;
    retryWaitBudgetMs -= delay;
    await sleep(delay);
    res = await verifyPoolAsset(input, opts);
  }
  return res;
}

// ---------------------------------------------------------------------------
// verifyPoolAssetsBatch — verify MANY candidates for the SAME entity, using
// one Gemini call per PERSON_VERIFY_BATCH_MAX candidates (person path). This
// is the matcher pool-builders' fast path: ~120 per-candidate calls become
// ~15 batched calls, the reference photo uploads once per batch instead of
// once per candidate, and a 503 spike touches far fewer calls.
//
// All inputs MUST share projectId, entityType, and entityName (the matcher
// builds pools per entity, so this is the natural shape). Results align 1:1
// with inputs; errored entries should be parked and re-submitted later.
// Non-person entity types fall back to concurrent single verifies (they have
// no shared reference image to amortise).
// ---------------------------------------------------------------------------
export async function verifyPoolAssetsBatch(
  inputs: VerifyAssetInput[],
  opts: VerifyAssetOptions = {},
): Promise<PoolVerifyResult[]> {
  if (inputs.length === 0) return [];
  const first = inputs[0];
  const entityName = first.entityName.trim();
  const results: Array<PoolVerifyResult | null> = inputs.map(() => null);

  // Fast paths + in-process cache, per input (same rules as the single path).
  const pending: number[] = [];
  for (let i = 0; i < inputs.length; i++) {
    if (isFallbackEntity(inputs[i].entityType) || !entityName) {
      results[i] = skippedResult("celebrity_default fallback (no gate)", true, 1);
      continue;
    }
    const cached = cacheGet(cacheKeyFor(inputs[i]));
    if (cached) {
      results[i] = { ...cached, accept: policyAccept(cached.verdict, opts) };
      continue;
    }
    pending.push(i);
  }
  if (pending.length === 0) return results as PoolVerifyResult[];

  const refType = toReferenceEntityType(first.entityType);
  if (!refType) {
    for (const i of pending) {
      const out = skippedResult(`unknown entity type ${first.entityType}`, true);
      cacheSet(cacheKeyFor(inputs[i]), out);
      results[i] = out;
    }
    return results as PoolVerifyResult[];
  }

  // Persistent-cache read-through, one query for the whole batch.
  const dbHits = await dbGetVerdicts(refType, entityName, pending.map((i) => inputs[i].candidateUrl));
  const misses: number[] = [];
  for (const i of pending) {
    const hit = dbHits.get(inputs[i].candidateUrl);
    if (hit) {
      const out: PoolVerifyResult = {
        accept: policyAccept(hit.verdict, opts),
        verdict: hit.verdict,
        reason: hit.reason,
        confidence: hit.confidence,
        geminiCalled: false,
      };
      cacheSet(cacheKeyFor(inputs[i]), out);
      results[i] = out;
    } else {
      misses.push(i);
    }
  }
  if (misses.length === 0) return results as PoolVerifyResult[];

  // Non-person entities have no shared reference image — nothing to batch.
  // Run their singles concurrently (the single path handles caching/stats).
  if (first.entityType !== "person") {
    const singles = await Promise.all(misses.map((i) => verifyPoolAsset(inputs[i], opts)));
    misses.forEach((i, k) => { results[i] = singles[k]; });
    return results as PoolVerifyResult[];
  }

  // PERSON path — one reference lookup for the whole batch.
  const ref = await lookupReference(first.projectId, "person", entityName);
  if (!ref?.reference_url) {
    for (const i of misses) {
      const out = skippedResult("no reference image for person", opts.requireConfirmed ? false : true);
      cacheSet(cacheKeyFor(inputs[i]), out);
      results[i] = out;
    }
    return results as PoolVerifyResult[];
  }

  for (let start = 0; start < misses.length; start += PERSON_VERIFY_BATCH_MAX) {
    const chunk = misses.slice(start, start + PERSON_VERIFY_BATCH_MAX);
    const verdicts = await verifyPersonImagesCleanBatch({
      candidateUrls: chunk.map((i) => inputs[i].candidateUrl),
      referenceUrl: ref.reference_url,
      personName: entityName,
    });
    const toPersist: Array<{ candidateUrl: string; verdict: PoolVerdict; reason: string; confidence: number }> = [];
    chunk.forEach((i, k) => {
      const result = verdicts[k];
      const collapsed = collapsePersonClean(result);
      const out: PoolVerifyResult = {
        accept: policyAccept(collapsed.verdict, opts),
        verdict: collapsed.verdict,
        reason: collapsed.reason,
        confidence: result.confidence,
        geminiCalled: true,
        errored: result.errored || undefined,
      };
      recordOutcome(out);
      if (!result.errored) {
        cacheSet(cacheKeyFor(inputs[i]), out);
        toPersist.push({
          candidateUrl: inputs[i].candidateUrl,
          verdict: collapsed.verdict,
          reason: collapsed.reason,
          confidence: result.confidence,
        });
      }
      results[i] = out;
    });
    dbPutVerdicts("person", entityName, toPersist);
  }
  return results as PoolVerifyResult[];
}

// Test/operations helper — clears the per-process cache. Not used by the
// matcher; exported so tests and admin endpoints can force re-verification.
export function clearVerificationCache(): void {
  cache.clear();
}
