/**
 * An agent's colour: a hue its birth rank picks, golden-angle steps from a start its workspace picks. A palette of
 * twelve gave the thirteenth agent the first one's colour (production, 2026-10-08); a hue never repeats, and every one
 * keeps the tile's eyes and its edge as legible as the palette it replaced, in both themes.
 */
import { describe, expect, test } from 'bun:test';
import { hueStops, rankHue } from '../src/web/agent-colour';
import { THEME_TOKENS } from '../src/web/theme';

/** WCAG 2.x relative luminance of an opaque sRGB hex colour. */
function luminance(hex: string): number {
  const channel = (at: number): number => {
    const unit = Number.parseInt(hex.slice(at, at + 2), 16) / 255;

    return unit <= 0.040_45 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  };

  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG's contrast ratio between two opaque colours. */
function contrast(one: string, other: string): number {
  const [light, dark] = [luminance(one), luminance(other)].sort((a, b) => b - a);

  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

const EVERY_TENTH_DEGREE = Array.from({ length: 3600 }, (_unused, tenth) => tenth / 10);

describe("an agent's colour", () => {
  test('no two of a workspace\'s first 64 agents share one, the thirteenth included', () => {
    const tiles = Array.from({ length: 64 }, (_unused, rank) => hueStops(rankHue(7, rank)).join(' '));

    expect(new Set(tiles).size).toBe(64);
    expect(tiles[12]).not.toBe(tiles[0]);
  });

  test('agents born one after another sit far apart on the wheel', () => {
    const gaps = Array.from({ length: 63 }, (_unused, rank) => {
      const step = Math.abs(rankHue(7, rank + 1) - rankHue(7, rank));

      return Math.min(step, 360 - step);
    });

    expect(Math.min(...gaps)).toBeGreaterThan(100);
  });

  test('at every hue the eyes read on the tile, and its edge on either theme\'s grounds', () => {
    const dark = [THEME_TOKENS.dark['--c-bg'], THEME_TOKENS.dark['--c-sidebar']];
    const light = [THEME_TOKENS.light['--c-bg'], THEME_TOKENS.light['--c-sidebar']];
    const worst = { eyes: Number.POSITIVE_INFINITY, onDark: Number.POSITIVE_INFINITY, onLight: Number.POSITIVE_INFINITY };

    for (const hue of EVERY_TENTH_DEGREE) {
      const [lightest, middle, darkest] = hueStops(hue);

      worst.eyes = Math.min(worst.eyes, contrast('#FFFFFF', middle));
      worst.onDark = Math.min(worst.onDark, ...dark.map((ground) => contrast(lightest, ground)));
      worst.onLight = Math.min(worst.onLight, ...light.map((ground) => contrast(darkest, ground)));
    }

    // The eyes as legible as the twelve-colour palette's (2.49:1 at its worst); the edge a graphic's 3:1 on its ground.
    expect(worst.eyes).toBeGreaterThanOrEqual(2.45);
    expect(worst.onDark).toBeGreaterThanOrEqual(3);
    expect(worst.onLight).toBeGreaterThanOrEqual(3);
  });
});
