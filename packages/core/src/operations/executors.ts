/**
 * The executors' members as programs call them: the workspace (its files, shell, crafted tools and, on Nimbus, its
 * processes, ports and runtimes), your computer, the parent workspace a hire reads, and the user's machine.
 * Each executor is its own namespace on its own plane, so each member is its own operation.
 */
import * as v from 'valibot';
import { ExecutorPortSchema } from '../execution/types';
import { DESKTOP_INPUTS, WATCH_DEFAULT_FRAMES, watchSheet, type DesktopScreen } from '../execution/desktop';
import { CRAFTED_TOOL_BODY, WORKSPACE_FILE_BINDINGS } from '../types/codemode';
import { defineOperation, described, type Impact, type Operation } from './operation';

const Path = described(v.pipe(v.string(), v.nonEmpty()), 'Relative paths resolve at the executor\'s home.');

const Command = v.pipe(v.string(), v.nonEmpty());

const Text = v.string();

/** An executor's member; Plan keeps only what observes. */
const executorOp = (ns: string) => <const I extends v.StrictObjectSchema<v.ObjectEntries, undefined>, const O extends v.GenericSchema>(
  op: Pick<Operation<I, O>, 'name' | 'help' | 'input' | 'output'> & { readonly impact: Impact },
) => defineOperation({ ns, slate: true, ...op });

const ProcessId = described(v.pipe(v.string(), v.nonEmpty()), 'The id `startProcess` answered.');

/** What every machine that keeps long-running processes answers alike (`process_long`): one name and one shape each. */
function processMembers(op: ReturnType<typeof executorOp>) {
  return {
    startProcess: op({
      name: 'startProcess', impact: 'administer',
      help: 'Start a long-running process in the background, such as a server; it returns while the process runs. Put '
        + 'variables at the head of the command (`PORT=4100 node server.js`). `logs` reads what it writes, `stopProcess` ends it.',
      input: v.strictObject({ command: Command, cwd: v.optional(described(v.string(), 'Where it starts; default your home.')) }),
      output: v.strictObject({ processId: v.string() }),
    }),
    stopProcess: op({
      name: 'stopProcess', help: 'End a process `startProcess` started.', impact: 'administer',
      input: v.strictObject({ processId: ProcessId }), output: v.strictObject({ stopped: v.boolean() }),
    }),
    listProcesses: op({
      name: 'listProcesses', impact: 'observe',
      help: 'The processes `startProcess` started, with their status. One stopped at a prompt reads "waiting for input", '
        + 'its last line in `waiting`; where it has a terminal `session` the person can open, answer it with exec '
        + '(`tmux send-keys -t \'=<session>:\' \'<answer>\' Enter`) when the answer is yours to give, or ask the person.',
      input: v.strictObject({}),
      output: v.array(v.strictObject({
        processId: v.string(), pid: v.optional(v.number()), status: v.string(), restartable: v.optional(v.boolean()),
        command: v.string(), session: v.optional(v.string()), waiting: v.optional(v.string()),
      })),
    }),
    logs: op({
      name: 'logs', help: 'What a process wrote, its most recent output.', impact: 'observe', output: Text,
      input: v.strictObject({ processId: ProcessId, lines: v.optional(v.number()), bytes: v.optional(v.number()) }),
    }),
  } as const;
}

const ws = executorOp('workspace');

export const WORKSPACE = {
  readFile: ws({ name: 'readFile', help: 'A file of the workspace, as text.', impact: 'observe', input: v.strictObject({ path: Path }), output: Text }),
  writeFile: ws({
    name: 'writeFile', impact: 'mutate', input: v.strictObject({ path: Path, content: v.string() }), output: Text,
    help: 'Write a file, creating its parent directories. A new file is written at once; replacing one needs readFile first.',
  }),
  readdir: ws({ name: 'readdir', help: 'A directory\'s entry names.', impact: 'observe', input: v.strictObject({ path: Path }), output: v.array(v.string()) }),
  exists: ws({ name: 'exists', help: 'Whether a path exists.', impact: 'observe', input: v.strictObject({ path: Path }), output: v.boolean() }),
  exec: ws({
    name: 'exec', impact: 'execute', output: v.union([Text, v.object({ stdout: v.string(), stderr: v.string(), exitCode: v.number() })]),
    help: 'Run a command in the workspace shell, over the same files readFile reads: a POSIX shell with ~95 coreutils, pipes, '
      + 'redirects, loops and variables. Each call starts fresh in `cwd` (default your home) unless it names a shell, which '
      + 'keeps its directory and exported variables. Use sandbox or device only when the task needs that machine.',
    input: v.strictObject({
      command: Command,
      cwd: v.optional(described(v.string(), 'Where the command starts.')),
      name: v.optional(described(v.pipe(v.string(), v.nonEmpty()), 'A shell that keeps its directory and variables between calls naming it.')),
      parts: v.optional(described(v.literal(true), 'Answer `{ stdout, stderr, exitCode }` as the command wrote them, instead of the text.')),
    }),
  }),
  listTools: ws({
    name: 'listTools', help: 'Your crafted tools, with each one\'s quality score.', impact: 'observe', input: v.strictObject({}),
    output: v.array(v.object({ name: v.string(), description: v.string(), qualityScore: v.number() })),
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
  runCode: ws({
    name: 'runCode', help: 'Run a snippet in a language runtime of the workspace.', impact: 'execute', output: Text,
    input: v.strictObject({
      code: v.pipe(v.string(), v.nonEmpty()),
      language: v.optional(v.picklist(['javascript', 'typescript', 'python', 'ruby', 'shell'])),
      install: v.optional(described(v.picklist(['never', 'ifMissing']), 'Install the runtime when missing; default never.')),
    }),
  }),
  ...processMembers(ws),
  exposePort: ws({
    name: 'exposePort', impact: 'administer', input: v.strictObject({ port: ExecutorPortSchema }), output: Text,
    help: 'A public URL for a port a process serves, then whether it was reached.',
  }),
  unexposePort: ws({ name: 'unexposePort', help: 'Withdraw a port\'s public URL.', impact: 'administer', input: v.strictObject({ port: ExecutorPortSchema }), output: Text }),
  listPorts: ws({ name: 'listPorts', help: 'The exposed ports and their URLs.', impact: 'observe', input: v.strictObject({}), output: Text }),
  installRuntime: ws({ name: 'installRuntime', help: 'Install a language runtime, by spec.', impact: 'administer', input: v.strictObject({ spec: v.pipe(v.string(), v.nonEmpty()) }), output: Text }),
  listRuntimes: ws({ name: 'listRuntimes', help: 'The installed language runtimes.', impact: 'observe', input: v.strictObject({}), output: Text }),
} as const;

const sb = executorOp('computer');

/** The computer container's members; `resize` is declared over the host's own size table. Its files are read and
 *  written through the workspace's, under `/computer`, as every plane's are. */
export const COMPUTER = {
  exec: sb({
    name: 'exec', impact: 'execute', input: v.strictObject({ command: Command }), output: Text,
    help: 'Run a command on your computer. Bun is the default toolchain here (`bun install`, `bun run`, `bun x`, `bun test`). '
      + 'A computer restored after it slept keeps its source and lockfiles but not node_modules or build output: after a failed '
      + 'import there, run `bun install` once.',
  }),
  readdir: sb({
    name: 'readdir', help: 'A directory\'s entries; the working directory when no path is given.', impact: 'observe',
    input: v.strictObject({ path: v.optional(v.string()) }), output: Text,
  }),
  deleteFile: sb({ name: 'deleteFile', help: 'Delete a file on your computer.', impact: 'mutate', input: v.strictObject({ path: Path }), output: Text }),
  exists: sb({ name: 'exists', help: '"true" or "false".', impact: 'observe', input: v.strictObject({ path: Path }), output: Text }),
  ...processMembers(sb),
  rest: sb({
    name: 'rest', help: '"now" saves and stops the computer, ending what runs; "keep" runs on until it asks again.', impact: 'administer',
    input: v.strictObject({ answer: v.picklist(['now', 'keep']) }), output: Text,
  }),
  exposePort: sb({
    name: 'exposePort', help: 'A public URL for a port the computer serves.', impact: 'administer',
    input: v.strictObject({ port: ExecutorPortSchema, name: v.optional(v.string()) }), output: Text,
  }),
  unexposePort: sb({ name: 'unexposePort', help: 'Withdraw a port\'s public URL.', impact: 'administer', input: v.strictObject({ port: ExecutorPortSchema }), output: Text }),
  listPorts: sb({ name: 'listPorts', help: 'The exposed ports and their URLs.', impact: 'observe', input: v.strictObject({}), output: Text }),
} as const;

/** `computer.resize` over the host's sizes, each described as it runs. */
export function computerResize(sizes: readonly { readonly size: string; readonly vcpu: number; readonly memoryMib: number }[]) {
  const choices = sizes.map((row) => `${row.size}: ${String(row.vcpu)} vCPU, ${String(Math.round(row.memoryMib / 102.4) / 10)} GiB`).join('; ');

  return sb({
    name: 'resize', impact: 'administer', output: Text,
    help: `${choices}. A running sandbox restarts at the new size: files stay, supervised servers and ports come back, a running command ends.`,
    input: v.strictObject({ size: v.picklist(sizes.map((row) => row.size)) }),
  });
}

/** A desktop member: the owner's screen is never reachable from a slate. */
const desk = <const I extends v.StrictObjectSchema<v.ObjectEntries, undefined>, const O extends v.GenericSchema>(
  op: Pick<Operation<I, O>, 'name' | 'help' | 'input' | 'output'> & { readonly impact: Impact },
) => defineOperation({ ns: 'computer', slate: false, ...op });

const KEYS_ARE = '"Return", "Tab", "Escape", "BackSpace", "Delete", "Home", "End", "Page_Up", "Page_Down", "Up", "Down", '
  + '"Left", "Right", "space", "F1"-"F12", or a letter, digit or punctuation mark; modifiers before it with "+": "ctrl+l", '
  + '"ctrl+shift+t", "alt+Tab". Enter, Esc, cmd and win are understood.';

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
      input: deskInput(DESKTOP_INPUTS.click, {
        at: point,
        button: 'Default "left".',
        count: '2 double-clicks, 3 triple-clicks; default 1.',
        hold: 'Modifiers held during the click: "ctrl", "shift", "alt", "super", or several joined by "+".',
      }),
    }),
    type: desk({
      name: 'type', impact: 'execute', output: v.null(), help: 'Type text at the keyboard focus. "\\n" presses Return.',
      input: deskInput(DESKTOP_INPUTS.type, { text: 'At most 4,000 characters.' }),
    }),
    key: desk({
      name: 'key', impact: 'execute', output: v.null(), help: 'Press a key, or a chord of modifiers and a key.',
      input: deskInput(DESKTOP_INPUTS.key, { keys: KEYS_ARE, hold: 'Milliseconds to hold it down, as a game reads a held key; at most 10,000.' }),
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

const parent = executorOp('parent');

/** The parent workspace a hire reads, in the parent's own paths. Its files are read and written through the
 *  workspace's, which share its folder, as every plane's are. */
export const PARENT = {
  readdir: parent({ name: 'readdir', help: 'A directory\'s entry names.', impact: 'observe', input: v.strictObject({ path: Path }), output: v.array(v.string()) }),
  exists: parent({ name: 'exists', help: 'Whether a path exists.', impact: 'observe', input: v.strictObject({ path: Path }), output: v.boolean() }),
  exec: parent({
    name: 'exec', impact: 'execute', input: v.strictObject({ command: Command }), output: Text,
    help: 'Run a command in the parent workspace\'s shell, the same coreutils its own agent has: the fast way to search it '
      + '(`grep -rn TODO .`, `find . -name \'*.ts\'`).',
  }),
} as const;

const device = executorOp('device');

const Device = v.optional(described(v.string(), 'With several machines connected, which one, by name.'));

/** The user's own machine; `unavailable` means none is attached, and the error says how to attach one. Its files are
 *  read and written through the workspace's, under `/pc/<machine>`, as every plane's are. */
export const DEVICE = {
  exec: device({ name: 'exec', help: 'Run a command on the machine.', impact: 'execute', input: v.strictObject({ command: Command, device: Device }), output: Text }),
  readdir: device({ name: 'readdir', help: 'A directory\'s entry names.', impact: 'observe', input: v.strictObject({ path: Path, device: Device }), output: v.array(v.string()) }),
  exists: device({ name: 'exists', help: 'Whether a path exists.', impact: 'observe', input: v.strictObject({ path: Path, device: Device }), output: v.boolean() }),
} as const;
