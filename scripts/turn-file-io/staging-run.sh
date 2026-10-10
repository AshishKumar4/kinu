#!/usr/bin/env bash
set -euo pipefail
export KINU_EVAL_LIVE=1
export KINU_EVAL_BACKEND=cloud
export KINU_EVAL_ORIGIN=https://staging.kinu.run
export KINU_EVAL_ACCOUNT=first-run
bun scripts/eval-session-mint.ts
mapfile -t perf_credentials < <(bun scripts/eval-credentials.ts)
[[ "${#perf_credentials[@]}" == 2 ]]
[[ "${perf_credentials[0]}" == https://staging.kinu.run ]]
export KINU_EVAL_TOKEN="${perf_credentials[1]}"
export KINU_TOKEN="${perf_credentials[1]}"
bun scripts/turn-file-io/staging.ts --samples=30
