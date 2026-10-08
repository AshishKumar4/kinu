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
(cd packages/cf-backend && env "${build_env[@]}" bunx vite build)
if [ "$promote" != --promote ]; then
  version="$(bun -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version.split("+")[0])' packages/cli/package.json)+$sha"
  bun scripts/build-worker-release.ts "$version" "$sha"
  bash scripts/build-cli-dist.sh --unsigned
fi
# With the build, the redirect vite writes beside it, which points `wrangler deploy` at dist/kinu/wrangler.json.
tar -czf "${ARMADA_OUT:?runs as an armada task}" -C packages/cf-backend dist .wrangler/deploy
