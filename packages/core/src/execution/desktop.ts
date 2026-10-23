/**
 * The computer's desktop as a program drives it: the screen the owner watches in the Computer pane, seen as an image
 * and acted on at its pixels. Each member's call is checked here before anything reaches the screen, and runs whole:
 * one call at a time, stopped with its program, and refused once its program was moved to the background, which Stop
 * no longer reaches. The box checks what only it knows: the screen's size, and which agent drives it (D89).
 */
import { Effect, Semaphore } from 'effect';
import * as v from 'valibot';
import { KinuError, refusalOf, settle, toKinuError, type Refusal } from '../obs/index';
import type { DesktopAction, DesktopAnswer, DesktopRequest, DesktopScreen as BoxScreen } from '@kinu.run/devbox/wire';
import type { ExecutorTool, ExecutorToolResult } from './types';

/** The box's own words: it parses each request it is sent (`DesktopRequestSchema`). A typed action's `text` holds no
 *  line break or tab and at most {@link TYPED_CHUNK} characters; `keys` and a click's `hold` are spelt as
 *  {@link desktopChord} spells them. */
export type { DesktopAction, DesktopAnswer, DesktopRequest } from '@kinu.run/devbox/wire';

/** The members that look, which Plan keeps and a program moved to the background may still call. */
const LOOKING = ['screenshot', 'watch'] as const;

export const DESKTOP_MEMBERS = [...LOOKING, 'click', 'type', 'key', 'scroll', 'move', 'drag'] as const;

type DesktopMember = (typeof DESKTOP_MEMBERS)[number];

const Coordinate = v.pipe(v.number(), v.integer(), v.minValue(0));

const XY = v.object({ x: v.number(), y: v.number() });

const AtPoint = v.object({ at: v.array(v.number()) });

/** A point sent as `{ x, y }`, or as an options object holding `at` (the minecraft trials, 2026-10-19), is refused with
 *  the array to send instead. */
function pointIsAnArray(issue: { readonly input: unknown }): string {
  const xy = v.safeParse(XY, issue.input);
  const at = v.safeParse(AtPoint, issue.input);

  if (xy.success) return `a point is one array [x, y]: send [${String(xy.output.x)}, ${String(xy.output.y)}]`;

  return at.success
    ? `the point comes first, alone, and any options after it: send [${at.output.at.join(', ')}]`
    : 'a point is one array [x, y]: pixels from the top left';
}

/** A point of the screen; its size is the box's to check. */
const DesktopPointSchema = v.tuple([Coordinate, Coordinate], pointIsAnArray);

const STEP_IS = 'a whole number of pixels from -4096 to 4096';

const Step = v.pipe(v.number(STEP_IS), v.integer(STEP_IS), v.minValue(-4096, STEP_IS), v.maxValue(4096, STEP_IS));

/** How far a relative move goes: [dx, dy], right and down. */
const DesktopDeltaSchema = v.tuple([Step, Step], 'a distance is one array [dx, dy]: pixels right and down, negative left and up');

const MOVE_IS = 'move takes a point [x, y], or a distance { by: [dx, dy] }';

/** Where a move goes: to a point, or by a distance from wherever the pointer is. */
const MoveSchema = v.union([DesktopPointSchema, v.strictObject({ by: DesktopDeltaSchema })], (issue) => {
  const by = v.safeParse(v.object({ by: v.unknown() }), issue.input);

  return by.success ? `{ by } is a distance: ${STEP_IS} each, as [dx, dy]` : `${MOVE_IS}; ${pointIsAnArray(issue)}`;
});

/** Wheel clicks: the largest scroll is one call of about 2 s at the box's 20 ms a click. */
const WheelClicksSchema = v.pipe(v.number(), v.integer(), v.minValue(-50), v.maxValue(50));

/** What a chord is, said where a call sends something else. */
const CHORDS_ARE = 'a chord is its keys as an array, pressed together, like ["ctrl", "s"]';

/** The keys of a chord: an array, its documented form, and a string joined by "+", which agents still send and which is
 *  read silently (owner, 2026-10-19). The model reads the array (`executors.ts`). {@link chordKeys} reads either. */
const KeysSchema = v.union([
  v.pipe(v.array(v.pipe(v.string(), v.nonEmpty(CHORDS_ARE))), v.minLength(1, CHORDS_ARE), v.maxLength(8)),
  v.pipe(v.string(), v.nonEmpty(CHORDS_ARE), v.maxLength(64)),
], CHORDS_ARE);

/** A chord's keys, however they were sent. */
function chordKeys(keys: string | readonly string[]): readonly string[] {
  return typeof keys === 'string' ? keys.split('+') : keys;
}

/** What a click's `keys` are, said where a click gets them wrong: a model sent a duration, as `key`'s hold takes. */
const MODIFIER_KEYS_ARE = 'the modifiers held while it clicks, as an array like ["shift"] or ["ctrl", "shift"]; a click is not held for a time';

/** The modifiers a click holds, sent as a chord's keys are; {@link desktopChord} reads them. */
const ClickKeysSchema = v.union([
  v.pipe(v.array(v.pipe(v.string(), v.nonEmpty(MODIFIER_KEYS_ARE))), v.minLength(1, MODIFIER_KEYS_ARE), v.maxLength(4)),
  v.pipe(v.string(), v.nonEmpty(MODIFIER_KEYS_ARE), v.maxLength(64)),
], MODIFIER_KEYS_ARE);

const ButtonSchema = v.picklist(['left', 'right', 'middle']);

const ClickCountSchema = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(3));

const TypedTextSchema = v.pipe(v.string(), v.nonEmpty(), v.maxLength(4_000));

/** How long `watch` looks: long enough for an animation or a page's load, short enough to stay one call. */
const WatchSecondsSchema = v.pipe(v.number(), v.minValue(0.5), v.maxValue(10));

/** Frames a second `watch` samples; it never takes more frames than its sheet's layout holds. */
const WatchFpsSchema = v.pipe(v.number(), v.minValue(0.1), v.maxValue(30));

/** The frames a `watch` takes when not asked. */
export const WATCH_DEFAULT_FRAMES = 4;

/**
 * The desktop as the box runs it, from the box's own constants: its size, and how a watch tiles its frames: each at
 * `percent` of the screen's width and height, `columns[n - 1]` to a row for `n` frames, at most as many as `columns`.
 */
export interface DesktopScreen extends BoxScreen {
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

/** What `hold` is, said where a call gets it wrong: models sent `true` and `0` for a key down and a key up. */
const HOLD_IS = 'milliseconds the key stays down before it is released, 1 to 10,000; there is no separate key down or key up, so hold it for as long as it should act';

/** How long `key` holds its chord down, as a game reads a held key. */
const KeyHoldSchema = v.pipe(v.number(HOLD_IS), v.integer(HOLD_IS), v.minValue(1, HOLD_IS), v.maxValue(10_000, HOLD_IS));

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

/** Keys models write as the character they type, which xdotool cannot read: refused with the name to send. */
const SENT_AS = new Map([[' ', 'space']]);

/** A punctuation mark by the keysym name X knows it by: xdotool's `key` reads names, never the mark itself. */
const MARKS = new Map(Object.entries({
  '`': 'grave', '~': 'asciitilde', '!': 'exclam', '@': 'at', '#': 'numbersign', $: 'dollar', '%': 'percent', '^': 'asciicircum',
  '&': 'ampersand', '*': 'asterisk', '(': 'parenleft', ')': 'parenright', '-': 'minus', _: 'underscore', '=': 'equal',
  '[': 'bracketleft', ']': 'bracketright', '{': 'braceleft', '}': 'braceright', '\\': 'backslash', '|': 'bar',
  ';': 'semicolon', ':': 'colon', "'": 'apostrophe', '"': 'quotedbl', ',': 'comma', '.': 'period', '<': 'less', '>': 'greater',
  '/': 'slash', '?': 'question', '+': 'plus',
}));

/** The marks' names. */
const MARK_NAMES = new Set(MARKS.values());

const KEYS_ARE = 'a chord is its keys as an array, pressed together: Return, Tab, Escape, BackSpace, Delete, Insert, Home, End, Page_Up, '
  + 'Page_Down, Up, Down, Left, Right, space, F1-F12, a letter, a digit or a punctuation mark, and ctrl, shift, alt or super';

/** One key as X spells it, or null. */
function keyName(token: string): string | null {
  if (/^[A-Za-z0-9]$/u.test(token)) return token;

  const lower = token.toLowerCase();

  return MARKS.get(token) ?? NAMED.get(lower) ?? (MARK_NAMES.has(lower) ? lower : null);
}

/**
 * A chord as xdotool spells it: the keys pressed together, modifiers among them, as a game reads ["w", "space"] (forward
 * and jump at once; the box presses each down in order and lets each up). `modifiers` reads modifiers only, as a click
 * holds them. Checked here because xdotool skips a name it does not know and still answers success.
 */
function desktopChord(keys: readonly string[], modifiers = false): readonly string[] | KinuError {
  const spelt: string[] = [];

  for (const token of keys) {
    const modifier = MODIFIERS.get(token.toLowerCase());
    const key = modifiers ? undefined : keyName(token) ?? undefined;

    if (token === '') return new KinuError('bad_input', `${JSON.stringify(keys)} is not a chord: ${KEYS_ARE}.`);

    const named = SENT_AS.get(token);

    if (named !== undefined && !modifiers) {
      return new KinuError('bad_input', `"${token}" is written "${named}": send ${JSON.stringify(keys.map((each) => SENT_AS.get(each) ?? each))}.`);
    }

    if (modifier === undefined && key === undefined) {
      return new KinuError('bad_input', modifiers
        ? `"${token}" is not a modifier: modifiers are "ctrl", "shift", "alt" and "super".`
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

/** What each member takes, by field, declared once: read bare where the members run, here, and described for the model
 *  where they are declared (`computerDesktop`). */
export const DESKTOP_INPUTS = {
  screenshot: {},
  watch: { seconds: WatchSecondsSchema, fps: v.optional(WatchFpsSchema) },
  // Null: where the pointer is, which moves nothing first.
  click: { at: v.nullable(DesktopPointSchema), button: v.optional(ButtonSchema), count: v.optional(ClickCountSchema), keys: v.optional(ClickKeysSchema) },
  type: { text: TypedTextSchema },
  key: { keys: KeysSchema, hold: v.optional(KeyHoldSchema) },
  scroll: { at: DesktopPointSchema, dy: WheelClicksSchema, dx: v.optional(WheelClicksSchema) },
  move: { at: MoveSchema },
  drag: { from: DesktopPointSchema, to: DesktopPointSchema },
} as const satisfies Record<DesktopMember, v.ObjectEntries>;

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

/** Once `signal` aborts; without one, never. */
function stopped(signal: AbortSignal | undefined): Effect.Effect<void> {
  if (signal === undefined) return Effect.never;

  return Effect.callback<void>((resume) => {
    const stop = (): void => { resume(Effect.void); };

    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });

    return Effect.sync(() => { signal.removeEventListener('abort', stop); });
  });
}

export interface DesktopDeps {
  /** The box's desktop, which `signal` stops; absent, no computer is configured. */
  readonly box: ((request: DesktopRequest, signal: AbortSignal | undefined) => Promise<DesktopAnswer>) | undefined;
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
  const send = (member: DesktopMember, planned: readonly DesktopAction[] | KinuError, context: CallContext): Effect.Effect<ExecutorToolResult | Refusal> => Effect.gen(function* () {
    const { box } = deps;

    if (box === undefined) return deps.notConfigured();

    if (planned instanceof KinuError) return refusalOf(planned);
    let answer: DesktopAnswer = { kind: 'done' };

    for (const action of planned) {
      if (context.signal?.aborted === true) return refusalOf(new KinuError('cancelled', `computer.${member}: its program stopped, so the rest did not reach the screen.`));

      if (!LOOKING.some((looking) => looking === member) && context.detached?.aborted === true) {
        return refusalOf(new KinuError('denied', `computer.${member}: this program was moved to the background; the screen is driven from the turn in the foreground.`));
      }

      // The program's stop reaches the box, which ends the action's run and lets go of what it held before answering.
      answer = yield* Effect.tryPromise({
        try: () => box({ driver: deps.driver, action }, context.signal),
        catch: (cause) => (context.signal?.aborted === true
          ? new KinuError('cancelled', `computer.${member}: its program stopped, so its action on the screen was ended.`)
          : toKinuError({ doing: `computer.${member}`, cause, otherwise: 'unavailable' })),
      });

      if (answer.kind === 'refused') break;
    }

    return answered(member, answer);
  }).pipe(Effect.catch((failure) => Effect.succeed(refusalOf(failure))));

  /**
   * A call, run whole once it holds the screen. Its program's stop ends the wait for the screen at once, behind another
   * program's call; once the call holds the screen, a stop reaches the box, which ends the action and lets go of what
   * it held before answering.
   */
  const drive = (member: DesktopMember, planned: readonly DesktopAction[] | KinuError, context: CallContext): Effect.Effect<ExecutorToolResult | Refusal> => {
    let holding = false;

    const whole = Effect.suspend(() => {
      holding = true;

      return send(member, planned, context);
    }).pipe(Effect.uninterruptible, alone.withPermits(1));

    return Effect.raceFirst(whole, Effect.flatMap(stopped(context.signal), () => (holding ? Effect.never : Effect.succeed(
      refusalOf(new KinuError('cancelled', `computer.${member}: its program stopped while another call held the screen, so nothing reached it.`)),
    ))));
  };

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
    screenshot: member('screenshot', 'The desktop the owner watches, as a PNG data URL.', v.strictObject(DESKTOP_INPUTS.screenshot), () => [{ kind: 'screenshot' }]),
    watch: member('watch', 'The desktop over a few seconds, as one PNG data URL of its frames.', v.strictObject(DESKTOP_INPUTS.watch), ({ seconds, fps }) => [{
      kind: 'watch', seconds, frames: fps === undefined ? Math.min(WATCH_DEFAULT_FRAMES, deps.frames) : Math.max(1, Math.min(deps.frames, Math.round(seconds * fps))),
    }]),
    click: member('click', 'Click at a point of the screen.', v.strictObject(DESKTOP_INPUTS.click), ({ at, button = 'left', count = 1, keys }) => {
      const held = keys === undefined ? [] : desktopChord(chordKeys(keys), true);

      return held instanceof KinuError ? held : [{ kind: 'click', ...at !== null && { at }, button, count, hold: held }];
    }),
    type: member('type', 'Type text at the keyboard focus.', v.strictObject(DESKTOP_INPUTS.type), ({ text }) => typedActions(text)),
    key: member('key', 'Press a key or a chord, or hold it down.', v.strictObject(DESKTOP_INPUTS.key), ({ keys, hold }) => {
      const pressed = desktopChord(chordKeys(keys));

      if (pressed instanceof KinuError) return pressed;

      return [{ kind: 'key', keys: pressed.join('+'), ...(hold !== undefined && { holdMs: hold }) }];
    }),
    scroll: member('scroll', 'Turn the mouse wheel over a point.', v.strictObject(DESKTOP_INPUTS.scroll), ({ at, dy, dx = 0 }) => (
      dy === 0 && dx === 0 ? new KinuError('bad_input', 'nothing to scroll: dy and dx are both 0.') : [{ kind: 'scroll', at, dy, dx }]
    )),
    move: member('move', 'Move the pointer to a point, or by a distance.', v.strictObject(DESKTOP_INPUTS.move), ({ at }) => [
      'by' in at ? { kind: 'move', by: at.by } : { kind: 'move', at },
    ]),
    drag: member('drag', 'Drag with the left button from one point to another.', v.strictObject(DESKTOP_INPUTS.drag), ({ from, to }) => [{ kind: 'drag', from, to }]),
  } satisfies Record<DesktopMember, { readonly description: string }>;

  return Object.fromEntries(Object.entries(members).map(([name, { run, ...declared }]): [string, ExecutorTool] => [name, {
    ...declared,
    execute: async (...args) => await settle(run(args)),
  }]));
}
