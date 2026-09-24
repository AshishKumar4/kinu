/** Theme ink per role, read from the SGR bytes the product writes to a real pty. */
import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

import { BUILTIN_TUI_THEMES, createThemeRegistry, DEFAULT_TUI_THEME_SELECTION } from '../src/tui/theme';
import { inkBefore, runTuiInPty } from './helpers/pty-screen';

const entry = resolve(import.meta.dir, 'fixtures/pty-chat.tsx');

describe('the chat surface on a real terminal, fresh install', () => {
  test('the default theme paints the canvas and writes assistant prose in ink', async () => {
    const light = createThemeRegistry(BUILTIN_TUI_THEMES).get(DEFAULT_TUI_THEME_SELECTION.themeId);

    const run = await runTuiInPty(entry, {
      steps: [
        { wait: 'Connected to pty', timeout: 15 },
        { send: 'draft one' },
        { wait: 'draft one', timeout: 1 },
        { send: '\r' },
        { wait: 'agent prose reply', timeout: 3 },
      ],
    });

    const canvas = light.colors.background.canvas;

    if (canvas === undefined) throw new Error('the default theme must paint a canvas');
    const [red, green, blue] = [1, 3, 5].map((start) => Number.parseInt(canvas.slice(start, start + 2), 16));
    expect(run.raw).toContain(`48;2;${String(red)};${String(green)};${String(blue)}m`);
    // The agent body uses the ink register, not the dimmer body register.
    expect(inkBefore(run.raw, 'agent prose reply')).toBe(light.colors.text.strong);
    expect(light.colors.text.strong).not.toBe(light.colors.text.primary);
  });
});
