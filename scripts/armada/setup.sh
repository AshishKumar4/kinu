#!/bin/sh
# The CI tier's system, as root, once per armada environment (.armada.json), on top of armada's own runner layer
# (git as a GitHub runner has it, iproute2, strace, procps, zip, a compiler, tini): Chrome where
# scripts/test-chrome.ts looks for it, bubblewrap and ffmpeg for the sandbox and media suites, the squashfs
# tools the devbox suites spawn, GNU time for scripts/gate-cost-measure.ts, fonts, and a bootstrap bun only to run
# the install, after which every row runs the lock's. The bootstrap is package.json's `packageManager` Bun, so the
# install runs on the Bun the rows do (release-config.test.ts holds the two equal); and TruffleHog for the verified
# secret scan.
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
curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s bun-v1.4.3 >/dev/null
# TruffleHog for the verified secret scan (scripts/verified-secret-scan.ts): the release GitHub's workflow pinned until
# the scan moved here, from its named release, whose sha256 is checked before the binary is unpacked or run.
trufflehog_work="$(mktemp -d)"
curl -fsSL --retry 3 -o "$trufflehog_work/trufflehog.tar.gz" https://github.com/trufflesecurity/trufflehog/releases/download/v3.97.1/trufflehog_3.97.1_linux_amd64.tar.gz
printf '%s  %s\n' f863ea3a8d786f7d097870496c977944cce7372a2fe1e56707d965016e543ece "$trufflehog_work/trufflehog.tar.gz" | sha256sum --check --strict
tar -xzf "$trufflehog_work/trufflehog.tar.gz" -C "$trufflehog_work" trufflehog
install -m 755 "$trufflehog_work/trufflehog" /usr/local/bin/trufflehog
rm -rf "$trufflehog_work"
apt-get clean
rm -rf /var/lib/apt/lists/*
