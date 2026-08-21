/**
 * The signed-out pages, measured in a browser.
 *
 * Everything the front page claims about itself is a rendered fact, and none of
 * it is visible to `tsc`, to `oxlint`, or to any test that reads the source:
 *
 *   - The hero tree grows. Growth is a pair of moments, so a frame that only
 *     ended up complete could have been complete from the start, and a frame
 *     that only started could have stalled at beat zero. Both are checked.
 *   - The finished tree is what a reader gets when motion is refused. The
 *     reveal is written as "hide, then put back", so a browser that never runs
 *     the script shows the search — but only if the CSS agrees, and that is a
 *     cascade fact.
 *   - The bright line is the accent. The picture's argument is that colour
 *     means measurement, and it is made of computed strokes.
 *   - Nothing overflows at 390px. A public page that scrolls sideways on a
 *     phone is the one defect a visitor cannot work around.
 *   - Text meets AA against the surface it actually lands on. The palette test
 *     proves the tokens; only a browser can say which token ended up on which
 *     background in a stylesheet assembled in TypeScript.
 *
 * One server, one browser: booting vite costs seconds and every assertion here
 * reads from a handful of loads.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import type { Browser, Page } from 'puppeteer';

import { withGallery } from './gallery-harness';
import { THEMES, type Theme } from './computed-style';

/** Widths that are two different designs, not one design resized. */
const PHONE = { width: 390, height: 844 } as const;
const TABLET = { width: 640, height: 900 } as const;
const DESKTOP = { width: 1280, height: 900 } as const;

const PAGES = ['landing', 'login', 'install', 'approve'] as const;

interface Growth {
  /** Nodes drawn at the first frame after load, out of how many the tree has. */
  readonly early: number;
  readonly total: number;
  /** Nodes drawn once the page stopped growing. */
  readonly settled: number;
  /** Whether the page ever declared itself mid-reveal. */
  readonly announced: boolean;
}

interface Contrast {
  readonly what: string;
  readonly ratio: number;
  /** Font size in px, which decides whether AA wants 4.5 or 3.0. */
  readonly size: number;
}

/** Every measurement, taken once. `withGallery` owns one server and one
 *  browser, so the suite pays for the boot a single time. */
interface Facts {
  growth?: Growth;
  reducedMotion?: { shown: number; total: number; announced: boolean };
  strokes?: { kept: string; accent: string; prunedDash: string; keptWidth: number; siblingWidth: number };
  overflow: Record<string, number>;
  targets: Record<string, number>;
  contrast: Contrast[];
  panel?: { hiddenAtFirst: boolean; openAfterClick: boolean; command: string };
  providers?: string[];
}

let browser: Browser;
let origin: string;
const facts: Facts = { overflow: {}, targets: {}, contrast: [] };

/** sRGB relative luminance, per WCAG. */
function luminance(rgb: readonly [number, number, number]): number {
  const linear = (channel: number) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2]);
}

function ratio(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  const one = luminance(a);
  const two = luminance(b);
  const hi = Math.max(one, two);
  const lo = Math.min(one, two);
  return (hi + 0.05) / (lo + 0.05);
}

/** `rgb()`/`rgba()` from a computed style, or the hex a token still holds when
 *  it is read straight off a custom property. */
function parseRgb(value: string): [number, number, number] {
  const hex = value.trim().match(/^#([0-9a-f]{6})$/i);
  if (hex !== null) {
    const n = parseInt(hex[1]!, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const parts = value.match(/-?[\d.]+/g);
  if (parts === null || parts.length < 3) throw new Error(`not a colour: ${value}`);
  return [Number(parts[0]), Number(parts[1]), Number(parts[2])];
}

/** Open a public frame in a new page pinned to one theme, and bring it to the
 *  front — a background tab is served no animation frames, so a reveal driven
 *  by `requestAnimationFrame` would never start there. */
async function openPage(frame: string, theme: Theme, size: { width: number; height: number }): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewport(size);
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme.mode }]);
  await page.evaluateOnNewDocument((palette: string) => { localStorage.setItem('palette', palette); }, theme.palette);
  await page.bringToFront();
  await page.goto(`${origin}/gallery.html?frame=${frame}`, { waitUntil: 'networkidle0' });
  const applied = await page.evaluate(() => ({
    mode: document.documentElement.dataset.mode,
    palette: document.documentElement.dataset.palette,
  }));
  if (applied.mode !== theme.mode || applied.palette !== theme.palette) {
    await page.close();
    throw new Error(`${frame}: asked for ${theme.palette} ${theme.mode}, page is on ${applied.palette} ${applied.mode}`);
  }
  return page;
}

const SILK_DARK: Theme = { palette: 'silk', mode: 'dark' };

beforeAll(async () => {
  await withGallery(async (gallery) => {
    browser = gallery.browser;
    origin = gallery.origin;

    // ── The tree grows, and it settles ────────────────────────────────
    {
      const page = await openPage('landing', SILK_DARK, DESKTOP);
      // The first observable moment where the tree is PART drawn — awaited as a
      // condition rather than slept for, so the assertion is "there was such a
      // moment" and not "420ms was long enough".
      const partial = await page.waitForFunction(() => {
        const tree = document.querySelector('#hero-tree');
        if (tree === null) return null;
        const shown = tree.querySelectorAll('.n[data-shown]').length;
        const total = tree.querySelectorAll('.n').length;
        if (shown === 0 || shown >= total) return null;
        return { shown, total, growing: tree.hasAttribute('data-growing') };
      }, { polling: 'raf', timeout: 8000 }).then((handle) => handle.jsonValue());
      if (partial === null) throw new Error('the hero tree was never observed part-drawn');
      await page.waitForFunction(() => !document.querySelector('[data-growing]'), { timeout: 8000 });
      const settled = await page.evaluate(() => document.querySelectorAll('#hero-tree .n[data-shown]').length);
      facts.growth = {
        early: partial.shown,
        total: partial.total,
        settled,
        announced: partial.growing,
      };

      // ── The install panel ───────────────────────────────────────────
      const hiddenAtFirst = await page.evaluate(() => document.getElementById('install')?.hidden === true);
      await page.click('.nav [data-install-toggle]');
      const panel = await page.evaluate(() => ({
        open: document.getElementById('install')?.hidden === false,
        expanded: [...document.querySelectorAll('[data-install-toggle]')]
          .every((toggle) => toggle.getAttribute('aria-expanded') === 'true'),
        command: document.getElementById('landing-install-command')?.textContent?.trim() ?? '',
      }));
      facts.panel = { hiddenAtFirst: hiddenAtFirst === true, openAfterClick: panel.open && panel.expanded, command: panel.command };

      // ── Colour carries the meaning ──────────────────────────────────
      facts.strokes = await page.evaluate(() => {
        const kept = document.querySelector('#hero-tree .e[data-status="kept"]')!;
        const pruned = document.querySelector('#hero-tree .e[data-status="pruned"]')!;
        const root = getComputedStyle(document.documentElement);
        const keptNode = document.querySelector('#hero-tree .n[data-status="kept"]')!;
        const other = document.querySelector('#hero-tree .n[data-status="pruned"]')!;
        return {
          kept: getComputedStyle(kept).stroke,
          accent: root.getPropertyValue('--c-accent').trim(),
          prunedDash: getComputedStyle(pruned).strokeDasharray,
          keptWidth: Number(keptNode.getAttribute('r')),
          siblingWidth: Number(other.getAttribute('r')),
        };
      });

      // ── Contrast, measured where the text actually sits ─────────────
      facts.contrast = await page.evaluate(() => {
        const samples: { what: string; selector: string }[] = [
          { what: 'hero headline', selector: 'h1' },
          { what: 'hero lede', selector: '.lede' },
          { what: 'eyebrow', selector: '.eyebrow' },
          { what: 'section label', selector: '.label' },
          { what: 'figure annotation', selector: '.anno span' },
          { what: 'figure caption', selector: 'figcaption' },
          { what: 'stat label', selector: '.stat span' },
          { what: 'capability body', selector: '.cell p' },
          { what: 'command text', selector: '.cmd code' },
          { what: 'copy button', selector: '.copy' },
          { what: 'footer', selector: 'footer span' },
          { what: 'nav link', selector: '.nav .quiet' },
        ];
        /** The first ancestor that actually paints a background. */
        const ground = (node: Element): string => {
          for (let el: Element | null = node; el; el = el.parentElement) {
            const bg = getComputedStyle(el).backgroundColor;
            if (bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg;
          }
          return getComputedStyle(document.body).backgroundColor;
        };
        return samples.flatMap(({ what, selector }) => {
          const el = document.querySelector(selector);
          if (el === null) return [];
          const style = getComputedStyle(el);
          return [{ what, ink: style.color, paper: ground(el), size: parseFloat(style.fontSize) }];
        });
      }).then((rows) => rows.map((row) => ({
        what: row.what,
        size: row.size,
        ratio: ratio(parseRgb(row.ink), parseRgb(row.paper)),
      })));
      await page.close();
    }

    // ── Motion refused leaves the finished picture ────────────────────
    {
      const page = await browser.newPage();
      await page.setViewport(DESKTOP);
      await page.emulateMediaFeatures([
        { name: 'prefers-color-scheme', value: 'dark' },
        { name: 'prefers-reduced-motion', value: 'reduce' },
      ]);
      await page.bringToFront();
      await page.goto(`${origin}/gallery.html?frame=landing`, { waitUntil: 'networkidle0' });
      facts.reducedMotion = await page.evaluate(() => ({
        shown: document.querySelectorAll('#hero-tree .n').length,
        total: document.querySelectorAll('#hero-tree .n').length,
        announced: document.querySelector('[data-growing]') !== null,
      }));
      // Every node must be painted, not merely present: a hidden tree and a
      // shown tree have the same node count.
      const opacities = await page.evaluate(() => [...document.querySelectorAll('#hero-tree .n')]
        .map((node) => Number(getComputedStyle(node).opacity)));
      facts.reducedMotion = { ...facts.reducedMotion, shown: opacities.filter((o) => o > 0.9).length };
      await page.close();
    }

    // ── Width, and the size of a thing you tap ────────────────────────
    for (const frame of PAGES) {
      for (const [label, size] of [['390', PHONE], ['640', TABLET], ['1280', DESKTOP]] as const) {
        const page = await openPage(frame, SILK_DARK, size);
        if (frame === 'landing') {
          await page.waitForFunction(() => !document.querySelector('[data-growing]'), { timeout: 8000 });
        }
        facts.overflow[`${frame}@${label}`] = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        if (label === '390') {
          facts.targets[frame] = await page.evaluate(() => {
            // Visible controls only: the install panel ships closed, and a
            // control inside a `hidden` block has no box to hit yet.
            const hits = [...document.querySelectorAll('a.btn, button.copy, a.provider, button[type="submit"]')]
              .filter((hit) => hit.getClientRects().length > 0);
            return Math.min(...hits.map((hit) => hit.getBoundingClientRect().height), Infinity);
          });
        }
        await page.close();
      }
    }

    // ── Sign-in offers a real way in ──────────────────────────────────
    {
      const page = await openPage('login', SILK_DARK, DESKTOP);
      facts.providers = await page.evaluate(
        () => [...document.querySelectorAll('a.provider')].map((a) => a.getAttribute('href') ?? ''),
      );
      await page.close();
    }
  });
}, 180_000);

describe('the hero tree is a search happening', () => {
  test('it starts partly drawn and ends whole', () => {
    const growth = facts.growth!;
    expect(growth.total).toBeGreaterThan(20);
    expect(growth.announced, 'the page never declared itself mid-reveal').toBeTrue();
    expect(growth.early, 'nothing had been revealed yet').toBeGreaterThan(0);
    expect(growth.early, 'the tree was already complete, so nothing grew').toBeLessThan(growth.total);
    expect(growth.settled, 'the reveal stopped before it finished').toBe(growth.total);
  });

  test('refusing motion shows the whole search at once', () => {
    const seen = facts.reducedMotion!;
    expect(seen.announced, 'a reveal was started against prefers-reduced-motion').toBeFalse();
    expect(seen.shown).toBe(seen.total);
  });
});

describe('the picture means what the caption says', () => {
  test('the kept line is drawn in the accent', () => {
    const strokes = facts.strokes!;
    expect(parseRgb(strokes.kept)).toEqual(parseRgb(strokes.accent));
  });

  test('an abandoned branch is dashed, so it reads as abandoned without colour', () => {
    expect(facts.strokes!.prunedDash).not.toBe('none');
  });

  test('a node that was measured more is drawn larger', () => {
    const strokes = facts.strokes!;
    expect(strokes.keptWidth).toBeGreaterThan(strokes.siblingWidth);
  });
});

describe('the install command is on the page, not behind a navigation', () => {
  test('the panel is closed until asked for, then both toggles agree', () => {
    const panel = facts.panel!;
    expect(panel.hiddenAtFirst).toBeTrue();
    expect(panel.openAfterClick).toBeTrue();
  });

  test('the command is whole', () => {
    expect(facts.panel!.command).toMatch(/^curl -fsSL '.*\/install\.sh' \| bash$/);
  });
});

describe('every public page fits the screen it is on', () => {
  test('nothing scrolls sideways, at any of the three widths', () => {
    for (const [where, overflow] of Object.entries(facts.overflow)) {
      expect(overflow, where).toBeLessThanOrEqual(0);
    }
  });

  test('a control on a phone is big enough to hit', () => {
    for (const [frame, height] of Object.entries(facts.targets)) {
      if (height === Infinity) continue;
      expect(height, `${frame}: smallest control`).toBeGreaterThanOrEqual(34);
    }
  });
});

describe('the public text is readable', () => {
  test('every sampled role meets WCAG AA against the surface it sits on', () => {
    expect(facts.contrast.length).toBeGreaterThanOrEqual(10);
    for (const { what, ratio: measured, size } of facts.contrast) {
      // AA: 4.5 for body text, 3.0 once the type is large (18.66px bold or
      // 24px). Every label on these pages is small, so almost all of it is
      // held to 4.5.
      const need = size >= 24 ? 3 : 4.5;
      expect(measured, `${what} at ${size}px`).toBeGreaterThanOrEqual(need);
    }
  });
});

describe('sign-in works from the page', () => {
  test('each provider starts a real OAuth flow', () => {
    const providers = facts.providers!;
    expect(providers.length).toBeGreaterThan(0);
    for (const href of providers) expect(href).toMatch(/^\/auth\/[^/]+\/start/);
  });
});

describe('the pages hold up in every theme', () => {
  test('all four themes are the ones the shell declares', () => {
    // The overflow and contrast passes above run in silk dark. This names the
    // set they are a sample of, so a palette added to the app without a public
    // projection fails here rather than silently going unphotographed.
    expect(THEMES.map((theme) => `${theme.palette} ${theme.mode}`)).toEqual([
      'umber dark', 'umber light', 'silk dark', 'silk light',
    ]);
  });
});
