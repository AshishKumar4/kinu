/**
 * The executors' members as programs call them: the workspace (its shell, files, crafted tools and, on Nimbus, its
 * processes and ports), your computer, the parent workspace a hire reads, and the user's machine. What every machine
 * shares is declared once (`machineOperations`, `machineFileOperations`); each keeps its own members beside them.
 */
import * as v from 'valibot';
import { ExecutorPortSchema, type ExecutorCapability } from '../execution/types';
import { DESKTOP_INPUTS, WATCH_DEFAULT_FRAMES, watchSheet, type DesktopScreen } from '../execution/desktop';
import { CRAFTED_TOOL_BODY, WORKSPACE_FILE_BINDINGS } from '../types/codemode';
import { defineOperation, described, opaque, type Impact, type Operation } from './operation';
import { FILE } from './file';

const Command = v.pipe(v.string(), v.nonEmpty());

/** Where a workspace command runs: said by the `shell` tool and by a program's `child_process`. */
export const EXEC_RUNS_WHERE_ITS_CWD_IS = 'A command whose cwd is under /computer runs on the computer, under /pc/<name> on that machine, '
  + 'and anywhere else in the workspace; a `cd` inside the command does not move it.';

/** When a command answers, on every machine: said by its `exec` and by the `shell` tool. */
export const EXEC_ANSWERS_AT_EXIT = 'It answers when the command itself exits: a process it starts in the background keeps running, '
  + 'and what that process writes afterwards is not returned.';

const Text = v.string();

/** An executor's member; Plan keeps only what observes. */
const executorOp = (ns: string) => <const I extends v.StrictObjectSchema<v.ObjectEntries, undefined>, const O extends v.GenericSchema>(
  op: Pick<Operation<I, O>, 'name' | 'help' | 'input' | 'output'> & { readonly impact: Impact },
) => defineOperation({ ns, slate: true, ...op });

const Device = v.optional(described(v.string(), 'With several machines connected, which one, by name.'));

const ProcessId = described(v.pipe(v.string(), v.nonEmpty()), 'The id `startProcess` answered.');

const RouteSchema = described(v.union([
  v.strictObject({ reached: v.literal(true) }),
  v.strictObject({ reached: v.literal(false), gate: v.string(), detail: v.string() }),
]), 'Whether a request to the URL reaches the server, or the preview-route gate that refused it. The check never calls your server.');

/** One executor op builder, each member's input widened by `option` (the device fleet's machine selector). */
type MachineOp = ReturnType<typeof executorOp>;

/** What every machine answers alike, each member under the capability that admits it: one name and one shape. */
function machineMembers<const O extends v.ObjectEntries>(op: MachineOp, option: O) {
  const input = <const E extends v.ObjectEntries>(entries: E) => v.strictObject({ ...entries, ...option });

  return {
    shell: {
      exec: op({
        name: 'exec', impact: 'execute', output: v.union([Text, v.strictObject({ stdout: v.string(), stderr: v.string(), exitCode: v.number() })]),
        help: 'Run a shell command on this machine. Each call starts fresh in `cwd` (default its home) unless it names a shell, '
          + `which keeps its directory and exported variables. ${EXEC_ANSWERS_AT_EXIT}`,
        input: input({
          command: Command,
          cwd: v.optional(described(v.string(), 'Where the command starts.')),
          name: v.optional(described(v.pipe(v.string(), v.nonEmpty()), 'A shell that keeps its directory and variables between calls naming it.')),
          parts: v.optional(described(v.literal(true), 'Answer `{ stdout, stderr, exitCode }` as the command wrote them, instead of the text.')),
        }),
      }),
    },
    process_long: {
      startProcess: op({
        name: 'startProcess', impact: 'administer',
        help: 'Start a long-running process in the background, such as a server; it returns while the process runs. Put '
          + 'variables at the head of the command (`PORT=4100 node server.js`). `logs` reads what it writes, `stopProcess` ends it.',
        input: input({ command: Command, cwd: v.optional(described(v.string(), 'Where it starts; default its home.')) }),
        output: v.strictObject({
          processId: v.string(),
          jobId: v.optional(described(v.string(), 'The background job it runs as on the workspace: its end wakes you.')),
        }),
      }),
      stopProcess: op({
        name: 'stopProcess', help: 'End a process `startProcess` started.', impact: 'administer',
        input: input({ processId: ProcessId }), output: v.strictObject({ stopped: v.boolean() }),
      }),
      listProcesses: op({
        name: 'listProcesses', impact: 'observe',
        help: 'The processes `startProcess` started, with their status. One stopped at a prompt reads "waiting for input", '
          + 'its last line in `waiting`; where it has a terminal `session` the person can open, answer it with exec '
          + '(`tmux send-keys -t \'=<session>:\' \'<answer>\' Enter`) when the answer is yours to give, or ask the person.',
        input: input({}),
        output: v.array(v.strictObject({
          processId: v.string(), pid: v.optional(v.number()), status: v.string(), restartable: v.optional(v.boolean()),
          command: v.string(), session: v.optional(v.string()), waiting: v.optional(v.string()),
        })),
      }),
      logs: op({
        name: 'logs', help: 'What a process wrote, its most recent output.', impact: 'observe', output: Text,
        input: input({ processId: ProcessId, lines: v.optional(v.number()), bytes: v.optional(v.number()) }),
      }),
    },
    net_inbound: {
      exposePort: op({
        name: 'exposePort', impact: 'administer',
        help: 'A public URL for a port a process on this machine serves. Start the server first; nothing listening is refused with the fix.',
        input: input({ port: ExecutorPortSchema, name: v.optional(described(v.string(), 'A label for the preview\'s address.')) }),
        output: v.strictObject({ port: v.number(), url: v.string(), name: v.optional(v.string()), route: RouteSchema }),
      }),
      unexposePort: op({ name: 'unexposePort', help: 'Withdraw a port\'s public URL.', impact: 'administer', input: input({ port: ExecutorPortSchema }), output: v.null() }),
      listPorts: op({
        name: 'listPorts', help: 'The exposed ports and their URLs.', impact: 'observe', input: input({}),
        output: v.array(v.strictObject({ port: v.number(), url: v.string(), name: v.optional(v.string()), status: v.picklist(['listening', 'unknown', 'unreachable']) })),
      }),
    },
  } as const;
}

/** The capabilities that admit machine members, in the order a namespace lists them. */
export const MACHINE_CAPABILITIES = ['shell', 'process_long', 'net_inbound'] as const satisfies readonly ExecutorCapability[];

/** Every machine member a namespace may have, by capability: what `executorNamespace` admits from a machine's own set. */
export function machineOperations(ns: string) {
  const op = executorOp(ns);

  return ns === 'device' ? machineMembers(op, { device: Device }) : machineMembers(op, {});
}

const ws = executorOp('workspace');

const WORKSPACE = {
  listTools: ws({
    name: 'listTools', impact: 'observe', input: v.strictObject({}),
    help: 'Your crafted tools, best first: each one\'s preference (how often you chose it when offered, weighted by how '
      + 'the turns that used it were rated, 0 to 1) and, if its last call raised, the error.',
    output: v.array(v.object({ name: v.string(), description: v.string(), preference: v.number(), broken: v.nullable(v.string()) })),
  }),
  createTool: ws({
    name: 'createTool', impact: 'mutate',
    help: 'Save a crafted tool, callable as `tools.<name>(args)` from the next program; the same name updates it. `code` is '
      + `${CRAFTED_TOOL_BODY}; helpers may precede it. In its body, ${WORKSPACE_FILE_BINDINGS}, and call `
      + '`tools.<name>(args)`; `require`, `import` and `eval` are refused. `code` may be the function itself, '
      + '`createTool(name, description, async (args) => { ... })`, saved as its source: it closes over nothing in this program.',
    input: v.strictObject({ name: v.pipe(v.string(), v.nonEmpty()), description: v.pipe(v.string(), v.nonEmpty()), code: v.pipe(v.string(), v.nonEmpty()) }),
    output: v.object({ name: v.string(), action: v.picklist(['created', 'updated']) }),
  }),
  retireTool: ws({
    name: 'retireTool', impact: 'mutate',
    help: 'Delete a crafted tool you no longer need, or one that keeps raising and is not worth a rewrite.',
    input: v.strictObject({ name: v.pipe(v.string(), v.nonEmpty()) }),
    output: v.object({ name: v.string(), action: v.literal('retired') }),
  }),
} as const;

const sb = executorOp('computer');

/** The computer container's own members; `resize` is declared over the host's own size table. Its files are
 *  `computer.fs`, the workspace's file operations at `/computer`. */
const COMPUTER = {
  rest: sb({
    name: 'rest', help: '"now" saves and stops the computer, ending what runs; "keep" runs on until it asks again.', impact: 'administer',
    input: v.strictObject({ answer: v.picklist(['now', 'keep']) }), output: Text,
  }),
} as const;

const RESIZES = 'A running sandbox restarts at the new size: files stay, supervised servers and ports come back, a running command ends.';

/** The computer's members a host serves over its own tables, as every host declares them: `resize` only where the host
 *  has sizes, its choices those sizes (`computerResize`). */
const COMPUTER_HOSTED = {
  resize: sb({ name: 'resize', impact: 'administer', output: Text, help: RESIZES, input: v.strictObject({ size: v.string() }) }),
} as const;

/** `computer.resize` over the host's sizes, each described as it runs. */
export function computerResize(sizes: readonly { readonly size: string; readonly vcpu: number; readonly memoryMib: number }[]) {
  const choices = sizes.map((row) => `${row.size}: ${String(row.vcpu)} vCPU, ${String(Math.round(row.memoryMib / 102.4) / 10)} GiB`).join('; ');

  return defineOperation({
    ...COMPUTER_HOSTED.resize, help: `${choices}. ${RESIZES}`, input: v.strictObject({ size: v.picklist(sizes.map((row) => row.size)) }),
  });
}

/** A desktop member: the owner's screen is never reachable from a slate. */
const desk = <const I extends v.StrictObjectSchema<v.ObjectEntries, undefined>, const O extends v.GenericSchema>(
  op: Pick<Operation<I, O>, 'name' | 'help' | 'input' | 'output'> & { readonly impact: Impact },
) => defineOperation({ ns: 'computer', slate: false, ...op });

const KEYS_ARE = 'The keys pressed together, as an array: "Return", "Tab", "Escape", "BackSpace", "Delete", "Home", "End", "Page_Up", '
  + '"Page_Down", "Up", "Down", "Left", "Right", "space", "F1"-"F12", a letter, digit or punctuation mark, and modifiers: '
  + '["ctrl", "l"], ["ctrl", "shift", "t"], ["alt", "Tab"], or ["w", "space"] for two at once. Enter, Esc, cmd and win are understood.';

/** The keys of a chord as the model reads them, however the desktop reads them (`DESKTOP_INPUTS`): an array of
 *  strings, its one documented form. */
const KEY_LIST = { type: 'array', items: { type: 'string' } } as const;

/** What a watch's frames cost, from the box's layout: each frame's size, then the image the default and the most make,
 *  as screenshots' worth of pixels, which is what an image costs. */
function watchPays(screen: DesktopScreen): string {
  const most = screen.sheet.columns.length;
  const size = (sheet: { readonly width: number; readonly height: number }): string => `${String(sheet.width)}×${String(sheet.height)}`;

  const made = (frames: number): string => {
    const sheet = watchSheet(screen, frames);
    const shots = Number(sheet.screenshots.toFixed(1));

    return `${String(frames)} make a ${size(sheet)} image, as much as ${String(shots)} screenshot${shots === 1 ? '' : 's'}`;
  };

  return `Frames a second, at most ${String(most)} in all; without it, ${String(WATCH_DEFAULT_FRAMES)}. Each frame is `
    + `${size(watchSheet(screen, 1))}, ${String(screen.sheet.percent)}% of the screen's width and height, and an image costs by its size: `
    + `${made(WATCH_DEFAULT_FRAMES)}; ${made(most)}.`;
}

/** A desktop member's input as the model reads it: its fields as the desktop declares them (`DESKTOP_INPUTS`), each
 *  with its words, inside its `optional` where it has one. */
function deskInput<const E extends v.ObjectEntries>(entries: E, words: { readonly [F in keyof E]: string }) {
  const said = new Map<string, string>(Object.entries(words));

  return v.strictObject(Object.fromEntries(Object.entries(entries).map(([field, schema]) => {
    const text = said.get(field) ?? '';

    return [field, v.isOfType('optional', schema) ? v.optional(described(schema.wrapped, text)) : described(schema, text)];
  })));
}

/** The desktop's members over the screen the box runs, its size declared once, where the model reads it (D89). */
export function computerDesktop(screen: DesktopScreen) {
  const size = `${String(screen.width)}×${String(screen.height)}`;
  const point = `A point on the screen, [x, y]: pixels from its top left, x below ${String(screen.width)} and y below ${String(screen.height)}.`;
  const Image = described(v.string(), 'A PNG data URL. Returned from the program, it is shown to you.');

  return {
    screenshot: desk({
      name: 'screenshot', impact: 'observe', input: deskInput(DESKTOP_INPUTS.screenshot, {}), output: Image,
      help: `The desktop: the screen the owner watches in the Computer pane, ${size}, as an image. Starts the desktop if it `
        + 'is not running; start programs that open windows after it. Return it from the program to see it.',
    }),
    watch: desk({
      name: 'watch', impact: 'observe', output: Image,
      help: 'The desktop over a few seconds, to see what moves or changes: its frames, taken evenly, in one image.',
      input: deskInput(DESKTOP_INPUTS.watch, { seconds: 'How long to watch, at most 10.', fps: watchPays(screen) }),
    }),
    click: desk({
      name: 'click', impact: 'execute', output: v.null(), help: 'Click at a point.',
      input: deskInput({ ...DESKTOP_INPUTS.click, keys: v.optional(opaque(DESKTOP_INPUTS.click.keys.wrapped, KEY_LIST)) }, {
        at: point,
        button: 'Default "left".',
        count: '2 double-clicks, 3 triple-clicks; default 1.',
        keys: 'Modifiers held during the click, as an array: ["shift"] or ["ctrl", "shift"].',
      }),
    }),
    type: desk({
      name: 'type', impact: 'execute', output: v.null(), help: 'Type text at the keyboard focus. "\\n" presses Return.',
      input: deskInput(DESKTOP_INPUTS.type, { text: 'At most 4,000 characters.' }),
    }),
    key: desk({
      name: 'key', impact: 'execute', output: v.null(), help: 'Press a key, or a chord: keys pressed together.',
      input: deskInput({ ...DESKTOP_INPUTS.key, keys: opaque(DESKTOP_INPUTS.key.keys, KEY_LIST) }, {
        keys: `${KEYS_ARE} The space bar is "space".`,
        hold: 'Milliseconds it stays down before it is released, as a game reads a held key; 1 to 10,000. There is no '
          + 'separate key down or key up: hold it for as long as it should act.',
      }),
    }),
    scroll: desk({
      name: 'scroll', impact: 'execute', output: v.null(), help: 'Turn the mouse wheel over a point: what is under it scrolls.',
      input: deskInput(DESKTOP_INPUTS.scroll, { at: point, dy: 'Wheel clicks down; negative scrolls up.', dx: 'Wheel clicks right; negative scrolls left.' }),
    }),
    move: desk({
      name: 'move', impact: 'execute', output: v.null(), help: 'Move the pointer to a point without clicking, to hover.',
      input: deskInput(DESKTOP_INPUTS.move, { at: point }),
    }),
    drag: desk({
      name: 'drag', impact: 'execute', output: v.null(), help: 'Press the left button at one point, move to another, release.',
      input: deskInput(DESKTOP_INPUTS.drag, { from: 'Where the drag starts.', to: 'Where it ends.' }),
    }),
  } as const;
}

/** The parent workspace a hire reads: its shell alone, in the parent's own paths. Its files are the folder it shares
 *  with you, read through `file`. */
const PARENT = {} as const;

/** The user's own machine: its shell, and its files as `device.fs`. `unavailable` means none is attached, and the error
 *  says how to attach one. */
const DEVICE = {} as const;

/** The member group a machine's own files are under: `computer.fs.read(path)`. */
export const MACHINE_FILES = 'fs';

const MachinePath = described(v.pipe(v.string(), v.trim(), v.nonEmpty()),
  'A path on this machine, as its own shell names it; a relative one starts at its home.');

/**
 * `<machine>.fs`: the `file` operations, each on this machine's own paths. They answer as `file` does, naming each file
 * where the file plane holds it (`/computer/…`), so a read through either lets an edit through the other.
 */
export function machineFileOperations(ns: string): Readonly<Record<string, Operation>> {
  const option: v.ObjectEntries = ns === 'device' ? { device: Device } : {};

  return Object.fromEntries(Object.values<Operation>(FILE).map((op) => [`${MACHINE_FILES}.${op.name}`, defineOperation({
    ...op, ns, name: `${MACHINE_FILES}.${op.name}`, input: v.strictObject({ ...op.input.entries, path: MachinePath, ...option }),
  })]));
}

/** Each executor's own members and what it is, by its name; what every machine shares is admitted by its capabilities. */
export const EXECUTOR_OPERATIONS = new Map<string, { readonly ops: Readonly<Record<string, Operation>>; readonly summary: string }>([
  ['workspace', { ops: WORKSPACE, summary: 'Your workspace: its files and shell, the tools you save, and its slates.' }],
  ['computer', {
    ops: COMPUTER,
    summary: 'Your computer, a Linux machine with files and a shell of its own. Bun is its default toolchain (`bun install`, '
      + '`bun run`, `bun x`, `bun test`); restored after it slept, it keeps source and lockfiles but not node_modules or '
      + 'build output, so after a failed import run `bun install` once.',
  }],
  ['parent', { ops: PARENT, summary: 'The workspace that hired you; its shell is the fast way to search it (`grep -rn`, `find`).' }],
  ['device', { ops: DEVICE, summary: 'The user\'s machine.' }],
]);

/**
 * Every member each executor may serve, by name: what any machine may share, its own, and what a host serves over its
 * own tables. The desktop's members are none of them: each is `slate: false`, so a slate is refused them all the same.
 */
export const EXECUTOR_CATALOG: ReadonlyMap<string, Readonly<Record<string, Operation>>> = new Map([...EXECUTOR_OPERATIONS].map(([ns, { ops }]) => [
  ns, Object.assign({}, ...Object.values<Readonly<Record<string, Operation>>>(machineOperations(ns)), machineFileOperations(ns), ops,
    ns === 'computer' ? COMPUTER_HOSTED : {}),
]));
