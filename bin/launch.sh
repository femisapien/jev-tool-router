#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${AI_GATEWAY_API_KEY:-}" ]]; then
  echo "AI_GATEWAY_API_KEY is missing. Set it in the environment; do not store it in router config." >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$repo_root/src/server.mjs"
