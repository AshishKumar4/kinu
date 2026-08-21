/**
 * The signed-out pages must be the same product as the app.
 *
 * They cannot import `index.css`: they are served by the worker as one
 * self-contained document, with no bundler and no stylesheet link. So the
 * public shell carries a PROJECTION of that palette, and the projection is
 * exactly the drift this file exists to make impossible. The four surfaces
 * previously carried three hand-copied sets of the umber hexes, `index.css`
 * asked for them to "stay identical to it" in a comment, and by the time
 * anyone looked they were not: no light mode at all, a different hairline
 * alpha, three different button heights.
 *
 * A comment is not a gate. This is:
 *
 *   · every token the shell declares equals what `index.css` resolves for the
 *     same token in the same theme, with the cascade replayed rather than
 *     assumed;
 *   · every radius role equals the Tailwind rung `index.css` maps it to;
 *   · the pre-paint theme script resolves the four cases it claims;
 *   · no public page shows the old product name.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  HERO_FACTS, RADII, REPO_URL, THEME_BLOCKS, THEME_BOOT, mark, markDocument, publicPage,
  MARK_IDS, KINU_MARK,
  type Mode, type Palette,
} from '../src/lib/public-shell';
import {
  approvalDocument, authDocument, installDocument, landingDocument, loginDocument,
} from '../src/lib/public-pages';
import { heroSearch } from '../src/lib/hero-search';

const INDEX_CSS = readFileSync(resolve(import.meta.dir, '../src/index.css'), 'utf8');

/** The palette blocks that apply to each theme, in source order. Same model as
 *  `unit-palette-contrast`: every block carries specificity (0,1,0) or higher
 *  and later declarations win, so a selector list in source order replays the
 *  cascade faithfully. */
const CASCADE = {
  'umber dark': [':root'],
  'umber light': [':root', '[data-mode="light"]'],
  'silk dark': [':root', '[data-palette="silk"]'],
  'silk light': [':root', '[data-mode="light"]', '[data-palette="silk"]', '[data-palette="silk"][data-mode="light"]'],
} satisfies Readonly<Record<string, readonly string[]>>;


/** One block of `index.css`, as name → value. Anchored at line start so
 *  `[data-palette="silk"]` cannot match the compound selector or a mention of
 *  itself inside a comment. */
function block(selector: string) {
  const at = INDEX_CSS.search(new RegExp(`^${selector.replace(/[[\]"().*+?^${}|\\]/g, '\\$&')}\\s*\\{`, 'm'));
  if (at === -1) throw new Error(`no ${selector} block in index.css`);
  const open = INDEX_CSS.indexOf('{', at);
  let depth = 0;
  let i = open;
  for (; i < INDEX_CSS.length; i++) {
    if (INDEX_CSS[i] === '{') depth++;
    else if (INDEX_CSS[i] === '}' && --depth === 0) break;
  }
  return Object.fromEntries(
    [...INDEX_CSS.slice(open, i).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]),
  );
}

/** The tokens `index.css` leaves standing for one theme. An unknown theme name
 *  is a test that would silently measure nothing, so it throws. */
function resolved(theme: string) {
  const selectors = Object.entries(CASCADE).find(([name]) => name === theme)?.[1];
  if (selectors === undefined) throw new Error(`no cascade modelled for ${theme}`);
  const out: Record<string, string> = {};
  for (const selector of selectors) Object.assign(out, block(selector));
  return out;
}

const NAMED = (palette: Palette, mode: Mode) => `${palette} ${mode}`;

const FONT_PATH = '/assets/fonts/fraunces-latin-var.woff2';

describe('public shell tokens are the app palette', () => {
  test('all four themes are projected', () => {
    const projected: string[] = THEME_BLOCKS.map((b) => NAMED(b.palette, b.mode));
    expect(projected.sort()).toEqual(Object.keys(CASCADE).sort());
  });

  for (const { palette, mode, tokens, selector } of THEME_BLOCKS) {
    test(`${NAMED(palette, mode)} matches index.css`, () => {
      const app = resolved(NAMED(palette, mode));
      for (const [token, value] of Object.entries(tokens)) {
        expect(app[token], `${token} in ${selector}`).toBe(value);
      }
    });
  }

  test('every projected token is declared in every theme', () => {
    // A token the projection carries but a palette block never declares would
    // resolve to whichever theme declared it last — the failure mode
    // `index.css` states its own completeness rule against.
    // SAFETY: `Object.keys` over the closed CASCADE literal, narrowed to its
    // own key union.
    const names = Object.keys(THEME_BLOCKS[0]!.tokens);
    for (const theme of Object.keys(CASCADE)) {
      const app = resolved(theme);
      for (const token of names) expect(app[token], `${token} in ${theme}`).toBeString();
    }
  });

  test('radius roles are the rungs index.css maps them to', () => {
    const theme = block('@theme');
    const rung = {
      '--r-control': '--radius-sm',
      '--r-row': '--radius-md',
      '--r-card': '--radius-lg',
      '--r-overlay': '--radius-xl',
    } satisfies Readonly<Record<keyof typeof RADII, string>>;
    // SAFETY: `Object.keys` of a closed object literal, narrowed to its own
    // key union so the rung lookup below is checked.
    for (const role of Object.keys(RADII) as (keyof typeof RADII)[]) {
      const px = RADII[role];
      // SAFETY: `Object.keys` of a closed literal, narrowed back to its own key
      // union so the rung lookup below is checked rather than indexed by string.
      const rem = theme[rung[role]];
      expect(rem, `${role} → ${rung[role]}`).toBeString();
      const value = Number(rem!.replace(/rem.*$/, '').trim());
      expect(`${value * 16}px`, `${role} resolves through ${rung[role]}`).toBe(px);
    }
  });

  test('the display face is one stack, shared with the app', () => {
    // The signed-out pages and the app must speak in the same voice. Two
    // stacks would diverge on the first platform where one has a face the
    // other does not.
    const app = block(':root')['--font-display'];
    expect(app).toBeString();
    expect(publicPage({ title: 't', body: '' })).toContain(`--font-display:${app!.replaceAll(', ', ',')}`);
  });

  test('the display face leads with the shipped webfont in both stylesheets', () => {
    // The face itself, not just the stack string: the app declares the
    // @font-face over the same asset path the shell inlines, and the shell
    // preloads it. A path that drifts between the two is a landing page in
    // the fallback face — exactly the drift this file exists to prevent.
    expect(block(':root')['--font-display']).toStartWith('"Fraunces"');
    expect(INDEX_CSS).toContain('src: url("/assets/fonts/fraunces-latin-var.woff2") format("woff2-variations")');
    const page = publicPage({ title: 't', body: '' });
    expect(page).toContain('@font-face{font-family:"Fraunces"');
    expect(page).toContain('url("/assets/fonts/fraunces-latin-var.woff2") format("woff2-variations")');
    expect(page).toContain('font-display:swap');
    expect(page).toContain('<link rel="preload" href="/assets/fonts/fraunces-latin-var.woff2" as="font" type="font/woff2" crossorigin />');
  });

  test('the webfont is the latin variable subset, inside its byte budget', () => {
    // 67,304 B today ([opsz,wght] latin). The budget refuses the full-axes
    // build (121 KB) and any unsubset swap; the licence must travel with the
    // file because OFL requires it.
    const file = resolve(import.meta.dir, '../public', '.' + FONT_PATH);
    const bytes = readFileSync(file);
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('wOF2');
    expect(bytes.byteLength).toBeLessThanOrEqual(70_000);
    expect(readFileSync(resolve(file, '../OFL.txt'), 'utf8')).toContain('SIL Open Font License');
  });

  test('the landing page weight stays inside its envelope', () => {
    // What a first visit downloads before images: the document (gzipped, as
    // served) plus the display font. 93 KB today; the envelope catches an
    // unbounded regression while leaving room for the landing's inline
    // demos to grow deliberately.
    const html = landingDocument("curl -fsSL 'https://kinu.run/install.sh' | bash");
    const gz = Bun.gzipSync(new TextEncoder().encode(html)).byteLength;
    const font = readFileSync(resolve(import.meta.dir, '../public', '.' + FONT_PATH)).byteLength;
    expect(gz + font).toBeLessThanOrEqual(128 * 1024);
  });
});

describe('the pre-paint theme script', () => {
  /** Run the shipped snippet against stubbed storage and report what it set. */
  function boot(stored: Record<string, string>, prefersLight: boolean) {

    const attrs: Record<string, string> = {};
    const root = { attrs, style: { colorScheme: '' } };
    const scope = {
      document: {
        documentElement: {
          setAttribute: (name: string, value: string) => { root.attrs[name] = value; },
          style: root.style,
        },
      },
      localStorage: { getItem: (key: string) => stored[key] ?? null },
      window: { matchMedia: (query: string) => ({ matches: query.includes('light') && prefersLight }) },
    };
    // The snippet is an IIFE over three globals, which is why it can be checked
    // by call rather than by reading it.
    // SAFETY: the snippet is this repo's own text, evaluated against the three
    // stub globals declared immediately above.
    new Function('document', 'localStorage', 'window', THEME_BOOT)(scope.document, scope.localStorage, scope.window);
    return { mode: root.attrs['data-mode'], palette: root.attrs['data-palette'], colorScheme: root.style.colorScheme };
  }

  test('silk is the public default, not umber', () => {
    expect(boot({}, false)).toEqual({ mode: 'dark', palette: 'silk', colorScheme: 'dark' });
  });

  test('the system preference decides the mode when nothing is stored', () => {
    expect(boot({}, true).mode).toBe('light');
  });

  test("a returning user's stored choice wins over the system preference", () => {
    expect(boot({ theme: 'dark' }, true).mode).toBe('dark');
    expect(boot({ theme: 'light' }, false).mode).toBe('light');
    expect(boot({ palette: 'umber' }, false).palette).toBe('umber');
  });

  test('a junk stored value falls back rather than shipping an unknown attribute', () => {
    expect(boot({ theme: 'sepia', palette: 'neon' }, false)).toEqual({
      mode: 'dark', palette: 'silk', colorScheme: 'dark',
    });
  });
});

/** Every public document, with the arguments its route passes. */
const DOCUMENTS = {
  landing: landingDocument("curl -fsSL 'https://kinu.run/install.sh' | bash"),
  login: loginDocument([{ href: '/auth/github/start', label: 'GitHub' }], ' And a trailing line.'),
  authFailure: authDocument('Sign in failed', '<p class="lede">Try again.</p>'),
  install: installDocument("curl -fsSL 'https://kinu.run/install.sh' | bash"),
  approval: approvalDocument('Connect the Kinu CLI', '<p>A terminal asked to sign in.</p>'),
} satisfies Readonly<Record<string, string>>;

/** What a reader sees: no scripts, no styles, no attributes. */
function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
}

describe('public copy', () => {
  for (const [name, html] of Object.entries(DOCUMENTS)) {
    test(`${name} shows no trace of the old product name`, () => {
      expect(visibleText(html).toLowerCase()).not.toContain('proteus');
    });

    test(`${name} carries the old name in the repository URL and nowhere else`, () => {
      // The GitHub repository has not been renamed yet, and that URL is the one
      // place the old name may survive. `REPO_URL` in `public-shell.ts` is the
      // single line that changes when it is.
      const rest = html.replaceAll(REPO_URL, '');
      expect(rest.toLowerCase()).not.toContain('proteus');
    });

    test(`${name} names the product Kinu.run`, () => {
      expect(html).toContain('Kinu.run');
    });

    test(`${name} pins the theme before it paints`, () => {
      // The boot script must precede the stylesheet, or the first frame is the
      // wrong palette and the page flashes.
      expect(html.indexOf('data-mode')).toBeLessThan(html.indexOf('<style>'));
      expect(html).toContain('<link rel="icon" type="image/svg+xml" href="/assets/kinu-icon.svg" />');
    });

    test(`${name} sets a lang and a viewport`, () => {
      expect(html).toContain('<html lang="en">');
      expect(html).toContain('width=device-width, initial-scale=1');
    });
  }

  test('the front page quotes the search it actually draws', () => {
    const search = heroSearch();
    expect(HERO_FACTS.nodes).toBe(search.nodes.length);
    expect(HERO_FACTS.depth).toBe(search.depth);
    expect(HERO_FACTS.rollouts).toBe(search.beats);
    expect(HERO_FACTS.abandoned).toBe(search.nodes.filter((node) => node.status === 'pruned').length);
    const html = DOCUMENTS.landing;
    expect(html).toContain(`${HERO_FACTS.rollouts} rollouts · depth ${HERO_FACTS.depth}`);
    expect(html).toContain(`${HERO_FACTS.abandoned} branches abandoned`);
    // The picture has to hold every node the caption's numbers came from.
    expect(html.match(/class="n"/g)?.length).toBe(search.nodes.length);
  });

  test('no page reaches for a font, a script or an image it cannot serve', () => {
    // `publicHtmlHeaders` allows `'self'` and inline only. A remote font or
    // image URL renders as a missing asset in production and nowhere else.
    for (const [name, html] of Object.entries(DOCUMENTS)) {
      expect(html, name).not.toContain('https://fonts.');
      expect(html.match(/src="https?:\/\//g), name).toBeNull();
      expect(html.match(/@import/g), name).toBeNull();
    }
  });
});

describe('the mark', () => {
  test('every candidate is one path set on the same 24-unit grid', () => {
    for (const id of MARK_IDS) {
      const svg = mark(24, id);
      expect(svg, id).toContain('viewBox="0 0 24 24"');
      // `currentColor` is what lets one mark be the accent of four themes.
      expect(svg, id).toContain('currentColor');
      expect(svg, id).not.toContain('gradient');
    }
  });

  test('the shipping mark is one of the candidates', () => {
    expect(MARK_IDS).toContain(KINU_MARK);
  });

  test('the favicon declares its own colour, since it has no cascade', () => {
    const svg = markDocument();
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('color="#E3D2AE');
  });

  test('the favicon on disk is the mark this code renders', () => {
    const onDisk = readFileSync(resolve(import.meta.dir, '../public/assets/kinu-icon.svg'), 'utf8');
    expect(onDisk).toBe(markDocument());
  });

  /**
   * The README banners carry the shipped mark, not a copy of one.
   *
   * `docs/assets/banner*.svg` are hand-authored documents outside the bundle,
   * so the stroke in them is a LITERAL of the shipping mark's path data.
   * Nothing regenerates them and nothing read them, so changing which mark
   * ships moved the favicon, the four public pages and the app, and left the
   * banner at the top of the README drawing the previous one.
   *
   * The path DATA is what is asserted, not the whole element: the banners fill
   * with `var(--thread)` so their own two themes can colour the stroke, which
   * is a real difference from `currentColor` and the only one allowed.
   */
  test('both README banners draw the mark that ships', () => {
    const shipped = [...mark(24, KINU_MARK).matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]);
    expect(shipped, `${KINU_MARK} renders no path`).not.toBeEmpty();
    for (const file of ['banner.svg', 'banner-dark.svg']) {
      const svg = readFileSync(resolve(import.meta.dir, '../../../docs/assets', file), 'utf8');
      for (const d of shipped) expect(svg, `${file} is missing ${KINU_MARK}`).toContain(`<path d="${d}"`);
    }
  });
});

/**
 * The README film is the real app, held to the same honesty as the landing's.
 *
 * `docs/assets/kinu-film-readme.webp` is cut by `scripts/web-film.ts` from the
 * gallery's fixture transport. Nothing here can re-run that shoot, so the
 * gates hold the committed artefact to its three claims: it MOVES, every
 * frame marker is verbatim gallery fixture text (a fixture that moves breaks
 * this gate instead of silently restaging the film), and the pair of films
 * stays inside the media budget. The embed itself is checked for the width
 * and height that keep arrival from shifting the page.
 */
describe('the README film', () => {
  const FILM = readFileSync(resolve(import.meta.dir, '../../../docs/assets/kinu-film-readme.webp'));
  const LANDING_FILM = readFileSync(resolve(import.meta.dir, '../public/assets/kinu-film-web.webp'));
  // The text the mounted app renders: the gallery fixtures, plus the pages
  // and surfaces a frame mounts whole.
  const GALLERY = [
    '../src/gallery.tsx', '../src/pages/HomePage.tsx', '../src/pages/MCTSExplorer.tsx',
    '../src/components/surfaces/WorkTab.tsx',
  ].map((file) => readFileSync(resolve(import.meta.dir, file), 'utf8')).join('\n');
  const SHOOT = readFileSync(resolve(import.meta.dir, '../../../scripts/web-film.ts'), 'utf8');
  const README = readFileSync(resolve(import.meta.dir, '../../../README.md'), 'utf8');

  test('it is an animation, not a poster', () => {
    expect(FILM.includes('ANIM'), 'no animation header').toBeTrue();
    let frames = 0;
    for (let at = FILM.indexOf('ANMF'); at !== -1; at = FILM.indexOf('ANMF', at + 4)) frames += 1;
    expect(frames, 'a film of one frame is a poster').toBeGreaterThan(1);
  });

  test('every frame marker is fixture text the app renders', () => {
    const markers = [...SHOOT.matchAll(/settled: '([^']+)'/g)].map((m) => m[1]);
    expect(markers.length, 'the shoot declares no markers').toBeGreaterThan(0);
    for (const marker of markers) {
      expect(GALLERY, `not fixture text the app renders: ${marker.slice(0, 60)}`).toContain(marker);
    }
  });

  test('both films hold the weight budget', () => {
    expect(FILM.byteLength + LANDING_FILM.byteLength, 'combined film assets over 2.5 MB').toBeLessThan(2_500_000);
  });

  test('the README carries it under the banner, sized against layout shift', () => {
    const embed = /<img alt="[^"]+" src="docs\/assets\/kinu-film-readme\.webp" width="\d+" height="\d+">/.exec(README);
    expect(embed, 'the film is not embedded with explicit dimensions').not.toBeNull();
    // Position, not just presence: the film sits under the banner, before the
    // tagline block.
    expect(README.indexOf('kinu-film-readme.webp'))
      .toBeLessThan(README.indexOf('A self-evolving agent platform'));
  });
});

