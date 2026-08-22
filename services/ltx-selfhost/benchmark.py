# Measure what a clip actually costs us on our own GPU.
#
# Everything in the cost case for self-hosting rests on ONE unknown: how many
# seconds of wall-clock a 6s/1080p clip takes on this card. The published
# figures are either vendor benchmarks on hardware nobody rents (6.8s for a 10s
# clip on 2x GB200) or a different resolution entirely. This script replaces the
# estimate with a measurement.
#
# Run ON the pod, against the running service:
#   python benchmark.py --base http://127.0.0.1:8000 --token "$LTX_SELFHOST_TOKEN"
#
# Reports per-clip wall time and the implied $/second, so it can be compared
# directly against PRICE_TABLE.ltx2 ($0.04/sec) in lib/synthetic/cost.ts.

import argparse
import statistics
import time

import requests

# A still that is already public, so the service's _download_image path is
# exercised exactly as it will be in production (the app passes public R2 URLs).
DEFAULT_IMAGE = "https://huggingface.co/datasets/huggingface/documentation-images/resolve/main/diffusers/cat.png"

# Prompts in the same register the planner emits for ai_clip blocks -- short
# camera/motion directions, not scene descriptions.
PROMPTS = [
    "slow cinematic dolly in, subtle parallax, natural motion",
    "gentle handheld drift to the right, shallow depth of field",
    "slow push out revealing the wider scene, steady camera",
]


def run_one(base: str, token: str, image: str, prompt: str, duration: int, resolution: str, fps: int) -> float:
    """Submit one clip and block until it completes. Returns wall seconds."""
    headers = {"Authorization": f"Bearer {token}"}
    started = time.time()
    submit = requests.post(
        f"{base}/v2/image-to-video",
        headers=headers,
        json={
            "image_uri": image,
            "prompt": prompt,
            "duration": duration,
            "resolution": resolution,
            "fps": fps,
        },
        timeout=60,
    )
    submit.raise_for_status()
    job_id = submit.json()["id"]

    while True:
        st = requests.get(f"{base}/v2/image-to-video/{job_id}", headers=headers, timeout=30).json()
        if st.get("status") == "completed":
            return time.time() - started
        if st.get("status") == "failed":
            raise RuntimeError(f"job failed: {st.get('error')}")
        time.sleep(2)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8000")
    ap.add_argument("--token", required=True)
    ap.add_argument("--image", default=DEFAULT_IMAGE)
    # 6s @ 1080p/25fps is what the planner actually asks for: blocks target 6s
    # (SYNTHETIC_BLOCK_TARGET_SECONDS) and ltx.ts snaps to the 6s tier.
    ap.add_argument("--duration", type=int, default=6)
    ap.add_argument("--resolution", default="1920x1080")
    ap.add_argument("--fps", type=int, default=25)
    ap.add_argument("--runs", type=int, default=3)
    # Per-hour price of this GPU, used to turn wall time into $/clip.
    ap.add_argument("--gpu-hourly", type=float, default=2.09)
    args = ap.parse_args()

    times: list[float] = []
    for i in range(args.runs):
        prompt = PROMPTS[i % len(PROMPTS)]
        took = run_one(args.base, args.token, args.image, prompt, args.duration, args.resolution, args.fps)
        times.append(took)
        print(f"run {i + 1}/{args.runs}: {took:.1f}s")

    # The FIRST run includes lazily-initialised CUDA kernels and autotuning that
    # never recur, so it overstates steady-state cost. Report both.
    steady = times[1:] or times
    median = statistics.median(steady)
    per_clip_usd = (median / 3600) * args.gpu_hourly
    api_usd = args.duration * 0.04  # PRICE_TABLE.ltx2, lib/synthetic/cost.ts

    print("\n--- RESULT ---")
    print(f"cold start (run 1)   : {times[0]:.1f}s")
    print(f"steady-state median  : {median:.1f}s per {args.duration}s clip")
    print(f"self-hosted $/clip   : ${per_clip_usd:.4f}  (at ${args.gpu_hourly}/hr)")
    print(f"LTX API   $/clip     : ${api_usd:.4f}  (at $0.04/sec)")
    print(f"saving factor        : {api_usd / per_clip_usd:.1f}x")
    # ~43 clips per 20-minute video -- see the phase split in lib/env.ts.
    print(f"per 20-min video     : ${per_clip_usd * 43:.2f} vs ${api_usd * 43:.2f} on the API")
    print(f"clips per GPU-hour   : {3600 / median:.0f}")


if __name__ == "__main__":
    main()
