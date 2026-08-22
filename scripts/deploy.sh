#!/usr/bin/env bash
# Kinu deploy pipeline — THE deploy path for BOTH environments.
#   bun run deploy           → production, https://kinu.run
#   bun run deploy:staging   → staging, https://staging.kinu.run
#
# Deploying any other way is how production once shipped without the CLI
# download assets: the site was fine, but /downloads/* answered with the SPA
# shell and every fresh install died on a checksum mismatch. Nothing here is
# optional. The gate below is what makes the difference between "the Worker
# uploaded" and "the product works".
#
# Deploys the cf-backend Worker (name "kinu") with the @cloudflare/sandbox
# Sandbox DO + Container binding, the NimbusSession DO, and the local-device
# executor routes. Pipeline: strict repository gates → vite build → CLI source
# archive → wrangler deploy → smoke test.
#
# Where the static assets come from (settled by reading wrangler 4.97 source +
# `wrangler deploy --dry-run`, 2026-08-07):
#   - The vite plugin writes packages/cf-backend/.wrangler/deploy/config.json,
#     and `wrangler deploy` DOES follow it (the command declares
#     useConfigRedirectIfAvailable) — it deploys dist/kinu/wrangler.json.
#   - That generated config's assets.directory is "../client", and the user
#     config's is "dist/client". Both resolve to the SAME directory:
#     packages/cf-backend/dist/client. There is one assets dir, not two.
#   - dist/kinu/assets/ is NOT an assets dir. It is the worker bundle's
#     code-split chunk output, which wrangler attaches as worker modules.
#     Writing downloads there publishes nothing.
# Step 3 asserts this from wrangler's own output rather than trusting it.
#
# ONE SCRIPT FOR BOTH ENVIRONMENTS, and that is the whole reason staging is
# trustworthy. Staging existed and served for days with nothing deploying it:
# every push went to production and staging drifted. A second script would have
# been a second place for the asset check and the smoke gate to be absent from,
# and their absence is what shipped production assetless once. Here the two
# environments differ in four values — the route, the wrangler `--env` flag, the
# infrastructure scope and the label — and share every gate, the build, the asset
# assertion and all six smoke checks by construction.
#
# Usage:
#   bun run deploy                           # production
#   bun run deploy:staging                   # staging
#   bash scripts/deploy.sh <production|staging>
#   CLOUDFLARE_ACCOUNT_ID=... scripts/deploy.sh staging
#
# Idempotent: safe to re-run. Exits on first failure.
set -uo pipefail

GREEN='\033[0;32m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

# ── Locate Kinu root ──────────────────────────────────────────
KINU_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$KINU_ROOT" || { echo -e "${RED}Cannot cd to Kinu root${NC}"; exit 1; }

export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-f44999d1ddda7012e9a87729eba250f1}"

# ── Which environment ─────────────────────────────────────────
#
# The four values that differ. Everything else in this file is shared.
KINU_ENV="${1:-production}"
case "$KINU_ENV" in
  production)
    KINU_URL="https://kinu.run/"
    KINU_WRANGLER_ARGS=()
    ;;
  staging)
    KINU_URL="https://staging.kinu.run/"
    KINU_WRANGLER_ARGS=(--env staging)
    ;;
  *)
    echo -e "${RED}Unknown environment '$KINU_ENV'.${NC}"
    echo "Usage: scripts/deploy.sh <production|staging>"
    exit 2
    ;;
esac
# Read by scripts/infra-verify.ts when no environment is given on its argv, so
# the `bun run gate:infra` line below stays one string for scripts/ladder.ts to
# parse while still checking the environment being deployed.
export KINU_DEPLOY_ENV="$KINU_ENV"

# Captured during deploy for final summary
KINU_VERSION=""
# The one directory wrangler publishes as static assets (see header).
KINU_ASSETS_DIR="$KINU_ROOT/packages/cf-backend/dist/client"
# build-cli-source-archive.sh stamps this sha into the archive, the published
# version.json, and therefore /api/health's build stamp.
KINU_SHA="$(git -C "$KINU_ROOT" rev-parse --short HEAD 2>/dev/null || echo dev)"

# Temp log file — trap cleans up on any exit.
KINU_DEPLOY_LOG=""
cleanup() {
  [ -n "$KINU_DEPLOY_LOG" ] && rm -f "$KINU_DEPLOY_LOG"
}
trap cleanup EXIT INT TERM

# Read one dotted JSON field from stdin. Prints nothing when the body is not
# JSON — which is exactly what a smoke test needs, because "not JSON" is how a
# missing asset used to present itself (the SPA shell under a JSON
# content-type).
json_field() {
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=process.argv[1].split(".").reduce((o,k)=>o?.[k],JSON.parse(s));process.stdout.write(v==null?"":String(v))}catch{}})' "$1"
}

# ── The gate queue ───────────────────────────────────────────────
#
# `run_required_gate` ENQUEUES; `flush_gates` runs the queue concurrently and
# waits. The gates used to run one after another for no reason: 400s of
# declared cost on a 24-thread box that sat idle for all of it.
#
# Two gates may not share the machine, and `SERIAL_GATES` in scripts/ladder.ts
# names them with the reason. They get their own flush, which is what a barrier
# looks like here: preflight alone before everything, gate:infra alone after
# everything. deploy.test.ts asserts the barriers match that declaration, so a
# third gate cannot be quietly made concurrent.
#
# The enqueue lines stay one per gate, spelled `run_required_gate "label" cmd`,
# because scripts/ladder.ts PARSES them: they are the authoritative list of what
# a deploy runs, and collapsing them into a loop would leave the ladder reading
# an empty tier.
#
# Cross-wave barriers own every remaining exclusion. The empty table stays
# explicit because deploy.test.ts holds it equal to EXCLUSION_GROUPS; a future
# same-wave exclusion has to update both declarations.
declare -A GATE_GROUP=()
GATE_LABELS=()
GATE_CMDS=()

run_required_gate() {
  GATE_LABELS+=("$1")
  shift
  GATE_CMDS+=("$*")
}

# How many at once. Derived from the machine rather than declared, because it is
# a property of the box and not a policy. Halved against the thread count: the
# heavy members are test suites that already use more than one thread each, and
# at full width they contend instead of overlapping (measured 2026-08-21 —
# nproc=24: 12 jobs 96s, 24 jobs 103s).
gate_jobs() {
  local threads
  threads="$(nproc 2>/dev/null || echo 4)"
  echo "${KINU_DEPLOY_JOBS:-$(( threads / 2 > 0 ? threads / 2 : 1 ))}"
}

# A gate that cannot exit is a failure, not an infinite deploy. The slowest
# measured source gate is ~60s under the full 12-job wave (2026-08-22); 180s
# preserves that work while bounding leaked worker processes.
GATE_DEADLINE_SECONDS=180

# Run everything enqueued, then clear the queue. Each gate's output goes to its
# own file and is printed ONLY if it fails: 52 concurrent streams interleaved
# into one terminal is not a log anybody can read, and the output a reader wants
# is the failing gate's.
#
# On the first failure it stops LAUNCHING and lets the running gates finish. That
# is deliberate rather than tidy — a wave usually holds more than one real
# failure, and reporting "these three failed" beats reporting the first one and
# discarding two diagnostics that have already been paid for.
flush_gates() {
  local total=${#GATE_LABELS[@]}
  if [ "$total" -eq 0 ]; then return 0; fi

  local jobs; jobs="$(gate_jobs)"
  local dir; dir="$(mktemp -d "${TMPDIR:-/tmp}/kinu-gates.XXXXXX")"
  local settled=0 failures=0 index status
  local -a reported=()

  echo "Running $total gate(s), up to $jobs at once"
  for ((index = 0; index < total; index++)); do
    reported[index]=0
    # `$cmd` is split on whitespace on purpose: every gate is a plain argv of
    # words, which is the same assumption scripts/ladder.ts's parse makes and
    # deploy.test.ts pins by exact string. A quoted argument would mis-split
    # silently, so refuse it here instead.
    case "${GATE_CMDS[index]}" in
      *\"*|*\'*)
        echo -e "${RED}❌ gate ${index}: '${GATE_CMDS[index]}' carries a quote.${NC}"
        echo "   Gate commands must be plain words. scripts/ladder.ts parses these lines"
        echo "   and this runner splits them; a quoted argument would not survive either."
        rm -rf "$dir"
        exit 1
        ;;
    esac
  done

  local -a launched=()
  local -A busy=()
  local pick group
  for ((index = 0; index < total; index++)); do launched[index]=0; done

  while [ "$settled" -lt "$total" ]; do
    # Take the FIRST gate that is neither launched nor blocked by a peer in its
    # own group. A plain queue pointer would stall the whole wave behind a
    # gallery gate waiting for its turn.
    while [ "$failures" -eq 0 ] && [ "$(jobs -rp | wc -l)" -lt "$jobs" ]; do
      pick=-1
      for ((index = 0; index < total; index++)); do
        if [ "${launched[index]}" -eq 1 ]; then continue; fi
        group="${GATE_GROUP[${GATE_CMDS[index]}]:-}"
        if [ -n "$group" ] && [ -n "${busy[$group]:-}" ]; then continue; fi
        pick=$index
        break
      done
      if [ "$pick" -lt 0 ]; then break; fi
      group="${GATE_GROUP[${GATE_CMDS[pick]}]:-}"
      if [ -n "$group" ]; then busy[$group]=1; fi
      launched[pick]=1
      # `timeout` owns a process group and escalates after five seconds, so a
      # worker that keeps an open handle cannot outlive its gate or the deploy.
      # shellcheck disable=SC2086
      ( timeout --signal=TERM --kill-after=5s "$GATE_DEADLINE_SECONDS" ${GATE_CMDS[pick]} > "$dir/$pick.log" 2>&1; echo $? > "$dir/$pick.status" ) &
    done

    # WAIT ONLY IF SOMETHING IS RUNNING, and never break before settling. An
    # earlier version broke here the moment `jobs -rp` was empty, and with stub
    # gates that finish instantly the whole wave could be launched, finish, and be
    # abandoned unreported — so a failing gate left `failures` at 0 and the build
    # ran. Nothing is running also means no group is busy, which is exactly when a
    # gate held back by its group becomes launchable, so an empty job table is a
    # reason to loop rather than to stop.
    if [ "$(jobs -rp | wc -l)" -gt 0 ]; then wait -n 2>/dev/null || true; fi

    for ((index = 0; index < total; index++)); do
      if [ "${launched[index]}" -eq 0 ] || [ "${reported[index]}" -eq 1 ]; then continue; fi
      if [ ! -f "$dir/$index.status" ]; then continue; fi
      reported[index]=1
      settled=$((settled + 1))
      group="${GATE_GROUP[${GATE_CMDS[index]}]:-}"
      if [ -n "$group" ]; then unset "busy[$group]"; fi
      status="$(cat "$dir/$index.status")"
      if [ "$status" = "0" ]; then
        echo -e "${GREEN}✅ ${GATE_LABELS[index]}${NC}"
      else
        failures=$((failures + 1))
        echo -e "${RED}❌ ${GATE_LABELS[index]} failed (exit $status)${NC}"
      fi
    done

    # The one reason to stop early: a gate failed, so nothing more is launched,
    # and the gates already running have now all been reported.
    if [ "$failures" -ne 0 ] && [ "$(jobs -rp | wc -l)" -eq 0 ]; then break; fi
  done

  if [ "$failures" -ne 0 ]; then
    for ((index = 0; index < total; index++)); do
      if [ ! -f "$dir/$index.status" ] || [ "$(cat "$dir/$index.status")" = "0" ]; then continue; fi
      echo ""
      echo -e "${BOLD}── ${GATE_LABELS[index]} ──${NC}"
      echo "Reproduce: ${GATE_CMDS[index]}"
      cat "$dir/$index.log"
    done
    echo ""
    echo -e "${RED}❌ $failures gate(s) failed. The build and publish steps did not start.${NC}"
    rm -rf "$dir"
    exit 1
  fi

  rm -rf "$dir"
  GATE_LABELS=()
  GATE_CMDS=()
}

echo -e "${BOLD}Kinu Deploy Pipeline${NC}"
echo "========================"
echo "Environment:  $KINU_ENV"
echo "Target:       $KINU_URL"
echo "Kinu root: $KINU_ROOT"
echo "Account:      $CLOUDFLARE_ACCOUNT_ID"
echo "Build sha:    $KINU_SHA"
if [ -n "$(git -C "$KINU_ROOT" status --porcelain 2>/dev/null)" ]; then
  echo -e "${RED}Worktree is dirty — build $KINU_SHA would not describe the bytes being published.${NC}"
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
# BARRIER. Preflight runs alone, and this is why the queue exists: nothing may
# report on this machine until the preflight has said the machine is fit to be
# reported on. See SERIAL_GATES in scripts/ladder.ts.
flush_gates

# ── Pre-flight: verify npx + wrangler auth ───────────────────────
if ! command -v npx >/dev/null 2>&1; then
  echo -e "${RED}npx not found — install Node.js${NC}"
  exit 1
fi
if ! npx wrangler whoami >/dev/null 2>&1; then
  echo -e "${RED}Wrangler is not authenticated. Nothing was deployed.${NC}"
  echo "  On your own machine:  npx wrangler login"
  echo "  In CI: set the CLOUDFLARE_API_TOKEN secret. Cloudflare dashboard →"
  echo "  My Profile → API Tokens → Create Token → Edit Cloudflare Workers,"
  echo "  then add Workers R2 Storage: Edit, Workers KV Storage: Edit and"
  echo "  Vectorize: Edit, scoped to account $CLOUDFLARE_ACCOUNT_ID."
  echo "  Only a person with dashboard access can mint it; this script will not"
  echo "  deploy part of the way without it."
  exit 1
fi

# The strict gates need the locked dependency graph, but dependency setup is
# not a build or publish operation. Do it before verification when a checkout
# has not been prepared yet; never let deploy update the lockfile.
if [ ! -d "$KINU_ROOT/node_modules" ]; then
  echo "Installing Kinu dependencies (root node_modules missing)..."
  bun install --frozen-lockfile \
    || { echo -e "${RED}bun install failed in Kinu${NC}"; exit 1; }
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
run_required_gate "Exploration policy mutations" bun run test:mutation
run_required_gate "Test-utils suite" bun test packages/test-utils/
run_required_gate "Cloudflare backend and conformance suite" bun test --parallel=4 packages/cf-backend/
run_required_gate "Durable Object semantics under workerd" bun run test:workerd
run_required_gate "CLI backend and conformance suite" bun test --parallel=4 packages/cli-backend/
run_required_gate "Full production CLI suite" bun test --parallel=4 packages/cli/
run_required_gate "Evaluation gate logic" bun test scripts/eval.test.ts scripts/eval-triage.test.ts
run_required_gate "Benchmark harness guarantees" bun test scripts/bench*.test.ts packages/core/tests/unit-bench*.test.ts
run_required_gate "Secret scanner self-test" bun test scripts/secret-scan.test.ts scripts/sources.test.ts
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
run_required_gate "Gate self-tests" bun test scripts/gates.test.ts scripts/reachability.test.ts scripts/do-init-gate.test.ts scripts/platform-catalog.test.ts scripts/policy-drift.test.ts scripts/scratch-ownership.test.ts scripts/literature-citations.test.ts scripts/commit-hygiene.test.ts scripts/lean-citations.test.ts scripts/doc-claims.test.ts scripts/infra.test.ts scripts/patch-parity.test.ts scripts/silent-drop.test.ts
run_required_gate "Skip ratchet and typecheck coverage self-tests" bun test scripts/skip-ratchet.test.ts scripts/typecheck-coverage.test.ts
run_required_gate "Set-equality gate self-tests" bun test scripts/gate-set-equality.test.ts
run_required_gate "Wired gate self-tests" bun test scripts/wired.test.ts
run_required_gate "UI gate self-tests" bun test scripts/chat-and-files-ux.test.ts scripts/computed-style.test.ts
run_required_gate "Public pages render" bun test scripts/public-pages.test.ts
run_required_gate "Swarm-tree geometry" bun test scripts/swarm-tree-geometry.test.ts
run_required_gate "Chat infinite scroll" bun test scripts/chat-scroll.test.ts
run_required_gate "Gate ladder wiring" bun test scripts/ladder.test.ts
run_required_gate "Dead code" bun run gate:dead-code
run_required_gate "Built but unwired" bun run gate:wired
run_required_gate "Duplicate implementations" bun run gate:duplication
run_required_gate "Cross-backend capability parity" bun run gate:capability-parity
run_required_gate "Duplicated policy constants" bun run gate:policy-drift
run_required_gate "Silently dropped failures" bun run gate:silent-drop
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
run_required_gate "Doc claims against the code" bun run gate:doc-claims
run_required_gate "Commit message hygiene" bun run gate:commit-message
run_required_gate "Dependency install-script policy" bun run gate:install-scripts
run_required_gate "Dependency advisory policy" bun run gate:dependency-advisories
run_required_gate "Committed patches reproduce node_modules" bun run gate:patch-parity
run_required_gate "Seeded bench defects still apply" bun run gate:bench-corpus
run_required_gate "Local-device daemon suite" bun test packages/pc-agent/
run_required_gate "Root end-to-end lifecycle suites" bun test ./tests/
run_required_gate "Layergate conformance" bun run layergate
run_required_gate "Layergate fault-localization matrix" bun run layergate --matrix
run_required_gate "Lean proofs, consistency, and traceability" bun run verify:lean

# BARRIER. Everything above this line is independent and ran concurrently.
flush_gates


# Alone, and last. Everything above proves the SOURCE is deployable; this proves
# the ACCOUNT is. Scoped to the environment being deployed (KINU_DEPLOY_ENV), so a
# staging deploy is not refused for a production defect and a production deploy is
# not refused for staging drift. `npx wrangler whoami` above is its precondition —
# without a session it reports BLOCKED and non-zero rather than skipping. See
# SERIAL_GATES in scripts/ladder.ts.
run_required_gate "Declared infrastructure exists and is bound" bun run gate:infra

# BARRIER.
flush_gates

echo ""
echo -e "${GREEN}All required pre-deploy gates passed.${NC}"

# ── Step 2: Build Kinu ────────────────────────────────────────
echo ""
echo -e "${BOLD}Step 2: Building Kinu${NC}"
cd "$KINU_ROOT/packages/cf-backend" || { echo -e "${RED}cannot cd to cf-backend${NC}"; exit 1; }

# Build the client bundle into dist/client (used by wrangler's assets directive).
if [ -f ./node_modules/.bin/vite ]; then
  echo "Running: vite build"
  ./node_modules/.bin/vite build || { echo -e "${RED}vite build failed${NC}"; exit 1; }
else
  echo "Running: bunx vite build"
  bunx vite build || { echo -e "${RED}vite build failed${NC}"; exit 1; }
fi

echo "Building CLI source archive"
bash "$KINU_ROOT/scripts/build-cli-source-archive.sh" || { echo -e "${RED}CLI source archive build failed${NC}"; exit 1; }

# Neither environment may ship without the three CLI download assets sitting in
# the directory wrangler publishes. A deploy missing them bricks every fresh
# install and update.
for asset in kinu-source.tar.gz kinu-source.tar.gz.sha256 kinu-version.json; do
  if [ ! -s "$KINU_ASSETS_DIR/downloads/$asset" ]; then
    echo -e "${RED}❌ Missing build output: $KINU_ASSETS_DIR/downloads/$asset${NC}"
    exit 1
  fi
done
echo -e "${GREEN}✅ CLI download assets staged in $KINU_ASSETS_DIR/downloads${NC}"

# ── Step 3: Deploy Kinu ───────────────────────────────────────
echo ""
echo -e "${BOLD}Step 3: Deploying Kinu${NC}"
KINU_DEPLOY_LOG="$(mktemp -t kinu-deploy.XXXXXX.log)"
echo ""
echo "Running: npx wrangler deploy ${KINU_WRANGLER_ARGS[*]} (log → $KINU_DEPLOY_LOG)"
echo ""
if npx wrangler deploy "${KINU_WRANGLER_ARGS[@]}" 2>&1 | tee "$KINU_DEPLOY_LOG"; then
  echo ""
  echo -e "${GREEN}Kinu deploy succeeded.${NC}"
else
  echo ""
  echo -e "${RED}Kinu deploy failed — see log above.${NC}"
  exit 1
fi

KINU_VERSION="$(grep -oE 'Version ID:[[:space:]]*[a-f0-9-]+' "$KINU_DEPLOY_LOG" | head -1 | awk '{print $NF}')"

# Verify wrangler echoed the Sandbox binding (proves @cloudflare/sandbox is wired).
# Binding name is "Sandbox" (capital S) — the SDK hardcodes env.Sandbox lookup.
if grep -qE 'KinuSandbox' "$KINU_DEPLOY_LOG"; then
  echo -e "${GREEN}✅ Kinu bound Sandbox (KinuSandbox DO + Container)${NC}"
else
  echo -e "${RED}❌ wrangler output did not mention the Sandbox binding${NC}"
  echo "   Check that packages/cf-backend/wrangler.jsonc includes:"
  echo "     { \"class_name\": \"KinuSandbox\", \"name\": \"Sandbox\" }"
  echo "   and a \"containers\" block."
  exit 1
fi

# Wrangler names the assets directory it actually read. Assert it is the one we
# staged the downloads into, so a future config or plugin change that moves the
# assets dir fails here instead of silently shipping an assetless site.
DEPLOYED_ASSETS_DIR="$(grep -oE 'Read [0-9]+ files from the assets directory .*' "$KINU_DEPLOY_LOG" | head -1 | sed 's|.*assets directory ||' | tr -d '\r')"
if [ "$DEPLOYED_ASSETS_DIR" = "$KINU_ASSETS_DIR" ]; then
  echo -e "${GREEN}✅ Wrangler published assets from $KINU_ASSETS_DIR${NC}"
else
  echo -e "${RED}❌ Wrangler published assets from '${DEPLOYED_ASSETS_DIR:-<not reported>}'${NC}"
  echo "   Expected: $KINU_ASSETS_DIR (the directory the CLI downloads were staged into)."
  echo "   Reconcile packages/cf-backend/wrangler.jsonc, the vite plugin's"
  echo "   .wrangler/deploy/config.json redirect, and this script's header."
  exit 1
fi

cd "$KINU_ROOT" || exit 1

# ── Step 4: Post-deploy smoke test ───────────────────────────────
echo ""
echo -e "${BOLD}Step 4: Post-deploy smoke test${NC}"
echo "Waiting 10s for deployments to propagate..."
sleep 10

SMOKE_FAIL=0

# The environment's own route.
LIVE_STATUS=$(curl -so /dev/null -w '%{http_code}' --max-time 15 "$KINU_URL" 2>/dev/null || echo "000")
if [ "$LIVE_STATUS" = "200" ]; then
  echo -e "${GREEN}✅ Kinu live site returns 200${NC} ($KINU_URL)"
else
  echo -e "${RED}❌ Kinu live site returns $LIVE_STATUS${NC} ($KINU_URL)"
  SMOKE_FAIL=1
fi


# One GET that answers "did my deploy land?". /api/health reads its build stamp
# out of the deployed asset bundle, so a mismatch here also means the CLI
# download assets are stale or missing. Edge rollout takes up to ~2 minutes,
# so the stamp check retries with backoff before calling the deploy bad —
# a stamp that NEVER converges is the real failure this guards.
HEALTH_SHA=""
for _try in 1 2 3 4 5 6 7 8; do
  HEALTH_JSON=$(curl -s --max-time 15 "${KINU_URL}api/health?smoke=$_try" 2>/dev/null)
  HEALTH_SHA=$(printf '%s' "$HEALTH_JSON" | json_field build.sha)
  [ "$HEALTH_SHA" = "$KINU_SHA" ] && break
  sleep 15
done
if [ "$HEALTH_SHA" = "$KINU_SHA" ]; then
  echo -e "${GREEN}✅ /api/health reports the deployed build ($KINU_SHA)${NC}"
else
  echo -e "${RED}❌ /api/health build stamp is '${HEALTH_SHA:-<none>}', expected '$KINU_SHA'${NC}"
  echo "   Body: ${HEALTH_JSON:0:200}"
  SMOKE_FAIL=1
fi

# The §0 regression: this asset once came back as the SPA shell wearing an
# application/json content-type, so `kinu update` could never see a version.
VERSION_SHA=""
for _try in 1 2 3 4 5 6 7 8; do
  VERSION_SHA=$(curl -fsSL --max-time 15 "${KINU_URL}downloads/kinu-version.json?smoke=$_try" 2>/dev/null | json_field sha)
  [ "$VERSION_SHA" = "$KINU_SHA" ] && break
  sleep 15
done
if [ "$VERSION_SHA" = "$KINU_SHA" ]; then
  echo -e "${GREEN}✅ Published kinu-version.json is real JSON for this build${NC}"
else
  echo -e "${RED}❌ Published kinu-version.json sha is '${VERSION_SHA:-<unparseable>}', expected '$KINU_SHA'${NC}"
  SMOKE_FAIL=1
fi

CLI_SHIM=$(curl -s --max-time 15 "${KINU_URL}downloads/kinu" 2>/dev/null)
if echo "$CLI_SHIM" | grep -q 'downloads/kinu-source.tar.gz' && ! echo "$CLI_SHIM" | grep -q 'github.com'; then
  echo -e "${GREEN}✅ Kinu CLI shim uses deployed source archive${NC}"
else
  echo -e "${RED}❌ Kinu CLI shim is not using the deployed source archive${NC}"
  SMOKE_FAIL=1
fi

CLI_ARCHIVE_TMP="$(mktemp -t kinu-cli-source.XXXXXX.tar.gz)"
CLI_ARCHIVE_LIST="$(mktemp -t kinu-cli-source.XXXXXX.list)"
CLI_ARCHIVE_OK=0
for attempt in 1 2 3 4 5 6; do
  if curl -fsSL --max-time 30 "${KINU_URL}downloads/kinu-source.tar.gz" -o "$CLI_ARCHIVE_TMP" \
    && tar -tzf "$CLI_ARCHIVE_TMP" > "$CLI_ARCHIVE_LIST" \
    && grep -Fq 'kinu/packages/cli/src/commands/setup.ts' "$CLI_ARCHIVE_LIST"; then
    CLI_ARCHIVE_OK=1
    break
  fi
  [ "$attempt" = "6" ] || sleep 5
done
if [ "$CLI_ARCHIVE_OK" = "1" ]; then
  echo -e "${GREEN}✅ Kinu CLI source archive is downloadable${NC}"
  # The CLI shim verifies this checksum by default — a stale/missing .sha256
  # bricks installs and updates, so the deploy gate checks it too.
  PUBLISHED_SHA="$(curl -fsSL --max-time 15 "${KINU_URL}downloads/kinu-source.tar.gz.sha256" 2>/dev/null | awk '{print $1}')"
  ACTUAL_SHA="$(sha256sum "$CLI_ARCHIVE_TMP" | awk '{print $1}')"
  if [ -n "$PUBLISHED_SHA" ] && [ "$PUBLISHED_SHA" = "$ACTUAL_SHA" ]; then
    echo -e "${GREEN}✅ Kinu CLI source checksum matches the published .sha256${NC}"
  else
    echo -e "${RED}❌ Published source checksum is missing or does not match the archive${NC}"
    SMOKE_FAIL=1
  fi
else
  echo -e "${RED}❌ Kinu CLI source archive is missing or invalid${NC}"
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
echo -e "${BOLD}Deploy complete — $KINU_ENV.${NC}"
echo "================================="
echo "Kinu:  $KINU_URL"
echo "          version ${KINU_VERSION:-unknown}"
echo "          build   $KINU_SHA"
echo ""
echo -e "${GREEN}✅ Kinu Worker deployed and verified.${NC}"
