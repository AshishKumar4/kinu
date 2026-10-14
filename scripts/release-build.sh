#!/usr/bin/env bash
# The deploy's build, run on armada at the exact SHA by scripts/release-build.ts: the client bundle and Worker for
# <env>, and unless promoting, the worker release artifact and the CLI distribution, unsigned. Its output is
# packages/cf-backend/dist as one tarball; the deploy signs it where the key is, and uploads it.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/repo-runtime.sh
target="$1" sha="$2" promote="${3:-}"
# The CLI's stamp is `git rev-parse --short HEAD`, which must abbreviate as the deploy's checkout did.
git config core.abbrev "${#sha}"
build_env=()
if [ "$target" = staging ]; then build_env=(CLOUDFLARE_ENV=staging); fi
# The CLI distribution reads none of the client build, so it builds beside it, into a directory of its own: vite empties
# dist/client as it writes. On armada, 2026-10-14: vite 39 to 80 s, the CLI 8 to 13 s, the worker release 7 to 10 s.
downloads="$(mktemp -d)"
cli=""
if [ "$promote" != --promote ]; then
  bash scripts/build-cli-dist.sh --unsigned "$downloads" &
  cli=$!
fi
(cd packages/cf-backend && env "${build_env[@]}" bunx vite build)
if [ "$promote" != --promote ]; then
  wait "$cli"
  # What the deploy signs, beside the build rather than among what it publishes.
  mv "$downloads/release-unsigned.json" packages/cf-backend/dist/
  mkdir -p packages/cf-backend/dist/client/downloads
  mv "$downloads"/* packages/cf-backend/dist/client/downloads/
  version="$(bun -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version.split("+")[0])' packages/cli/package.json)+$sha"
  bun scripts/build-worker-release.ts "$version" "$sha"
fi
# With the build, the redirect vite writes beside it, which points `wrangler deploy` at dist/kinu/wrangler.json. At gzip
# level 1: most of it is the CLI's own tarballs, so it is 11% larger and takes 4 to 5 s where the default took 9 to 12.
tar -cf - -C packages/cf-backend dist .wrangler/deploy | gzip -1 > "${ARMADA_OUT:?runs as an armada task}"
