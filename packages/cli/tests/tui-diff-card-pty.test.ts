/** The diff card on a real pty: the SGR bytes prove the theme's added/removed inks reach the terminal. */
import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

import { BUILTIN_TUI_THEMES, createThemeRegistry, DEFAULT_TUI_THEME_SELECTION } from '../src/tui/theme';
import { inkBefore, runTuiInPty } from './helpers/pty-screen';

const entry = resolve(import.meta.dir, 'fixtures/pty-chat.tsx');

describe('the file diff card on a real terminal', () => {
  test('an edit result renders header and hunk lines in the well inks', () => {
    const theme = createThemeRegistry(BUILTIN_TUI_THEMES).get(DEFAULT_TUI_THEME_SELECTION.themeId);

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

    // The header is the ↳ row; the call row above it carries the path inside the clipped args preview.
    const rows = run.screen.split('\n').map((line) => line.trimEnd()).filter((line) => line.trim() !== '');
    const header = rows.findIndex((line) => line.includes('↳ src/state.ts'));

    expect(header).toBeGreaterThanOrEqual(0);
    expect(rows[header]).toContain('+1');
    expect(rows[header]).toContain('−1');
    expect(rows[header + 1]).toContain('− export const ready = false;');
    expect(rows[header + 2]).toContain('+ export const ready = true;');
    // Prefix and text are sibling spans, so the SGR sits before the text.
    expect(inkBefore(run.raw, 'export const ready = false;')).toBe(theme.colors.well.danger);
    expect(inkBefore(run.raw, 'export const ready = true;')).toBe(theme.colors.well.success);
  });
});
