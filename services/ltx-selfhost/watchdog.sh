#!/usr/bin/env bash
# Keep the stack alive while the pod is up.
#
# WHAT THIS COVERS AND WHAT IT DOES NOT
#   covers:     a backend crashing, OOMing, or being killed; the router dying;
#               a GPU process wedging so /health stops answering
#   DOES NOT:   a pod restart -- this process dies with the container. Boot
#               persistence needs the pod's Docker start command to call
#               autostart.sh (see README).
#
# Why it matters in production: when a backend is down, ltx.ts gets a connection
# error, treats it as transient, and generateClipWithFallback quietly routes the
# clip to fal.ai Veo/Kling instead. The video still renders, so nothing looks
# broken -- you just silently stop using the GPU you are paying for and start
# paying per-generation again. That failure is invisible without this.
set -uo pipefail

ROUTER_PORT="${ROUTER_PORT:-8000}"
INTERVAL="${WATCHDOG_INTERVAL:-60}"
LOG=/workspace/ltx/watchdog.log

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >> "$LOG"; }

log "watchdog started (interval ${INTERVAL}s)"
fails=0
while true; do
  if curl -s -m 10 "http://127.0.0.1:${ROUTER_PORT}/health" 2>/dev/null | grep -q '"ok":true'; then
    if [ "$fails" -gt 0 ]; then log "recovered after ${fails} failed checks"; fi
    fails=0
  else
    fails=$((fails + 1))
    # Two consecutive failures before acting: a single miss is usually the router
    # being busy, and restarting a backend mid-render would throw away a clip
    # that was about to finish.
    log "health check failed (${fails})"
    if [ "$fails" -ge 2 ]; then
      log "running autostart.sh"
      bash /workspace/ltx/autostart.sh >> "$LOG" 2>&1
      fails=0
    fi
  fi
  sleep "$INTERVAL"
done
