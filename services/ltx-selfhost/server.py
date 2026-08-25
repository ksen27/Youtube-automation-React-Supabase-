# Self-hosted LTX-2.5 image-to-video service.
#
# WHY THIS EXISTS
# ---------------
# lib/synthetic/ltx.ts talks to api.ltx.video and bills ~$0.04/sec of generated
# video (PRICE_TABLE.ltx2 in lib/synthetic/cost.ts). This service runs the
# open-weights LTX-2.5 checkpoint on our own GPU instead, so the marginal cost of
# a clip becomes GPU time rather than a per-second API fee.
#
# THE CONTRACT IS DELIBERATELY IDENTICAL TO api.ltx.video/v2
# ----------------------------------------------------------
# ltx.ts already reads its endpoint from LTX_BASE_URL (lib/env.ts), so if this
# service speaks the SAME three-call lifecycle the app needs NO code change --
# cutover is one env var, and rollback is the same env var pointed back:
#
#   1. POST /v2/image-to-video       -> { id, created_at }
#   2. GET  /v2/image-to-video/{id}  -> { status: pending|processing|completed|failed, result }
#   3. GET  result.video_url         -> the mp4 bytes
#
# Every field name here (image_uri, prompt, model, duration, resolution, fps,
# result.video_url) is chosen to match what ltx.ts already sends and parses.
# Do not "improve" these names -- they are an external contract.
#
# AUDIO IS DISCARDED ON PURPOSE
# -----------------------------
# LTX-2.5's headline feature is synchronized audio, but the renderer strips clip
# audio anyway (keepAudio:false -- the voiceover is the master track), so we drop
# the audio return value and never encode it. That is also why the pipeline call
# below does not pay for an audio VAE decode.
#
# CONCURRENCY: ONE JOB AT A TIME, ON PURPOSE
# ------------------------------------------
# At 1080p the 22B transformer needs most of the card, so a second concurrent
# generation would OOM or thrash rather than double throughput. Requests are
# accepted immediately (returning a job id, exactly like the real API) and served
# by a single background worker draining a FIFO queue. The app-side parallelism
# (IMAGE_TO_VIDEO_CONCURRENCY=3) therefore becomes queue depth here, NOT
# concurrent GPU work -- to actually run 3 clips at once, run 3 of these
# processes on 3 GPUs behind one load balancer.

import asyncio
import os
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any, Literal

import imageio
import numpy as np
import requests
import torch
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from PIL import Image

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

# The bearer token callers must present. This is OUR token -- unlike the real
# LTX API there is nobody to issue us a key, so we mint one and hand the same
# value to the app as LTX_API_KEY. Generated with `openssl rand -hex 32`.
API_TOKEN = os.environ["LTX_SELFHOST_TOKEN"]

# Public origin this service is reachable at, used to build result.video_url.
# On RunPod this is https://<POD_ID>-<PORT>.proxy.runpod.net -- the app must be
# able to GET that URL to download the finished mp4.
PUBLIC_BASE_URL = os.environ["LTX_SELFHOST_PUBLIC_URL"].rstrip("/")

MODEL_ID = os.environ.get("LTX_SELFHOST_MODEL_ID", "Lightricks/LTX-2.5-Diffusers")
OUT_DIR = os.environ.get("LTX_SELFHOST_OUT_DIR", "/workspace/ltx/out")

# Finished mp4s are served from disk; prune them so the volume does not fill.
# The app downloads each clip immediately after the job completes, so an hour is
# generous. (Set 0 to keep everything -- useful while benchmarking.)
RESULT_TTL_SECONDS = int(os.environ.get("LTX_SELFHOST_RESULT_TTL", "3600"))

# Memory levers. See _load_pipeline for the measurement that made these the
# defaults rather than an opt-in low-VRAM path.
# DEFAULT ON. See the ATTENTION_SLICING note above: turning this off measured
# SLOWER, not faster.
VAE_TILING = os.environ.get("LTX_SELFHOST_VAE_TILING", "1") not in ("0", "false", "")
CPU_OFFLOAD = os.environ.get("LTX_SELFHOST_CPU_OFFLOAD", "0") not in ("0", "false", "")

# TWO-STAGE GENERATION -- the only economically viable path at 1080p.
#
# MEASURED 2026-08-21 on a 96GB RTX PRO 6000, one 6s/1080p clip:
#   native 1080p, weights resident  -> CUDA OOM (needed 2.49 GiB more than existed)
#   native 1080p, CPU offload       -> 673.2s  = $0.372/clip  (WORSE than the $0.24 API)
#   two-stage 960x544 -> x2 upscale ->  77.1s  = $0.043/clip  (5.6x CHEAPER than the API)
#
# Stage 1 renders at quarter area, which is what keeps the 22B weights resident
# on the card; stage 2 runs the latent upsampler Lightricks ships alongside the
# model. Turning this off means native 1080p, which does not fit -- it exists as
# a switch only for lower target resolutions where one stage does fit.
TWO_STAGE = os.environ.get("LTX_SELFHOST_TWO_STAGE", "1") not in ("0", "false", "")

# Two-stage is a WORKAROUND FOR THE OOM, not a quality feature -- it costs real
# detail, because stage 1 renders at half each dimension and the upsampler invents
# the rest. So only take that hit when a native render genuinely will not fit.
#
# 1920x1080 = 2,073,600 px  -> does not fit (OOM'd by 2.49 GiB) -> two-stage
# 1280x720  =   921,600 px  -> fits natively                    -> ONE stage
#
# Applying two-stage at 720p meant generating at 640x384 and upscaling, which is
# visibly softer than a real 1280x720 render for no benefit. The threshold sits
# between the two so 1080p still routes through the upscaler.
TWO_STAGE_MIN_PIXELS = int(os.environ.get("LTX_SELFHOST_TWO_STAGE_MIN_PIXELS", str(1280 * 720 + 1)))

# TEXT-ENCODER OFFLOAD — the lever aimed squarely at the 2.49 GiB OOM.
#
# THE MEASUREMENT THIS IS BUILT ON (2026-08-21, recorded above): a native 1080p
# render asked for 2.49 GiB more than the card had, with 92.68 of 94.97 GiB
# already resident. Only 2.49. Every fix tried for it was a blunt instrument --
# full CPU offload (673s/clip, worse than the API), FP8 (unproven on quality),
# two-stage (costs real detail by construction) -- and the cheap targeted one was
# never tried: LTX-2's text encoder is a multi-GiB T5-class model that runs ONCE
# per clip, to turn the prompt into embeddings, and then sits on the card doing
# nothing for the entire denoising loop that OOMs.
#
# accelerate's cpu_offload keeps its weights in host RAM and streams them in for
# that single forward pass. The cost is a few seconds per clip on a ~77s job; the
# prize is native 1080p, which is the ONLY path to matching the pre-cutover
# api.ltx.video quality on our own GPU. Two-stage 1080p cannot get there: it
# generates 960x544 = 522k real pixels, which is LESS than native 720p's 922k.
#
# UNVERIFIED — this has not been run on the pod. It is written to be switched off
# in one env var precisely because f926156 shipped a GPU change unverified and
# the client is still living with the result. Verify before customer output:
#   LTX_SELFHOST_TEXT_ENCODER_OFFLOAD=1 LTX_SELFHOST_TWO_STAGE_MIN_PIXELS=2073601 \
#     python benchmark.py --resolution 1920x1080 --duration 4
# and confirm (a) it does not OOM, (b) the clip is sharper than the 720p one.
TEXT_ENCODER_OFFLOAD = os.environ.get("LTX_SELFHOST_TEXT_ENCODER_OFFLOAD", "0") not in ("0", "false", "")

# Sampling steps. The distilled checkpoint ships a fixed few-step sigma schedule
# (DISTILLED_SIGMA_VALUES) and that is what makes a clip cost $0.043 instead of
# $0.24. Raising it is the other quality lever, and unlike resolution it is a
# smooth dial: set a count here to subdivide the distilled schedule and trade
# wall-clock for detail. Empty = the distilled schedule exactly as shipped, which
# is the measured-cost configuration.
#
# NOTE it is NOT a like-for-like comparison with the API: api.ltx.video's
# ltx-2-3-fast is itself a fast/distilled variant, so steps are probably NOT the
# delta between the two lanes. Resolution is. Try resolution first.
STEPS_OVERRIDE = int(os.environ.get("LTX_SELFHOST_STEPS", "0") or 0)

# Slice attention into chunks instead of materialising it whole. Trades speed for
# peak memory; the point is to make a NATIVE 1080p render fit so we can stop
# upscaling from 960x544.
# DEFAULT ON -- and MEASURED, not assumed. Slicing/tiling look like pure speed
# costs (both compute in chunks to cut peak memory), so on 2026-08-21 they were
# switched off at 720p expecting a speedup. The OPPOSITE happened: a 4s clip went
# 76.2s -> 88.1s/88.2s across two warm runs. Best explanation is allocator
# pressure -- the unchunked path allocates far larger transients, and the churn
# costs more than the chunking saves. Leave both on unless a controlled
# experiment says otherwise.
ATTENTION_SLICING = os.environ.get("LTX_SELFHOST_ATTENTION_SLICING", "1") not in ("0", "false", "")

# x264 preset for the intermediate encode. See the note at the mimwrite call.
#
# veryfast -> slow (client 2026-08-22: "the amount of the action part, the
# quality is not good / blur and not clear"). The preset governs MOTION
# ESTIMATION effort, which CRF does not: at veryfast the encoder barely searches
# for motion between frames, so artifacts concentrate exactly where things move
# while the static background stays clean -- which is the artifact as described.
# These clips are short intermediates the renderer re-encodes into a 4K export,
# so smearing introduced here is baked in and then magnified by the upscale.
# Encode is a small share of a ~48s clip; buying motion quality with a few
# seconds of it is the right trade.
ENCODE_PRESET = os.environ.get("LTX_SELFHOST_ENCODE_PRESET", "slow")

# torch.compile the transformer. Fuses kernels and removes Python dispatch
# overhead; the cost is a one-off compile on the FIRST generation after boot
# (minutes, not seconds) and a RECOMPILE whenever the input shape changes.
# That makes it a good fit for us specifically because the client settled on one
# shape -- 1280x720, 4s, 25fps -- so after the first clip every subsequent clip
# reuses the same graph. It would be a poor trade if resolutions varied per clip.
COMPILE = os.environ.get("LTX_SELFHOST_COMPILE", "0") not in ("0", "false", "")
COMPILE_MODE = os.environ.get("LTX_SELFHOST_COMPILE_MODE", "max-autotune-no-cudagraphs")

# FP8 weight+activation quantisation of the transformer via torchao. Blackwell
# (this card) has hardware FP8, and LTX document FP8 as natively supported with
# ~40% less VRAM. Two reasons to want it: speed, and the headroom that could make
# a NATIVE 1080p render fit -- the thing that OOM'd by only 2.49 GiB.
# UNPROVEN ON QUALITY: quantisation is lossy, so a clip must be eyeballed against
# a bf16 one before this goes anywhere near production output.
FP8_QUANT = os.environ.get("LTX_SELFHOST_FP8", "0") not in ("0", "false", "")

# LTX generates in latent space at a fixed temporal compression, so frame counts
# must satisfy num_frames % 8 == 1. Requesting anything else silently changes the
# clip length, which would desync it from the block's spoken-time window.
FRAME_MULTIPLE = 8

# Height/width must be divisible by 32. 1080 is not (1080/32 = 33.75), so we
# generate at 1088 and crop the extra 8 rows off the bottom. The renderer
# re-encodes anyway, but returning a non-1080 height would be a surprise.
DIM_MULTIPLE = 32

os.makedirs(OUT_DIR, exist_ok=True)


def _round_frames(seconds: float, fps: int) -> int:
    """Frame count for `seconds` at `fps`, snapped UP to the next 8n+1.

    Rounding up rather than to-nearest guarantees the clip is never SHORTER than
    the block it has to cover -- a short clip leaves a gap in the timeline, while
    a few extra frames are simply trimmed at render time.
    """
    raw = max(1, int(round(seconds * fps)))
    n = -(-(raw - 1) // FRAME_MULTIPLE)  # ceil((raw-1)/8)
    return n * FRAME_MULTIPLE + 1


def _round_dim(v: int) -> int:
    """Snap a pixel dimension up to the next multiple of 32."""
    return -(-v // DIM_MULTIPLE) * DIM_MULTIPLE


def _parse_resolution(res: str) -> tuple[int, int]:
    """'1920x1080' -> (1920, 1080). Falls back to 1080p on anything unparseable."""
    try:
        w, h = res.lower().split("x")
        return int(w), int(h)
    except Exception:
        return 1920, 1080


# ---------------------------------------------------------------------------
# Job store
# ---------------------------------------------------------------------------
# In-memory only. A restart loses in-flight jobs -- acceptable because ltx.ts
# already treats a poll failure as a transient error and falls through to the
# fal.ai Veo/Kling chain (generateClipWithFallback), so a lost job degrades to
# the existing fallback rather than failing the segment.

JobStatus = Literal["pending", "processing", "completed", "failed"]


class Job:
    def __init__(self, job_id: str, params: dict[str, Any]):
        self.id = job_id
        self.params = params
        self.status: JobStatus = "pending"
        self.created_at = time.time()
        self.finished_at: float | None = None
        self.video_path: str | None = None
        self.error: str | None = None


JOBS: dict[str, Job] = {}
QUEUE: asyncio.Queue[str] = asyncio.Queue()
PIPE = None  # loaded once at startup
UPSAMPLER = None  # stage-2 pipeline; None when TWO_STAGE is off


# ---------------------------------------------------------------------------
# Generation
# ---------------------------------------------------------------------------


def _load_pipeline():
    """Load LTX-2.5 onto the GPU once, at startup.

    Loading is slow (~66 GiB of weights off the network volume), so it happens
    during app startup rather than on the first request -- otherwise the first
    clip of every restart would look like a multi-minute stall to the caller.
    """
    from diffusers import LTX2ImageToVideoPipeline

    pipe = LTX2ImageToVideoPipeline.from_pretrained(MODEL_ID, dtype=torch.bfloat16)

    # MEASURED 2026-08-21 on a 96GB RTX PRO 6000: the bf16 weights alone sit at
    # ~68GB resident, and a 151-frame 1080p generation then OOMs -- it asked for
    # another 2.49 GiB with 92.68 of 94.97 GiB already in use. Native 1080p does
    # NOT fit on a 96GB card without help, so the memory levers below are on by
    # default rather than being an exotic low-VRAM path.
    if CPU_OFFLOAD:
        # Streams each submodule to the GPU only while it runs. Biggest memory
        # win, real speed cost -- the fallback when tiling alone is not enough.
        pipe.enable_model_cpu_offload()
    else:
        pipe.to("cuda")

    if TEXT_ENCODER_OFFLOAD and not CPU_OFFLOAD:
        # Only meaningful when the rest of the pipeline is resident: with
        # CPU_OFFLOAD on, accelerate is already streaming every submodule and
        # adding a second set of hooks to one of them would just fight it.
        try:
            from accelerate import cpu_offload

            cpu_offload(pipe.text_encoder, execution_device=torch.device("cuda"))
            print('{"msg":"ltx_selfhost.text_encoder_offloaded"}', flush=True)
        except Exception as e:  # noqa: BLE001 - never let a memory tweak stop startup
            print(
                '{"msg":"ltx_selfhost.text_encoder_offload_failed","err":"%s"}' % str(e)[:200],
                flush=True,
            )

    if VAE_TILING:
        # Tiling decodes the frame stack in pieces instead of allocating it whole.
        # Note: on its own this did NOT rescue native 1080p -- the OOM is in the
        # transformer, not the VAE -- but it keeps stage 2's decode affordable.
        try:
            pipe.vae.enable_tiling()
        except AttributeError:
            pass
        try:
            pipe.vae.enable_slicing()
        except AttributeError:
            pass

    if FP8_QUANT:
        # Quantise BEFORE compiling: torch.compile traces the module as it finds
        # it, so swapping layers afterwards would invalidate the compiled graph.
        from torchao.quantization import float8_dynamic_activation_float8_weight, quantize_

        quantize_(pipe.transformer, float8_dynamic_activation_float8_weight())
        print('{"msg":"ltx_selfhost.fp8_quantised"}', flush=True)

    if COMPILE:
        # Only the transformer: it is the overwhelming majority of the compute,
        # and compiling the VAE/text encoder too multiplies compile time for
        # little return. dynamic=False pins the shape so we get a specialised
        # graph rather than a generic one.
        pipe.transformer = torch.compile(pipe.transformer, mode=COMPILE_MODE, dynamic=False)
        print('{"msg":"ltx_selfhost.compiled","mode":"%s"}' % COMPILE_MODE, flush=True)

    if ATTENTION_SLICING and not COMPILE:
        # Slicing runs attention in a Python loop, which forces graph breaks and
        # undoes much of what compiling buys. When compiling, skip it -- the
        # compiled path manages memory better anyway. (Measured separately:
        # WITHOUT compile, slicing is a net WIN here -- see the note above.)
        try:
            pipe.enable_attention_slicing("max")
        except AttributeError:
            pass

    ups = None
    if TWO_STAGE:
        # latent_upsampler is a subfolder component and is deliberately NOT in the
        # root model_index.json (that index describes LTX2Pipeline), so
        # from_pretrained on the repo root cannot find it -- load the module
        # directly and construct the pipeline around the ALREADY-RESIDENT vae so
        # we do not pay for a second copy of it.
        from diffusers import LTX2LatentUpsamplePipeline
        from diffusers.pipelines.ltx2.latent_upsampler import LTX2LatentUpsamplerModel

        lu = LTX2LatentUpsamplerModel.from_pretrained(
            MODEL_ID, subfolder="latent_upsampler", torch_dtype=torch.bfloat16
        )
        ups = LTX2LatentUpsamplePipeline(vae=pipe.vae, latent_upsampler=lu)
        try:
            ups.vae.enable_tiling()
        except AttributeError:
            pass
        ups.to(device="cuda", dtype=torch.bfloat16)
    return pipe, ups


def _download_image(url: str) -> Image.Image:
    """Fetch the source still. `image_uri` is a public R2 URL (see ltx.ts)."""
    resp = requests.get(url, timeout=60)
    resp.raise_for_status()
    from io import BytesIO

    return Image.open(BytesIO(resp.content)).convert("RGB")


def _generate(job: Job) -> str:
    """Run one image-to-video generation. Returns the written mp4 path."""
    from diffusers.pipelines.ltx2.utils import (
        DEFAULT_NEGATIVE_PROMPT,
        DISTILLED_SIGMA_VALUES,
        STAGE_2_DISTILLED_SIGMA_VALUES,
    )

    # Hand back reserved-but-unallocated blocks before the largest allocation of
    # the job -- see the note above _generate. A 1080p render OOM'd by 78 MiB
    # while 3.03 GiB sat reserved and unused.
    try:
        torch.cuda.empty_cache()
    except Exception:  # noqa: BLE001 - a memory hint must never fail a render
        pass

    p = job.params
    width, height = _parse_resolution(p["resolution"])
    fps = int(p["fps"])
    num_frames = _round_frames(float(p["duration"]), fps)

    # With two-stage on, stage 1 renders at HALF each dimension and the upsampler
    # doubles it back: 1920x1080 -> generate 960x544 -> upscale 1920x1088 -> crop
    # to 1080. Halving before rounding (not after) keeps the upscaled result at
    # or above the requested size so the crop never has to pad.
    use_two_stage = (
        TWO_STAGE and UPSAMPLER is not None and (width * height) >= TWO_STAGE_MIN_PIXELS
    )
    if use_two_stage:
        gen_w, gen_h = _round_dim((width + 1) // 2), _round_dim((height + 1) // 2)
    else:
        gen_w, gen_h = _round_dim(width), _round_dim(height)

    image = _download_image(p["image_uri"])
    negative = p.get("negative_prompt") or DEFAULT_NEGATIVE_PROMPT

    # THE OFFICIAL LTX-2.5 DISTILLED PIPELINE IS THREE PARTS, NOT TWO.
    #
    # Corrected 2026-08-25 against Lightricks' own documented workflow
    # (huggingface.co/docs/diffusers/main/en/api/pipelines/ltx2):
    #
    #   1. generate at HALF resolution on the distilled sigma schedule, keeping
    #      LATENTS (not decoded pixels);
    #   2. latent x2 upsample;
    #   3. REFINE at FULL resolution -- 3 steps on STAGE_2_DISTILLED_SIGMA_VALUES,
    #      re-noised to STAGE_2[0], guidance 1.0.
    #
    # This service implemented 1 and 2 and stopped. Step 3 is the one that puts
    # the detail back, so its absence is why "two-stage" output looked soft and
    # why the code above it concluded two-stage "costs real detail" -- a verdict
    # drawn from a pipeline missing its refinement pass. Lightricks document the
    # full three-part flow as producing BETTER quality than single-stage, and it
    # is almost certainly what api.ltx.video runs.
    #
    # Staying in latent space between 1 and 2 also removes a lossy VAE
    # round-trip: the old code decoded to PIL, upsampled pixels, and re-encoded.
    #
    # NOTE ON STEPS: the distilled checkpoint is driven by an EXPLICIT SIGMA
    # SCHEDULE, not a step count -- [1.0, 0.99375, 0.9875, 0.98125, 0.975,
    # 0.909375, 0.725, 0.421875], five fine steps near 1.0 then three large
    # drops. The docs warn that passing num_inference_steps "would hand the model
    # a generic linear schedule and quietly cost quality". An earlier attempt
    # here interpolated that schedule to 20 points and produced structurally
    # melted faces. Do NOT reintroduce a steps knob for the distilled model; the
    # count is fixed at 8 by the checkpoint.
    if use_two_stage:
        # Stage 1 -- half resolution, latents out.
        video_latent, audio_latent = PIPE(
            image=image,
            prompt=p["prompt"],
            negative_prompt=negative,
            height=gen_h,
            width=gen_w,
            num_frames=num_frames,
            frame_rate=fps,
            # THE FULL DISTILLED PARAMETER SET -- all of it, not just guidance_scale.
            #
            # Root cause of the client's 2026-08-25 report ("the not action part is
            # good but the around action part such as body is not good"), found by
            # reading the pipeline's own gate properties:
            #
            #   do_classifier_free_guidance    = guidance_scale > 1 or audio_guidance_scale > 1
            #   do_spatio_temporal_guidance    = stg_scale > 0 or audio_stg_scale > 0
            #   do_modality_isolation_guidance = modality_scale > 1 or audio_modality_scale > 1
            #
            # This service passed ONLY guidance_scale=1.0 and left the rest at their
            # NON-distilled defaults (audio_guidance_scale=7.0, stg_scale=1.0,
            # modality_scale=3.0). So every gate evaluated TRUE and the distilled
            # checkpoint ran with all three guidance mechanisms active.
            #
            # STG is the one that shows: it is Spatio-Temporal Guidance, applied at
            # transformer block 28, and its delta
            #     video_stg_delta = stg_scale * (pred - pred_uncond_stg)
            # is added to the prediction at every step. It perturbs the TEMPORAL
            # pathway specifically -- which is why static regions were clean and
            # anything in motion degraded.
            #
            # Cost, too: CFG doubles the batch and STG/modality each add a forward
            # pass, so a "distilled 8-step" render was doing 3-4x the compute it
            # should. Turning them off makes it faster AND correct.
            #
            # NOTE: with CFG off the negative_prompt is unused -- the distilled model
            # is trained for unguided sampling. It is still passed so that flipping
            # guidance back on for an experiment needs no other change.
            guidance_scale=1.0,
            audio_guidance_scale=1.0,
            stg_scale=0.0,
            audio_stg_scale=0.0,
            modality_scale=1.0,
            audio_modality_scale=1.0,
            sigmas=DISTILLED_SIGMA_VALUES,
            output_type="latent",
            return_dict=False,
        )

        # Latent x2 upsample. width/height here are STAGE 1's dimensions -- the
        # upsampler doubles them internally, so passing the target size would
        # yield a 4K frame and OOM the decode.
        upscaled_latent = UPSAMPLER(
            latents=video_latent,
            width=gen_w,
            height=gen_h,
            output_type="latent",
            return_dict=False,
        )[0]

        # Stage 3 -- refinement at full resolution. Only 3 steps, so this costs a
        # fraction of a full-resolution generation while working at full detail.
        video, _audio = PIPE(
            image=image,
            latents=upscaled_latent,
            audio_latents=audio_latent,
            prompt=p["prompt"],
            negative_prompt=negative,
            num_frames=num_frames,
            frame_rate=fps,
            # THE FULL DISTILLED PARAMETER SET -- all of it, not just guidance_scale.
            #
            # Root cause of the client's 2026-08-25 report ("the not action part is
            # good but the around action part such as body is not good"), found by
            # reading the pipeline's own gate properties:
            #
            #   do_classifier_free_guidance    = guidance_scale > 1 or audio_guidance_scale > 1
            #   do_spatio_temporal_guidance    = stg_scale > 0 or audio_stg_scale > 0
            #   do_modality_isolation_guidance = modality_scale > 1 or audio_modality_scale > 1
            #
            # This service passed ONLY guidance_scale=1.0 and left the rest at their
            # NON-distilled defaults (audio_guidance_scale=7.0, stg_scale=1.0,
            # modality_scale=3.0). So every gate evaluated TRUE and the distilled
            # checkpoint ran with all three guidance mechanisms active.
            #
            # STG is the one that shows: it is Spatio-Temporal Guidance, applied at
            # transformer block 28, and its delta
            #     video_stg_delta = stg_scale * (pred - pred_uncond_stg)
            # is added to the prediction at every step. It perturbs the TEMPORAL
            # pathway specifically -- which is why static regions were clean and
            # anything in motion degraded.
            #
            # Cost, too: CFG doubles the batch and STG/modality each add a forward
            # pass, so a "distilled 8-step" render was doing 3-4x the compute it
            # should. Turning them off makes it faster AND correct.
            #
            # NOTE: with CFG off the negative_prompt is unused -- the distilled model
            # is trained for unguided sampling. It is still passed so that flipping
            # guidance back on for an experiment needs no other change.
            guidance_scale=1.0,
            audio_guidance_scale=1.0,
            stg_scale=0.0,
            audio_stg_scale=0.0,
            modality_scale=1.0,
            audio_modality_scale=1.0,
            sigmas=STAGE_2_DISTILLED_SIGMA_VALUES,
            noise_scale=STAGE_2_DISTILLED_SIGMA_VALUES[0],
            output_type="np",
            return_dict=False,
        )
    else:
        # Single stage: the target already fits, so generate straight at it.
        video, _audio = PIPE(
            image=image,
            prompt=p["prompt"],
            negative_prompt=negative,
            height=gen_h,
            width=gen_w,
            num_frames=num_frames,
            frame_rate=fps,
            # THE FULL DISTILLED PARAMETER SET -- all of it, not just guidance_scale.
            #
            # Root cause of the client's 2026-08-25 report ("the not action part is
            # good but the around action part such as body is not good"), found by
            # reading the pipeline's own gate properties:
            #
            #   do_classifier_free_guidance    = guidance_scale > 1 or audio_guidance_scale > 1
            #   do_spatio_temporal_guidance    = stg_scale > 0 or audio_stg_scale > 0
            #   do_modality_isolation_guidance = modality_scale > 1 or audio_modality_scale > 1
            #
            # This service passed ONLY guidance_scale=1.0 and left the rest at their
            # NON-distilled defaults (audio_guidance_scale=7.0, stg_scale=1.0,
            # modality_scale=3.0). So every gate evaluated TRUE and the distilled
            # checkpoint ran with all three guidance mechanisms active.
            #
            # STG is the one that shows: it is Spatio-Temporal Guidance, applied at
            # transformer block 28, and its delta
            #     video_stg_delta = stg_scale * (pred - pred_uncond_stg)
            # is added to the prediction at every step. It perturbs the TEMPORAL
            # pathway specifically -- which is why static regions were clean and
            # anything in motion degraded.
            #
            # Cost, too: CFG doubles the batch and STG/modality each add a forward
            # pass, so a "distilled 8-step" render was doing 3-4x the compute it
            # should. Turning them off makes it faster AND correct.
            #
            # NOTE: with CFG off the negative_prompt is unused -- the distilled model
            # is trained for unguided sampling. It is still passed so that flipping
            # guidance back on for an experiment needs no other change.
            guidance_scale=1.0,
            audio_guidance_scale=1.0,
            stg_scale=0.0,
            audio_stg_scale=0.0,
            modality_scale=1.0,
            audio_modality_scale=1.0,
            sigmas=DISTILLED_SIGMA_VALUES,
            output_type="np",
            return_dict=False,
        )

    frames = np.asarray(video)
    # Both paths can hand back a BATCH: (B, F, H, W, C). The two-stage branch
    # already indexes [0] off the upsampler's return, but the single-stage branch
    # gets the batch straight from the pipeline -- and a 5-D array reaches the
    # encoder as "Image must have 1, 2, 3 or 4 channels". Normalise here so the
    # encode path never has to care which branch produced the frames.
    if frames.ndim == 5:
        frames = frames[0]
    if frames.dtype != np.uint8:
        frames = (np.clip(frames, 0.0, 1.0) * 255).astype(np.uint8)
    # Crop back to the REQUESTED size (1088 -> 1080); generation had to round up
    # to a multiple of 32.
    frames = frames[:, :height, :width, :]

    out_path = os.path.join(OUT_DIR, f"{job.id}.mp4")
    # yuv420p + even dimensions keeps the output playable by ffmpeg/browsers,
    # which matters because the render pipeline re-encodes these clips.
    # CRF 18 rather than imageio's `quality=` shorthand: this clip is an
    # INTERMEDIATE that the render pipeline re-encodes downstream, so compression
    # artifacts introduced here get baked in and then re-compressed. Near-visually-
    # lossless at this stage costs a few MB and keeps the generation's real detail
    # intact for the final export.
    imageio.mimwrite(
        out_path,
        frames,
        fps=fps,
        codec="libx264",
        macro_block_size=1,
        # `veryfast` rather than `medium`: preset trades ENCODE SPEED for file
        # size at a FIXED quality (that is CRF's job), and this clip is a
        # short-lived intermediate the renderer re-encodes anyway. Measured
        # 2026-08-21: encode + array conversion was ~41s of a 118s end-to-end
        # clip, so the preset is worth real wall-clock here and costs us only a
        # few MB on a file that is deleted within the hour.
        ffmpeg_params=["-pix_fmt", "yuv420p", "-crf", "18", "-preset", ENCODE_PRESET],
    )
    return out_path


async def _worker():
    """Single consumer draining the job queue. One generation at a time."""
    while True:
        job_id = await QUEUE.get()
        job = JOBS.get(job_id)
        if job is None:
            QUEUE.task_done()
            continue
        job.status = "processing"
        started = time.time()
        try:
            # The pipeline is blocking CPU/GPU work; run it off the event loop so
            # status polls stay responsive while a clip renders.
            job.video_path = await asyncio.to_thread(_generate, job)
            job.status = "completed"
            print(
                f'{{"msg":"ltx_selfhost.completed","job":"{job.id}",'
                f'"seconds":{job.params["duration"]},"took_s":{time.time() - started:.1f}}}',
                flush=True,
            )
        except Exception as exc:  # noqa: BLE001 - surface any failure to the caller
            job.status = "failed"
            job.error = str(exc)[:300]
            print(
                f'{{"msg":"ltx_selfhost.failed","job":"{job.id}","err":"{job.error}"}}',
                flush=True,
            )
        finally:
            job.finished_at = time.time()
            QUEUE.task_done()
            _prune()


def _prune() -> None:
    """Drop finished jobs (and their mp4s) older than RESULT_TTL_SECONDS."""
    if RESULT_TTL_SECONDS <= 0:
        return
    cutoff = time.time() - RESULT_TTL_SECONDS
    for jid, job in list(JOBS.items()):
        if job.finished_at and job.finished_at < cutoff:
            if job.video_path and os.path.exists(job.video_path):
                try:
                    os.remove(job.video_path)
                except OSError:
                    pass
            JOBS.pop(jid, None)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global PIPE, UPSAMPLER
    print('{"msg":"ltx_selfhost.loading_model"}', flush=True)
    PIPE, UPSAMPLER = await asyncio.to_thread(_load_pipeline)
    print(
        '{"msg":"ltx_selfhost.model_ready","two_stage":%s}' % ("true" if UPSAMPLER else "false"),
        flush=True,
    )
    task = asyncio.create_task(_worker())
    yield
    task.cancel()


app = FastAPI(lifespan=lifespan)


def _auth(authorization: str | None) -> None:
    """Bearer check. ltx.ts sends `Authorization: Bearer <LTX_API_KEY>`."""
    if authorization != f"Bearer {API_TOKEN}":
        raise HTTPException(status_code=401, detail="invalid api key")


@app.get("/health")
async def health():
    """Unauthenticated liveness probe -- also reports whether weights are loaded.

    `load` is what a multi-GPU router must balance on, NOT `queued`. The worker
    pops a job off the queue the instant it starts rendering, so a backend that is
    2 seconds into a 77-second clip reports queued=0 and looks idle. Balancing on
    that sent two concurrent clips to the SAME GPU while the other sat unused
    (observed 2026-08-22). load = waiting + in-flight is the honest number.
    """
    active = sum(1 for j in JOBS.values() if j.status == "processing")
    queued = QUEUE.qsize()
    return {
        "ok": PIPE is not None,
        "queued": queued,
        "active": active,
        "load": queued + active,
        "jobs": len(JOBS),
    }


@app.post("/v2/image-to-video")
async def submit(request: Request, authorization: str | None = Header(default=None)):
    _auth(authorization)
    body = await request.json()

    image_uri = body.get("image_uri")
    prompt = body.get("prompt")
    if not image_uri or not prompt:
        raise HTTPException(status_code=400, detail="image_uri and prompt are required")

    job_id = uuid.uuid4().hex
    job = Job(
        job_id,
        {
            "image_uri": image_uri,
            "prompt": prompt,
            "model": body.get("model", MODEL_ID),
            "duration": body.get("duration", 6),
            "resolution": body.get("resolution", "1920x1080"),
            "fps": body.get("fps", 25),
            # Optional; falls back to the library default. ltx.ts does not send
            # this, so production behaviour is unchanged.
            "negative_prompt": body.get("negative_prompt"),
            # Optional sampling-step count, see STEPS_OVERRIDE. Per-request so a
            # quality experiment costs one clip instead of one model reload.
            "steps": body.get("steps"),
        },
    )
    JOBS[job_id] = job
    await QUEUE.put(job_id)
    # Shape matches the real API: ltx.ts reads `id` off this response and ignores
    # the rest.
    return JSONResponse({"id": job_id, "created_at": int(job.created_at)})


@app.get("/v2/image-to-video/{job_id}")
async def status(job_id: str, authorization: str | None = Header(default=None)):
    _auth(authorization)
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")

    payload: dict[str, Any] = {"status": job.status}
    if job.status == "completed":
        # Absolute URL -- the app downloads this directly (step 3 in ltx.ts).
        payload["result"] = {"video_url": f"{PUBLIC_BASE_URL}/files/{job_id}.mp4"}
    if job.status == "failed":
        payload["error"] = job.error
    return payload


@app.get("/files/{name}")
async def download(name: str):
    """Serve a finished mp4.

    Deliberately UNAUTHENTICATED: ltx.ts downloads result.video_url with a plain
    fetch that carries no Authorization header (the real API returns a signed CDN
    URL there). Filenames are random 32-hex job ids and expire with the job, so
    the URL is unguessable rather than access-controlled.
    """
    # Reject path traversal -- `name` lands straight in a filesystem path.
    if "/" in name or "\\" in name or ".." in name:
        raise HTTPException(status_code=400, detail="bad name")
    path = os.path.join(OUT_DIR, name)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="not found")
    return FileResponse(path, media_type="video/mp4")
