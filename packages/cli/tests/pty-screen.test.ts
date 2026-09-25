/** The pty driver: every pty `wait` reads its screen model, so the model's blind spots are the gate's. */
import { describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';

import { tolerate } from '@kinu.run/core/obs';
import { scratchPath } from '@kinu.run/test-utils';
import { runTuiInPty, screenOf } from './helpers/pty-screen';

const ESC = '\u001B';

const CSI = `${ESC}[`;

const at = (row: number, col: number) => `${CSI}${String(row)};${String(col)}H`;

const SIZE = { rows: 30, cols: 100 };

describe('the pty screen model', () => {
  test('a word painted by rewriting only its changed cells is on the screen', async () => {
    // Captured from the shipped surface: the placeholders share their third cell, so the second paint skips it.
    const bytes = `${at(29, 31)}Connecting…${at(29, 31)}Se${CSI}0m${at(29, 34)}`
      + `${CSI}38;2;156;145;132m${CSI}48;2;36;30;22md a message…`;

    expect(bytes).not.toContain('Send a message…');
    const screen = await screenOf(bytes, SIZE);
    expect(screen.split('\n')[28]).toContain('Send a message…');
    expect(screen).not.toContain('Connecting');
  });

  test('an overlay repainted as blanks has left the screen', async () => {
    const card = `${at(12, 30)}D don't ask again · N not now`;
    const cleared = `${at(12, 30)}${' '.repeat(29)}`;
    expect(await screenOf(card, SIZE)).toContain('not now');
    expect(await screenOf(card + cleared, SIZE)).not.toContain('not now');
    expect((await screenOf(`${card}${CSI}2J`, SIZE)).trim()).toBe('');
  });

  test('colour, mode, query and cursor-shape sequences leave no text behind', async () => {
    // `CSI 1 SP q` and `CSI ? 1016 $ p` carry an intermediate byte; the tmux passthrough is a DCS with an ESC inside.
    const bytes = `${CSI}?2031h${ESC}]11;?\u0007${CSI}>0q${CSI}?1016$p${CSI}?u${CSI}1 q`
      + `${ESC}Ptmux;${ESC}${ESC}]11;?\u0007${ESC}\\`
      + `${at(1, 1)}${CSI}38;2;255;255;255m${CSI}48;2;20;17;16mink${CSI}0m`;

    expect(await screenOf(bytes, SIZE)).toBe(`ink${'\n'.repeat(29)}`);
  });

  test('wide and combining cells keep a row in step with the terminal', async () => {
    const bytes = `${at(1, 1)}漢${at(1, 3)}x${at(2, 1)}e\u0301${at(2, 2)}y`;
    const [first, second] = (await screenOf(bytes, SIZE)).split('\n');
    expect(first).toBe('漢x');
    expect(second).toBe('e\u0301y');
  });

  test('plain output before the renderer starts scrolls and wraps like a terminal', async () => {
    const small = { rows: 3, cols: 10 };
    const bytes = 'READY-FR\r\nabcdefghijkl\r\nlast';
    expect(await screenOf(bytes, small)).toBe('abcdefghij\nkl\nlast');
  });

  test('a control that moves cells and is not modelled refuses the run', async () => {
    await expect(screenOf(`${at(1, 1)}ink${CSI}1S`, SIZE)).rejects.toThrow('unmodelled CSI finals: S');
    await expect(screenOf(`${at(1, 1)}ink${CSI}L${CSI}2@`, SIZE)).rejects.toThrow('unmodelled CSI finals: @L');
  });
});

describe('the pty driver', () => {
  test('a run ends every process the program started, not only the program', async () => {
    const pidFile = scratchPath('pty-driver-group', 'child.pid');
    const program = scratchPath('pty-driver-group', 'program.ts');

    // The child outlives the terminal's hangup, as a child still shutting down does: only the group's end stops it.
    writeFileSync(program, [
      "const child = Bun.spawn(['sh', '-c', 'trap \"\" HUP; while :; do sleep 1; done']);",
      `await Bun.write(${JSON.stringify(pidFile)}, String(child.pid));`,
      "console.log('ready');",
      'await child.exited;',
    ].join('\n'));

    const run = await runTuiInPty(program, { steps: [{ wait: 'ready', timeout: 15 }] });
    const child = Number(readFileSync(pidFile, 'utf8'));
    const alive = tolerate(() => process.kill(child, 0), 'esrch') !== undefined;

    // A red run must not leave the loop behind for the scratch release to trip over.
    if (alive) process.kill(child, 'SIGKILL');
    expect(run.waits.every((wait) => wait.met), run.screen).toBe(true);
    expect(alive).toBe(false);
  });
});
