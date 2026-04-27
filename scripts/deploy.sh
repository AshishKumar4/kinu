#!/usr/bin/env bash
# Proteus deploy pipeline.
#
# Deploys the cf-backend Worker (name "proteus") with the @cloudflare/sandbox
# SANDBOX DO + Container binding. Nimbus has been shelved; the legacy
# SKIP_NIMBUS flag is accepted for backward compat but does nothing.
#
# Usage:
#   bash scripts/deploy.sh
#   SKIP_E2E=1 bash scripts/deploy.sh        # skip pre-deploy verification
#   CLOUDFLARE_ACCOUNT_ID=... scripts/deploy.sh
#
# Idempotent: safe to re-run. Exits on first failure.
set -uo pipefail

GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

# ── Locate Proteus root + Nimbus path ────────────────────────────
PROTEUS_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROTEUS_ROOT" || { echo -e "${RED}Cannot cd to Proteus root${NC}"; exit 1; }

export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-f44999d1ddda7012e9a87729eba250f1}"

# Captured during deploy for final summary
PROTEUS_URL="https://proteus.ashishkumarsingh.com/"
PROTEUS_VERSION=""

# Temp log file — trap cleans up on any exit.
PROTEUS_DEPLOY_LOG=""
cleanup() {
  [ -n "$PROTEUS_DEPLOY_LOG" ] && rm -f "$PROTEUS_DEPLOY_LOG"
}
trap cleanup EXIT INT TERM

echo -e "${BOLD}Proteus Deploy Pipeline${NC}"
echo "========================"
echo "Proteus root: $PROTEUS_ROOT"
echo "Account:      $CLOUDFLARE_ACCOUNT_ID"
echo ""

# ── Pre-flight: verify npx + wrangler auth ───────────────────────
if ! command -v npx >/dev/null 2>&1; then
  echo -e "${RED}npx not found — install Node.js${NC}"
  exit 1
fi
if ! npx wrangler whoami >/dev/null 2>&1; then
  echo -e "${RED}Wrangler not authenticated.${NC}"
  echo "Run: npx wrangler login"
  exit 1
fi

# ── Step 1: Pre-deploy verification ──────────────────────────────
echo -e "${BOLD}Step 1: Pre-deploy verification${NC}"
if [ "${SKIP_E2E:-0}" = "1" ]; then
  echo -e "${YELLOW}SKIP_E2E=1 — skipping E2E suite${NC}"
else
  if bash scripts/e2e-test.sh; then
    echo ""
    echo -e "${GREEN}Pre-deploy checks passed.${NC}"
  else
    echo ""
    echo -e "${RED}Pre-deploy checks failed. Fix issues before deploying.${NC}"
    echo "(Re-run with SKIP_E2E=1 to bypass, e.g. for a doc-only or config-only deploy.)"
    exit 1
  fi
fi

# Legacy: SKIP_NIMBUS is accepted for backward compat but is a no-op now
# (Nimbus has been shelved in favor of @cloudflare/sandbox).
if [ "${SKIP_NIMBUS:-0}" = "1" ]; then
  echo -e "${YELLOW}SKIP_NIMBUS=1 ignored — Nimbus has been shelved.${NC}"
fi

# ── Step 2: Deploy Proteus ───────────────────────────────────────
echo ""
echo -e "${BOLD}Step 2: Deploying Proteus${NC}"
cd "$PROTEUS_ROOT/packages/cf-backend" || { echo -e "${RED}cannot cd to cf-backend${NC}"; exit 1; }

# Install deps + build static assets.
if [ ! -d "$PROTEUS_ROOT/node_modules" ]; then
  echo "Installing Proteus dependencies (root node_modules missing)..."
  (cd "$PROTEUS_ROOT" && bun install) || { echo -e "${RED}bun install failed in Proteus${NC}"; exit 1; }
fi

# Build the client bundle into dist/client (used by wrangler's assets directive).
if [ -f ./node_modules/.bin/vite ]; then
  echo "Running: vite build"
  ./node_modules/.bin/vite build || { echo -e "${RED}vite build failed${NC}"; exit 1; }
else
  echo "Running: bunx vite build"
  bunx vite build || { echo -e "${RED}vite build failed${NC}"; exit 1; }
fi

PROTEUS_DEPLOY_LOG="$(mktemp -t proteus-deploy.XXXXXX.log)"
echo ""
echo "Running: npx wrangler deploy (log → $PROTEUS_DEPLOY_LOG)"
echo ""
if npx wrangler deploy 2>&1 | tee "$PROTEUS_DEPLOY_LOG"; then
  echo ""
  echo -e "${GREEN}Proteus deploy succeeded.${NC}"
else
  echo ""
  echo -e "${RED}Proteus deploy failed — see log above.${NC}"
  exit 1
fi

PROTEUS_VERSION="$(grep -oE 'Version ID:[[:space:]]*[a-f0-9-]+' "$PROTEUS_DEPLOY_LOG" | head -1 | awk '{print $NF}')"

# Verify wrangler echoed the Sandbox binding (proves @cloudflare/sandbox is wired).
# Binding name is "Sandbox" (capital S) — the SDK hardcodes env.Sandbox lookup.
if grep -qE 'ProteusSandbox' "$PROTEUS_DEPLOY_LOG"; then
  echo -e "${GREEN}✅ Proteus bound Sandbox (ProteusSandbox DO + Container)${NC}"
else
  echo -e "${RED}❌ wrangler output did not mention the Sandbox binding${NC}"
  echo "   Check that packages/cf-backend/wrangler.jsonc includes:"
  echo "     { \"class_name\": \"ProteusSandbox\", \"name\": \"Sandbox\" }"
  echo "   and a \"containers\" block."
  exit 1
fi

cd "$PROTEUS_ROOT" || exit 1

# ── Step 3: Post-deploy smoke test ───────────────────────────────
echo ""
echo -e "${BOLD}Step 3: Post-deploy smoke test${NC}"
echo "Waiting 10s for deployments to propagate..."
sleep 10

SMOKE_FAIL=0

# Proteus (production route).
LIVE_STATUS=$(curl -so /dev/null -w '%{http_code}' --max-time 15 "$PROTEUS_URL" 2>/dev/null || echo "000")
if [ "$LIVE_STATUS" = "200" ]; then
  echo -e "${GREEN}✅ Proteus live site returns 200${NC} ($PROTEUS_URL)"
else
  echo -e "${RED}❌ Proteus live site returns $LIVE_STATUS${NC} ($PROTEUS_URL)"
  SMOKE_FAIL=1
fi

LIVE_HTML=$(curl -s --max-time 15 "$PROTEUS_URL" 2>/dev/null)
if echo "$LIVE_HTML" | grep -qi 'proteus'; then
  echo -e "${GREEN}✅ Proteus live site serves Proteus app${NC}"
else
  echo -e "${RED}❌ Proteus live site content missing 'Proteus'${NC}"
  SMOKE_FAIL=1
fi

if [ "$SMOKE_FAIL" -ne 0 ]; then
  echo ""
  echo -e "${RED}Smoke test failed.${NC}"
  exit 1
fi

# ── Step 4: Summary ──────────────────────────────────────────────
echo ""
echo -e "${BOLD}Deploy complete.${NC}"
echo "================================="
echo "Proteus:  $PROTEUS_URL"
echo "          version ${PROTEUS_VERSION:-unknown}"
echo ""
echo -e "${GREEN}✅ Proteus Worker deployed and verified.${NC}"
