import { WALLPAPER_PY } from './desktop-wallpaper';

export const DESKTOP_PORT = 6080;

/** Where the desktop's parts write what went wrong; the container tier reads it when the desktop does not paint. */
export const DESKTOP_LOG = '/tmp/devbox-desktop.log';

const LOG = DESKTOP_LOG;

/** The session's own files: its two launchers and its panel's configuration. */
const SESSION = '/usr/local/share/devbox/desktop';

/** The screen, which the client scales to its frame. 768 high: no vision model Kinu serves resizes a screenshot this size,
 *  so an agent's points are the screen's own pixels (D89). */
export const DESKTOP_SIZE = { width: 1280, height: 768 } as const;

/**
 * How `computer.watch` tiles its frames (D89): each at `percent` of the screen's width and height, scrot's own thumbnail,
 * `columns[n - 1]` to a row for `n` frames, in reading order; as many frames as `columns` has at most. Measured: four
 * half-size frames read as well as four screenshots and cost what one does; eight at a third lost small text.
 */
export const WATCH_SHEET = { percent: 50, columns: [1, 2, 2, 2, 4, 4, 4, 4] } as const;

/**
 * The desktop's look (D88): its ground falls from `background` at the top to `foot` and glows in `glow` from below the
 * panel; the panel and the windows' frames are the same warm darks, and the open window carries `glow` under its task.
 */
export const DESKTOP_COLOURS = { background: '#0F0D0B', foot: '#141110', glow: '#E0A458', panel: '#141110' } as const;

/** The panel's height; its launchers sit at its left, each centred this far from the screen's left edge. */
export const DESKTOP_PANEL = { height: 36, launchers: { terminal: 21, browser: 51 } } as const;

const launcher = (name: string, exec: string, icon: string) => ['[Desktop Entry]', 'Type=Application', `Name=${name}`, `Exec=${exec}`, `Icon=${icon}`]
  .map((line) => `'${line}'`).join(' ');

/**
 * tint2: launchers (terminal, then browser), the open windows, a clock. The padding fixes the launchers' centres. Its
 * backgrounds come first: an id is resolved as it is read, and one not yet defined is the transparent 0, a black panel.
 */
const PANEL = `rounded = 0
border_width = 1
border_sides = T
background_color = ${DESKTOP_COLOURS.panel} 100
border_color = #262019 100
rounded = 6
border_width = 2
border_sides = B
background_color = #221C15 100
border_color = ${DESKTOP_COLOURS.glow} 100
rounded = 6
border_width = 0
background_color = #1B1713 100
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
launcher_icon_size = 22
launcher_item_app = ${SESSION}/terminal.desktop
launcher_item_app = ${SESSION}/browser.desktop
taskbar_mode = single_desktop
taskbar_padding = 6 0 4
task_text = 1
task_icon = 1
task_maximum_size = 220 28
task_padding = 10 2 6
task_font = DejaVu Sans 9
task_font_color = #9C9184 100
task_active_font_color = #EDE5D8 100
task_background_id = 0
task_active_background_id = 2
mouse_hover = 1
task_hover_background_id = 3
time1_format = %H:%M
time1_font = DejaVu Sans 9
clock_font_color = #9C9184 100
clock_padding = 10 0`;

/** Openbox's frames in the same warm darks: a quiet title bar, the open window's title in the light text. */
const WINDOWS = `border.width: 1
padding.width: 8
padding.height: 5
window.handle.width: 0
window.client.padding.width: 0
window.client.padding.height: 0
window.label.text.justify: left
window.active.border.color: #332C23
window.inactive.border.color: #262019
window.active.client.color: ${DESKTOP_COLOURS.background}
window.inactive.client.color: ${DESKTOP_COLOURS.background}
window.active.title.bg: flat solid
window.active.title.bg.color: #181512
window.inactive.title.bg: flat solid
window.inactive.title.bg.color: ${DESKTOP_COLOURS.panel}
window.active.title.separator.color: #262019
window.inactive.title.separator.color: #262019
window.active.label.bg: parentrelative
window.inactive.label.bg: parentrelative
window.active.label.text.color: #EDE5D8
window.inactive.label.text.color: #8A7F72
window.active.button.unpressed.bg: parentrelative
window.active.button.unpressed.image.color: #C9BEAF
window.active.button.hover.bg: flat solid
window.active.button.hover.bg.color: #221C15
window.active.button.hover.image.color: #EDE5D8
window.active.button.pressed.bg: flat solid
window.active.button.pressed.bg.color: #2A231A
window.active.button.pressed.image.color: ${DESKTOP_COLOURS.glow}
window.active.button.disabled.bg: parentrelative
window.active.button.disabled.image.color: #5A5148
window.active.button.toggled.unpressed.bg: parentrelative
window.active.button.toggled.unpressed.image.color: ${DESKTOP_COLOURS.glow}
window.inactive.button.unpressed.bg: parentrelative
window.inactive.button.unpressed.image.color: #6E6458
window.inactive.button.hover.bg: flat solid
window.inactive.button.hover.bg.color: #1B1713
window.inactive.button.hover.image.color: #C9BEAF
window.inactive.button.pressed.bg: flat solid
window.inactive.button.pressed.bg.color: #221C15
window.inactive.button.pressed.image.color: #EDE5D8
window.inactive.button.disabled.bg: parentrelative
window.inactive.button.disabled.image.color: #3A332B
window.inactive.button.toggled.unpressed.bg: parentrelative
window.inactive.button.toggled.unpressed.image.color: #9C9184
window.active.handle.bg: flat solid
window.active.handle.bg.color: #181512
window.inactive.handle.bg: flat solid
window.inactive.handle.bg.color: ${DESKTOP_COLOURS.panel}
window.active.grip.bg: flat solid
window.active.grip.bg.color: #181512
window.inactive.grip.bg: flat solid
window.inactive.grip.bg.color: ${DESKTOP_COLOURS.panel}
menu.border.width: 1
menu.border.color: #332C23
menu.separator.color: #262019
menu.title.bg: flat solid
menu.title.bg.color: #181512
menu.title.text.color: #EDE5D8
menu.title.text.justify: left
menu.items.bg: flat solid
menu.items.bg.color: ${DESKTOP_COLOURS.panel}
menu.items.text.color: #EDE5D8
menu.items.disabled.text.color: #6E6458
menu.items.active.bg: flat solid
menu.items.active.bg.color: #221C15
menu.items.active.text.color: #EDE5D8
menu.items.active.disabled.text.color: #6E6458
osd.border.width: 1
osd.border.color: #332C23
osd.bg: flat solid
osd.bg.color: ${DESKTOP_COLOURS.panel}
osd.label.text.color: #EDE5D8
osd.hilight.bg: flat solid
osd.hilight.bg.color: ${DESKTOP_COLOURS.glow}
osd.unhilight.bg: flat solid
osd.unhilight.bg.color: #262019`;

/** Every xterm on the desktop, the launcher's and an agent's, on the desktop's ground. */
const TERMINALS = `XTerm*faceName: Monospace
XTerm*faceSize: 11
XTerm*background: ${DESKTOP_COLOURS.background}
XTerm*foreground: #EDE5D8
XTerm*cursorColor: ${DESKTOP_COLOURS.glow}
XTerm*internalBorder: 8`;

/**
 * The first open starts the session; a later one finds it running. A window manager, a panel with a terminal and a
 * browser to launch, and the wallpaper, so a fresh desktop is a desktop and not a black screen (D80, D88). Its first
 * argument is the mark the wallpaper centres, an SVG document, or empty for none.
 */
const DESKTOP_START = `cd /
if ! pgrep -x Xkasmvnc >/dev/null; then
  printf '%s\\n' 'export CHROMIUM_FLAGS="$CHROMIUM_FLAGS --no-sandbox --disable-gpu --disable-dev-shm-usage --disable-component-update --no-first-run --no-default-browser-check"' > /etc/chromium.d/devbox
  mkdir -p /etc/chromium/policies/managed ${SESSION} /usr/local/share/themes/Kinu/openbox-3
  printf '%s\\n' '{"CommandLineFlagSecurityWarningsEnabled": false}' > /etc/chromium/policies/managed/devbox.json
  printf '%s\\n' ${launcher('Terminal', 'sh -c "cd /workspace 2>/dev/null; exec xterm"', '/usr/share/pixmaps/xterm-color_48x48.xpm')} > ${SESSION}/terminal.desktop
  printf '%s\\n' ${launcher('Browser', 'chromium', '/usr/share/icons/hicolor/48x48/apps/chromium.png')} > ${SESSION}/browser.desktop
  cat > ${SESSION}/tint2rc <<'PANEL'
${PANEL}
PANEL
  cat > /usr/local/share/themes/Kinu/openbox-3/themerc <<'WINDOWS'
${WINDOWS}
WINDOWS
  cat > ${SESSION}/Xresources <<'TERMINALS'
${TERMINALS}
TERMINALS
  cat > ${SESSION}/wallpaper.py <<'WALLPAPER'
${WALLPAPER_PY}
WALLPAPER
  printf '%s' "\${1-}" > ${SESSION}/mark.svg
  sed '/<theme>/,/<\\/theme>/ s#<name>[^<]*</name>#<name>Kinu</name>#' /etc/xdg/openbox/rc.xml > ${SESSION}/rc.xml
  setsid Xkasmvnc :0 -geometry ${String(DESKTOP_SIZE.width)}x${String(DESKTOP_SIZE.height)} -depth 24 -interface 0.0.0.0 -websocketPort ${String(DESKTOP_PORT)} \\
    -DisableBasicAuth 1 -sslOnly 0 -SecurityTypes None -AlwaysShared -publicIP 127.0.0.1 >${LOG} 2>&1 </dev/null &
  server=$!
fi
until (exec 3<>/dev/tcp/127.0.0.1/${String(DESKTOP_PORT)}) 2>/dev/null; do
  pgrep -x Xkasmvnc >/dev/null || { [ -n "\${server-}" ] && kill -0 "$server" 2>/dev/null; } || { tail -n 20 ${LOG} >&2; exit 1; }
  sleep 0.05
done
[ -z "\${server-}" ] || DISPLAY=:0 xrdb -nocpp -merge ${SESSION}/Xresources
if ! pgrep -x openbox >/dev/null; then
  DISPLAY=:0 setsid openbox --config-file ${SESSION}/rc.xml >/dev/null 2>&1 </dev/null &
  wm=$!
  until pgrep -x openbox >/dev/null; do kill -0 "$wm" 2>/dev/null || exit 1; sleep 0.01; done
fi
[ -z "\${server-}" ] || DISPLAY=:0 setsid python3 ${SESSION}/wallpaper.py ${SESSION}/mark.svg '${DESKTOP_COLOURS.background}' '${DESKTOP_COLOURS.foot}' \\
  '${DESKTOP_COLOURS.glow}' ${String(DESKTOP_PANEL.height)} >>${LOG} 2>&1 </dev/null &
if ! pgrep -x tint2 >/dev/null; then
  DISPLAY=:0 setsid tint2 -c ${SESSION}/tint2rc >>${LOG} 2>&1 </dev/null &
  panel=$!
  until DISPLAY=:0 xdotool search --class tint2 >/dev/null 2>&1; do kill -0 "$panel" 2>/dev/null || { tail -n 20 ${LOG} >&2; exit 1; }; sleep 0.02; done
fi`;

/** The start, which brings back any part of the session that died, then the screen's size as X reports it, and `fresh`
 *  when this run started X: a screen nobody has seen. */
export const DESKTOP_CHECK = `${DESKTOP_START}
DISPLAY=:0 xdotool getdisplaygeometry
[ -z "\${server-}" ] || echo fresh`;
