#!/usr/bin/env bash
# Proteus deploy pipeline — THE deploy path. `bun run deploy` runs this.
#
# Deploying any other way is how production once shipped without the CLI
# download assets: the site was fine, but /downloads/* answered with the SPA
# shell and every fresh install died on a checksum mismatch. Nothing here is
# optional. The gate below is what makes the difference between "the Worker
# uploaded" and "the product works".
#
# Deploys the cf-backend Worker (name "proteus") with the @cloudflare/sandbox
# Sandbox DO + Container binding, the NimbusSession DO, and the local-device
# executor routes. Pipeline: strict repository gates → vite build → CLI source
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
# Step 3 asserts this from wrangler's own output rather than trusting it.
#
# Usage:
#   bun run deploy                           # preferred
#   bash scripts/deploy.sh
#   CLOUDFLARE_ACCOUNT_ID=... scripts/deploy.sh
#
# Idempotent: safe to re-run. Exits on first failure.
set -uo pipefail

GREEN='\033[0;32m'
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

run_required_gate() {
  local label="$1"
  shift
  echo "Running: $*"
  if "$@"; then
    echo -e "${GREEN}✅ $label passed${NC}"
  else
    echo -e "${RED}❌ $label failed. The production build and publish steps did not start.${NC}"
    exit 1
  fi
}

echo -e "${BOLD}Proteus Deploy Pipeline${NC}"
echo "========================"
echo "Proteus root: $PROTEUS_ROOT"
echo "Account:      $CLOUDFLARE_ACCOUNT_ID"
echo "Build sha:    $PROTEUS_SHA"
if [ -n "$(git -C "$PROTEUS_ROOT" status --porcelain 2>/dev/null)" ]; then
  echo -e "${RED}Worktree is dirty — build $PROTEUS_SHA would not describe the bytes being published.${NC}"
  echo "Commit the verified tree before deploying."
  exit 1
fi
echo ""
# Preflight FIRST — before the tool checks, before `bun install`, before any
# gate. Its whole job is to refuse to report on a poisoned environment, so it
# has to run before anything that could be poisoned: an exhausted $TMPDIR inode
# table surfaces later as a 5-second timeout inside an unrelated filesystem
# test, which reads as a code regression and is not one. Running it at gate 1
# still left `bun install` and the wrangler auth probe ahead of it. It repairs
# nothing; `--reclaim` is explicit and separate.
run_required_gate "Environment preflight" bun scripts/preflight.ts

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

# The strict gates need the locked dependency graph, but dependency setup is
# not a build or publish operation. Do it before verification when a checkout
# has not been prepared yet; never let deploy update the lockfile.
if [ ! -d "$PROTEUS_ROOT/node_modules" ]; then
  echo "Installing Proteus dependencies (root node_modules missing)..."
  bun install --frozen-lockfile \
    || { echo -e "${RED}bun install failed in Proteus${NC}"; exit 1; }
fi

# ── Step 1: Required pre-deploy gates ────────────────────────────
echo -e "${BOLD}Step 1: Required pre-deploy gates${NC}"

# Keep the commands explicit and unconditional. These are the same strict,
# credential-free gates used by the repository workflows, plus the complete
# package test script and both Layergate proofs. No environment variable may
# skip one when this production deploy path is running.
run_required_gate "Strict lint and TypeScript" bun run check
run_required_gate "Production deploy contract" bun test scripts/deploy.test.ts
run_required_gate "Agent-utils, Core, and compaction suites" bun run test
run_required_gate "Test-utils suite" bun test packages/test-utils/
run_required_gate "Cloudflare backend and conformance suite" bun test packages/cf-backend/
run_required_gate "Durable Object semantics under workerd" bun run test:workerd
run_required_gate "CLI backend and conformance suite" bun test packages/cli-backend/
run_required_gate "Full production CLI suite" bun test packages/cli/
run_required_gate "Evaluation gate logic" bun test scripts/eval.test.ts
run_required_gate "Benchmark harness guarantees" bun test scripts/bench*.test.ts packages/core/tests/unit-bench*.test.ts
run_required_gate "Secret scanner self-test" bun test scripts/secret-scan.test.ts
run_required_gate "Secret scan" bun scripts/secret-scan.ts
run_required_gate "Schema drift" bun scripts/schema-drift.ts
# Traces are a separate switch from logs and wrangler does not inherit
# `observability` into a named environment, so this asserts every deployable
# environment has them on — and proves the tracer is live by observing real
# spans under workerd with and without a tail sink, so green cannot come from
# an empty result. Credential-free, 0.3 s.
run_required_gate "Tracing wired end to end" bun scripts/tracing-gate.ts
# `gate:computed-style` is deliberately NOT here: it boots vite and Chrome over
# 19 gallery frames (~68 s) and would fail this pipeline for environmental
# reasons unrelated to the change under test. It is a deliberate standalone run.
# Its DECISION LOGIC is guarded below, though — a gate kept off the path for its
# cost still needs its own reasoning tested, or the thing that would have caught
# `--radius` undefined at `:root` is itself unguarded.
run_required_gate "Gate self-tests" bun test scripts/gates.test.ts scripts/reachability.test.ts scripts/do-init-gate.test.ts scripts/platform-catalog.test.ts scripts/policy-drift.test.ts scripts/scratch-ownership.test.ts scripts/literature-citations.test.ts
run_required_gate "Skip ratchet and typecheck coverage self-tests" bun test scripts/skip-ratchet.test.ts scripts/typecheck-coverage.test.ts
run_required_gate "Set-equality gate self-tests" bun test scripts/gate-set-equality.test.ts
run_required_gate "UI gate self-tests" bun test scripts/chat-and-files-ux.test.ts scripts/computed-style.test.ts
run_required_gate "Gate ladder wiring" bun test scripts/ladder.test.ts
run_required_gate "Dead code" bun run gate:dead-code
run_required_gate "Duplicate implementations" bun run gate:duplication
run_required_gate "Cross-backend capability parity" bun run gate:capability-parity
run_required_gate "Duplicated policy constants" bun run gate:policy-drift
run_required_gate "Test scratch ownership" bun run gate:scratch-ownership
run_required_gate "Agents action/field relation" bun run gate:agents-fields
run_required_gate "Durable Object cold start" bun run gate:do-init
run_required_gate "Unreachable RPC surface" bun run gate:reachability
run_required_gate "Platform fact catalog" bun run gate:platform
run_required_gate "Egress interception totality" bun run gate:egress-interception
run_required_gate "Typecheck coverage" bun run gate:typecheck-coverage
run_required_gate "Declared skip ratchet" bun run gate:skip-ratchet
run_required_gate "Measured set equals governed set" bun run gate:set-equality
run_required_gate "External citation register" bun run gate:literature-citations
run_required_gate "Dependency install-script policy" bun run gate:install-scripts
run_required_gate "Dependency advisory policy" bun run gate:dependency-advisories
run_required_gate "Local-device daemon suite" bun test packages/pc-agent/
run_required_gate "Root end-to-end lifecycle suites" bun test ./tests/
run_required_gate "Behavioural evals" bun run test:eval
run_required_gate "Layergate conformance" bun run layergate
run_required_gate "Layergate fault-localization matrix" bun run layergate --matrix
run_required_gate "Lean proofs, consistency, and traceability" bun run verify:lean

echo ""
echo -e "${GREEN}All required pre-deploy gates passed.${NC}"

# ── Step 2: Build Proteus ────────────────────────────────────────
echo ""
echo -e "${BOLD}Step 2: Building Proteus${NC}"
cd "$PROTEUS_ROOT/packages/cf-backend" || { echo -e "${RED}cannot cd to cf-backend${NC}"; exit 1; }

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

# ── Step 3: Deploy Proteus ───────────────────────────────────────
echo ""
echo -e "${BOLD}Step 3: Deploying Proteus${NC}"
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

# ── Step 4: Post-deploy smoke test ───────────────────────────────
echo ""
echo -e "${BOLD}Step 4: Post-deploy smoke test${NC}"
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
# download assets are stale or missing. Edge rollout takes up to ~2 minutes,
# so the stamp check retries with backoff before calling the deploy bad —
# a stamp that NEVER converges is the real failure this guards.
HEALTH_SHA=""
for _try in 1 2 3 4 5 6 7 8; do
  HEALTH_JSON=$(curl -s --max-time 15 "${PROTEUS_URL}api/health?smoke=$_try" 2>/dev/null)
  HEALTH_SHA=$(printf '%s' "$HEALTH_JSON" | json_field build.sha)
  [ "$HEALTH_SHA" = "$PROTEUS_SHA" ] && break
  sleep 15
done
if [ "$HEALTH_SHA" = "$PROTEUS_SHA" ]; then
  echo -e "${GREEN}✅ /api/health reports the deployed build ($PROTEUS_SHA)${NC}"
else
  echo -e "${RED}❌ /api/health build stamp is '${HEALTH_SHA:-<none>}', expected '$PROTEUS_SHA'${NC}"
  echo "   Body: ${HEALTH_JSON:0:200}"
  SMOKE_FAIL=1
fi

# The §0 regression: this asset once came back as the SPA shell wearing an
# application/json content-type, so `proteus update` could never see a version.
VERSION_SHA=""
for _try in 1 2 3 4 5 6 7 8; do
  VERSION_SHA=$(curl -fsSL --max-time 15 "${PROTEUS_URL}downloads/proteus-version.json?smoke=$_try" 2>/dev/null | json_field sha)
  [ "$VERSION_SHA" = "$PROTEUS_SHA" ] && break
  sleep 15
done
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

# ── Step 5: Summary ──────────────────────────────────────────────
echo ""
echo -e "${BOLD}Deploy complete.${NC}"
echo "================================="
echo "Proteus:  $PROTEUS_URL"
echo "          version ${PROTEUS_VERSION:-unknown}"
echo "          build   $PROTEUS_SHA"
echo ""
echo -e "${GREEN}✅ Proteus Worker deployed and verified.${NC}"
