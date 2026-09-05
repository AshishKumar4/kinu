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
 *
 * THE SCREEN IS A CELL GRID. The renderer paints by moving the cursor and
 * writing only the cells that changed since its last frame, so a word the
 * terminal shows whole need never cross the wire whole. Measured 2026-09-05 on
 * the shipped surface over a real pty: the composer placeholder going from
 * `Connecting…` to `Send a message…` arrived as `CSI 29;31H` `Se`,
 * `CSI 29;34H` `d a message…`. The shared `n` was never rewritten, and a `wait`
 * that searched the stripped stream sat for its whole bound on a placeholder
 * every terminal was displaying. That is what held the first-run tier red on
 * staging on 2026-09-04. So the driver keeps the grid a terminal keeps (cursor
 * moves, erases, wrap, wide cells), every `wait` and every `screen` reads that
 * grid, and a sequence the grid does not model fails the run instead of
 * passing over it.
 */
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as v from 'valibot';
import { scratchPath } from '@kinu.run/test-utils';

export type PtyStep =
  /** Read until the screen shows this text, or fail the whole run. */
  | { readonly wait: string; readonly timeout?: number }
  /** Read until the screen no longer shows this text, or fail the whole run.
   *  An overlay leaving the screen is the product's own word that whatever it
   *  covered has its keys back. */
  | { readonly gone: string; readonly timeout?: number }
  /** Write bytes into the terminal, exactly as a keyboard would. */
  | { readonly send: string }
  | { readonly sleep: number };

const PtyResultSchema = v.object({
  output: v.string(),
  screen: v.string(),
  waits: v.array(v.object({
    until: v.picklist(['shown', 'gone']), text: v.string(), met: v.boolean(), afterMs: v.number(),
  })),
  exited: v.boolean(),
  /** CSI final bytes the screen model met and does not follow; empty on a run
   *  whose every wait and screen can be trusted. */
  unmodelled: v.string(),
});

const DRIVER = String.raw`
import base64, codecs, json, os, pty, select, struct, sys, termios, fcntl, time, unicodedata


class Screen:
    """The cell grid a terminal shows, fed the bytes it would receive.

    Enough of a VT to follow the renderer: cursor placement (CUP, CHA, VPA, the
    relative moves, save/restore), the erases (ED, EL, ECH), CR/LF/BS/TAB, wrap
    at the right edge, and the wide and zero-width cells a row's text must keep
    in step. Colour, modes, queries and cursor shape change no cell and are
    parsed only far enough to be skipped whole. A control that WOULD move cells
    and is not modelled (insert, delete, scroll, margins, tab and line moves)
    is recorded in unmodelled, so a run over it fails instead of reading a
    grid the terminal never showed.
    """

    UNMODELLED = "@PLMSTrEFIZ" + "\x60" + "ae"

    def __init__(self, rows, cols):
        self.rows, self.cols = rows, cols
        self.cells = [[" "] * cols for _ in range(rows)]
        self.row = self.col = 0
        self.unmodelled = set()
        self.saved = (0, 0)
        self.pending = ""
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")

    def feed(self, chunk):
        for ch in self.decoder.decode(chunk):
            if self.pending:
                self.pending += ch
                if self.sequence_done():
                    self.apply(self.pending)
                    self.pending = ""
            elif ch == "\x1b":
                self.pending = ch
            else:
                self.plain(ch)

    def sequence_done(self):
        s = self.pending
        if len(s) < 2:
            return False
        kind = s[1]
        if kind == "[":                       # CSI: params, intermediates, one final byte
            return len(s) > 2 and "@" <= s[-1] <= "~"
        if kind == "]":                       # OSC: BEL or ST
            return s.endswith("\x07") or s.endswith("\x1b\\")
        if kind in "PX^_":                    # DCS, SOS, PM, APC: ST
            return s.endswith("\x1b\\")
        if " " <= kind <= "/":                # ESC ( B and kin: intermediates, then a final byte
            return "0" <= s[-1] <= "~"
        return True                           # ESC 7, ESC 8, ESC c, ESC =: one byte

    def apply(self, s):
        if s[1] != "[":
            if s == "\x1b7":
                self.saved = (self.row, self.col)
            elif s == "\x1b8":
                self.row, self.col = self.saved
            elif s == "\x1bc":
                self.erase(0, 0, self.rows * self.cols)
                self.row = self.col = 0
            return
        body, final = s[2:-1], s[-1]
        private = body[:1] if body[:1] in "<=>?" else ""
        digits = body[len(private):]
        inter = digits.lstrip("0123456789;:")
        digits = digits[:len(digits) - len(inter)]
        if private or inter:                  # modes, queries, cursor shape: no cell moves
            return
        n = [int(p) if p.isdigit() else 0 for p in digits.split(";")] if digits else []

        def arg(k, default):
            return n[k] if k < len(n) and n[k] > 0 else default

        if final in "Hf":
            self.row, self.col = arg(0, 1) - 1, arg(1, 1) - 1
        elif final == "A":
            self.row -= arg(0, 1)
        elif final == "B":
            self.row += arg(0, 1)
        elif final == "C":
            self.col += arg(0, 1)
        elif final == "D":
            self.col -= arg(0, 1)
        elif final == "G":
            self.col = arg(0, 1) - 1
        elif final == "d":
            self.row = arg(0, 1) - 1
        elif final == "J":
            mode = n[0] if n else 0
            at = self.row * self.cols + self.col
            if mode == 0:
                self.erase(self.row, self.col, self.rows * self.cols - at)
            elif mode == 1:
                self.erase(0, 0, at + 1)
            else:
                self.erase(0, 0, self.rows * self.cols)
        elif final == "K":
            mode = n[0] if n else 0
            if mode == 0:
                self.erase(self.row, self.col, self.cols - self.col)
            elif mode == 1:
                self.erase(self.row, 0, self.col + 1)
            else:
                self.erase(self.row, 0, self.cols)
        elif final == "X":
            self.erase(self.row, self.col, arg(0, 1))
        elif final == "s":
            self.saved = (self.row, self.col)
        elif final == "u":
            self.row, self.col = self.saved
        elif final in self.UNMODELLED:
            self.unmodelled.add(final)
        self.row = min(max(self.row, 0), self.rows - 1)
        self.col = min(max(self.col, 0), self.cols - 1)

    def erase(self, row, col, count):
        at = row * self.cols + col
        for i in range(at, min(at + count, self.rows * self.cols)):
            self.cells[i // self.cols][i % self.cols] = " "

    def linefeed(self):
        if self.row + 1 < self.rows:
            self.row += 1
        else:
            self.cells.pop(0)
            self.cells.append([" "] * self.cols)

    def plain(self, ch):
        if ch == "\r":
            self.col = 0
        elif ch == "\n":
            self.linefeed()
        elif ch == "\b":
            self.col = max(0, self.col - 1)
        elif ch == "\t":
            self.col = min(self.cols - 1, (self.col // 8 + 1) * 8)
        elif ch < " " or "\x7f" <= ch <= "\x9f":
            return
        elif unicodedata.category(ch) in ("Mn", "Me", "Cf"):
            # A combining mark or joiner rides the cell before it and takes no column.
            if self.col > 0:
                self.cells[self.row][self.col - 1] += ch
        else:
            if self.col >= self.cols:
                self.col = 0
                self.linefeed()
            self.cells[self.row][self.col] = ch
            self.col += 1
            if unicodedata.east_asian_width(ch) in ("W", "F") and self.col < self.cols:
                self.cells[self.row][self.col] = ""
                self.col += 1

    def text(self):
        return "\n".join("".join(row).rstrip() for row in self.cells)


# Screen-only mode: the bytes on stdin, shown on a rows x cols grid. This is how
# the model above is tested against captured renderer output without a pty.
if sys.argv[1] == "--screen":
    shown = Screen(int(sys.argv[2]), int(sys.argv[3]))
    shown.feed(sys.stdin.buffer.read())
    if shown.unmodelled:
        sys.stderr.write("unmodelled CSI finals: " + "".join(sorted(shown.unmodelled)))
        sys.exit(2)
    sys.stdout.write(shown.text())
    sys.exit(0)

spec = json.loads(sys.argv[1])
cols, rows = spec["cols"], spec["rows"]

pid, master = pty.fork()
if pid == 0:
    os.environ.update(spec["env"])
    os.chdir(spec["cwd"])
    os.execvp(spec["cmd"][0], spec["cmd"])

fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

raw = bytearray()
screen = Screen(rows, cols)

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
        screen.feed(chunk)
    return True

alive = True
waits = []
started = time.time()
for step in spec["steps"]:
    if "wait" in step or "gone" in step:
        until = "gone" if "gone" in step else "shown"
        text = step["gone"] if until == "gone" else step["wait"]
        deadline = time.time() + step.get("timeout", 15)
        met = (text in screen.text()) == (until == "shown")
        while not met and time.time() < deadline and alive:
            alive = pump(0.1)
            met = (text in screen.text()) == (until == "shown")
        waits.append({"until": until, "text": text, "met": met, "afterMs": int((time.time() - started) * 1000)})
        if not met:
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
    "screen": screen.text(),
    "waits": waits,
    "exited": not alive,
    "unmodelled": "".join(sorted(screen.unmodelled)),
}))
`;

/** One `wait` or `gone` step's verdict: what the screen had to show (or stop
 *  showing), whether it did before the step's bound, and when the step ended
 *  relative to the run's start. */
export interface PtyWait {
  readonly until: 'shown' | 'gone';
  readonly text: string;
  readonly met: boolean;
  readonly afterMs: number;
}

export interface PtyRun {
  /** Every byte the terminal received, in order. */
  readonly raw: string;
  /** The screen as the run left it: one line per terminal row, trailing
   *  blanks cut, exactly what a person looking at the terminal would read. */
  readonly screen: string;
  /** Each `wait` and `gone` step, in order. The first unmet one ended the run. */
  readonly waits: readonly PtyWait[];
}

/** The interpreter and the driver file, written where the shared scratch owner
 *  releases it for the whole run. */
function installDriver() {
  const python = Bun.which('python3');
  if (!python) throw new Error('python3 is required for the pty tests');
  const driver = scratchPath('pty-screen', 'driver.py');
  writeFileSync(driver, DRIVER);
  return { python, driver };
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
  // The pty child's KINU_HOME is the driver's own directory.
  const { python, driver } = installDriver();
  const home = join(driver, '..');
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
    // `import.meta.dirname` — not Bun's `import.meta.dir`, which is undefined
    // under any other runner and turns this resolve into the crash the
    // first-run tier's vitest process hit.
    cwd: resolve(import.meta.dirname),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = proc.stdout.toString().trim();
  if (!proc.success || !stdout.startsWith('{')) {
    throw new Error(`pty driver failed (${String(proc.exitCode)}): ${proc.stderr.toString()}${stdout}`);
  }
  const result = v.parse(PtyResultSchema, JSON.parse(stdout));
  if (result.unmodelled !== '') {
    // A grid the terminal never showed proves nothing either way, so the run
    // is refused rather than read. Extending the model is the fix.
    throw new Error(`the pty screen model met CSI controls it does not follow (final bytes `
      + `${JSON.stringify(result.unmodelled)}), so no wait over this run can be trusted`);
  }
  const raw = Buffer.from(result.output, 'base64').toString('utf8');
  return { raw, screen: result.screen, waits: result.waits };
}

/**
 * The screen a `rows` × `cols` terminal shows after receiving `bytes`, read by
 * the same model every `wait` reads. For testing the model against captured
 * renderer output, so a byte pattern that blinded a wait once can be pinned.
 */
export function screenOf(bytes: string, size: { readonly rows: number; readonly cols: number }): string {
  const { python, driver } = installDriver();
  const proc = Bun.spawnSync({
    cmd: [python, driver, '--screen', String(size.rows), String(size.cols)],
    stdin: Buffer.from(bytes, 'utf8'),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (!proc.success) {
    throw new Error(`pty screen model failed (${String(proc.exitCode)}): ${proc.stderr.toString()}`);
  }
  return proc.stdout.toString();
}

const ESC = String.fromCharCode(27);

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
