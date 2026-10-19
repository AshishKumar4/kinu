/**
 * A PC's screen as Kinu can show it (1014-t), as its daemon reports it at connect and again when it changes. The daemon
 * is the screen's one endpoint on every system: on Linux it serves the screen the desktop portal gives it, on macOS it
 * fronts the system's own Screen Sharing; either way the Environment's desktop client reads one stream.
 *
 * - `ready`: the screen can be opened; `width` and `height` are its size.
 * - `setup`: one step on the PC first (macOS: Screen Sharing is off); `detail` names it.
 * - `permission`: the PC shows its own prompt, and the screen opens once someone there allows it.
 * - `update`: the daemon predates its desktop; `kinu update` brings it.
 * - `none`: no screen to show (no graphical session, or a system with no way to share one).
 */
export const DEVICE_DESKTOP_STATES = ['ready', 'setup', 'permission', 'update', 'none'] as const;

export type DeviceDesktopState = typeof DEVICE_DESKTOP_STATES[number];
