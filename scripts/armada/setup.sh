#!/bin/sh
# The CI tier's system, as root, once per armada environment (.armada.json), on top of armada's own runner layer
# (git as a GitHub runner has it, iproute2, strace, procps, zip, a compiler, tini): Chrome where
# scripts/test-chrome.ts looks for it, bubblewrap and ffmpeg as .github/workflows/ci.yml installs them, the squashfs
# tools the devbox suites spawn, fonts, and a bootstrap bun only to run the install, after which every row runs the
# lock's.
set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends bubblewrap ffmpeg squashfs-tools fonts-liberation fonts-dejavu-core fonts-noto-color-emoji
curl -fsSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
apt-get install -y -qq --no-install-recommends /tmp/chrome.deb
rm -f /tmp/chrome.deb
curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash >/dev/null
apt-get clean
rm -rf /var/lib/apt/lists/*
