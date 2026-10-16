/**
 * The terminal's colours, every theme and mode: a slot a program writes text in reads at WCAG AA on the terminal's
 * ground. The light terminal drew a bold prompt in xterm's own bright green, 1.5:1 there (the owner, 2026-10-15).
 */
import { describe, expect, test } from 'bun:test';
import { terminalPalette, THEME_NAMES, THEME_TOKENS, type TerminalPalette } from '../src/web/theme';

/** WCAG 2.2 relative luminance of a `#rrggbb` colour. */
function luminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = [1, 3, 5]
    .map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255)
    .map((channel) => (channel <= 0.039_28 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(ink: string, ground: string): number {
  const [light, dark] = [luminance(ink), luminance(ground)].sort((a, b) => b - a);

  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

/** The slots programs write text in; black is the recess a dark terminal paints backgrounds with. */
const TEXT_SLOTS = [
  'foreground', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
] as const satisfies readonly (keyof TerminalPalette)[];

describe('the terminal palette', () => {
  for (const theme of THEME_NAMES) {
    for (const mode of ['light', 'dark'] as const) {
      test(`${theme} ${mode}: every text slot reads at 4.5:1 or more on the terminal's ground`, () => {
        const palette = terminalPalette(mode, (name) => THEME_TOKENS[theme][mode][name]);
        const slots = mode === 'light' ? [...TEXT_SLOTS, 'black' as const] : TEXT_SLOTS;
        const below = slots.filter((slot) => contrast(palette[slot], palette.background) < 4.5);

        expect(below).toEqual([]);
      });
    }
  }
});
