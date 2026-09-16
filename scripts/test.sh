#!/usr/bin/env bash
# Run the full Kinu test suite with coverage.
#
# Usage:
#   bash scripts/test.sh                    # unit + integration
#   bash scripts/test.sh --coverage         # + coverage report
#   bash scripts/test.sh --bail             # exit on first failure
#   bash scripts/test.sh packages/core/...  # specific file
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# No per-test clock: bun applies a preload's setDefaultTimeout(0) to the first
# file only (measured 2026-09-15, bun 1.4.0), so the flag is the one switch
# that covers every file. `gate:test-clocks` refuses per-test durations.
FLAGS=(--timeout=0)
PATTERNS=()
for arg in "$@"; do
  case "$arg" in
    -h|--help) sed -n '2,8p' "$REPO_ROOT/scripts/test.sh"; exit 0 ;;
    --coverage|--bail|--watch|--verbose|--rerun-each) FLAGS+=("$arg") ;;
    --*) FLAGS+=("$arg") ;;
    *)  PATTERNS+=("$arg") ;;
  esac
done

echo "→ Kinu test suite"
echo "  flags:    ${FLAGS[*]:-(none)}"
echo "  patterns: ${PATTERNS[*]:-(all)}"
echo

if [ ${#PATTERNS[@]} -gt 0 ]; then
  # Specific files / directories — pass-through to bun test
  exec bun test "${FLAGS[@]}" "${PATTERNS[@]}"
fi

# Default: run the package test suites that do not require live LLM credentials.
# Run them as one bun-test invocation so coverage aggregates across packages.
exec bun test "${FLAGS[@]}" \
  packages/core/tests \
  packages/cf-backend/tests \
  packages/cli-backend/tests \
  packages/cli/tests
