#!/usr/bin/env bash
# Kinu deploy pipeline — THE deploy path. Every deploy lands on staging,
# https://staging.kinu.run, and production, https://kinu.run, gets only a build
# staging verified.
#   bun run deploy              staging: the upload gates, the upload, then every tier
#                               and every local gate to its end, and the record
#   bun run deploy --promote    production: HEAD's build, as staging verified it
#   bun run deploy --promote --override "<owner's words>"
#                               production: HEAD's build as staging served it, which
#                               staging did not verify, kept as an UNVERIFIED override
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
# local-device executor routes. Pipeline: preflight → armada's exact-SHA CI
# verdict, its six hammer runs included (L25) → the upload gates (the account
# and the secret scan) → vite build → CLI source archive → wrangler deploy →
# smoke test → staging tiers beside the rows CI cannot host → the record.
# Promotion: the record → the upload gates →
# vite build → staging's downloads → wrangler deploy → smoke test → post-deploy
# tiers.
#
# REPORT-ALL (L18). Every phase after the upload runs to its end whatever goes
# red, so one deploy captures every failure, and the deploy ends with one report
# file, every red row with its finding, grouped by phase, whose path it prints
# (scripts/deploy-report.ts). Only the preflight, the precondition for any
# verdict, CI's verdict, and the two upload gates, whose damage the next deploy
# cannot undo, stop a deploy early. A red build on staging is fine: staging is the test
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
#   bun run deploy [--promote [--override "<owner's words>"] | --rollback] [--reset | --reset-tables] [--evals]
#   bash scripts/deploy.sh [--promote [--override "<owner's words>"]] [--reset | --reset-tables [--loss-override "<owner's words>"]] [--bootstrap] [--gates-only] [--evals]
#   bash scripts/deploy.sh --rollback
#
# `--evals` runs the real-model evals a deploy can start: on staging, the
# armada evals (five trials on staging against production) and the soak;
# on a promotion, the soak on production. Without it a deploy runs no real-model
# eval (the owner, 2026-10-08): evals run on a staging that has stopped moving,
# against production, and staging stays quiet while they run, so they are
# started by hand once it has (`bun scripts/evals-map.ts <sha> --post=<sha>`, then
# `bun scripts/promote.ts evals <out>` names the verdict in the build's record).
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
# `--override "<owner's words>"`, with `--promote` only, is the owner's call to
# promote a build staging did not verify. It never writes a verified record: it
# writes overrides/<sha>.json, HEAD's build as staging served it (the record
# staging's deploy writes once it serves a build, whatever goes red after),
# marked UNVERIFIED with the words and the reds staging's deploy left open. The
# promotion adopts that record with every digest and download check, the
# production table plan and its typed confirmation stay, and the report and
# production's history say "owner override, unverified".
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
# before anything runs. A reset whose build never uploaded is finished by the next deploy with `--reset`,
# whose pre-upload infrastructure phase defers exactly the rows that reset's record deleted.
#
# `--reset-tables` is how a release that reshapes tables ships: every object keeps its storage and drops exactly the
# tables this release changed (with the tables that refer to them), made anew empty, the first time the new build
# opens it (core state/schema-repair.ts). Before the upload it prints the plan, every table each class drops against
# the build the deployment serves, and stops on anything that would refuse; on production it asks for a typed
# confirmation naming every table it drops, and only then: a release that only adds tables drops nothing, and stage.sh
# deploys it unattended (`reset.ts schema-change`). Production refuses a plan that drops or retires a table holding user
# data, every table but those scripts/schema-loss.json names, unless `--loss-override "<owner's words>"` names it (the
# owner, 2026-10-21); a full `--reset` of production needs words naming every table, and a release retiring a class
# words naming it (`reset.ts retirements`, every deploy). The owner's other way, a one-time migration, has no mechanism
# yet: the repair drops every table it finds changed. After the upload, once this deploy's version answers, it opens every object
# once, so each resets itself before a user waits on it, prints what each did and writes each database's census
# (`scripts/reset.ts tables-plan` and `tables`, scripts/tables-reset.ts).
# Chosen per release; automatic only for one that only adds tables. Its record goes where a reset's does, and a rerun
# of the walk is harmless.
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
KINU_RESET_TABLES=0
# The owner's words for a production reset that loses user data, naming each table (scripts/schema-loss.json).
KINU_LOSS_OVERRIDE=""
KINU_LOSS_WORDS=0
KINU_EVALS=0
KINU_OVERRIDE=""
KINU_OVERRIDE_GIVEN=0
KINU_OVERRIDE_WORDS=0
for option in "$@"; do
  if [ "$KINU_OVERRIDE_WORDS" = "1" ]; then
    KINU_OVERRIDE="$option"
    KINU_OVERRIDE_WORDS=0
    continue
  fi
  if [ "$KINU_LOSS_WORDS" = "1" ]; then
    KINU_LOSS_OVERRIDE="$option"
    KINU_LOSS_WORDS=0
    continue
  fi
  case "$option" in
    --promote) KINU_PROMOTE=1 ;;
    --override) KINU_OVERRIDE_GIVEN=1; KINU_OVERRIDE_WORDS=1 ;;
    --rollback) KINU_ROLLBACK=1 ;;
    --bootstrap) KINU_BOOTSTRAP=1 ;;
    --gates-only) KINU_GATES_ONLY=1 ;;
    --reset) KINU_RESET=1 ;;
    --reset-tables) KINU_RESET_TABLES=1 ;;
    --loss-override) KINU_LOSS_WORDS=1 ;;
    --evals) KINU_EVALS=1 ;;
    *)
      echo -e "${RED}Unknown option '$option'.${NC}"
      echo "Usage: scripts/deploy.sh [--promote [--override \"<owner's words>\"]] [--reset | --reset-tables [--loss-override \"<owner's words>\"]] [--bootstrap] [--gates-only] [--evals] | --rollback"
      exit 2
      ;;
  esac
done
if [ -n "$KINU_LOSS_OVERRIDE" ] && [ "$KINU_RESET" != "1" ] && [ "$KINU_RESET_TABLES" != "1" ]; then
  echo -e "${RED}--loss-override names the tables a reset may lose, so it goes with --reset or --reset-tables only.${NC}"
  exit 2
fi
# reset.ts reads the owner's words where production's plan would lose user data (scripts/schema-loss.json).
export KINU_LOSS_OVERRIDE
if [ "$KINU_OVERRIDE_GIVEN" = "1" ] && [ -z "${KINU_OVERRIDE//[[:space:]]/}" ]; then
  echo -e "${RED}--override takes the owner's words: --override \"<why production takes a build staging did not verify>\".${NC}"
  exit 2
fi
if [ "$KINU_OVERRIDE_GIVEN" = "1" ] && [ "$KINU_PROMOTE" != "1" ]; then
  echo -e "${RED}--override overrides a promotion's record, so it goes with --promote only.${NC}"
  exit 2
fi
unset CLOUDFLARE_ENV
if [ "$KINU_ROLLBACK" = "1" ]; then
  if [ "$#" -ne 1 ]; then
    echo -e "${RED}--rollback takes no other option.${NC}"
    exit 2
  fi
  exec bun "$KINU_ROOT/scripts/promote.ts" rollback
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
# The reset record `gate:infra` reads, which only a --reset deploy carries: the gate defers before the upload exactly
# the rows that reset deleted (scripts/infra-verify.ts). ALWAYS ASSIGNED, like the phase: a record named by the shell
# that launched a deploy nobody asked to reset must never soften its gate.
export KINU_RESET_RECORD=""
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
  # The newest reset's record, which step 2b's reset then writes over: a reset whose build never uploaded, its
  # placeholder serving or its upload stopped short of a container application (2026-10-09), is finished by this
  # deploy, and the gate defers exactly what that record deleted.
  KINU_RESET_RECORD="$(mktemp -t kinu-reset.XXXXXX.json)"
  KINU_PENDING_RESET="$(bun "$KINU_ROOT/scripts/reset.ts" pending "$KINU_ENV" "$KINU_RESET_RECORD")" || exit 1
  if [ "$KINU_PENDING_RESET" != "none" ]; then
    echo -e "${BOLD}RESET: finishing $KINU_PENDING_RESET, whose build never uploaded; $KINU_ENV serves its placeholder.${NC}"
  else
    echo -e "${BOLD}RESET: this deploy deletes every Durable Object of $KINU_ENV, with all its storage:${NC}"
    bun "$KINU_ROOT/scripts/reset.ts" plan "$KINU_ENV" || exit 1
  fi
fi

# The plan is the candidate's lock against the build the deployment serves now, read before the upload replaces it;
# its record is kept here and published just before the upload, the first moment any object resets.
KINU_TABLES_RECORD=""
# A release that retires a class deletes its namespace and every row in it: production refuses one the owner's words
# (--loss-override) do not name (the owner, 2026-10-21; `reset.ts retirements`). A full --reset deletes every class anyway.
if [ "$KINU_RESET" != "1" ] && [ "$KINU_ROLLBACK" != "1" ] && [ "$KINU_GATES_ONLY" != "1" ]; then
  bun "$KINU_ROOT/scripts/reset.ts" retirements "$KINU_ENV" || exit 1
fi
if [ "$KINU_RESET_TABLES" = "1" ]; then
  if [ "$KINU_RESET" = "1" ] || [ "$KINU_GATES_ONLY" = "1" ]; then
    echo -e "${RED}--reset-tables keeps every object: --reset deletes them all anyway, and --gates-only stops before the build.${NC}"
    exit 2
  fi
  # Production's confirmation is typed at a terminal only for a plan that drops or retires a table (tables-plan asks it,
  # and refuses one with no terminal); a plan that only adds tables drops nothing, and ships unattended (stage.sh).
  KINU_TABLES_RECORD="$(mktemp -t kinu-tables.XXXXXX.json)"
  echo -e "${BOLD}TABLES: every object drops the tables this release changed, made anew empty, the first time the new build opens it. The plan:${NC}"
  bun "$KINU_ROOT/scripts/reset.ts" tables-plan "$KINU_ENV" "$KINU_TABLES_RECORD" || exit 1
elif [ "$KINU_RESET" != "1" ] && [ "$KINU_ROLLBACK" != "1" ] && [ "$KINU_GATES_ONLY" != "1" ]; then
  # A build that moves a class's stamp resets every database of that class at first contact, so it never ships
  # without its plan having been read.
  KINU_STAMPS_MOVED="$(bun "$KINU_ROOT/scripts/reset.ts" stamps "$KINU_ENV")"
  case $? in
    0) ;;
    3)
      echo -e "${RED}This build moves the stamp of: $KINU_STAMPS_MOVED. Every such database drops the tables this release changed when the new build first opens it: deploy with --reset-tables, which prints them first.${NC}"
      exit 1
      ;;
    *) exit 1 ;;
  esac
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
# The reset record the deploy's record names, once step 2b's reset has started.
KINU_RECORD_ARGS=()
cleanup() {
  local status=$?
  [ -n "$KINU_DEPLOY_LOG" ] && rm -f "$KINU_DEPLOY_LOG"
  if [ "$status" -ne 0 ] && [ "${DEPLOY_PUBLISHED:-0}" = "1" ] && [ "$KINU_PROMOTE" = "1" ]; then
    echo -e "${RED}Production serves this red promotion. Return it to the build it took before: bun run deploy --rollback${NC}"
  fi
  if [ "$status" -ne 0 ] && [ "${#KINU_RECORD_ARGS[@]}" -ne 0 ] && [ "${DEPLOY_PUBLISHED:-0}" != "1" ]; then
    echo -e "${RED}The reset ran and the build never uploaded: the reset lines above say what $KINU_WORKER serves and what was deleted. Deploy again with --reset: it finishes the reset from its record, or finds it done, and uploads the build.${NC}"
  fi
}
trap cleanup EXIT INT TERM

# The validator's reading in a wrangler upload's <log>: its startup in ms, `refused`, or `none`.
startup_reading() {
  if grep -qF 'Script startup exceeded CPU time limit' "$1"; then echo refused; return; fi
  local said
  said="$(grep -oE 'Worker Startup Time:[[:space:]]*[0-9]+' "$1" | head -1 | grep -oE '[0-9]+$')"
  echo "${said:-none}"
}

# A refused startup in a wrangler upload's <log>, in the platform's words and what its operator does: prints nothing for
# any other failure. The deploy never asks again by itself (L27); the validator reads one bundle in two modes, so its
# operator reruns the deploy (platform-catalog `worker.startup_ms`).
startup_refusal() {
  [ "$(startup_reading "$1")" = refused ] || return 0
  echo "Cloudflare refused this build's startup (code 10021): \"Script startup exceeded CPU time limit.\" Its validator reads one bundle in two modes, about 370 and 780-950 ms (platform-catalog worker.startup_ms), so run the same deploy again. "
}

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
# only what CI cannot host. The hammer runs in CI on armada, not after this wave (L25).
# 'soak', the real-model eval pass, starts once the deployment serves and is never awaited (L24).
# A gate's row in scripts/ladder.ts declares which, and why.
#
# `run_phase <phase[,phase]>` runs to the end and says whether anything went red;
# `stop_phase <phase>` ends the deploy on a red, for the phases nothing may pass:
# the preflight, the precondition for any verdict, and the upload gates.
run_phase() {
  bun scripts/ladder.ts "--deploy-phase=$1"
  phase_ended "$1" "$?"
}

# phase_ended <phase> <status>: a phase's runner ended with <status>, and a red is the deploy's.
phase_ended() {
  local status=$2
  if [ "$status" -eq 0 ]; then return 0; fi
  KINU_REDS=1
  echo -e "${RED}❌ the $1 phase failed (exit $status).${NC}"
  # A red the ladder found is in the report already. A runner that names none
  # ended without its verdict: a signal (the OOM killer's 137), or a crash, which
  # also exits 1 (staging e8837b133, 2026-10-22: an armada report the ladder could
  # not parse), so the exit status alone cannot say. The report says, and names the
  # phase when it holds none of its reds.
  if ! reported_red "$1"; then
    report note "$1" "the $1 phase's runner" "it ended with exit $status and no verdict of its own, so a row it had not reported on may be red and unnamed"
  fi
  return 1
}

stop_phase() {
  run_phase "$1" && return 0
  echo -e "${RED}❌ the $1 phase is red, so nothing was uploaded.${NC}"
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
# reported_red [phase[,phase]]: whether the report names a red (of those phases).
reported_red() {
  report holds-red "$@" >/dev/null 2>&1
}
# The build started beside the upload gates (see THE BUILD below), cancelled when the deploy ends before it is awaited.
KINU_BUILD_PID=""
# The source phase, started beside the build (see THE SOURCE PHASE below), cancelled when the deploy ends before it is
# joined.
KINU_SOURCE_PID=""
cancel_source() {
  [ -n "$KINU_SOURCE_PID" ] || return 0
  kill -TERM -- "-$KINU_SOURCE_PID" 2>/dev/null || kill -TERM "$KINU_SOURCE_PID" 2>/dev/null
  wait "$KINU_SOURCE_PID" 2>/dev/null
  KINU_SOURCE_PID=""
  echo "The source phase was cancelled; its output is $KINU_DEPLOY_REPORT/logs/source.log."
}
# join_source: the source phase's output and its verdict, once it ends.
join_source() {
  local status
  [ -n "$KINU_SOURCE_PID" ] || return 0
  wait "$KINU_SOURCE_PID"
  status=$?
  KINU_SOURCE_PID=""
  cat "$KINU_DEPLOY_REPORT/logs/source.log"
  phase_ended source "$status"
}
# The telemetry read of the published version (Step 5b), started once the traffic ends, beside the wave's last rows,
# and joined before the record; cancelled when the deploy ends before it is joined.
KINU_TELEMETRY_PID=""
start_telemetry() {
  [ "$KINU_ENV" = "staging" ] && [ "${DEPLOY_PUBLISHED:-0}" = "1" ] && [ -n "$KINU_VERSION" ] || return 0
  KINU_TRAFFIC_ENDED="$(report when traffic)" || KINU_TRAFFIC_ENDED=""
  setsid -w bun "$KINU_ROOT/scripts/prod-logs.ts" version "$KINU_VERSION" --worker "$KINU_WORKER" --since "$KINU_LIVE_AT" \
    ${KINU_TRAFFIC_ENDED:+--until "$KINU_TRAFFIC_ENDED"} --keep-windows "$KINU_ENV" >"$KINU_DEPLOY_REPORT/logs/telemetry.log" 2>&1 </dev/null &
  KINU_TELEMETRY_PID=$!
}
cancel_telemetry() {
  [ -n "$KINU_TELEMETRY_PID" ] || return 0
  kill -TERM -- "-$KINU_TELEMETRY_PID" 2>/dev/null || kill -TERM "$KINU_TELEMETRY_PID" 2>/dev/null
  wait "$KINU_TELEMETRY_PID" 2>/dev/null
  KINU_TELEMETRY_PID=""
}
# join_telemetry: the read's output, and a notice when it found something; it holds nothing.
join_telemetry() {
  local status
  [ -n "$KINU_TELEMETRY_PID" ] || return 0
  wait "$KINU_TELEMETRY_PID"
  status=$?
  KINU_TELEMETRY_PID=""
  cat "$KINU_DEPLOY_REPORT/logs/telemetry.log"
  [ "$status" = "0" ] || report notice telemetry "the telemetry read" "scripts/prod-logs.ts found something; each finding is a notice here, and none holds the deploy"
}
cancel_build() {
  [ -n "$KINU_BUILD_PID" ] || return 0
  kill -TERM -- "-$KINU_BUILD_PID" 2>/dev/null || kill -TERM "$KINU_BUILD_PID" 2>/dev/null
  wait "$KINU_BUILD_PID" 2>/dev/null
  KINU_BUILD_PID=""
  echo "The build on armada was cancelled; its output is $KINU_BUILD_LOG."
}
finish() {
  cancel_build
  cancel_source
  cancel_telemetry
  mark end
  # The verdict is the report's: a deploy red here names a red there, the budget's included once the end is marked, or
  # the report says that no step named one.
  if [ "$KINU_REDS" != "0" ] && ! reported_red; then
    report note deploy "the verdict" "this deploy went red and no step named a red in this report; its output says which step failed"
  fi
  report render || KINU_REDS=1
  # A red run that published keeps staging's built record, the one an owner's override names (promote.ts withdraw).
  if [ "$KINU_ENV" = "staging" ] && [ "${DEPLOY_PUBLISHED:-0}" = "1" ] && [ "$KINU_REDS" != "0" ]; then
    bun "$KINU_ROOT/scripts/promote.ts" withdraw || KINU_REDS=1
  fi
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

# CI's verdict for this exact revision, which armada stored when its push to next-rc or main was proved
# (L25): every row of it goes into the report, and a red or missing one ends the deploy before anything is built.
# A promotion takes staging's record instead, which only a deploy past this gate wrote.
if [ "$KINU_PROMOTE" != "1" ]; then
  KINU_CI_SHA="$(git -C "$KINU_ROOT" rev-parse HEAD)"
  bun "$KINU_ROOT/scripts/ladder.ts" --ci-verdict="$KINU_CI_SHA" || { step_red ci "armada CI" "armada has no green verdict for $KINU_CI_SHA, so nothing was built or uploaded."; finish; }
  mark ci
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
  if [ -n "$KINU_OVERRIDE" ]; then
    # THE OWNER'S WORD IN PLACE OF STAGING'S, and said so: never a verified record.
    bun "$KINU_ROOT/scripts/promote.ts" override "$KINU_OVERRIDE" \
      || { step_red promote "the owner override" "staging never served $KINU_SHA, or its reds are unknown here, so not even an override can name the build."; finish; }
    report notice promote "owner override, unverified" "$KINU_OVERRIDE"
  else
    bun "$KINU_ROOT/scripts/promote.ts" check \
      || { step_red promote "staging's record" "staging has not verified $KINU_SHA with every phase green; deploy it to staging first."; finish; }
  fi
fi

# THE BUILD, started beside the upload gates and awaited by `publish_build`: it runs on armada and writes only
# packages/cf-backend/dist, which neither gate reads (the account gate reads wrangler.jsonc and the account, the secret
# scan the refs), so their 31 s (staging, 2026-10-14) no longer come before it. A red there, or a deploy that ends
# before the build is awaited, cancels it (`cancel_build`), its armada job with it; nothing it made is published.
# Its own session, so the cancel reaches the armada run it started; its output is in the report's logs.
KINU_BUILD_LOG="$KINU_DEPLOY_REPORT/logs/build.log"
if [ "$KINU_GATES_ONLY" != "1" ]; then
  KINU_BUILD_ARGS=("$KINU_ENV" "$KINU_SHA")
  if [ "$KINU_PROMOTE" = "1" ]; then KINU_BUILD_ARGS+=(--promote); fi
  setsid -w bun "$KINU_ROOT/scripts/release-build.ts" "${KINU_BUILD_ARGS[@]}" >"$KINU_BUILD_LOG" 2>&1 </dev/null &
  KINU_BUILD_PID=$!
fi
# THE SOURCE PHASE, started beside the build and joined at the wave: no row of it reads the deployment (ladder.ts
# `readsDeployment`), so it waits out neither the upload gates nor the build and the publish. Its longest row, the
# devbox contracts (635-692 s), sets every staging deploy's wave: begun after the upload gates it ended at 726 s,
# their 52 s included (m1929a, staging 8f6ccf7fb, 2026-10-23). A red upload gate cancels it (finish). A promotion runs
# no source phase, and `--gates-only` runs it after the upload gates, below.
if [ "$KINU_PROMOTE" != "1" ] && [ "$KINU_GATES_ONLY" != "1" ]; then
  setsid -w bun scripts/ladder.ts --deploy-phase=source >"$KINU_DEPLOY_REPORT/logs/source.log" 2>&1 </dev/null &
  KINU_SOURCE_PID=$!
fi
# THE ONLY GATES THAT HOLD THE UPLOAD, and the only phase besides the preflight
# whose red ends the deploy: the account gate, which proves the ACCOUNT is
# deployable for the environment and in the phase KINU_INFRA_ENVIRONMENT and
# KINU_INFRA_PHASE name (`full` normally, `bootstrap` under `--bootstrap`),
# travelling in the environment so the gate's command stays one string in the
# plan; and the secret scan, since a credential in a published asset cannot be
# withdrawn. Every other gate's red is recoverable on staging, so it runs after
# the upload and gates the promotion instead.
# The account tokens the deployment needs (DEVBOX_REGISTRY_TOKEN), minted with this deploy's own Cloudflare token once
# every refusal before it passed, and installed before the account gate reads the Worker's secrets (infra-provision.ts
# mintAccountToken). One it cannot mint is the gate's red, as an absent secret always was.
if [ "$KINU_GATES_ONLY" != "1" ]; then
  bun "$KINU_ROOT/scripts/infra-provision.ts" "$KINU_ENV" --account-tokens || echo -e "${BOLD}An account token could not be minted; the account gate names it.${NC}"
fi
if [ "$KINU_PROMOTE" != "1" ]; then
  if ! run_phase upload; then
    echo -e "${RED}The upload checks are red, so nothing was uploaded.${NC}"
    finish
  fi
else
  stop_phase upload
fi
mark upload

if [ "$KINU_GATES_ONLY" = "1" ]; then
  run_phase source
  mark source
  echo "Gates only: stopping before the build, as asked."
  finish
fi

# ── Steps 2 to 4: build, upload, and prove the deployment serves it ──
#
# `publish_build` returns non-zero at the first step that went red, with
# KINU_PUBLISH_FINDING saying which and why. After that nothing that reads the
# deployment can test this build, while every local gate still can: the deploy
# records the step, skips only the rows that read the deployment, and runs the
# remaining local wave to the end.
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

# The smoke's reads of this deploy's own version: `ours` and `not_ours`.
source "$KINU_ROOT/scripts/deploy-smoke.sh"
# The upload, and the one retry wrangler asks for: `upload`.
source "$KINU_ROOT/scripts/deploy-upload.sh"

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

# The build, started beside the upload gates, on armada at this exact commit (scripts/release-build.sh): the
# client bundle and Worker for this environment, and unless promoting, the worker
# release artifact and the CLI distribution, which is signed here, where the key is.
wait "$KINU_BUILD_PID"
KINU_BUILD_STATUS=$?
KINU_BUILD_PID=""
cat "$KINU_BUILD_LOG"
[ "$KINU_BUILD_STATUS" -eq 0 ] || { publish_red "the build on armada failed"; return 1; }
cd "$KINU_ROOT/packages/cf-backend" || { publish_red "cannot cd to cf-backend"; return 1; }

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
  bun "$KINU_ROOT/scripts/promote.ts" adopt ${KINU_OVERRIDE:+override} \
    || { publish_red "this build is not the one staging verified, or its downloads did not check out"; return 1; }
fi

# No deploy may ship without every CLI download asset sitting in the
# directory wrangler publishes. A deploy missing one bricks every fresh install
# and update on the platform it belongs to.
# The archives by core's inventory, the one the build wrote and the launcher downloads (http/deployed-assets.ts).
mapfile -t KINU_CLI_ARTIFACTS < <(bun -e 'for (const p of (await import(process.argv[1])).CLI_DIST_PATHS) console.log(p.slice(p.lastIndexOf("/") + 1))' "$KINU_ROOT/packages/core/src/http/deployed-assets.ts")
for file in kinu-version.json release.json "$KINU_WORKER_ARTIFACT.sha256" \
  "${KINU_CLI_ARTIFACTS[@]}" "${KINU_CLI_ARTIFACTS[@]/%/.sha256}"; do
  if [ ! -s "$KINU_ASSETS_DIR/downloads/$file" ]; then
    publish_red "Missing build output: $KINU_ASSETS_DIR/downloads/$file"
    return 1
  fi
done
echo -e "${GREEN}✅ CLI and worker release assets staged in $KINU_ASSETS_DIR/downloads${NC}"

# THE RELEASE ARTIFACT, THE DEVBOX TOOLS AND THE RUNTIME CATALOG, beside the validated upload below (Step 2a): none
# reads another or the version, and all three are joined before the reset and the deploy, so each is still in place
# before anything is deleted or served. Its own process, so a red says why through a file.
KINU_ALONGSIDE_FINDING="$KINU_DEPLOY_REPORT/logs/alongside.finding"
: > "$KINU_ALONGSIDE_FINDING"
alongside_red() {
  printf '%s' "$1" > "$KINU_ALONGSIDE_FINDING"
}
publish_alongside() {
  # The worker artifact is larger than Cloudflare's 25 MiB per-file asset limit,
  # so it is published into R2 and streamed by the Worker instead. BEFORE the
  # deploy, never after: the release.json this deploy publishes names this
  # artifact, and a manifest that names an object nobody uploaded yet sends every
  # self-deploy run at a 404. Into this build's own releases bucket; a promotion
  # copied staging's there above.
  if [ "$KINU_PROMOTE" != "1" ]; then
    if [ ! -s "$KINU_WORKER_ARTIFACT_PATH" ]; then
      alongside_red "Missing build output: $KINU_WORKER_ARTIFACT_PATH"
      return 1
    fi
    KINU_RELEASES_BUCKET="$(bun -e '
      const config = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      process.stdout.write(config.r2_buckets?.find((bucket) => bucket.binding === "RELEASES_BUCKET")?.bucket_name ?? "");
    ' "$KINU_BUILT_CONFIG")"
    if [ -z "$KINU_RELEASES_BUCKET" ]; then
      alongside_red "$KINU_BUILT_CONFIG binds no RELEASES_BUCKET"
      return 1
    fi
    echo "Publishing $KINU_WORKER_ARTIFACT to r2://$KINU_RELEASES_BUCKET"
    npx wrangler r2 object put "$KINU_RELEASES_BUCKET/$KINU_WORKER_ARTIFACT" \
      --file "$KINU_WORKER_ARTIFACT_PATH" --content-type application/gzip --remote \
      || { alongside_red "uploading the worker release artifact failed"; return 1; }
    npx wrangler r2 object put "$KINU_RELEASES_BUCKET/$KINU_WORKER_ARTIFACT.sha256" \
      --file "$KINU_ASSETS_DIR/downloads/$KINU_WORKER_ARTIFACT.sha256" --content-type text/plain --remote \
      || { alongside_red "uploading the worker release checksum failed"; return 1; }
    echo -e "${GREEN}✅ Worker release artifact published to R2${NC}"
  fi

  # The devbox tools tarball the image's golden snapshot installs (D65) must be in the
  # store bucket before a box can start: refused by name, never built here.
  KINU_BACKUP_BUCKET="$(bun -e '
    const config = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    process.stdout.write(config.r2_buckets?.find((bucket) => bucket.binding === "BACKUP_BUCKET")?.bucket_name ?? "");
  ' "$KINU_BUILT_CONFIG")"
  if [ -z "$KINU_BACKUP_BUCKET" ]; then
    alongside_red "$KINU_BUILT_CONFIG binds no BACKUP_BUCKET"
    return 1
  fi
  bun "$KINU_ROOT/scripts/devbox-tools.ts" check "$KINU_BACKUP_BUCKET" \
    || { alongside_red "the devbox tools tarball is missing from $KINU_BACKUP_BUCKET; publish it as the line above says"; return 1; }

  # The same parts, served by the release channel (`/downloads/devbox-tools/`) to a self-deployment's computer, which
  # copies them into its own store bucket: in this build's releases bucket before the release.json naming them ships.
  KINU_CHANNEL_BUCKET="$(bun -e '
    const config = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    process.stdout.write(config.r2_buckets?.find((bucket) => bucket.binding === "RELEASES_BUCKET")?.bucket_name ?? "");
  ' "$KINU_BUILT_CONFIG")"
  bun "$KINU_ROOT/scripts/devbox-tools.ts" release "$KINU_BACKUP_BUCKET" "$KINU_CHANNEL_BUCKET" \
    || { alongside_red "the devbox tools could not be copied into $KINU_CHANNEL_BUCKET for the release channel"; return 1; }

  # The runtime catalog this build pins (NIMBUS_RUNTIME_CATALOG_SHA256), read by a hosted `nimbus install` from
  # `catalog/sha256/<sha256>.json` in its NIMBUS_RUNTIME_CACHE bucket: put there from the bucket's `catalog/v1.json` when
  # that is the pinned catalog, else refused by name, before the Worker that reads it is uploaded.
  KINU_RUNTIME_CATALOG="$(bun -e '
    const config = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const bucket = config.r2_buckets?.find((entry) => entry.binding === "NIMBUS_RUNTIME_CACHE")?.bucket_name ?? "";
    process.stdout.write(bucket + " " + (config.vars?.NIMBUS_RUNTIME_CATALOG_SHA256 ?? ""));
  ' "$KINU_BUILT_CONFIG")"
  read -r KINU_RUNTIME_BUCKET KINU_RUNTIME_CATALOG_SHA256 <<< "$KINU_RUNTIME_CATALOG"
  if [ -z "$KINU_RUNTIME_BUCKET" ] || [ -z "$KINU_RUNTIME_CATALOG_SHA256" ]; then
    alongside_red "$KINU_BUILT_CONFIG binds no NIMBUS_RUNTIME_CACHE or pins no NIMBUS_RUNTIME_CATALOG_SHA256"
    return 1
  fi
  bun "$KINU_ROOT/scripts/runtime-catalog.ts" ensure "$KINU_RUNTIME_BUCKET" "$KINU_RUNTIME_CATALOG_SHA256" \
    || { alongside_red "the pinned runtime catalog is not in $KINU_RUNTIME_BUCKET, as the line above says"; return 1; }
}
publish_alongside &
KINU_ALONGSIDE_PID=$!
# Joined before anything is deleted or served: answers its red as this deploy's.
join_alongside() {
  wait "$KINU_ALONGSIDE_PID" && return 0
  publish_red "$(cat "$KINU_ALONGSIDE_FINDING")"
  return 1
}

# ── Step 2a: The Worker's startup ────────────────────────────
# Cloudflare refuses a version whose startup exceeds its CPU limit (code 10021).
# Before a reset deletes what the target serves, the validator itself reads it:
# the build is uploaded as a version, not deployed, while the target still runs
# (`wrangler versions upload`, which needs the target's container application,
# gone once the reset ran). On 2026-10-13 the reset ran first, staging's upload
# was refused, and staging served its placeholder. The deploy after the reset is
# still `wrangler deploy` of the same build, never the validated version by id,
# which serves with none of the classes the reset deleted (L26). A refusal is the
# build's verdict, never asked again (L27). A reset finishing an earlier one has
# a placeholder serving and nothing left to keep up, so its deploy is its first
# reading. A version cannot bind a Durable Object class its deploy has not yet
# provisioned (rc28's MailNameDO, 2026-10-20), so the version uploaded is the
# build with the classes new to the target left out (reset.ts `validation`): the
# same script, whose bindings the deploy after the reset adds, and the report
# names them.
if [ "$KINU_RESET" = "1" ] && [ "${KINU_PENDING_RESET:-none}" = "none" ]; then
  KINU_VALIDATE_LOG="$(mktemp -t kinu-validate.XXXXXX.log)"
  KINU_VALIDATE_CONFIG="$(dirname "$KINU_BUILT_CONFIG")/wrangler.validate.json"
  if ! KINU_WITHHELD="$(bun "$KINU_ROOT/scripts/reset.ts" validation "$KINU_ENV" "$KINU_BUILT_CONFIG" "$KINU_VALIDATE_CONFIG")"; then
    wait "$KINU_ALONGSIDE_PID"
    publish_red "the classes $KINU_WORKER binds could not be read, so this build's version was not validated and nothing was deleted"
    return 1
  fi
  read -ra KINU_WITHHELD_CLASSES <<< "$KINU_WITHHELD"
  echo "Running: npx wrangler versions upload --config $KINU_VALIDATE_CONFIG ${KINU_WRANGLER_ARGS[*]} (log → $KINU_VALIDATE_LOG)"
  if [ "${#KINU_WITHHELD_CLASSES[@]}" -ne 0 ]; then
    echo "  without the bindings of ${KINU_WITHHELD_CLASSES[*]}, which $KINU_WORKER does not bind yet"
  fi
  upload "$KINU_VALIDATE_LOG" npx wrangler versions upload --config "$KINU_VALIDATE_CONFIG" "${KINU_WRANGLER_ARGS[@]}"
  KINU_VALIDATED=$?
  rm -f "$KINU_VALIDATE_CONFIG"
  report startup validated "$(startup_reading "$KINU_VALIDATE_LOG")" "${KINU_WITHHELD_CLASSES[@]}"
  if [ "$KINU_VALIDATED" -ne 0 ]; then
    wait "$KINU_ALONGSIDE_PID"
    publish_red "$(startup_refusal "$KINU_VALIDATE_LOG")$KINU_WORKER refused this build's version before the reset, so nothing was deleted and it still serves what it did; the log is $KINU_VALIDATE_LOG"
    return 1
  fi
fi
join_alongside || return 1

# ── Step 2b: The reset ────────────────────────────────────────
# After the build and its validated version, so a red gate, a failed build or
# a refused version deletes nothing; the upload below is then the genesis deploy.
if [ "$KINU_RESET" = "1" ]; then
  echo ""
  echo -e "${BOLD}Step 2b: Resetting $KINU_WORKER${NC}"
  KINU_RECORD_ARGS=("$KINU_RESET_RECORD")
  bun "$KINU_ROOT/scripts/reset.ts" wipe "$KINU_ENV" "$KINU_RESET_RECORD" \
    || { publish_red "the reset failed; its lines in the deploy's output say what it deleted before it stopped, and a deploy with --reset finishes it from its record"; return 1; }
fi

# The tables plan's record becomes the rollback barrier only now, the last step before any object can repair. Just
# before it, every table's rows and digest on every object, as the build before holds them: the walk's census after the
# upload is read against this one (census-diff below), the proof the reset dropped what its plan named and no more.
if [ "$KINU_RESET_TABLES" = "1" ]; then
  bun "$KINU_ROOT/scripts/reset.ts" census "$KINU_ENV" "$KINU_TABLES_RECORD.before.tsv" \
    || { publish_red "the census before the upload could not be taken; nothing was uploaded"; return 1; }
  # A database it could not read is one census-diff cannot prove after: refused here, before anything changes.
  if grep -q $'\t!unreachable\t' "$KINU_TABLES_RECORD.before.tsv"; then
    publish_red "the census before the upload could not read $(grep -c $'\t!unreachable\t' "$KINU_TABLES_RECORD.before.tsv") object(s) (lines with !unreachable in $KINU_TABLES_RECORD.before.tsv); nothing was uploaded"
    return 1
  fi
  bun "$KINU_ROOT/scripts/reset.ts" tables-record "$KINU_ENV" "$KINU_TABLES_RECORD" \
    || { publish_red "the tables plan's record could not be published as the rollback barrier; nothing was uploaded"; return 1; }
fi

# ── Step 3: Deploy Kinu ───────────────────────────────────────
echo ""
echo -e "${BOLD}Step 3: Deploying $KINU_WORKER${NC}"
KINU_DEPLOY_LOG="$(mktemp -t kinu-deploy.XXXXXX.log)"
echo ""
echo "Running: npx wrangler deploy ${KINU_WRANGLER_ARGS[*]} (log → $KINU_DEPLOY_LOG)"
echo ""
if upload "$KINU_DEPLOY_LOG" npx wrangler deploy "${KINU_WRANGLER_ARGS[@]}"; then
  report startup deployed "$(startup_reading "$KINU_DEPLOY_LOG")"
  DEPLOY_PUBLISHED=1
  # From when the version could answer: the start of what Step 5b reads.
  KINU_LIVE_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo ""
  echo -e "${GREEN}Kinu deploy succeeded.${NC}"
else
  report startup deployed "$(startup_reading "$KINU_DEPLOY_LOG")"
  echo ""
  publish_red "$(startup_refusal "$KINU_DEPLOY_LOG")wrangler deploy failed; its log is $KINU_DEPLOY_LOG"
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

# ── Step 3b: The tables walk ──────────────────────────────────
# Every object opened once through the version just deployed, so each resets itself before a user waits on it, what
# each reset dropped printed, and each database's census written beside the record. Correctness never waits on it: an
# object it misses resets at its first request, so a gap in its census is named and fails nothing; only a reset that
# refused fails the deploy.
# It starts once this deploy's version answers (`ours`, as the smoke test reads it), and asks a batch, or an object
# that started on a machine still running the build before, again for as long (KINU_PROPAGATION_SECONDS).
if [ "$KINU_RESET_TABLES" = "1" ]; then
  echo ""
  echo -e "${BOLD}Step 3b: Opening every object of $KINU_WORKER, so each resets its changed tables${NC}"
  KINU_RECORD_ARGS=("$KINU_TABLES_RECORD")
  KINU_TABLES_BODY="$(mktemp -t kinu-tables-health.XXXXXX)"
  ours "$KINU_TABLES_BODY" --max-time 15 "${KINU_URL}api/health"
  rm -f "$KINU_TABLES_BODY"
  FINDING="$(not_ours "/api/health")"
  if [ -n "$FINDING" ]; then
    publish_red "the tables walk did not start: $FINDING; every object still resets at its first request, and 'KINU_VERSION=$KINU_VERSION bun scripts/reset.ts tables $KINU_ENV $KINU_TABLES_RECORD' walks them"
    return 1
  fi
  KINU_VERSION="$KINU_VERSION" KINU_PROPAGATION_SECONDS="$KINU_PROPAGATION_SECONDS" bun "$KINU_ROOT/scripts/reset.ts" tables "$KINU_ENV" "$KINU_TABLES_RECORD" \
    || { publish_red "the tables walk found a reset that refused (its lines name it); 'KINU_VERSION=$KINU_VERSION bun scripts/reset.ts tables $KINU_ENV $KINU_TABLES_RECORD' walks again"; return 1; }
  # The reset's structure fails a deploy anywhere; a change outside its plan fails one only where nothing else writes.
  bun "$KINU_ROOT/scripts/reset.ts" census-diff "$KINU_ENV" "$KINU_TABLES_RECORD.before.tsv" "$KINU_TABLES_RECORD.census.tsv" "$KINU_TABLES_RECORD" \
    || { publish_red "the census after the reset is not the one before it but for the plan's tables (its lines name each); 'bun scripts/reset.ts census-diff $KINU_ENV $KINU_TABLES_RECORD.before.tsv $KINU_TABLES_RECORD.census.tsv $KINU_TABLES_RECORD' reads them again"; return 1; }
fi

# ── Step 4: Post-deploy smoke test ───────────────────────────────
# Every check reads the response of the version this deploy made (`ours`): a
# version it replaced may still answer at an edge for seconds after the upload.
echo ""
echo -e "${BOLD}Step 4: Post-deploy smoke test of version ${KINU_VERSION:-<unnamed>}${NC}"

SMOKE_FAIL=0
KINU_SMOKE_FINDINGS=()
SMOKE_BODY="$(mktemp -t kinu-smoke-body.XXXXXX)"

if [ -z "$KINU_VERSION" ]; then
  smoke_red "wrangler named no Version ID, so no answer can be told to be this deploy's"
fi

# The deployment's own route, and the application shell it serves.
ours "$SMOKE_BODY" --max-time 15 "$KINU_URL"
LIVE_STATUS="$KINU_STATUS"
FINDING="$(not_ours "the live site")"
if [ -n "$FINDING" ]; then
  smoke_red "$FINDING"
elif [ "$LIVE_STATUS" != "200" ]; then
  smoke_red "Kinu live site returns $LIVE_STATUS ($KINU_URL)"
elif grep -q "id=\"$KINU_APP_ROOT\"" "$SMOKE_BODY" && grep -q '<script type="module"' "$SMOKE_BODY"; then
  echo -e "${GREEN}✅ Kinu live site returns 200 with the application shell${NC} ($KINU_URL)"
else
  smoke_red "Kinu live site returned 200 without the application shell"
fi

# One GET that answers "did my deploy land?". /api/health reads its build stamp
# out of the deployed asset bundle, so a mismatch here also means the CLI
# download assets are stale or missing.
ours "$SMOKE_BODY" --max-time 15 "${KINU_URL}api/health"
HEALTH_SHA="$(json_field build.sha < "$SMOKE_BODY")"
FINDING="$(not_ours "/api/health")"
if [ -n "$FINDING" ]; then
  smoke_red "$FINDING"
elif [ "$HEALTH_SHA" = "$KINU_SHA" ]; then
  echo -e "${GREEN}✅ /api/health reports the deployed build ($KINU_SHA)${NC}"
else
  smoke_red "/api/health build stamp is '${HEALTH_SHA:-<none>}', expected '$KINU_SHA'"
  echo "   Body: $(head -c 200 "$SMOKE_BODY")"
fi

# The §0 regression: this asset once came back as the SPA shell wearing an
# application/json content-type, so `kinu update` could never see a version.
ours "$SMOKE_BODY" --max-time 15 "${KINU_URL}downloads/kinu-version.json"
VERSION_SHA="$(json_field sha < "$SMOKE_BODY")"
SIGNED_ARTIFACT_SHA="$(bun -e 'const m=JSON.parse(await Bun.stdin.text()); process.stdout.write(m.checksums?.["/downloads/"+process.argv[1]] ?? "")' "$KINU_WORKER_ARTIFACT" < "$SMOKE_BODY" 2>/dev/null)"
FINDING="$(not_ours "kinu-version.json")"
if [ -n "$FINDING" ]; then
  smoke_red "$FINDING"
elif [ "$VERSION_SHA" = "$KINU_SHA" ]; then
  echo -e "${GREEN}✅ Published kinu-version.json is real JSON for this build${NC}"
else
  smoke_red "Published kinu-version.json sha is '${VERSION_SHA:-<unparseable>}', expected '$KINU_SHA'"
fi

# The self-deploy channel. Same SPA-shell hazard as the stamp above, and worse
# consequences: a deployment reading a shell instead of a manifest would try to
# upload a Worker made of an HTML page.
ours "$SMOKE_BODY" --max-time 15 "${KINU_URL}downloads/release.json"
RELEASE_SHA="$(json_field sha < "$SMOKE_BODY")"
RELEASE_FINDING="$(not_ours "release.json")"
ours "$SMOKE_BODY" --max-time 15 "${KINU_URL}downloads/$KINU_WORKER_ARTIFACT.sha256"
RELEASE_ARTIFACT_SHA="$(awk '{print $1}' "$SMOKE_BODY")"
CHECKSUM_FINDING="$(not_ours "the worker artifact's .sha256")"
ours /dev/null -I --max-time 30 "${KINU_URL}downloads/$KINU_WORKER_ARTIFACT"
ARTIFACT_STATUS="$KINU_STATUS"
ARTIFACT_FINDING="$(not_ours "the worker artifact route")"
if [ -n "$RELEASE_FINDING$CHECKSUM_FINDING$ARTIFACT_FINDING" ]; then
  for FINDING in "$RELEASE_FINDING" "$CHECKSUM_FINDING" "$ARTIFACT_FINDING"; do [ -z "$FINDING" ] || smoke_red "$FINDING"; done
elif [ "$RELEASE_SHA" = "$KINU_SHA" ] && [ -n "$RELEASE_ARTIFACT_SHA" ] \
  && [ "$RELEASE_ARTIFACT_SHA" = "$SIGNED_ARTIFACT_SHA" ] && [ "$ARTIFACT_STATUS" = "200" ]; then
  echo -e "${GREEN}✅ release.json names this build, the artifact route answers, and its checksum is the signed one${NC}"
else
  smoke_red "release.json sha is '${RELEASE_SHA:-<unparseable>}' (expected '$KINU_SHA'); worker artifact checksum '${RELEASE_ARTIFACT_SHA:-<none>}' vs signed '${SIGNED_ARTIFACT_SHA:-<none>}'; artifact route answered ${ARTIFACT_STATUS:-<none>}"
fi

ours "$SMOKE_BODY" --max-time 15 "${KINU_URL}downloads/kinu"
FINDING="$(not_ours "the CLI launcher")"
if [ -n "$FINDING" ]; then
  smoke_red "$FINDING"
elif grep -q 'downloads/kinu-cli-' "$SMOKE_BODY" && ! grep -q 'github.com' "$SMOKE_BODY"; then
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
  ours "$CLI_ARTIFACT_TMP" -L --max-time 60 "${KINU_URL}downloads/$artifact"
  ARTIFACT_STATUS="$KINU_STATUS"
  FINDING="$(not_ours "$artifact")"
  if [ -n "$FINDING" ]; then
    smoke_red "$FINDING"
    continue
  fi
  if [ "$ARTIFACT_STATUS" != "200" ] || ! tar -tzf "$CLI_ARTIFACT_TMP" > "$CLI_ARTIFACT_LIST" 2>/dev/null \
    || ! grep -Fq "$MEMBER" "$CLI_ARTIFACT_LIST"; then
    smoke_red "$artifact answered $ARTIFACT_STATUS, is unreadable, or carries no $MEMBER"
    continue
  fi
  ours "$SMOKE_BODY" --max-time 15 "${KINU_URL}downloads/$artifact.sha256"
  FINDING="$(not_ours "$artifact.sha256")"
  PUBLISHED_SHA="$(awk '{print $1}' "$SMOKE_BODY")"
  ACTUAL_SHA="$(sha256sum "$CLI_ARTIFACT_TMP" | awk '{print $1}')"
  if [ -n "$FINDING" ]; then
    smoke_red "$FINDING"
  elif [ -n "$PUBLISHED_SHA" ] && [ "$PUBLISHED_SHA" = "$ACTUAL_SHA" ]; then
    echo -e "${GREEN}✅ $artifact downloads and matches its published .sha256${NC}"
  else
    smoke_red "$artifact checksum is missing or does not match the download"
  fi
done
rm -f "$CLI_ARTIFACT_TMP" "$CLI_ARTIFACT_LIST" "$SMOKE_BODY"

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
  # Staging's build as it serves it, whatever goes red after: what an owner's override names, never a verdict.
  if [ "$KINU_PROMOTE" != "1" ]; then
    bun "$KINU_ROOT/scripts/promote.ts" built "${KINU_VERSION:-unknown}" "${KINU_RECORD_ARGS[@]}" \
      || step_red record "the built record" "staging serves $KINU_SHA, and its built record was not written, so no override could name it"
  fi
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
  npx wrangler deploy -c scripts/scripted-model-worker.jsonc --secrets-file "$KINU_SCRIPTED_SECRETS"
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

# THE STATISTICS, on armada (L19). scripts/evals-map.ts runs each trial as one `armada map` task at
# this commit, both legs at once: every eval task five trials each on staging, which must be serving
# this build, and on production, the baseline. Its comparison verdict fails on an incomplete report
# or a regression between the two. Started first and never awaited. The soak finishes before the
# statistical map starts so two jobs cannot multiply the one Muse budget. Its completed verdict is
# stored beside the verified record; either may finish first, and promotion waits for both.
KINU_EVALS_OUT=""
start_evals() {
  local out="$KINU_DEPLOY_REPORT/evals-map"
  mkdir -p "$out"
  setsid nohup bash -c 'run_soak; exec bun scripts/evals-map.ts "$1" --out="$2" --record --post="$1"' \
    _ "$KINU_SHA" "$out" >"$out/driver.log" 2>&1 </dev/null &
  KINU_EVALS_OUT="$out"
  report dispatched "the evals of $KINU_SHA on armada, every task five trials each on staging against production" "$out/driver.log"
}

# The soak's run, its verdict into the report, and the report rendered again: the soak alone, or before the evals.
# Exported, so the detached shells that run it have it.
run_soak() {
  bun scripts/ladder.ts --deploy-phase=soak
  bun scripts/deploy-report.ts runner "$KINU_DEPLOY_REPORT" soak $?
  bun scripts/deploy-report.ts render "$KINU_DEPLOY_REPORT" after-soak
}
export -f run_soak

# EVAL-SERVICE'S PROVIDER KEYS (scripts/eval-provider-keys.ts), stored before any eval starts, on each deployment one
# drives: this one and, for a staging build, production, the baseline the evals compare it with. Awaited here, so a key
# not stored is this deploy's red, its finding the provisioner's own, and no eval starts. The trial accounts are keyed by
# the run that leases them (scripts/evals-map.ts, scripts/evals-lease.ts), on its block alone.
provision_eval_keys() {
  local origin
  for origin in "$@"; do
    env -u KINU_EVAL_MODELS bun "$KINU_ROOT/scripts/eval-provider-keys.ts" "$origin" \
      || { step_red evals "the eval accounts' provider keys" "not all stored at $origin, so no eval was started: each of its trials would be refused HTTP 401"; return 1; }
  done
}

# THE SOAK (L24): one trial of every eval task on the deployment, on the models the evals measure. Started once the
# deployment serves and never awaited, so a real model's minutes are outside this deploy's 20-minute wall and its red
# outside this deploy's verdict: the soak writes into this report's soak section and renders it again when it ends.
start_soak() {
  setsid nohup bash -c run_soak >"$KINU_DEPLOY_REPORT/soak.log" 2>&1 </dev/null &
  report dispatched "the eval soak, one trial of every task on $KINU_EVAL_ORIGIN; its reds re-render this report" "$KINU_DEPLOY_REPORT/soak.log"
}

# THE REVIEWER'S LOGINS (evals/scripts/reviewer-sign-in.ts): the eval reviewer's own ChatGPT logins on this deployment, asked
# of the owner here, in the foreground, and only for a login the deployment does not hold, so only after a reset wiped
# it. The soak's provisioning runs detached and cannot ask. A login not approved is a notice in the report, never a red:
# the reviewer explains a run, and the build is not what it measures.
if [ "$KINU_SERVING" = "1" ]; then
  bun "$KINU_ROOT/scripts/credential-checkpoint.ts" restore "$KINU_EVAL_ORIGIN" \
    || step_red provision "eval-service's credentials" "the checkpoint was not restored, as the line above says; its file stays for the next deploy to finish"
  bun "$KINU_ROOT/evals/scripts/reviewer-sign-in.ts" "$KINU_EVAL_ORIGIN"
fi

if [ "$KINU_PROMOTE" = "1" ]; then
  if [ -z "$KINU_TIERS_WHY" ]; then
    if [ "$KINU_EVALS" = "1" ] && provision_eval_keys "$KINU_EVAL_ORIGIN"; then start_soak; fi
    run_phase post-publish
  else
    skip_phase post-publish "$KINU_TIERS_WHY"
  fi
  mark tiers
else
  # Started first, so its hours run while the wave runs here. Without its run
  # this build has no verdict to be promoted on, so a failed start is a red.
  if [ "$KINU_EVALS" = "1" ] && [ "$KINU_SERVING" = "1" ]; then
    # Production, the baseline leg's origin, as wrangler.jsonc declares it: the evals measure the candidate on staging
    # against it.
    EVAL_BASELINE_ORIGIN="$(bun "$KINU_ROOT/scripts/eval-target.ts" production | head -1)"
    if provision_eval_keys "$KINU_EVAL_ORIGIN" "$EVAL_BASELINE_ORIGIN"; then
      start_evals
    fi
  fi
  if [ -z "$KINU_TIERS_WHY" ]; then
    run_phase post-publish
  else
    skip_phase post-publish "$KINU_TIERS_WHY"
  fi
  start_telemetry
  join_source
  mark wave
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
# tiers have driven it (the soak may still run), with zero users the traffic being our
# own: an invocation that ended in an uncaught exception or that the platform
# ended, a terminal effect that failed or was left owed, an object started as
# often as the product calls a wake loop, an alarm with nothing to watch. Each
# is a notice of this deploy, in the report under `telemetry`, and holds
# nothing (the owner, 2026-10-23: "Monitors don't block"); so is telemetry it
# cannot read. Its window ends when the wave's last row that drove the deployment
# did (the ladder's `traffic` mark), and it is read once, then, beside the wave's
# last rows (start_telemetry): a monitor that holds nothing waits for no settle.
# It settled on reads 2 min apart, 370 s past the wave of staging 8f6ccf7fb
# (2026-10-23). What lands later is read by later deploys: this one keeps its
# window in the releases bucket and reads again every window earlier deploys
# kept, so a row that landed late is named for its version in a later report
# (scripts/telemetry-windows.ts). With no row that drove the deployment, the
# window ends at the post-publish phase's end.
if [ -n "$KINU_TELEMETRY_PID" ]; then
  echo ""
  echo -e "${BOLD}Step 5b: What version $KINU_VERSION did on staging${NC}"
  join_telemetry
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
  bun "$KINU_ROOT/scripts/promote.ts" record "${KINU_VERSION:-unknown}" "${KINU_RECORD_ARGS[@]}" \
    || { step_red record "the record" "the record was not written, so this build cannot be promoted"; finish; }
elif ! bun "$KINU_ROOT/scripts/promote.ts" promoted ${KINU_OVERRIDE:+--override} "${KINU_VERSION:-}" "${KINU_RECORD_ARGS[@]}"; then
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
if [ "$KINU_ENV" = "staging" ] && [ -z "$KINU_EVALS_OUT" ]; then
  echo "No eval ran. Once staging has stopped moving: bun scripts/evals-map.ts $KINU_SHA --post=$KINU_SHA, then bun scripts/promote.ts evals <its out>;"
  echo "a passing verdict lets it be promoted with: bun run deploy --promote"
elif [ "$KINU_ENV" = "staging" ]; then
  echo "Promote it to production with: bun run deploy --promote"
else
  echo "Return production to the build it took before with: bun run deploy --rollback"
fi
finish
