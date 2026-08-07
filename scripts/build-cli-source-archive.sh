#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# The deployed asset dir is dist/proteus/assets (wrangler follows the vite
# plugin's .wrangler/deploy/config.json redirect) — dist/client is NOT what
# ships. Writing there bricked fresh installs with SPA-fallback 200s.
OUT="${1:-$ROOT/packages/cf-backend/dist/client/downloads/proteus-source.tar.gz}"
# Which assets dir ships depends on the wrangler invocation: bare `wrangler
# deploy` reads root wrangler.jsonc (dist/client); a redirect-honoring run
# reads dist/proteus/assets. Mirror into both so neither path bricks installs.
MIRROR="$ROOT/packages/cf-backend/dist/proteus/assets/downloads"

tmp="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp"
}
trap cleanup EXIT INT TERM

stage="$tmp/proteus"
mkdir -p "$stage" "$(dirname "$OUT")"

paths=(
  package.json
  bun.lock
  packages
)

for optional in tsconfig.json tsconfig.base.json; do
  [ -f "$ROOT/$optional" ] && paths+=("$optional")
done

tar \
  --exclude='node_modules' \
  --exclude='*/node_modules' \
  --exclude='dist' \
  --exclude='*/dist' \
  --exclude='.wrangler' \
  --exclude='.env' \
  --exclude='.env.*' \
  --exclude='.dev.vars' \
  --exclude='*.db' \
  --exclude='*.sqlite' \
  -cf - \
  -C "$ROOT" "${paths[@]}" | tar -xf - -C "$stage"

# Stamp the build into the CLI version (semver build metadata) so installed
# binaries are distinguishable: "0.1.0+abc1234". package.json stays the single
# version source; the sha only exists in the shipped archive.
sha="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo dev)"
node -e "
  const p = require('$stage/packages/cli/package.json');
  p.version = p.version.split('+')[0] + '+' + process.argv[1];
  require('fs').writeFileSync('$stage/packages/cli/package.json', JSON.stringify(p, null, 2) + '\n');
" "$sha"

tar -czf "$tmp/proteus-source.tar.gz" -C "$tmp" proteus
mv "$tmp/proteus-source.tar.gz" "$OUT"

# Publish the served build's version alongside the archive so an installed CLI
# can ask "is there anything newer?" without downloading it. Written from the
# SAME stamped package.json the archive ships — one stamping site, one source.
node -e "
  const { version } = require('$stage/packages/cli/package.json');
  const out = JSON.stringify({ version, sha: process.argv[1], builtAt: new Date().toISOString() });
  require('fs').writeFileSync(process.argv[2], out + '\n');
" "$sha" "$(dirname "$OUT")/proteus-version.json"

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$(dirname "$OUT")" && sha256sum "$(basename "$OUT")" > "$(basename "$OUT").sha256")
fi
if [ -d "$(dirname "$MIRROR")" ] || mkdir -p "$MIRROR"; then
  mkdir -p "$MIRROR"; cp "$(dirname "$OUT")"/proteus-source.tar.gz* "$(dirname "$OUT")"/proteus-version.json "$MIRROR"/ 2>/dev/null || true
elif command -v shasum >/dev/null 2>&1; then
  (cd "$(dirname "$OUT")" && shasum -a 256 "$(basename "$OUT")" > "$(basename "$OUT").sha256")
fi
