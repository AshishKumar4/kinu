/**
 * The computer's desktop as a program drives it: the screen the owner watches in the Computer pane, seen as an image
 * and acted on at its pixels. Each member's call is checked here before anything reaches the screen, and runs whole:
 * one call at a time, stopped with its program, and refused once its program was moved to the background, which Stop
 * no longer reaches. The box checks what only it knows: the screen's size, and which agent drives it (D89).
 */
import { Effect, Semaphore } from 'effect';
import * as v from 'valibot';
import { KinuError, refusalOf, settle, toKinuError, type Refusal } from '../obs/index';
import type { ExecutorTool, ExecutorToolResult } from './types';

/** [x, y]: pixels of the screenshot, from its top left. */
type DesktopPoint = readonly [number, number];

type DesktopButton = 'left' | 'right' | 'middle';

/**
 * One action the box performs on the screen. `text` holds no line break or tab and at most {@link TYPED_CHUNK}
 * characters; `keys` and `hold` are spelt as {@link desktopChord} spells them.
 */
export type DesktopAction =
  | { readonly kind: 'screenshot' }
  | { readonly kind: 'watch'; readonly seconds: number; readonly frames: number }
  | { readonly kind: 'click'; readonly at: DesktopPoint; readonly button: DesktopButton; readonly count: number; readonly hold: readonly string[] }
  | { readonly kind: 'type'; readonly text: string }
  | { readonly kind: 'key'; readonly keys: string; readonly holdMs?: number }
  | { readonly kind: 'scroll'; readonly at: DesktopPoint; readonly dy: number; readonly dx: number }
  | { readonly kind: 'move'; readonly at: DesktopPoint }
  | { readonly kind: 'drag'; readonly from: DesktopPoint; readonly to: DesktopPoint };

/** An action, and the agent it is for: the screen has one driver at a time. */
export interface DesktopRequest {
  readonly driver: string;
  readonly action: DesktopAction;
}

/** `off_screen`: a point outside it. `driven`: another agent drives it. `look_first`: this agent has not looked since
 *  another could have changed it. */
type DesktopRefusal = 'off_screen' | 'driven' | 'look_first';

/** The box's answer: `png` is base64. A refusal is the box's verdict on the request, given before any input. */
export type DesktopAnswer =
  | { readonly kind: 'done' }
  | { readonly kind: 'screen'; readonly png: string; readonly width: number; readonly height: number }
  | { readonly kind: 'refused'; readonly reason: DesktopRefusal; readonly detail: string };

/** The members that look, which Plan keeps and a program moved to the background may still call. */
const LOOKING = ['screenshot', 'watch'] as const;

export const DESKTOP_MEMBERS = [...LOOKING, 'click', 'type', 'key', 'scroll', 'move', 'drag'] as const;

type DesktopMember = (typeof DESKTOP_MEMBERS)[number];

const Coordinate = v.pipe(v.number(), v.integer(), v.minValue(0));

/** A point of the screen; its size is the box's to check. */
export const DesktopPointSchema = v.tuple([Coordinate, Coordinate]);

/** Wheel clicks: the largest scroll is one call of about 2 s at the box's 20 ms a click. */
export const WheelClicksSchema = v.pipe(v.number(), v.integer(), v.minValue(-50), v.maxValue(50));

/** A chord as a program writes it; {@link desktopChord} reads it. */
export const KeysSchema = v.pipe(v.string(), v.nonEmpty(), v.maxLength(64));

export const ButtonSchema = v.picklist(['left', 'right', 'middle']);

export const ClickCountSchema = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(3));

export const TypedTextSchema = v.pipe(v.string(), v.nonEmpty(), v.maxLength(4_000));

/** How long `watch` looks: long enough for an animation or a page's load, short enough to stay one call. */
export const WatchSecondsSchema = v.pipe(v.number(), v.minValue(0.5), v.maxValue(10));

/** Frames a second `watch` samples; it never takes more frames than its sheet's layout holds. */
export const WatchFpsSchema = v.pipe(v.number(), v.minValue(0.1), v.maxValue(30));

/** The frames a `watch` takes when not asked. */
export const WATCH_DEFAULT_FRAMES = 4;

/**
 * The desktop as the box runs it, from the box's own constants: its size, and how a watch tiles its frames: each at
 * `percent` of the screen's width and height, `columns[n - 1]` to a row for `n` frames, at most as many as `columns`.
 */
export interface DesktopScreen {
  readonly width: number;
  readonly height: number;
  readonly sheet: { readonly percent: number; readonly columns: readonly number[] };
}

/** The image a watch answers: its size, and how many screenshots' worth of pixels that is, which is what it costs. */
export interface WatchImage {
  readonly width: number;
  readonly height: number;
  readonly screenshots: number;
}

/** The image a watch of `frames` frames answers on `screen`. */
export function watchSheet(screen: DesktopScreen, frames: number): WatchImage {
  const { percent, columns } = screen.sheet;
  const across = Math.min(frames, columns[frames - 1] ?? Math.max(...columns));
  const tile = { width: Math.floor(screen.width * percent / 100), height: Math.floor(screen.height * percent / 100) };
  const width = tile.width * across;
  const height = tile.height * Math.ceil(frames / across);

  return { width, height, screenshots: (width * height) / (screen.width * screen.height) };
}

/** How long `key` holds its chord down, as a game reads a held key. */
export const KeyHoldSchema = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10_000));

/** Characters per typed action: Stop is checked between them. The reference demo's chunk, at its 12 ms a character. */
const TYPED_CHUNK = 50;

/** Modifiers by the names models use, as xdotool spells them. */
const MODIFIERS = new Map([
  ['ctrl', 'ctrl'], ['control', 'ctrl'], ['shift', 'shift'], ['alt', 'alt'], ['option', 'alt'],
  ['super', 'super'], ['cmd', 'super'], ['command', 'super'], ['win', 'super'], ['meta', 'super'],
]);

/** Keys by name, case aside, as X spells them. */
const NAMED = new Map<string, string>([
  ...['Return', 'Tab', 'Escape', 'BackSpace', 'Delete', 'Insert', 'Home', 'End', 'Page_Up', 'Page_Down', 'Up', 'Down', 'Left', 'Right', 'space']
    .map((key) => [key.toLowerCase(), key] as const),
  ...Array.from({ length: 12 }, (_, at) => [`f${String(at + 1)}`, `F${String(at + 1)}`] as const),
  ['enter', 'Return'], ['esc', 'Escape'], ['del', 'Delete'], ['pageup', 'Page_Up'], ['pagedown', 'Page_Down'],
]);

/** A punctuation mark by the keysym name X knows it by: xdotool's `key` reads names, never the mark itself. */
const MARKS = new Map(Object.entries({
  '`': 'grave', '~': 'asciitilde', '!': 'exclam', '@': 'at', '#': 'numbersign', $: 'dollar', '%': 'percent', '^': 'asciicircum',
  '&': 'ampersand', '*': 'asterisk', '(': 'parenleft', ')': 'parenright', '-': 'minus', _: 'underscore', '=': 'equal',
  '[': 'bracketleft', ']': 'bracketright', '{': 'braceleft', '}': 'braceright', '\\': 'backslash', '|': 'bar',
  ';': 'semicolon', ':': 'colon', "'": 'apostrophe', '"': 'quotedbl', ',': 'comma', '.': 'period', '<': 'less', '>': 'greater',
  '/': 'slash', '?': 'question',
}));

/** The marks' names, and `plus`, which `+` cannot be in a chord. */
const MARK_NAMES = new Set([...MARKS.values(), 'plus']);

const KEYS_ARE = 'a key is Return, Tab, Escape, BackSpace, Delete, Insert, Home, End, Page_Up, Page_Down, Up, Down, Left, Right, '
  + 'space, F1-F12, a letter, a digit or a punctuation mark (`plus` for +), after ctrl, shift, alt or super, joined by "+"';

/** One key as X spells it, or null. */
function keyName(token: string): string | null {
  if (/^[A-Za-z0-9]$/u.test(token)) return token;

  const lower = token.toLowerCase();

  return MARKS.get(token) ?? NAMED.get(lower) ?? (MARK_NAMES.has(lower) ? lower : null);
}

/**
 * A chord as xdotool spells it: modifiers, then one key, which may itself be a modifier pressed alone. `modifiers`
 * reads modifiers only, as a click holds them. Checked here because xdotool skips a name it does not know and still
 * answers success.
 */
function desktopChord(keys: string, modifiers = false): readonly string[] | KinuError {
  const tokens = keys.split('+');
  const spelt: string[] = [];

  for (const [at, token] of tokens.entries()) {
    const modifier = MODIFIERS.get(token.toLowerCase());
    const key = modifiers || at < tokens.length - 1 ? undefined : keyName(token) ?? undefined;

    if (token === '') return new KinuError('bad_input', `"${keys}" is not a chord: ${KEYS_ARE}.`);

    if (modifier === undefined && key === undefined) {
      return new KinuError('bad_input', modifiers || at < tokens.length - 1
        ? `"${token}" is not a modifier: modifiers are ctrl, shift, alt and super, before the key, joined by "+".`
        : `no key "${token}": ${KEYS_ARE}.`);
    }

    spelt.push(modifier ?? key ?? token);
  }

  return spelt;
}

/**
 * `text` as the box types it: runs of at most {@link TYPED_CHUNK} ASCII characters, with Return where a line breaks and
 * Tab where it tabs, which xdotool's `type` sends as neither. A character past ASCII is pressed as its own Unicode key:
 * on a real box Chromium dropped `type`'s ü at xdotool's 12 ms a character, and took `key U00FC`.
 */
function typedActions(text: string): DesktopAction[] {
  return text.split(/(\r\n|\r|\n|\t|[^\x20-\x7e])/u).flatMap((part): DesktopAction[] => {
    if (part === '\t') return [{ kind: 'key', keys: 'Tab' }];

    if (/^(?:\r\n|\r|\n)$/u.test(part)) return [{ kind: 'key', keys: 'Return' }];

    const code = part.codePointAt(0);

    if (code !== undefined && Array.from(part).length === 1 && (code < 0x20 || code > 0x7e)) {
      return [{ kind: 'key', keys: `U${code.toString(16).toUpperCase().padStart(4, '0')}` }];
    }

    const characters = Array.from(part);

    return Array.from({ length: Math.ceil(characters.length / TYPED_CHUNK) }, (_, at) => ({
      kind: 'type' as const, text: characters.slice(at * TYPED_CHUNK, (at + 1) * TYPED_CHUNK).join(''),
    }));
  });
}

const ClickSchema = v.object({
  at: DesktopPointSchema, button: v.optional(ButtonSchema), count: v.optional(ClickCountSchema), hold: v.optional(KeysSchema),
});

/** What a desktop call carries beyond its input, as an `exec` does: its program's stop signal, and the signal its
 *  program was moved to the background with. */
const CallContextSchema = v.object({ signal: v.optional(v.instance(AbortSignal)), detached: v.optional(v.instance(AbortSignal)) });

type CallContext = v.InferOutput<typeof CallContextSchema>;

const REFUSED_AS = { off_screen: 'bad_input', look_first: 'bad_input', driven: 'unavailable' } as const;

function answered(member: DesktopMember, answer: DesktopAnswer): ExecutorToolResult | Refusal {
  switch (answer.kind) {
    case 'done':
      return null;
    case 'screen':
      return `data:image/png;base64,${answer.png}`;
    case 'refused':
      return refusalOf(new KinuError(REFUSED_AS[answer.reason], `computer.${member}: ${answer.detail}`));
  }
}

export interface DesktopDeps {
  /** The box's desktop; absent, no computer is configured. */
  readonly box: ((request: DesktopRequest) => Promise<DesktopAnswer>) | undefined;
  /** This agent, as the box tells drivers apart. */
  readonly driver: string;
  /** The most frames a watch takes: what the box's sheet holds. */
  readonly frames: number;
  readonly notConfigured: () => Refusal;
}

/**
 * The desktop's members over one agent's computer. Each is called with its named input and the call's context. Calls
 * run one at a time in the order made, each whole, so a program's calls made together never interleave on the screen;
 * each action is sent only while the program still runs in the foreground.
 */
export function desktopTools(deps: DesktopDeps): Record<string, ExecutorTool> {
  const alone = Semaphore.makeUnsafe(1);

  /** One call's `planned` actions, sent in order while its program runs in the foreground. */
  const drive = (member: DesktopMember, planned: readonly DesktopAction[] | KinuError, context: CallContext): Effect.Effect<ExecutorToolResult | Refusal> => Effect.gen(function* () {
    const { box } = deps;

    if (box === undefined) return deps.notConfigured();

    if (planned instanceof KinuError) return refusalOf(planned);
    let answer: DesktopAnswer = { kind: 'done' };

    for (const action of planned) {
      if (context.signal?.aborted === true) return refusalOf(new KinuError('cancelled', `computer.${member}: its program stopped, so the rest did not reach the screen.`));

      if (!LOOKING.some((looking) => looking === member) && context.detached?.aborted === true) {
        return refusalOf(new KinuError('denied', `computer.${member}: this program was moved to the background; the screen is driven from the turn in the foreground.`));
      }

      answer = yield* Effect.tryPromise({
        try: () => box({ driver: deps.driver, action }),
        catch: (cause) => toKinuError({ doing: `computer.${member}`, cause, otherwise: 'unavailable' }),
      });

      if (answer.kind === 'refused') break;
    }

    return answered(member, answer);
  }).pipe(Effect.catch((failure) => Effect.succeed(refusalOf(failure))), alone.withPermits(1));

  /** A member: its named input read as it arrives, then its plan driven with the call's context. */
  const member = <S extends v.GenericSchema>(
    name: DesktopMember, description: string, schema: S, plan: (input: v.InferOutput<S>) => readonly DesktopAction[] | KinuError,
  ) => ({
    description,
    ...(LOOKING.some((looking) => looking === name) && { planAllowed: true }),
    run: (args: readonly unknown[]): Effect.Effect<ExecutorToolResult | Refusal> => {
      const input = v.safeParse(schema, args[0]);
      const context = v.safeParse(CallContextSchema, args[1]);

      return drive(name, input.success ? plan(input.output) : new KinuError('bad_input', `computer.${name}: ${v.summarize(input.issues)}`), context.success ? context.output : {});
    },
  });

  const members = {
    screenshot: member('screenshot', 'The desktop the owner watches, as a PNG data URL.', v.object({}), () => [{ kind: 'screenshot' }]),
    watch: member('watch', 'The desktop over a few seconds, as one PNG data URL of its frames.', v.object({ seconds: WatchSecondsSchema, fps: v.optional(WatchFpsSchema) }), ({ seconds, fps }) => [{
      kind: 'watch', seconds, frames: fps === undefined ? Math.min(WATCH_DEFAULT_FRAMES, deps.frames) : Math.max(1, Math.min(deps.frames, Math.round(seconds * fps))),
    }]),
    click: member('click', 'Click at a point of the screen.', ClickSchema, ({ at, button = 'left', count = 1, hold }) => {
      const held = hold === undefined ? [] : desktopChord(hold, true);

      return held instanceof KinuError ? held : [{ kind: 'click', at, button, count, hold: held }];
    }),
    type: member('type', 'Type text at the keyboard focus.', v.object({ text: TypedTextSchema }), ({ text }) => typedActions(text)),
    key: member('key', 'Press a key or a chord, or hold it down.', v.object({ keys: KeysSchema, hold: v.optional(KeyHoldSchema) }), ({ keys, hold }) => {
      const chord = desktopChord(keys);

      if (chord instanceof KinuError) return chord;

      return [{ kind: 'key', keys: chord.join('+'), ...(hold !== undefined && { holdMs: hold }) }];
    }),
    scroll: member('scroll', 'Turn the mouse wheel over a point.', v.object({ at: DesktopPointSchema, dy: WheelClicksSchema, dx: v.optional(WheelClicksSchema) }), ({ at, dy, dx = 0 }) => (
      dy === 0 && dx === 0 ? new KinuError('bad_input', 'nothing to scroll: dy and dx are both 0.') : [{ kind: 'scroll', at, dy, dx }]
    )),
    move: member('move', 'Move the pointer to a point.', v.object({ at: DesktopPointSchema }), ({ at }) => [{ kind: 'move', at }]),
    drag: member('drag', 'Drag with the left button from one point to another.', v.object({ from: DesktopPointSchema, to: DesktopPointSchema }), ({ from, to }) => [{ kind: 'drag', from, to }]),
  } satisfies Record<DesktopMember, { readonly description: string }>;

  return Object.fromEntries(Object.entries(members).map(([name, { run, ...declared }]): [string, ExecutorTool] => [name, {
    ...declared,
    execute: async (...args) => await settle(run(args)),
  }]));
}
