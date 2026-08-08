#!/usr/bin/env bash
# Proteus deploy pipeline — THE deploy path. `bun run deploy` runs this.
#
# Deploying any other way is how production once shipped without the CLI
# download assets: the site was fine, but /downloads/* answered with the SPA
# shell and every fresh install died on a checksum mismatch. Nothing here is
# optional-with-a-flag except SKIP_E2E; the gate below is what makes the
# difference between "the Worker uploaded" and "the product works".
#
# Deploys the cf-backend Worker (name "proteus") with the @cloudflare/sandbox
# Sandbox DO + Container binding, the NimbusSession DO, and the local-device
# executor routes. Pipeline: e2e verification → vite build → CLI source
# archive → wrangler deploy → smoke test.
#
# Where the static assets come from (settled by reading wrangler 4.97 source +
# `wrangler deploy --dry-run`, 2026-08-07):
#   - The vite plugin writes packages/cf-backend/.wrangler/deploy/config.json,
#     and `wrangler deploy` DOES follow it (the command declares
#     useConfigRedirectIfAvailable) — it deploys dist/proteus/wrangler.json.
#   - That generated config's assets.directory is "../client", and the user
#     config's is "dist/client". Both resolve to the SAME directory:
#     packages/cf-backend/dist/client. There is one assets dir, not two.
#   - dist/proteus/assets/ is NOT an assets dir. It is the worker bundle's
#     code-split chunk output, which wrangler attaches as worker modules.
#     Writing downloads there publishes nothing.
# Step 2 asserts this from wrangler's own output rather than trusting it.
#
# Usage:
#   bun run deploy                           # preferred
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

# ── Locate Proteus root ──────────────────────────────────────────
PROTEUS_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROTEUS_ROOT" || { echo -e "${RED}Cannot cd to Proteus root${NC}"; exit 1; }

export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-f44999d1ddda7012e9a87729eba250f1}"

# Captured during deploy for final summary
PROTEUS_URL="https://proteus.ashishkumarsingh.com/"
PROTEUS_VERSION=""
# The one directory wrangler publishes as static assets (see header).
PROTEUS_ASSETS_DIR="$PROTEUS_ROOT/packages/cf-backend/dist/client"
# build-cli-source-archive.sh stamps this sha into the archive, the published
# version.json, and therefore /api/health's build stamp.
PROTEUS_SHA="$(git -C "$PROTEUS_ROOT" rev-parse --short HEAD 2>/dev/null || echo dev)"

# Temp log file — trap cleans up on any exit.
PROTEUS_DEPLOY_LOG=""
cleanup() {
  [ -n "$PROTEUS_DEPLOY_LOG" ] && rm -f "$PROTEUS_DEPLOY_LOG"
}
trap cleanup EXIT INT TERM

# Read one dotted JSON field from stdin. Prints nothing when the body is not
# JSON — which is exactly what a smoke test needs, because "not JSON" is how a
# missing asset used to present itself (the SPA shell under a JSON
# content-type).
json_field() {
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=process.argv[1].split(".").reduce((o,k)=>o?.[k],JSON.parse(s));process.stdout.write(v==null?"":String(v))}catch{}})' "$1"
}

echo -e "${BOLD}Proteus Deploy Pipeline${NC}"
echo "========================"
echo "Proteus root: $PROTEUS_ROOT"
echo "Account:      $CLOUDFLARE_ACCOUNT_ID"
echo "Build sha:    $PROTEUS_SHA"
if [ -n "$(git -C "$PROTEUS_ROOT" status --porcelain 2>/dev/null)" ]; then
  echo -e "${YELLOW}Worktree is dirty — the published build stamp ($PROTEUS_SHA) will not describe what shipped.${NC}"
fi
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

echo "Building CLI source archive"
bash "$PROTEUS_ROOT/scripts/build-cli-source-archive.sh" || { echo -e "${RED}CLI source archive build failed${NC}"; exit 1; }

# Nothing may reach production without the three CLI download assets sitting in
# the directory wrangler publishes. A deploy missing them bricks every fresh
# install and update.
for asset in proteus-source.tar.gz proteus-source.tar.gz.sha256 proteus-version.json; do
  if [ ! -s "$PROTEUS_ASSETS_DIR/downloads/$asset" ]; then
    echo -e "${RED}❌ Missing build output: $PROTEUS_ASSETS_DIR/downloads/$asset${NC}"
    exit 1
  fi
done
echo -e "${GREEN}✅ CLI download assets staged in $PROTEUS_ASSETS_DIR/downloads${NC}"

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

# Wrangler names the assets directory it actually read. Assert it is the one we
# staged the downloads into, so a future config or plugin change that moves the
# assets dir fails here instead of silently shipping an assetless site.
DEPLOYED_ASSETS_DIR="$(grep -oE 'Read [0-9]+ files from the assets directory .*' "$PROTEUS_DEPLOY_LOG" | head -1 | sed 's|.*assets directory ||' | tr -d '\r')"
if [ "$DEPLOYED_ASSETS_DIR" = "$PROTEUS_ASSETS_DIR" ]; then
  echo -e "${GREEN}✅ Wrangler published assets from $PROTEUS_ASSETS_DIR${NC}"
else
  echo -e "${RED}❌ Wrangler published assets from '${DEPLOYED_ASSETS_DIR:-<not reported>}'${NC}"
  echo "   Expected: $PROTEUS_ASSETS_DIR (the directory the CLI downloads were staged into)."
  echo "   Reconcile packages/cf-backend/wrangler.jsonc, the vite plugin's"
  echo "   .wrangler/deploy/config.json redirect, and this script's header."
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

# One GET that answers "did my deploy land?". /api/health reads its build stamp
# out of the deployed asset bundle, so a mismatch here also means the CLI
# download assets are stale or missing.
HEALTH_JSON=$(curl -s --max-time 15 "${PROTEUS_URL}api/health" 2>/dev/null)
HEALTH_SHA=$(printf '%s' "$HEALTH_JSON" | json_field build.sha)
if [ "$HEALTH_SHA" = "$PROTEUS_SHA" ]; then
  echo -e "${GREEN}✅ /api/health reports the deployed build ($PROTEUS_SHA)${NC}"
else
  echo -e "${RED}❌ /api/health build stamp is '${HEALTH_SHA:-<none>}', expected '$PROTEUS_SHA'${NC}"
  echo "   Body: ${HEALTH_JSON:0:200}"
  SMOKE_FAIL=1
fi

# The §0 regression: this asset once came back as the SPA shell wearing an
# application/json content-type, so `proteus update` could never see a version.
VERSION_SHA=$(curl -fsSL --max-time 15 "${PROTEUS_URL}downloads/proteus-version.json" 2>/dev/null | json_field sha)
if [ "$VERSION_SHA" = "$PROTEUS_SHA" ]; then
  echo -e "${GREEN}✅ Published proteus-version.json is real JSON for this build${NC}"
else
  echo -e "${RED}❌ Published proteus-version.json sha is '${VERSION_SHA:-<unparseable>}', expected '$PROTEUS_SHA'${NC}"
  SMOKE_FAIL=1
fi

CLI_SHIM=$(curl -s --max-time 15 "${PROTEUS_URL}downloads/proteus" 2>/dev/null)
if echo "$CLI_SHIM" | grep -q 'downloads/proteus-source.tar.gz' && ! echo "$CLI_SHIM" | grep -q 'github.com'; then
  echo -e "${GREEN}✅ Proteus CLI shim uses deployed source archive${NC}"
else
  echo -e "${RED}❌ Proteus CLI shim is not using the deployed source archive${NC}"
  SMOKE_FAIL=1
fi

CLI_ARCHIVE_TMP="$(mktemp -t proteus-cli-source.XXXXXX.tar.gz)"
CLI_ARCHIVE_LIST="$(mktemp -t proteus-cli-source.XXXXXX.list)"
CLI_ARCHIVE_OK=0
for attempt in 1 2 3 4 5 6; do
  if curl -fsSL --max-time 30 "${PROTEUS_URL}downloads/proteus-source.tar.gz" -o "$CLI_ARCHIVE_TMP" \
    && tar -tzf "$CLI_ARCHIVE_TMP" > "$CLI_ARCHIVE_LIST" \
    && grep -Fq 'proteus/packages/cli/src/commands/setup.ts' "$CLI_ARCHIVE_LIST"; then
    CLI_ARCHIVE_OK=1
    break
  fi
  [ "$attempt" = "6" ] || sleep 5
done
if [ "$CLI_ARCHIVE_OK" = "1" ]; then
  echo -e "${GREEN}✅ Proteus CLI source archive is downloadable${NC}"
  # The CLI shim verifies this checksum by default — a stale/missing .sha256
  # bricks installs and updates, so the deploy gate checks it too.
  PUBLISHED_SHA="$(curl -fsSL --max-time 15 "${PROTEUS_URL}downloads/proteus-source.tar.gz.sha256" 2>/dev/null | awk '{print $1}')"
  ACTUAL_SHA="$(sha256sum "$CLI_ARCHIVE_TMP" | awk '{print $1}')"
  if [ -n "$PUBLISHED_SHA" ] && [ "$PUBLISHED_SHA" = "$ACTUAL_SHA" ]; then
    echo -e "${GREEN}✅ Proteus CLI source checksum matches the published .sha256${NC}"
  else
    echo -e "${RED}❌ Published source checksum is missing or does not match the archive${NC}"
    SMOKE_FAIL=1
  fi
else
  echo -e "${RED}❌ Proteus CLI source archive is missing or invalid${NC}"
  SMOKE_FAIL=1
fi
rm -f "$CLI_ARCHIVE_TMP" "$CLI_ARCHIVE_LIST"

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
echo "          build   $PROTEUS_SHA"
echo ""
echo -e "${GREEN}✅ Proteus Worker deployed and verified.${NC}"
