/**
 * The signed-out pages carry their own stylesheet, projected by hand from the app's palette by
 * core's `publicPage`. Defends: that projection drifting from the app's index.css. Chromium is asked
 * about both documents per theme: every palette token the shell projects must be the app's and compute
 * to what the app computes (radius roles to the same length), and the shared faces load the same webfont files.
 *
 * What the shell emits on its own (order, preloads, byte budgets, the pre-paint script) stays in
 * packages/cf-backend/tests/unit-public-shell.test.ts.
 */
import { describe, expect, test } from 'bun:test';

import { withGallery } from './gallery-harness';

const MODES = ['dark', 'light'] as const;

/**
 * The token families the shell projects from the app's palette, each with the property that computes it: a probe
 * painted through the token resolves the value, so the same colour written two ways computes alike. The shell's own
 * layout tokens (`--gutter`, `--rule`, `--ease`) are no family's and not projections.
 */
const PROJECTED: readonly (readonly [prefix: string, property: string])[] = [
  ['--c-', 'color'],
  ['--shadow-', 'box-shadow'],
  ['--r-', 'border-top-left-radius'],
];

const projected = (name: string): boolean => PROJECTED.some(([prefix]) => name.startsWith(prefix));

/** What one document computes, as Chromium resolved it. */
interface Painted {
  readonly mode: string | undefined;
  /** Every custom property the document's own `:root` rules declare, by name. */
  readonly declared: readonly string[];
  /** Each asked token as a probe computes it through its family's property. */
  readonly tokens: Readonly<Record<string, string>>;
  /** `@font-face` rules by family, each face's `src` as the engine parsed it. */
  readonly faces: Readonly<Record<string, readonly string[]>>;
}

/** Runs inside the page; closes over nothing, since puppeteer serialises it. Null asks for the
 *  document's own declared tokens. */
function paintOf(asked: readonly string[] | null, families: readonly (readonly [string, string])[]): Painted {
  const normalise = (value: string): string => value.trim().replace(/\s+/gu, ' ').replace(/\s*,\s*/gu, ',');
  const declared = new Set<string>();
  const faces: Record<string, string[]> = {};

  const walk = (rules: CSSRuleList): void => {
    for (const rule of rules) {
      if (rule instanceof CSSStyleRule && rule.selectorText === ':root') {
        for (let at = 0; at < rule.style.length; at += 1) {
          const name = rule.style.item(at);

          if (name.startsWith('--')) declared.add(name);
        }
      } else if (rule instanceof CSSFontFaceRule) {
        const family = rule.style.getPropertyValue('font-family').replaceAll('"', '').trim();
        faces[family] = [...(faces[family] ?? []), normalise(rule.style.getPropertyValue('src'))];
      }

      if (rule instanceof CSSGroupingRule) walk(rule.cssRules);
    }
  };

  for (const sheet of document.styleSheets) walk(sheet.cssRules);

  const tokens: Record<string, string> = {};

  for (const name of (asked ?? [...declared])) {
    const property = families.find(([prefix]) => name.startsWith(prefix))?.[1];

    if (property === undefined) continue;
    const probe = document.createElement('div');
    probe.style.setProperty(property, `var(${name})`);
    document.body.append(probe);
    tokens[name] = normalise(getComputedStyle(probe).getPropertyValue(property));
    probe.remove();
  }

  return { mode: document.documentElement.dataset.mode, declared: [...declared].sort(), tokens, faces };
}

type Mode = (typeof MODES)[number];

/** The app shell and the sign-in page, as one visitor on each theme sees them. */
const painted = await withGallery(async ({ newPage, origin }) => {
  const open = async (mode: Mode, frame: string, asked: readonly string[] | null): Promise<Painted> => {
    const page = await newPage();
    // The pre-paint script reads the preference once, at load.
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: mode }]);
    await page.goto(`${origin}/gallery.html?frame=${frame}`, { waitUntil: 'networkidle0' });
    const paint = await page.evaluate(paintOf, asked, PROJECTED);
    await page.close();

    return paint;
  };

  const byMode: Partial<Record<Mode, { app: Painted; shell: Painted }>> = {};

  for (const mode of MODES) {
    // The shell names the tokens it projects; the app is asked for exactly those.
    const shell = await open(mode, 'login', null);
    byMode[mode] = { shell, app: await open(mode, 'shell', shell.declared.filter(projected)) };
  }

  return byMode;
});

describe.each([...MODES])('the sign-in page on the %s theme', (mode) => {
  const both = painted[mode];

  if (both === undefined) throw new Error(`no paint was taken on the ${mode} theme`);
  const { app, shell } = both;

  test('both documents are on the theme the pass claims', () => {
    expect([app.mode, shell.mode]).toEqual([mode, mode]);
  });

  test('the shell projects a palette and radius roles, not an empty set', () => {
    const names = shell.declared.filter(projected);
    expect(names.filter((name) => name.startsWith('--c-')).length).toBeGreaterThan(10);
    expect(names.filter((name) => name.startsWith('--r-')).length).toBeGreaterThan(0);
  });

  test('every token the shell projects is the app\'s, and computes to what the app computes', () => {
    // A token the app renamed or dropped is drift too: the shell would keep painting the old value.
    const drift = shell.declared
      .filter((name) => projected(name) && (!app.declared.includes(name) || app.tokens[name] !== shell.tokens[name]))
      .map((name) => `${name}: app ${JSON.stringify(app.tokens[name])}, shell ${JSON.stringify(shell.tokens[name])}`);

    expect(drift).toEqual([]);
  });

  test('the shared faces load the same webfont files, and Newsreader stays in the app', () => {
    for (const family of ['Schibsted Grotesk', 'Fragment Mono']) {
      const shellFaces = shell.faces[family] ?? [];
      expect(shellFaces.length, `${family} in the shell`).toBeGreaterThan(0);
      expect(shellFaces.filter((face) => !(app.faces[family] ?? []).includes(face)), `${family} faces the app lacks`).toEqual([]);
    }

    expect(app.faces.Newsreader?.join(' ')).toContain('/assets/fonts/newsreader-latin-var.woff2');
    expect(shell.faces.Newsreader).toBeUndefined();
  });
});
