#!/usr/bin/env bash
# One arm of the seeded both-arms Terminal-Bench run.
#
#   scripts/tbench-arm.sh <true|false> <seed> <size> <model-id> <concurrency>
#
# Both arms are launched from this one script so the only difference between
# them is the `evolve` kwarg it is given. Everything else — corpus, task list,
# model, timeouts, concurrency, attempts, adapter, binary — is spelled once
# here, because an arm pair whose two commands were typed separately is an arm
# pair that can differ in a way nobody recorded.
#
# The design this executes is pre-registered in tests/bench/seal-ledger.jsonl
# (ordinal 6) and was committed before any experimental token was spent.
set -euo pipefail

EVOLVE="${1:?arm state: true|false}"
SEED="${2:?seed}"
SIZE="${3:?sample size}"
MODEL="${4:?model id}"
CONCURRENCY="${5:?concurrent trials}"

WORKTREE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Where the corpus is, in the one place `.gitignore` and `bench/harbor/kinu_agent.py`
# already say it is: the repository root. This line used to name an absolute path
# under the operator's checkout directory, and the rename to Kinu rewrote the
# directory name inside it, so it pointed at nothing from that commit onward. A
# path spelled relative to the tree cannot be broken by renaming the product.
# TBENCH_CORPUS points at a shared copy, which is how one 60 MB fetch serves
# several worktrees.
CORPUS="${TBENCH_CORPUS:-$WORKTREE/terminal-bench-2.1}"
JOBS_DIR=/var/tmp/tbench-jobs
SHA="$(git -C "$WORKTREE" rev-parse --short=9 HEAD)"
JOB_NAME="tb21-seed${SEED}-evolve${EVOLVE}-${SHA}"

# The trap named in the ticket: if any of these is set, the CLI takes the
# direct-endpoint branch before it ever reaches the token, and the adapter would
# forward an operator's ambient endpoint into a scored run. Refuse rather than
# measure something nobody chose.
#
# SET, not non-empty. `KINU_BASE_URL=` defeats the adapter's own default
# (harbor's EnvVar resolves the empty string in preference to it) and then fails
# 40 trials in with "No credential rule for provider 'custom' at ." — which is
# what an operator trying to CLEAR the variable actually produces. A guard that
# measured emptiness would have governed the wrong set.
# KINU_EVAL_TOKEN belongs to the same set for the same reason, and it is
# supplied below rather than inherited: a scored run's identity is not a fact
# about whoever's shell launched it.
for trap_var in KINU_BASE_URL KINU_AUTH KINU_MODEL KINU_HOME KINU_EVAL_TOKEN; do
  if [ -n "${!trap_var+set}" ]; then
    echo "REFUSING: $trap_var is set in this shell (value: '${!trap_var}'). The" >&2
    echo "adapter resolves its own endpoint, identity and home; an inherited one —" >&2
    echo "empty or not — is an unrecorded variable in a scored run. Unset it, do not" >&2
    echo "blank it: an empty KINU_BASE_URL overrides the adapter's default." >&2
    exit 2
  fi
done

# The corpus, checked here rather than through the sampler below. Two reasons and
# both are about the failure being readable. The sampler's FileNotFoundError goes
# into a pipe, so an absent corpus used to surface as "the sample returned 0
# tasks" — a message that names the count and hides the cause, and it hid a corpus
# path that had been dead since the rename. And this check sits ABOVE the
# credential one because the corpus is free and public: an operator can prove this
# refusal fires without holding a token, where a check reachable only with a
# credential is a check nobody exercises.
if [ ! -d "$CORPUS" ]; then
  parent="$(dirname "$CORPUS")"
  echo "REFUSING: no Terminal-Bench corpus at $CORPUS." >&2
  echo "The dataset is public. Fetch it, name the directory after the RELEASE, and write" >&2
  echo "its manifest — the manifest is what ties a score to the task set that produced it:" >&2
  echo "  harbor datasets download terminal-bench/terminal-bench-2-1@6 -o $parent" >&2
  echo "  mv $parent/terminal-bench-2-1 $CORPUS   # export mode names the dataset, not the release" >&2
  echo "  python3 -m bench.harbor.corpus init $CORPUS --name terminal-bench --version 2.1 \\" >&2
  echo "    --registry-ref terminal-bench/terminal-bench-2-1@6 --fetched-at \$(date -I)" >&2
  echo "Set TBENCH_CORPUS to share one 60 MB copy across worktrees." >&2
  exit 2
fi

# The eval-service credential, from a file only this operator can read. It used
# to be exported as KINU_TOKEN, which the CLI also reads as a SIGNED-IN
# SESSION — so whichever account minted the file became the account every scored
# run acted as. The eval identity has its own variable so that cannot recur, and
# `bench/model_endpoint.py` reads no other.
EVAL_TOKEN_FILE="$HOME/.config/kinu/eval-service-token"
if [ ! -r "$EVAL_TOKEN_FILE" ]; then
  echo "REFUSING: no eval-service credential at $EVAL_TOKEN_FILE." >&2
  echo "Mint one against staging and write it there:" >&2
  echo "  kinu auth --origin https://staging.kinu.run" >&2
  echo "  kinu tokens create --name tbench --scopes ai.proxy" >&2
  exit 2
fi
KINU_EVAL_TOKEN="$(cat "$EVAL_TOKEN_FILE")"
export KINU_EVAL_TOKEN
export PATH="$HOME/.local/bin:$PATH"
export PYTHONPATH="$WORKTREE"

# The sample, drawn by the same seeded function for both arms. Read from the
# corpus rather than pasted, so the two arms cannot receive different lists.
mapfile -t TASKS < <(python3 -m bench.harbor.corpus sample "$CORPUS" \
  --size "$SIZE" --seed "$SEED" | python3 -c 'import json,sys; [print(t) for t in json.load(sys.stdin)["tasks"]]')
if [ "${#TASKS[@]}" -ne "$SIZE" ]; then
  echo "REFUSING: the sample returned ${#TASKS[@]} tasks, not $SIZE" >&2
  exit 2
fi

TASK_FLAGS=()
for t in "${TASKS[@]}"; do TASK_FLAGS+=(-i "$t"); done

cd "$WORKTREE"
echo "arm evolve=$EVOLVE  model=$MODEL  sha=$SHA  tasks=${#TASKS[@]}  concurrency=$CONCURRENCY"
echo "job=$JOB_NAME  jobs-dir=$JOBS_DIR"

exec harbor run \
  --agent bench.harbor.kinu_agent:KinuAgent \
  --path "$CORPUS" \
  "${TASK_FLAGS[@]}" \
  -m "$MODEL" \
  --ak "evolve=$EVOLVE" \
  --allow-agent-host staging.kinu.run \
  --jobs-dir "$JOBS_DIR" \
  --job-name "$JOB_NAME" \
  -n "$CONCURRENCY" \
  -k 1 \
  -q -y
