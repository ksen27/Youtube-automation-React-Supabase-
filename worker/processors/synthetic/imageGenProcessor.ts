import { getServerSupabase } from "@/lib/supabase/server";
import { setMediaJob, logJob } from "@/lib/jobs/db";
import type { ImageGenerationJobData } from "@/lib/jobs/queue";
import { uploadBuffer } from "@/lib/storage";
import { generateImage, plannedImageProvider, isCensored } from "@/lib/synthetic/sixtynine-labs";
import { regenerateSegmentPrompt } from "@/lib/synthetic/planner";
import { toLanguageCode } from "@/lib/i18n/locale";
import type { SyntheticBlockType } from "@/lib/types";
import { degradeImageLowFi } from "@/lib/synthetic/degrade";
import { logProviderCall } from "@/lib/synthetic/cost";
import { r2Keys } from "@/lib/synthetic/constants";
import { findReusableAsset, indexGeneratedAsset } from "@/lib/synthetic/asset-library";
import { finishSegment, maybeFinalizeSynthetic } from "@/worker/processors/synthetic/_shared";
import type { JobAttemptInfo } from "@/worker/index";
import { generateGeminiImage, isGeminiImageConfigured } from "@/lib/synthetic/gemini-image";
import { characterScenePrompt } from "@/lib/synthetic/character-blocks";
import { fetchOrThrow } from "@/lib/synthetic/http";

// THE NARRATOR APPEARS IN THE STORY (client 2026-08-26). On the handful of
// blocks the planner flagged `character_block`, the still is generated with the
// project's uploaded avatar photo as an IDENTITY REFERENCE, so the presenter's
// own face shows up as a character in the story rather than an anonymous
// stranger invented by the image model.
//
// This routes through Gemini because it is the ONLY configured model that
// accepts a reference image at all — the normal chain (ai33 / 69labs, both
// gpt-image-2) is text-to-image and has no slot for one.
//
// Every failure here falls back to the ordinary text-to-image path. A missing
// avatar, an unconfigured/geo-blocked Gemini, a budget cap, a safety refusal:
// none of them should cost the video a block. The shot simply shows an
// anonymous person, exactly as it did before this feature existed.
async function generateWithAvatarFace(input: {
  projectId: string;
  segmentId: string;
  mediaJobId: string;
  prompt: string;
  avatarImageUrl: string;
}): Promise<{ image: Buffer; contentType: string; provider: "gemini_image" } | null> {
  const { projectId, segmentId, mediaJobId, prompt, avatarImageUrl } = input;
  if (!isGeminiImageConfigured()) return null;
  try {
    const res = await fetchOrThrow(avatarImageUrl, { timeoutMs: 60_000 });
    const image = Buffer.from(await res.arrayBuffer());
    const mimeType = res.headers.get("content-type") || "image/jpeg";
    const out = await generateGeminiImage(characterScenePrompt(prompt), { image, mimeType });
    await logJob({ projectId, jobId: mediaJobId, sourceId: segmentId }, "synthetic.image_gen.character_block", {
      provider: out.provider,
      bytes: out.image.length,
    });
    return { image: out.image, contentType: out.contentType, provider: out.provider };
  } catch (e) {
    await logJob({ projectId, jobId: mediaJobId, sourceId: segmentId }, "synthetic.image_gen.character_block_failed", {
      err: (e as Error).message?.slice(0, 200),
      note: "falling back to the normal text-to-image path; the shot loses the avatar's face, not the block",
    });
    return null;
  }
}

// Image generation for 'image' and 'split_2' blocks (nano-banana, Flux
// fallback handled inside generateImage). For split_2 the generated still is
// the RIGHT half; the avatar video is composited on the left at render time, so
// it is stored as right_image_url. For 'image' it is the full-frame still.
//
// Failure policy: BullMQ retries (attempts=3) the whole job. Only on the FINAL
// exhausted attempt do we mark the segment 'failed' so the pipeline can
// finalize without it; mid-attempt failures just throw and let BullMQ retry.

// CENSORED RECOVERY. A content refusal is terminal at every layer below this
// one — no other key and no other provider will accept the same text (see
// isCensored) — so without this the block is simply lost and a human has to
// notice, open the review screen, and rewrite the prompt by hand.
//
// The refusal is a fact about the PROMPT, and we already have the machine that
// writes prompts. So: ask Gemini for a safe rewrite of THIS block (printing the
// refused text so it rewrites rather than re-rolls), persist it so the review
// screen shows what actually ran, and resubmit ONCE. Bounded to one rewrite per
// media job (`promptRewrittenForCensor`) — if the rewrite is refused too, the
// content is beyond an automatic fix and the block should fail loudly.
async function recoverFromCensoredPrompt(input: {
  projectId: string;
  mediaJobId: string;
  segmentId: string;
  blockType: SyntheticBlockType;
  script: string;
  basePrompt: string;
  refusedPrompt: string;
  onSubmit: (jobId: string, keyIdx: number) => Promise<void>;
  refusalMessage: string;
  // This job already spent its one free re-roll on a prior BullMQ attempt.
  alreadyResubmitted: boolean;
}) {
  const { projectId, mediaJobId, segmentId, blockType, script, basePrompt, refusedPrompt } = input;
  const sb = getServerSupabase();

  await logJob({ projectId, jobId: mediaJobId, sourceId: segmentId }, "synthetic.image_gen.censored", {
    err: input.refusalMessage.slice(0, 200),
    prompt: refusedPrompt.slice(0, 300),
  });

  // STEP 1 — RE-ROLL THE SAME PROMPT, ONCE.
  //
  // A refusal is not a fixed property of the text. Measured against the live
  // provider 2026-08-22, one prompt submitted six times:
  //     PASS  PASS  PASS  CENSORED  PASS  CENSORED
  // Borderline content is scored stochastically, so roughly a third of these
  // "blocked" blocks were never a wording problem at all — they were one
  // unlucky roll. And the pipeline never re-rolled: the refused provider job id
  // stays in this job's metadata, so BullMQ attempts 2 and 3 hit the resume
  // guard in generateImage and RE-POLL the dead job instead of resubmitting.
  // Every block therefore died on a single submit.
  //
  // So: clear the pointer and submit the same text again before spending a
  // Gemini call rewriting a prompt that may be perfectly generatable. Bounded to
  // one re-roll per media job, and only for CENSORED — a refusal that survives
  // two independent rolls is much more likely to be real, and that is when the
  // rewrite below earns its cost.
  if (!input.alreadyResubmitted) {
    await setMediaJob(mediaJobId, {
      metadata: { censorResubmitted: true, sixtynineJobId: null, sixtynineKeyIdx: null },
    });
    try {
      const retried = await generateImage(refusedPrompt, { jobId: "", keyIdx: -1, onSubmit: input.onSubmit });
      await logJob({ projectId, jobId: mediaJobId, sourceId: segmentId }, "synthetic.image_gen.censor_reroll_ok", {
        note: "same prompt passed on a second submit; the refusal was not about the text",
      });
      return retried;
    } catch (err) {
      // Anything OTHER than a second refusal is a real failure of this attempt
      // (timeout, auth, provider outage) and must not be masked by a prompt
      // rewrite — BullMQ retries those on their own terms.
      if (!isCensored(err)) throw err;
      await logJob({ projectId, jobId: mediaJobId, sourceId: segmentId }, "synthetic.image_gen.censor_reroll_failed", {
        note: "refused twice; escalating to a safe rewrite",
      });
    }
  }

  // The base prompt is stamped on every segment at plan time, but dispatchSegments
  // overwrites a segment's metadata once it generates — so THIS row may no longer
  // carry it. Fall back to a sibling (it is identical project-wide), exactly as
  // the review screen's Regenerate-prompt route does.
  let base = basePrompt;
  if (!base) {
    const { data: siblings } = await sb
      .from("synthetic_segments")
      .select("metadata")
      .eq("project_id", projectId)
      .not("metadata->base_prompt", "is", null)
      .limit(1);
    base = ((siblings?.[0]?.metadata as { base_prompt?: string } | null)?.base_prompt ?? "").trim();
  }
  const { data: proj } = await sb.from("projects").select("language").eq("id", projectId).single();

  const rewritten = await regenerateSegmentPrompt({
    projectId,
    jobId: mediaJobId,
    script,
    basePrompt: base,
    blockType,
    language: toLanguageCode(proj?.language as string | null),
    refusedPrompt,
  });
  const nextPrompt = rewritten.imagePrompt.trim();
  // A rewrite that came back identical would be refused identically; spending a
  // second generation on it only buys the same error more slowly.
  if (!nextPrompt || nextPrompt === refusedPrompt.trim()) {
    throw new Error(`image_gen: CENSORED and the safe rewrite was unchanged — edit the prompt manually. ${input.refusalMessage}`);
  }

  // Persist BEFORE resubmitting, so the review screen shows the prompt that
  // actually ran even if the retry dies, and so a BullMQ retry of this job
  // starts from the rewritten text.
  await sb.from("synthetic_segments").update({ image_prompt: nextPrompt }).eq("id", segmentId);
  await setMediaJob(mediaJobId, {
    metadata: { promptRewrittenForCensor: true, sixtynineJobId: null, sixtynineKeyIdx: null },
  });
  await logJob({ projectId, jobId: mediaJobId, sourceId: segmentId }, "synthetic.image_gen.prompt_rewritten", {
    prompt: nextPrompt.slice(0, 300),
  });

  // Fresh submit — the refused generation is dead, so a resume pointer would
  // only re-poll a job that will never complete.
  return generateImage(nextPrompt, { jobId: "", keyIdx: -1, onSubmit: input.onSubmit });
}

export async function processImageGenJob(
  data: ImageGenerationJobData,
  attempt?: JobAttemptInfo,
): Promise<void> {
  const { projectId, mediaJobId, segmentId } = data;
  const sb = getServerSupabase();
  const isFinalAttempt = (attempt?.attemptsMade ?? 1) >= (attempt?.attemptsAllowed ?? 1);

  await setMediaJob(mediaJobId, { status: "running", progress: 10, metadata: { segmentId } });

  // ZOMBIE-LOOP FIX: if a PRIOR attempt of this job already submitted a 69labs
  // generation (recorded here) but its poll timed out, resume polling THAT job
  // instead of submitting a new one — resubmitting stacks a second generation on
  // the same account and fills its 7-slot ceiling, which is what causes the
  // chronic "Concurrent limit reached (7)" 403 under load. Read the recorded
  // (jobId, keyIdx) off the media_job metadata (setMediaJob merges metadata, so
  // it survives across BullMQ attempts).
  const { data: jobRow } = await sb
    .from("media_jobs")
    .select("metadata")
    .eq("id", mediaJobId)
    .single();
  // promptRewrittenForCensor: this job already spent its ONE automatic safe
  // rewrite (see recoverFromCensoredPrompt). It survives across BullMQ attempts
  // with the rest of the metadata, so a retry can't rewrite the prompt again.
  const jobMeta = (jobRow?.metadata as {
    sixtynineJobId?: string;
    sixtynineKeyIdx?: number;
    promptRewrittenForCensor?: boolean;
    censorResubmitted?: boolean;
  } | null) ?? {};
  const resume = {
    // A prior attempt's recorded 69labs job, or ("", -1) when there's nothing to
    // resume — generateImage's canResume guard falls through to a fresh submit in
    // that case, and onSubmit persists the new (jobId, keyIdx) either way so the
    // NEXT attempt can resume it.
    jobId: jobMeta.sixtynineJobId ?? "",
    keyIdx: typeof jobMeta.sixtynineKeyIdx === "number" ? jobMeta.sixtynineKeyIdx : -1,
    onSubmit: async (jobId: string, keyIdx: number) => {
      await setMediaJob(mediaJobId, { metadata: { sixtynineJobId: jobId, sixtynineKeyIdx: keyIdx } });
    },
  };

  const { data: seg, error } = await sb
    .from("synthetic_segments")
    .select("id, block_type, image_prompt, script, metadata")
    .eq("id", segmentId)
    .single();
  if (error || !seg) throw new Error(`image_gen: segment ${segmentId} not found`);

  // Flagged by the planner (see character-blocks.ts) — this block's still should
  // show the project's avatar as the person in the scene.
  const isCharacterBlock = Boolean((seg.metadata as { character_block?: boolean } | null)?.character_block);

  // Resolve the picture prompt. NEVER fall back to seg.script — the script is
  // the SPOKEN narration, and drawing it verbatim is what produced literal,
  // off-topic stills (e.g. "Be honest, I read these." rendered as a person
  // reading). When the per-block prompt is missing, use the video's recurring
  // world (base_prompt, stashed by the planner) so the still is at least
  // on-topic. If neither exists, fail loudly so the segment is retryable rather
  // than silently mis-generated.
  const basePrompt = ((seg.metadata as { base_prompt?: string } | null)?.base_prompt ?? "").trim();
  const prompt = (seg.image_prompt?.trim() || basePrompt).trim();
  if (!prompt) throw new Error(`image_gen: segment ${segmentId} has no usable image prompt`);

  const isSplitBlock = seg.block_type === "split_2";

  // ASSET LIBRARY (migration 0030): before paying for a fresh still, look for
  // a close-enough prior generation (exact-hash or semantic match, gated by
  // ASSET_LIBRARY_REUSE_THRESHOLD; urls already used in THIS project are
  // excluded so one video never repeats an asset). On a hit we reuse its
  // permanent R2 url outright — no provider call, no upload. Disabled (or any
  // library error) falls straight through to the normal generate path.
  // A character block is skipped by the asset library on purpose: library
  // entries are keyed on the prompt text, and a match would hand back a still of
  // an ANONYMOUS person generated for some other project. The whole point of
  // this block is whose face is in it.
  const reuse = isCharacterBlock ? null : await findReusableAsset({ prompt, assetType: "image", projectId });
  if (reuse) {
    await logJob({ projectId, jobId: mediaJobId, sourceId: segmentId }, "synthetic.image_gen.reused", {
      via: reuse.via,
      similarity: Number(reuse.similarity.toFixed(4)),
      assetId: reuse.id,
    });
    await finishSegment(segmentId, {
      status: "ready",
      // Keep the ORIGINAL provider label (nano_banana etc.) so cost estimates
      // stay by-provider-correct; the reuse itself is visible in the log line
      // above and in generated_assets.reuse_count.
      provider: reuse.provider ?? "library_reuse",
      error: null,
      ...(isSplitBlock ? { right_image_url: reuse.assetUrl } : { image_url: reuse.assetUrl }),
    }, { via: reuse.via, similarity: reuse.similarity, assetId: reuse.id });
    await setMediaJob(mediaJobId, {
      status: "completed",
      progress: 100,
      metadata: { reusedFromLibrary: true, libraryAssetId: reuse.id, sixtynineJobId: null, sixtynineKeyIdx: null },
    });
    await maybeFinalizeSynthetic(projectId);
    return;
  }

  try {
    const t0 = Date.now();
    await logProviderCall({ projectId, jobId: mediaJobId, segmentId, provider: plannedImageProvider(), phase: "request" });
    // A CENSORED refusal is not retryable as-is (same text, same verdict, every
    // key and every provider), so it is caught HERE rather than left to BullMQ:
    // the only thing that can change the outcome is the prompt itself.
    let out;
    // Character blocks try the avatar-conditioned path FIRST. It returns null
    // on any problem (no avatar on the project, Gemini unconfigured or
    // geo-blocked, monthly cap reached, safety refusal), and the normal
    // text-to-image call below then runs exactly as it always has.
    const faceOut = isCharacterBlock
      ? await (async () => {
          const { data: proj } = await sb
            .from("projects").select("avatar_image_url").eq("id", projectId).single();
          const avatarImageUrl = (proj?.avatar_image_url as string | null)?.trim();
          if (!avatarImageUrl) return null;
          return generateWithAvatarFace({ projectId, segmentId, mediaJobId, prompt, avatarImageUrl });
        })()
      : null;
    try {
      out = faceOut ?? await generateImage(prompt, resume);
    } catch (err) {
      if (!isCensored(err) || jobMeta.promptRewrittenForCensor) throw err;
      out = await recoverFromCensoredPrompt({
        projectId,
        mediaJobId,
        segmentId,
        blockType: seg.block_type as SyntheticBlockType,
        script: (seg.script as string) ?? "",
        basePrompt,
        refusedPrompt: prompt,
        onSubmit: resume.onSubmit,
        refusalMessage: (err as Error).message ?? "",
        alreadyResubmitted: !!jobMeta.censorResubmitted,
      });
    }
    await logProviderCall({
      projectId, jobId: mediaJobId, segmentId,
      provider: out.provider, phase: "response",
      durationMs: Date.now() - t0, cost: { provider: out.provider, images: 1 },
    });

    // Low-fi "vlogging" degrade (keeps dimensions, lowers texture quality) so
    // the still reads as real phone footage instead of a clean AI render.
    const deg = await degradeImageLowFi(out.image);

    // Versioned key (timestamp) so a regenerate writes a NEW file and the prior
    // version survives in R2 for the review screen's history. finishSegment
    // archives the previous URL into asset_history.
    const version = Date.now();
    const key = isSplitBlock
      ? r2Keys.segmentRightImage(projectId, segmentId, version)
      : r2Keys.segmentImage(projectId, segmentId, version);
    const up = await uploadBuffer(deg.image, key, deg.degraded ? deg.contentType : out.contentType);

    await finishSegment(segmentId, {
      status: "ready",
      provider: out.provider,
      error: null, // clear any prior-attempt / stall-sweep error on success
      ...(isSplitBlock ? { right_image_url: up.publicUrl } : { image_url: up.publicUrl }),
    });
    // Index the fresh still into the cross-project asset library so future
    // videos with a matching prompt can reuse it. Best-effort — never fails
    // the segment (indexGeneratedAsset catches its own errors), and a no-op
    // when ASSET_LIBRARY_ENABLED is off.
    // NEVER index a character block. The library is cross-PROJECT and keyed on
    // prompt text, so indexing this would let another customer's video reuse a
    // still containing THIS project's avatar's face — a privacy problem, and
    // wrong for the reusing video too, whose narrator is someone else.
    if (!isCharacterBlock) {
      await indexGeneratedAsset({
        prompt,
        assetType: "image",
        assetUrl: up.publicUrl,
        provider: out.provider,
        projectId,
        segmentId,
      });
    }
    // Clear the resume pointer on success so a later regenerate of this segment
    // starts a fresh generation instead of re-polling this now-consumed job.
    await setMediaJob(mediaJobId, {
      status: "completed",
      progress: 100,
      metadata: { provider: out.provider, sixtynineJobId: null, sixtynineKeyIdx: null },
    });
  } catch (err) {
    await logJob({ projectId, jobId: mediaJobId, sourceId: segmentId }, "synthetic.image_gen.failed", {
      err: (err as Error).message?.slice(0, 200),
      isFinalAttempt,
    });
    if (isFinalAttempt) {
      await finishSegment(segmentId, { status: "failed", error: (err as Error).message?.slice(0, 300) });
      await setMediaJob(mediaJobId, { status: "failed", progress: 100, error: (err as Error).message });
      await maybeFinalizeSynthetic(projectId);
      return; // swallow on final attempt so the project can finalize
    }
    throw err; // let BullMQ retry
  }

  await maybeFinalizeSynthetic(projectId);
}
