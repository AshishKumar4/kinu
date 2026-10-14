/**
 * The desktop as agents drive it (D89): one action at a time on the screen the owner watches, sent by xdotool, and one
 * agent driving at a time. What runs on the box is decided here; the box runs it.
 */
import * as v from 'valibot';
import { WATCH_SHEET } from './desktop';

/** The longest a key is held, and the longest a watch looks. */
const KEY_HOLD_MAX_MS = 10_000;

const WATCH_MAX_SECONDS = 10;

const Coordinate = v.pipe(v.number(), v.integer(), v.minValue(0));

const Point = v.pipe(v.tuple([Coordinate, Coordinate]), v.readonly());

/** A key or modifier as X spells it; the agent's chord was read into these before it was sent. */
const KeyName = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_]+$/u));

const Wheel = v.pipe(v.number(), v.integer(), v.minValue(-50), v.maxValue(50));

export const DesktopRequestSchema = v.object({
  driver: v.pipe(v.string(), v.nonEmpty()),
  /** The id `killExec` ends the action by, as an exec's (D69): its caller's stop ends its run. */
  execId: v.optional(v.pipe(v.string(), v.nonEmpty())),
  action: v.variant('kind', [
    v.object({ kind: v.literal('screenshot') }),
    v.object({
      kind: v.literal('watch'), seconds: v.pipe(v.number(), v.minValue(0.5), v.maxValue(WATCH_MAX_SECONDS)),
      frames: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(WATCH_SHEET.columns.length)),
    }),
    v.object({
      kind: v.literal('click'), at: Point, button: v.picklist(['left', 'right', 'middle']),
      count: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(3)), hold: v.pipe(v.array(KeyName), v.readonly()),
    }),
    // A line break or tab is a key press, never typed: xdotool types neither.
    v.object({ kind: v.literal('type'), text: v.pipe(v.string(), v.nonEmpty(), v.maxLength(200), v.regex(/^[^\r\n\t]*$/u)) }),
    v.object({
      kind: v.literal('key'), keys: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_]+(?:\+[A-Za-z0-9_]+)*$/u)),
      holdMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(KEY_HOLD_MAX_MS))),
    }),
    v.object({ kind: v.literal('scroll'), at: Point, dy: Wheel, dx: Wheel }),
    v.object({ kind: v.literal('move'), at: Point }),
    v.object({ kind: v.literal('drag'), from: Point, to: Point }),
  ]),
});

export type DesktopRequest = v.InferOutput<typeof DesktopRequestSchema>;

export type DesktopAction = DesktopRequest['action'];

export type DesktopAnswer =
  | { readonly kind: 'done' }
  | { readonly kind: 'screen'; readonly png: string; readonly width: number; readonly height: number }
  | { readonly kind: 'refused'; readonly reason: 'off_screen' | 'driven' | 'look_first'; readonly detail: string };

export interface DesktopScreen {
  readonly width: number;
  readonly height: number;
}

const BUTTONS = { left: '1', middle: '2', right: '3' } as const;

/**
 * A watch: its frames taken evenly over its window, the last at its end, each by scrot with the pointer drawn in; then
 * their thumbnails tiled into one PNG on stdout by Pillow, which the image carries (python3-pil, D89). Its arguments: a
 * name for the run, the seconds, the frames, the thumbnail's percent and the columns.
 */
const WATCH_PY = String.raw`import os, shutil, subprocess, sys, tempfile, time
from PIL import Image

seconds, frames, percent, cols = float(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])
folder = tempfile.mkdtemp()
try:
    start, tiles = time.monotonic(), []
    for at in range(frames):
        due = seconds if frames == 1 else at * seconds / (frames - 1)
        time.sleep(max(0.0, start + due - time.monotonic()))
        subprocess.run(['scrot', '-o', '-p', '-t', str(percent), '%s/f%d.ppm' % (folder, at)], check=True, env=dict(os.environ, DISPLAY=':0'))
        tiles.append(Image.open('%s/f%d-thumb.ppm' % (folder, at)).convert('RGB'))
    width, height = tiles[0].size
    sheet = Image.new('RGB', (width * min(cols, len(tiles)), height * -(-len(tiles) // cols)), 'white')
    for at, tile in enumerate(tiles):
        sheet.paste(tile, ((at % cols) * width, (at // cols) * height))
    sheet.save(sys.stdout.buffer, 'PNG')
finally:
    shutil.rmtree(folder, ignore_errors=True)
`;

/** A watch's run: its program and arguments. */
export function watchArgv(action: { readonly seconds: number; readonly frames: number }): string[] {
  // The request's frames are within the layout's table (DesktopRequestSchema); past it would be its widest row.
  const columns = WATCH_SHEET.columns[action.frames - 1] ?? Math.max(...WATCH_SHEET.columns);

  return ['python3', '-c', WATCH_PY, 'devbox-watch', String(action.seconds), String(action.frames), String(WATCH_SHEET.percent), String(columns)];
}

/** Captured with the pointer drawn in, read back and removed in the same run. */
export const SCREENSHOT = 'f=$(mktemp --suffix=.png) && scrot -o -p "$f" && cat "$f"; s=$?; rm -f "$f"; exit $s';

const xy = ([x, y]: readonly [number, number]): string[] => [String(x), String(y)];

/** One xdotool invocation, and what releases anything it holds down if it is cut short. */
export interface XdotoolRun {
  readonly argv: string[];
  readonly release: string[] | null;
}

/**
 * The xdotool argv that performs `action`, one invocation, and what releases anything it holds down if it is cut short.
 * No `mousemove --sync`: it waits for the pointer to leave where it was, about 15 s when it is already at the point, and
 * a warp then a click on one X connection are served in order without it.
 */
export function xdotoolOf(action: Exclude<DesktopAction, { kind: 'screenshot' | 'watch' }>): XdotoolRun {
  switch (action.kind) {
    case 'click': {
      const down = action.hold.flatMap((key) => ['keydown', key]);
      const up = action.hold.flatMap((key) => ['keyup', key]);

      return {
        argv: ['xdotool', ...down, 'mousemove', ...xy(action.at), 'click', '--repeat', String(action.count), '--delay', '80', BUTTONS[action.button], ...up],
        release: up.length === 0 ? null : ['xdotool', ...up],
      };
    }

    case 'type':
      return { argv: ['xdotool', 'type', '--delay', '12', '--', action.text], release: null };
    case 'key':
      // Held: down, a wait, up, in the one run; cut short, the release lets it go.
      return action.holdMs === undefined
        ? { argv: ['xdotool', 'key', '--', action.keys], release: null }
        : { argv: ['xdotool', 'keydown', action.keys, 'sleep', String(action.holdMs / 1000), 'keyup', action.keys], release: ['xdotool', 'keyup', action.keys] };
    case 'scroll': {
      // Wheel buttons: 4 up, 5 down, 6 left, 7 right. xdotool's own 100 ms a click would outlast the bound.
      const turns = (clicks: number, back: string, on: string): string[] => (clicks === 0 ? [] : ['click', '--repeat', String(Math.abs(clicks)), '--delay', '20', clicks < 0 ? back : on]);

      return { argv: ['xdotool', 'mousemove', ...xy(action.at), ...turns(action.dy, '4', '5'), ...turns(action.dx, '6', '7')], release: null };
    }

    case 'move':
      return { argv: ['xdotool', 'mousemove', ...xy(action.at)], release: null };
    case 'drag': {
      // Moved through its midpoint: an app that reads a drag from motion sees one.
      const middle: [number, number] = [Math.round((action.from[0] + action.to[0]) / 2), Math.round((action.from[1] + action.to[1]) / 2)];

      return {
        argv: ['xdotool', 'mousemove', ...xy(action.from), 'mousedown', '1', 'sleep', '0.05', 'mousemove', ...xy(middle), 'sleep', '0.05',
          'mousemove', ...xy(action.to), 'sleep', '0.05', 'mouseup', '1'],
        release: ['xdotool', 'mouseup', '1'],
      };
    }
  }
}

/** The points an action acts at. */
function pointsOf(action: DesktopAction): ReadonlyArray<readonly [number, number]> {
  if (action.kind === 'drag') return [action.from, action.to];

  return 'at' in action ? [action.at] : [];
}

/** The action's points that fall outside `screen`, as the refusal names them. */
export function offScreen(action: DesktopAction, screen: DesktopScreen): string | null {
  const points = pointsOf(action);
  const outside = points.find(([x, y]) => x >= screen.width || y >= screen.height);

  return outside === undefined
    ? null
    : `[${String(outside[0])}, ${String(outside[1])}] is off the screen, which is ${String(screen.width)}×${String(screen.height)}.`;
}

/** A PNG's signature, then its first chunk's length and type: the image header that holds its size. */
const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52];

/** A PNG's size, from its header; null for bytes that are no PNG. */
export function pngSize(png: Uint8Array): DesktopScreen | null {
  if (png.length < 24 || PNG_HEAD.some((byte, at) => png[at] !== byte)) return null;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);

  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * Who drives the screen (D89). An agent takes it by looking when nobody holds it, and holds it until its turns end, it
 * is stopped, or X starts afresh: however long it thinks between looks. Input is accepted only from the agent that holds
 * it, so every action lands on a screen its agent saw while it held it. The owner is not a driver: they use their screen
 * as they like.
 */
export class DesktopLease {
  #driver: string | null = null;

  /** A screen X started afresh is nobody's: what any agent saw before it is gone. */
  clear(): void {
    this.#driver = null;
  }

  /** `driver`'s turns ended, or it was stopped: the screen is free, if it held it. */
  release(driver: string): void {
    if (this.#driver === driver) this.#driver = null;
  }

  /** Whether `driver` may act now; looking takes the screen when it is free. */
  admit(driver: string, looking: boolean): DesktopAnswer | null {
    const held = this.#driver;

    if (held === driver) return null;

    if (looking) {
      if (held === null) this.#driver = driver;

      return null;
    }

    return held === null
      ? { kind: 'refused', reason: 'look_first', detail: 'take a screenshot first: input acts on the screen you last saw.' }
      : { kind: 'refused', reason: 'driven', detail: "another agent of this workspace drives the desktop; it is free once that agent's turn ends." };
  }
}
