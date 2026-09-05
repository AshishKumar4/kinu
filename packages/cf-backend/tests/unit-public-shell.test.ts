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
 *   · no public page shows the old product name, anywhere in the document.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  mark, markDocument, publicPage, MARK_IDS, KINU_MARK,
} from '../src/lib/public-shell';
import {
  approvalDocument, authDocument, installDocument, loginDocument,
} from '../src/lib/public-pages';
const INDEX_CSS = readFileSync(resolve(import.meta.dir, '../src/index.css'), 'utf8');

/** The palette blocks that apply to each theme, in source order. Same model as
 *  `unit-palette-contrast`: every block carries specificity (0,1,0) or higher
 *  and later declarations win, so a selector list in source order replays the
 *  cascade faithfully. */
const CASCADE = {
  'dark': [':root'],
  'light': [':root', '[data-mode="light"]'],
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


/** The stylesheet the shell ships, as the document carries it. The parity
 *  below reads the projection out of this text rather than out of the
 *  module's internals, so it holds the shipped bytes to the app. */
function shippedStyle(): string {
  const page = publicPage({ title: 't', body: '' });
  const start = page.indexOf('<style>');
  const end = page.indexOf('</style>');
  if (start === -1 || end === -1 || end < start) throw new Error('public page carries no stylesheet');
  return page.slice(start + '<style>'.length, end);
}

/** One `selector{...}` rule of the shipped stylesheet, as name → value. */
function shippedBlock(style: string, selector: string) {
  const at = style.indexOf(`${selector}{`);
  if (at === -1) throw new Error(`shipped stylesheet carries no ${selector} block`);
  const open = style.indexOf('{', at);
  let depth = 0;
  let i = open;
  for (; i < style.length; i++) {
    if (style[i] === '{') depth++;
    else if (style[i] === '}' && --depth === 0) break;
  }
  return Object.fromEntries(
    style.slice(open + 1, i).split(';').flatMap((entry) => {
      const colon = entry.indexOf(':');
      if (colon === -1) return [];
      const name = entry.slice(0, colon).trim();
      return name.startsWith('--') ? [[name, entry.slice(colon + 1).trim()]] : [];
    }),
  );
}

const UI_FONT_PATH = '/assets/fonts/schibsted-latin-var.woff2';
const MONO_FONT_PATH = '/assets/fonts/fragmentmono-latin.woff2';

describe('public shell tokens are the app palette', () => {
  const style = shippedStyle();

  test('both themes are projected before the shell', () => {
    const rootAt = style.indexOf(':root{');
    const lightAt = style.indexOf('[data-mode="light"]{');
    const shellAt = style.indexOf('@font-face');
    expect(rootAt).toBeGreaterThanOrEqual(0);
    expect(lightAt).toBeGreaterThan(rootAt);
    // The projection precedes the shell it themes, so a theme edit cannot
    // hide under it.
    expect(shellAt).toBeGreaterThan(lightAt);
  });

  for (const [mode, selectors] of Object.entries(CASCADE)) {
    test(`${mode} matches index.css`, () => {
      const app = resolved(mode);
      const selector = selectors.at(-1);
      if (selector === undefined) throw new Error(`no block modelled for ${mode}`);
      const emitted = shippedBlock(style, selector);
      for (const [token, value] of Object.entries(emitted)) {
        if (token.startsWith('--r-')) continue;
        expect(app[token], `${token} in ${selector}`).toBe(value);
      }
    });
  }

  test('every projected token is declared in every theme', () => {
    // A token the projection carries but a palette block never declares would
    // resolve to whichever theme declared it last — the failure mode
    // `index.css` states its own completeness rule against.
    const names = Object.keys(shippedBlock(style, ':root')).filter((name) => !name.startsWith('--r-'));
    for (const theme of Object.keys(CASCADE)) {
      const app = resolved(theme);
      for (const token of names) expect(app[token], `${token} in ${theme}`).toBeString();
    }
  });

  test('radius roles match what index.css resolves', () => {
    // control and row alias Tailwind rungs on purpose (a `.p-*` class and a
    // `rounded-*` utility written beside one cannot disagree); card and
    // overlay are the mock's own 14px literals. Resolve each the way the
    // browser would.
    const root = block(':root');
    const rungs = block('@theme');
    const shipped = shippedBlock(style, ':root');
    const remToPx = (rem: string) => `${Number(rem.replace(/rem.*$/, '').trim()) * 16}px`;
    for (const [role, rung] of [['--r-control', '--radius-sm'], ['--r-row', '--radius-md']] as const) {
      const rungValue = rungs[rung];
      if (rungValue === undefined) throw new Error(`no ${rung} rung in index.css`);
      expect(shipped[role], `${role} resolves through ${rung}`).toBe(remToPx(rungValue));
    }
    for (const role of ['--r-card', '--r-overlay'] as const) {
      const rootValue = root[role];
      if (rootValue === undefined) throw new Error(`no ${role} role in index.css`);
      expect(shipped[role], `${role} is its own literal`).toBe(remToPx(rootValue));
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

  test('both faces lead with the shipped webfonts in both stylesheets', () => {
    // The faces themselves, not just the stack strings: the app declares the
    // @font-face over the same asset paths the shell inlines, and the shell
    // preloads them. A path that drifts between the two is a landing page in
    // the fallback face — exactly the drift this file exists to prevent.
    expect(block(':root')['--font-display']).toStartWith('"Schibsted Grotesk"');
    expect(block(':root')['--font-mono']).toStartWith('"Fragment Mono"');
    expect(INDEX_CSS).toContain('src: url("/assets/fonts/schibsted-latin-var.woff2") format("woff2-variations")');
    expect(INDEX_CSS).toContain('src: url("/assets/fonts/fragmentmono-latin.woff2") format("woff2")');
    const page = publicPage({ title: 't', body: '' });
    expect(page).toContain('@font-face{font-family:"Schibsted Grotesk"');
    expect(page).toContain('@font-face{font-family:"Fragment Mono"');
    expect(page).toContain('url("/assets/fonts/schibsted-latin-var.woff2") format("woff2-variations")');
    expect(page).toContain('url("/assets/fonts/fragmentmono-latin.woff2") format("woff2")');
    expect(page).toContain('font-display:swap');
    expect(page).toContain('<link rel="preload" href="/assets/fonts/schibsted-latin-var.woff2" as="font" type="font/woff2" crossorigin />');
    expect(page).toContain('<link rel="preload" href="/assets/fonts/fragmentmono-latin.woff2" as="font" type="font/woff2" crossorigin />');
  });

  test.each([
    [UI_FONT_PATH, 50_000],
    [MONO_FONT_PATH, 30_000],
  ])('%s is a real woff2 latin subset inside its byte budget', (path, budget) => {
    // 46,752 B Schibsted [wght] latin, 25,224 B Fragment Mono latin. The
    // budgets refuse the full-axes builds and any unsubset swap; the licence
    // must travel with the files because OFL requires it.
    const file = resolve(import.meta.dir, '../public', '.' + path);
    const bytes = readFileSync(file);
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('wOF2');
    expect(bytes.byteLength).toBeLessThanOrEqual(budget);
    expect(readFileSync(resolve(file, '../OFL.txt'), 'utf8')).toContain('SIL Open Font License');
  });

  test('Newsreader stays in the React bundle rather than the standalone shell', () => {
    // Landing and the app share the Kinu wordmark through the React stylesheet.
    // Login/install pages remain small standalone documents.
    expect(publicPage({ title: 't', body: '' })).not.toContain('Newsreader');
    expect(INDEX_CSS).toContain('/assets/fonts/newsreader-latin-var.woff2');
  });

});


describe('the pre-paint theme script', () => {
  /** The pre-paint script the document ships, as the document carries it. */
  function shippedBoot(): string {
    const page = publicPage({ title: 't', body: '' });
    const match = /<script>([\s\S]*?)<\/script>/.exec(page);
    const text = match?.[1];
    if (text === undefined || !text.includes('data-mode')) {
      throw new Error('public page carries no theme boot script');
    }
    return text;
  }

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
    new Function('document', 'localStorage', 'window', shippedBoot())(scope.document, scope.localStorage, scope.window);
    return { mode: root.attrs['data-mode'], colorScheme: root.style.colorScheme };
  }

  test('dark is the public default', () => {
    expect(boot({}, false)).toEqual({ mode: 'dark', colorScheme: 'dark' });
  });

  test('the system preference decides the mode when nothing is stored', () => {
    expect(boot({}, true).mode).toBe('light');
  });

  test("a returning user's stored choice wins over the system preference", () => {
    expect(boot({ theme: 'dark' }, true).mode).toBe('dark');
    expect(boot({ theme: 'light' }, false).mode).toBe('light');
  });

  test('a junk stored value falls back rather than shipping an unknown attribute', () => {
    expect(boot({ theme: 'sepia' }, false)).toEqual({ mode: 'dark', colorScheme: 'dark' });
  });
});

/** Every public document, with the arguments its route passes. */
const DOCUMENTS = {
  login: loginDocument([{ href: '/auth/github/start', label: 'GitHub' }]),
  authFailure: authDocument('Sign in failed', '<p class="lede">Try again.</p>'),
  install: installDocument("curl -fsSL 'https://kinu.run/install.sh' | bash"),
  approval: approvalDocument('Connect the Kinu CLI', '<p>A terminal asked to sign in.</p>'),
} satisfies Readonly<Record<string, string>>;

/** The retired product name, assembled from parts so this file carries no
 *  literal copy of what it forbids — the gate below is the reason the tracked
 *  tree can be grepped for it and come back empty. */
const RETIRED_NAME = ['prot', 'eus'].join('');

describe('public copy', () => {
  for (const [name, html] of Object.entries(DOCUMENTS)) {
    test(`${name} shows no trace of the old product name`, () => {
      // Not only the visible text: the repository URL, the icon href and every
      // attribute are the places a rename leaves a survivor behind.
      expect(html.toLowerCase()).not.toContain(RETIRED_NAME);
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
    expect(svg).toContain('color="#E0A458');
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
 * The README opens on the bug-fix film.
 *
 * An animated WebP paints frame over frame, so its failure mode is a leak: a
 * frame that alpha-blends onto the canvas leaves every earlier state showing
 * through, which is how an earlier landing film shipped rendering the chat, the
 * approval card and the tree all at once. Two properties rule that out and both
 * are asserted here. The base frame paints the whole canvas, and every frame
 * OVERWRITES its rectangle rather than blending into it, so no earlier pixel can
 * survive under a later one. The third assertion is layout: the declared width
 * and height are the canvas's own, so the page reserves the space before the
 * bytes arrive and nothing below the film moves when it loads.
 */
describe('the README demo film', () => {
  const FILM = readFileSync(resolve(import.meta.dir, '../../../docs/assets/kinu-bugfix-demo.webp'));
  const README = readFileSync(resolve(import.meta.dir, '../../../README.md'), 'utf8');

  interface Frame {
    readonly x: number; readonly y: number;
    readonly width: number; readonly height: number;
    /** False when the frame overwrites its rectangle, which is what we require. */
    readonly blends: boolean;
  }
  interface Film {
    readonly width: number; readonly height: number;
    /** 0 is the WebP spelling of "loop forever". */
    readonly loops: number;
    readonly animated: boolean;
    readonly frames: readonly Frame[];
  }

  /** WebP writes its geometry as little-endian 24-bit fields. */
  function u24(buffer: Buffer, at: number): number {
    return buffer[at]! | (buffer[at + 1]! << 8) | (buffer[at + 2]! << 16);
  }

  function readFilm(webp: Buffer): Film {
    let width = 0, height = 0, loops = -1, animated = false;
    const frames: Frame[] = [];
    for (let at = 12; at + 8 <= webp.byteLength;) {
      const tag = webp.subarray(at, at + 4).toString();
      const size = webp.readUInt32LE(at + 4);
      const body = webp.subarray(at + 8, at + 8 + size);
      if (tag === 'VP8X') { width = u24(body, 4) + 1; height = u24(body, 7) + 1; }
      if (tag === 'ANIM') { animated = true; loops = body.readUInt16LE(4); }
      if (tag === 'ANMF') {
        frames.push({
          // The frame origin is stored halved, so the encoder can only place a
          // frame on an even pixel.
          x: u24(body, 0) * 2, y: u24(body, 3) * 2,
          width: u24(body, 6) + 1, height: u24(body, 9) + 1,
          // Flags bit 1: clear means alpha-blend onto the canvas, set means
          // overwrite it.
          blends: (body[15]! & 0x02) === 0,
        });
      }
      at += 8 + size + (size & 1);
    }
    return { width, height, loops, animated, frames };
  }

  const film = readFilm(FILM);

  test('the film is an animated WebP that loops forever', () => {
    expect(FILM.subarray(0, 4).toString(), 'no RIFF header').toBe('RIFF');
    expect(FILM.subarray(8, 12).toString(), 'not WebP').toBe('WEBP');
    expect(film.animated, 'the film carries no animation chunk').toBeTrue();
    expect(film.frames.length, 'a film needs more than one frame').toBeGreaterThan(1);
    expect(film.loops, 'the film stops instead of looping').toBe(0);
    expect(FILM.byteLength, 'the README film exceeds 2.5 MB').toBeLessThan(2_500_000);
  });

  test('no frame can smear the one before it', () => {
    const base = film.frames[0]!;
    expect(
      { x: base.x, y: base.y, width: base.width, height: base.height },
      'the first frame must paint the whole canvas, or frame one shows through',
    ).toEqual({ x: 0, y: 0, width: film.width, height: film.height });

    const blending = film.frames.filter((frame) => frame.blends).length;
    expect(blending, 'frames that alpha-blend composite every earlier state into the current one').toBe(0);

    const escaping = film.frames.filter((f) => f.x + f.width > film.width || f.y + f.height > film.height);
    expect(escaping, 'a frame paints outside the canvas').toBeEmpty();
  });

  test('the README reserves the film layout and shows it before the install steps', () => {
    expect(README).toContain(
      `src="docs/assets/kinu-bugfix-demo.webp" width="${String(film.width)}" height="${String(film.height)}">`,
    );
    expect(README).toMatch(/<img alt="[^"]+" src="docs\/assets\/kinu-bugfix-demo\.webp"/);
    // The install steps live under "Ways to use it" since the flagship
    // restructure; the invariant is unchanged — the film shows first.
    expect(README.indexOf('kinu-bugfix-demo.webp'))
      .toBeLessThan(README.indexOf('## Ways to use it'));
  });
});

