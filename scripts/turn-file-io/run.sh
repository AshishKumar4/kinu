#!/usr/bin/env bash
set -euo pipefail
target_sha="$1"
shape="$2"
mode="$3"
probe_dir=$(mktemp -d)
git diff --binary 26244c765 HEAD -- scripts/turn-file-io.ts scripts/turn-file-io > "$probe_dir/probes.patch"
git switch --detach "$target_sha"
git apply "$probe_dir/probes.patch"
bun install --frozen-lockfile
(cd packages/cf-backend && bunx vite build)
if [[ "$shape" == all ]]; then
  if [[ "$mode" == all ]]; then metrics=(counts time heap); else metrics=("$mode"); fi
  for subject in short five long growth; do
    for metric in "${metrics[@]}"; do
      bun scripts/turn-file-io.ts --sha="$target_sha" --shape="$subject" --mode="$metric"
    done
  done
  if [[ "$mode" == all ]]; then bun scripts/turn-file-io.ts --sha="$target_sha" --shape=files --mode=time; fi
elif [[ "$mode" == all ]]; then
  for metric in counts time heap; do
    bun scripts/turn-file-io.ts --sha="$target_sha" --shape="$shape" --mode="$metric"
  done
else
  bun scripts/turn-file-io.ts --sha="$target_sha" --shape="$shape" --mode="$mode"
fi
