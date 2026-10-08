export const DESKTOP_PORT = 6080;

const LOG = '/tmp/devbox-desktop.log';

/** The session's own files: its two launchers and its panel's configuration. */
const SESSION = '/usr/local/share/devbox/desktop';

/** The screen, which the client scales to its frame. */
export const DESKTOP_SIZE = { width: 1280, height: 800 } as const;

/** What a fresh desktop shows behind every window, and the panel along its foot (D80). */
export const DESKTOP_COLOURS = { background: '#3b4252', panel: '#20242b' } as const;

/** The panel's height; its launchers sit at its left, each centred this far from the screen's left edge. */
export const DESKTOP_PANEL = { height: 36, launchers: { terminal: 24, browser: 60 } } as const;

const launcher = (name: string, exec: string, icon: string) => ['[Desktop Entry]', 'Type=Application', `Name=${name}`, `Exec=${exec}`, `Icon=${icon}`]
  .map((line) => `'${line}'`).join(' ');

/**
 * tint2: launchers (terminal, then browser), the open windows, a clock. The padding fixes the launchers' centres. Its
 * backgrounds come first: an id is resolved as it is read, and one not yet defined is the transparent 0, a black panel.
 */
const PANEL = `rounded = 0
border_width = 0
background_color = ${DESKTOP_COLOURS.panel} 100
border_color = #000000 0
rounded = 4
border_width = 0
background_color = #4c566a 100
border_color = #000000 0
panel_items = LTC
panel_size = 100% ${String(DESKTOP_PANEL.height)}
panel_position = bottom center horizontal
panel_padding = 6 4 6
panel_background_id = 1
panel_layer = top
strut_policy = follow_size
wm_menu = 1
launcher_padding = 4 2 8
launcher_background_id = 0
launcher_icon_size = 28
launcher_item_app = ${SESSION}/terminal.desktop
launcher_item_app = ${SESSION}/browser.desktop
taskbar_mode = single_desktop
taskbar_padding = 4 0 4
task_text = 1
task_icon = 1
task_maximum_size = 200 28
task_padding = 6 2 4
task_font_color = #d8dee9 100
task_background_id = 0
task_active_background_id = 2
time1_format = %H:%M
clock_font_color = #d8dee9 100
clock_padding = 8 0`;

/**
 * The first open starts the session; a later one finds it running. A window manager, a panel with a terminal and a
 * browser to launch, and a background, so a fresh desktop is a desktop and not a black screen (D80).
 */
export const DESKTOP_START = `cd /
printf '%s\\n' 'export CHROMIUM_FLAGS="$CHROMIUM_FLAGS --no-sandbox --disable-gpu --disable-dev-shm-usage --disable-component-update"' > /etc/chromium.d/devbox
mkdir -p ${SESSION}
printf '%s\\n' ${launcher('Terminal', 'sh -c "cd /workspace 2>/dev/null; exec xterm -fa Monospace -fs 11"', '/usr/share/pixmaps/xterm-color_48x48.xpm')} > ${SESSION}/terminal.desktop
printf '%s\\n' ${launcher('Browser', 'chromium', '/usr/share/icons/hicolor/48x48/apps/chromium.png')} > ${SESSION}/browser.desktop
cat > ${SESSION}/tint2rc <<'PANEL'
${PANEL}
PANEL
if ! pgrep -x Xkasmvnc >/dev/null; then
  setsid Xkasmvnc :0 -geometry ${String(DESKTOP_SIZE.width)}x${String(DESKTOP_SIZE.height)} -depth 24 -interface 0.0.0.0 -websocketPort ${String(DESKTOP_PORT)} \\
    -DisableBasicAuth 1 -sslOnly 0 -SecurityTypes None -AlwaysShared -publicIP 127.0.0.1 >${LOG} 2>&1 </dev/null &
  server=$!
fi
until (exec 3<>/dev/tcp/127.0.0.1/${String(DESKTOP_PORT)}) 2>/dev/null; do
  pgrep -x Xkasmvnc >/dev/null || { [ -n "\${server-}" ] && kill -0 "$server" 2>/dev/null; } || { tail -n 20 ${LOG} >&2; exit 1; }
  sleep 0.05
done
if ! pgrep -x openbox >/dev/null; then
  DISPLAY=:0 setsid openbox >/dev/null 2>&1 </dev/null &
  wm=$!
  until pgrep -x openbox >/dev/null; do kill -0 "$wm" 2>/dev/null || exit 1; sleep 0.01; done
fi
DISPLAY=:0 xsetroot -solid '${DESKTOP_COLOURS.background}'
if ! pgrep -x tint2 >/dev/null; then
  DISPLAY=:0 setsid tint2 -c ${SESSION}/tint2rc >>${LOG} 2>&1 </dev/null &
  panel=$!
  until DISPLAY=:0 xdotool search --class tint2 >/dev/null 2>&1; do kill -0 "$panel" 2>/dev/null || { tail -n 20 ${LOG} >&2; exit 1; }; sleep 0.02; done
fi`;
