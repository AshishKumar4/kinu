/**
 * The app's palette as Chromium resolves it: each token is painted through a probe on the real stylesheet, so
 * the cascade, the light theme's overrides and every `var()` indirection are the browser's own.
 *
 * Every text role meets WCAG AA against every surface it can land on, on both themes. And Kumo, whose
 * components ship compiled, paints from the Kinu palette: its colour tokens are the only lever, and a token
 * left unmapped, or mapped to a literal, silently keeps Kumo's blue (or the dark value on the light theme).
 */
import { describe, expect, test } from 'bun:test';

import { unruledClasses, withGallery } from './gallery-harness';

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

/** Kumo's colour families: the size scale and the raw neutral ramp are inputs, not surfaces the palette themes. */
const KUMO_COLOUR = '^--(color-kumo-(?!neutral-)|text-color-kumo-)';

/** Each Kumo colour token before and after the palette moves, every class naming a Kumo token, and those
 *  of them no served rule selects. */
interface KumoRead {
  readonly tokens: Readonly<Record<string, readonly [before: string, after: string]>>;
  readonly utilities: readonly string[];
  readonly unruled: readonly string[];
}

/**
 * Runs inside the page; closes over nothing. Every `--c-*` the document declares is rewritten on the root to a
 * sentinel colour: a Kumo token that follows the palette moves with it, and one left on Kumo's own value does not.
 */
function readKumo(colourFamily: string): Omit<KumoRead, 'unruled'> {
  const family = new RegExp(colourFamily, 'u');
  const kumo = new Set<string>();
  const palette = new Set<string>();

  const walk = (rules: CSSRuleList): void => {
    for (const rule of rules) {
      if (rule instanceof CSSStyleRule) {
        for (let at = 0; at < rule.style.length; at += 1) {
          const name = rule.style.item(at);

          if (family.test(name)) kumo.add(name);

          if (name.startsWith('--c-')) palette.add(name);
        }
      }

      if (rule instanceof CSSGroupingRule) walk(rule.cssRules);
    }
  };

  for (const sheet of document.styleSheets) walk(sheet.cssRules);

  // `bg-kumo-base`, `hover:bg-kumo-tint`, `!text-kumo-default`: every class naming a Kumo token.
  const utilities = new Set([...document.querySelectorAll('[class*="-kumo-"]')]
    .flatMap((element) => [...element.classList].filter((name) => name.includes('-kumo-'))));

  const colourOf = (name: string): string => {
    const probe = document.createElement('div');
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const computed = getComputedStyle(probe).color;
    probe.remove();

    return computed;
  };

  const before = new Map([...kumo].map((name) => [name, colourOf(name)] as const));

  for (const [index, name] of [...palette].entries()) {
    document.documentElement.style.setProperty(name, `rgb(${String(index % 256)}, ${String(Math.floor(index / 256))}, 251)`);
  }

  const tokens: Record<string, readonly [string, string]> = {};

  for (const name of kumo) tokens[name] = [before.get(name) ?? '', colourOf(name)];

  return { tokens, utilities: [...utilities] };
}

type Mode = (typeof MODES)[number];

/** Transparent is a mapping (`--color-kumo-tip-shadow`), not a colour the palette could move. */
const TRANSPARENT = 'rgba(0, 0, 0, 0)';

const { palettes, kumo } = await withGallery(async ({ newPage, origin }) => {
  const byMode: Partial<Record<Mode, Palette>> = {};
  const kumoByMode: Partial<Record<Mode, KumoRead>> = {};

  for (const mode of MODES) {
    const page = await newPage();
    // The pre-paint script reads the preference once, at load.
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: mode }]);
    await page.goto(`${origin}/gallery.html?frame=home`, { waitUntil: 'networkidle0' });
    byMode[mode] = await page.evaluate(paletteOf, ASKED);
    await page.close();

    // The workspace page mounts Kumo's compiled components: tabs, the composer's controls.
    const workspace = await newPage();
    await workspace.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: mode }]);
    await workspace.goto(`${origin}/gallery.html?frame=workspacepage`, { waitUntil: 'networkidle0' });
    // Kumo's components ship compiled: their utilities exist only if Tailwind's sources reached Kumo's dist.
    kumoByMode[mode] = {
      ...await workspace.evaluate(readKumo, KUMO_COLOUR),
      unruled: await workspace.evaluate(unruledClasses, '[class*="-kumo-"]', '-kumo-', []),
    };
    await workspace.close();
  }

  return { palettes: byMode, kumo: kumoByMode };
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

describe.each([...MODES])('Kumo on the %s theme', (mode) => {
  const read = kumo[mode];

  if (read === undefined) throw new Error(`no Kumo read on the ${mode} theme`);

  test('the page carries Kumo\'s colour tokens and components that use its utilities', () => {
    // An empty read would make every check below pass vacuously.
    expect(Object.keys(read.tokens).length).toBeGreaterThan(30);
    expect(Object.keys(read.tokens)).toContain('--color-kumo-brand');
    expect(read.utilities.length).toBeGreaterThan(10);
  });

  test('every Kumo colour token moves with the Kinu palette', () => {
    const fixed = Object.entries(read.tokens)
      .filter(([, [before, after]]) => before === after && before !== TRANSPARENT)
      .map(([name, [before]]) => `${name} stays ${before}`);

    expect(fixed).toEqual([]);
  });

  test('every Kumo utility the page carries was generated into the served CSS', () => {
    expect(read.unruled).toEqual([]);
  });
});
