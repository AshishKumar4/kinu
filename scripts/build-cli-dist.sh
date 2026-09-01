#!/usr/bin/env bash
set -euo pipefail

# Build the CLI once, here, and publish the result.
#
# The CLI used to ship as a source archive. Every fresh install ran
# `bun install --frozen-lockfile` on the whole monorepo — measured on
# 2026-09-01, cold, on a 12900K: 13.35 s of a 16.08 s install, 950 packages,
# 105,648 files and 1.9 GB of the user's disk, with the workerd postinstall
# shelling out to `npm install` for a binary. All of it for a program the
# bundler resolves to 1112 modules in ~100 ms.
#
# So the dependency graph is resolved here and the user gets the result:
# download Bun if absent, download the build, unpack. No package manager runs
# on the user's machine, no registry has to be up, and no postinstall script
# runs there at all.
#
# Three things cannot bundle. They travel as files beside cli.js, in the
# artifact's own node_modules:
#   - @nimbus-sh/runtime-bash and @nimbus-sh/runtime-cpython hold their blobs
#     as files and read a manifest.json next to their own module URL.
#   - @opentui/core reaches its native library through
#     `import("@opentui/core-${process.platform}-${process.arch}/index.ts")`,
#     a template the bundler cannot resolve.
#
# That native package is the only per-platform part, so the build publishes two
# things: one artifact per platform, and the CPython runtime once. Measured
# 2026-09-01: whole, an artifact is 22.19 MiB against Cloudflare's 25 MiB
# per-file asset limit, and 13.71 MiB of it is the same platform-independent
# CPython blobs repeated four times. Split, each platform artifact is ~8.5 MiB
# and the shared runtime is ~13.7 MiB. Same bytes for the user, 41 MiB less in
# the asset bundle, and both sides well under the limit.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# The deployed asset dir is packages/cf-backend/dist/client, from both configs
# wrangler can pick: the user config (wrangler.jsonc, "dist/client") and the
# vite plugin's redirect target (dist/kinu/wrangler.json, "../client").
# dist/kinu/assets/ is NOT an asset dir — it is the worker bundle's
# code-split chunk output, uploaded as worker modules. See scripts/deploy.sh.
OUT_DIR="${1:-$ROOT/packages/cf-backend/dist/client/downloads}"

# Cloudflare's static-asset limit, per file, on both plans. A file over it
# publishes nothing, and the assets route then answers the SPA shell in its
# place — the exact failure the checksum gate exists for. Caught here instead.
MAX_ASSET_BYTES=$((25 * 1024 * 1024))

PLATFORMS=(darwin-arm64 darwin-x64 linux-arm64 linux-x64)
NATIVE_SCOPE="@opentui"
# Unpacks into the same tree as a platform artifact, so the launcher extracts
# both over one directory and moves it into place once.
CPYTHON_ARTIFACT="kinu-runtime-cpython.tar.gz"
CPYTHON_PATH="node_modules/@nimbus-sh/runtime-cpython"

BUN="${BUN:-bun}"
command -v "$BUN" >/dev/null 2>&1 || { echo "build-cli-dist: bun is required" >&2; exit 1; }

MANIFEST="$ROOT/packages/cli/package.json"
MANIFEST_BACKUP="$(mktemp -t kinu-cli-manifest.XXXXXX.json)"
cp "$MANIFEST" "$MANIFEST_BACKUP"
tmp="$(mktemp -d)"
cleanup() {
  cp "$MANIFEST_BACKUP" "$MANIFEST"
  rm -rf "$tmp" "$MANIFEST_BACKUP"
}
trap cleanup EXIT INT TERM

mkdir -p "$OUT_DIR"

# Stamp the build into the CLI version (semver build metadata) so installed
# copies are distinguishable: "0.2.0+abc1234". package.json stays the single
# version source. The bundler inlines it (src/display.ts imports the manifest),
# so the stamp has to land before the build and is reverted by the trap after.
sha="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo dev)"
"$BUN" -e '
  const [path, sha] = process.argv.slice(1);
  const manifest = JSON.parse(require("fs").readFileSync(path, "utf8"));
  manifest.version = `${manifest.version.split("+")[0]}+${sha}`;
  require("fs").writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(manifest.version);
' "$MANIFEST" "$sha" > "$tmp/version"
version="$(cat "$tmp/version")"
echo "build-cli-dist: building kinu $version"

stage="$tmp/kinu"
mkdir -p "$stage"
"$BUN" build "$ROOT/packages/cli/bin/cli.ts" \
  --target=bun \
  --outdir="$stage" \
  --external '@nimbus-sh/runtime-bash' \
  --external '@nimbus-sh/runtime-cpython' \
  > "$tmp/build.log" || { cat "$tmp/build.log" >&2; echo "build-cli-dist: bun build failed" >&2; exit 1; }
[ -f "$stage/cli.js" ] || { echo "build-cli-dist: bun build wrote no cli.js" >&2; exit 1; }

# The artifact roots its own module resolution: cli.js sits beside the
# node_modules holding what could not bundle, and Bun walks up from the file.
"$BUN" -e '
  const [path, version] = process.argv.slice(1);
  const manifest = { name: "kinu", version, private: true, type: "module" };
  require("fs").writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
' "$stage/package.json" "$version"

mkdir -p "$stage/node_modules/@nimbus-sh" "$stage/node_modules/$NATIVE_SCOPE"
for runtime in runtime-bash runtime-cpython; do
  source_dir="$ROOT/node_modules/@nimbus-sh/$runtime"
  [ -d "$source_dir" ] || {
    echo "build-cli-dist: @nimbus-sh/$runtime is not installed — run bun install" >&2
    exit 1
  }
  cp -RL "$source_dir" "$stage/node_modules/@nimbus-sh/$runtime"
done

# One version for every platform's native package: the one this tree resolved.
# Reading it from the installed package rather than from a manifest range keeps
# the artifact's native half pinned to the same build as its JavaScript half.
host_arch="$("$BUN" -e 'process.stdout.write(`${process.platform}-${process.arch}`)')"
host_native="$ROOT/node_modules/$NATIVE_SCOPE/core-$host_arch"
[ -d "$host_native" ] || {
  echo "build-cli-dist: $NATIVE_SCOPE/core-$host_arch is not installed — run bun install" >&2
  exit 1
}
native_version="$("$BUN" -e '
  process.stdout.write(require(`${process.argv[1]}/package.json`).version);
' "$host_native")"
echo "build-cli-dist: native $NATIVE_SCOPE/core-* pinned at $native_version"

# The artifact this machine can execute IS executed, from the staged tree,
# before anything ships. A bundle that resolves at build time and dies at
# launch on a runtime file it cannot find is what this catches.
cp -RL "$host_native" "$stage/node_modules/$NATIVE_SCOPE/core-$host_arch"
launched="$("$BUN" run "$stage/cli.js" --version 2>&1)" || {
  echo "build-cli-dist: the built CLI did not launch: $launched" >&2
  exit 1
}
[ "$launched" = "$version" ] || {
  echo "build-cli-dist: the built CLI reports '$launched', expected '$version'" >&2
  exit 1
}
echo "build-cli-dist: staged CLI launches and reports $launched"

# One writer for every published file: size gate, then checksum, then the log
# line. A file that skips this is a file nothing measured.
publish() {
  name="$1"
  bytes="$(wc -c < "$OUT_DIR/$name")"
  if [ "$bytes" -gt "$MAX_ASSET_BYTES" ]; then
    echo "build-cli-dist: $name is $bytes bytes, over Cloudflare's" >&2
    echo "  $MAX_ASSET_BYTES-byte static-asset limit. It cannot be published as one file." >&2
    exit 1
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$OUT_DIR" && sha256sum "$name" > "$name.sha256")
  elif command -v shasum >/dev/null 2>&1; then
    (cd "$OUT_DIR" && shasum -a 256 "$name" > "$name.sha256")
  else
    echo "build-cli-dist: no sha256sum or shasum — cannot publish the checksum for $name" >&2
    exit 1
  fi
  echo "build-cli-dist: published $name ($(( bytes / 1024 )) KiB)"
}

for platform in "${PLATFORMS[@]}"; do
  # The whole scope, not just this platform's directory: the launch check above
  # staged the host's native library, and leaving it in place shipped it inside
  # every other platform's artifact.
  native_dir="$stage/node_modules/$NATIVE_SCOPE/core-$platform"
  rm -rf "$stage/node_modules/$NATIVE_SCOPE"
  mkdir -p "$stage/node_modules/$NATIVE_SCOPE"
  if [ "$platform" = "$host_arch" ]; then
    cp -RL "$host_native" "$native_dir"
  else
    # A cross-platform build cannot install a package its own os/cpu filters
    # reject, so the pinned tarball is fetched by name. A miss is fatal: an
    # artifact without its native library launches and then dies on first paint.
    tarball="$tmp/core-$platform.tgz"
    curl -fsSL \
      "https://registry.npmjs.org/$NATIVE_SCOPE/core-$platform/-/core-$platform-$native_version.tgz" \
      -o "$tarball" || {
      echo "build-cli-dist: could not fetch $NATIVE_SCOPE/core-$platform@$native_version" >&2
      exit 1
    }
    mkdir -p "$tmp/native-$platform"
    tar -xzf "$tarball" -C "$tmp/native-$platform"
    mv "$tmp/native-$platform/package" "$native_dir"
  fi

  tar -czf "$OUT_DIR/kinu-cli-$platform.tar.gz" --exclude "kinu/$CPYTHON_PATH" -C "$tmp" kinu
  publish "kinu-cli-$platform.tar.gz"
done

tar -czf "$OUT_DIR/$CPYTHON_ARTIFACT" -C "$tmp" "kinu/$CPYTHON_PATH"
publish "$CPYTHON_ARTIFACT"

# Publish the served build's version alongside the artifacts so an installed
# CLI can ask "is there anything newer?" without downloading one. Written from
# the SAME stamp the bundle carries — one stamping site, one source.
"$BUN" -e '
  const [path, version, sha] = process.argv.slice(1);
  const stamp = { version, sha, builtAt: new Date().toISOString() };
  require("fs").writeFileSync(path, `${JSON.stringify(stamp)}\n`);
' "$OUT_DIR/kinu-version.json" "$version" "$sha"
