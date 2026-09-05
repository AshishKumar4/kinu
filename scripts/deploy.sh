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
# Sandbox DO + Container binding and the local-device executor routes.
# Pipeline: strict repository gates → vite build → CLI source archive →
# wrangler deploy → smoke test.
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
#   bash scripts/deploy.sh <production|staging> [--bootstrap]
#   CLOUDFLARE_ACCOUNT_ID=... scripts/deploy.sh staging
#
# `--bootstrap` is for the deploy that DECLARES something only a deploy can
# create — a Durable Object class new to `migrations`, a new container, a new
# route. It moves the pre-deploy infrastructure phase to `bootstrap`, which
# defers exactly those and nothing else. It skips no verification: every
# external prerequisite still refuses the deploy before the upload, and step 5
# below re-checks everything with no tolerance whatever, in both environments,
# whether this flag was passed or not.
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
# The values that differ. Everything else in this file is shared. Both
# environments serve the SAME unified shell — the landing carries the app
# behind auth — so the smoke marker is one value, not a split.
KINU_ENV="${1:-production}"
KINU_APP_ROOT="landing-root"
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
    echo "Usage: scripts/deploy.sh <production|staging> [--bootstrap]"
    exit 2
    ;;
esac

# ── Bootstrap, or not ─────────────────────────────────────────
#
# EXPLICIT, and only ever about the PRE-DEPLOY phase.
#
# A deploy that declares a resource only a deploy can create cannot pass a
# pre-deploy check demanding that resource already exist, and no provisioning
# command can close the gap: wrangler has no verb that creates a Durable Object
# namespace, a container application or a route. Measured: `ControlPlaneDO` was
# added to `migrations`, staging's pre-deploy gates (55 at the time) passed, and `gate:infra`
# then refused the only deploy that could have created the namespace — naming
# `bun run infra:provision` as the fix, which cannot.
#
# WHAT THIS FLAG DOES NOT DO. It skips no verification and it cannot. It moves
# the pre-deploy phase to `bootstrap`, which defers ONLY resources the
# infrastructure manifest marks `wrangler-deploy`; every external prerequisite —
# secrets, KV, R2, Vectorize, DNS, the AI Gateway — still refuses the deploy
# before the upload, and so does any lookup that merely failed. Step 5 below
# runs the full phase with no tolerance at all, unconditionally, in both
# environments, and its findings fail the deployment.
KINU_BOOTSTRAP=0
case "${2:-}" in
  "") ;;
  --bootstrap) KINU_BOOTSTRAP=1 ;;
  *)
    echo -e "${RED}Unknown option '$2'.${NC}"
    echo "Usage: scripts/deploy.sh <production|staging> [--bootstrap]"
    exit 2
    ;;
esac
# Read by scripts/infra-verify.ts when no environment is given on its argv, so
# the `bun run gate:infra` line below stays one string for scripts/ladder.ts to
# parse while still checking the environment being deployed.
export KINU_DEPLOY_ENV="$KINU_ENV"
# The pre-deploy phase, travelling beside that same line for that same reason.
# ALWAYS ASSIGNED, in both arms: an ambient KINU_INFRA_PHASE from whatever shell
# launched this must never decide how strictly a deploy nobody asked to
# bootstrap is checked. There is no third value, and no value of it reaches the
# upload without step 5 behind it.
if [ "$KINU_BOOTSTRAP" = "1" ]; then
  export KINU_INFRA_PHASE="bootstrap"
else
  export KINU_INFRA_PHASE="full"
fi
# The Cloudflare Vite plugin resolves named Wrangler environments at build
# time. Passing `--env` only to the generated deploy config is too late: that
# config already carries the root Worker's name, bindings, routes and assets.
if [ "$KINU_ENV" = "staging" ]; then
  export CLOUDFLARE_ENV="staging"
else
  unset CLOUDFLARE_ENV
fi

# Captured during deploy for final summary
KINU_VERSION=""
# The one directory wrangler publishes as static assets (see header).
KINU_ASSETS_DIR="$KINU_ROOT/packages/cf-backend/dist/client"
# build-cli-dist.sh stamps this sha into the built CLI, the published
# version.json, and therefore /api/health's build stamp.
KINU_SHA="$(git -C "$KINU_ROOT" rev-parse --short HEAD 2>/dev/null || echo dev)"

# The deployed Worker VERSION carries that sha, as the version annotations
# wrangler sends with the upload (`workers/tag` and `workers/message`; it turns
# these two flags into them for this deploy path — wrangler-dist/cli.js:150445).
# Workers Logs tags every invocation with a version id and nothing else, so
# without this the only route from a persisted stack trace to the bytes that
# produced it is somebody's terminal scrollback. Afterwards the pair is readable
# from `npx wrangler versions list`, and /api/health reports the same sha back out
# of the asset bundle — which is the other half of the same join.
KINU_WRANGLER_ARGS+=(--tag "$KINU_SHA" --message "kinu $KINU_ENV $KINU_SHA")

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

# `wait -n -p`, which the gate runner takes every verdict from, is bash 5.1
# (December 2020). Refused here rather than at the first flush: an unsupported
# shell is a fact about the machine, not a gate result. The associative arrays
# below already ruled out bash 3.
if ((BASH_VERSINFO[0] < 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] < 1))); then
  echo -e "${RED}bash $BASH_VERSION cannot run the gate wave: 'wait -n -p' needs bash 5.1 or newer.${NC}"
  exit 1
fi

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

# Each heavy gate runs Bun with up to four workers. One outer process per four
# hardware threads keeps the aggregate at the machine's thread count. The old
# half-thread rule launched 12 outer gates and up to 48 inner workers here.
# Measured 2026-08-23: that wave turned a 23.67s CLI file into a 173.54s run
# and produced nine false timeout failures. Six outer gates keep all 24 threads
# available without oversubscribing them.
gate_jobs() {
  local threads
  threads="$(nproc 2>/dev/null || echo 4)"
  echo "${KINU_DEPLOY_JOBS:-$(( threads / 4 > 0 ? threads / 4 : 1 ))}"
}

# A gate that cannot exit is a failure, not an infinite deploy. The slowest
# source gate is the five-suite UI batch, so the shared wall stays calibrated
# for source work rather than being raised for a live account probe.
GATE_DEADLINE_SECONDS=480

# The launcher reads this table under `set -u`, so it exists even when no gate
# has earned a different wall. A future deployed probe may add one only with its
# matching declaration in `scripts/ladder.ts` and the deploy-contract proof.
# Six deployed episodes use a real model, daemons and browser. Their configured
# deadline remains 1800s. The six-case deployed wall is unmeasured.
# deploy.test.ts holds this value equal to GATE_DEADLINES in scripts/ladder.ts.
declare -A GATE_DEADLINES=(
  ['bun run gate:first-run']=1800
)

# Run everything enqueued, then clear the queue. Each gate's output goes to its
# own file and is printed ONLY if it fails: a wave's concurrent streams interleaved
# into one terminal is not a log anybody can read, and the output a reader wants
# is the failing gate's.
#
# WHERE A GATE'S VERDICT COMES FROM: `wait -n -p`, which hands back the pid that
# terminated and its exit status together. That is the whole reaping story, and
# it is deliberately not a status file. The earlier version published each gate's
# status into `$dir/$i.status` and counted `jobs -rp | wc -l` between waits, so a
# gate whose process died before it could write one — an OOM kill, a `kill -9`
# from outside the gate's own tree — was detected only by probing `kill -0` on a
# pid the shell had already reaped. A recycled pid answers that probe as somebody
# else's process, and the loop then has nothing left to wait on: it spins at 100%
# CPU and the deploy never ends. The kernel already knows every child's fate, so
# asking it removes the status files, the atomic-rename dance, the liveness probe
# and the poll in one move.
#
# A gate killed by a signal therefore settles as 128+signal, a gate past the
# deadline as `timeout`'s 124, and a gate whose command does not exist as 127.
# None of those can be read as a pass, and none depends on the gate cooperating.
#
# On the first failure it stops LAUNCHING and lets the running gates finish. That
# is deliberate rather than tidy — a wave usually holds more than one real
# failure, and reporting "these three failed" beats reporting the first one and
# discarding two diagnostics that have already been paid for.
flush_gates() {
  local total=${#GATE_LABELS[@]}
  if [ "$total" -eq 0 ]; then return 0; fi

  local jobs; jobs="$(gate_jobs)"
  # Every gate writes its output here and every failure is reported out of it, so
  # a directory that could not be created is a wave that cannot be reported on.
  # Refused rather than worked around: with `$dir` empty the redirections below
  # would write to `/0.log`, and a box out of space or inodes would present as a
  # clean pass.
  local dir=""
  dir="$(mktemp -d "${TMPDIR:-/tmp}/kinu-gates.XXXXXX" 2>/dev/null)" || dir=""
  if [ -z "$dir" ] || [ ! -d "$dir" ]; then
    echo -e "${RED}❌ cannot create a gate log directory under ${TMPDIR:-/tmp}.${NC}"
    echo "   Nothing can be reported without it, so nothing is built or published."
    echo "   Free space or inodes, or set TMPDIR."
    exit 1
  fi

  local index
  for ((index = 0; index < total; index++)); do
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

  local -a launched=() statuses=()
  local -A busy=() gate_of_pid=()
  local pick group finished status
  local running=0 settled=0 failures=0
  for ((index = 0; index < total; index++)); do launched[index]=0; statuses[index]=-1; done

  echo "Running $total gate(s), up to $jobs at once"
  while [ "$settled" -lt "$total" ]; do
    # Take the FIRST gate that is neither launched nor blocked by a peer in its
    # own group. A plain queue pointer would stall the whole wave behind a
    # gallery gate waiting for its turn.
    while [ "$failures" -eq 0 ] && [ "$running" -lt "$jobs" ]; do
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
      # `timeout` signals the gate's process group and escalates after five
      # seconds. That kills the gate command tree, and no more: a child that
      # calls setsid (a detached dev server, a daemonized browser helper)
      # leaves the group and can outlive the kill — headless browsers and
      # workerd accumulated exactly that way across repeated walls until this
      # box ran out of memory on 2026-08-25. The box carries swap now; if
      # orphan accumulation returns, the fix is cgroup scopes at the suite
      # layer, not a longer deadline.
      #
      # `exec` so the tracked pid IS `timeout`: one process fewer per gate, and
      # the status `wait` reports below is the gate's own, not a wrapper's.
      (
        # shellcheck disable=SC2086
        exec timeout --signal=TERM --kill-after=5s "${GATE_DEADLINES[${GATE_CMDS[pick]}]:-$GATE_DEADLINE_SECONDS}" ${GATE_CMDS[pick]} > "$dir/$pick.log" 2>&1
      ) &
      gate_of_pid[$!]=$pick
      running=$((running + 1))
    done

    if [ "$running" -eq 0 ]; then
      # Nothing running and nothing launchable. After a failure that is the
      # planned end of the wave. Without one, every unlaunched gate is held by a
      # group no running gate owns, which is a defect in the exclusion table
      # rather than a gate result — so it fails here instead of looping forever
      # over a queue that cannot move.
      if [ "$failures" -ne 0 ]; then break; fi
      echo -e "${RED}❌ $((total - settled)) gate(s) can never launch: the exclusion table holds them with nothing running.${NC}"
      rm -rf "$dir"
      exit 1
    fi

    finished=""
    wait -n -p finished; status=$?
    if [ -z "$finished" ] || [ -z "${gate_of_pid[$finished]:-}" ]; then
      # `wait` came back without naming a child of this wave, so the status
      # cannot be attributed to a gate. Stop rather than credit it to one.
      echo -e "${RED}❌ a gate wait returned no child of this wave (status $status).${NC}"
      rm -rf "$dir"
      exit 1
    fi
    index="${gate_of_pid[$finished]}"
    unset "gate_of_pid[$finished]"
    running=$((running - 1))
    settled=$((settled + 1))
    statuses[index]=$status
    group="${GATE_GROUP[${GATE_CMDS[index]}]:-}"
    if [ -n "$group" ]; then unset "busy[$group]"; fi
    if [ "$status" -eq 0 ]; then
      echo -e "${GREEN}✅ ${GATE_LABELS[index]}${NC}"
    else
      failures=$((failures + 1))
      echo -e "${RED}❌ ${GATE_LABELS[index]} failed (exit $status)${NC}"
    fi
  done

  if [ "$failures" -ne 0 ]; then
    for ((index = 0; index < total; index++)); do
      if [ "${statuses[index]}" -le 0 ]; then continue; fi
      echo ""
      echo -e "${BOLD}── ${GATE_LABELS[index]} ──${NC}"
      echo "Reproduce: ${GATE_CMDS[index]}"
      if [ -f "$dir/$index.log" ]; then
        cat "$dir/$index.log"
      else
        echo "(the gate left no log file: its output went with the process)"
      fi
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
if [ "$KINU_BOOTSTRAP" = "1" ]; then
  echo -e "${BOLD}BOOTSTRAP: the pre-deploy infrastructure phase will DEFER resources this deploy creates.${NC}"
  echo "  Deferred: only what the manifest marks \`wrangler-deploy\` — Durable Object namespaces,"
  echo "            container applications, routes, crons, inert bindings, the Worker itself."
  echo "  Still refused before the upload: every secret, KV namespace, R2 bucket, Vectorize index,"
  echo "            DNS record and AI Gateway, and any lookup that merely failed."
  echo "  Step 5 re-checks all of it after the upload with no tolerance, and fails this deploy if"
  echo "            anything deferred did not appear."
fi

# Keep the commands explicit and unconditional. These are the same strict,
# credential-free gates used by the repository workflows, plus the complete
# package test script and both Layergate proofs. No environment variable may
# skip one when this production deploy path is running.
run_required_gate "Strict lint and TypeScript" bun run check
run_required_gate "Production deploy contract" bun test scripts/deploy.test.ts
run_required_gate "Agent-utils, Core, and compaction suites" bun run test
run_required_gate "Bench Python suites" bun run gate:python-suites
run_required_gate "Exploration policy mutations" bun run test:mutation
run_required_gate "Concurrency fences stay load-bearing" bun run gate:mutation-fences
run_required_gate "Cross-backend seam differential" bun run gate:twin-differential
run_required_gate "Devbox durability decisions" bun test packages/devbox/
run_required_gate "Test-utils suite" bun test packages/test-utils/
run_required_gate "Cloudflare backend and conformance suite" bun test --parallel=4 packages/cf-backend/
run_required_gate "Durable Object semantics under workerd" bun run test:workerd
run_required_gate "CLI backend and conformance suite" bun test --parallel=4 packages/cli-backend/
run_required_gate "Full production CLI suite" bun run test:cli
run_required_gate "Evaluation gate logic" bun test scripts/eval.test.ts scripts/eval-triage.test.ts scripts/staging-preflight.test.ts
run_required_gate "Benchmark harness guarantees" bun test scripts/bench*.test.ts packages/core/tests/unit-bench*.test.ts scripts/sandbox-durability-probe.test.ts scripts/capture-probe.test.ts scripts/capture-probe-live.test.ts scripts/storage-matrix-admission.test.ts scripts/storage-matrix-cleanup.test.ts scripts/storage-matrix-manifest.test.ts scripts/storage-matrix-protocol.test.ts scripts/deploy-substrate.test.ts scripts/payload-transport.test.ts scripts/devbox-e2e.test.ts scripts/fixtures/r2-bench/security/cells.test.ts
run_required_gate "Gate self-tests: secrets, corpus, preflight" bun test scripts/secret-scan.test.ts scripts/sources.test.ts scripts/preflight.test.ts scripts/gallery-harness.test.ts scripts/workspace-name-ux.test.ts
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
run_required_gate "Hammer and fence gate self-tests" bun test scripts/hammer.test.ts scripts/mutation-fences.test.ts
run_required_gate "Gate self-tests" bun test scripts/gates.test.ts scripts/schema-drift.test.ts scripts/reachability.test.ts scripts/do-init-gate.test.ts scripts/platform-catalog.test.ts scripts/policy-drift.test.ts scripts/scratch-ownership.test.ts scripts/literature-citations.test.ts scripts/commit-hygiene.test.ts scripts/lean-citations.test.ts scripts/infra.test.ts scripts/patch-parity.test.ts scripts/silent-drop.test.ts scripts/analytics-datasets.test.ts scripts/release-config.test.ts scripts/complexity.test.ts scripts/dead-code.test.ts scripts/scanner-bundle-gate.test.ts scripts/coverage-merge.test.ts scripts/test-census.test.ts
run_required_gate "Skip ratchet and typecheck coverage self-tests" bun test scripts/skip-ratchet.test.ts scripts/typecheck-coverage.test.ts scripts/python-suites.test.ts
run_required_gate "Set-equality gate self-tests" bun test scripts/gate-set-equality.test.ts
run_required_gate "Wired gate self-tests" bun test scripts/wired.test.ts
run_required_gate "UI gate self-tests" bun test scripts/chat-and-files-ux.test.ts scripts/computed-style.test.ts scripts/control-plane-ux.test.ts scripts/feedback-ux.test.ts scripts/plan-review-ux.test.ts scripts/gadget-sandbox-ux.test.ts
run_required_gate "Public pages render" bun test scripts/public-pages.test.ts
run_required_gate "Client failure recovery" bun test scripts/client-error-ux.test.ts scripts/lazy-route-ux.test.ts
run_required_gate "React runtime identity" bun test scripts/react-runtime-identity.test.ts
run_required_gate "Nested container resolution" bun test scripts/nested-container-resolution.test.ts
run_required_gate "Swarm-tree geometry" bun test scripts/swarm-tree-geometry.test.ts
run_required_gate "Chat infinite scroll" bun test scripts/chat-scroll.test.ts
run_required_gate "Gate ladder wiring" bun test scripts/ladder.test.ts
run_required_gate "Tier-budget ratchet" bun run gate:ladder-budget
run_required_gate "Dead code" bun run gate:dead-code
run_required_gate "Built but unwired" bun run gate:wired
# The test corpus's own quality ratchet: a NEW coupled test, by the five axes
# a test review judges on. Beside the wired gate because they hold two sides of
# one boundary — an export added to satisfy a test is a wired finding, a
# constant restated beside a module is a census finding.
run_required_gate "Test census ratchet" bun scripts/test-census.ts --ratchet
run_required_gate "Duplicate implementations" bun run gate:duplication
run_required_gate "Complexity budget" bun run gate:complexity
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
run_required_gate "Commit message hygiene" bun run gate:commit-message
run_required_gate "Dependency install-script policy" bun run gate:install-scripts
run_required_gate "Install scanner bundle" bun run gate:scanner-bundle
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

# ALONE, and deliberately so: this gate's SUBJECT is contention. It saturates
# half the machine's threads on purpose, so a gate running beside it would fail
# for a reason unrelated to the change under test — which is the one thing a
# deploy gate must never do. See SERIAL_GATES in scripts/ladder.ts.
run_required_gate "Contended reruns of the Cloudflare suite" bun run gate:hammer

# BARRIER.
flush_gates


# Alone, and last. Everything above proves the SOURCE is deployable; this proves
# the ACCOUNT is. Scoped to the environment being deployed (KINU_DEPLOY_ENV), so a
# staging deploy is not refused for a production defect and a production deploy is
# not refused for staging drift. `npx wrangler whoami` above is its precondition —
# without a session it reports BLOCKED and non-zero rather than skipping. See
# SERIAL_GATES in scripts/ladder.ts.
#
# It runs the phase KINU_INFRA_PHASE names: `full` normally, `bootstrap` when the
# operator passed `--bootstrap`. The line itself stays ONE string because
# scripts/ladder.ts parses these lines and holds them equal to LADDER, which is
# why what varies per run travels in the environment beside it — exactly as
# KINU_DEPLOY_ENV already does.
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

echo "Building the CLI distribution"
bash "$KINU_ROOT/scripts/build-cli-dist.sh" || { echo -e "${RED}CLI distribution build failed${NC}"; exit 1; }

# Neither environment may ship without every CLI download asset sitting in the
# directory wrangler publishes. A deploy missing one bricks every fresh install
# and update on the platform it belongs to.
KINU_CLI_ARTIFACTS=(kinu-runtime-cpython.tar.gz)
for platform in darwin-arm64 darwin-x64 linux-arm64 linux-x64; do
  KINU_CLI_ARTIFACTS+=("kinu-cli-$platform.tar.gz")
done
for file in kinu-version.json "${KINU_CLI_ARTIFACTS[@]}" "${KINU_CLI_ARTIFACTS[@]/%/.sha256}"; do
  if [ ! -s "$KINU_ASSETS_DIR/downloads/$file" ]; then
    echo -e "${RED}❌ Missing build output: $KINU_ASSETS_DIR/downloads/$file${NC}"
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

if [ "$LIVE_STATUS" = "200" ]; then
  LIVE_HTML=$(curl -fsSL --max-time 15 "$KINU_URL" 2>/dev/null || true)
  if grep -q "id=\"$KINU_APP_ROOT\"" <<< "$LIVE_HTML" \
    && grep -q '<script type="module"' <<< "$LIVE_HTML"; then
    echo -e "${GREEN}✅ Kinu live site serves the application shell${NC}"
  else
    echo -e "${RED}❌ Kinu live site returned 200 without the application shell${NC}"
    SMOKE_FAIL=1
  fi
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
if echo "$CLI_SHIM" | grep -q 'downloads/kinu-cli-' && ! echo "$CLI_SHIM" | grep -q 'github.com'; then
  echo -e "${GREEN}✅ Kinu CLI launcher uses the deployed build artifacts${NC}"
else
  echo -e "${RED}❌ Kinu CLI launcher is not using the deployed build artifacts${NC}"
  SMOKE_FAIL=1
fi

# Every artifact the launcher can ask for, downloaded and hashed the way the
# launcher does it. A platform whose artifact never published installs nothing,
# and a checksum that disagrees makes install and update both refuse.
CLI_ARTIFACT_TMP="$(mktemp -t kinu-cli-artifact.XXXXXX.tar.gz)"
CLI_ARTIFACT_LIST="$(mktemp -t kinu-cli-artifact.XXXXXX.list)"
for artifact in "${KINU_CLI_ARTIFACTS[@]}"; do
  case "$artifact" in
    kinu-runtime-cpython.tar.gz) MEMBER='kinu/node_modules/@nimbus-sh/runtime-cpython/manifest.json' ;;
    *) MEMBER='kinu/cli.js' ;;
  esac
  CLI_ARTIFACT_OK=0
  for attempt in 1 2 3 4 5 6; do
    if curl -fsSL --max-time 60 "${KINU_URL}downloads/$artifact" -o "$CLI_ARTIFACT_TMP" \
      && tar -tzf "$CLI_ARTIFACT_TMP" > "$CLI_ARTIFACT_LIST" \
      && grep -Fq "$MEMBER" "$CLI_ARTIFACT_LIST"; then
      CLI_ARTIFACT_OK=1
      break
    fi
    [ "$attempt" = "6" ] || sleep 5
  done
  if [ "$CLI_ARTIFACT_OK" != "1" ]; then
    echo -e "${RED}❌ $artifact is missing, unreadable, or carries no $MEMBER${NC}"
    SMOKE_FAIL=1
    continue
  fi
  PUBLISHED_SHA="$(curl -fsSL --max-time 15 "${KINU_URL}downloads/$artifact.sha256" 2>/dev/null | awk '{print $1}')"
  ACTUAL_SHA="$(sha256sum "$CLI_ARTIFACT_TMP" | awk '{print $1}')"
  if [ -n "$PUBLISHED_SHA" ] && [ "$PUBLISHED_SHA" = "$ACTUAL_SHA" ]; then
    echo -e "${GREEN}✅ $artifact downloads and matches its published .sha256${NC}"
  else
    echo -e "${RED}❌ $artifact checksum is missing or does not match the download${NC}"
    SMOKE_FAIL=1
  fi
done
rm -f "$CLI_ARTIFACT_TMP" "$CLI_ARTIFACT_LIST"

if [ "$SMOKE_FAIL" -ne 0 ]; then
  echo ""
  echo -e "${RED}Smoke test failed.${NC}"
  exit 1
fi

# ── Step 4b: The first-run tier ──────────────────────────────────
#
# STAGING ONLY, and that is not a cost decision. The tier acts as the eval
# identity, which is a STAGING construct by design: the same DEV_IDENTITY_SECRET
# that lets a test act as a signed-in user without signing in is the whole
# authority for that identity, and production deliberately carries neither it nor
# DEV_USER_EMAIL (wrangler.jsonc:441-445, scripts/infra-manifest.ts:586-601) —
# a first-run against production would need a service identity production is
# built to refuse. The same bits reach production minutes after staging passed
# them, so the product a production user meets IS the one this tier judged.
#
# WHAT A NEW USER MEETS, on the build that just landed. Every gate above this
# line ran BEFORE the upload, on this tree, over inputs their authors wrote. The
# owner found four product defects by hand in two days that 33 such gates and an
# 11,531-test census never touched — a crafted tool that would not run, an
# Approve button that re-ticked every box, two machines flapping on one slot,
# Enter not sending in the TUI — and every one of them had a green test, because
# each test exercised what its author wrote instead of what a user brings.
#
# So this tier drives the DEPLOYED product the way a person does: a fresh
# workspace per case over the public REST, the real model, a real click in
# Chrome, two real daemons, real pty bytes. One case per defect, hard assertions
# only, red on any of them.
#
# AFTER THE SMOKE GATE, because the smoke gate answers a cheaper question first:
# did the deploy land at all. Running this against an origin that is not serving
# would report six product failures for one deployment failure.
#
# ALONE, in its own wave, and `SERIAL_GATES` in scripts/ladder.ts carries the
# reason: it attaches real machines to the account and drives a real browser
# session as the same identity `gate:infra` authenticates with. Two gates on one
# account is how a fleet case measures a sibling's daemons.
#
# THE ENQUEUE LINE STAYS AT COLUMN 0, inside the guard. `scripts/ladder.ts`
# parses these lines with `^run_required_gate`, so an indented one is invisible
# to `deployGates`/`deployWaves` — the gate would run on staging while the
# ladder, the CI-coverage assertion and the deploy contract all reported a tier
# that does not exist. Measured: indenting it dropped the gate from the parse
# and left `deploy.test.ts` green over a wave it could no longer see.
if [ "$KINU_ENV" = "staging" ]; then
run_required_gate "First-run tier" bun run gate:first-run
fi

# BARRIER.
flush_gates

# ── Step 5: Post-deploy infrastructure verification ──────────────
#
# UNCONDITIONAL, IN BOTH ENVIRONMENTS, AND RELAXED BY NOTHING. This is the other
# half of the pre-deploy phase and the reason `--bootstrap` is allowed to defer
# anything at all: the upload has run, so every resource the deployed version
# declares — Durable Object namespaces, the container application, the routes,
# the cron, the Worker itself — exists now or this deployment failed. No flag, no
# environment variable and no argument reaches this line with a weaker phase;
# `--phase=post-deploy` is spelled here, on the argv, and it is the strictest of
# the three.
#
# It runs AFTER the smoke test because the two ask different questions and this
# one is the slower to settle: a route and a custom domain need a moment at the
# edge, while the smoke test above only needs the origin to answer. And a green
# smoke test does not answer this question at all — the site answered 200 with
# the bindings it already had, and a namespace the new version declares while the
# account never created it throws on the FIRST request down its own path, which
# no public route touches.
echo ""
echo -e "${BOLD}Step 5: Post-deploy infrastructure verification${NC}"
if bun scripts/infra-verify.ts "$KINU_ENV" --phase=post-deploy; then
  echo -e "${GREEN}✅ Every declared resource exists and is bound${NC}"
else
  echo ""
  echo -e "${RED}❌ Post-deploy infrastructure verification failed for $KINU_ENV.${NC}"
  echo "   The Worker uploaded and the smoke test passed, and a resource the deployed version"
  echo "   declares is not in this account. The findings above name each one. Whatever the"
  echo "   public route answers, this deployment is not good."
  exit 1
fi

# ── Step 6: Summary ──────────────────────────────────────────────
echo ""
echo -e "${BOLD}Deploy complete — $KINU_ENV.${NC}"
echo "================================="
echo "Kinu:  $KINU_URL"
echo "          version ${KINU_VERSION:-unknown}"
echo "          build   $KINU_SHA"
echo ""
echo -e "${GREEN}✅ Kinu Worker deployed and verified.${NC}"
