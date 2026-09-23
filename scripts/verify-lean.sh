#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../lean"
lake build
bash check-no-false.sh

# The refinement fixtures are the model's own output: write them afresh and refuse drift.
rm -rf .lake/fixtures-check
lake env lean --run RefinementFixtures.lean .lake/fixtures-check
if ! diff -r fixtures .lake/fixtures-check >&2; then
  echo 'verify-lean: lean/fixtures is not what the model generates. In lean/, run' \
    '`lake env lean --run RefinementFixtures.lean fixtures` and review the diff.' >&2
  exit 1
fi

node check-traceability.mjs
bun ../scripts/lean-citations.ts

# The deployed code on those fixtures: exactly the tests lean/traceability.yaml names.
mapfile -t refinement_tests < <(node check-traceability.mjs --list-refinement-tests)
for package in $(printf '%s\n' "${refinement_tests[@]}" | sed 's|/tests/.*||' | sort -u); do
  tests=()
  for test in "${refinement_tests[@]}"; do
    if [[ "$test" == "$package/tests/"* ]]; then tests+=("${test#"$package"/}"); fi
  done
  (cd "../$package" && bun test "${tests[@]}")
done

# Devbox's lifecycle corpus uses its own pinned Lean toolchain.
cd ../packages/devbox/proof
lake build
