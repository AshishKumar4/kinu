#!/usr/bin/env bash
# Proteus end-to-end verification script.
# Exercises every major feature without requiring LLM credentials.
# For full E2E with real LLM calls, run: bun test tests/e2e-full-lifecycle.test.ts
set -uo pipefail

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
NC='\033[0m'

PASS=0
FAIL=0
SKIP=0
INFO=0
RESULTS=()

check() {
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then
    RESULTS+=("${GREEN}✅ PASS${NC}: $name")
    ((PASS++))
  else
    RESULTS+=("${RED}❌ FAIL${NC}: $name")
    ((FAIL++))
  fi
}

check_output() {
  local name="$1"; shift
  local output
  output=$("$@" 2>&1)
  local code=$?
  if [ $code -eq 0 ]; then
    RESULTS+=("${GREEN}✅ PASS${NC}: $name")
    ((PASS++))
  else
    RESULTS+=("${RED}❌ FAIL${NC}: $name")
    RESULTS+=("         ${output:0:200}")
    ((FAIL++))
  fi
}

skip() {
  local name="$1"; local reason="$2"
  RESULTS+=("${YELLOW}⏭  SKIP${NC}: $name ($reason)")
  ((SKIP++))
}

# A measurement with no pass/fail criterion. It is NOT counted as a pass — a
# line that says PASS whatever the number is inflates the score and hides the
# number it was added to surface.
info() {
  RESULTS+=("${BOLD}ℹ  INFO${NC}: $1")
  ((INFO++))
}

cd "$(dirname "$0")/.." || exit 1
echo -e "${BOLD}Proteus End-to-End Verification${NC}"
echo "================================"
echo ""

# ═══════════════════════════════════════════════════════════════════
# §1. Build verification
# ═══════════════════════════════════════════════════════════════════
echo -e "${BOLD}§1. Build Verification${NC}"

# Unit tests
UNIT_OUTPUT=$(NODE_TLS_REJECT_UNAUTHORIZED=0 bun test packages/core/tests/ --timeout 60000 2>&1)
UNIT_PASS=$(echo "$UNIT_OUTPUT" | grep -oP '\d+ pass' | grep -oP '\d+')
UNIT_FAIL=$(echo "$UNIT_OUTPUT" | grep -oP '\d+ fail' | grep -oP '\d+')
if [ "${UNIT_FAIL:-0}" = "0" ] && [ "${UNIT_PASS:-0}" -ge 50 ]; then
  RESULTS+=("${GREEN}✅ PASS${NC}: Unit tests (${UNIT_PASS} pass, ${UNIT_FAIL:-0} fail)")
  ((PASS++))
else
  RESULTS+=("${RED}❌ FAIL${NC}: Unit tests (${UNIT_PASS:-?} pass, ${UNIT_FAIL:-?} fail)")
  ((FAIL++))
fi

# Eval quality-gate logic (credential-free — stubbed model + judge). The live
# benchmark that makes real model calls runs in the gated eval.yml workflow.
check "Eval gate logic (cred-free)" bun test scripts/eval.test.ts

# Secret scan
SECRET_HITS=$(grep -rn 'A9Z9eTP9\|cfut_' . --include='*.ts' --include='*.tsx' --include='*.json' --include='*.jsonc' --include='*.md' 2>/dev/null | grep -v node_modules | grep -v .wrangler | grep -v .dev.vars | grep -v '.git/' | wc -l)
if [ "$SECRET_HITS" = "0" ]; then
  RESULTS+=("${GREEN}✅ PASS${NC}: No secrets in codebase")
  ((PASS++))
else
  RESULTS+=("${RED}❌ FAIL${NC}: Found $SECRET_HITS secret reference(s)")
  ((FAIL++))
fi

echo ""

# ═══════════════════════════════════════════════════════════════════
# §2. Architecture verification
# ═══════════════════════════════════════════════════════════════════
echo -e "${BOLD}§2. Architecture Verification${NC}"

# Execution layer completeness: the barrel must resolve (every module it
# re-exports still exists) and must still expose the router plus the four
# reusable provider factories checked below.
EXEC_DIR="packages/core/src/execution"
EXEC_BARREL="$EXEC_DIR/index.ts"
EXEC_MISSING=""
for mod in $(grep -oE "from '\./[a-z0-9-]+\.js'" "$EXEC_BARREL" 2>/dev/null | sed "s|from './||; s|\.js'||" | sort -u); do
  [ -f "$EXEC_DIR/$mod.ts" ] || EXEC_MISSING="$EXEC_MISSING $mod"
done
EXEC_EXPORTS="DefaultExecutionRouter createInlineExecutor createNimbusExecutor createSandboxExecutor createDeviceTunnelExecutor"
EXEC_UNEXPORTED=""
for sym in $EXEC_EXPORTS; do
  grep -qE "\b$sym\b" "$EXEC_BARREL" 2>/dev/null || EXEC_UNEXPORTED="$EXEC_UNEXPORTED $sym"
done
if [ -f "$EXEC_BARREL" ] && [ -z "$EXEC_MISSING" ] && [ -z "$EXEC_UNEXPORTED" ]; then
  RESULTS+=("${GREEN}✅ PASS${NC}: Execution layer barrel resolves and exports the router + all 4 executor factories")
  ((PASS++))
else
  RESULTS+=("${RED}❌ FAIL${NC}: Execution layer — missing modules:${EXEC_MISSING:- none} unexported:${EXEC_UNEXPORTED:- none}")
  ((FAIL++))
fi

# Canonical built-in architecture: one registry declares the built-in tool
# surface, and every backend builds its tools from @proteus/core's
# buildBuiltinTools — no backend-local tool factory, no legacy buildAgentTools.
REGISTRY_PROBE="import { BUILTIN_TOOLS } from './packages/core/src/tools/registry.ts'; console.log([...BUILTIN_TOOLS].sort().join(','))"
EXPECTED_TOOLS='agents,execute_tools,file,memory,report,run,tasks,web'
REGISTRY_TOOLS=$(bun -e "$REGISTRY_PROBE" 2>/dev/null | tail -n 1)
# Each actor composition root consumes the shared factory. The HEAD toolset
# builder now lives in core (packages/core/src/heads/head-tools.ts) so both
# backends build forks from one source instead of a per-backend copy — that
# hoist is what fixed local forks running over an empty in-memory world, so
# the guard asserts the shared location, not the old cf-local one.
SHARED_FACTORY_CALL='const [A-Za-z_$][A-Za-z0-9_$]* = buildBuiltinTools\('
CF_USES_FACTORY=$(grep -lE "$SHARED_FACTORY_CALL" packages/cf-backend/src/actor-agent.ts 2>/dev/null | wc -l)
CLI_USES_FACTORY=$(grep -lE "$SHARED_FACTORY_CALL" packages/cli-backend/src/local-session.ts 2>/dev/null | wc -l)
HEADS_SHARED=$(grep -lE "$SHARED_FACTORY_CALL" packages/core/src/heads/head-tools.ts 2>/dev/null | wc -l)
LEGACY_FACTORY=$(grep -rlE 'buildAgentTools\(' packages/*/src 2>/dev/null | wc -l)
if [ "$REGISTRY_TOOLS" = "$EXPECTED_TOOLS" ] && [ "$CF_USES_FACTORY" -eq 1 ] && [ "$CLI_USES_FACTORY" -eq 1 ] && [ "$HEADS_SHARED" -eq 1 ] && [ "$LEGACY_FACTORY" -eq 0 ]; then
  # The count is read back from the probe rather than written here: the exact
  # SET is already pinned by EXPECTED_TOOLS above, and a second hand-kept
  # number only ever goes stale.
  RESULTS+=("${GREEN}✅ PASS${NC}: Built-in tool architecture ($(echo "$REGISTRY_TOOLS" | tr ',' '\n' | wc -l)-tool registry; CF actor, CLI backend, and the shared core head builder all consume buildBuiltinTools)")
  ((PASS++))
else
  RESULTS+=("${RED}❌ FAIL${NC}: Tool architecture — registry=${REGISTRY_TOOLS:-<unreadable>} cf=$CF_USES_FACTORY/1 cli=$CLI_USES_FACTORY/1 heads=$HEADS_SHARED/1 legacy=$LEGACY_FACTORY")
  RESULTS+=("         expected registry: $EXPECTED_TOOLS")
  RESULTS+=("         registry probe:    bun -e \"\$REGISTRY_PROBE\"")
  ((FAIL++))
fi

# CraftStore EMA scoring wired
if grep -q 'updateCraftScores\|emaUpdate' packages/core/src/evolution/engine.ts 2>/dev/null; then
  RESULTS+=("${GREEN}✅ PASS${NC}: CraftStore EMA scoring wired in evolution engine")
  ((PASS++))
else
  RESULTS+=("${YELLOW}⏭  SKIP${NC}: CraftStore EMA scoring (not yet wired)")
  ((SKIP++))
fi

# Lean↔TypeScript traceability manifest. lean/traceability.yaml replaced the
# old lean/generated/.ts-checksums drift manifest; --manifest-only runs every
# toolchain-free check (well-formedness, tsRefs resolve, claimed theorems exist
# as source declarations) without needing lake.
check_output "Lean↔TS traceability manifest (lean/traceability.yaml)" node lean/check-traceability.mjs --manifest-only

# Lean proof files
LEAN_COUNT=$(find lean/Proteus -name "*.lean" 2>/dev/null | wc -l)
if [ "$LEAN_COUNT" -ge 10 ]; then
  RESULTS+=("${GREEN}✅ PASS${NC}: Lean proof files ($LEAN_COUNT modules)")
  ((PASS++))
else
  RESULTS+=("${RED}❌ FAIL${NC}: Expected 10+ Lean files, found $LEAN_COUNT")
  ((FAIL++))
fi

# Lean sorry count. Reported, never scored: nothing in this repo gates the
# count (verify-lean.sh does not), so there is no criterion to pass. It used to
# print PASS unconditionally, which is how 11 open proofs read as a green line.
SORRY_HITS=$(grep -rn '\bsorry\b' lean/Proteus/ --include='*.lean' 2>/dev/null | grep -v '^[[:space:]]*--' || true)
SORRY_COUNT=$(printf '%s' "$SORRY_HITS" | grep -c . || true)
SORRY_MODULES=$(printf '%s' "$SORRY_HITS" | cut -d: -f1 | sort -u | grep -c . || true)
info "Lean sorry count: $SORRY_COUNT across $SORRY_MODULES module(s) — ungated"

echo ""

# ═══════════════════════════════════════════════════════════════════
# §3. Documentation verification
# ═══════════════════════════════════════════════════════════════════
echo -e "${BOLD}§3. Documentation Verification${NC}"

EXPECTED_DOCS="docs/ARCHITECTURE.md docs/EVOLUTION.md docs/MCTS.md docs/TOOLS.md docs/STORAGE.md docs/DEPLOYMENT.md docs/FORMAL-SPEC.md docs/APPLICATIONS.md docs/NIMBUS-INTEGRATION.md docs/EXECUTION-LAYER-SPEC.md"
MISSING_DOCS=0
for doc in $EXPECTED_DOCS; do
  [ -f "$doc" ] || ((MISSING_DOCS++))
done
if [ "$MISSING_DOCS" = "0" ]; then
  RESULTS+=("${GREEN}✅ PASS${NC}: All 10 documentation files present")
  ((PASS++))
else
  RESULTS+=("${RED}❌ FAIL${NC}: $MISSING_DOCS documentation file(s) missing")
  ((FAIL++))
fi

# CI workflows
CI_FILES=".github/workflows/lean-verify.yml .github/workflows/security-scan.yml"
ALL_CI=true
for f in $CI_FILES; do
  [ -f "$f" ] || ALL_CI=false
done
if $ALL_CI; then
  RESULTS+=("${GREEN}✅ PASS${NC}: CI workflows present (lean-verify, security-scan)")
  ((PASS++))
else
  RESULTS+=("${RED}❌ FAIL${NC}: CI workflow(s) missing")
  ((FAIL++))
fi

echo ""

# ═══════════════════════════════════════════════════════════════════
# §4. Package structure verification
# ═══════════════════════════════════════════════════════════════════
echo -e "${BOLD}§4. Package Structure${NC}"

PACKAGES="packages/core packages/cf-backend packages/cli packages/cli-backend packages/agent-utils"
MISSING_PKG=0
for pkg in $PACKAGES; do
  [ -d "$pkg/src" ] || ((MISSING_PKG++))
done
if [ "$MISSING_PKG" = "0" ]; then
  RESULTS+=("${GREEN}✅ PASS${NC}: All 5 packages present with src/ directories")
  ((PASS++))
else
  RESULTS+=("${RED}❌ FAIL${NC}: $MISSING_PKG package(s) missing")
  ((FAIL++))
fi

# Core exports check
CORE_EXPORTS=$(grep -c 'export' packages/core/src/index.ts 2>/dev/null || echo 0)
if [ "$CORE_EXPORTS" -ge 30 ]; then
  RESULTS+=("${GREEN}✅ PASS${NC}: Core barrel export ($CORE_EXPORTS exports)")
  ((PASS++))
else
  RESULTS+=("${RED}❌ FAIL${NC}: Core exports seem low ($CORE_EXPORTS)")
  ((FAIL++))
fi

echo ""

# ═══════════════════════════════════════════════════════════════════
# §5. Deployment verification (live site)
# ═══════════════════════════════════════════════════════════════════
echo -e "${BOLD}§5. Deployment Verification${NC}"

LIVE_URL="https://proteus.ashishkumarsingh.com/"
LIVE_STATUS=$(curl -so /dev/null -w '%{http_code}' --max-time 10 "$LIVE_URL" 2>/dev/null || echo "000")
if [ "$LIVE_STATUS" = "200" ]; then
  RESULTS+=("${GREEN}✅ PASS${NC}: Live site returns 200 ($LIVE_URL)")
  ((PASS++))
  LIVE_HTML=$(curl -s --max-time 10 "$LIVE_URL" 2>/dev/null)
  if echo "$LIVE_HTML" | grep -qi 'proteus'; then
    RESULTS+=("${GREEN}✅ PASS${NC}: Live site HTML contains 'Proteus'")
    ((PASS++))
  else
    RESULTS+=("${RED}❌ FAIL${NC}: Live site HTML missing 'Proteus' text")
    ((FAIL++))
  fi
else
  skip "Live site check" "HTTP $LIVE_STATUS (site may not be deployed)"
  skip "Live site content" "depends on live site"
fi

echo ""

# ═══════════════════════════════════════════════════════════════════
# §6. Local dev server (if running)
# ═══════════════════════════════════════════════════════════════════
echo -e "${BOLD}§6. Local Dev Server${NC}"

LOCAL_STATUS=$(curl -so /dev/null -w '%{http_code}' --max-time 3 "http://localhost:5173/" 2>/dev/null || echo "000")
if [ "$LOCAL_STATUS" = "200" ]; then
  RESULTS+=("${GREEN}✅ PASS${NC}: Local dev server running on :5173")
  ((PASS++))
  LOCAL_HTML=$(curl -s --max-time 3 "http://localhost:5173/" 2>/dev/null)
  if echo "$LOCAL_HTML" | grep -qi 'proteus\|vite'; then
    RESULTS+=("${GREEN}✅ PASS${NC}: Local dev server serves app content")
    ((PASS++))
  else
    RESULTS+=("${RED}❌ FAIL${NC}: Local dev server response missing expected content")
    ((FAIL++))
  fi
else
  skip "Local dev server" "not running on :5173"
  skip "Local dev content" "depends on local server"
fi

# ═══════════════════════════════════════════════════════════════════
# §7. Real E2E — Web (WebSocket + HTTP against running dev server)
# ═══════════════════════════════════════════════════════════════════
echo -e "${BOLD}§7. Web E2E (live agent tests)${NC}"

WEB_E2E="$(dirname "$0")/e2e-web.sh"
if [ -x "$WEB_E2E" ]; then
  bash "$WEB_E2E"; WEB_CODE=$?
  case "$WEB_CODE" in
    0) RESULTS+=("${GREEN}✅ PASS${NC}: Web E2E tests passed"); ((PASS++)) ;;
    2) skip "Web E2E tests" "dev server not reachable on :5173" ;;
    *) RESULTS+=("${RED}❌ FAIL${NC}: Web E2E tests failed (exit $WEB_CODE)"); ((FAIL++)) ;;
  esac
else
  skip "Web E2E tests" "scripts/e2e-web.sh not found or not executable"
fi

echo ""

# ═══════════════════════════════════════════════════════════════════
# §8. Real E2E — CLI (local agent lifecycle)
# ═══════════════════════════════════════════════════════════════════
echo -e "${BOLD}§8. CLI E2E (local agent lifecycle)${NC}"

CLI_E2E="$(dirname "$0")/e2e-cli.sh"
if [ -x "$CLI_E2E" ]; then
  if bash "$CLI_E2E"; then
    RESULTS+=("${GREEN}✅ PASS${NC}: CLI E2E tests passed")
    ((PASS++))
  else
    RESULTS+=("${RED}❌ FAIL${NC}: CLI E2E tests failed")
    ((FAIL++))
  fi
else
  skip "CLI E2E tests" "scripts/e2e-cli.sh not found or not executable"
fi

echo ""

# ═══════════════════════════════════════════════════════════════════
# Report
# ═══════════════════════════════════════════════════════════════════
echo ""
echo -e "${BOLD}════════════════════════════════════════${NC}"
echo -e "${BOLD}Results${NC}"
echo -e "${BOLD}════════════════════════════════════════${NC}"
echo ""

for result in "${RESULTS[@]}"; do
  echo -e "  $result"
done

TOTAL=$((PASS + FAIL + SKIP))
echo ""
echo -e "${BOLD}SUMMARY: ${PASS}/${TOTAL} passed, ${FAIL} failed, ${SKIP} skipped, ${INFO} informational${NC}"
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo -e "${RED}Some checks failed.${NC}"
  exit 1
else
  echo -e "${GREEN}All checks passed.${NC}"
  exit 0
fi
