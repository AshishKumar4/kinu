/**
 * Every text role must meet WCAG AA against every surface it can land on, in
 * every theme — both palettes × both modes.
 *
 * This is the defect the design audit measured and the owner saw: light mode
 * shipped `--c-text-3` at 2.90:1 behind 10–11px meta text, and the accent and
 * every status tone failed AA on paper. Nothing catches that — a colour is
 * never "wrong" to a compiler, and the failure is invisible to whoever picked
 * the hex on a good monitor.
 *
 * Tokens are read out of `index.css` rather than restated here, so the test
 * measures what actually ships and a palette edit is checked by the same run
 * that makes it. The four themes are assembled by REPLAYING the cascade: every
 * palette block in the stylesheet carries specificity (0,1,0) — `:root` is a
 * pseudo-class, the others are attribute selectors — so source order alone
 * decides, and a selector list in source order is a faithful model of it.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const INDEX_CSS = resolve(import.meta.dir, '../src/index.css');

/** Text roles, and the surfaces each is allowed to sit on. `--c-text-3` is
 *  the dim role: it lands anywhere, including inside dialogs, which is where
 *  it used to fail. */
const SURFACES = ['--c-bg', '--c-sidebar', '--c-surface', '--c-elevated', '--c-overlay', '--c-recessed', '--c-fill'] as const;
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

/** Each theme, and the palette blocks that apply to it in source order. `:root`
 *  holds umber dark; each later block overrides a subset (umber light) or the
 *  whole set (silk). */
const CASCADE = [
  { theme: 'umber dark', blocks: [':root'] },
  { theme: 'umber light', blocks: [':root', '[data-mode="light"]'] },
  { theme: 'silk dark', blocks: [':root', '[data-palette="silk"]'] },
  // `[data-mode="light"]` still MATCHES silk light and sits between the two
  // silk blocks in source order, so it is part of that cascade even though silk
  // is expected to overwrite every token it sets. Modelling it is what lets the
  // completeness test below prove that expectation rather than assume it.
  {
    theme: 'silk light',
    blocks: [':root', '[data-mode="light"]', '[data-palette="silk"]', '[data-palette="silk"][data-mode="light"]'],
  },
] as const;

/** One palette block, as name → value, `--c-*` only. Anchored at the start of
 *  a line so `[data-palette="silk"]` cannot match the compound selector or a
 *  mention of itself in a comment. */
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
    [...css.slice(open, i).matchAll(/(--c-[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]),
  );
}

/** The theme as the browser would compute it: every matching block applied in
 *  source order, then one level of `var(--c-…)` indirection resolved, which is
 *  all the palette uses. */
function palette(blocks: readonly string[]) {
  const css = readFileSync(INDEX_CSS, 'utf8');
  const merged: Record<string, string> = {};
  for (const selector of blocks) Object.assign(merged, block(css, selector));
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
  /** A silk block that forgot a token does not fail to render: it inherits
   *  whichever earlier block declared it last, so silk light would quietly
   *  serve a dark-face value or an umber one. That is the cascade hazard the
   *  four-way matrix creates, and it is checked structurally rather than left
   *  to whether the omitted token happens to fail a contrast pair. */
  test('each silk block declares the whole palette, not a diff over another one', () => {
    const css = readFileSync(INDEX_CSS, 'utf8');
    const roles = Object.keys(block(css, ':root')).sort();
    for (const selector of ['[data-palette="silk"]', '[data-palette="silk"][data-mode="light"]']) {
      const declared = Object.keys(block(css, selector)).sort();
      expect({ selector, missing: roles.filter((t) => !declared.includes(t)) })
        .toEqual({ selector, missing: [] });
      // The other direction: a typo'd role name is a token nothing reads.
      expect({ selector, unknown: declared.filter((t) => !roles.includes(t)) })
        .toEqual({ selector, unknown: [] });
    }
  });

  for (const { theme, blocks } of CASCADE) {
    describe(theme, () => {
      const p = palette(blocks);

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
