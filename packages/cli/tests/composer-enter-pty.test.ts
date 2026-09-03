/**
 * Enter, on a real terminal, in the composer.
 *
 * The in-process suites drive `createTestRenderer`, which never negotiates
 * with a terminal: they deliver CR and assert the submit binding. A real tty
 * can also deliver Enter as LF, because the kernel translates CR to NL when
 * the line discipline has ICRNL set (or the terminal answered LNM). Before
 * the fix, only the 'return' name submitted; opentui's own default table
 * mapped the 'linefeed' name to the newline action, so Enter-as-LF opened a
 * line and nothing was sent. That was measured in the real product under a
 * real tmux: `send-keys -H 0a` left the composer empty and no turn ran.
 *
 * These tests run the same product path `runTuiChat` runs — `createCliRenderer`
 * and `ChatApp` — on a real pty, and press both spellings.
 */
import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

import { runTuiInPty } from './helpers/pty-screen';

const entry = resolve(import.meta.dir, 'fixtures/pty-chat.tsx');

function enterSubmits(label: string, enterBytes: string) {
  test(`${label} sends the draft and the agent reply lands on screen`, () => {
    const run = runTuiInPty(entry, {
      steps: [
        { wait: 'Connected to pty', timeout: 15 },
        { send: 'draft one' },
        { sleep: 1 },
        { send: enterBytes },
        { sleep: 3 },
      ],
    });
    const screen = run.frames.at(-1) ?? '';
    expect(screen).toContain('agent prose reply');
  }, 60_000);
}

describe('the composer on a real terminal', () => {
  enterSubmits('Enter as CR', '\r');
  enterSubmits('Enter as LF (the tty translated it)', '\n');

  test('Shift+Enter opens a line instead of sending', () => {
    const run = runTuiInPty(entry, {
      steps: [
        { wait: 'Connected to pty', timeout: 15 },
        { send: 'draft one' },
        { sleep: 1 },
        { send: '\u001B[13;2u' },
        { sleep: 1 },
        { send: 'line two' },
        { sleep: 2 },
      ],
    });
    const screen = run.frames.at(-1) ?? '';
    expect(screen).toContain('line two');
    expect(screen).not.toContain('agent prose reply');
  }, 60_000);
});
