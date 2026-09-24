/**
 * Every text role meets WCAG AA against every surface it can land on, on both themes, as Chromium resolves
 * the app's palette: each token is painted through a probe on the real stylesheet, so the cascade, the
 * light theme's overrides and every `var()` indirection are the browser's own, not a reading of index.css.
 */
import { describe, expect, test } from 'bun:test';

import { withGallery } from './gallery-harness';

const MODES = ['dark', 'light'] as const;

/** Surfaces a text role can land on; dim and micro-label roles land anywhere, dialogs included. */
const SURFACES = ['--c-bg', '--c-sidebar', '--c-surface', '--c-elevated', '--c-overlay', '--c-recessed', '--c-fill'] as const;

const TEXT_ROLES = [
  '--c-text', '--c-text-2', '--c-text-3', '--c-text-4', '--c-accent-fg',
  '--c-success', '--c-warning', '--c-danger', '--c-info',
] as const;

const FILLS: readonly (readonly [ink: string, fill: string, what: string])[] = [
  ['--c-accent-on', '--c-accent', 'p-btn label on brass'],
  ['--c-bg', '--c-danger', 'p-btn-danger label on danger'],
  ['--c-bg', '--c-success', 'MCTS node score label on the score ramp'],
  ['--c-bg', '--c-warning', 'MCTS node score label on the score ramp'],
  ['--c-text', '--c-user-bg', 'user turn'],
];

const STATUSES = ['success', 'warning', 'danger', 'info'] as const;

const AA = 4.5;

const ASKED = [
  ...SURFACES, ...TEXT_ROLES, ...FILLS.flatMap(([ink, fill]) => [ink, fill]),
  ...STATUSES.flatMap((status) => [`--c-${status}`, `--c-${status}-tint`]),
];

/** What one theme computes: the mode it landed on, and each asked token as a probe's `color` resolves it. */
interface Palette {
  readonly mode: string | undefined;
  /** Null for a token the document does not declare. */
  readonly colours: Readonly<Record<string, string | null>>;
}

/** Runs inside the page; closes over nothing, since puppeteer serialises it. */
function paletteOf(asked: readonly string[]): Palette {
  const colours: Record<string, string | null> = {};
  const root = getComputedStyle(document.documentElement);

  for (const name of asked) {
    if (root.getPropertyValue(name).trim() === '') {
      colours[name] = null;
      continue;
    }

    const probe = document.createElement('div');
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    colours[name] = getComputedStyle(probe).color;
    probe.remove();
  }

  return { mode: document.documentElement.dataset.mode, colours };
}

interface Rgba { readonly r: number; readonly g: number; readonly b: number; readonly a: number }

/** A computed `color`: Chromium serialises sRGB colours as `rgb(…)` or `rgba(…)`. */
function rgba(computed: string): Rgba {
  const channels = /^rgba?\(([^)]+)\)$/u.exec(computed)?.[1]?.split(',').map((part) => Number(part.trim()));

  if (channels === undefined || channels.length < 3 || channels.some(Number.isNaN)) {
    throw new Error(`not an sRGB computed colour: ${computed}`);
  }

  const [r = 0, g = 0, b = 0, a = 1] = channels;

  return { r, g, b, a };
}

const over = (ink: Rgba, paper: Rgba): Rgba => ({
  r: ink.r * ink.a + paper.r * (1 - ink.a),
  g: ink.g * ink.a + paper.g * (1 - ink.a),
  b: ink.b * ink.a + paper.b * (1 - ink.a),
  a: 1,
});

function luminance({ r, g, b }: Rgba): number {
  const channel = (value: number): number => {
    const unit = value / 255;

    return unit <= 0.039_28 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  };

  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(ink: Rgba, paper: Rgba): number {
  const light = luminance(over(ink, paper));
  const dark = luminance(paper);

  return Number(((Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05)).toFixed(2));
}

type Mode = (typeof MODES)[number];

const palettes = await withGallery(async ({ newPage, origin }) => {
  const byMode: Partial<Record<Mode, Palette>> = {};

  for (const mode of MODES) {
    const page = await newPage();
    // The pre-paint script reads the preference once, at load.
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: mode }]);
    await page.goto(`${origin}/gallery.html?frame=home`, { waitUntil: 'networkidle0' });
    byMode[mode] = await page.evaluate(paletteOf, ASKED);
    await page.close();
  }

  return byMode;
});

describe.each([...MODES])('the app palette on the %s theme', (mode) => {
  const palette = palettes[mode];

  if (palette === undefined) throw new Error(`no palette was read on the ${mode} theme`);

  const colour = (name: string): Rgba => {
    const computed = palette.colours[name];

    if (computed === null || computed === undefined) throw new Error(`${name} is not declared on the ${mode} theme`);

    return rgba(computed);
  };

  test('the page is on the theme the pass claims, and declares every token the roles need', () => {
    // A renamed token would make the loops below measure a fallback colour and pass.
    expect(palette.mode).toBe(mode);
    expect(ASKED.filter((name) => palette.colours[name] === null)).toEqual([]);
  });

  test('every text role meets AA on every surface', () => {
    const failures = TEXT_ROLES.flatMap((role) => SURFACES.map((surface) => ({
      role, surface, ratio: contrast(colour(role), colour(surface)),
    }))).filter((row) => row.ratio < AA);

    expect(failures).toEqual([]);
  });

  test('every filled control carries legible ink', () => {
    const failures = FILLS.map(([ink, fill, what]) => ({ what, ratio: contrast(colour(ink), colour(fill)) }))
      .filter((row) => row.ratio < AA);

    expect(failures).toEqual([]);
  });

  test('status text stays legible on its own tint', () => {
    const failures = STATUSES.map((status) => ({
      status,
      ratio: contrast(colour(`--c-${status}`), over(colour(`--c-${status}-tint`), colour('--c-bg'))),
    })).filter((row) => row.ratio < AA);

    expect(failures).toEqual([]);
  });
});
