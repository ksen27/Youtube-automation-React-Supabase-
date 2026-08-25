# Self-hosted LTX-2.5 clip service

Runs the open-weights LTX-2.5 checkpoint on our own GPU so `ai_clip` blocks stop
billing `$0.04/sec` against `api.ltx.video` (`PRICE_TABLE.ltx2` in
`lib/synthetic/cost.ts`).

**It is a drop-in for `api.ltx.video`.** `lib/synthetic/ltx.ts` already reads its
endpoint from `LTX_BASE_URL`, and this service speaks the identical `/v2`
lifecycle, so cutover and rollback are one environment variable. No app code
changes.

## Why the app needs no changes

| `ltx.ts` does | This service serves |
| --- | --- |
| `POST /v2/image-to-video` with `image_uri`, `prompt`, `model`, `duration`, `resolution`, `fps` | Accepts all six, returns `{ id, created_at }` |
| `GET /v2/image-to-video/{id}` every 5s | `{ status: pending\|processing\|completed\|failed }` |
| Downloads `result.video_url` | Absolute URL to the finished mp4 |
| Sends `Authorization: Bearer <LTX_API_KEY>` | Checks it against `LTX_SELFHOST_TOKEN` |

The `fal.ai` Veo → Kling fallback chain (`generateClipWithFallback`) is untouched,
so if this box dies mid-render the segment falls through to the existing
providers rather than failing.

## Hardware

Verified on a RunPod **RTX PRO 6000 Blackwell WS (96GB)**, driver 580.173.02,
torch 2.8.0+cu128, Python 3.12.

- **≥80GB VRAM** for 1080p at bf16 without offload. A 48GB card needs
  `enable_model_cpu_offload()` (slower); 24–32GB cards spill to weight streaming
  and are not viable at our resolution.
- **`/workspace` must be a network volume** (100GB+). The weights are ~66 GiB;
  on container disk they are lost on every restart.

## Setup on a fresh pod

```bash
# 1. Deps (Python 3.12+, CUDA 12.7+ already present on the RunPod pytorch image)
pip install "huggingface_hub[hf_transfer]" hf_transfer accelerate transformers \
    sentencepiece protobuf imageio imageio-ffmpeg av fastapi "uvicorn[standard]" pillow requests
pip install git+https://github.com/huggingface/diffusers   # LTX2 pipelines are dev-branch only

# 2. Weights -- GATED. Accept the LTX-2.x Community License at
#    https://huggingface.co/Lightricks/LTX-2.5-Diffusers first, then:
export HF_HOME=/workspace/hf HF_HUB_ENABLE_HF_TRANSFER=1 HF_TOKEN=hf_...
python -c "from huggingface_hub import snapshot_download; \
           snapshot_download('Lightricks/LTX-2.5-Diffusers', max_workers=16)"

# 3. Run
export LTX_SELFHOST_TOKEN=<the token you will also set as the app's LTX_API_KEY>
export LTX_SELFHOST_PUBLIC_URL=https://<POD_ID>-8000.proxy.runpod.net
bash run.sh
```

The pod must expose **HTTP port 8000** (RunPod → pod → Edit → HTTP Ports), or the
proxy URL resolves to nothing.

Startup loads ~66 GiB onto the card before serving — `GET /health` returns
`{"ok": false}` until that finishes. Do not point production at it before
`ok: true`.

## Measured results (2026-08-21, RTX PRO 6000 96GB @ $1.99/hr)

One 6s clip at 1920x1080, 25fps, via the service API:

| Path | Per clip | $/clip | Verdict |
| --- | --- | --- | --- |
| Native 1080p, weights resident | — | — | **CUDA OOM.** Needed 2.49 GiB more than the card had |
| Native 1080p, CPU offload | 673.2s | $0.372 | **Worse than the API.** Weights stream over PCIe every step |
| **Two-stage 960x544 -> x2 upscale** | **118.2s** | **$0.0653** | **3.7x cheaper than the API** |

- Per 20-minute video (~43 clips): **$2.81 vs $10.32** on the API.
- Throughput: **30 clips/GPU-hour**.

### 720p (client 2026-08-21: "change it to 720p ... make the footage look older")

Same rig, same 6s clip, `--resolution 1280x720`:

| | Per clip | $/clip | Per 20-min video | Clips/GPU-hr |
| --- | --- | --- | --- | --- |
| 1080p two-stage | 118.2s | $0.0653 | $2.81 | 30 |
| **720p** | **50.1s** | **$0.0277** | **$1.19** | **72** |

**8.7x cheaper than the API**, and it halves the wall-clock problem too: ~36
GPU-minutes per video instead of ~85, so two GPUs get a video's clips done in
~18 minutes rather than needing three-plus.

NOTE: the synthetic engine's export canvas is **3840x2160** (`renderCanvasFor`
in lib/media/ffmpeg.ts — the client wants 4K export). 720p clips are therefore
upscaled **3x** into the final frame. That softness is the point of the request,
but it is a much bigger jump than the 2x that 1080p clips were getting, so the
look should be confirmed on a real export before this ships.
- Generation alone is 77.1s (58.6 stage 1 + 18.5 stage 2); the remaining ~41s is
  image download, float32->uint8 conversion of a 958MB array, and the libx264
  encode. The encode is the bulk of it and is the obvious next optimisation
  (`quality=8` is conservative), so 3.7x is a floor rather than a ceiling.

**Wall-clock caveat.** At 118s/clip a 43-clip video needs ~85 GPU-minutes on ONE
card, against ~6 minutes today (the API absorbed `IMAGE_TO_VIDEO_CONCURRENCY=3`
across a key pool). Three GPUs bring it to ~28 minutes -- still slower per video
than the API. Self-hosting trades delivery latency for cost; size the fleet for
the turnaround the client actually needs, not just for the saving.

## Benchmark before cutting over

```bash
python benchmark.py --token "$LTX_SELFHOST_TOKEN" --runs 3
```

Prints steady-state seconds per clip, `$/clip` against the GPU hourly rate, and
the saving multiple versus the `$0.04/sec` API price. **Run this before changing
any production env var** — the entire cost case rests on this number, and every
published figure is either a vendor benchmark on unobtainable hardware or a
different resolution.

## Cutover

```bash
fly secrets set \
  LTX_BASE_URL=https://<POD_ID>-8000.proxy.runpod.net \
  LTX_API_KEY=<LTX_SELFHOST_TOKEN> \
  --app video-automation-avatar-worker
```

Roll back by setting `LTX_BASE_URL` to `https://api.ltx.video` and `LTX_API_KEY`
back to the LTX account key.

**Do not delete the LTX account keys.** `keyPool()` in `ltx.ts` still supports a
multi-key pool; keeping the real keys funded means a bad GPU deploy can be
reverted in seconds.

## Clip quality: what was actually wrong (2026-08-25)

The client reported that clips degraded after the GPU cutover, specifically:
"the not action part is good but the around action part such as body is not
good" -- static regions clean, anything in motion falling apart.

**Three real bugs, found in this order. The first is the one that mattered.**

### 1. Guidance was ON for a distilled checkpoint (the cause)

`_generate` passed `guidance_scale=1.0` and nothing else, leaving every other
guidance parameter at its NON-distilled default. The pipeline's own gates:

```python
do_classifier_free_guidance    = guidance_scale > 1 or audio_guidance_scale > 1
do_spatio_temporal_guidance    = stg_scale > 0 or audio_stg_scale > 0
do_modality_isolation_guidance = modality_scale > 1 or audio_modality_scale > 1
```

With `audio_guidance_scale=7.0`, `stg_scale=1.0`, `modality_scale=3.0` all left
at defaults, **all three evaluated TRUE**. The damaging one is STG --
Spatio-Temporal Guidance -- applied at transformer block 28, adding
`stg_scale * (pred - pred_uncond_stg)` to every prediction. It perturbs the
TEMPORAL pathway, which is exactly why static areas were fine and motion was not.

It was also costing 3-4x the compute: CFG doubles the batch, STG and modality
each add a forward pass.

MEASURED, 4s @ 1080p: **24.0 s/it -> 5.9 s/it, 170s -> 60s per clip.** Faster
AND correct. The fix is to pass the full distilled set (see `_generate`).

Note: with CFG correctly off, **`negative_prompt` does nothing** -- the distilled
model is trained for unguided sampling. Leave `LTX_NEGATIVE_PROMPT` unset.

### 2. Stage 2 refinement never ran

The official LTX-2.5 distilled workflow is THREE parts: generate at half
resolution (latents) -> latent x2 upsample -> **refine at full resolution**, 3
steps on `STAGE_2_DISTILLED_SIGMA_VALUES`. This service did parts 1 and 2 and
stopped, so the step that restores detail never ran -- and it decoded to pixels
between stages, adding a lossy VAE round-trip.

That omission is what produced the earlier note claiming two-stage "costs real
detail". It does not. Two-stage IS the recommended production path; a two-stage
pipeline **missing its refinement** costs real detail.

### 3. Allocator fragmentation blocked native 1080p

`Tried to allocate 894.00 MiB. 816.31 MiB free. 3.03 GiB reserved by PyTorch but
unallocated.` Missed by 78 MiB while holding 3 GB it was not using.
`PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True` (now set in `run.sh`) plus an
`empty_cache()` before the largest allocation.

Largely moot once #1 was fixed -- correct distilled sampling uses far less
memory -- but it is cheap insurance and it is what proved native 1080p fits.

### Dead ends, recorded so they are not retried

- **Text-encoder CPU offload** freed ~16 GB and did allow native 1080p, but at
  24 s/it -- which turned out to be the guidance bug, not the offload. Not
  needed. `LTX_SELFHOST_TEXT_ENCODER_OFFLOAD` remains for emergencies only.
- **Raising the step count.** The distilled checkpoint is driven by an explicit
  sigma schedule `[1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725,
  0.421875]`, not a step count. Interpolating it to 20 points produced
  structurally melted faces. The docs are explicit that passing
  `num_inference_steps` "would hand the model a generic linear schedule and
  quietly cost quality". **The count is fixed at 8.**
- **Setting `LTX_RESOLUTION=1920x1080`.** It was already 1920x1080 in
  production and always correct. The label was never the problem.

### Comparing by eye

`scripts/clip-quality-sample.ts` animates one still against whichever endpoint
`LTX_BASE_URL` names. This is the side-by-side check f926156 said it needed and
never got -- run it before any future cutover.

## Known differences from `api.ltx.video`

These are behavioural, not contractual — the app cannot tell the difference, but
the output can:

- **Model version.** Production runs `ltx-2-3-fast`; this is **2.5**. Newer, but
  the look differs. Validate a full video side-by-side before switching the
  client's output over.
- **Duration tiers.** The API only accepts `6/8/10/12/…s`; this service accepts
  any duration and snaps frames to `8n+1` internally. `ltx.ts` still sends
  snapped tiers (`snapDuration`), so behaviour is unchanged — but the constraint
  is no longer enforced server-side.
- **Concurrency.** The API absorbed `IMAGE_TO_VIDEO_CONCURRENCY=3` across a key
  pool. Here it becomes **queue depth against one GPU**: three clips submitted at
  once run sequentially. Run one process per GPU behind a load balancer to
  restore real parallelism.
- **Jobs are in-memory.** A restart loses in-flight jobs. The app treats the poll
  failure as transient and falls through to fal.ai.
- **`/files/{name}` is unauthenticated** by design — `ltx.ts` downloads
  `result.video_url` with no auth header, matching the real API's signed-CDN
  behaviour. Names are random 32-hex job ids that expire with the job.
