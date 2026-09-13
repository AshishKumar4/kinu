#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../lean"
lake build
bash check-no-false.sh
node check-traceability.mjs
bun ../scripts/lean-citations.ts

# Devbox's lifecycle corpus uses its own pinned Lean toolchain.
cd ../packages/devbox/proof
lake build
