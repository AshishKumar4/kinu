#!/usr/bin/env bash
# Kinu deploy pipeline — THE deploy path. One environment, https://kinu.run.
#   bun run deploy
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
#   bash scripts/deploy.sh [--bootstrap]
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

# ── The one environment ──────────────────────────────────────────────────────
#
# There is no staging. The product has no external users, so the deployed
# worker IS the test target: every gate below, the first-run tier included,
# drives https://kinu.run. The landing carries the app behind auth, so the
# smoke marker is one value.
KINU_ENV="production"
KINU_APP_ROOT="landing-root"
KINU_URL="https://kinu.run/"
KINU_WRANGLER_ARGS=()

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
# `--gates-only` runs every pre-publish wave exactly as a deploy would — same
# gates, same barriers, same cost caps — and stops before the build. It is how
# the WAVE is measured, as opposed to how a row is: a row's own figures come
# from `bun scripts/gate-cost-measure.ts`, which runs it alone. On the
# argv and never from the environment, so no ambient variable can turn a
# deploy into a rehearsal.
KINU_GATES_ONLY=0
# `--all` is the full audit: a wave keeps LAUNCHING after its first red, so
# every red in the tier is reported in one run rather than the first few. The
# default stops launching on the first red — the fastest path to the first
# finding — and still lets every running gate finish and report. Neither
# changes what a red means: a deploy with any red gate publishes nothing.
KINU_GATES_ALL=0
for option in "$@"; do
  case "$option" in
    --bootstrap) KINU_BOOTSTRAP=1 ;;
    --gates-only) KINU_GATES_ONLY=1 ;;
    --all) KINU_GATES_ALL=1 ;;
    *)
      echo -e "${RED}Unknown option '$option'.${NC}"
      echo "Usage: scripts/deploy.sh [--bootstrap] [--gates-only] [--all]"
      exit 2
      ;;
  esac
done
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
unset CLOUDFLARE_ENV

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
# missing asset presents itself (the SPA shell under a JSON
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

# ── The gate plan ────────────────────────────────────────────────
#
# WHAT RUNS IS READ, NOT WRITTEN HERE. `bun scripts/ladder.ts --plan` prints
# every deploy-tier gate as one tab-separated line — phase, label, measured
# threads, measured resident MiB, deadline, command — in the order the phases
# run. This script loads that once and `run_phase <name>` schedules the phase's
# gates concurrently under the machine cap, then waits: a barrier. Until
# 2026-09-15 this file held a second copy of every row (the command lines, a
# weight table, a deadline table, an exclusion table) that deploy.test.ts held
# equal to the ladder, and every new suite was a hand edit in three files.
# There is one copy now.
#
# Phases, in the ladder's DEPLOY_PHASES order: `preflight` alone before
# anything; `source`, the one concurrent wave; `hammer` and `infra` alone after
# it; `post-publish` after the upload and the smoke test. A gate's row in
# scripts/ladder.ts declares which, and why it runs alone.
#
# Every gate is a plain argv of words — the plan carries no quotes — and
# `flush_gates` splits it on whitespace; bash expands a glob word against the
# tree, which is how the UI row's `scripts/*-ux.test.ts` reaches its family.
# Its `--path-ignore-patterns=<suite>` word holds no glob character, so bash
# passes it through and bun subtracts the suite that is a row of its own.
PLAN_PHASE=()
PLAN_LABEL=()
PLAN_THREADS=()
PLAN_RSS=()
PLAN_DEADLINE=()
PLAN_SHARED=()
PLAN_CMD=()

load_plan() {
  local plan
  plan="$(bun scripts/ladder.ts --plan)" || {
    echo -e "${RED}❌ the ladder printed no plan; nothing is scheduled without one.${NC}"
    exit 1
  }
  local phase label threads rss deadline shared cmd
  while IFS=$'\t' read -r phase label threads rss deadline shared cmd; do
    [ -n "$cmd" ] || continue
    PLAN_PHASE+=("$phase")
    PLAN_LABEL+=("$label")
    PLAN_THREADS+=("$threads")
    PLAN_RSS+=("$rss")
    PLAN_DEADLINE+=("$deadline")
    PLAN_SHARED+=("$shared")
    PLAN_CMD+=("$cmd")
  done <<< "$plan"
  if [ "${#PLAN_CMD[@]}" -eq 0 ]; then
    echo -e "${RED}❌ the plan holds no gate. A deploy that schedules nothing publishes nothing.${NC}"
    exit 1
  fi
}

# The gates of one phase, as the queue flush_gates runs.
GATE_LABELS=()
GATE_CMDS=()
GATE_THREADS=()
GATE_RSS=()
GATE_DEADLINE=()
GATE_SHARED=()

run_phase() {
  local wanted="$1" index
  GATE_LABELS=(); GATE_CMDS=(); GATE_THREADS=(); GATE_RSS=(); GATE_DEADLINE=(); GATE_SHARED=()
  for ((index = 0; index < ${#PLAN_CMD[@]}; index++)); do
    if [ "${PLAN_PHASE[index]}" != "$wanted" ]; then continue; fi
    GATE_LABELS+=("${PLAN_LABEL[index]}")
    GATE_CMDS+=("${PLAN_CMD[index]}")
    GATE_THREADS+=("${PLAN_THREADS[index]}")
    GATE_RSS+=("${PLAN_RSS[index]}")
    GATE_DEADLINE+=("${PLAN_DEADLINE[index]}")
    GATE_SHARED+=("${PLAN_SHARED[index]}")
  done
  if [ "${#GATE_CMDS[@]}" -eq 0 ]; then
    echo -e "${RED}❌ phase '$wanted' holds no gate in the plan.${NC}"
    exit 1
  fi
  flush_gates
}

# THE WAVE IS SCHEDULED BY MEASURED COST, IN TWO DIMENSIONS, UNDER A CAP THIS
# BOX ANSWERS FOR. A row carries what it was measured to take when it ran alone
# (scripts/gate-cost.json, written by `bun scripts/gate-cost-measure.ts`):
# the threads it burns at peak and the resident set it holds at peak. A row
# launches only while BOTH the running threads plus its own fit `nproc` and the
# running resident set plus its own fits the memory the kernel says is
# available. A row heavier than the whole cap still launches when nothing else
# is running, so the cap can never wedge.
#
# Measured 2026-08-23: a half-thread rule launched 12 outer gates and up to 48
# inner workers here, turned a 23.67s CLI file into a 173.54s run and produced
# nine false timeout failures. Measured 2026-09-16: a six-gate width — the rule
# that replaced it — put the eleven-suite UI row beside two `--parallel=4`
# package suites and failed every deploy that day on a puppeteer wall, while
# the same row passed alone in 361s. The DECLARED thread figure that replaced
# the width then failed the same way for the same reason: five rows died on
# their per-row deadline across the two deploys of 2026-09-16, one of them at
# 137 — the kernel's status for a SIGKILL, which no thread budget can predict —
# and the three rows that run workerd had each declared one thread and no
# memory at all. A count of gates is not a measure of load; neither is a
# number a row wrote about itself.
#
# MemAvailable, not MemTotal: MemTotal includes memory nothing can have, and a
# cap taken from it is a cap that admits rows onto swap. The reserve is the
# fraction of what is available that the wave does not claim — page cache for
# the suites' own I/O, and whatever else on this box grows while the wave runs.
# Measured 2026-09-17: the source wave's summed admitted peaks ran 5.9 GiB
# under the machine's own MemAvailable floor at a 75% reserve line, and no row
# was killed under either loaded run.
#
# AND ONE ROW AT A TIME PER SHARED RESOURCE, WHICH NO COST FIGURE CAN EXPRESS.
# A row that boots a headless browser takes the box's browser lane whole — the
# Chrome tree, the dev server behind it, and the workerd the Cloudflare vite
# plugin runs the product in. The plan carries the resource per row (`shared`,
# derived in scripts/ladder.ts from the modules each row claims) and the wave
# holds at most one row of it in flight; every row's declared seconds were
# measured alone, so serial admission is what those declarations assumed.
#
# A HYPOTHESIS, AND THE MEASUREMENT THAT SAYS SO. Measured 2026-09-18 on this
# box, quiet (load 1.04 concurrent, 0.45 serial, 41,197 MiB available), the
# three browser rows of that day's red wave: concurrently 480.1s/124,
# 480.1s/124 and 152.8s/1; serially 480.2s/124, 480.2s/124 and 149.7s/1. The
# overlap is NOT what reddened them — all three are red alone on one product
# defect (L9). What IS measured is that no cap can refuse the overlap: those
# rows are admitted at 1, 1 and 3 threads and 2,534, 2,458 and 6,446 MiB
# against 24 threads and 30.7 GiB. L9 in docs/ARCHITECTURE-DECISIONS.md.
GATE_RESERVE_PERCENT=75

gate_thread_cap() {
  echo "${KINU_DEPLOY_THREADS:-$(nproc 2>/dev/null || echo 4)}"
}

# Prints nothing it cannot read: the CALLER refuses, because an `exit` inside a
# command substitution ends only the subshell and would leave the wave running
# with an empty cap.
gate_rss_cap() {
  if [ -n "${KINU_DEPLOY_RSS_MB:-}" ]; then
    echo "$KINU_DEPLOY_RSS_MB"
    return 0
  fi
  awk -v reserve="$GATE_RESERVE_PERCENT" \
    '/^MemAvailable:/ { print int($2 / 1024 * reserve / 100) }' /proc/meminfo 2>/dev/null
}

# Run everything enqueued, then clear the queue. Each gate's output goes to its
# own file and is printed ONLY if it fails: a wave's concurrent streams interleaved
# into one terminal is not a log anybody can read, and the output a reader wants
# is the failing gate's.
#
# WHERE A GATE'S VERDICT COMES FROM: `wait -n -p`, which hands back the pid that
# terminated and its exit status together. That is the whole reaping story, and
# it is deliberately not a status file. A status file is written by the gate, so
# a gate whose process dies before it can write one — an OOM kill, a `kill -9`
# from outside the gate's own tree — leaves no verdict at all, and the only way
# left to notice is probing `kill -0` on a pid the shell has already reaped. A
# recycled pid answers that probe as somebody else's process, and a loop built
# that way has nothing left to wait on: it spins at 100% CPU and the deploy
# never ends. The kernel already knows every child's fate, so asking it removes
# the status files, the atomic-rename dance, the liveness probe and the poll in
# one move.
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

  local thread_cap rss_cap
  thread_cap="$(gate_thread_cap)"
  rss_cap="$(gate_rss_cap)"
  if [ -z "$rss_cap" ] || [ "$rss_cap" -le 0 ]; then
    # A cap nobody can read is a wave with no memory dimension at all, which is
    # the defect this scheduling came from. Refused rather than defaulted.
    echo -e "${RED}❌ cannot read MemAvailable from /proc/meminfo; the wave has no memory cap to schedule under.${NC}"
    echo "   Set KINU_DEPLOY_RSS_MB to schedule against a figure you name instead."
    exit 1
  fi

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

  local -a launched=() statuses=() started=()
  local -A gate_of_pid=()
  local -A resource_held=()
  local pick finished status threads rss resource wall
  local running=0 load=0 held=0 settled=0 failures=0
  for ((index = 0; index < total; index++)); do launched[index]=0; statuses[index]=-1; done

  if [ "$KINU_GATES_ALL" = "1" ]; then
    echo "Running $total gate(s) within $thread_cap threads and $rss_cap MiB of measured cost, every gate regardless of failures (--all)"
  else
    echo "Running $total gate(s) within $thread_cap threads and $rss_cap MiB of measured cost, stopping new launches at the first failure"
  fi
  local lanes=0
  for ((index = 0; index < total; index++)); do
    if [ "${GATE_SHARED[index]}" != "none" ]; then lanes=$((lanes + 1)); fi
  done
  if [ "$lanes" -gt 0 ]; then
    echo "  $lanes of them hold a shared resource (a browser and the dev server behind it) and run one at a time"
  fi
  while [ "$settled" -lt "$total" ]; do
    # Take the FIRST gate that is not launched, whose shared resource is free,
    # and whose MEASURED cost fits what is left of both caps — or, when nothing
    # is running, the first gate regardless of the caps, so a gate heavier than
    # the whole cap still runs and the cap can never wedge. A plain queue
    # pointer would stall the whole wave behind a gallery gate waiting for its
    # turn.
    #
    # The RESOURCE check is not part of that bypass: it is the one admission a
    # row cannot be let past, and with nothing running no resource is held, so
    # it cannot wedge either.
    while [ "$failures" -eq 0 ] || [ "$KINU_GATES_ALL" = "1" ]; do
      pick=-1
      for ((index = 0; index < total; index++)); do
        if [ "${launched[index]}" -eq 1 ]; then continue; fi
        threads="${GATE_THREADS[index]}"
        rss="${GATE_RSS[index]}"
        resource="${GATE_SHARED[index]}"
        if [ "$resource" != "none" ] && [ -n "${resource_held[$resource]:-}" ]; then continue; fi
        if [ "$running" -gt 0 ]; then
          if [ $((load + threads)) -gt "$thread_cap" ] || [ $((held + rss)) -gt "$rss_cap" ]; then continue; fi
        fi
        pick=$index
        break
      done
      if [ "$pick" -lt 0 ]; then break; fi
      launched[pick]=1
      load=$((load + GATE_THREADS[pick]))
      held=$((held + GATE_RSS[pick]))
      if [ "${GATE_SHARED[pick]}" != "none" ]; then resource_held["${GATE_SHARED[pick]}"]="$pick"; fi
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
        exec timeout --signal=TERM --kill-after=5s "${GATE_DEADLINE[pick]}" ${GATE_CMDS[pick]} > "$dir/$pick.log" 2>&1
      ) &
      gate_of_pid[$!]=$pick
      started[pick]=$SECONDS
      running=$((running + 1))
    done

    if [ "$running" -eq 0 ]; then
      # Nothing running and nothing launchable: after a failure that is the
      # planned end of the wave, and with nothing running every unlaunched gate
      # fits both caps by construction, so anything else here is a scheduler
      # defect and fails rather than looping over a queue that cannot move.
      if [ "$failures" -ne 0 ]; then break; fi
      echo -e "${RED}❌ $((total - settled)) gate(s) can never launch with nothing running.${NC}"
      rm -rf "$dir"
      exit 1
    fi

    finished=""
    wait -n -p finished; status=$?
    if [ -z "${finished:-}" ] || [ -z "${gate_of_pid[$finished]:-}" ]; then
      # `wait` came back without naming a child of this wave, so the status
      # cannot be attributed to a gate. Stop rather than credit it to one.
      echo -e "${RED}❌ a gate wait returned no child of this wave (status $status).${NC}"
      echo "Gate logs retained at $dir" >&2
      exit 1
    fi
    index="${gate_of_pid[$finished]}"
    unset "gate_of_pid[$finished]"
    running=$((running - 1))
    load=$((load - GATE_THREADS[index]))
    held=$((held - GATE_RSS[index]))
    if [ "${GATE_SHARED[index]}" != "none" ]; then unset "resource_held[${GATE_SHARED[index]}]"; fi
    settled=$((settled + 1))
    statuses[index]=$status
    # Wall seconds since launch, on the line itself: which row a wave waits on
    # is otherwise unanswerable once the gate dir is gone.
    wall=$((SECONDS - started[index]))
    if [ "$status" -eq 0 ]; then
      echo -e "${GREEN}✅ ${GATE_LABELS[index]}${NC} ${wall}s"
    else
      failures=$((failures + 1))
      echo -e "${RED}❌ ${GATE_LABELS[index]} failed (exit $status)${NC} ${wall}s"
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
    if [ "${DEPLOY_PUBLISHED:-0}" -eq 1 ]; then
      echo -e "${RED}❌ $failures gate(s) failed AFTER publish: the build is live and this tier is red against it.${NC}"
    else
      echo -e "${RED}❌ $failures gate(s) failed. The build and publish steps did not start.${NC}"
    fi
    rm -rf "$dir"
    exit 1
  fi

  rm -rf "$dir"
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
# test, which reads as a code regression and is not one. It repairs nothing;
# `--reclaim` is explicit and separate. The plan is loaded first because the
# preflight is its first phase.
load_plan
run_phase preflight

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

# The source wave: every gate the plan marks `source`, concurrent under the
# thread budget, unconditional. No environment variable may skip one when this
# production deploy path is running; a gate that should not be here leaves the
# ladder, never this script.
run_phase source

# ALONE, and deliberately so: the hammer's SUBJECT is contention. It saturates
# half the machine's threads on purpose, so a gate running beside it would fail
# for a reason unrelated to the change under test. Its row says so.
run_phase hammer


# Alone, and last before the build. Everything above proves the SOURCE is
# deployable; this proves the ACCOUNT is. Scoped to the environment being
# deployed (KINU_DEPLOY_ENV) and the phase KINU_INFRA_PHASE names (`full`
# normally, `bootstrap` under `--bootstrap`), both travelling in the
# environment so the gate's command stays one string in the plan.
run_phase infra

# The agent tiers run AFTER the publish, in Step 4b — where first-run already
# is. A tier whose subject is the agent on a deployed build can only measure a
# build that exists, and the only honest one to measure is the one this deploy
# just shipped.

echo ""
echo -e "${GREEN}All required pre-deploy gates passed.${NC}"
if [ "$KINU_GATES_ONLY" = "1" ]; then
  echo "Gates only: stopping before the build, as asked."
  exit 0
fi

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

# The worker release artifact, BEFORE the CLI distribution: `build-cli-dist.sh`
# signs every artifact it finds in the downloads directory, so writing this one
# first is what puts its checksum in `kinu-version.json` beside the CLI's. The
# self-deploy flow reads `release.json` and verifies the tarball against the
# `.sha256` published beside it, which is integrity and not a signature; the
# smoke check below is where that sidecar is held against the signed manifest,
# so a drift between them fails this deploy (docs/SELF-DEPLOY.md).
KINU_RELEASE_VERSION="$(bun -e '
  const manifest = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(manifest.version.split("+")[0]);
' "$KINU_ROOT/packages/cli/package.json")+$KINU_SHA"
echo "Building the worker release artifact ($KINU_RELEASE_VERSION)"
bun "$KINU_ROOT/scripts/build-worker-release.ts" "$KINU_RELEASE_VERSION" "$KINU_SHA" \
  || { echo -e "${RED}worker release artifact build failed${NC}"; exit 1; }

echo "Building the CLI distribution"
bash "$KINU_ROOT/scripts/build-cli-dist.sh" || { echo -e "${RED}CLI distribution build failed${NC}"; exit 1; }

# Neither environment may ship without every CLI download asset sitting in the
# directory wrangler publishes. A deploy missing one bricks every fresh install
# and update on the platform it belongs to.
KINU_CLI_ARTIFACTS=(kinu-runtime-cpython.tar.gz)
for platform in darwin-arm64 darwin-x64 linux-arm64 linux-x64; do
  KINU_CLI_ARTIFACTS+=("kinu-cli-$platform.tar.gz")
done
KINU_WORKER_ARTIFACT="kinu-worker-$KINU_RELEASE_VERSION.tar.gz"
KINU_WORKER_ARTIFACT_PATH="$KINU_ROOT/packages/cf-backend/dist/worker-release/$KINU_WORKER_ARTIFACT"
for file in kinu-version.json release.json "$KINU_WORKER_ARTIFACT.sha256" \
  "${KINU_CLI_ARTIFACTS[@]}" "${KINU_CLI_ARTIFACTS[@]/%/.sha256}"; do
  if [ ! -s "$KINU_ASSETS_DIR/downloads/$file" ]; then
    echo -e "${RED}❌ Missing build output: $KINU_ASSETS_DIR/downloads/$file${NC}"
    exit 1
  fi
done
if [ ! -s "$KINU_WORKER_ARTIFACT_PATH" ]; then
  echo -e "${RED}❌ Missing build output: $KINU_WORKER_ARTIFACT_PATH${NC}"
  exit 1
fi
echo -e "${GREEN}✅ CLI and worker release assets staged in $KINU_ASSETS_DIR/downloads${NC}"

# The worker artifact is larger than Cloudflare's 25 MiB per-file asset limit,
# so it is published into R2 and streamed by the Worker instead. BEFORE the
# deploy, never after: the release.json this deploy publishes names this
# artifact, and a manifest that names an object nobody uploaded yet sends every
# self-deploy run at a 404.
echo "Publishing $KINU_WORKER_ARTIFACT to r2://kinu-releases"
npx wrangler r2 object put "kinu-releases/$KINU_WORKER_ARTIFACT" \
  --file "$KINU_WORKER_ARTIFACT_PATH" --content-type application/gzip --remote \
  || { echo -e "${RED}❌ uploading the worker release artifact failed${NC}"; exit 1; }
npx wrangler r2 object put "kinu-releases/$KINU_WORKER_ARTIFACT.sha256" \
  --file "$KINU_ASSETS_DIR/downloads/$KINU_WORKER_ARTIFACT.sha256" --content-type text/plain --remote \
  || { echo -e "${RED}❌ uploading the worker release checksum failed${NC}"; exit 1; }
echo -e "${GREEN}✅ Worker release artifact published to R2${NC}"

# ── Step 3: Deploy Kinu ───────────────────────────────────────
echo ""
echo -e "${BOLD}Step 3: Deploying Kinu${NC}"
KINU_DEPLOY_LOG="$(mktemp -t kinu-deploy.XXXXXX.log)"
echo ""
echo "Running: npx wrangler deploy ${KINU_WRANGLER_ARGS[*]} (log → $KINU_DEPLOY_LOG)"
echo ""
if npx wrangler deploy "${KINU_WRANGLER_ARGS[@]}" 2>&1 | tee "$KINU_DEPLOY_LOG"; then
  DEPLOY_PUBLISHED=1
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

# The self-deploy channel. Same SPA-shell hazard as the stamp above, and worse
# consequences: a deployment reading a shell instead of a manifest would try to
# upload a Worker made of an HTML page.
RELEASE_SHA=""
for _try in 1 2 3 4 5 6 7 8; do
  RELEASE_SHA=$(curl -fsSL --max-time 15 "${KINU_URL}downloads/release.json?smoke=$_try" 2>/dev/null | json_field sha)
  [ "$RELEASE_SHA" = "$KINU_SHA" ] && break
  sleep 15
done
RELEASE_ARTIFACT_SHA="$(curl -fsSL --max-time 15 "${KINU_URL}downloads/$KINU_WORKER_ARTIFACT.sha256" 2>/dev/null | awk '{print $1}')"
SIGNED_ARTIFACT_SHA="$(curl -fsSL --max-time 15 "${KINU_URL}downloads/kinu-version.json" 2>/dev/null \
  | bun -e 'const m=JSON.parse(await Bun.stdin.text()); process.stdout.write(m.checksums?.["/downloads/"+process.argv[1]] ?? "")' "$KINU_WORKER_ARTIFACT")"
ARTIFACT_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -I --max-time 30 "${KINU_URL}downloads/$KINU_WORKER_ARTIFACT" 2>/dev/null)"
if [ "$RELEASE_SHA" = "$KINU_SHA" ] && [ -n "$RELEASE_ARTIFACT_SHA" ] \
  && [ "$RELEASE_ARTIFACT_SHA" = "$SIGNED_ARTIFACT_SHA" ] && [ "$ARTIFACT_STATUS" = "200" ]; then
  echo -e "${GREEN}✅ release.json names this build, the artifact route answers, and its checksum is the signed one${NC}"
else
  echo -e "${RED}❌ release.json sha is '${RELEASE_SHA:-<unparseable>}' (expected '$KINU_SHA'); worker artifact checksum '${RELEASE_ARTIFACT_SHA:-<none>}' vs signed '${SIGNED_ARTIFACT_SHA:-<none>}'; artifact route answered ${ARTIFACT_STATUS:-<none>}${NC}"
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

# ── Step 4b: The post-publish tiers ─────────────────────────────────────────
#
# AGAINST THE DEPLOYED PRODUCT, every deploy. There is one environment, so the
# worker this tier drives is the one a user meets. It acts as the eval service
# identity: `DEV_USER_EMAIL` names it in wrangler.jsonc and `DEV_IDENTITY_SECRET`
# is its whole authority, honoured only for a request presenting the secret and
# refused by the admin gate regardless (control-plane/admin-caller.ts). Every
# workspace a case creates carries the eval prefix and is torn down by the run.
#
# WHY IT EXISTS. Every gate above this line ran BEFORE the upload, on this tree,
# over inputs their authors wrote. The owner found product defects by hand that
# those gates never touched — a crafted tool that would not run, an Approve
# button that re-ticked every box, two machines flapping on one slot, Enter not
# sending in the TUI, and on 2026-09-10 every workspace open failing on a query
# no unit test ran — each with a green test, because each test exercised what
# its author wrote instead of what a user brings. On 2026-09-10 this tier was
# gated to a staging deploy that never happened, so production shipped without
# it four times in one day. It is unconditional now.
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
# ONE WAVE, both gates the plan marks `post-publish`: their rows say why each
# stays clear of the source wave (both drive the account as the same identity
# `gate:infra` authenticates with — real machines, a real browser, live model
# turns). They share a wave because they measure the same thing — the build
# that just shipped — and neither perturbs what the other asserts. A red here
# is a red on what users have NOW, and the runner says so.
run_phase post-publish

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
