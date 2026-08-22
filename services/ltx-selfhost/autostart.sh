#!/usr/bin/env bash
# Idempotent bring-up of the whole stack. Safe to run at any time: if everything
# is already healthy it exits immediately without touching the running service.
#
# TWO WAYS THIS GETS INVOKED
#   1. watchdog.sh calls it when a backend or the router stops answering
#   2. the pod's Docker start command calls it on boot (see README) -- that is
#      the only true boot persistence, because RunPod rebuilds the container disk
#      from the image on every restart. Anything we install outside /workspace is
#      gone; this script and everything it starts live on /workspace, so they
#      survive.
set -uo pipefail

LTX_DIR=/workspace/ltx
ROUTER_PORT="${ROUTER_PORT:-8000}"
# 8011+, not 8001: the RunPod image's own nginx owns 8001.
PORTS=(8011 8002)
GPUS=(0 1)

log() { echo "$(date -u +%H:%M:%S) autostart: $*"; }

# Nothing to do if the router already reports every backend loaded.
if curl -s -m 5 "http://127.0.0.1:${ROUTER_PORT}/health" 2>/dev/null | grep -q '"ok":true'; then
  log "already healthy, nothing to do"
  exit 0
fi

cd "$LTX_DIR" || { log "FATAL: $LTX_DIR missing -- is the network volume attached?"; exit 1; }
[ -x "$LTX_DIR/venv/bin/python" ] || { log "FATAL: venv missing -- wrong volume?"; exit 1; }

# Start any backend that is not answering. Deliberately per-port rather than
# "restart everything": a healthy GPU mid-render should not be killed because its
# neighbour died.
for i in "${!PORTS[@]}"; do
  port="${PORTS[$i]}"
  gpu="${GPUS[$i]}"
  if curl -s -m 5 "http://127.0.0.1:${port}/health" 2>/dev/null | grep -q '"ok":true'; then
    log "backend gpu${gpu}:${port} already up"
    continue
  fi
  # Clear a half-dead process holding the port or the GPU, or the new one will
  # load 35 GiB and then fail to bind / OOM.
  pkill -f "port ${port}" 2>/dev/null
  log "starting backend gpu${gpu} on :${port}"
  CUDA_VISIBLE_DEVICES="$gpu" PORT="$port" \
    setsid nohup bash "$LTX_DIR/run.sh" > "$LTX_DIR/backend${i}.log" 2>&1 < /dev/null &
  disown
done

# Weights take ~5 min to reach the card; both backends load in parallel.
log "waiting for backends"
for _ in $(seq 1 60); do
  ready=0
  for port in "${PORTS[@]}"; do
    curl -s -m 5 "http://127.0.0.1:${port}/health" 2>/dev/null | grep -q '"ok":true' && ready=$((ready + 1))
  done
  [ "$ready" -eq "${#PORTS[@]}" ] && break
  sleep 20
done
log "backends ready: ${ready}/${#PORTS[@]}"

# Router last: it reports ok only when every backend is loaded, so starting it
# earlier would just publish an unhealthy endpoint.
if ! curl -s -m 5 "http://127.0.0.1:${ROUTER_PORT}/health" 2>/dev/null | grep -q '"gpus"'; then
  BACKENDS=""
  for port in "${PORTS[@]}"; do BACKENDS="${BACKENDS}${BACKENDS:+,}http://127.0.0.1:${port}"; done
  log "starting router on :${ROUTER_PORT} -> ${BACKENDS}"
  cd "$LTX_DIR"
  LTX_ROUTER_BACKENDS="$BACKENDS" \
    setsid nohup "$LTX_DIR/venv/bin/uvicorn" router:app \
      --host 0.0.0.0 --port "$ROUTER_PORT" --workers 1 \
      > "$LTX_DIR/router.log" 2>&1 < /dev/null &
  disown
  sleep 6
fi

curl -s -m 10 "http://127.0.0.1:${ROUTER_PORT}/health"
echo
