/**
 * The line terminal, at the two seams a user reaches: what the keyboard puts
 * into a command, and what a finished command puts on the screen.
 *
 * Every case here was measured first in a browser against a live workspace
 * executor (Chrome 152, `vite dev`, executor `workspace`, 2026-09-01) and each
 * assertion states the reading it was measured against:
 *
 *   · `printf 'a\nb\nc\n'` drew `a`, ` b`, `  c`, `   $` — one column further
 *     right per line, because xterm was handed bare LF and an LF moves down
 *     without returning to column 0. `ls -la` walked off the right edge.
 *   · a pasted `echo first-line\necho second-line\n` ran the first line and
 *     dropped the second with no echo and no error.
 *   · `echo one \` submitted at once, and `cat <<EOF` answered
 *     `Expected HeredocBody but got EOF ('')` before its body was typed.
 *   · `ls /definitely-not-here` printed its failure twice, once plain and once
 *     in red, because the row carries the same rendered text in both columns.
 *   · an arrow key typed `[A` into the command line.
 *
 * The driver is imported directly: it decides over strings, and the pane's own
 * module graph pulls xterm, a stylesheet and React.
 */

import { describe, expect, test } from 'bun:test';

import {
  LineTerminalState, feedInput, needsMoreInput, terminalLane, writeOutputRow,
  type TerminalPaneOutput, type TerminalWriter,
} from '../src/lib/terminal-lane';

/** A terminal that keeps its bytes. The pane hands xterm's `Terminal` here;
 *  the one method is all either of them uses. */
class Recorder implements TerminalWriter {
  #written = '';

  write(data: string) {
    this.#written += data;
  }

  /** Everything written, control bytes included. */
  get raw(): string {
    return this.#written;
  }

  /** The rows a reader sees. Splitting on CR LF is the point of the test: a
   *  bare LF leaves its row joined to the one before it here exactly as it
   *  leaves the cursor mid-row in xterm. `Bun.stripANSI` takes the colour off
   *  structurally — no regex, no control characters — as the CLI suites do. */
  get rows(): readonly string[] {
    return Bun.stripANSI(this.#written).split('\r\n');
  }
}

function row(stdout: string, over: Partial<TerminalPaneOutput> = {}): TerminalPaneOutput {
  return {
    id: 'row-1',
    command: 'cmd',
    stdout,
    stderr: '',
    stdout_len: stdout.length,
    stderr_len: 0,
    exit_code: 0,
    created_at: 0,
    ...over,
  };
}

/** A state at a fresh generation, as the pane's mount effect leaves it. */
function editor(): LineTerminalState {
  const state = new LineTerminalState();
  state.reset();
  return state;
}

describe('program output reaches the terminal as terminal lines', () => {
  test('a bare LF between two lines arrives as CR LF', () => {
    const term = new Recorder();
    writeOutputRow(term, row('a\nb'));
    // Red against the pre-fix `term.write(out.stdout)`: that wrote `a\nb\r\n`,
    // so `b` began in the column `a` ended in.
    expect(term.raw).toBe('a\r\nb\r\n');
  });

  test('a three-line output draws three rows, each at column zero', () => {
    const term = new Recorder();
    writeOutputRow(term, row('a\nb\nc\n'));
    expect(term.rows).toEqual(['a', 'b', 'c', '']);
  });

  test('CR LF already in the output is not doubled', () => {
    const term = new Recorder();
    writeOutputRow(term, row('a\r\nb\r\n'));
    expect(term.raw).toBe('a\r\nb\r\n');
  });

  test('a lone CR survives, because a progress bar means it', () => {
    const term = new Recorder();
    writeOutputRow(term, row('12%\r45%\r100%\n'));
    expect(term.raw).toBe('12%\r45%\r100%\r\n');
  });

  test('output that ends without a newline still leaves the prompt its own row', () => {
    const term = new Recorder();
    writeOutputRow(term, row('no-trailing-newline'));
    expect(term.raw).toBe('no-trailing-newline\r\n');
  });

  test('a failing row that repeats its text in both columns is drawn once, in red', () => {
    const rendered = "Error (exit 1)\n--- stderr ---\nls: cannot access '/nope'\n";
    const term = new Recorder();
    writeOutputRow(term, row(rendered, { stderr: rendered, stderr_len: rendered.length, exit_code: 1 }));
    // One copy of the text, and it keeps the failure colour. Red against the
    // pre-fix pane, which wrote stdout and then the identical stderr again.
    expect(term.raw.split('Error (exit 1)').length - 1).toBe(1);
    expect(term.raw.startsWith('\x1b[31m')).toBe(true);
    expect(term.rows).toEqual(['Error (exit 1)', '--- stderr ---', "ls: cannot access '/nope'", '']);
  });

  test('a failing row whose stderr differs from its stdout keeps both', () => {
    const term = new Recorder();
    writeOutputRow(term, row('partial output\n', {
      stderr: 'boom\n', stderr_len: 5, exit_code: 1,
    }));
    expect(term.rows).toEqual(['partial output', 'boom', '']);
  });

  test('the clip note is drawn once for a row that repeats its text', () => {
    const term = new Recorder();
    const shown = 'Error (exit 1)\n';
    writeOutputRow(term, row(shown, {
      stderr: shown, stdout_len: 4_000, stderr_len: 4_000, exit_code: 1,
    }));
    expect(term.raw.split('more').length - 1).toBe(1);
    expect(term.raw).toContain('3,985 more stderr characters');
  });
});

describe('what the keyboard puts into a command', () => {
  test('Enter on a finished command hands it over and clears the buffer', () => {
    const state = editor();
    const term = new Recorder();
    expect(feedInput(term, state, 'ls -la')).toBeNull();
    expect(feedInput(term, state, '\r')).toBe('ls -la');
    expect(state.buffer).toBe('');
  });

  test('Enter on an empty line reprompts and runs nothing', () => {
    const state = editor();
    const term = new Recorder();
    expect(feedInput(term, state, '\r')).toBeNull();
    expect(term.raw).toBe('\r\n\x1b[32m$\x1b[0m ');
  });

  test('a pasted script runs whole, not just its first line', () => {
    const state = editor();
    const term = new Recorder();
    // xterm delivers a paste as one chunk with every newline turned into CR
    // (browser/Clipboard.ts `prepareTextForTerminal`). Red against the loop
    // this replaces, which returned after the first CR: it answered
    // `echo first-line` and dropped the rest with no echo and no error.
    const command = feedInput(term, state, 'echo first-line\recho second-line\r');
    expect(command).toBe('echo first-line\necho second-line');
  });

  test('a pasted script with no trailing newline waits at a continuation prompt', () => {
    const state = editor();
    const term = new Recorder();
    expect(feedInput(term, state, 'cd /tmp\rls')).toBeNull();
    expect(state.buffer).toBe('cd /tmp\nls');
    expect(term.raw).toContain('\x1b[32m>\x1b[0m ');
    expect(feedInput(term, state, '\r')).toBe('cd /tmp\nls');
  });

  test('a pasted tab is text, so an indented body survives the paste', () => {
    const state = editor();
    const term = new Recorder();
    expect(feedInput(term, state, 'cat <<-EOF\r\tindented\rEOF\r')).toBe('cat <<-EOF\n\tindented\nEOF');
  });

  test('a backslash at the end of the line opens a continuation line', () => {
    const state = editor();
    const term = new Recorder();
    // Red against the pre-fix editor, which submitted `echo one \` at once and
    // then ran `two` as its own command: `two: command not found`.
    expect(feedInput(term, state, 'echo one \\\r')).toBeNull();
    expect(term.raw.endsWith('\x1b[32m>\x1b[0m ')).toBe(true);
    expect(feedInput(term, state, 'two\r')).toBe('echo one \\\ntwo');
  });

  test('a heredoc collects its body and closes on its delimiter', () => {
    const state = editor();
    const term = new Recorder();
    expect(feedInput(term, state, 'cat <<EOF\r')).toBeNull();
    expect(feedInput(term, state, 'hello heredoc\r')).toBeNull();
    expect(feedInput(term, state, 'EOF\r')).toBe('cat <<EOF\nhello heredoc\nEOF');
  });

  test('an arrow key moves nothing and types nothing', () => {
    const state = editor();
    const term = new Recorder();
    feedInput(term, state, 'abc');
    feedInput(term, state, '\x1b[A');
    feedInput(term, state, '\x1bOB');
    // Red against the pre-fix loop, which dropped the ESC and appended the
    // rest: the line read `abc[A[B`.
    expect(state.buffer).toBe('abc');
  });

  test('Ctrl-C drops every line of a part-typed command', () => {
    const state = editor();
    const term = new Recorder();
    feedInput(term, state, 'cat <<EOF\rbody\r');
    expect(state.buffer).not.toBe('');
    feedInput(term, state, '\x03');
    expect(state.buffer).toBe('');
    expect(term.raw.endsWith('^C\r\n\x1b[32m$\x1b[0m ')).toBe(true);
  });

  test('backspace stops at the start of a continuation line', () => {
    const state = editor();
    const term = new Recorder();
    feedInput(term, state, 'echo a \\\r');
    const written = term.raw;
    feedInput(term, state, '\x7f');
    // Nothing erased and nothing echoed: this editor cannot repaint the row
    // above, and joining the lines silently would lose a character.
    expect(state.buffer).toBe('echo a \\\n');
    expect(term.raw).toBe(written);
  });

  test('backspace inside a line erases one character', () => {
    const state = editor();
    const term = new Recorder();
    feedInput(term, state, 'lss');
    feedInput(term, state, '\x7f');
    expect(state.buffer).toBe('ls');
  });

  test('an astral character stays one character', () => {
    const state = editor();
    const term = new Recorder();
    expect(feedInput(term, state, "echo '🌱'\r")).toBe("echo '🌱'");
  });
});

describe('when the shell is still reading', () => {
  test.each([
    ['echo one \\\n', 'a trailing backslash'],
    ["echo 'open\n", 'an open single quote'],
    ['echo "open\n', 'an open double quote'],
    ['cat <<EOF\n', 'a heredoc with no body yet'],
    ['cat <<EOF\nbody\n', 'a heredoc with no delimiter line yet'],
    ["cat <<'EOF'\nbody\n", 'a quoted heredoc delimiter'],
    ['cat <<-EOF\n\tbody\n', 'a tab-stripping heredoc'],
    ['cat <<A <<B\nfirst\nA\n', 'the second of two heredocs'],
  ])('%p keeps reading (%s)', (source) => {
    expect(needsMoreInput(source)).toBe(true);
  });

  test.each([
    ['', 'nothing typed'],
    ['ls -la\n', 'a plain command'],
    ["echo 'closed'\n", 'a closed single quote'],
    ['echo "a \\" b"\n', 'an escaped quote inside a double quote'],
    ["echo 'a \\'\n", 'a backslash inside a single quote, which quotes it'],
    ['cat <<EOF\nbody\nEOF\n', 'a closed heredoc'],
    ['cat <<-EOF\n\tbody\n\tEOF\n', 'a tab-stripping heredoc closed on an indented line'],
    ['cat <<A <<B\nfirst\nA\nsecond\nB\n', 'both heredocs closed'],
    ['echo hi # <<EOF\n', 'a heredoc operator inside a comment'],
    ['cat <<<"here string"\n', 'a here-string, which takes no body'],
    ['echo "a#b" # done\n', 'a hash inside quotes and a real comment after it'],
  ])('%p is finished (%s)', (source) => {
    expect(needsMoreInput(source)).toBe(false);
  });

  test('a heredoc body is not read for quotes of its own', () => {
    // The body is data. A lone apostrophe in it opened a quote that never
    // closed, which would strand the editor on a continuation prompt.
    expect(needsMoreInput("cat <<EOF\nit's fine\nEOF\n")).toBe(false);
  });

  test('a delimiter line with trailing text does not close the heredoc', () => {
    expect(needsMoreInput('cat <<EOF\nEOF trailing\n')).toBe(true);
  });
});

describe('the line driver runs only where there is no pseudo-terminal', () => {
  test('the sandbox lane still asks for the PTY driver', () => {
    // The newline conversion above belongs to the line seam alone. A container
    // PTY sends its own CR LF and positions the cursor before an LF, so the
    // shared `newTerminal` must stay free of `convertEol` for this lane.
    expect(terminalLane('sandbox')).toEqual({ mode: 'pty' });
  });
});
