/**
 * Every text role must meet WCAG AA against every surface it can land on, in both palettes × both modes.
 * Tokens come from `index.css`; every palette block has specificity (0,1,0), so source order models the cascade.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { present } from '@kinu.run/test-utils';

const INDEX_CSS = resolve(import.meta.dir, '../src/index.css');

/** Text roles and allowed surfaces; dim and micro-label roles land anywhere, dialogs included. */
const SURFACES = ['--c-bg', '--c-sidebar', '--c-surface', '--c-elevated', '--c-overlay', '--c-recessed', '--c-fill'] as const;

const TEXT_ROLES = [
  '--c-text', '--c-text-2', '--c-text-3', '--c-text-4', '--c-accent-fg',
  '--c-success', '--c-warning', '--c-danger', '--c-info',
] as const;

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
    const n = parseInt(hex[1], 16);

    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }

  const rgb = css.match(/^rgba?\(([^)]+)\)$/i);

  if (rgb) {
    const [r, g, b, a] = rgb[1].split(',').map((v) => Number(v.trim()));

    return { r: r, g: g, b: b, a: a ?? 1 };
  }

  throw new Error(`palette token is not a hex or rgb() literal: ${css}`);
}

const CASCADE = [
  { theme: 'dark', blocks: [':root'] },
  { theme: 'light', blocks: [':root', '[data-mode="light"]'] },
] as const;

/** Anchored at line start so the selector cannot match a compound selector or a mention in a comment. */
function block(css: string, selector: string) {
  const at = css.search(new RegExp(`^${selector.replace(/[[\]"().*+?^${}|\\]/g, '\\$&')}\\s*\\{`, 'm'));

  if (at === -1) throw new Error(`no ${selector} block in index.css`);
  const open = css.indexOf('{', at);
  let depth = 0, i = open;

  for (; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) break;
  }

  return Object.fromEntries(
    [...css.slice(open, i).matchAll(/(--c-[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]),
  );
}

/** Blocks applied in source order, then one level of `var(--c-…)` resolved, which is all the palette uses. */
function palette(blocks: readonly string[]) {
  const css = readFileSync(INDEX_CSS, 'utf8');
  const merged: Record<string, string> = {};

  for (const selector of blocks) Object.assign(merged, block(css, selector));

  for (const [k, v] of Object.entries(merged)) {
    const ref = v.match(/^var\((--c-[a-z0-9-]+)\)$/);

    if (ref) merged[k] = present(merged[ref[1]], `the palette variable ${ref[1]}`);
  }

  return merged;
}

const over = (fg: Rgb, bg: Rgb): Rgb => ({
  r: fg.r * fg.a + bg.r * (1 - fg.a),
  g: fg.g * fg.a + bg.g * (1 - fg.a),
  b: fg.b * fg.a + bg.b * (1 - fg.a),
  a: 1,
});

function luminance({ r, g, b }: Rgb): number {
  const ch = (c: number) => {
    const v = c / 255;

    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };

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
  for (const { theme, blocks } of CASCADE) {
    describe(theme, () => {
      const p = palette(blocks);

      test('every token the roles need is declared', () => {
        // A renamed token would make the loops below iterate over nothing and pass.
        const needed = [...SURFACES, ...TEXT_ROLES, ...FILLS.flatMap(([i, f]) => [i, f])];
        expect(needed.filter((t) => !(t in p))).toEqual([]);
      });

      test('every text role meets AA on every surface', () => {
        const failures = TEXT_ROLES.flatMap((role) =>
          SURFACES.map((surface) => ({ role, surface, ratio: Number(contrast(p[role], p[surface]).toFixed(2)) }))
            .filter((r) => r.ratio < AA));

        expect(failures).toEqual([]);
      });

      test('every filled control carries legible ink', () => {
        const failures = FILLS
          .map(([ink, fill, what]) => ({ what, ratio: Number(contrast(p[ink], p[fill]).toFixed(2)) }))
          .filter((r) => r.ratio < AA);

        expect(failures).toEqual([]);
      });

      test('status text stays legible on its own tint', () => {
        const failures = (['success', 'warning', 'danger', 'info'] as const)
          .map((s) => {
            const tinted = over(parse(p[`--c-${s}-tint`]), parse(p['--c-bg']));
            const css = `rgb(${tinted.r},${tinted.g},${tinted.b})`;

            return { badge: s, ratio: Number(contrast(p[`--c-${s}`], css).toFixed(2)) };
          })
          .filter((r) => r.ratio < AA);

        expect(failures).toEqual([]);
      });
    });
  }
});
