#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/packages/cf-backend/dist/client/downloads/proteus-source.tar.gz}"

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

tar -czf "$tmp/proteus-source.tar.gz" -C "$tmp" proteus
mv "$tmp/proteus-source.tar.gz" "$OUT"

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$(dirname "$OUT")" && sha256sum "$(basename "$OUT")" > "$(basename "$OUT").sha256")
elif command -v shasum >/dev/null 2>&1; then
  (cd "$(dirname "$OUT")" && shasum -a 256 "$(basename "$OUT")" > "$(basename "$OUT").sha256")
fi
