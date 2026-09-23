/**
 * Defends: the signed-out pages (self-contained, no `index.css`) shipping a broken stylesheet, pre-paint
 * theme or Kinu identity. Whether their palette and radii match the app's is asked of Chromium in
 * scripts/public-shell-palette-ux.test.ts.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  mark, markDocument, publicPage, MARK_IDS, KINU_MARK,
} from '@kinu.run/core';
import {
  approvalDocument, authDocument, installDocument, loginDocument,
} from '@kinu.run/core';
import { MOVIE_CUES, MOVIE_END } from '@kinu.run/core';
import {
  CURSOR_ENTER_AT,
  composerTextAt, cueCountAt, cursorAt, discreteAt,
} from '../src/components/landing/landing-movie-timeline';

/** Reads the shipped bytes, not the module's internals. */
function shippedStyle(): string {
  const page = publicPage({ title: 't', body: '' });
  const start = page.indexOf('<style>');
  const end = page.indexOf('</style>');

  if (start === -1 || end === -1 || end < start) throw new Error('public page carries no stylesheet');

  return page.slice(start + '<style>'.length, end);
}

describe('the shell stylesheet', () => {
  const style = shippedStyle();

  test('both themes are projected before the shell', () => {
    const rootAt = style.indexOf(':root{');
    const lightAt = style.indexOf('[data-mode="light"]{');
    const shellAt = style.indexOf('@font-face');
    expect(rootAt).toBeGreaterThanOrEqual(0);
    expect(lightAt).toBeGreaterThan(rootAt);
    // The projection precedes the shell it themes.
    expect(shellAt).toBeGreaterThan(lightAt);
  });

  test('both faces lead with the shipped webfonts, preloaded', () => {
    // The app's faces match these files in Chromium: scripts/public-shell-palette-ux.test.ts.
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
    ['Schibsted Grotesk', 50_000],
    ['Fragment Mono', 30_000],
  ])('%s is a real woff2 latin subset inside its byte budget', (family, budget) => {
    // 46,752 B Schibsted [wght] latin, 25,224 B Fragment Mono latin; refuses full-axes or
    // unsubset builds. OFL requires the licence travel with the files.
    const page = publicPage({ title: 't', body: '' });
    const face = new RegExp(`@font-face\\{font-family:"${family}";src:url\\("([^"]+)"\\)`).exec(page);

    if (face?.[1] === undefined) throw new Error(`no @font-face for ${family} in the shell`);
    const file = resolve(import.meta.dir, '../public', `.${face[1]}`);
    const bytes = readFileSync(file);
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('wOF2');
    expect(bytes.byteLength).toBeLessThanOrEqual(budget);
    expect(readFileSync(resolve(file, '../OFL.txt'), 'utf8')).toContain('SIL Open Font License');
  });

  test('Newsreader stays out of the standalone shell', () => {
    expect(publicPage({ title: 't', body: '' })).not.toContain('Newsreader');
  });

});

describe('the pre-paint theme script', () => {
  function shippedBoot(): string {
    const page = publicPage({ title: 't', body: '' });
    const match = /<script>([\s\S]*?)<\/script>/.exec(page);
    const text = match?.[1];

    if (text === undefined || !text.includes('data-mode')) {
      throw new Error('public page carries no theme boot script');
    }

    return text;
  }

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

const DOCUMENTS = {
  login: loginDocument([{ href: '/auth/github/start', label: 'GitHub' }]),
  authFailure: authDocument('Sign in failed', '<p class="lede">Try again.</p>'),
  install: installDocument("curl -fsSL 'https://kinu.run/install.sh' | bash"),
  approval: approvalDocument('Connect the Kinu CLI', '<p>A terminal asked to sign in.</p>'),
} satisfies Readonly<Record<string, string>>;

/** Assembled from parts so the tracked tree can be grepped for the retired name and come back empty. */
const RETIRED_NAME = ['prot', 'eus'].join('');

describe('public copy', () => {
  for (const [name, html] of Object.entries(DOCUMENTS)) {
    test(`${name} uses Kinu branding throughout the document`, () => {
      // URLs and attributes too: that is where a rename leaves survivors.
      expect(html.toLowerCase()).not.toContain(RETIRED_NAME);
    });

    test(`${name} names the product Kinu.run`, () => {
      expect(html).toContain('Kinu.run');
    });

    test(`${name} pins the theme before it paints`, () => {
      // Boot script before the stylesheet, or the first frame flashes the wrong palette.
      expect(html.indexOf('data-mode')).toBeLessThan(html.indexOf('<style>'));
      expect(html).toContain('<link rel="icon" type="image/svg+xml" href="/assets/kinu-icon.svg" />');
    });

    test(`${name} sets a lang and a viewport`, () => {
      expect(html).toContain('<html lang="en">');
      expect(html).toContain('width=device-width, initial-scale=1');
    });
  }

  test('no page reaches for a font, a script or an image it cannot serve', () => {
    // `publicHtmlHeaders` allows `'self'` and inline only; remote assets break in production alone.
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

  /** `docs/assets/banner*.svg` hand-copy the shipped mark's path data; only the fill (`var(--thread)`) may differ. */
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
 * README film: frame 0 covers the canvas, every frame stays inside it, and no frame uses disposal 2 or 3
 * (both paint unphotographed states). Frame 0 opacity is decoded in `scripts/plan-demo-film.test.ts`.
 */
describe('the README demo film', () => {
  const FILM = readFileSync(resolve(import.meta.dir, '../../../docs/assets/kinu-plan-demo.gif'));
  const README = readFileSync(resolve(import.meta.dir, '../../../README.md'), 'utf8');

  interface Frame {
    readonly x: number; readonly y: number;
    readonly width: number; readonly height: number;
    /** Disposal 2 blanks under the frame, 3 restores previous; the film must carry neither. */
    readonly disposal: number;
  }

  interface Film {
    readonly width: number; readonly height: number;
    readonly loops: number | null;
    readonly frames: readonly Frame[];
  }

  /** Bounded: `Buffer[at]` is undefined past the end, and undefined arithmetic can loop a skip forever. */
  function byteAt(gif: Buffer, at: number, what: string): number {
    if (at < 0 || at >= gif.byteLength) {
      throw new Error(`the film ends mid-${what} at ${String(at)}`);
    }

    return gif.readUInt8(at);
  }

  interface TakenBlock { readonly body: Buffer; readonly next: number }

  function takeBlock(gif: Buffer, at: number, size: number, what: string): TakenBlock {
    if (at + size > gif.byteLength) {
      throw new Error(`the film ends mid-${what} at ${String(at)}`);
    }

    return { body: gif.subarray(at, at + size), next: at + size };
  }

  /** Every offset comes from the file's length fields and every read is bounded, so a malformed film throws. */
  function readFilm(gif: Buffer): Film {
    if (gif.byteLength < 13 || gif.subarray(0, 6).toString() !== 'GIF89a') {
      throw new Error('not a GIF89a film');
    }

    const width = gif.readUInt16LE(6);
    const height = gif.readUInt16LE(8);

    if (width <= 0 || height <= 0) {
      throw new Error(`the film declares a ${String(width)}x${String(height)} canvas`);
    }

    const packed = gif.readUInt8(10);
    const gctSize = (packed & 0x80) !== 0 ? 3 * (2 ** ((packed & 7) + 1)) : 0;

    if (13 + gctSize > gif.byteLength) throw new Error('the film ends mid-global colour table');

    let at = 13 + gctSize;
    let loops: number | null = null;
    const frames: Frame[] = [];
    // A GCE carries the NEXT image's disposal, so it is staged between descriptors.
    let gce = { disposal: 0 };

    const skipSubBlocks = (what: string): void => {
      for (;;) {
        const size = byteAt(gif, at, what);

        at += 1;

        if (size === 0) return;
        at = takeBlock(gif, at, size, what).next;
      }
    };

    const readApplicationExtension = (): void => {
      const size = byteAt(gif, at, 'application extension');
      const app = takeBlock(gif, at + 1, size, 'application extension');

      at = app.next;

      // NETSCAPE2.0's first sub-block is {1, lo, hi}: the loop count.
      if (size === 11 && app.body.toString() === 'NETSCAPE2.0'
        && byteAt(gif, at, 'loop sub-block') === 3) {
        const loopBlock = takeBlock(gif, at + 1, 3, 'loop sub-block');

        if (loopBlock.body.readUInt8(0) === 1) {
          loops = loopBlock.body.readUInt16LE(1);
        }

        at = loopBlock.next;
      }

      skipSubBlocks('application extension');
    };

    for (;;) {
      const tag = byteAt(gif, at, 'block stream');

      if (tag === 0x3b) {
        at += 1;

        return { width, height, loops, frames };
      }

      if (tag === 0x2c) {
        const descriptor = takeBlock(gif, at + 1, 9, 'image descriptor').body;
        const localPacked = descriptor.readUInt8(8);

        frames.push({
          x: descriptor.readUInt16LE(0), y: descriptor.readUInt16LE(2),
          width: descriptor.readUInt16LE(4), height: descriptor.readUInt16LE(6),
          ...gce,
        });
        gce = { disposal: 0 };
        at += 10;

        const lctSize = (localPacked & 0x80) !== 0 ? 3 * (2 ** ((localPacked & 7) + 1)) : 0;

        at = takeBlock(gif, at, lctSize, 'local colour table').next;
        at = takeBlock(gif, at, 1, 'LZW minimum code size').next;
        skipSubBlocks('image data');
      } else if (tag === 0x21) {
        const label = byteAt(gif, at + 1, 'extension label');

        at += 2;

        if (label === 0xf9) {
          const size = byteAt(gif, at, 'graphic-control extension');

          if (size !== 4) {
            throw new Error(`graphic-control extension declares ${String(size)} bytes, not 4`);
          }

          const body = takeBlock(gif, at + 1, 4, 'graphic-control extension').body;

          gce = { disposal: (body.readUInt8(0) >> 2) & 0x07 };
          at += 5;

          if (byteAt(gif, at, 'graphic-control terminator') !== 0) {
            throw new Error('graphic-control extension is not zero-terminated');
          }

          at += 1;
        } else if (label === 0xff) {
          readApplicationExtension();
        } else {
          skipSubBlocks('extension');
        }
      } else {
        throw new Error(`unparseable GIF block 0x${tag.toString(16)} at ${String(at)}`);
      }
    }
  }

  function selfContained(film: Film): string[] {
    const problems: string[] = [];
    const [base] = film.frames;

    if (base === undefined
      || base.x !== 0 || base.y !== 0 || base.width !== film.width || base.height !== film.height) {
      problems.push('the first frame must paint the whole canvas, or frame one shows through');
    }

    if (film.frames.some((frame) => frame.disposal === 2 || frame.disposal === 3)) {
      problems.push('a restore disposal rewrites pixels the frame does not carry');
    }

    if (film.frames.some((f) => f.x < 0 || f.y < 0 || f.x + f.width > film.width || f.y + f.height > film.height)) {
      problems.push('a frame paints outside the canvas');
    }

    return problems;
  }

  const film = readFilm(FILM);

  test('the film is an animated GIF that loops forever', () => {
    expect(film.frames.length, 'a film needs more than one frame').toBeGreaterThan(1);
    expect(film.loops, 'the film stops instead of looping').toBe(0);
    expect(FILM.byteLength, 'the README film exceeds 2.5 MB').toBeLessThan(2_500_000);
  });

  test('no frame can smear the one before it', () => {
    expect(selfContained(film)).toEqual([]);
  });

  test('the README reserves the film layout and shows it before the install steps', () => {
    expect(README).toContain(
      `src="docs/assets/kinu-plan-demo.gif" width="${String(film.width)}" height="${String(film.height)}">`,
    );
    expect(README).toMatch(/<img alt="[^"]+" src="docs\/assets\/kinu-plan-demo\.gif"/);
    expect(README.indexOf('kinu-plan-demo.gif'))
      .toBeLessThan(README.indexOf('## Using it'));
  });

  /** Minimal GIF89a frames on a 2x2 canvas with a two-colour palette. */
  function fixtureGif(
    ...frames: { gce?: { transparent?: boolean; disposal?: number }; x?: number; y?: number; w?: number; h?: number }[]
  ): Buffer {
    const head = Buffer.from([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // GIF89a
      0x02, 0x00, 0x02, 0x00, // 2x2 canvas
      0x80, 0x00, 0x00, // GCT flag, no sort, 2 colours
      0x00, 0x00, 0x00, 0xff, 0xff, 0xff, // palette
    ]);

    const parts = frames.map((frame) => Buffer.concat([
      frame.gce === undefined ? Buffer.alloc(0) : Buffer.from([
        0x21, 0xf9, 0x04,
        ((frame.gce.disposal ?? 0) << 2) | (frame.gce.transparent === true ? 1 : 0),
        0x0a, 0x00, // 10cs delay
        0x00, // transparent index
        0x00,
      ]),
      Buffer.from([
        0x2c,
        frame.x ?? 0, 0x00, frame.y ?? 0, 0x00, // left, top
        frame.w ?? 2, 0x00, frame.h ?? 2, 0x00, // width, height
        0x00, // no local table
        0x02, 0x02, 0x44, 0x01, 0x00, // LZW stream
      ]),
    ]));

    return Buffer.concat([head, ...parts, Buffer.from([0x3b])]);
  }

  test('the parser throws promptly on truncated, untrailered, or malformed input', () => {
    const good = fixtureGif({});
    const truncated = good.subarray(0, good.byteLength - 4); // mid image data
    const untrailered = good.subarray(0, good.byteLength - 1); // no 0x3b
    // GCE size byte sits at offset 21 in a fixture that carries one.
    const badGce = Buffer.from(fixtureGif({ gce: {} }));
    badGce[21] = 0x05;

    expect(() => readFilm(good), 'a well-formed fixture must parse').not.toThrow();
    expect(() => readFilm(truncated), 'a truncated sub-block must throw, not hang').toThrow('ends mid-');
    expect(() => readFilm(untrailered), 'a missing trailer must throw').toThrow('mid-block stream');
    expect(() => readFilm(badGce), 'a malformed GCE must throw').toThrow('graphic-control');
  });

  test('the self-consistency invariant fails restore disposals and out-of-canvas frames', () => {
    const restoring = readFilm(fixtureGif({}, { gce: { disposal: 3 } }));
    expect(selfContained(restoring)).toEqual([
      'a restore disposal rewrites pixels the frame does not carry',
    ]);

    const blanking = readFilm(fixtureGif({}, { gce: { disposal: 2 } }));
    expect(selfContained(blanking)).toEqual([
      'a restore disposal rewrites pixels the frame does not carry',
    ]);

    const croppedBase = readFilm(fixtureGif({ x: 1, y: 0, w: 1, h: 2 }));
    expect(selfContained(croppedBase)).toEqual([
      'the first frame must paint the whole canvas, or frame one shows through',
    ]);

    const escaping = readFilm(fixtureGif({}, { x: 1, y: 0, w: 2, h: 2 }));
    expect(selfContained(escaping)).toEqual([
      'a frame paints outside the canvas',
    ]);
  });
});

/** Pins the walkthrough's order in `landing-movie-timeline.ts`: typing, tools, plan, approval, slate. */
describe('the landing walkthrough timeline', () => {
  test('cues run in story order and the cursor enters mid-investigation', () => {
    const order = [
      'typeStart', 'sent', 'reasoning', 'readStart', 'readDone', 'searchStart',
      'searchDone', 'submitted', 'planReady', 'approve', 'approvedText',
      'manifestStart', 'manifestDone', 'serverStart', 'serverDone', 'clientStart',
      'clientDone', 'previewStart', 'previewDone', 'slateOpen', 'finalText', 'end',
    ] as const;

    const times = order.map((cue) => MOVIE_CUES[cue]);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(MOVIE_END).toBe(MOVIE_CUES.end);
    expect(CURSOR_ENTER_AT).toBe(4_700);
    expect(MOVIE_CUES.sent).toBeLessThan(MOVIE_CUES.reasoning);
    expect(MOVIE_CUES.searchDone).toBeLessThan(MOVIE_CUES.submitted);
    expect(MOVIE_CUES.submitted).toBeLessThan(MOVIE_CUES.planReady);
    expect(MOVIE_CUES.planReady).toBeLessThan(MOVIE_CUES.approve);
    expect(MOVIE_CUES.approve).toBeLessThan(MOVIE_CUES.previewDone);
    expect(MOVIE_CUES.previewDone).toBeLessThan(MOVIE_CUES.slateOpen);
  });

  test('cueCountAt counts fired cues and nothing else', () => {
    expect(cueCountAt(0)).toBe(0);
    expect(cueCountAt(MOVIE_CUES.typeStart - 1)).toBe(0);
    expect(cueCountAt(MOVIE_CUES.typeStart)).toBe(1);
    expect(cueCountAt(MOVIE_END)).toBe(Object.keys(MOVIE_CUES).length);
  });

  test('the composer types the request, then clears on send', () => {
    expect(composerTextAt(0)).toBe('');
    // Asserted through the function: typing grows toward the request, incomplete partway.
    const full = composerTextAt(MOVIE_CUES.sent - 1);
    const mid = composerTextAt((MOVIE_CUES.typeStart + MOVIE_CUES.sent) / 2);
    expect(mid.length).toBeGreaterThan(0);
    expect(full.startsWith(mid)).toBeTrue();
    expect(mid.length).toBeLessThan(full.length);
    expect(composerTextAt(MOVIE_CUES.sent)).toBe('');
    expect(composerTextAt(MOVIE_END)).toBe('');
  });

  test('the cursor rests before it enters and after it settles', () => {
    expect(cursorAt(0).visible).toBeFalse();
    expect(cursorAt(CURSOR_ENTER_AT - 1).visible).toBeFalse();
    expect(cursorAt(MOVIE_END).visible).toBeFalse();
    const atApprove = cursorAt(MOVIE_CUES.approve + 1);
    expect(atApprove.visible).toBeTrue();
    expect(atApprove.pressed).toBe('approve');
    expect(atApprove.ripple).not.toBeNull();
  });

  test('the story starts empty: no transcript, no plan, no slate', () => {
    const start = discreteAt(0);
    expect(start.messages).toBeEmpty();
    expect(start.plan).toBeNull();
    expect(start.slates).toBeEmpty();
    expect(start.surface).toBe('Work');
    expect(start.settled).toBeFalse();
  });

  test('tool calls stream before the plan exists', () => {
    const tools = discreteAt(MOVIE_CUES.searchDone);
    expect(tools.plan).toBeNull();
    const parts = tools.messages.flatMap((message) => message.parts);
    expect(parts.some((part) => part.type === 'tool-file')).toBeTrue();
    expect(discreteAt(MOVIE_CUES.planReady - 1).plan).toBeNull();
  });

  test('the plan pops up pending and clean, so Approve is the live decision', () => {
    const ready = discreteAt(MOVIE_CUES.planReady);
    expect(ready.plan?.status).toBe('pending');
    expect(ready.plan?.annotations).toBeEmpty();
    expect(ready.surface).toBe('Work');
  });

  test('the approval beat precedes the slate, and the slate opens its own tab', () => {
    expect(MOVIE_CUES.approve).toBeLessThan(MOVIE_CUES.slateOpen);
    const building = discreteAt(MOVIE_CUES.serverDone);
    expect(building.messages.flatMap((message) => message.parts)
      .some((part) => part.type === 'tool-file')).toBeTrue();
    const open = discreteAt(MOVIE_CUES.slateOpen);
    expect(open.surface).toBe('slate:support-queue');
    expect(open.slates.map((slate) => slate.id)).toEqual(['support-queue']);
    const end = discreteAt(MOVIE_END);
    expect(end.settled).toBeTrue();
    expect(end.messages.flatMap((message) => message.parts).length).toBeGreaterThan(0);
  });
});
