#!/bin/sh
# The locked install with its `prepare` hook, as the user in the checkout, once per armada environment, and the smoke
# every shard depends on. The bun cache stays: scripts/patch-parity.ts reads its pristine trees.
set -eu
PATH=/usr/local/bin:/usr/bin:/bin bun install --frozen-lockfile
node_modules/.bin/bun --version
node_modules/.bin/workerd --version
google-chrome --version
bwrap --unshare-all --die-with-parent --ro-bind / / true
ffmpeg -version | head -n 1
# The Lean toolchains the proofs pin (lean/ and packages/devbox/proof) and both builds, for `bun run verify:lean`,
# which a deploy runs on armada (ARMADA_DEPLOY_ROWS in scripts/ladder.ts). elan comes from a named release whose sha256
# is checked before it runs, as .github/actions/setup-lean does. Built once per environment; a task's checkout keeps
# `.lake`, so a run rebuilds only what its commit changed.
elan_work="$(mktemp -d)"
curl -fsSL --retry 3 -o "$elan_work/elan.tar.gz" https://github.com/leanprover/elan/releases/download/v4.2.4/elan-x86_64-unknown-linux-gnu.tar.gz
printf '%s  %s\n' 42b94d4244e8353142c456ec0e4ca6528fd898a6c604d4059f494e706e431f63 "$elan_work/elan.tar.gz" | sha256sum --check --strict
tar -xzf "$elan_work/elan.tar.gz" -C "$elan_work"
"$elan_work/elan-init" -y --default-toolchain none --no-modify-path
rm -rf "$elan_work"
(cd lean && "$HOME/.elan/bin/lake" build)
(cd packages/devbox/proof && "$HOME/.elan/bin/lake" build)
