#!/usr/bin/env bash
# The Linux screen source (1014-t) proved in a real desktop session, which no test row has: a headless GNOME with
# PipeWire and the desktop portals, inside a private session bus, so nothing of the machine's own session is touched.
# It drives the daemon's own source (packages/pc-agent/src/daemon/linux-screen.js) and its embedded helper, and prints:
#   1. what the probe found;
#   2. the share: the portal's prompt, its Share pressed through AT-SPI as the person at the PC would press it;
#   3. a served frame, its size and JPEG bytes;
#   4. that input reaches the session: pointer moves draw new frames, the cursor being embedded in them;
#   5. a second open on the restore token, and how long it took with no prompt.
# Needs gnome-shell (--headless), pipewire, wireplumber, xdg-desktop-portal with its GNOME backend, and python3 with
# PyGObject's Gio, Gst and Atspi. Exits 64 where any is missing.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"

for tool in gnome-shell pipewire wireplumber dbus-run-session bun python3; do
  command -v "$tool" > /dev/null || { echo "missing $tool: this proof needs a GNOME desktop's packages" >&2; exit 64; }
done

[ -x /usr/libexec/xdg-desktop-portal ] || { echo "missing /usr/libexec/xdg-desktop-portal" >&2; exit 64; }

python3 -c "import gi; gi.require_version('Atspi', '2.0'); gi.require_version('Gst', '1.0')" 2> /dev/null \
  || { echo "missing PyGObject's Atspi or Gst bindings" >&2; exit 64; }

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/kinu-linux-screen-proof.XXXXXX")"
export SCRATCH REPO

# The person at the PC: presses Share on the portal's prompt.
export CLICKER='
import sys, time
import gi
gi.require_version("Atspi", "2.0")
from gi.repository import Atspi
Atspi.init()
for _ in range(300):
    desktop = Atspi.get_desktop(0)
    for i in range(desktop.get_child_count()):
        app = desktop.get_child_at_index(i)
        stack = [app] if app is not None else []
        while stack:
            node = stack.pop()
            try:
                if node.get_role_name() in ("push button", "button") and node.get_name() == "Share":
                    node.get_action_iface().do_action(0)
                    sys.exit(0)
                stack.extend(c for c in (node.get_child_at_index(j) for j in range(node.get_child_count())) if c is not None)
            except Exception:
                pass
    time.sleep(0.1)
sys.exit(1)
'

session() {
  # Every process this session starts ends with it: an orphan would outlive the proof.
  trap 'kill $(jobs -p) 2> /dev/null; wait 2> /dev/null' EXIT
  export XDG_RUNTIME_DIR="$SCRATCH/run" HOME="$SCRATCH/home" XDG_CURRENT_DESKTOP=GNOME XDG_SESSION_TYPE=wayland GTK_A11Y=atspi
  mkdir -p "$XDG_RUNTIME_DIR" "$HOME" && chmod 700 "$XDG_RUNTIME_DIR"
  pipewire > "$SCRATCH/pipewire.log" 2>&1 &
  wireplumber > "$SCRATCH/wireplumber.log" 2>&1 &
  gnome-shell --headless --virtual-monitor 1280x800 --no-x11 > "$SCRATCH/shell.log" 2>&1 &
  for _ in $(seq 1 100); do [ -S "$XDG_RUNTIME_DIR/wayland-0" ] && break; sleep 0.1; done
  export WAYLAND_DISPLAY=wayland-0
  dbus-update-activation-environment WAYLAND_DISPLAY XDG_CURRENT_DESKTOP XDG_SESSION_TYPE XDG_RUNTIME_DIR HOME GTK_A11Y
  bun -e '
    const { createLinuxSource } = require(`${process.env.REPO}/packages/pc-agent/src/daemon/linux-screen.js`);
    const home = `${process.env.SCRATCH}/kinu`;
    require("node:fs").mkdirSync(home, { recursive: true });
    const said = [];
    const step = (what) => console.error(`proof: ${what}`);
    const source = createLinuxSource({ home, log: (...words) => { said.push(words.join(" ")); step(words.join(" ")); } });
    const result = {};
    const probed = await source.probe();
    result.probe = probed;
    step(`probed ${JSON.stringify(probed)}`);
    const clicker = Bun.spawn(["python3", "-c", process.env.CLICKER]);
    result.share = await source.share();
    step(`shared ${JSON.stringify(result.share)}`);
    result.clicked = (await clicker.exited) === 0;
    result.desktop = source.desktop();
    const frames = [];
    const first = Promise.withResolvers();
    const screen = await source.open({ onFrame: (frame) => { frames.push(frame); first.resolve(frame); }, onEnd: (why) => said.push(`ended ${why}`) });
    step("opened");
    const frame = await first.promise;
    step("first frame");
    result.frame = { width: frame.width, height: frame.height, bytes: frame.jpeg.byteLength, jpeg: frame.jpeg[0] === 0xff && frame.jpeg[1] === 0xd8 };
    for (let move = 0; move < 20; move += 1) {
      screen.pointer(0, 200 + 30 * move, 200 + 20 * move, { x: 0, y: 0 });
      await Bun.sleep(100);
    }
    result.framesAfterMoves = frames.length - 1;
    screen.close();
    const again = Promise.withResolvers();
    const started = performance.now();
    const reopened = await source.open({ onFrame: again.resolve, onEnd: () => {} });
    result.reopenMs = Math.round(performance.now() - started);
    await again.promise;
    reopened.close();
    result.said = said;
    console.log(JSON.stringify(result, null, 2));
    const ok = probed.ok && result.share.ok && result.frame.jpeg && result.framesAfterMoves > 0 && result.reopenMs < 5000;
    process.exit(ok ? 0 : 1);
  '
}
export -f session

echo "== the Linux screen source in a headless GNOME session =="
code=0
timeout 120 dbus-run-session -- bash -c session 2> "$SCRATCH/session.err" || code=$?
echo "(session logs in $SCRATCH)"
exit "$code"
