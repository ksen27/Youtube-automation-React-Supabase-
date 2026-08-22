# Front door for a multi-GPU pod: one public endpoint, N single-GPU backends.
#
# WHY A ROUTER AND NOT PLAIN ROUND-ROBIN
# --------------------------------------
# server.py keeps its job table IN MEMORY, per process. A naive load balancer
# would POST a job to GPU 0 and then send the status poll to GPU 1, which has
# never heard of that id and returns 404 -- the clip would look like it failed
# while it was quietly rendering next door. So this router remembers which
# backend owns each job id and pins every follow-up call (status, file download)
# to that same backend.
#
# It exists because ltx.ts must keep believing it is talking to ONE api.ltx.video
# instance. All the multi-GPU detail stops here.
#
# WHAT "USING BOTH GPUS AT ONCE" MEANS HERE: each backend renders a DIFFERENT
# clip simultaneously. Splitting a single generation across two GPUs is not
# supported by LTX-2 (Lightricks/LTX-2 issue #162 is an open feature request), so
# per-clip time is unchanged and THROUGHPUT is what doubles.
#
# Run:  LTX_ROUTER_BACKENDS=http://127.0.0.1:8001,http://127.0.0.1:8002 \
#       uvicorn router:app --host 0.0.0.0 --port 8000

import asyncio
import itertools
import os
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

BACKENDS = [
    b.strip().rstrip("/")
    for b in os.environ.get(
        "LTX_ROUTER_BACKENDS", "http://127.0.0.1:8001,http://127.0.0.1:8002"
    ).split(",")
    if b.strip()
]
if not BACKENDS:
    raise SystemExit("LTX_ROUTER_BACKENDS is empty")

# job_id -> backend that owns it. Same lifetime as the backends' own job tables,
# so it dies with a restart exactly as they do; ltx.ts treats a lost poll as a
# transient error and falls through to the fal.ai chain.
OWNER: dict[str, str] = {}
_rr = itertools.cycle(range(len(BACKENDS)))
_lock = asyncio.Lock()

app = FastAPI()
# Generation is minutes long, but the router only ever proxies SHORT calls
# (submit, poll, file read) -- the long wait happens inside the backend while the
# client polls. A generous read timeout still matters for the file download.
client = httpx.AsyncClient(timeout=httpx.Timeout(300.0, connect=10.0))


async def _pick_backend() -> str:
    """Choose the backend with the shortest queue; round-robin on a tie.

    Least-queued rather than pure round-robin because clips are not equal cost --
    a 6s clip takes ~50% longer than a 4s one, so strict alternation can leave one
    GPU idle while the other has two long jobs stacked up.
    """
    depths: list[tuple[int, str]] = []
    for b in BACKENDS:
        try:
            r = await client.get(f"{b}/health", timeout=5.0)
            d = r.json()
            # `load` = waiting + IN-FLIGHT. Balancing on `queued` alone sent two
            # simultaneous clips to one GPU while the other idled: the worker
            # dequeues immediately, so a backend mid-render reports queued=0.
            # Fall back to queued only for a backend too old to report load.
            depths.append((int(d.get("load", d.get("queued", 0))), b))
        except Exception:
            # Unreachable backend: rank it last rather than removing it, so a
            # briefly-restarting GPU is not permanently dropped from the pool.
            depths.append((10_000, b))
    depths.sort(key=lambda x: x[0])
    if depths and depths[0][0] < 10_000:
        return depths[0][1]
    async with _lock:
        return BACKENDS[next(_rr)]


@app.get("/health")
async def health() -> dict[str, Any]:
    """Aggregate health. ok only when EVERY backend has its weights loaded."""
    out = []
    for b in BACKENDS:
        try:
            r = await client.get(f"{b}/health", timeout=5.0)
            out.append({"backend": b, **r.json()})
        except Exception as exc:  # noqa: BLE001
            out.append({"backend": b, "ok": False, "error": str(exc)[:120]})
    return {
        "ok": all(x.get("ok") for x in out),
        "gpus": len(BACKENDS),
        "queued": sum(int(x.get("queued", 0)) for x in out),
        "backends": out,
    }


@app.post("/v2/image-to-video")
async def submit(request: Request):
    body = await request.body()
    backend = await _pick_backend()
    r = await client.post(
        f"{backend}/v2/image-to-video",
        content=body,
        headers={
            k: v
            for k, v in request.headers.items()
            if k.lower() in ("authorization", "content-type")
        },
    )
    if r.status_code >= 400:
        return JSONResponse(r.json() if r.text else {}, status_code=r.status_code)
    data = r.json()
    job_id = data.get("id")
    if job_id:
        OWNER[job_id] = backend
    return JSONResponse(data, status_code=r.status_code)


@app.get("/v2/image-to-video/{job_id}")
async def status(job_id: str, request: Request):
    backend = OWNER.get(job_id)
    if backend is None:
        # Unknown id: ask every backend rather than 404ing. Covers a router
        # restart that lost the map while the backends kept their jobs.
        for b in BACKENDS:
            try:
                r = await client.get(
                    f"{b}/v2/image-to-video/{job_id}",
                    headers={"authorization": request.headers.get("authorization", "")},
                )
                if r.status_code == 200:
                    OWNER[job_id] = b
                    return JSONResponse(r.json())
            except Exception:  # noqa: BLE001
                continue
        raise HTTPException(status_code=404, detail="job not found on any backend")

    r = await client.get(
        f"{backend}/v2/image-to-video/{job_id}",
        headers={"authorization": request.headers.get("authorization", "")},
    )
    return JSONResponse(r.json() if r.text else {}, status_code=r.status_code)


@app.get("/files/{name}")
async def files(name: str):
    """Stream a finished mp4 from whichever backend produced it.

    The filename is "<job_id>.mp4", so the owner map resolves it directly; the
    fallback scan covers stable-named files copied in by hand for sharing.
    """
    job_id = name.rsplit(".", 1)[0]
    candidates = [OWNER[job_id]] if job_id in OWNER else BACKENDS
    for b in candidates:
        try:
            r = await client.get(f"{b}/files/{name}")
            if r.status_code == 200:
                return StreamingResponse(
                    iter([r.content]),
                    media_type=r.headers.get("content-type", "video/mp4"),
                )
        except Exception:  # noqa: BLE001
            continue
    raise HTTPException(status_code=404, detail="file not found on any backend")
