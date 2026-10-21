/**
 * The app's palette as Chromium resolves it: each token is painted through a probe on the real stylesheet, so
 * the cascade, the light theme's overrides and every `var()` indirection are the browser's own.
 *
 * Every text role meets WCAG AA against every surface it can land on, in every theme and mode, and a control's edge
 * stands out from the grounds beside it. Each theme draws its own palette, named on the root as the server names it.
 * And Kumo, whose
 * components ship compiled, paints from the Kinu palette: its colour tokens are the only lever, and a token
 * left unmapped, or mapped to a literal, silently keeps Kumo's blue (or the dark value on the light theme).
 */
import { describe, expect, test } from 'bun:test';

import { contrast, over, rgba, type Rgba, unruledClasses, withGallery } from '../../scripts/gallery-harness';
import { TEST_REQUIREMENTS } from '../../scripts/test-requirements';
import { THEME_NAMES, type ThemeName } from '@kinu.run/core';

const MODES = ['dark', 'light'] as const;

/** Grounds a control's edge sits on: a field on the page, in the rail, or inside a card. */
const CONTROL_GROUNDS = ['--c-bg', '--c-sidebar', '--c-surface'] as const;

/** Every ground a role can land on; the hover and selected washes are measured over the page. */
const SURFACES = ['--c-bg', '--c-sidebar', '--c-surface', '--c-fill', '--c-overlay', '--c-sunken'] as const;

const WASHES = ['--c-hover', '--c-selected'] as const;

const TEXT_ROLES = [
  '--c-text', '--c-text-2', '--c-text-3', '--c-accent-fg',
  '--c-success', '--c-warning', '--c-danger', '--c-info',
] as const;

const FILLS: readonly (readonly [ink: string, fill: string, what: string])[] = [
  ['--c-accent-on', '--c-accent', 'primary button label on brass'],
  ['--c-danger-on', '--c-danger', 'destructive button label on danger'],
  ['--c-text', '--c-button-bg', 'secondary button label on its fill'],
  ['--c-danger', '--c-button-bg', 'danger button label on its fill'],
  ['--c-bg', '--c-success', 'MCTS node score label on the score ramp'],
  ['--c-bg', '--c-warning', 'MCTS node score label on the score ramp'],
  ['--c-text', '--c-user-bg', 'user turn'],
];

const STATUSES = ['success', 'warning', 'danger', 'info'] as const;

const AA = TEST_REQUIREMENTS.wcagTextContrast.values.normal;

/** WCAG's floor for a graphic that carries meaning: the open sidebar row's icon on its wash. */
const NON_TEXT = TEST_REQUIREMENTS.wcagNonTextContrast.values.minimum;

type Ground = (typeof SURFACES)[number] | (typeof WASHES)[number];

type Floors = typeof TEST_REQUIREMENTS.designContrastFloors.values;

/** The palette's own floors (docs/DESIGN-SYSTEM.md §1.1): each role, the grounds it lands on, and its least ratio there. */
function floorsOf(floor: Floors): readonly { readonly role: string; readonly grounds: readonly Ground[]; readonly floor: number }[] {
  return [
    { role: '--c-text', grounds: ['--c-bg', '--c-surface', '--c-overlay'], floor: floor.text },
    { role: '--c-text-2', grounds: ['--c-bg', '--c-surface'], floor: floor.text2 },
    { role: '--c-text-3', grounds: ['--c-bg', '--c-sidebar', '--c-surface', '--c-overlay', '--c-fill', '--c-hover', '--c-sunken'], floor: floor.quiet },
    { role: '--c-accent-fg', grounds: ['--c-bg', '--c-surface', '--c-selected'], floor: floor.quiet },
    { role: '--c-accent', grounds: ['--c-bg'], floor: floor.fill },
    { role: '--c-field-border', grounds: ['--c-bg', '--c-surface'], floor: floor.fill },
    { role: '--c-focus', grounds: ['--c-bg', '--c-surface'], floor: floor.fill },
    ...STATUSES.map((status) => ({ role: `--c-${status}`, grounds: ['--c-bg', '--c-surface'] satisfies Ground[], floor: floor.quiet })),
  ];
}

const ASKED = [
  ...SURFACES, ...WASHES, ...TEXT_ROLES, ...FILLS.flatMap(([ink, fill]) => [ink, fill]),
  ...STATUSES.flatMap((status) => [`--c-${status}`, `--c-${status}-tint`]),
  '--c-accent', '--c-accent-mark', '--c-field', '--c-field-border', '--c-focus', '--c-border',
];

/** What one theme and mode compute: the mode it landed on, and each asked token as a probe's `color` resolves it. */
interface Palette {
  readonly mode: string | undefined;
  readonly theme: string | undefined;
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

  return { mode: document.documentElement.dataset.mode, theme: document.documentElement.dataset.theme, colours };
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
  const byLook: Partial<Record<`${ThemeName} ${Mode}`, Palette>> = {};
  const kumoByMode: Partial<Record<Mode, KumoRead>> = {};

  for (const mode of MODES) {
    for (const theme of THEME_NAMES) {
      const page = await newPage();
      // The pre-paint script reads the preference once, at load; the theme is named on the root, as the server names it.
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: mode }]);
      await page.goto(`${origin}/gallery.html?frame=home`, { waitUntil: 'networkidle0' });
      await page.evaluate((name) => { document.documentElement.dataset.theme = name; }, theme);
      byLook[`${theme} ${mode}`] = await page.evaluate(paletteOf, ASKED);
      await page.close();
    }

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

  return { palettes: byLook, kumo: kumoByMode };
});

const LOOKS = THEME_NAMES.flatMap((theme) => MODES.map((mode) => [theme, mode] as const));

describe.each(LOOKS)('the %s palette, %s', (theme, mode) => {
  const palette = palettes[`${theme} ${mode}`];

  if (palette === undefined) throw new Error(`no palette was read for ${theme} ${mode}`);

  const colour = (name: string): Rgba => {
    const computed = palette.colours[name];

    if (computed === null || computed === undefined) throw new Error(`${name} is not declared for ${theme} ${mode}`);

    return rgba(computed);
  };

  // A wash is drawn over the page, so its ratio is the ink's against the two together.
  const groundOf = (ground: Ground): Rgba => (ground === '--c-hover' || ground === '--c-selected' ? over(colour(ground), colour('--c-bg')) : colour(ground));

  test('the page is on the theme and mode the pass claims, and declares every token the roles need', () => {
    // A renamed token would make the loops below measure a fallback colour and pass.
    expect({ theme: palette.theme, mode: palette.mode }).toEqual({ theme, mode });
    expect(ASKED.filter((name) => palette.colours[name] === null)).toEqual([]);
  });

  test('it is its own: no other theme draws this mode with the same ground, surface and text', () => {
    const face = (read: Palette | undefined) => ['--c-bg', '--c-surface', '--c-text'].map((name) => read?.colours[name]).join(' ');
    const twins = THEME_NAMES.filter((other) => other !== theme && face(palettes[`${other} ${mode}`]) === face(palette));

    expect(twins).toEqual([]);
  });

  // A field's edge shows where an empty field is; the focus ring shows where the keyboard is.
  test("a control's edge and the focus ring stand out on every ground beside them", () => {
    const failures = (['--c-field-border', '--c-focus'] as const).flatMap((line) => CONTROL_GROUNDS.map((ground) => ({
      line, ground, ratio: contrast(colour(line), colour(ground)),
    }))).filter((row) => row.ratio < NON_TEXT);

    expect(failures).toEqual([]);
  });

  test('every role clears its own floor on every ground it lands on', () => {
    const failures = floorsOf(TEST_REQUIREMENTS.designContrastFloors.values).flatMap(({ role, grounds, floor }) => grounds.map((ground) => ({
      role, ground, floor, ratio: contrast(colour(role), groundOf(ground)),
    }))).filter((row) => row.ratio < row.floor);

    expect(failures).toEqual([]);
  });

  test("a field's edge stands out inside the field too, and a hairline is visible but quiet", () => {
    expect(contrast(colour('--c-field-border'), colour('--c-field'))).toBeGreaterThanOrEqual(NON_TEXT);

    const hairlines = (['--c-bg', '--c-surface'] as const).map((ground) => contrast(colour('--c-border'), colour(ground)));

    expect(Math.min(...hairlines)).toBeGreaterThanOrEqual(TEST_REQUIREMENTS.designContrastFloors.values.hairlineLow);
    expect(Math.max(...hairlines)).toBeLessThanOrEqual(TEST_REQUIREMENTS.designContrastFloors.values.hairlineHigh);
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

  test('the open sidebar row\'s icon stands out on its wash', () => {
    expect(contrast(colour('--c-accent-mark'), over(colour('--c-selected'), colour('--c-sidebar')))).toBeGreaterThanOrEqual(NON_TEXT);
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
