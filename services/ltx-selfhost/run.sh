#!/usr/bin/env bash
# Start the self-hosted LTX-2.5 service on the GPU pod.
#
# Run from the pod:  bash /workspace/ltx/run.sh
# Logs:              /workspace/ltx/server.log
#
# The weights live on the NETWORK volume (/workspace/hf), not container disk, so
# a pod restart reloads them from /workspace instead of re-downloading ~66 GiB.
set -euo pipefail

# The venv lives on the NETWORK volume, not container disk. A pod restart wipes
# /usr/local/lib/python3.12/dist-packages (it comes from the image), so anything
# pip-installed there is gone on every reboot -- learned the hard way. Only torch
# is taken from the image, via --system-site-packages when the venv was created.
source /workspace/ltx/venv/bin/activate

# Pod-local settings (token, public URL, model path) live here rather than being
# passed through the ssh command line, where quoting silently mangled them.
if [ -f /workspace/ltx/.env ]; then
  set -a
  # shellcheck disable=SC1091
  . /workspace/ltx/.env
  set +a
fi

export HF_HOME=/workspace/hf
export HF_HUB_ENABLE_HF_TRANSFER=1
# Weights are already on disk; never reach out to the Hub at request time (a
# gated-repo 401 mid-generation would fail a clip that could otherwise run).
export HF_HUB_OFFLINE=1

# Bearer token callers must present. Mirror this EXACTLY into the app's
# LTX_API_KEY. Rotate by changing it in both places.
export LTX_SELFHOST_TOKEN="${LTX_SELFHOST_TOKEN:?set LTX_SELFHOST_TOKEN}"

# Public origin used to build result.video_url. On RunPod the proxy hostname is
# derived from the POD ID and the exposed port -- it must match the port uvicorn
# binds below, or the app will poll a URL that 404s.
export LTX_SELFHOST_PUBLIC_URL="${LTX_SELFHOST_PUBLIC_URL:?set LTX_SELFHOST_PUBLIC_URL}"

export LTX_SELFHOST_OUT_DIR=/workspace/ltx/out
mkdir -p "$LTX_SELFHOST_OUT_DIR"

# ONE worker on purpose. Each worker would load its own copy of the 22B
# transformer and they would fight over the same GPU -- see the concurrency note
# in server.py. Scale by running this on more GPUs, not by raising --workers.
exec uvicorn server:app \
  --host 0.0.0.0 \
  --port "${PORT:-8000}" \
  --workers 1 \
  --timeout-keep-alive 75
