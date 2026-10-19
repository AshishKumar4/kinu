#!/usr/bin/env bash
# The macOS half of the daemon's held-directory file access (L111 #1 and #2), proved on a Mac.
#
# On macOS the daemon reaches a judged path through libSystem's *at calls and lists a directory through its own
# descriptor (fdopendir and readdir, `$INODE64` on x86_64), with metadata from fstatat. None of that runs on Linux, where
# the same tests run through /proc/self/fd, so it is unproved until this script runs on a Mac.
#
# It runs, on this Mac:
#   1. one listing, one stat and one held write of a scratch directory, straight through held.js, printing what each
#      answered: the libc bindings load, the 64-bit-inode layouts read, and a made file has the mode asked;
#   2. every test of the daemon's file confinement: the swap races (a command swapping a link into a path while
#      frames run), listings, stats, and writes that name the bytes they replace;
#   3. what macOS's own Screen Sharing listens on (1014-t, the PC desktop): every socket on TCP 5900 and the address
#      it is bound to, and the firewall's state. It reads and changes nothing; run it with Screen Sharing turned on
#      (System Settings › General › Sharing) for the measurement to say anything, and turn it back off after.
#
# Usage, from the repository root on a Mac, after `bun install`:
#
#   bash packages/pc-agent/scripts/mac-held-proof.sh
#
# It writes nothing outside its own scratch directories and installs nothing. Paste the whole final block back.
set -uo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This script proves the daemon's macOS file access and must run on a Mac; this is $(uname -s)."
  exit 64
fi

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
source "$REPO/scripts/repo-runtime.sh"
SCRATCH="$(mktemp -d /tmp/kinu-mac-held.XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT

echo "== this Mac =="
sw_vers 2>/dev/null
echo "arch: $(uname -m)  bun: $(bun --version)"

echo "== held.js on this Mac, directly =="
direct="$(cd "$REPO" && KINU_HELD_SCRATCH="$SCRATCH" bun -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const { atJudged } = require("./packages/pc-agent/src/daemon/held.js");
  const dir = fs.realpathSync(process.env.KINU_HELD_SCRATCH);
  fs.mkdirSync(path.join(dir, "sub"));
  fs.writeFileSync(path.join(dir, "a.txt"), "abc");
  fs.symlinkSync("/etc", path.join(dir, "link"));
  const view = { raw: false };
  const answers = {};
  const record = (name, act) => { try { answers[name] = act(); } catch (cause) { answers[name] = `refused ${cause.code}: ${cause.message}`; } };
  record("list", () => atJudged(view, dir, {}, (at) => at.list((entries) => entries
    .map((entry) => `${entry.name}:${entry.isSymbolicLink() ? "link" : entry.isDirectory() ? "dir" : "file"}:${entry.stat().size}`)
    .sort((a, b) => a.localeCompare(b)))));
  record("stat", () => { const stat = atJudged(view, path.join(dir, "a.txt"), {}, (at) => at.stat()); return `size ${stat.size}, mtime ${new Date(stat.mtimeMs).toISOString()}`; });
  record("write", () => {
    const fd = atJudged(view, path.join(dir, "made", "b.txt"), { createParents: true }, (at) => at.open(fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC, 0o640));
    fs.closeSync(fd);
    const got = fs.statSync(path.join(dir, "made", "b.txt")).mode & 0o777;
    const asked = 0o640 & ~process.umask();
    return got === asked ? `mode ${got.toString(8)}, as asked` : `mode ${got.toString(8)}, asked ${asked.toString(8)}`;
  });
  console.log(JSON.stringify(answers, null, 2));
' 2>&1)"
echo "$direct"

direct_ok=no
if echo "$direct" | grep -q '"a.txt:file:3"' && echo "$direct" | grep -q '"link:link:' && echo "$direct" | grep -q '"sub:dir:' \
  && echo "$direct" | grep -q '"stat": "size 3' && echo "$direct" | grep -q '"write": "mode [0-7]*, as asked"'; then
  direct_ok=yes
fi

echo "== the daemon's file confinement tests =="
suite="$(cd "$REPO" && bun test --timeout=120000 packages/pc-agent/tests/daemon.test.js \
  -t 'daemon device path confinement|a write that names the bytes it replaces' 2>&1)"
echo "$suite" | grep -E '^\((pass|fail)\)' | sed 's/ \[[0-9.]*m\?s\]$//'
passed="$(echo "$suite" | grep -Ec '^\(pass\)')"
failed="$(echo "$suite" | grep -Ec '^\(fail\)')"

echo "== what Screen Sharing listens on (TCP 5900) =="
listeners="$(netstat -anv -p tcp 2>/dev/null | awk 'NR <= 2 || /\.5900 /' | grep -E 'LISTEN|Proto|Local' )"
echo "$listeners"
owned="$(sudo -n lsof -nP -iTCP:5900 -sTCP:LISTEN 2>/dev/null || echo '(lsof needs sudo for a root-owned listener; skipped)')"
echo "$owned"
firewall="$(/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate 2>/dev/null) $(/usr/libexec/ApplicationFirewall/socketfilterfw --getstealthmode 2>/dev/null)"
echo "$firewall"

echo
echo "===== paste from here ====="
echo "mac-held-proof $(git -C "$REPO" rev-parse --short HEAD) on $(sw_vers -productVersion 2>/dev/null) $(uname -m), bun $(bun --version)"
echo "direct held.js: $direct_ok"
echo "$direct" | tr -d '\n' | head -c 1200
echo
echo "confinement tests: $passed passed, $failed failed"
echo "$suite" | grep -E '^\(fail\)' | head -20
echo "tcp 5900 listeners:"
echo "$listeners" | grep LISTEN || echo "  none (Screen Sharing off?)"
echo "$owned" | tail -n +1 | head -5
echo "firewall: $firewall"
echo "===== to here ====="

[ "$direct_ok" = yes ] && [ "$failed" = 0 ] && [ "$passed" -gt 0 ]
