/**
 * A PC's screen as Kinu can show it (1014-t), as its daemon reports it in each HELLO. The daemon is the screen's one
 * endpoint on every system: on Linux it serves the screen the desktop portal gives it, on macOS the screen its own
 * capture helper gives it; either way the Environment's desktop client reads one stream.
 *
 * - `ready`: the screen can be opened; `width` and `height` are its size.
 * - `setup`: one step on the PC first (macOS: no compiler for the capture helper); `detail` names it.
 * - `permission`: the PC shows its own prompt, and the screen opens once someone there allows it.
 * - `none`: no screen to show (no graphical session, sharing never turned on, or a system with no way to share one).
 */
import * as v from 'valibot';

const ScreenAxisSchema = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(0xffff));

/** Its size while it can be opened, the step on it before that. An RFB axis is a u16. */
export const DeviceDesktopSchema = v.variant('state', [
  v.object({ state: v.literal('ready'), width: ScreenAxisSchema, height: ScreenAxisSchema }),
  v.object({ state: v.literal('setup'), detail: v.pipe(v.string(), v.trim(), v.minLength(1)) }),
  v.object({ state: v.picklist(['permission', 'none']) }),
]);

export type DeviceDesktop = v.InferOutput<typeof DeviceDesktopSchema>;
