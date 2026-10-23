/**
 * What the box speaks with its callers: the desktop's requests and answers (D89), and a digest write's request. The box
 * parses each request it is sent; its callers, core's computer among them, build them by these types. Nothing here
 * imports past valibot, so a caller's graph takes no more of the box than its words.
 */
import * as v from 'valibot';
import { WATCH_SHEET } from './desktop';

/** The directory a devbox makes durable, and every command's default working directory. */
export const DEVBOX_WORKDIR = '/workspace';

/** The longest a key is held, and the longest a watch looks. */
const KEY_HOLD_MAX_MS = 10_000;

const WATCH_MAX_SECONDS = 10;

const Coordinate = v.pipe(v.number(), v.integer(), v.minValue(0));

const Point = v.pipe(v.tuple([Coordinate, Coordinate]), v.readonly());

/** How far a relative move goes on each axis, in pixels: a screen's width each way is the most any turn needs. */
const Step = v.pipe(v.number(), v.integer(), v.minValue(-4096), v.maxValue(4096));

const Delta = v.pipe(v.tuple([Step, Step]), v.readonly());

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
      kind: v.literal('click'), at: v.optional(Point), button: v.picklist(['left', 'right', 'middle']),
      count: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(3)), hold: v.pipe(v.array(KeyName), v.readonly()),
    }),
    // A line break or tab is a key press, never typed: xdotool types neither.
    v.object({ kind: v.literal('type'), text: v.pipe(v.string(), v.nonEmpty(), v.maxLength(200), v.regex(/^[^\r\n\t]*$/u)) }),
    v.object({
      kind: v.literal('key'), keys: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_]+(?:\+[A-Za-z0-9_]+)*$/u)),
      holdMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(KEY_HOLD_MAX_MS))),
    }),
    v.object({ kind: v.literal('scroll'), at: Point, dy: Wheel, dx: Wheel }),
    // To a point, or by a distance from wherever the pointer is: an app that captures the pointer reads motion alone.
    v.object({ kind: v.literal('move'), at: Point }),
    v.object({ kind: v.literal('move'), by: Delta }),
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

/** One digest write as a caller sends it: the new bytes as base64, the digest they replace, and its sends' names. */
export interface DigestWriteRequest {
  readonly path: string;
  readonly contentBase64: string;
  readonly expected: string | null;
  /** This write's name across every send of it. */
  readonly operation: string;
  /** The caller's earlier writes whose answers it holds. */
  readonly settled: readonly string[];
}
