#!/usr/bin/env bash
#
# Prepare a git worktree to run this repo's suites.
#
# A fresh worktree has no node_modules, and the obvious shortcut — symlinking or
# copying the main checkout's — is the bug this script exists to prevent: every
# entry inside that directory, `@kinu` included, then resolves through the
# main checkout, so `@kinu.run/core` is MAIN's core and the branch under test is
# never loaded. Tests and typechecks pass while measuring the wrong tree.
#
# So: link third-party dependencies per entry (they are shared and identical),
# and give this tree its own real `@kinu` scope directory pointing at its own
# packages/. Idempotent — re-run it after adding a package.
#
#   bash scripts/setup-worktree.sh
#
# Dependencies themselves still come from the main checkout, so a branch that
# CHANGED package.json/bun.lock must run `bun install` in the worktree instead;
# this script says so rather than lying about it.

set -euo pipefail

TREE="$(git rev-parse --show-toplevel)"
MAIN="$(dirname "$(cd "$(git rev-parse --git-common-dir)" && pwd)")"

if [ "$TREE" = "$MAIN" ]; then
  echo "This is the main checkout — run 'bun install' here, not this script." >&2
  exit 1
fi
if [ ! -d "$MAIN/node_modules" ]; then
  echo "The main checkout ($MAIN) has no node_modules — run 'bun install' there first." >&2
  exit 1
fi
if ! cmp -s "$TREE/bun.lock" "$MAIN/bun.lock"; then
  echo "bun.lock differs from the main checkout: this branch changed dependencies." >&2
  echo "Borrowed modules would be the wrong ones — run 'bun install' in $TREE instead." >&2
  exit 1
fi

# Mirror one node_modules directory: every entry symlinked to the donor's, except
# the workspace scopes, which are rebuilt locally against THIS tree's workspaces.
# Both are DERIVED from the root manifest's `workspaces`, never hardcoded: the
# product scope has been renamed before, and the vendored `@mossaic/sdk` lives
# outside packages/. Read from packages/* alone, its scope stayed a link into the
# main checkout, so this tree's cf-backend loaded the main checkout's SDK.
WORKSPACES="$(bun -e 'const root = Bun.argv[1]; const dirs = new Set(); for (const pattern of JSON.parse(await Bun.file(`${root}/package.json`).text()).workspaces) for (const file of new Bun.Glob(`${pattern}/package.json`).scanSync({ cwd: root })) dirs.add(file.slice(0, -"/package.json".length)); process.stdout.write([...dirs].sort().join("\n"));' "$TREE")"
SCOPES="$(bun -e 'const scopes = new Set(); for (const file of Bun.argv.slice(1)) { const name = JSON.parse(await Bun.file(file).text()).name; if (!name.startsWith("@")) continue; const slash = name.indexOf("/"); if (slash < 2) throw new Error("Invalid package name in " + file); scopes.add(name.slice(0, slash)); } process.stdout.write([...scopes].sort().join("\n"));' $(printf "$TREE/%s/package.json " $WORKSPACES))"
if [ -z "$SCOPES" ]; then
  echo "No workspace scope found in the workspaces of $TREE/package.json - refusing to mirror blind." >&2
  exit 1
fi

mirror() {
  local src="$1" dst="$2" top="${3:-}"
  # A pre-existing wholesale symlink is exactly the failure mode being repaired.
  [ -L "$dst" ] && rm -f "$dst"
  mkdir -p "$dst"
  local entry name scope pkg
  for entry in "$src"/* "$src"/.[!.]*; do
    [ -e "$entry" ] || continue
    name="$(basename "$entry")"
    case " $SCOPES " in *" $name "*) continue ;; esac
    # Replace rather than link-into: `ln -sfn` onto an existing real directory
    # would nest the link inside it.
    rm -rf "${dst:?}/$name"
    ln -s "$entry" "$dst/$name"
  done
  # The workspace scope belongs to the TOP-LEVEL node_modules only: the
  # ../../<workspace> depth below is correct from nowhere else, and a nested
  # per-package tree never carries a workspace scope. Whether the DONOR has the
  # scope is a different question and was the wrong test — a scope this tree's
  # packages declare but the donor has not installed yet is exactly the case
  # that must still be built. Using the donor as the proxy left the vendored
  # @agent-core scope absent from every worktree mirrored before its install,
  # and workspace resolution then failed naming a package the tree really has.
  [ -n "$top" ] || return 0
  for scope in $SCOPES; do
    rm -rf "${dst:?}/$scope"
    mkdir -p "$dst/$scope"
    for dir in $WORKSPACES; do
      pkg="$TREE/$dir"
      [ -f "$pkg/package.json" ] || continue
      name="$(bun -e 'const [scope, file] = Bun.argv.slice(1); const name = JSON.parse(await Bun.file(file).text()).name; if (name.startsWith(scope + "/")) process.stdout.write(name.slice(scope.length + 1));' "$scope" "$pkg/package.json")"
      [ -n "$name" ] || continue
      ln -sfn "../../$dir" "$dst/$scope/$name"
    done
  done
}

mirror "$MAIN/node_modules" "$TREE/node_modules" top
# Nested per-workspace trees carry pinned versions (cf-backend's and the SDK's own typescript).
for dir in $WORKSPACES; do
  [ -d "$MAIN/$dir/node_modules" ] || continue
  mirror "$MAIN/$dir/node_modules" "$TREE/$dir/node_modules"
done

cd "$TREE"
# The vendored SDK now resolves to this tree's copy, and its export map points at
# `dist/`, which the root `prepare` hook builds and a linked worktree never runs.
sdk_out="$(bun scripts/mossaic-sdk.ts 2>&1)" || { printf '%s\n' "$sdk_out"; exit 1; }
# Quiet on success, loud on failure: the suite names the fix command, and a
# plain redirect hid exactly that line.
resolution_out="$(bun scripts/ladder.ts --run bun test --timeout=0 packages/*/tests/workspace-resolution.test.ts 2>&1)" \
  || { printf '%s\n' "$resolution_out"; exit 1; }

# The commit and push tiers are hooks, and a hook nobody installs is a hook that
# does not exist — `core.hooksPath` defaults to the untracked, sample-only
# `.git/hooks`, which is how both tiers came to be decorative. The value written
# is relative and worktrees share this config, so this covers every checkout at
# once; it is repeated here because a fresh worktree is exactly where nobody
# remembers to run it.
bun scripts/ladder.ts --install-hooks

echo "Worktree ready: workspace scope(s) $SCOPES resolve inside $TREE"
