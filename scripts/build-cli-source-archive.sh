#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# The deployed asset dir is packages/cf-backend/dist/client, from both configs
# wrangler can pick: the user config (wrangler.jsonc, "dist/client") and the
# vite plugin's redirect target (dist/kinu/wrangler.json, "../client").
# dist/kinu/assets/ is NOT an asset dir — it is the worker bundle's
# code-split chunk output, uploaded as worker modules. See scripts/deploy.sh.
OUT="${1:-$ROOT/packages/cf-backend/dist/client/downloads/kinu-source.tar.gz}"

tmp="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp"
}
trap cleanup EXIT INT TERM

stage="$tmp/kinu"
mkdir -p "$stage" "$(dirname "$OUT")"

paths=(
  package.json
  bun.lock
  packages
  patches
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

# The archive is an installed CLI distribution, not a Git checkout. The root
# prepare hook installs this repository's commit gates and imports source files
# intentionally omitted from the distribution. Keep every other script for
# source inspection, but never run development hook installation on end users.
node -e "
  const fs = require('fs');
  const path = '$stage/package.json';
  const manifest = require(path);
  if (manifest.scripts) delete manifest.scripts.prepare;
  fs.writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
"

# The distribution must resolve its lockfile the same way on every Bun.
#
# bunfig.toml is NOT in `paths`, and it must not be: it points `bun install` at
# ./scripts/security-scanner.ts and `bun test` at ./scripts/test-preload.ts,
# neither of which the distribution ships, and a bunfig naming an absent
# scanner makes `bun install` exit 1 outright. But one line of it IS
# load-bearing here — `[install] linker`. Bun 1.3.0 and 1.3.1 default a
# WORKSPACE to the isolated linker, and 1.3.1 predates the `configVersion`
# field this lockfile carries, so it cannot read the "hoisted" intent recorded
# there. Under isolated linking a package sees only what it declares, and this
# monorepo shares its runtime dependencies through the root manifest — so
# `packages/core` lost `@ai-sdk/provider-utils` and the installed CLI died on
# launch with `Cannot find module` on a fresh machine. Stamp the repository's
# own linker into a minimal distribution bunfig: one source of truth, carried.
linker="$(
  node -e "
    const text = require('fs').readFileSync('$ROOT/bunfig.toml', 'utf8');
    const match = /^\s*linker\s*=\s*[\"']([^\"']+)[\"']/m.exec(text);
    process.stdout.write(match ? match[1] : '');
  "
)"
if [ -z "$linker" ]; then
  echo "build-cli-source-archive: bunfig.toml declares no [install] linker — the" >&2
  echo "distribution's resolution would depend on the installing Bun's default." >&2
  exit 1
fi
cat > "$stage/bunfig.toml" <<EOF
# Kinu CLI distribution. Pinned from the repository's bunfig.toml so an install
# resolves bun.lock identically on every Bun version, whatever that version
# defaults a workspace to.
[install]
linker = "$linker"
EOF

# Stamp the build into the CLI version (semver build metadata) so installed
# binaries are distinguishable: "0.1.0+abc1234". package.json stays the single
# version source; the sha only exists in the shipped archive.
sha="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo dev)"
node -e "
  const p = require('$stage/packages/cli/package.json');
  p.version = p.version.split('+')[0] + '+' + process.argv[1];
  require('fs').writeFileSync('$stage/packages/cli/package.json', JSON.stringify(p, null, 2) + '\n');
" "$sha"

tar -czf "$tmp/kinu-source.tar.gz" -C "$tmp" kinu
mv "$tmp/kinu-source.tar.gz" "$OUT"

# Publish the served build's version alongside the archive so an installed CLI
# can ask "is there anything newer?" without downloading it. Written from the
# SAME stamped package.json the archive ships — one stamping site, one source.
node -e "
  const { version } = require('$stage/packages/cli/package.json');
  const out = JSON.stringify({ version, sha: process.argv[1], builtAt: new Date().toISOString() });
  require('fs').writeFileSync(process.argv[2], out + '\n');
" "$sha" "$(dirname "$OUT")/kinu-version.json"

# The shim verifies this checksum on every install and update; failing to
# write it is a broken publish, not a soft miss.
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$(dirname "$OUT")" && sha256sum "$(basename "$OUT")" > "$(basename "$OUT").sha256")
elif command -v shasum >/dev/null 2>&1; then
  (cd "$(dirname "$OUT")" && shasum -a 256 "$(basename "$OUT")" > "$(basename "$OUT").sha256")
else
  echo "build-cli-source-archive: no sha256sum or shasum — cannot publish the archive checksum" >&2
  exit 1
fi
