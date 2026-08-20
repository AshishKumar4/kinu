#!/usr/bin/env bash
#
# Prepare a git worktree to run this repo's suites.
#
# A fresh worktree has no node_modules, and the obvious shortcut — symlinking or
# copying the main checkout's — is the bug this script exists to prevent: every
# entry inside that directory, `@kinu` included, then resolves through the
# main checkout, so `@kinu/core` is MAIN's core and the branch under test is
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
  # `bun install` in an empty tree dies before installing anything: bunfig's
  # security scanner (scripts/security-scanner.ts) imports valibot, which is
  # not installed yet — SecurityScannerNotInDependencies, a bootstrap deadlock.
  # Seed exactly the scanner's own import so the install it guards can run.
  if [ ! -e "$TREE/node_modules/valibot" ] && [ -e "$MAIN/node_modules/valibot" ]; then
    mkdir -p "$TREE/node_modules"
    ln -s "$MAIN/node_modules/valibot" "$TREE/node_modules/valibot"
    echo "Seeded node_modules/valibot so the security scanner can load during that install." >&2
  fi
  exit 1
fi

# Mirror one node_modules directory: every entry symlinked to the donor's, except
# the workspace scope, which is rebuilt locally against THIS tree's packages.
# The workspace scope is DERIVED from this tree's own packages, never
# hardcoded: the product scope has been renamed before, and a hardcoded scope
# leaves every fresh worktree after such a rename with an empty scope directory
# that fails workspace resolution.
SCOPES="$(sed -n 's|.*"name"[[:space:]]*:[[:space:]]*"\(@[^/"]*\)/[^"]*".*|\1|p' "$TREE"/packages/*/package.json | sort -u)"
if [ -z "$SCOPES" ]; then
  echo "No workspace scope found in $TREE/packages/*/package.json - refusing to mirror blind." >&2
  exit 1
fi

mirror() {
  local src="$1" dst="$2"
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
  for scope in $SCOPES; do
    # Only where the donor HAS the scope (the top-level node_modules): a nested
    # per-package node_modules never carries it, and the ../../packages link
    # depth below is only correct from the top level.
    [ -d "$src/$scope" ] || continue
    rm -rf "${dst:?}/$scope"
    mkdir -p "$dst/$scope"
    for pkg in "$TREE"/packages/*/; do
      [ -f "$pkg/package.json" ] || continue
      name="$(sed -n 's|.*"name"[[:space:]]*:[[:space:]]*"'"$scope"'/\([^"]*\)".*|\1|p' "$pkg/package.json" | head -1)"
      [ -n "$name" ] || continue
      ln -sfn "../../packages/$(basename "$pkg")" "$dst/$scope/$name"
    done
  done
}

mirror "$MAIN/node_modules" "$TREE/node_modules"
# Nested per-package trees carry pinned versions (cf-backend's own typescript).
for nested in "$MAIN"/packages/*/node_modules; do
  [ -d "$nested" ] || continue
  mirror "$nested" "$TREE/packages/$(basename "$(dirname "$nested")")/node_modules"
done

cd "$TREE"
bun test packages/*/tests/workspace-resolution.test.ts >/dev/null

# The commit and push tiers are hooks, and a hook nobody installs is a hook that
# does not exist — `core.hooksPath` defaults to the untracked, sample-only
# `.git/hooks`, which is how both tiers came to be decorative. The value written
# is relative and worktrees share this config, so this covers every checkout at
# once; it is repeated here because a fresh worktree is exactly where nobody
# remembers to run it.
bun scripts/ladder.ts --install-hooks

echo "Worktree ready: workspace scope(s) $SCOPES resolve inside $TREE"
