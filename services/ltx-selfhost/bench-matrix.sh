#!/usr/bin/env bash
# Measure ONE optimisation flag combination end to end, on the pod.
#
# WHY A SCRIPT AND NOT "just run the benchmark": every measurement here needs the
# same four steps in the same order, and skipping any of them produces a number
# that looks real and is not:
#
#   1. Set the flags in .env          -- they are read at process start, not per request
#   2. Restart the service            -- so the flags actually apply
#   3. Wait for /health {"ok":true}   -- the model takes ~5 min to reach the GPU
#   4. DISCARD THE FIRST CLIP         -- see below
#
# THE FIRST CLIP IS ALWAYS A LIE. It carries CUDA kernel autotuning, and with
# LTX_SELFHOST_COMPILE=1 it also carries the entire torch.compile graph build,
# which is MINUTES. Reporting it as "the speed" would make compile look like a
# catastrophic regression when it is the opposite. Only warm runs count.
#
# Usage (from /workspace/ltx on the pod):
#   bash bench-matrix.sh baseline
#   bash bench-matrix.sh compile
#   bash bench-matrix.sh fp8
#   bash bench-matrix.sh compile+fp8
set -uo pipefail

MODE="${1:-baseline}"
RUNS="${RUNS:-3}"                 # warm runs, after the discarded first
DURATION="${DURATION:-4}"         # client 2026-08-21 settled on 4s clips
RESOLUTION="${RESOLUTION:-1280x720}"
GPU_HOURLY="${GPU_HOURLY:-1.99}"
ENV_FILE=/workspace/ltx/.env
BASE=http://127.0.0.1:8000

case "$MODE" in
  baseline)    COMPILE=0; FP8=0 ;;
  compile)     COMPILE=1; FP8=0 ;;
  fp8)         COMPILE=0; FP8=1 ;;
  compile+fp8) COMPILE=1; FP8=1 ;;
  *) echo "unknown mode: $MODE (baseline|compile|fp8|compile+fp8)"; exit 1 ;;
esac

echo "=== mode=$MODE compile=$COMPILE fp8=$FP8 ${RESOLUTION} ${DURATION}s ==="

# 1. Flags
sed -i '/LTX_SELFHOST_COMPILE=/d;/LTX_SELFHOST_FP8=/d' "$ENV_FILE"
echo "LTX_SELFHOST_COMPILE=$COMPILE" >> "$ENV_FILE"
echo "LTX_SELFHOST_FP8=$FP8" >> "$ENV_FILE"

# 2. Restart. Kill by GPU pid, not by name: an orphan holding VRAM makes the new
# process OOM at startup with an error that looks like a model problem.
for p in $(nvidia-smi --query-compute-apps=pid --format=csv,noheader); do kill -9 "$p" 2>/dev/null; done
sleep 5
cd /workspace/ltx && setsid nohup bash run.sh > /workspace/ltx/server.log 2>&1 < /dev/null &
disown

# 3. Wait for the weights to reach the GPU.
for _ in $(seq 1 40); do
  if curl -s -m 5 "$BASE/health" 2>/dev/null | grep -q '"ok":true'; then break; fi
  sleep 20
done
curl -s -m 5 "$BASE/health" | grep -q '"ok":true' || { echo "service never came up; see server.log"; exit 1; }

TOKEN=$(grep '^LTX_SELFHOST_TOKEN=' "$ENV_FILE" | cut -d= -f2-)

submit_and_wait() {
  local jid
  jid=$(curl -s -m 30 -X POST "$BASE/v2/image-to-video" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "{\"image_uri\":\"$IMAGE\",\"prompt\":\"$PROMPT\",\"duration\":$DURATION,\"resolution\":\"$RESOLUTION\",\"fps\":25}" \
    | grep -oE '"id":"[a-f0-9]+"' | cut -d'"' -f4)
  for _ in $(seq 1 60); do
    local st
    st=$(curl -s -m 15 "$BASE/v2/image-to-video/$jid" -H "Authorization: Bearer $TOKEN")
    echo "$st" | grep -q '"completed"' && { echo "$jid"; return 0; }
    echo "$st" | grep -q '"failed"' && { echo "FAILED $st" >&2; return 1; }
    sleep 10
  done
  echo "TIMEOUT" >&2; return 1
}

IMAGE="${IMAGE:-https://media.celebforge.org/synthetic/71a919c9-b8dd-4037-8562-b72f041e5573/images/7fba12f0-0359-42b6-8f97-e2ac4eb24d62_1787331151909.jpg}"
PROMPT="${PROMPT:-The person in the frame continues the everyday action they are already doing, slowly and deliberately. The camera is completely still and locked off.}"

echo "-- warmup (DISCARDED: carries CUDA autotune + torch.compile graph build) --"
submit_and_wait > /dev/null || exit 1

echo "-- $RUNS warm runs --"
for _ in $(seq 1 "$RUNS"); do submit_and_wait > /dev/null || exit 1; done

# The service logs its own generation time per job, which excludes the HTTP
# polling granularity a client-side stopwatch would add.
echo "-- took_s (last $RUNS) --"
# Sort in the shell, not awk: asort() is a GNU-awk extension and this pod ships
# mawk, where it fails with "function asort never defined" AFTER the expensive
# runs have already completed -- losing the result you just paid GPU time for.
grep -oE '"took_s":[0-9.]+' /workspace/ltx/server.log | tail -n "$RUNS" | cut -d: -f2 | sort -n \
  | awk -v hr="$GPU_HOURLY" -v m="$MODE" '
      { t[NR]=$1; s+=$1 }
      END {
        n=NR; if (n==0) { print "no timings"; exit }
        med = (n%2) ? t[int((n+1)/2)] : (t[n/2]+t[n/2+1])/2;
        clip = med/3600*hr; api = 6*0.04;   # a 4s request bills as 6s on the API
        printf "mode=%s median=%.1fs mean=%.1fs  $/clip=%.4f  vs API $%.4f (%.1fx)\n",
               m, med, s/n, clip, api, api/clip;
        printf "per 20-min video (~64 clips at 4s): $%.2f\n", clip*64;
      }'
