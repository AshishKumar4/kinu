#!/bin/sh
# The locked install with its `prepare` hook, as the user in the checkout, once per cf-ci environment, and the smoke
# every shard depends on. The bun cache stays: scripts/patch-parity.ts reads its pristine trees.
set -eu
PATH=/usr/local/bin:/usr/bin:/bin bun install --frozen-lockfile
node_modules/.bin/bun --version
node_modules/.bin/workerd --version
google-chrome --version
bwrap --unshare-all --die-with-parent --ro-bind / / true
ffmpeg -version | head -n 1
