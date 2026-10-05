#!/usr/bin/env bash
# Kinu deploy pipeline — THE deploy path. Every deploy lands on staging,
# https://staging.kinu.run, and production, https://kinu.run, gets only a build
# staging verified.
#   bun run deploy              staging: the upload gates, the upload, then every tier
#                               and every local gate to its end, and the record
#   bun run deploy --promote    production: HEAD's build, as staging verified it
#   bun run deploy --rollback   production: back to the build it took before
#
# Deploying any other way is how production once shipped without the CLI
# download assets: the site was fine, but /downloads/* answered with the SPA
# shell and every fresh install died on a checksum mismatch. Nothing here is
# optional. The gate below is what makes the difference between "the Worker
# uploaded" and "the product works".
#
# Deploys the cf-backend Worker (`kinu-staging`, or `kinu` under `--promote`)
# with the KinuDevbox Durable Object and its container, and the
# local-device executor routes. Pipeline: preflight → the upload gates (the
# account and the secret scan) → vite build → CLI source archive → wrangler
# deploy → smoke test → staging tiers beside the rows CI cannot host → CI's
# exact-SHA verdicts (including its isolated hammer) → the record. Promotion: the record → the upload gates →
# vite build → staging's downloads → wrangler deploy → smoke test → post-deploy
# tiers.
#
# REPORT-ALL (L18). Every phase after the upload runs to its end whatever goes
# red, so one deploy captures every failure, and the deploy ends with one report
# file, every red row with its finding, grouped by phase, whose path it prints
# (scripts/deploy-report.ts). Only the preflight, the precondition for any
# verdict, and the two upload gates, whose damage the next deploy cannot undo,
# stop a deploy early. A red build on staging is fine: staging is the test
# environment and the next deploy replaces it. The record production promotes
# from is written only when every phase is green.
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
# Usage:
#   bun run deploy [--promote | --rollback] [--reset]
#   bash scripts/deploy.sh [--promote] [--reset] [--bootstrap] [--gates-only]
#   bash scripts/deploy.sh --rollback
#
# `--promote` deploys production, and only the build staging verified: the
# record staging's green deploy of HEAD wrote (scripts/promote.ts) stands for
# the source gates, so none runs. It builds production's config at HEAD,
# refuses a build whose artifact is not the one staging ran, and publishes
# the downloads and worker release tarball that green run published, each
# checked by its hash. The account gate still runs first, for production's
# resources, and so does everything after the upload. A staging deploy
# withdraws HEAD's record before it builds, so a promotion never takes what a
# staging deploy under way, or red, left there.
#
# `--rollback` returns production to the newest build it took before the one it
# serves, a build a rollback left never again, and proves production then serves
# that build's downloads byte for byte. It runs no gate and builds nothing: it
# undoes a promotion whatever the tree holds.
#
# `--bootstrap` is for the deploy that DECLARES something only a deploy can
# create — a Durable Object class new to `exports`, a new container, a new
# route. It moves the pre-deploy infrastructure phase to `bootstrap`, which
# defers exactly those and nothing else. It skips no verification: every
# external prerequisite still refuses the deploy before the upload, and step 5
# below re-checks everything with no tolerance whatever, whether this flag was
# passed or not.
#
# `--reset` deletes every Durable Object class the Worker carries, with all its
# storage, between the build and the upload, which then creates every class
# `exports` declares (scripts/reset.ts). The Worker keeps its secrets and routes. The deploy
# record names what was deleted. On production it asks for a typed confirmation
# before anything runs.
#
# Idempotent: safe to re-run.
set -uo pipefail

GREEN='\033[0;32m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

# ── Locate Kinu root ──────────────────────────────────────────
KINU_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$KINU_ROOT" || { echo -e "${RED}Cannot cd to Kinu root${NC}"; exit 1; }
source "$KINU_ROOT/scripts/repo-runtime.sh"

export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-f44999d1ddda7012e9a87729eba250f1}"

# The landing carries the app behind auth in both environments, so the smoke
# marker is one value.
KINU_APP_ROOT="landing-root"
KINU_WRANGLER_ARGS=()

# ── Bootstrap, or not ─────────────────────────────────────────
#
# EXPLICIT, and only ever about the PRE-DEPLOY phase.
#
# A deploy that declares a resource only a deploy can create cannot pass a
# pre-deploy check demanding that resource already exist, and no provisioning
# command can close the gap: wrangler has no verb that creates a Durable Object
# namespace, a container application or a route. Measured: `ControlPlaneDO` was
# added to `migrations`, the pre-deploy gates (55 at the time) passed, and `gate:infra`
# then refused the only deploy that could have created the namespace — naming
# `bun run infra:provision` as the fix, which cannot.
#
# WHAT THIS FLAG DOES NOT DO. It skips no verification and it cannot. It moves
# the pre-deploy phase to `bootstrap`, which defers ONLY resources the
# infrastructure manifest marks `wrangler-deploy`; every external prerequisite —
# secrets, KV, R2, Vectorize, DNS, the AI Gateway — still refuses the deploy
# before the upload, and so does any lookup that merely failed. Step 5 below
# runs the full phase with no tolerance at all, unconditionally, and its
# findings fail the deployment.
KINU_BOOTSTRAP=0
# `--gates-only` runs every pre-publish wave exactly as a deploy would — same
# gates, same barriers, same cost caps — and stops before the build. It is how
# the WAVE is measured, as opposed to how a row is: a row's own figures come
# from `bun scripts/gate-cost-measure.ts`, which runs it alone. On the
# argv and never from the environment, so no ambient variable can turn a
# deploy into a rehearsal.
KINU_GATES_ONLY=0
# `--promote` is on the argv only, like `--gates-only`: no ambient variable can
# turn a staging deploy into a production one. So is `--reset`.
KINU_PROMOTE=0
KINU_ROLLBACK=0
KINU_RESET=0
for option in "$@"; do
  case "$option" in
    --promote) KINU_PROMOTE=1 ;;
    --rollback) KINU_ROLLBACK=1 ;;
    --bootstrap) KINU_BOOTSTRAP=1 ;;
    --gates-only) KINU_GATES_ONLY=1 ;;
    --reset) KINU_RESET=1 ;;
    *)
      echo -e "${RED}Unknown option '$option'.${NC}"
      echo "Usage: scripts/deploy.sh [--promote] [--reset] [--bootstrap] [--gates-only] | --rollback"
      exit 2
      ;;
  esac
done
unset CLOUDFLARE_ENV
if [ "$KINU_ROLLBACK" = "1" ]; then
  if [ "$#" -ne 1 ]; then
    echo -e "${RED}--rollback takes no other option.${NC}"
    exit 2
  fi
  exec bun "$KINU_ROOT/scripts/promote.ts" rollback
fi
# The pre-deploy phase, read by scripts/infra-verify.ts, travels in the
# environment so the `bun run gate:infra` line below stays one string for
# scripts/ladder.ts to parse.
# ALWAYS ASSIGNED, in both arms: an ambient KINU_INFRA_PHASE from whatever shell
# launched this must never decide how strictly a deploy nobody asked to
# bootstrap is checked. There is no third value, and no value of it reaches the
# upload without step 5 behind it.
if [ "$KINU_BOOTSTRAP" = "1" ]; then
  export KINU_INFRA_PHASE="bootstrap"
else
  export KINU_INFRA_PHASE="full"
fi

# ── The two environments ─────────────────────────────────────────────────────
#
# STAGING is where a deploy lands: `kinu-staging`, wrangler.jsonc's
# `env.staging`, with its own Durable Objects, stores and secrets, so the tiers
# below write nothing a user owns. PRODUCTION takes a build only through
# `--promote`. The Vite plugin fixes the environment into the build
# (`CLOUDFLARE_ENV`; Cloudflare Vite plugin docs, "Cloudflare Environments"),
# and `wrangler deploy` publishes the Worker that build names. So the Worker
# and origin below are READ from the build, and step 2 refuses a build of any
# other environment.
if [ "$KINU_PROMOTE" = "1" ]; then
  KINU_ENV="production"
else
  KINU_ENV="staging"
fi

# ONE DEPLOY OF AN ENVIRONMENT AT A TIME on this machine (L21): two would race
# on one Worker, one record and one report index, and continuous staging
# (scripts/staging-loop.ts) starts a deploy only when none runs. The script runs
# again under `flock`, which holds the environment's lock for the whole run and
# drops it however the run ends; with `-o` nothing the deploy starts inherits
# it, so a process it leaves behind cannot keep it. KINU_DEPLOY_LOCKED names the
# environment that re-run holds. A deploy that finds the lock held does nothing
# and exits 75, which the loop reads as "wait for that one".
if [ "${KINU_DEPLOY_LOCKED:-}" != "$KINU_ENV" ]; then
  KINU_DEPLOY_LOCK="${XDG_RUNTIME_DIR:-/tmp}/kinu-deploy-$KINU_ENV.lock"
  KINU_DEPLOY_LOCKED="$KINU_ENV" flock -n -o -E 75 "$KINU_DEPLOY_LOCK" "$BASH" "$0" "$@"
  status=$?
  if [ "$status" -eq 75 ]; then
    echo -e "${RED}Another $KINU_ENV deploy is running on this machine ($KINU_DEPLOY_LOCK is held), so this one did nothing.${NC}"
  fi
  exit "$status"
fi
# The environment `gate:infra` checks before the upload and step 5 after it,
# beside the command like the phase, and ALWAYS ASSIGNED for the same reason:
# an ambient value must never point a staging deploy's account check at
# production's resources.
export KINU_INFRA_ENVIRONMENT="$KINU_ENV"
KINU_WORKER=""
KINU_URL=""

# The plan is shown before the gates. A production reset is confirmed inside
# scripts/reset.ts wipe, at a terminal, just before it deletes, so a run with no
# terminal to ask on is refused here rather than after the build.
if [ "$KINU_RESET" = "1" ]; then
  if [ "$KINU_GATES_ONLY" = "1" ]; then
    echo -e "${RED}--reset deletes storage at the upload, and --gates-only stops before the build.${NC}"
    exit 2
  fi
  if [ "$KINU_ENV" = "production" ] && [ ! -t 0 ]; then
    echo -e "${RED}A production reset is confirmed at a terminal, and this run has none. Nothing was deployed or deleted.${NC}"
    exit 1
  fi
  echo -e "${BOLD}RESET: this deploy deletes every Durable Object of $KINU_ENV, with all its storage:${NC}"
  bun "$KINU_ROOT/scripts/reset.ts" plan "$KINU_ENV" || exit 1
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

# Temp log file — trap cleans up on any exit. A promotion that fails after its
# upload leaves production serving the red build, and says how to undo it.
KINU_DEPLOY_LOG=""
KINU_RESET_RECORD=""
cleanup() {
  local status=$?
  [ -n "$KINU_DEPLOY_LOG" ] && rm -f "$KINU_DEPLOY_LOG"
  if [ "$status" -ne 0 ] && [ "${DEPLOY_PUBLISHED:-0}" = "1" ] && [ "$KINU_PROMOTE" = "1" ]; then
    echo -e "${RED}Production serves this red promotion. Return it to the build it took before: bun run deploy --rollback${NC}"
  fi
  if [ "$status" -ne 0 ] && [ -n "$KINU_RESET_RECORD" ] && [ "${DEPLOY_PUBLISHED:-0}" != "1" ]; then
    echo -e "${RED}The reset ran and the build never uploaded: the reset lines above say what $KINU_WORKER serves and what was deleted. Deploy again with --reset: it finishes the reset from its record, or finds it done, and uploads the build.${NC}"
  fi
}
trap cleanup EXIT INT TERM

# Read one dotted JSON field from stdin. Prints nothing when the body is not
# JSON — which is exactly what a smoke test needs, because "not JSON" is how a
# missing asset presents itself (the SPA shell under a JSON
# content-type).
json_field() {
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=process.argv[1].split(".").reduce((o,k)=>o?.[k],JSON.parse(s));process.stdout.write(v==null?"":String(v))}catch{}})' "$1"
}

# ── The gate phases ──────────────────────────────────────────────
#
# WHAT RUNS IS READ, NOT WRITTEN HERE, AND SCHEDULED THERE TOO. `run_phase
# <name>` is `bun scripts/ladder.ts --deploy-phase=<name>`: the ladder runs its
# plan's rows of that phase through its one wave runner (`tierWave`), the same
# one the CI tier runs through. Admission is by each row's measured threads and
# resident set (scripts/gate-cost.json) under this box's caps (the CPU count
# and three quarters of MemAvailable, or KINU_DEPLOY_THREADS and
# KINU_DEPLOY_RSS_MB), one row at a time per shared resource such as the
# browser, and every row to its end whatever goes red. The command returns once
# every row it launched has ended: the phase's barrier. Each row's output is
# printed whole when it ends, under its own hang detector (scripts/deadline.ts),
# every red row is written into this deploy's report, and a red names every
# failed row at the end. Until 2026-09-15 this file held a second copy of every
# row, and until 2026-09-30 a second scheduler in Bash over the same cost table
# (L16).
#
# Phases, in the ladder's DEPLOY_PHASES order: `preflight` alone before
# anything; `upload`, the account gate and the secret scan, before any upload;
# 'post-publish', the tiers against the deployment, in one wave with 'source',
# only what CI cannot host. The isolated hammer runs on GitHub, not after this wave (L23).
# A gate's row in scripts/ladder.ts declares which, and why.
#
# `run_phase <phase[,phase]>` runs to the end and says whether anything went red;
# `stop_phase <phase>` ends the deploy on a red, for the phases nothing may pass:
# the preflight, the precondition for any verdict, and the upload gates.
run_phase() {
  local status
  bun scripts/ladder.ts "--deploy-phase=$1"
  status=$?
  if [ "$status" -eq 0 ]; then return 0; fi
  KINU_REDS=1
  echo -e "${RED}❌ the $1 phase failed (exit $status).${NC}"
  # 1 is the ladder's own verdict, every red it found already in the report.
  # Any other status is a runner that ended without one: a signal (the OOM
  # killer's 137) or a crash, which the kernel reports whether it cooperated
  # or not, so the report names the phase itself.
  if [ "$status" -ne 1 ]; then
    report note "$1" "the $1 phase's runner" "it ended with exit $status and no verdict of its own, so a row it had not reported on may be red and unnamed"
  fi
  return 1
}

stop_phase() {
  run_phase "$1" && return 0
  echo -e "${RED}❌ the $1 phase is red, so nothing was built or uploaded.${NC}"
  finish
}

# skip_phase <phase> <why>: the report names every row of <phase>, not run, and
# why, for rows that read a deployment this build never reached.
skip_phase() {
  bun scripts/ladder.ts "--deploy-phase=$1" "--skip=$2"
}

# ── The failure report ─────────────────────────────────────────────
#
# ONE FILE FOR THE WHOLE DEPLOY (scripts/deploy-report.ts): every red row with
# its finding, grouped by phase, marked new or carried over from the previous
# report of this environment, with the merges between the two deployed commits.
# The ladder writes each red row into it; this script writes its own steps that
# went red, the rows it could not run and why, the work it started and does not
# wait for, and when it reached each mark. `finish` renders it, prints its path
# and ends the deploy with its verdict.
KINU_DEPLOY_REPORT=""
KINU_REDS=0
report() {
  bun "$KINU_ROOT/scripts/deploy-report.ts" "$1" "$KINU_DEPLOY_REPORT" "${@:2}"
}
mark() {
  report mark "$1" "$SECONDS"
}
step_red() {
  KINU_REDS=1
  echo -e "${RED}❌ $3${NC}"
  report note "$1" "$2" "$3"
}
finish() {
  mark end
  report render || KINU_REDS=1
  exit "$KINU_REDS"
}

echo -e "${BOLD}Kinu Deploy Pipeline${NC}"
echo "========================"
echo "Environment:  $KINU_ENV"
echo "Kinu root: $KINU_ROOT"
echo "Account:      $CLOUDFLARE_ACCOUNT_ID"
echo "Build sha:    $KINU_SHA"
# The tiers' scripted model answers only this bearer (Step 4b); without it every
# post-publish tier would fail after the upload, so it is asked for before any.
# Trimmed here, once: the Worker's secret and the key the tiers store are both
# this exported value, so whitespace in a key file cannot split them.
KINU_SCRIPTED_MODEL_KEY="$(printf '%s' "${KINU_SCRIPTED_MODEL_KEY:-}" | tr -d '[:space:]')"
export KINU_SCRIPTED_MODEL_KEY
if [ "$KINU_GATES_ONLY" != "1" ] && [ -z "$KINU_SCRIPTED_MODEL_KEY" ]; then
  echo -e "${RED}KINU_SCRIPTED_MODEL_KEY is not set: the tiers' scripted model answers only that bearer. Nothing was deployed.${NC}"
  exit 1
fi
if [ -n "$(git -C "$KINU_ROOT" status --porcelain 2>/dev/null)" ]; then
  echo -e "${RED}Worktree is dirty — build $KINU_SHA would not describe the bytes being published.${NC}"
  echo "Commit the verified tree before deploying."
  exit 1
fi
if [ "$KINU_PROMOTE" = "1" ]; then KINU_MODE=promote
elif [ "$KINU_GATES_ONLY" = "1" ]; then KINU_MODE=gates-only
elif [ "$KINU_RESET" = "1" ]; then KINU_MODE=reset
else KINU_MODE=deploy
fi
KINU_DEPLOY_REPORT="$(bun "$KINU_ROOT/scripts/deploy-report.ts" open "$KINU_ENV" "$KINU_MODE" "$KINU_SHA")" \
  || { echo -e "${RED}❌ this deploy's report directory could not be opened, so nothing could report on it. Nothing was deployed.${NC}"; exit 1; }
export KINU_DEPLOY_REPORT
echo "Report:       $KINU_DEPLOY_REPORT"
echo ""
# Preflight FIRST — before the tool checks, before `bun install`, before any
# gate. Its whole job is to refuse to report on a poisoned environment, so it
# has to run before anything that could be poisoned: an exhausted $TMPDIR inode
# table surfaces later as a 5-second timeout inside an unrelated filesystem
# test, which reads as a code regression and is not one. It repairs nothing;
# `--reclaim` is explicit and separate. A red here ends the deploy: every later
# verdict presumes the machine it checks.
stop_phase preflight
mark preflight

KINU_CI_RUN="$KINU_DEPLOY_REPORT/ci-run.json"
if [ "$KINU_PROMOTE" != "1" ]; then
  KINU_CI_SHA="$(git -C "$KINU_ROOT" rev-parse HEAD)"
  bun "$KINU_ROOT/scripts/ladder.ts" --ci-find="$KINU_CI_SHA" --ci-run="$KINU_CI_RUN" || { step_red ci "push-CI" "No push-CI proof for $KINU_CI_SHA. Push the branch holding this clean revision; nothing was built or uploaded."; finish; }
fi

# ── Pre-flight: verify npx + wrangler auth ───────────────────────
if ! command -v npx >/dev/null 2>&1; then
  step_red preflight "npx" "npx not found — install Node.js"
  finish
fi
if ! npx wrangler whoami >/dev/null 2>&1; then
  report note preflight "wrangler auth" "Wrangler is not authenticated, so nothing could be uploaded."
  KINU_REDS=1
  echo -e "${RED}Wrangler is not authenticated. Nothing was deployed.${NC}"
  echo "  On your own machine:  npx wrangler login"
  echo "  In CI: set the CLOUDFLARE_API_TOKEN secret. Cloudflare dashboard →"
  echo "  My Profile → API Tokens → Create Token → Edit Cloudflare Workers,"
  echo "  then add Workers R2 Storage: Edit, Workers KV Storage: Edit and"
  echo "  Vectorize: Edit, scoped to account $CLOUDFLARE_ACCOUNT_ID."
  echo "  Only a person with dashboard access can mint it; this script will not"
  echo "  deploy part of the way without it."
  finish
fi

# The strict gates need the locked dependency graph, but dependency setup is
# not a build or publish operation. Do it before verification when a checkout
# has not been prepared yet; never let deploy update the lockfile.
if [ ! -d "$KINU_ROOT/node_modules" ]; then
  echo "Installing Kinu dependencies (root node_modules missing)..."
  bun install --frozen-lockfile \
    || { step_red preflight "bun install" "bun install --frozen-lockfile failed, so no gate could run."; finish; }
fi

# ── Step 1: The upload gates ─────────────────────────────────────
echo -e "${BOLD}Step 1: The upload gates${NC}"
if [ "$KINU_BOOTSTRAP" = "1" ]; then
  echo -e "${BOLD}BOOTSTRAP: the pre-deploy infrastructure phase will DEFER resources this deploy creates.${NC}"
  echo "  Deferred: only what the manifest marks \`wrangler-deploy\` — Durable Object namespaces,"
  echo "            container applications, routes, crons, inert bindings, the Worker itself."
  echo "  Still refused before the upload: every secret, KV namespace, R2 bucket, Vectorize index,"
  echo "            DNS record and AI Gateway, and any lookup that merely failed."
  echo "  Step 5 re-checks all of it after the upload with no tolerance, and fails this deploy if"
  echo "            anything deferred did not appear."
fi

if [ "$KINU_PROMOTE" = "1" ]; then
  # THE RECORD IS THE SOURCE GATE. Staging's deploy of HEAD wrote it after every
  # phase there passed, the plan's every gate and every tier, and staging must
  # still be serving that build. Without both, nothing is built.
  bun "$KINU_ROOT/scripts/promote.ts" check \
    || { step_red promote "staging's record" "staging has not verified $KINU_SHA with every phase green; deploy it to staging first."; finish; }
fi

# THE ONLY GATES THAT HOLD THE UPLOAD, and the only phase besides the preflight
# whose red ends the deploy: the account gate, which proves the ACCOUNT is
# deployable for the environment and in the phase KINU_INFRA_ENVIRONMENT and
# KINU_INFRA_PHASE name (`full` normally, `bootstrap` under `--bootstrap`),
# travelling in the environment so the gate's command stays one string in the
# plan; and the secret scan, since a credential in a published asset cannot be
# withdrawn. Every other gate's red is recoverable on staging, so it runs after
# the upload and gates the promotion instead.
if [ "$KINU_PROMOTE" != "1" ]; then
  # CI's upload proof and the local account check are independent; both still hold every upload.
  run_phase upload &
  KINU_UPLOAD_PID=$!
  bun "$KINU_ROOT/scripts/ladder.ts" --ci-upload --ci-run="$KINU_CI_RUN" || KINU_REDS=1
  wait "$KINU_UPLOAD_PID" || KINU_REDS=1
  if [ "$KINU_REDS" != "0" ]; then
    echo -e "${RED}The upload checks are red, so nothing was built or uploaded.${NC}"
    finish
  fi
else
  stop_phase upload
fi
mark upload

if [ "$KINU_GATES_ONLY" = "1" ]; then
  run_phase source
  mark source
  bun "$KINU_ROOT/scripts/ladder.ts" --ci-await --ci-run="$KINU_CI_RUN" || KINU_REDS=1
  mark ci
  echo "Gates only: stopping before the build, as asked."
  finish
fi

# ── Steps 2 to 4: build, upload, and prove the deployment serves it ──
#
# `publish_build` returns non-zero at the first step that went red, with
# KINU_PUBLISH_FINDING saying which and why. After that nothing that reads the
# deployment can test this build, while every local gate still can: the deploy
# records the step, skips only the rows that read the deployment, and runs the
# remaining local wave to the end, then imports CI's verdict, including the isolated hammer (L23).
KINU_PUBLISH_FINDING=""
publish_red() {
  KINU_PUBLISH_FINDING="$1"
  echo -e "${RED}❌ $1${NC}"
}
smoke_red() {
  echo -e "${RED}❌ $1${NC}"
  KINU_SMOKE_FINDINGS+=("$1")
  SMOKE_FAIL=1
}

publish_build() {
echo ""
echo -e "${BOLD}Step 2: Building Kinu for $KINU_ENV${NC}"

# A staging deploy is about to replace what staging serves for HEAD, so HEAD's
# record goes first: until this run's phases all pass and write it again, nothing
# it publishes, and nothing a red run of it leaves behind, can be promoted.
if [ "$KINU_ENV" = "staging" ]; then
  bun "$KINU_ROOT/scripts/promote.ts" forget \
    || { publish_red "$KINU_SHA's record on staging could not be withdrawn, so this deploy will not replace what it verified"; return 1; }
fi

cd "$KINU_ROOT/packages/cf-backend" || { publish_red "cannot cd to cf-backend"; return 1; }

# Build the client bundle into dist/client (used by wrangler's assets directive),
# for this deploy's environment. Production is the config's top level, so its
# build names none.
KINU_BUILD_ENV=()
if [ "$KINU_ENV" = "staging" ]; then KINU_BUILD_ENV=(CLOUDFLARE_ENV=staging); fi
if [ -f ./node_modules/.bin/vite ]; then
  echo "Running: vite build"
  env "${KINU_BUILD_ENV[@]}" ./node_modules/.bin/vite build || { publish_red "vite build failed"; return 1; }
else
  echo "Running: bunx vite build"
  env "${KINU_BUILD_ENV[@]}" bunx vite build || { publish_red "vite build failed"; return 1; }
fi

# The Worker and origin this build is FOR, read from the config the Vite plugin
# flattened for it, which is the one `wrangler deploy` publishes (see header).
# A build of the other environment is refused before anything leaves this box.
KINU_BUILT_CONFIG="$KINU_ROOT/packages/cf-backend/dist/kinu/wrangler.json"
if [ ! -s "$KINU_BUILT_CONFIG" ]; then
  publish_red "Missing build output: $KINU_BUILT_CONFIG"
  return 1
fi
KINU_BUILT_ENV="$(json_field targetEnvironment < "$KINU_BUILT_CONFIG")"
KINU_WORKER="$(json_field name < "$KINU_BUILT_CONFIG")"
KINU_URL="$(json_field vars.CLI_PUBLIC_ORIGIN < "$KINU_BUILT_CONFIG")/"
if [ "${KINU_BUILT_ENV:-production}" != "$KINU_ENV" ] || [ -z "$KINU_WORKER" ] || [ "$KINU_URL" = "/" ]; then
  publish_red "$KINU_BUILT_CONFIG is ${KINU_WORKER:-no Worker} for ${KINU_BUILT_ENV:-production} at '${KINU_URL%/}', not a $KINU_ENV build."
  return 1
fi
echo -e "${GREEN}✅ Built $KINU_WORKER, served at $KINU_URL${NC}"

KINU_RELEASE_VERSION="$(bun -e '
  const manifest = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(manifest.version.split("+")[0]);
' "$KINU_ROOT/packages/cli/package.json")+$KINU_SHA"
KINU_WORKER_ARTIFACT="kinu-worker-$KINU_RELEASE_VERSION.tar.gz"
KINU_WORKER_ARTIFACT_PATH="$KINU_ROOT/packages/cf-backend/dist/worker-release/$KINU_WORKER_ARTIFACT"
if [ "$KINU_PROMOTE" = "1" ]; then
  # STAGING'S DOWNLOADS, NOT A REBUILD. promote.ts proves this build is the
  # artifact staging verified, then writes staging's signed stamp, release
  # manifest and every download the stamp signs into the downloads directory,
  # each checked against the stamp, and copies the worker release tarball into
  # production's bucket: what a user downloads is what staging's tiers ran.
  echo "Adopting staging's downloads and worker release artifact"
  bun "$KINU_ROOT/scripts/promote.ts" adopt \
    || { publish_red "this build is not the one staging verified, or its downloads did not check out"; return 1; }
else
  # The worker release artifact, BEFORE the CLI distribution: `build-cli-dist.sh`
  # signs every artifact it finds in the downloads directory, so writing this one
  # first is what puts its checksum in `kinu-version.json` beside the CLI's. The
  # self-deploy flow reads `release.json` and verifies the tarball against the
  # `.sha256` published beside it, which is integrity and not a signature; the
  # smoke check below is where that sidecar is held against the signed manifest,
  # so a drift between them fails this deploy (docs/SELF-DEPLOY.md).
  echo "Building the worker release artifact ($KINU_RELEASE_VERSION)"
  bun "$KINU_ROOT/scripts/build-worker-release.ts" "$KINU_RELEASE_VERSION" "$KINU_SHA" \
    || { publish_red "worker release artifact build failed"; return 1; }

  echo "Building the CLI distribution"
  bash "$KINU_ROOT/scripts/build-cli-dist.sh" || { publish_red "CLI distribution build failed"; return 1; }
fi

# No deploy may ship without every CLI download asset sitting in the
# directory wrangler publishes. A deploy missing one bricks every fresh install
# and update on the platform it belongs to.
KINU_CLI_ARTIFACTS=(kinu-runtime-cpython.tar.gz)
for platform in darwin-arm64 darwin-x64 linux-arm64 linux-x64; do
  KINU_CLI_ARTIFACTS+=("kinu-cli-$platform.tar.gz")
done
for file in kinu-version.json release.json "$KINU_WORKER_ARTIFACT.sha256" \
  "${KINU_CLI_ARTIFACTS[@]}" "${KINU_CLI_ARTIFACTS[@]/%/.sha256}"; do
  if [ ! -s "$KINU_ASSETS_DIR/downloads/$file" ]; then
    publish_red "Missing build output: $KINU_ASSETS_DIR/downloads/$file"
    return 1
  fi
done
echo -e "${GREEN}✅ CLI and worker release assets staged in $KINU_ASSETS_DIR/downloads${NC}"

# The worker artifact is larger than Cloudflare's 25 MiB per-file asset limit,
# so it is published into R2 and streamed by the Worker instead. BEFORE the
# deploy, never after: the release.json this deploy publishes names this
# artifact, and a manifest that names an object nobody uploaded yet sends every
# self-deploy run at a 404. Into this build's own releases bucket; a promotion
# copied staging's there above.
if [ "$KINU_PROMOTE" != "1" ]; then
  if [ ! -s "$KINU_WORKER_ARTIFACT_PATH" ]; then
    publish_red "Missing build output: $KINU_WORKER_ARTIFACT_PATH"
    return 1
  fi
  KINU_RELEASES_BUCKET="$(bun -e '
    const config = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    process.stdout.write(config.r2_buckets?.find((bucket) => bucket.binding === "RELEASES_BUCKET")?.bucket_name ?? "");
  ' "$KINU_BUILT_CONFIG")"
  if [ -z "$KINU_RELEASES_BUCKET" ]; then
    publish_red "$KINU_BUILT_CONFIG binds no RELEASES_BUCKET"
    return 1
  fi
  echo "Publishing $KINU_WORKER_ARTIFACT to r2://$KINU_RELEASES_BUCKET"
  npx wrangler r2 object put "$KINU_RELEASES_BUCKET/$KINU_WORKER_ARTIFACT" \
    --file "$KINU_WORKER_ARTIFACT_PATH" --content-type application/gzip --remote \
    || { publish_red "uploading the worker release artifact failed"; return 1; }
  npx wrangler r2 object put "$KINU_RELEASES_BUCKET/$KINU_WORKER_ARTIFACT.sha256" \
    --file "$KINU_ASSETS_DIR/downloads/$KINU_WORKER_ARTIFACT.sha256" --content-type text/plain --remote \
    || { publish_red "uploading the worker release checksum failed"; return 1; }
  echo -e "${GREEN}✅ Worker release artifact published to R2${NC}"
fi

# The devbox tools tarball the image's golden snapshot installs (D65) must be in the
# store bucket before a box can start: refused by name, never built here.
KINU_BACKUP_BUCKET="$(bun -e '
  const config = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(config.r2_buckets?.find((bucket) => bucket.binding === "BACKUP_BUCKET")?.bucket_name ?? "");
' "$KINU_BUILT_CONFIG")"
if [ -z "$KINU_BACKUP_BUCKET" ]; then
  publish_red "$KINU_BUILT_CONFIG binds no BACKUP_BUCKET"
  return 1
fi
bun "$KINU_ROOT/scripts/devbox-tools.ts" check "$KINU_BACKUP_BUCKET" \
  || { publish_red "the devbox tools tarball is missing from $KINU_BACKUP_BUCKET; publish it as the line above says"; return 1; }

# ── Step 2b: The reset ────────────────────────────────────────
# After the build, so a red gate or a failed build deletes nothing; the upload
# below is then the genesis deploy.
KINU_RECORD_ARGS=()
if [ "$KINU_RESET" = "1" ]; then
  echo ""
  echo -e "${BOLD}Step 2b: Resetting $KINU_WORKER${NC}"
  KINU_RESET_RECORD="$(mktemp -t kinu-reset.XXXXXX.json)"
  bun "$KINU_ROOT/scripts/reset.ts" wipe "$KINU_ENV" "$KINU_RESET_RECORD" \
    || { publish_red "the reset failed; its lines in the deploy's output say what it deleted before it stopped, and a deploy with --reset finishes it from its record"; return 1; }
  KINU_RECORD_ARGS=("$KINU_RESET_RECORD")
fi

# ── Step 3: Deploy Kinu ───────────────────────────────────────
echo ""
echo -e "${BOLD}Step 3: Deploying $KINU_WORKER${NC}"
KINU_DEPLOY_LOG="$(mktemp -t kinu-deploy.XXXXXX.log)"
echo ""
echo "Running: npx wrangler deploy ${KINU_WRANGLER_ARGS[*]} (log → $KINU_DEPLOY_LOG)"
echo ""
if npx wrangler deploy "${KINU_WRANGLER_ARGS[@]}" 2>&1 | tee "$KINU_DEPLOY_LOG"; then
  DEPLOY_PUBLISHED=1
  # From when the version could answer: the start of what Step 5b reads.
  KINU_LIVE_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo ""
  echo -e "${GREEN}Kinu deploy succeeded.${NC}"
else
  echo ""
  publish_red "wrangler deploy failed; its log is $KINU_DEPLOY_LOG"
  return 1
fi

KINU_VERSION="$(grep -oE 'Version ID:[[:space:]]*[a-f0-9-]+' "$KINU_DEPLOY_LOG" | head -1 | awk '{print $NF}')"

# Verify wrangler echoed the workspace container's binding.
if grep -qE 'KinuDevbox' "$KINU_DEPLOY_LOG"; then
  echo -e "${GREEN}✅ Kinu bound KinuDevbox (Durable Object + container)${NC}"
else
  publish_red "wrangler output did not mention the KinuDevbox binding"
  echo "   Check that packages/cf-backend/wrangler.jsonc includes:"
  echo "     { \"class_name\": \"KinuDevbox\", \"name\": \"KinuDevbox\" }"
  echo "   and a \"containers\" block."
  return 1
fi

# Wrangler names the assets directory it actually read. Assert it is the one we
# staged the downloads into, so a future config or plugin change that moves the
# assets dir fails here instead of silently shipping an assetless site.
DEPLOYED_ASSETS_DIR="$(grep -oE 'Read [0-9]+ files from the assets directory .*' "$KINU_DEPLOY_LOG" | head -1 | sed 's|.*assets directory ||' | tr -d '\r')"
if [ "$DEPLOYED_ASSETS_DIR" = "$KINU_ASSETS_DIR" ]; then
  echo -e "${GREEN}✅ Wrangler published assets from $KINU_ASSETS_DIR${NC}"
else
  publish_red "Wrangler published assets from '${DEPLOYED_ASSETS_DIR:-<not reported>}', not $KINU_ASSETS_DIR"
  echo "   Expected: $KINU_ASSETS_DIR (the directory the CLI downloads were staged into)."
  echo "   Reconcile packages/cf-backend/wrangler.jsonc, the vite plugin's"
  echo "   .wrangler/deploy/config.json redirect, and this script's header."
  return 1
fi

cd "$KINU_ROOT" || { publish_red "cannot cd to $KINU_ROOT"; return 1; }

# ── Step 4: Post-deploy smoke test ───────────────────────────────
echo ""
echo -e "${BOLD}Step 4: Post-deploy smoke test${NC}"
echo "Waiting 10s for deployments to propagate..."
sleep 10

SMOKE_FAIL=0
KINU_SMOKE_FINDINGS=()

# The deployment's own route.
LIVE_STATUS=$(curl -so /dev/null -w '%{http_code}' --max-time 15 "$KINU_URL" 2>/dev/null || echo "000")
if [ "$LIVE_STATUS" = "200" ]; then
  echo -e "${GREEN}✅ Kinu live site returns 200${NC} ($KINU_URL)"
else
  smoke_red "Kinu live site returns $LIVE_STATUS ($KINU_URL)"
fi

if [ "$LIVE_STATUS" = "200" ]; then
  LIVE_HTML=$(curl -fsSL --max-time 15 "$KINU_URL" 2>/dev/null || true)
  if grep -q "id=\"$KINU_APP_ROOT\"" <<< "$LIVE_HTML" \
    && grep -q '<script type="module"' <<< "$LIVE_HTML"; then
    echo -e "${GREEN}✅ Kinu live site serves the application shell${NC}"
  else
    smoke_red "Kinu live site returned 200 without the application shell"
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
  smoke_red "/api/health build stamp is '${HEALTH_SHA:-<none>}', expected '$KINU_SHA'"
  echo "   Body: ${HEALTH_JSON:0:200}"
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
  smoke_red "Published kinu-version.json sha is '${VERSION_SHA:-<unparseable>}', expected '$KINU_SHA'"
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
  smoke_red "release.json sha is '${RELEASE_SHA:-<unparseable>}' (expected '$KINU_SHA'); worker artifact checksum '${RELEASE_ARTIFACT_SHA:-<none>}' vs signed '${SIGNED_ARTIFACT_SHA:-<none>}'; artifact route answered ${ARTIFACT_STATUS:-<none>}"
fi

CLI_SHIM=$(curl -s --max-time 15 "${KINU_URL}downloads/kinu" 2>/dev/null)
if echo "$CLI_SHIM" | grep -q 'downloads/kinu-cli-' && ! echo "$CLI_SHIM" | grep -q 'github.com'; then
  echo -e "${GREEN}✅ Kinu CLI launcher uses the deployed build artifacts${NC}"
else
  smoke_red "Kinu CLI launcher is not using the deployed build artifacts"
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
    smoke_red "$artifact is missing, unreadable, or carries no $MEMBER"
    continue
  fi
  PUBLISHED_SHA="$(curl -fsSL --max-time 15 "${KINU_URL}downloads/$artifact.sha256" 2>/dev/null | awk '{print $1}')"
  ACTUAL_SHA="$(sha256sum "$CLI_ARTIFACT_TMP" | awk '{print $1}')"
  if [ -n "$PUBLISHED_SHA" ] && [ "$PUBLISHED_SHA" = "$ACTUAL_SHA" ]; then
    echo -e "${GREEN}✅ $artifact downloads and matches its published .sha256${NC}"
  else
    smoke_red "$artifact checksum is missing or does not match the download"
  fi
done
rm -f "$CLI_ARTIFACT_TMP" "$CLI_ARTIFACT_LIST"

# Every name the deployment serves, over a certificate that verifies, before anything drives it. The upload returns
# before the edge holds a certificate for each new name: staging's first deploy started its tiers while the one for
# *.staging.kinu.run was still being issued, and a share case failed on the handshake (scripts/edge-settled.ts).
# A checked condition with a bound, never a length of time.
if bun scripts/edge-settled.ts "$KINU_ENV"; then
  echo -e "${GREEN}✅ Every name $KINU_WORKER serves answers over verified TLS${NC}"
else
  smoke_red "A name $KINU_WORKER serves never answered over verified TLS; the lines above name it"
fi

if [ "$SMOKE_FAIL" -ne 0 ]; then
  echo ""
  publish_red "the smoke test failed: $(IFS=';'; printf '%s' "${KINU_SMOKE_FINDINGS[*]}")"
  return 1
fi
}

KINU_SERVING=0
if publish_build; then
  KINU_SERVING=1
  mark live
else
  KINU_REDS=1
  report note publish "build, upload and smoke" "$KINU_PUBLISH_FINDING"
fi
cd "$KINU_ROOT" || { step_red publish "the checkout" "cannot cd to $KINU_ROOT"; finish; }

# ── Step 4b: The tiers' scripted model ────────────────────────────────────
#
# The product tiers below check the product, not a model's choices: their
# workspaces run on the scripted model (scripts/tier-model.ts), served by its own
# Worker at `scripted-model.kinu.run`. Published every run, from this tree,
# because its script is what the tiers' assertions were written against.
#
# TWO PATHS REACH THAT HOST, and its config holds one entry for each
# (scripts/scripted-model-worker.jsonc). A hosted turn calls the model from the
# workspace's Durable Object, whose fetch runs the zone's routes first, as a
# request from outside does: the Worker's own route, `scripted-model.kinu.run/*`,
# beats production's `*.kinu.run/*` there. A fetch the product's Worker makes
# from its request context, the provider proxy's, skips same-zone routes and goes
# to the host's origin: the Custom Domain makes this Worker that origin, the one
# way a Worker of this account is fetchable so without a service binding
# (Workers fetch docs: otherwise error 1042). The tier proves both before its
# cases (scripts/scripted-tier.ts): one hosted turn must come back with the
# script's own answer, and the proxy must list the model.
#
# Its route is public, so it answers only the bearer KINU_SCRIPTED_MODEL_KEY
# holds: uploaded with it as SCRIPTED_MODEL_KEY through a 0600 file this step
# removes, never on an argv or in the log, and stored by the tiers as the
# scripted account's API key.
#
# The rows that read the deployment run only against a deployment serving this
# build, on the model their assertions were written against: KINU_TIERS_WHY
# says why not, and those rows are then named in the report as not run.
KINU_TIERS_WHY=""
if [ "$KINU_SERVING" != "1" ]; then
  KINU_TIERS_WHY="$KINU_ENV does not serve this build: $KINU_PUBLISH_FINDING"
else
  echo ""
  echo -e "${BOLD}Step 4b: Publishing the tiers' scripted model${NC}"
  KINU_SCRIPTED_SECRETS="$(umask 077 && mktemp -t kinu-scripted-secrets.XXXXXX.json)"
  bun -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ SCRIPTED_MODEL_KEY: process.env.KINU_SCRIPTED_MODEL_KEY }))' "$KINU_SCRIPTED_SECRETS"
  bunx wrangler deploy -c scripts/scripted-model-worker.jsonc --secrets-file "$KINU_SCRIPTED_SECRETS"
  KINU_SCRIPTED_PUBLISHED=$?
  rm -f "$KINU_SCRIPTED_SECRETS"
  if [ "$KINU_SCRIPTED_PUBLISHED" != "0" ]; then
    step_red publish "the tiers' scripted model" "publishing the scripted model Worker failed"
    KINU_TIERS_WHY="the tiers' scripted model Worker did not publish"
  fi
fi

# ── Step 4c: The tiers against the deployment, beside every local gate ──────
#
# AGAINST THE DEPLOYMENT THIS RUN PUBLISHED, every deploy: staging's, and
# production's again when a build is promoted. It acts as the eval service
# identity: `DEV_USER_EMAIL` names it in wrangler.jsonc and that deployment's
# own `DEV_IDENTITY_SECRET` is its whole authority, honoured only for a request
# presenting the secret and refused by the admin gate regardless
# (control-plane/admin-caller.ts). Every workspace a case creates carries the
# eval prefix and is torn down by the run.
#
# WHY IT EXISTS. Every local gate runs on this tree, over inputs its author
# wrote. The owner found product defects by hand that
# those gates never touched — a crafted tool that would not run, an Approve
# button that re-ticked every box, two machines flapping on one slot, Enter not
# sending in the TUI, and on 2026-09-10 every workspace open failing on a query
# no unit test ran — each with a green test, because each test exercised what
# its author wrote instead of what a user brings. On 2026-09-10 this tier was
# gated to a staging deploy that never happened, so production shipped without
# it four times in one day. It is unconditional now.
#
# So this tier drives the DEPLOYED product the way a person does: a fresh
# workspace per case over the public REST, the scripted model (Step 4b) on the
# deployment's own provider path, a real click in Chrome, two real daemons, real
# pty bytes. One case per defect, hard assertions only, red on any of them.
#
# AFTER THE SMOKE GATE, because the smoke gate answers a cheaper question first:
# did the deploy land at all. Running this against an origin that is not serving
# would report six product failures for one deployment failure.
#
# ONE WAVE WITH THE SOURCE GATES, on staging: every gate the plan marks
# `post-publish` and every gate it marks `source`, admitted together by the
# ladder's wave. The tiers mostly wait on the network and start first; the local
# gates fill the box beside them under its measured caps; a tier's Chrome takes
# its own lane (`deployment-browser`), apart from the local browser rows'. Each
# runs to its end whatever the other side does, so the report holds every red of
# both (L18). A promotion runs only the tiers, against production.
#
# The tiers take the deployment from these two, and its secret from the
# variable `evalWebIdentityEnv` names for its origin
# (packages/test-utils/src/eval-identity.ts): each deployment has its own.
export KINU_EVAL_ORIGIN="${KINU_URL%/}"
export KINU_ORIGIN="${KINU_URL%/}"

# THE STATISTICS, on GitHub (L19). scripts/evals-dispatch.ts starts
# .github/workflows/evals.yml for this build from the branch on GitHub that
# holds it: every eval task ten times on staging, which must be serving this
# build, and on production, the baseline, and its Verdict job fails on a
# regression between the two. Not awaited: the report names the run and the
# record keeps its id, since a promotion waits for its verdict.
KINU_EVALS_RUN=""
KINU_EVALS_URL=""
KINU_EVALS_WHY=""
dispatch_evals() {
  local answer branch
  if ! answer="$(bun "$KINU_ROOT/scripts/evals-dispatch.ts" "$KINU_SHA")"; then
    KINU_EVALS_WHY="$answer"
    return 1
  fi
  read -r KINU_EVALS_RUN KINU_EVALS_URL branch <<<"$answer"
  report dispatched "the evals of $KINU_SHA from $branch, every task ten times on staging against production" "$KINU_EVALS_URL"
}

if [ "$KINU_PROMOTE" = "1" ]; then
  if [ -z "$KINU_TIERS_WHY" ]; then run_phase post-publish; else skip_phase post-publish "$KINU_TIERS_WHY"; fi
  mark tiers
else
  # Started first, so its hours run while the wave runs here. Without its run
  # this build has no verdict to be promoted on, so a failed dispatch is a red.
  if [ "$KINU_SERVING" = "1" ]; then
    dispatch_evals \
      || step_red evals "the evals" "evals.yml was not dispatched for $KINU_SHA: $KINU_EVALS_WHY; this build has no eval verdict to be promoted on"
  fi
  if [ -z "$KINU_TIERS_WHY" ]; then
    run_phase post-publish,source
  else
    skip_phase post-publish "$KINU_TIERS_WHY"
    run_phase source
  fi
  mark wave

  # CI's source shards and isolated hammer ran concurrently with this build and the live tiers. Their exact-SHA
  # verdicts are part of this deploy: no local repeat, no retry of a red, no record without the complete proof.
  bun "$KINU_ROOT/scripts/ladder.ts" --ci-await --ci-run="$KINU_CI_RUN" || KINU_REDS=1
  mark ci
fi

# ── Step 5: Post-deploy infrastructure verification ──────────────
#
# UNCONDITIONAL AND RELAXED BY NOTHING. This is the other
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
#
# Whenever the upload happened, whatever the smoke test said: the version is
# live either way, and a red here is a red of the deploy, which then writes no
# record.
if [ "${DEPLOY_PUBLISHED:-0}" = "1" ]; then
  echo ""
  echo -e "${BOLD}Step 5: Post-deploy infrastructure verification${NC}"
  if bun scripts/infra-verify.ts --phase=post-deploy; then
    echo -e "${GREEN}✅ Every declared resource exists and is bound${NC}"
  else
    echo ""
    step_red publish "post-deploy infrastructure" "a resource the version $KINU_ENV serves declares is not in its account; the verification's findings in the deploy's output name each one"
  fi
fi

# ── Step 5b: What the version did on staging ─────────────────────
#
# Every red above is a test's. These are staging's own signals for the version
# this deploy published, read through `scripts/prod-logs.ts version` once the
# tiers and the eval pass have driven it, with zero users the traffic being our
# own: an invocation that ended in an uncaught exception or that the platform
# ended, a terminal effect that failed or was left owed, an object woken as
# often as the product calls a wake loop, by startups or by alarms. Each is a
# red of this deploy whatever its tests said, in the report under `telemetry`
# (L18); so is telemetry it cannot read.
if [ "$KINU_ENV" = "staging" ] && [ "${DEPLOY_PUBLISHED:-0}" = "1" ] && [ -n "$KINU_VERSION" ]; then
  echo ""
  echo -e "${BOLD}Step 5b: What version $KINU_VERSION did on staging${NC}"
  bun "$KINU_ROOT/scripts/prod-logs.ts" version "$KINU_VERSION" --worker "$KINU_WORKER" --since "$KINU_LIVE_AT" || KINU_REDS=1
fi

# ── Step 6: The record, or the history and the evals ─────────────
#
# ON STAGING, THE RECORD: every phase and step above passed for this commit, so
# promotion may take it (scripts/promote.ts), once the evals run it names has a
# green verdict. It lists every download this run published by its hash, and
# promotion takes those bytes and no others. Written last and only on a deploy
# with no red anywhere, and a record that could not be written is a red of its
# own: without it this build can never be promoted.
#
# ON PRODUCTION, THE HISTORY: the build it took, which a later rollback may
# return to. Its evals ran before it was promoted, against the build production
# served then.
report budget "$SECONDS" || KINU_REDS=1
echo ""
if [ "$KINU_REDS" != "0" ] && [ "$KINU_ENV" = "staging" ]; then
  echo -e "${RED}❌ This deploy has a red, so no record is written: $KINU_SHA cannot be promoted.${NC}"
  finish
elif [ "$KINU_REDS" != "0" ]; then
  echo -e "${RED}❌ This promotion has a red, so production's history does not take $KINU_SHA.${NC}"
  finish
elif [ "$KINU_ENV" = "staging" ]; then
  echo -e "${BOLD}Step 6: Recording $KINU_SHA as verified on staging${NC}"
  bun "$KINU_ROOT/scripts/promote.ts" record "${KINU_VERSION:-unknown}" "$KINU_EVALS_RUN" "${KINU_RECORD_ARGS[@]}" \
    || { step_red record "the record" "the record was not written, so this build cannot be promoted"; finish; }
elif ! bun "$KINU_ROOT/scripts/promote.ts" promoted "${KINU_VERSION:-}" "${KINU_RECORD_ARGS[@]}"; then
  step_red record "production's history" "production serves $KINU_SHA, and its history does not hold it, so no rollback can return to it"
  finish
fi

# ── Step 7: Summary ──────────────────────────────────────────────
echo ""
echo -e "${BOLD}Deploy complete — $KINU_ENV.${NC}"
echo "================================="
echo "Kinu:  $KINU_URL ($KINU_WORKER)"
echo "          version ${KINU_VERSION:-unknown}"
echo "          build   $KINU_SHA"
echo ""
echo -e "${GREEN}✅ Kinu Worker deployed and verified.${NC}"
if [ "$KINU_ENV" = "staging" ]; then
  echo "Promote it to production with: bun run deploy --promote"
else
  echo "Return production to the build it took before with: bun run deploy --rollback"
fi
finish
