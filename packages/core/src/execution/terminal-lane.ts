/**
 * Terminal lane per environment, plus the line-mode driver for environments with no PTY.
 * Shared by terminal-route.ts and TerminalPane.tsx, which must agree. Import-free so the browser bundle can hold it.
 */

export type TerminalLane =
  | { mode: 'pty' }
  | { mode: 'shell' }
  | { mode: 'line' };

export const LINE_MODE_LABEL = 'line mode · one command at a time';

/** xterm's `Terminal` satisfies it; one method keeps this module import-free. */
export interface TerminalWriter {
  write(data: string): void;
}

export interface TerminalPaneOutput {
  id: string;
  command: string;
  stdout: string;
  stderr: string;
  /** Stored stream lengths; the server clips what it sends, so the clip is drawn, never implied. */
  stdout_len: number;
  stderr_len: number;
  exit_code: number;
  created_at: number;
}


const PROMPT = '\x1b[32m$\x1b[0m ';

const CONTINUATION = '\x1b[32m>\x1b[0m ';

export const BUSY = '\x1b[2m⋯ running\x1b[0m';

export function writePrompt(term: TerminalWriter) {
  term.write(PROMPT);
}

export function clearBusy(term: TerminalWriter, state: LineTerminalState) {
  if (!state.clearBusy()) return;
  term.write('\r\x1b[2K'); // carriage return + erase line
}


/**
 * Changing executor starts a new generation so stale work cannot complete into this terminal.
 * The buffer holds one command, possibly spanning lines; `needsMoreInput` decides when it is finished.
 */
export class LineTerminalState {
  #generation = 0;
  readonly #writtenOutputIds = new Set<string>();
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

  get buffer(): string {
    return this.#buffer;
  }

  recordOutput(id: string): boolean {
    if (this.#writtenOutputIds.has(id)) return false;
    this.#writtenOutputIds.add(id);

    return true;
  }

  takeCommand(): string {
    const command = this.#buffer.replace(/\n$/, '');
    this.#buffer = '';

    return command;
  }

  append(data: string) {
    this.#buffer += data;
  }

  newline() {
    this.#buffer += '\n';
  }

  /** Stops at the start of a continuation line rather than joining it to the line above. */
  backspace(): boolean {
    if (this.#buffer === '' || this.#buffer.endsWith('\n')) return false;
    // One code point, not one UTF-16 unit, so no lone surrogate is submitted.
    const points = Array.from(this.#buffer);
    points.pop();
    this.#buffer = points.join('');

    return true;
  }

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

interface HeredocDelimiter {
  readonly word: string;
  readonly dashed: boolean;
}

interface CommandLineScan {
  readonly quote: string;
  readonly continued: boolean;
  readonly heredocs: readonly HeredocDelimiter[];
}

const WORD_BREAK = ' \t;&|<>()';

/** Returns where the delimiter word ends. */
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
      // A `<<EOF` inside a comment opens no heredoc.
      break;
    }

    if (ch === '<' && line[i + 1] === '<') {
      const dashed = line[i + 2] === '-';
      let at = i + (dashed ? 3 : 2);

      while (line[at] === ' ' || line[at] === '\t') at += 1;
      // `<<<` needs no branch: its third `<` breaks the word and the empty delimiter queues nothing.
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
 * Whether the shell would still be reading this command: open quote, trailing backslash, or pending heredoc.
 * Grammar-incomplete commands (trailing `|`, `&&`, open `do`) submit and the shell reports the error.
 */
function needsMoreInput(source: string): boolean {
  const lines = source.split('\n');

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

    if (!continued) body = queued.shift() ?? null;
  }

  return quote !== '' || continued || body !== null || queued.length > 0;
}

/** Returns the index of the escape sequence's last character. */
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
 * Returns the command to run, or null while collecting. A paste arrives as one chunk with newlines as CR,
 * so a CR not at the chunk's end continues the same command.
 */
export function feedInput(
  term: TerminalWriter,
  state: LineTerminalState,
  data: string,
): string | null {
  const chars = Array.from(data);

  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    const code = ch.charCodeAt(0);

    if (code === 0x1b) {
      // Unimplemented keys are skipped whole, so `\x1b[A` does not type `[A`.
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

    // Tab is text, not completion: pasted `<<-` bodies and indented scripts carry them.
    if (code === 0x09 || code >= 0x20) {
      state.append(ch);
      term.write(ch);
    }
  }

  return null;
}


function writeClipNote(term: TerminalWriter, stream: string, shown: number, stored: number) {
  const withheld = stored - shown;

  if (withheld <= 0) return;
  term.write(`\x1b[2m… ${withheld.toLocaleString()} more ${stream} characters are stored and not shown here\x1b[0m\r\n`);
}

/**
 * Converts LF to CR LF (line mode has no tty ONLCR); a lone CR survives for progress bars.
 * Not xterm `convertEol`: the PTY driver shares `newTerminal` and its bytes already end in CR LF.
 */
function writeStream(term: TerminalWriter, text: string, danger: boolean) {
  const painted = text.replace(/\r?\n/g, '\r\n');
  term.write(danger ? `\x1b[31m${painted}\x1b[0m` : painted);

  if (!text.endsWith('\n')) term.write('\r\n');
}

/**
 * A failing row carries one text as both stdout and stderr (`formatExecResult`, `executeInExecutor`),
 * so the repeat is dropped.
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
 * Per-environment terminal capability:
 * `sandbox` — @cloudflare/sandbox runs a real PTY (`sandbox-container/src/pty.ts`).
 * `workspace` — Nimbus `WebSocketTerminal`, a line editor with no raw mode (no real TTY in the substrate).
 * `device` — a real PTY per session via `packages/pc-agent/src/pty.js`, gated by `UserDO.deviceRpc`.
 * `parent` — a fork's origin exec plane, one call per command, no session.
 */
export function terminalLane(executor: string): TerminalLane {
  if (executor === 'sandbox' || executor === 'device') return { mode: 'pty' };

  return executor === 'workspace' ? { mode: 'shell' } : { mode: 'line' };
}
