/**
 * Every text role must meet WCAG AA against every surface it can land on, in
 * BOTH modes.
 *
 * This is the defect the design audit measured and the owner saw: light mode
 * shipped `--c-text-3` at 2.90:1 behind 10–11px meta text, and the accent and
 * every status tone failed AA on paper. Nothing catches that — a colour is
 * never "wrong" to a compiler, and the failure is invisible to whoever picked
 * the hex on a good monitor.
 *
 * Tokens are read out of `index.css` rather than restated here, so the test
 * measures what actually ships and a palette edit is checked by the same run
 * that makes it.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const INDEX_CSS = resolve(import.meta.dir, '../src/index.css');

/** Text roles, and the surfaces each is allowed to sit on. `--c-text-3` is
 *  the dim role: it lands anywhere, including inside dialogs, which is where
 *  it used to fail. */
const SURFACES = ['--c-bg', '--c-sidebar', '--c-surface', '--c-elevated', '--c-overlay', '--c-recessed'] as const;
const TEXT_ROLES = [
  '--c-text', '--c-text-2', '--c-text-3', '--c-accent-fg',
  '--c-success', '--c-warning', '--c-danger', '--c-info',
] as const;

/** Ink-on-fill pairs: a filled control supplies both halves itself. */
const FILLS: ReadonlyArray<readonly [ink: string, fill: string, what: string]> = [
  ['--c-accent-on', '--c-accent', 'p-btn label on brass'],
  ['--c-bg', '--c-danger', 'p-btn-danger label on danger'],
  ['--c-bg', '--c-success', 'MCTS node score label on the score ramp'],
  ['--c-bg', '--c-warning', 'MCTS node score label on the score ramp'],
  ['--c-text', '--c-user-bg', 'user turn'],
];

type Rgb = { r: number; g: number; b: number; a: number };

function parse(css: string): Rgb {
  const hex = css.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1]!, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const rgb = css.match(/^rgba?\(([^)]+)\)$/i);
  if (rgb) {
    const [r, g, b, a] = rgb[1]!.split(',').map((v) => Number(v.trim()));
    return { r: r!, g: g!, b: b!, a: a ?? 1 };
  }
  throw new Error(`palette token is not a hex or rgb() literal: ${css}`);
}

/** The two `:root` / `[data-mode="light"]` blocks, as name → value. Values
 *  that indirect through another token are resolved one level, which is all
 *  the palette uses. */
function palette(mode: 'dark' | 'light'): Record<string, string> {
  const text = readFileSync(INDEX_CSS, 'utf8');
  // `:root` holds the dark set; the light block overrides a subset of it, so
  // light is dark-with-overrides exactly as the cascade computes it.
  const block = (selector: string) => {
    const start = text.indexOf(selector);
    if (start === -1) throw new Error(`no ${selector} block in index.css`);
    const open = text.indexOf('{', start);
    let depth = 0, i = open;
    for (; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}' && --depth === 0) break;
    }
    return Object.fromEntries(
      [...text.slice(open, i).matchAll(/(--c-[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]),
    );
  };
  const merged = { ...block('\n:root {'), ...(mode === 'light' ? block('[data-mode="light"] {') : {}) };
  for (const [k, v] of Object.entries(merged)) {
    const ref = v.match(/^var\((--c-[a-z0-9-]+)\)$/);
    if (ref) merged[k] = merged[ref[1]!]!;
  }
  return merged;
}

/** Alpha-composite `fg` over an opaque `bg`. */
const over = (fg: Rgb, bg: Rgb): Rgb => ({
  r: fg.r * fg.a + bg.r * (1 - fg.a),
  g: fg.g * fg.a + bg.g * (1 - fg.a),
  b: fg.b * fg.a + bg.b * (1 - fg.a),
  a: 1,
});

function luminance({ r, g, b }: Rgb): number {
  const ch = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

function contrast(fgCss: string, bgCss: string): number {
  const bg = parse(bgCss);
  const a = luminance(over(parse(fgCss), bg));
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const AA = 4.5;

describe('palette contrast', () => {
  for (const mode of ['dark', 'light'] as const) {
    describe(mode, () => {
      const p = palette(mode);

      test('every token the roles need is declared', () => {
        // Guards the guard: a renamed token would otherwise make the loops
        // below iterate over nothing and pass silently.
        const needed = [...SURFACES, ...TEXT_ROLES, ...FILLS.flatMap(([i, f]) => [i, f])];
        expect(needed.filter((t) => !(t in p))).toEqual([]);
      });

      test('every text role meets AA on every surface', () => {
        const failures = TEXT_ROLES.flatMap((role) =>
          SURFACES.map((surface) => ({ role, surface, ratio: +contrast(p[role]!, p[surface]!).toFixed(2) }))
            .filter((r) => r.ratio < AA));

        // Reported as rows so a failure names the exact pair and its number.
        expect(failures).toEqual([]);
      });

      test('every filled control carries legible ink', () => {
        const failures = FILLS
          .map(([ink, fill, what]) => ({ what, ratio: +contrast(p[ink]!, p[fill]!).toFixed(2) }))
          .filter((r) => r.ratio < AA);

        expect(failures).toEqual([]);
      });

      test('status text stays legible on its own tint', () => {
        const failures = (['success', 'warning', 'danger', 'info'] as const)
          .map((s) => {
            const tinted = over(parse(p[`--c-${s}-tint`]!), parse(p['--c-bg']!));
            const css = `rgb(${tinted.r},${tinted.g},${tinted.b})`;
            return { badge: s, ratio: +contrast(p[`--c-${s}`]!, css).toFixed(2) };
          })
          .filter((r) => r.ratio < AA);

        expect(failures).toEqual([]);
      });
    });
  }
});
