#!/usr/bin/env bash
# Proteus Web E2E tests — exercises the real agent via HTTP + WebSocket.
# Requires the local dev server (wrangler/vite) running on localhost:5173.
set -uo pipefail

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BASE_URL="${PROTEUS_BASE_URL:-http://localhost:5173}"
AGENT_NAME="e2e-$(date +%s)"

echo -e "${BOLD}Proteus Web E2E Tests${NC}"
echo "Target: $BASE_URL"
echo "Agent:  $AGENT_NAME"
echo ""

# ── Pre-flight: is the dev server reachable? ──────────────────────
HTTP_CODE=$(curl -so /dev/null -w '%{http_code}' --max-time 5 "$BASE_URL/" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" != "200" ]; then
  echo -e "${YELLOW}SKIP: Dev server not reachable at $BASE_URL (HTTP $HTTP_CODE)${NC}"
  echo "Start the dev server first:  cd packages/cf-backend && bun run dev"
  exit 0
fi

echo -e "${GREEN}Dev server reachable (HTTP $HTTP_CODE)${NC}"
echo ""

# ── Run the WebSocket test harness ────────────────────────────────
# The harness outputs PASS/FAIL lines and exits 0/1.
cd "$PROJECT_DIR"
exec bun run scripts/ws-test-harness.ts "$BASE_URL" "$AGENT_NAME"
