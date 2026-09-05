/**
 * The pty driver's screen model, against the renderer's own byte patterns.
 *
 * Every `wait` in a pty test reads this model, so its blind spots are the
 * gate's. The first case is the pattern that held the first-run tier red on
 * staging on 2026-09-04: the composer placeholder changed from `Connecting…`
 * to `Send a message…`, the renderer rewrote only the cells that differed, and
 * a wait that searched the byte stream never saw the word the terminal showed.
 * The last case is the model's own refusal, so a control it does not follow
 * turns a run red instead of green over a grid the terminal never showed.
 */
import { describe, expect, test } from 'bun:test';

import { screenOf } from './helpers/pty-screen';

const ESC = '\u001B';
const CSI = `${ESC}[`;
const at = (row: number, col: number) => `${CSI}${String(row)};${String(col)}H`;
const SIZE = { rows: 30, cols: 100 };

describe('the pty screen model', () => {
  test('a word painted by rewriting only its changed cells is on the screen', () => {
    // Captured 2026-09-05 from the shipped surface on a real pty: `Connecting…`
    // and `Send a message…` share their third cell, so the second paint skips
    // it, and an SGR reset sits between the two runs.
    const bytes = `${at(29, 31)}Connecting…${at(29, 31)}Se${CSI}0m${at(29, 34)}`
      + `${CSI}38;2;156;145;132m${CSI}48;2;36;30;22md a message…`;
    expect(bytes).not.toContain('Send a message…');
    const screen = screenOf(bytes, SIZE);
    expect(screen.split('\n')[28]).toContain('Send a message…');
    expect(screen).not.toContain('Connecting');
  });

  test('an overlay repainted as blanks has left the screen', () => {
    const card = `${at(12, 30)}D don't ask again · N not now`;
    const cleared = `${at(12, 30)}${' '.repeat(29)}`;
    expect(screenOf(card, SIZE)).toContain('not now');
    expect(screenOf(card + cleared, SIZE)).not.toContain('not now');
    expect(screenOf(`${card}${CSI}2J`, SIZE).trim()).toBe('');
  });

  test('colour, mode, query and cursor-shape sequences leave no text behind', () => {
    // `CSI 1 SP q` (cursor shape) and `CSI ? 1016 $ p` (mode query) carry an
    // intermediate byte; the tmux passthrough is a DCS with an ESC inside.
    const bytes = `${CSI}?2031h${ESC}]11;?\u0007${CSI}>0q${CSI}?1016$p${CSI}?u${CSI}1 q`
      + `${ESC}Ptmux;${ESC}${ESC}]11;?\u0007${ESC}\\`
      + `${at(1, 1)}${CSI}38;2;255;255;255m${CSI}48;2;20;17;16mink${CSI}0m`;
    expect(screenOf(bytes, SIZE)).toBe(`ink${'\n'.repeat(29)}`);
  });

  test('wide and combining cells keep a row in step with the terminal', () => {
    const bytes = `${at(1, 1)}漢${at(1, 3)}x${at(2, 1)}e\u0301${at(2, 2)}y`;
    const [first, second] = screenOf(bytes, SIZE).split('\n');
    expect(first).toBe('漢x');
    expect(second).toBe('e\u0301y');
  });

  test('plain output before the renderer starts scrolls and wraps like a terminal', () => {
    const small = { rows: 3, cols: 10 };
    // A ready line, a line that wraps, then a line feed on the last row.
    const bytes = 'READY-FR\r\nabcdefghijkl\r\nlast';
    expect(screenOf(bytes, small)).toBe('abcdefghij\nkl\nlast');
  });

  test('a control that moves cells and is not modelled refuses the run', () => {
    // Scroll up (CSI S) and insert line (CSI L) shift every row below the
    // cursor. A model that skipped them would answer with the wrong grid.
    expect(() => screenOf(`${at(1, 1)}ink${CSI}1S`, SIZE)).toThrow('unmodelled CSI finals: S');
    expect(() => screenOf(`${at(1, 1)}ink${CSI}L${CSI}2@`, SIZE)).toThrow('unmodelled CSI finals: @L');
  });
});
