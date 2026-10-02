#!/usr/bin/env bash
# Sourced by hooks, shell entry points and CI after dependency installation.
runtime_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)" || exit 1
if [ ! -x "$runtime_root/node_modules/.bin/bun" ]; then
  printf "repo-runtime: install this checkout's dependencies before running it.\n" >&2
  exit 1
fi
export PATH="$runtime_root/node_modules/.bin:$PATH"
unset runtime_root
