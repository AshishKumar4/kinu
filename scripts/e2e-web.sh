#!/usr/bin/env bash
# Kinu Web E2E tests — exercises the real agent via HTTP + WebSocket.
# Requires the local dev server (wrangler/vite) running on localhost:5173.
#
# It CREATES an agent on whatever it is pointed at, so where it points is not a
# detail. The default is a loopback dev server; a staging origin is the other
# accepted target, and anything else is refused unless KINU_EVAL_ALLOW_PROD=1
# names the exception. The rule and its one implementation live in
# packages/test-utils/src/eval-identity.ts — this script asks that module rather
# than keeping a second opinion about which hosts are safe.
#
# The agent it makes is named `eval-…` for the same reason: a row left behind by
# a failed run has to say what made it. `bun scripts/eval-workspaces.ts` lists
# them and prints the command that removes them.
set -uo pipefail

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BASE_URL="${KINU_BASE_URL:-http://localhost:5173}"
# "Nothing to run against", distinct from both success and failure.
SKIP_EXIT=2

cd "$PROJECT_DIR"
# Before the pre-flight, so a refused target is refused even when the thing it
# names happens to be reachable.
if ! AGENT_NAME="$(bun scripts/eval-target.ts "$BASE_URL" --name e2e-web)"; then
  exit 1
fi

echo -e "${BOLD}Kinu Web E2E Tests${NC}"
echo "Target: $BASE_URL"
echo "Agent:  $AGENT_NAME"
echo ""

# ── Pre-flight: is the dev server reachable? ──────────────────────
# Exit 2 — not 0 — when there is nothing to test against. Exiting 0 made "no
# dev server" indistinguishable from "every web test passed" to the caller,
# which duly reported the latter.
HTTP_CODE=$(curl -so /dev/null -w '%{http_code}' --max-time 5 "$BASE_URL/" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" != "200" ]; then
  echo -e "${YELLOW}SKIP: Dev server not reachable at $BASE_URL (HTTP $HTTP_CODE)${NC}"
  echo "Start the dev server first:  cd packages/cf-backend && bun run dev"
  exit "$SKIP_EXIT"
fi

echo -e "${GREEN}Dev server reachable (HTTP $HTTP_CODE)${NC}"
echo ""

# ── Run the WebSocket test harness ────────────────────────────────
# The harness outputs PASS/FAIL lines and exits 0/1.
exec bun run scripts/ws-test-harness.ts "$BASE_URL" "$AGENT_NAME"
