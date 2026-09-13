/**
 * The file diff card on a real terminal, where the SGR bytes are the proof:
 * the in-process suite asserts the card's rows; here a real pty shows that
 * the added and removed inks the theme audit blessed are the ones a terminal
 * actually receives.
 */
import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

import { BUILTIN_TUI_THEMES, DEFAULT_TUI_THEME_SELECTION } from '../src/tui/theme';
import { inkBefore, runTuiInPty } from './helpers/pty-screen';

const entry = resolve(import.meta.dir, 'fixtures/pty-chat.tsx');

describe('the file diff card on a real terminal', () => {
  test('an edit result renders header and hunk lines in the well inks', () => {
    const selection = DEFAULT_TUI_THEME_SELECTION;

    if (selection.mode !== 'theme') throw new Error('the default selection opens on a pinned theme');
    const theme = BUILTIN_TUI_THEMES.find((candidate) => candidate.id === selection.themeId);

    if (theme === undefined) throw new Error(`missing default theme ${selection.themeId}`);

    const run = runTuiInPty(entry, {
      env: { KINU_PTY_FILE_EDIT: '1' },
      steps: [
        { wait: 'Connected to pty', timeout: 15 },
        { send: 'edit state.ts' },
        { send: '\r' },
        { wait: 'src/state.ts', timeout: 3 },
        { wait: '+ export const ready = true;', timeout: 3 },
      ],
    });

    // The card's first three rows on screen: header, removed, added. The
    // header is the ↳ row — the call row above it carries the path inside
    // the clipped args preview.
    const rows = run.screen.split('\n').map((line) => line.trimEnd()).filter((line) => line.trim() !== '');
    const header = rows.findIndex((line) => line.includes('↳ src/state.ts'));

    expect(header).toBeGreaterThanOrEqual(0);
    expect(rows[header]).toContain('+1');
    expect(rows[header]).toContain('−1');
    expect(rows[header + 1]).toContain('− export const ready = false;');
    expect(rows[header + 2]).toContain('+ export const ready = true;');
    // Prefix and text are sibling spans, so the SGR sits before the text,
    // not before the whole `− export…` string.
    expect(inkBefore(run.raw, 'export const ready = false;')).toBe(theme.colors.well.danger);
    expect(inkBefore(run.raw, 'export const ready = true;')).toBe(theme.colors.well.success);
  }, 60_000);
});
