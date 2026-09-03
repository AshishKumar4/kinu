/**
 * A real pseudo-terminal for the TUI, and a screen read back out of it.
 *
 * Why this exists: `createTestRenderer` writes frames into a buffer and takes
 * keys as bytes on a fake stdin. It never negotiates with a terminal. A real
 * terminal answers the renderer's progressive-enhancement query, and from then
 * on it encodes keys differently — so a key test that passes in process can
 * pass while the same keystroke does something else in a terminal.
 *
 * The driver is Python's `pty` because a pty needs `TIOCSWINSZ` (a TUI with no
 * window size renders nothing) and a controlling terminal in a new session.
 * `script -qefc` gives neither: measured 2026-09-03, it leaves the child at
 * 0x0 with no tty on stdout.
 */
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as v from 'valibot';
import { scratchPath } from '@kinu.run/test-utils';

/** Terminal bytes to a screen, keyed to what the renderer emits. */
const CSI = '\u001B[';

export type PtyStep =
  /** Read until the screen shows this text, or fail the whole run. */
  | { readonly wait: string; readonly timeout?: number }
  /** Write bytes into the terminal, exactly as a keyboard would. */
  | { readonly send: string }
  | { readonly sleep: number };

const PtyResultSchema = v.object({
  output: v.string(),
  waits: v.array(v.object({ text: v.string(), found: v.boolean(), afterMs: v.number() })),
  exited: v.boolean(),
});

const DRIVER = String.raw`
import base64, json, os, pty, re, select, struct, sys, termios, fcntl, time

spec = json.loads(sys.argv[1])
cols, rows = spec["cols"], spec["rows"]

pid, master = pty.fork()
if pid == 0:
    os.environ.update(spec["env"])
    os.chdir(spec["cwd"])
    os.execvp(spec["cmd"][0], spec["cmd"])

fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

raw = bytearray()
ansi = re.compile(rb"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[\[\]][0-9;:?<>=!]*[a-zA-Z~]|\x1b[()][AB012]|\x1b[=>NOPMc]|[\x00-\x08\x0b\x0c\x0e-\x1f]")

def pump(seconds):
    end = time.time() + seconds
    while time.time() < end:
        ready, _, _ = select.select([master], [], [], 0.05)
        if not ready:
            continue
        try:
            chunk = os.read(master, 65536)
        except OSError:
            return False
        if not chunk:
            return False
        raw.extend(chunk)
    return True

def screen():
    return ansi.sub(b" ", bytes(raw)).decode("utf-8", "replace")

alive = True
waits = []
started = time.time()
for step in spec["steps"]:
    if "wait" in step:
        deadline = time.time() + step.get("timeout", 15)
        found = step["wait"] in screen()
        while not found and time.time() < deadline and alive:
            alive = pump(0.1)
            found = step["wait"] in screen()
        waits.append({"text": step["wait"], "found": found, "afterMs": int((time.time() - started) * 1000)})
        if not found:
            break
    elif "send" in step:
        os.write(master, step["send"].encode("utf-8"))
    else:
        alive = pump(step["sleep"])

pump(0.4)
os.kill(pid, 9)
os.waitpid(pid, 0)
print(json.dumps({
    "output": base64.b64encode(bytes(raw)).decode("ascii"),
    "waits": waits,
    "exited": not alive,
}))
`;

export interface PtyRun {
  /** Every byte the terminal received, in order. */
  readonly raw: string;
  /** The last painted frame, as a person would read it. */
  readonly screen: string;
  /** Every frame, oldest first. */
  readonly frames: readonly string[];
  /** Each `wait` step, in order, with whether its text ever appeared. */
  readonly waits: ReadonlyArray<{ readonly text: string; readonly found: boolean; readonly afterMs: number }>;
}

/**
 * Run a TUI entry point on a real pty and drive it with real keystrokes.
 *
 * `home` is the run's `KINU_HOME`, so preferences and themes stay off the
 * developer's own install.
 */
export function runTuiInPty(entry: string, options: {
  readonly steps: readonly PtyStep[];
  readonly cols?: number;
  readonly rows?: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly term?: string;
}): PtyRun {
  const python = Bun.which('python3');
  if (!python) throw new Error('python3 is required for the pty tests');
  // The pty child's KINU_HOME and the driver beside it: minted through the
  // shared scratch owner, which the test preload releases for the whole run.
  const driver = scratchPath('pty-screen', 'driver.py');
  const home = join(driver, '..');
  writeFileSync(driver, DRIVER);
  const spec = {
    cmd: [process.execPath, entry],
    cols: options.cols ?? 100,
    rows: options.rows ?? 30,
    cwd: home,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      KINU_HOME: home,
      TERM: options.term ?? 'xterm-256color',
      COLORTERM: 'truecolor',
      ...options.env,
    },
    steps: options.steps,
  };
  const proc = Bun.spawnSync({
    cmd: [python, driver, JSON.stringify(spec)],
    cwd: resolve(import.meta.dir, '..'),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = proc.stdout.toString().trim();
  if (!proc.success || !stdout.startsWith('{')) {
    throw new Error(`pty driver failed (${String(proc.exitCode)}): ${proc.stderr.toString()}${stdout}`);
  }
  const result = v.parse(PtyResultSchema, JSON.parse(stdout));
  const raw = Buffer.from(result.output, 'base64').toString('utf8');
  const frames = splitFrames(raw);
  return { raw, screen: frames.at(-1) ?? '', frames, waits: result.waits };
}

/**
 * The byte stream cut into frames.
 *
 * The renderer starts every full paint by homing the cursor (`CSI H`), so that
 * is the frame boundary. Text is what is left once the escape sequences are
 * out: one space per sequence, because a sequence sits between cells and
 * dropping it would join words that are apart on screen.
 */
function splitFrames(raw: string): string[] {
  const frames: string[] = [];
  for (const chunk of raw.split(`${CSI}H`)) {
    const text = stripSequences(chunk).trimEnd();
    if (text.trim() !== '') frames.push(text);
  }
  return frames;
}

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const NUL = String.fromCharCode(0);
const BS = String.fromCharCode(8);
const VT = String.fromCharCode(11);
const FF = String.fromCharCode(12);
const SO = String.fromCharCode(14);
const US = String.fromCharCode(31);
const SEQUENCES = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|${ESC}[[\\]][0-9;:?<>=!]*[a-zA-Z~]|${ESC}[()][AB012]|${ESC}[=>NOPMc]|[${NUL}-${BS}${VT}${FF}${SO}-${US}]`, 'gu');

export function stripSequences(chunk: string): string {
  return chunk.replace(SEQUENCES, ' ');
}

/**
 * The foreground colour the terminal was left in for a run of text, as
 * `#RRGGBB`. The renderer writes truecolor SGR (`38;2;r;g;b`) before the
 * cells, so the last one before the text is the ink that painted it.
 */
export function inkBefore(raw: string, text: string): string | null {
  const index = raw.indexOf(text);
  if (index < 0) return null;
  const sgr = new RegExp(`${ESC}\\[38;2;(\\d+);(\\d+);(\\d+)m`, 'gu');
  let ink: string | null = null;
  for (let match = sgr.exec(raw); match !== null && match.index < index; match = sgr.exec(raw)) {
    ink = `#${[match[1], match[2], match[3]].map((channel) => Number(channel).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
  }
  return ink;
}
