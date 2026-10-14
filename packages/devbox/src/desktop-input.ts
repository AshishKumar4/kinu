/**
 * The desktop as agents drive it (D89): one action at a time on the screen the owner watches, sent by xdotool, and one
 * agent driving at a time. What runs on the box is decided here; the box runs it.
 */
import * as v from 'valibot';

/** How long a driver keeps the screen after its last call before another agent may take it by looking. */
const DESKTOP_LEASE_MS = 30_000;

/** The bound on one action's xdotool run: the longest, a 50-click scroll on each axis, takes about 2 s. An action that
 *  waits by design (a held key, a watch) is bounded at its wait and this. */
export const DESKTOP_ACTION_MS = 5_000;

/** The longest a key is held, and the longest a watch looks. */
const KEY_HOLD_MAX_MS = 10_000;

const WATCH_MAX_SECONDS = 10;

/** The most frames one watch returns. */
const WATCH_MAX_FRAMES = 8;

/** The bound on the desktop check: a few times a fresh X's start, so a wedged X fails a call rather than holding every
 *  later one, and the box's rest, behind it. */
export const DESKTOP_CHECK_MS = 60_000;

const Coordinate = v.pipe(v.number(), v.integer(), v.minValue(0));

const Point = v.pipe(v.tuple([Coordinate, Coordinate]), v.readonly());

/** A key or modifier as X spells it; the agent's chord was read into these before it was sent. */
const KeyName = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_]+$/u));

const Wheel = v.pipe(v.number(), v.integer(), v.minValue(-50), v.maxValue(50));

export const DesktopRequestSchema = v.object({
  driver: v.pipe(v.string(), v.nonEmpty()),
  action: v.variant('kind', [
    v.object({ kind: v.literal('screenshot') }),
    v.object({
      kind: v.literal('watch'), seconds: v.pipe(v.number(), v.minValue(0.5), v.maxValue(WATCH_MAX_SECONDS)),
      frames: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(WATCH_MAX_FRAMES)),
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
 * A watch's sheet: each frame at half the screen's size, as scrot's own thumbnail, two to a row up to four frames and
 * four to a row past that, in reading order. Measured (D89): four half-size frames cost what one screenshot does and
 * read as well; eight at a third lost the screen's small text on both models.
 */
const WATCH_PERCENT = 50;

/** The sheet's columns for `frames` frames. */
function watchColumns(frames: number): number {
  if (frames <= 2) return frames;

  return frames <= 4 ? 2 : 4;
}

/**
 * A watch, in Python because the image carries it and no image tool: its frames taken evenly over its window, the last
 * at its end, each by scrot with the pointer drawn in; then their thumbnails, which scrot writes as PPM, tiled into one
 * PNG on stdout. Its arguments: a name for the run, the seconds, the frames, the thumbnail's percent and the columns.
 */
const WATCH_PY = String.raw`import os, shutil, struct, subprocess, sys, tempfile, time, zlib

seconds, frames, percent, cols = float(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])


def ppm(path):
    data = open(path, 'rb').read()
    fields, at = [], 0
    while len(fields) < 4:
        while data[at:at + 1].isspace():
            at += 1
        if data[at:at + 1] == b'#':
            at = data.index(b'\n', at) + 1
            continue
        end = at
        while not data[end:end + 1].isspace():
            end += 1
        fields.append(data[at:end])
        at = end
    width, height = int(fields[1]), int(fields[2])
    return width, height, data[at + 1:at + 1 + width * height * 3]


def chunk(kind, body):
    return struct.pack('>I', len(body)) + kind + body + struct.pack('>I', zlib.crc32(kind + body))


folder = tempfile.mkdtemp()
try:
    start, tiles = time.monotonic(), []
    for at in range(frames):
        due = seconds if frames == 1 else at * seconds / (frames - 1)
        time.sleep(max(0.0, start + due - time.monotonic()))
        path = folder + '/f%d.ppm' % at
        subprocess.run(['scrot', '-o', '-p', '-t', str(percent), path], check=True, env=dict(os.environ, DISPLAY=':0'))
        tiles.append(ppm(folder + '/f%d-thumb.ppm' % at))
    width, height = tiles[0][0], tiles[0][1]
    rows = -(-len(tiles) // cols)
    raw = bytearray()
    for row in range(rows):
        across = tiles[row * cols:(row + 1) * cols]
        for line in range(height):
            raw += b'\x00'
            for tile in across:
                raw += tile[2][line * width * 3:(line + 1) * width * 3]
            raw += b'\xff' * (width * 3 * (cols - len(across)))
    head = struct.pack('>IIBBBBB', width * min(cols, len(tiles)) if rows == 1 else width * cols, height * rows, 8, 2, 0, 0, 0)
    sys.stdout.buffer.write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', head) + chunk(b'IDAT', zlib.compress(bytes(raw), 6)) + chunk(b'IEND', b''))
finally:
    shutil.rmtree(folder, ignore_errors=True)
`;

/** A watch's run: its program and arguments. */
export function watchArgv(action: { readonly seconds: number; readonly frames: number }): string[] {
  return ['python3', '-c', WATCH_PY, 'devbox-watch', String(action.seconds), String(action.frames), String(WATCH_PERCENT), String(watchColumns(action.frames))];
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

/** How long an action may take: the bound, and the wait it makes by design. */
export function actionBoundMs(action: DesktopAction): number {
  if (action.kind === 'watch') return DESKTOP_ACTION_MS + action.seconds * 1000;

  return DESKTOP_ACTION_MS + (action.kind === 'key' ? action.holdMs ?? 0 : 0);
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
 * Who drives the screen. An agent takes it by looking when no other agent called in the last {@link DESKTOP_LEASE_MS};
 * input is accepted only from the agent that holds it, so every action lands on a screen its agent saw while it held it.
 * The owner is not a driver: they use their screen as they like.
 */
export class DesktopLease {
  #driver: { readonly id: string; at: number } | null = null;

  /** A screen X started afresh is nobody's: what any agent saw before it is gone. */
  clear(): void {
    this.#driver = null;
  }

  /** Whether `driver` may act now; looking takes the screen when it is free, and every call it may make keeps it. */
  admit(driver: string, looking: boolean, now: number): DesktopAnswer | null {
    const held = this.#driver;
    const free = held === null || held.id === driver || now - held.at > DESKTOP_LEASE_MS;

    if (held !== null && held.id === driver) {
      held.at = now;

      return null;
    }

    if (looking) {
      if (free) this.#driver = { id: driver, at: now };

      return null;
    }

    return free
      ? { kind: 'refused', reason: 'look_first', detail: 'take a screenshot first: input acts on the screen you last saw.' }
      : { kind: 'refused', reason: 'driven', detail: `another agent of this workspace drives the desktop; it is free ${String(DESKTOP_LEASE_MS / 1000)} s after its last call.` };
  }
}
