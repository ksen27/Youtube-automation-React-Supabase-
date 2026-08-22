#!/usr/bin/env bash
# Bring up the whole multi-GPU stack: one backend per GPU + the router.
#
#   :8000  router          (public, the only port RunPod needs to expose)
#   :8001  backend GPU 0   (localhost only)
#   :8002  backend GPU 1   (localhost only)
#
# Each backend is a SEPARATE PROCESS pinned to one GPU with CUDA_VISIBLE_DEVICES.
# That is deliberate: server.py loads the full 22B model and serves one clip at a
# time, so "use both GPUs" means two processes each owning a card, NOT one
# process spanning both (LTX-2 has no multi-GPU single-generation path).
#
# Each backend loads its own ~35 GiB of weights, so expect ~2x the load time and
# ~140 GB of host RAM in use during startup. Fine on this pod (1TB), worth
# knowing before running this on a smaller machine.
#
# Usage:  bash /workspace/ltx/run-multi.sh
# Logs:   /workspace/ltx/backend0.log, backend1.log, router.log
set -uo pipefail

cd /workspace/ltx
source /workspace/ltx/venv/bin/activate

GPUS="${GPUS:-0 1}"
# 8011+, NOT 8001+: the RunPod pytorch image runs its own nginx on 8001, so a
# backend there binds-fails with "address already in use" AFTER spending ~5
# minutes loading 35 GiB of weights -- the failure looks like a model problem and
# is not. 8011/8012 were verified free on this image.
BASE_PORT="${BASE_PORT:-8011}"
ROUTER_PORT="${ROUTER_PORT:-8000}"

# Kill anything from a previous run. Match with a bracket class so the pattern
# cannot match the shell running this script (a plain "uvicorn server:app" here
# would pkill our own parent and abort the launch).
pkill -f "uvicorn [s]erver:app" 2>/dev/null
pkill -f "uvicorn [r]outer:app" 2>/dev/null
for p in $(nvidia-smi --query-compute-apps=pid --format=csv,noheader 2>/dev/null); do
  kill -9 "$p" 2>/dev/null
done
sleep 4

BACKENDS=""
i=0
for g in $GPUS; do
  port=$((BASE_PORT + i))
  echo "starting backend on GPU $g -> :$port"
  # PUBLIC_URL still points at the ROUTER: result.video_url must be a URL the app
  # can reach, and only the router port is exposed. The router resolves the file
  # back to whichever backend produced it.
  # START ONE AT A TIME AND WAIT FOR THE CARD TO BE CLAIMED.
  #
  # 2026-08-22: launching both simultaneously put BOTH processes on GPU 0, which
  # then OOM'd each other (47.5 GiB + 47.5 GiB on a 95 GiB card) and took the
  # service down -- clips silently failed over to fal.ai until it was noticed.
  # The CUDA_VISIBLE_DEVICES assignments were correct; the race was in launching
  # them together. Waiting until this backend has actually allocated on its card
  # before starting the next removes the race entirely, at the cost of a short
  # stagger. Model load still overlaps -- only the first allocation is serialised.
  CUDA_VISIBLE_DEVICES="$g" \
  PORT="$port" \
  setsid nohup bash /workspace/ltx/run.sh > "/workspace/ltx/backend${i}.log" 2>&1 < /dev/null &
  disown
  for _ in $(seq 1 30); do
    used=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits -i "$g" 2>/dev/null | tr -d ' ')
    [ -n "$used" ] && [ "$used" -gt 2000 ] && break
    sleep 4
  done
  echo "  gpu $g claimed (${used:-?} MiB)"
  BACKENDS="${BACKENDS}${BACKENDS:+,}http://127.0.0.1:${port}"
  i=$((i + 1))
done

echo "waiting for backends to load weights (~5 min each, in parallel)"
for _ in $(seq 1 60); do
  ready=0
  for b in $(echo "$BACKENDS" | tr ',' ' '); do
    curl -s -m 5 "$b/health" 2>/dev/null | grep -q '"ok":true' && ready=$((ready + 1))
  done
  echo "  ready: $ready/$i"
  [ "$ready" -eq "$i" ] && break
  sleep 20
done

echo "starting router on :$ROUTER_PORT -> $BACKENDS"
LTX_ROUTER_BACKENDS="$BACKENDS" \
setsid nohup /workspace/ltx/venv/bin/uvicorn router:app \
  --host 0.0.0.0 --port "$ROUTER_PORT" --workers 1 \
  > /workspace/ltx/router.log 2>&1 < /dev/null &
disown

sleep 5
curl -s -m 10 "http://127.0.0.1:${ROUTER_PORT}/health"
echo
