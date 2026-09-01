#!/usr/bin/env bash
#
# The nightly mutation pilot: run `scripts/mutation-pilot.ts` unattended, in a
# worktree of its own, and leave the report where a human can read it.
#
# WHY A WRAPPER EXISTS AT ALL. The pilot mutates source IN PLACE — the reason is
# in its header, and it is measured: a sandbox copy resolves `@kinu.run/*`
# through the donor's node_modules to the pristine package, so two thirds of a
# mutant's own defenders would never see it. In-place mutation is only safe in a
# tree nobody else reads, so the pilot refuses the main checkout outright. A
# nightly runner therefore has to MAKE that tree, and this script is that step:
# a detached worktree at the ref under test, `setup-worktree.sh` for its own
# workspace scope, the pilot, then teardown in a trap so an interrupted run
# leaves no worktree and no mutant behind.
#
# NOT A GATE, and deliberately not in any tier. It costs minutes per mutant,
# its output is a reading list rather than a verdict, and a survivor is a
# candidate for a new fence in `scripts/mutation-fences.ts` — which IS a gate.
# The two are the loop: the pilot searches, a human reads, a fence pins what the
# reading found, and the gate re-proves it on every run.
#
#   bash scripts/nightly-mutation.sh                 # 24 mutants at HEAD
#   bash scripts/nightly-mutation.sh --budget 40
#   bash scripts/nightly-mutation.sh --ref main --budget 12
#
# Exit status is the pilot's own, and a survivor is NOT a failure: this reports.
# A non-zero exit means the run could not be made — no worktree, no modules, or
# a baseline that was already red, which is the one condition that would make
# every kill meaningless.

set -euo pipefail

REF="HEAD"
BUDGET="24"
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="$2"; shift 2 ;;
    --budget) BUDGET="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

MAIN="$(git rev-parse --show-toplevel)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
# `kinu-scratch-` is the catalogued prefix: preflight counts and reclaims by
# prefix, so a scratch directory outside it is both uncollected and invisible.
TREE="$(mktemp -d "${TMPDIR:-/tmp}/kinu-scratch-mutation-pilot-XXXXXX")"
REPORT="${TMPDIR:-/tmp}/kinu-scratch-mutation-pilot-${STAMP}.txt"

cleanup() {
  # Force, because the pilot restores its own bytes but a killed run may not
  # have: the worktree is disposable and the main checkout must never inherit a
  # mutant.
  git -C "$MAIN" worktree remove --force "$TREE" >/dev/null 2>&1 || true
  rm -rf "$TREE"
}
trap cleanup EXIT INT TERM

git -C "$MAIN" worktree add --detach "$TREE" "$REF" >/dev/null
bash "$TREE/scripts/setup-worktree.sh" >/dev/null

echo "mutation pilot: ref $(git -C "$TREE" rev-parse --short HEAD), budget ${BUDGET}"
echo "report: ${REPORT}"

set +e
(cd "$TREE" && bun scripts/mutation-pilot.ts --budget "$BUDGET") 2>&1 | tee "$REPORT"
STATUS="${PIPESTATUS[0]}"
set -e

# The survivors are the point, so they are repeated at the end where a nightly
# log is read from the bottom.
if grep -q '^  SURVIVED' "$REPORT"; then
  echo
  echo "survivors — each one is a decision no packages/core suite noticed changing:"
  grep -A 4 '^  SURVIVED' "$REPORT"
fi

exit "$STATUS"
