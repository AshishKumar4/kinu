/**
 * What kind of terminal each environment can give a user, and the line-mode
 * driver for the environments that can give no pseudo-terminal.
 *
 * One module because the lane answer has two readers that must agree: the
 * route that attaches the socket (terminal-route.ts) and the pane that renders
 * it (components/TerminalPane.tsx). A pane that offered a PTY the route
 * refuses would be a terminal that fails on connect, and a pane that fell back
 * to line mode where a PTY exists would be the fake shell this replaces.
 *
 * The line driver lives beside the table rather than inside the pane because
 * every rule in it is decided over strings, and this is the module a test can
 * load: the pane's own graph pulls xterm, its stylesheet and React.
 *
 * Client-safe by construction: no imports, so the browser bundle can hold it.
 */

/**
 * A lane is a mode and nothing else. The pane labels the mode it is in and
 * says nothing about primitives an environment lacks: what a person can do
 * here is run one command at a time, and that is the whole label. The
 * capability evidence for each environment is the comment on
 * {@link terminalLane}, which is engineering provenance rather than product
 * copy.
 */
export type TerminalLane =
  | { mode: 'pty' }
  | { mode: 'line' };

/** The line-mode label, beside the pane so a test can read it without xterm. */
export const LINE_MODE_LABEL = 'line mode · one command at a time';

/** What the line driver writes to. xterm's `Terminal` satisfies it. Declaring
 *  the one method keeps this module import-free and lets a test hold the bytes
 *  the pane would have painted. */
export interface TerminalWriter {
  write(data: string): void;
}

/** One finished command, as the pane receives it — from the live broadcast, or
 *  from the stored rows a reload reads back. */
export interface TerminalPaneOutput {
  id: string;
  command: string;
  stdout: string;
  stderr: string;
  /** Stored lengths of the two streams. The server clips what it sends, and a
   *  pane that showed the prefix alone would present part of an output as the
   *  whole of it — so the clip is drawn, never implied. */
  stdout_len: number;
  stderr_len: number;
  exit_code: number;
  created_at: number;
}

/* ── what the pane paints ─────────────────────────────────────────────── */

/** The prompt, and the prompt for a command the shell has not finished
 *  reading. `sh` writes `$ ` and `> `, and the two mean the same here. */
const PROMPT = '\x1b[32m$\x1b[0m ';
const CONTINUATION = '\x1b[32m>\x1b[0m ';

/** The in-flight marker, on its own line so it can be erased whole. */
export const BUSY = '\x1b[2m⋯ running\x1b[0m';

export function writePrompt(term: TerminalWriter) {
  term.write(PROMPT);
}

export function clearBusy(term: TerminalWriter, state: LineTerminalState) {
  if (!state.clearBusy()) return;
  term.write('\r\x1b[2K'); // carriage return + erase line
}

/* ── the line editor ──────────────────────────────────────────────────── */

/**
 * Mutable state owned by one line terminal. Changing executor starts a new
 * generation so work started for the previous terminal cannot complete into
 * this one.
 *
 * The buffer holds one COMMAND, which the shell may read over several lines —
 * a backslash continuation, an open quote, a heredoc body. `needsMoreInput`
 * decides when it is finished.
 */
export class LineTerminalState {
  #generation = 0;
  #writtenOutputIds = new Set<string>();
  #buffer = '';
  #running = false;
  #busy = false;

  reset(): number {
    this.#generation += 1;
    this.#writtenOutputIds.clear();
    this.#buffer = '';
    this.#running = false;
    this.#busy = false;
    return this.#generation;
  }

  get running(): boolean {
    return this.#running;
  }

  /** The command as typed so far, newlines included. */
  get buffer(): string {
    return this.#buffer;
  }

  recordOutput(id: string): boolean {
    if (this.#writtenOutputIds.has(id)) return false;
    this.#writtenOutputIds.add(id);
    return true;
  }

  /** Take the finished command and empty the buffer. The newline that
   *  submitted it is not part of it. */
  takeCommand(): string {
    const command = this.#buffer.replace(/\n$/, '');
    this.#buffer = '';
    return command;
  }

  append(data: string) {
    this.#buffer += data;
  }

  /** End one input line. The shell may still be reading. */
  newline() {
    this.#buffer += '\n';
  }

  /** Delete the character before the cursor. This editor cannot move the
   *  cursor off the current row, so backspace stops at the start of a
   *  continuation line instead of joining it to the line above. */
  backspace(): boolean {
    if (this.#buffer === '' || this.#buffer.endsWith('\n')) return false;
    // One code point, not one UTF-16 unit: input arrives by code point, so
    // slicing one unit off an astral character submits a lone surrogate.
    const points = [...this.#buffer];
    points.pop();
    this.#buffer = points.join('');
    return true;
  }

  /** Throw away what was typed. Ctrl-C drops the whole command, every line of
   *  it, exactly as a shell does. */
  discard() {
    this.#buffer = '';
  }

  beginCommand() {
    this.#running = true;
    this.#busy = true;
  }

  finishCommand(generation: number): boolean {
    if (generation !== this.#generation) return false;
    this.#running = false;
    return true;
  }

  clearBusy(): boolean {
    if (!this.#busy) return false;
    this.#busy = false;
    return true;
  }
}

/** A heredoc the shell is waiting to read the body of. */
interface HeredocDelimiter {
  readonly word: string;
  /** `<<-` strips leading tabs from the body and from the closing line. */
  readonly dashed: boolean;
}

interface CommandLineScan {
  /** The quote still open at the end of the line: `'`, `"`, or empty. */
  readonly quote: string;
  /** The line ended with a backslash the shell removes: the command goes on. */
  readonly continued: boolean;
  /** Heredocs this line opened, in the order their bodies arrive. */
  readonly heredocs: readonly HeredocDelimiter[];
}

/** Characters that end a word outside quotes. */
const WORD_BREAK = ' \t;&|<>()';

/** Read the delimiter word of a heredoc operator. Returns where it ends. */
function readDelimiter(line: string, start: number) {
  let word = '';
  let i = start;
  while (i < line.length) {
    const ch = line[i];
    if (ch === "'" || ch === '"') {
      i += 1;
      while (i < line.length && line[i] !== ch) {
        word += line[i];
        i += 1;
      }
      i += 1;
      continue;
    }
    if (ch === '\\') {
      i += 1;
      if (i < line.length) {
        word += line[i];
        i += 1;
      }
      continue;
    }
    if (WORD_BREAK.includes(ch)) break;
    word += ch;
    i += 1;
  }
  return { word, end: i };
}

/** One command line, read with the quote left open by the line before it. */
function scanCommandLine(line: string, openQuote: string): CommandLineScan {
  const heredocs: HeredocDelimiter[] = [];
  let quote = openQuote;
  let escaped = false;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (escaped) {
      escaped = false;
      i += 1;
      continue;
    }
    if (quote === "'") {
      // A single quote quotes everything, the backslash included.
      if (ch === "'") quote = '';
      i += 1;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      i += 1;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = '';
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === '#' && (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t')) {
      // A comment runs to the end of the line, so a `<<EOF` inside one opens
      // no heredoc and must not strand the editor on a continuation prompt.
      break;
    }
    if (ch === '<' && line[i + 1] === '<') {
      const dashed = line[i + 2] === '-';
      let at = i + (dashed ? 3 : 2);
      while (line[at] === ' ' || line[at] === '\t') at += 1;
      // `<<<` is a here-string and takes no body. It needs no branch of its
      // own: its third `<` breaks the word, the delimiter comes back empty,
      // and an empty delimiter queues nothing.
      const delimiter = readDelimiter(line, at);
      if (delimiter.word !== '') heredocs.push({ word: delimiter.word, dashed });
      i = delimiter.end;
      continue;
    }
    i += 1;
  }
  return { quote, continued: escaped, heredocs };
}

/**
 * Whether the shell would still be reading this command.
 *
 * The executor takes a whole command as one string and runs it in one shell
 * (`box.exec`, core/src/execution/nimbus.ts), so a command the shell reads over
 * several lines is one call rather than several. This predicate decides when
 * Enter submits and when it opens a continuation line.
 *
 * It answers for what a lexer can see: an open single or double quote, a
 * trailing backslash, and a heredoc whose delimiter line has not arrived. A
 * command left incomplete by the GRAMMAR — a trailing `|`, `&&`, or an open
 * `do` — submits, and the shell reports the syntax error. Reading those needs
 * the parse, and a wrong guess strands a user at a prompt no key can leave.
 */
function needsMoreInput(source: string): boolean {
  const lines = source.split('\n');
  // A trailing newline ends the last line; it does not start an empty one.
  if (lines[lines.length - 1] === '') lines.pop();
  let quote = '';
  let continued = false;
  let body: HeredocDelimiter | null = null;
  const queued: HeredocDelimiter[] = [];
  for (const line of lines) {
    if (body !== null) {
      const closing = body.dashed ? line.replace(/^\t+/, '') : line;
      if (closing === body.word) body = queued.shift() ?? null;
      continue;
    }
    const scan = scanCommandLine(line, quote);
    quote = scan.quote;
    continued = scan.continued;
    queued.push(...scan.heredocs);
    // The bodies start after the whole logical line, so a continued line keeps
    // collecting operators before the first body arrives.
    if (!continued) body = queued.shift() ?? null;
  }
  return quote !== '' || continued || body !== null || queued.length > 0;
}

/** Skip one escape sequence. Returns the index of its last character. */
function skipEscape(chars: readonly string[], start: number): number {
  const next = chars[start + 1];
  if (next === undefined) return start; // a bare Escape key
  if (next !== '[' && next !== 'O') return start + 1; // Escape plus one key
  let i = start + 2;
  while (i < chars.length) {
    const code = chars[i].charCodeAt(0);
    if (code >= 0x40 && code <= 0x7e) return i; // the final byte
    i += 1;
  }
  return chars.length - 1;
}

/**
 * Feed one xterm data chunk to the line editor. Returns the command to run, or
 * null while the editor is still collecting.
 *
 * A chunk is the unit, not a keystroke, because a PASTE arrives as one chunk
 * with every newline already turned into CR (xterm's `prepareTextForTerminal`,
 * browser/Clipboard.ts). The loop this replaces submitted the first line and
 * returned, so every later line of a pasted script vanished with no echo and
 * no error. Here a CR that is not the end of the chunk opens the next line of
 * the SAME command, which is what the pasted text means: one shell, one
 * working directory, one call — the script the user copied.
 */
export function feedInput(
  term: TerminalWriter,
  state: LineTerminalState,
  data: string,
): string | null {
  // By code point, so an astral character stays one unit.
  const chars = [...data];
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    const code = ch.charCodeAt(0);
    if (code === 0x1b) {
      // An escape sequence is a key this editor does not implement: an arrow,
      // Home, a function key. Skipping it whole keeps its final letter out of
      // the command — `\x1b[A` used to type `[A` at the cursor.
      i = skipEscape(chars, i);
      continue;
    }
    if (code === 0x0d || code === 0x0a) {
      if (code === 0x0d && chars[i + 1] === '\n') i += 1;
      state.newline();
      term.write('\r\n');
      if (i < chars.length - 1 || needsMoreInput(state.buffer)) {
        term.write(CONTINUATION);
        continue;
      }
      const command = state.takeCommand();
      if (command.trim() === '') {
        writePrompt(term);
        continue;
      }
      return command;
    }
    if (code === 0x7f || code === 0x08) {
      if (state.backspace()) term.write('\b \b');
      continue;
    }
    if (code === 0x03) {
      state.discard();
      term.write('^C\r\n');
      writePrompt(term);
      continue;
    }
    // Tab is text here, not completion: a pasted `<<-` body and any indented
    // script carry them, and dropping them changed what the user pasted.
    if (code === 0x09 || code >= 0x20) {
      state.append(ch);
      term.write(ch);
    }
  }
  return null;
}

/* ── what a finished command paints ───────────────────────────────────── */

/** Say what the row is not showing. Silence here would turn a clipped prefix
 *  into a claim about the whole output. */
function writeClipNote(term: TerminalWriter, stream: string, shown: number, stored: number) {
  const withheld = stored - shown;
  if (withheld <= 0) return;
  term.write(`\x1b[2m… ${withheld.toLocaleString()} more ${stream} characters are stored and not shown here\x1b[0m\r\n`);
}

/**
 * Program bytes to terminal bytes, and one stream painted.
 *
 * A program ends a line with LF. A terminal starts the next line at column 0,
 * which takes CR LF, and xterm writes exactly the bytes it is given. An LF
 * alone drops one row and keeps the column, so every row of an `ls -la` began
 * where the row above it ended and the output walked off the right edge. A
 * real tty converts in its line discipline (ONLCR). Line mode has no tty, so
 * the pane converts here, at the one seam where program bytes arrive.
 *
 * xterm's `convertEol` option would convert too, and it is not used: the
 * option belongs to the Terminal, and both drivers build theirs from
 * `newTerminal`. The PTY driver carries container bytes that already end lines
 * in CR LF and that position the cursor before writing an LF, so adding a CR
 * there would move output the container placed.
 *
 * A lone CR survives. A progress bar means it.
 */
function writeStream(term: TerminalWriter, text: string, danger: boolean) {
  const painted = text.replace(/\r?\n/g, '\r\n');
  term.write(danger ? `\x1b[31m${painted}\x1b[0m` : painted);
  // The next thing painted is the prompt, and it belongs on its own row.
  if (!text.endsWith('\n')) term.write('\r\n');
}

/**
 * Paint one finished command.
 *
 * A FAILING row carries one text in both columns. The executor renders the
 * exit code, stdout and stderr into a single string (`formatExecResult`,
 * core/src/execution/exec-result.ts) and the orchestrator stores that string as
 * stdout and as stderr (`executeInExecutor`), so painting both drew every
 * failure twice — once plain, once in red. The repeat is dropped and the
 * failure keeps its colour.
 */
export function writeOutputRow(term: TerminalWriter, out: TerminalPaneOutput) {
  const failed = out.exit_code !== 0;
  const repeated = failed && out.stderr !== '' && out.stderr === out.stdout;
  if (!repeated) {
    if (out.stdout !== '') writeStream(term, out.stdout, false);
    writeClipNote(term, 'stdout', out.stdout.length, out.stdout_len);
  }
  if (failed) {
    if (out.stderr !== '') writeStream(term, out.stderr, true);
    writeClipNote(term, 'stderr', out.stderr.length, out.stderr_len);
  }
}

/**
 * Per-environment terminal capability, established from each environment's own
 * source rather than from what would be convenient.
 *
 * `sandbox` — @cloudflare/sandbox 0.12.8 runs a real pseudo-terminal:
 *   `sandbox-container/src/pty.ts` spawns the shell against a `Bun.Terminal`
 *   (`name: 'xterm-256color'`, `TERM=xterm-256color` in the child's env),
 *   `resize(cols, rows)` reaches that terminal, and a 256 KiB ring buffer
 *   replays to a reattaching client.
 *
 * `workspace` — Nimbus. Its session handle (core/src/execution/nimbus.ts,
 *   `NimbusSandboxHandle`) offers `exec` with a one-shot `stdin?: string`,
 *   `startProcess` with `processes.logs(pid)` polling, and nothing more: no
 *   bidirectional byte stream, no resize, no raw-mode input. Nimbus is a
 *   JS/WASM substrate and its own tty shim states there is no real TTY
 *   (`@nimbus-sh/core` substrate/lifo/node-compat/tty.d.ts), so its processes
 *   have no controlling terminal to attach to.
 *
 * `laptop` — the owner's own machine, through its agent
 *   (`packages/pc-agent/src/pty.js`). The agent allocates a real terminal per
 *   session, claims it as the shell's controlling terminal, and streams bytes
 *   both ways over the one socket it already dials out on. Measured there
 *   2026-09-03: `top` paints, a resize delivers SIGWINCH to the running
 *   program, and ^C, ^Z, `bg` and `fg` all reach it. A session carries the
 *   workspace's grant for that machine and the same sandbox confinement an
 *   `exec` carries, decided by one call (`UserDO.deviceRpc`).
 *
 * `parent` — a fork reaching its origin's exec plane, one call per command,
 *   with no session of its own to attach to.
 */
export function terminalLane(executor: string): TerminalLane {
  return executor === 'sandbox' || executor === 'laptop' ? { mode: 'pty' } : { mode: 'line' };
}
