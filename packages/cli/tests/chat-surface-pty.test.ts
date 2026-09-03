/**
 * Defects 4 and 5, proven where they live: on a real terminal's byte stream.
 *
 * The in-process theme suite pins the resolved ink per role through the test
 * renderer's span capture. This test reads the same facts out of the SGR
 * sequences the product writes to a real pty, so a default that paints the
 * canvas and a prose register in ink are what a terminal actually receives.
 */
import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

import { BUILTIN_TUI_THEMES, DEFAULT_TUI_THEME_SELECTION } from '../src/tui/theme';
import { inkBefore, runTuiInPty } from './helpers/pty-screen';

const entry = resolve(import.meta.dir, 'fixtures/pty-chat.tsx');

describe('the chat surface on a real terminal, fresh install', () => {
  test('the default theme paints the canvas and writes assistant prose in ink', () => {
    const selection = DEFAULT_TUI_THEME_SELECTION;
    if (selection.mode !== 'system') throw new Error('the default selection follows the terminal');
    const dark = BUILTIN_TUI_THEMES.find((theme) => theme.id === selection.darkThemeId)!;
    const run = runTuiInPty(entry, {
      steps: [
        { wait: 'Connected to pty', timeout: 15 },
        { send: 'draft one' },
        { sleep: 1 },
        { send: '\r' },
        { sleep: 3 },
      ],
    });
    // Defect 4: a fresh install paints. The canvas token is defined and its
    // background SGR reaches the terminal, so panels sit on a fill rather
    // than on whatever the terminal happens to be.
    expect(dark.colors.background.canvas).toBeDefined();
    const canvas = dark.colors.background.canvas!;
    const [red, green, blue] = [1, 3, 5].map((start) => Number.parseInt(canvas.slice(start, start + 2), 16));
    expect(run.raw).toContain(`48;2;${String(red)};${String(green)};${String(blue)}m`);
    // Defect 5: the agent's body is written in the ink register, not the
    // dimmer body register, so it reads as prose beside the muted thinking
    // line and the muted annotations.
    expect(inkBefore(run.raw, 'agent prose reply')).toBe(dark.colors.text.strong);
    expect(dark.colors.text.strong).not.toBe(dark.colors.text.primary);
  }, 60_000);
});
