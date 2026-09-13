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
import { readFileSync, writeFileSync } from 'node:fs';
import { scratchPath } from '@kinu.run/test-utils';

import { runTuiInPty } from './helpers/pty-screen';

const entry = resolve(import.meta.dir, 'fixtures/pty-chat.tsx');

function enterSubmits(label: string, enterBytes: string) {
  test(`${label} sends the draft and the agent reply lands on screen`, () => {
    const run = runTuiInPty(entry, {
      steps: [
        { wait: 'Connected to pty', timeout: 15 },
        { send: 'draft one' },
        { wait: 'draft one', timeout: 1 },
        { send: enterBytes },
        { wait: 'agent prose reply', timeout: 3 },
      ],
    });

    expect(run.screen).toContain('agent prose reply');
  }, 60_000);
}

describe('the composer on a real terminal', () => {
  test('an image path paste uses the existing attachment resolver', () => {
    const sent = scratchPath('composer-image-path', 'sent.json');
    const path = scratchPath('composer-image-path', 'shot.png');
    const bytes = Buffer.from('iVBORw0KGgo=', 'base64');
    writeFileSync(path, bytes);

    const run = runTuiInPty(entry, {
      env: { KINU_PTY_SENT_FILE: sent },
      steps: [
        { wait: 'Connected to pty', timeout: 15 },
        { send: `\x1b[200~${path}\x1b[201~` },
        { wait: '[Image #1]', timeout: 3 },
        { send: '\r' },
        { wait: 'agent prose reply', timeout: 3 },
      ],
    });

    expect(run.screen).toContain('shot.png');
    expect(JSON.parse(readFileSync(sent, 'utf8'))).toEqual({
      text: path, files: [{ filename: 'shot.png', mediaType: 'image/png', url: 'data:image/png;base64,iVBORw0KGgo=' }],
    });
  }, 60_000);

  test('OSC 5522 receives image chunks and attaches them on send', () => {
    const sent = scratchPath('composer-image-osc', 'sent.json');
    const mime = Buffer.from('image/png').toString('base64');
    const packet = (header: string, payload = '') => `\x1b]5522;type=read:${header};${payload}\x07`;

    const run = runTuiInPty(entry, {
      env: { KINU_PTY_SENT_FILE: sent },
      steps: [
        { wait: 'Connected to pty', timeout: 15 },
        { send: packet('status=OK') + packet(`status=DATA:mime=${mime}`) + packet('status=DONE') },
        { send: packet('status=OK') + packet(`status=DATA:mime=${mime}`, 'iVBORw0KGgo=') + packet('status=DONE') },
        { wait: '[Image #1]', timeout: 3 },
        { send: '\r' },
        { wait: 'agent prose reply', timeout: 3 },
      ],
    });

    expect(run.screen).toContain('agent prose reply');
    expect(JSON.parse(readFileSync(sent, 'utf8'))).toEqual({
      text: expect.stringContaining('/clipboard/'),
      files: [{ filename: expect.stringMatching(/\.png$/), mediaType: 'image/png', url: 'data:image/png;base64,iVBORw0KGgo=' }],
    });
  }, 60_000);

  test('a twelve-line bracketed paste collapses and expands exactly on send', () => {
    const sent = scratchPath('composer-paste', 'sent.json');
    const text = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n');

    const run = runTuiInPty(entry, {
      env: { KINU_PTY_SENT_FILE: sent },
      steps: [
        { wait: 'Connected to pty', timeout: 15 },
        { send: `\x1b[200~${text}\x1b[201~` },
        { wait: '[paste #1]', timeout: 3 },
        { send: '\r' },
        { wait: 'agent prose reply', timeout: 3 },
      ],
    });

    expect(run.screen).toContain('agent prose reply');
    expect(JSON.parse(readFileSync(sent, 'utf8'))).toBe(text);
  }, 60_000);

  test('embedded newlines in a short bracketed paste never submit', () => {
    const run = runTuiInPty(entry, {
      steps: [
        { wait: 'Connected to pty', timeout: 15 },
        { send: '\x1b[200~first pasted line\nsecond pasted line\n\x1b[201~' },
        { wait: 'second pasted line', timeout: 3 },
      ],
    });

    expect(run.screen).toContain('first pasted line');
    expect(run.screen).not.toContain('agent prose reply');
  }, 60_000);

  enterSubmits('Enter as CR', '\r');
  enterSubmits('Enter as LF (the tty translated it)', '\n');

  test('Shift+Enter opens a line instead of sending', () => {
    const run = runTuiInPty(entry, {
      steps: [
        { wait: 'Connected to pty', timeout: 15 },
        { send: 'draft one' },
        { wait: 'draft one', timeout: 1 },
        { send: '\u001B[13;2u' },
        { send: 'line two' },
        { wait: 'line two', timeout: 3 },
      ],
    });

    expect(run.screen).toContain('line two');
    expect(run.screen).not.toContain('agent prose reply');
  }, 60_000);
});
