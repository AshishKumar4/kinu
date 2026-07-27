#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../lean"
lake build
bash check-no-false.sh
node check-traceability.mjs
