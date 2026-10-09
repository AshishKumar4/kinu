#!/bin/sh
# The CI tier's system, as root, once per armada environment (.armada.json), on top of armada's own runner layer
# (git as a GitHub runner has it, iproute2, strace, procps, zip, a compiler, tini): Chrome where
# scripts/test-chrome.ts looks for it, bubblewrap and ffmpeg for the sandbox and media suites, the squashfs
# tools the devbox suites spawn, GNU time for scripts/gate-cost-measure.ts, fonts, and a bootstrap bun only to run
# the install, after which every row runs the lock's.
set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends bubblewrap ffmpeg squashfs-tools time libcap2-bin fonts-liberation fonts-dejavu-core fonts-noto-color-emoji
subject_capability=cap_net_raw
install -m 755 /usr/bin/sleep /usr/local/bin/kinu-cap-subject
setcap "$subject_capability+ep" /usr/local/bin/kinu-cap-subject
curl -fsSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
apt-get install -y -qq --no-install-recommends /tmp/chrome.deb
rm -f /tmp/chrome.deb
curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash >/dev/null
apt-get clean
rm -rf /var/lib/apt/lists/*
