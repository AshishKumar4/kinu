#!/bin/sh
# The CI tier's system, as root, once per cf-ci environment (.cf-ci.json): what a GitHub runner has and the tier
# reads. Chrome where scripts/test-chrome.ts looks for it; bubblewrap and ffmpeg as .github/workflows/ci.yml installs
# them; iproute2, strace, squashfs-tools and zip, which suites spawn; git as the runner has it (trixie's 2.47 prints no
# `path=` records for `rev-list --objects -z`, which scripts/sources.ts reads), from kernel.org's pinned release; and
# a bootstrap bun only to run the install, after which every row runs the lock's.
set -eu
export DEBIAN_FRONTEND=noninteractive
GIT_VERSION=2.53.0
GIT_SHA256=5818bd7d80b061bbbdfec8a433d609dc8818a05991f731ffc4a561e2ca18c653
apt-get update -qq
apt-get install -y -qq --no-install-recommends curl unzip zip xz-utils procps psmisc lsof python3 \
  bubblewrap ffmpeg sqlite3 jq openssl tzdata iproute2 strace squashfs-tools file \
  fonts-liberation fonts-dejavu-core fonts-noto-color-emoji \
  build-essential libcurl4-openssl-dev libexpat1-dev libssl-dev zlib1g-dev libpcre2-dev
curl -fsSL -o /tmp/git.tar.xz "https://mirrors.edge.kernel.org/pub/software/scm/git/git-$GIT_VERSION.tar.xz"
echo "$GIT_SHA256  /tmp/git.tar.xz" | sha256sum -c -
tar -xJf /tmp/git.tar.xz -C /tmp
make -C "/tmp/git-$GIT_VERSION" -j4 prefix=/usr/local NO_GETTEXT=1 NO_TCLTK=1 USE_LIBPCRE2=1 all install >/dev/null
rm -rf /tmp/git.tar.xz "/tmp/git-$GIT_VERSION"
curl -fsSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
apt-get install -y -qq --no-install-recommends /tmp/chrome.deb
rm -f /tmp/chrome.deb
curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash >/dev/null
apt-get clean
rm -rf /var/lib/apt/lists/*
