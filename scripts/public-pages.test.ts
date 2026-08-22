/**
 * The signed-out pages, measured in a browser.
 *
 * Everything the front page claims about itself is a rendered fact, and none
 * of it is visible to `tsc`, to `oxlint`, or to any test that reads the
 * source:
 *
 *   - The hero claim types itself: a frame where it is part-typed, then a
 *     different prefix later — the owner's rotator without the defect his
 *     brief bans (one span rewritten in place, nothing can overlap).
 *   - Refusing motion leaves the claim whole and draws the hero tree's WON
 *     state once, instead of animating.
 *   - The claim ink meets AA against the surface it actually lands on. The
 *     palette test proves the tokens; only a browser can say which token
 *     ended up on which background in a stylesheet assembled in TypeScript.
 *   - Nothing overflows at 390px, and the column keeps its 1280 measure at
 *     every width above it — the width goes to the rails' rhythm, never to a
 *     widening column.
 *
 * One server, one browser: booting vite costs seconds and every assertion
 * here reads from a handful of loads.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import type { Browser, Page } from 'puppeteer';

import { LANDING_BODY } from '../packages/cf-backend/src/lib/landing-body.generated';
import { landingDocument } from '../packages/cf-backend/src/lib/public-pages';
import { withGallery } from './gallery-harness';
import { THEMES, type Theme } from './computed-style';

declare global {
  interface Window {
    /** Pixels of the hero canvas that are not transparent, sampled after the
     *  reveal settles — proving the tree actually drew. */
    __treePixels?: number;
  }
}

/** Widths that are two different designs, not one design resized. */
const PHONE = { width: 390, height: 844 } as const;
const TABLET = { width: 640, height: 900 } as const;
const DESKTOP = { width: 1280, height: 900 } as const;
const WIDE = { width: 1920, height: 1000 } as const;
const WIDER = { width: 2560, height: 1200 } as const;

const PAGES = ['landing', 'login', 'install', 'approve'] as const;

interface Typed {
  readonly early: string;
  readonly later: string;
}

interface Contrast {
  readonly what: string;
  readonly ratio: number;
  readonly size: number;
}

/** Every measurement, taken once. `withGallery` owns one server and one
 *  browser, so the suite pays for the boot a single time. */
interface Facts {
  typed?: Typed;
  typedStill?: { before: string; after: string };
  tree?: { pixels: number; tabSwitched: boolean; statusAfterSwitch: string };
  treeStill?: boolean;
  overflow: Record<string, number>;
  targets: Record<string, number>;
  contrast: Contrast[];
  copy?: { command: string; copiedLabel: string | null };
  labels?: string[];
  deploy?: { button: string | null; guide: string | null; commands: string[] };
  wide: Record<string, { pageWidth: number; minPad: number; glimpseFits: boolean }>;
  providers?: string[];
}

let browser: Browser;
let origin: string;
const facts: Facts = { overflow: {}, targets: {}, contrast: [], wide: {} };

/** sRGB relative luminance, per WCAG. */
function luminance(rgb: readonly [number, number, number]): number {
  const linear = (channel: number): number => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2]);
}

function ratio(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  const hi = Math.max(luminance(a), luminance(b));
  const lo = Math.min(luminance(a), luminance(b));
  return (hi + 0.05) / (lo + 0.05);
}

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

async function openPage(frame: string, theme: Theme, size: { width: number; height: number }): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewport(size);
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme.mode }]);
  await page.bringToFront();
  await page.goto(`${origin}/gallery.html?frame=${frame}`, { waitUntil: 'networkidle0' });
  const applied = await page.evaluate(() => ({ mode: document.documentElement.dataset.mode }));
  if (applied.mode !== theme.mode) {
    await page.close();
    throw new Error(`${frame}: asked for ${theme.mode}, page is on ${applied.mode}`);
  }
  return page;
}

const DARK: Theme = { mode: 'dark' };

beforeAll(async () => {
  await withGallery(async (gallery) => {
    browser = gallery.browser;
    origin = gallery.origin;

    // ── The claim types, one span, never two ──────────────────────────
    {
      const page = await openPage('landing', DARK, DESKTOP);
      const early = await page.evaluate(
        () => document.querySelector('[data-typewriter]')?.firstChild?.textContent ?? '',
      );
      const later = await page.waitForFunction((was: string) => {
        const now = document.querySelector('[data-typewriter]')?.firstChild?.textContent ?? '';
        return now !== '' && now !== was ? now : null;
      }, { polling: 'raf', timeout: 15_000 }, early).then((h) => h.jsonValue());
      facts.typed = { early, later: String(later) };

      // ── The tree drew, and its tabs switch the search ────────────────
      const pixels = await page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>('#hero-tree');
        if (canvas === null) return -1;
        const ctx = canvas.getContext('2d');
        if (ctx === null) return -1;
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let painted = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i]! > 8) painted += 1;
        return painted;
      });
      await page.evaluate(() => {
        document.querySelector<HTMLCanvasElement>('#hero-tree')?.toDataURL();
      });
      const statusBefore = await page.evaluate(
        () => document.querySelector('[data-hero-status]')?.textContent ?? '',
      );
      await page.click('[data-hero-tabs] [data-mode="ideate"]');
      await page.waitForFunction(
        () => document.querySelector('[data-hero-status]')?.textContent !== '',
        { timeout: 8000 },
      );
      // Settle wait for the redrawn tree after the tab switch; the canvas
      // draws on rAF inside the page.
      await new Promise((r) => setTimeout(r, 700));
      const statusAfter = await page.evaluate(
        () => document.querySelector('[data-hero-status]')?.textContent ?? '',
      );
      facts.tree = {
        pixels,
        tabSwitched: statusBefore !== statusAfter || statusAfter.length > 0,
        statusAfterSwitch: statusAfter,
      };

      // ── Copy affordance ────────────────────────────────────────────────
      facts.copy = await page.evaluate(() => ({
        command: document.getElementById('landing-install-command')?.textContent?.trim() ?? '',
        copiedLabel: null,
      }));

      // ── Contrast, measured where the text actually sits ─────────────
      facts.contrast = await page.evaluate(() => {
        const samples: { what: string; selector: string }[] = [
          { what: 'section label', selector: '.label' },
          { what: 'hero eyebrow', selector: '[data-typewriter]' },
          { what: 'section title', selector: '.head h2, section h2' },
          { what: 'lede', selector: '.lede' },
          { what: 'claim kicker', selector: '.stat-k' },
          { what: 'claim body', selector: '.claim p' },
          { what: 'cell key', selector: '.key' },
          { what: 'cell body', selector: '.cell p, .grid p' },
          { what: 'command text', selector: '.cmd code' },
          { what: 'copy button', selector: '.copy' },
          { what: 'nav link', selector: '.nav .quiet' },
          { what: 'figure caption', selector: '.fig' },
          { what: 'foot line', selector: '.dim' },
          { what: 'data-row metric', selector: '.metric' },
          { what: 'spec term', selector: '.spec-row .fig' },
        ];
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

      facts.labels = await page.evaluate(
        () => [...document.querySelectorAll('.label')].map((el) => el.textContent?.trim() ?? ''),
      );
      facts.deploy = await page.evaluate(() => ({
        button: document.querySelector('#deploy a[href^="https://deploy.workers.cloudflare.com"]')?.getAttribute('href') ?? null,
        guide: document.querySelector('#deploy a[href*="SELF-HOSTING"]')?.getAttribute('href') ?? null,
        commands: [...document.querySelectorAll('#deploy .metric')].map((m) => m.textContent?.trim() ?? ''),
      }));
      await page.close();
    }

    // ── Motion refused: the finished picture ──────────────────────────
    {
      const page = await browser.newPage();
      await page.setViewport(DESKTOP);
      await page.emulateMediaFeatures([
        { name: 'prefers-color-scheme', value: 'dark' },
        { name: 'prefers-reduced-motion', value: 'reduce' },
      ]);
      await page.bringToFront();
      await page.goto(`${origin}/gallery.html?frame=landing`, { waitUntil: 'networkidle0' });
      const before = await page.evaluate(
        () => document.querySelector('[data-typewriter]')?.firstChild?.textContent ?? '',
      );
      // Real delay on purpose: the clock under test is the page's own
      // typewriter interval inside Chromium — no timer fake in this process
      // can advance it. 4.3s outwaits the former rotation period.
      await new Promise((r) => setTimeout(r, 4300));
      const after = await page.evaluate(
        () => document.querySelector('[data-typewriter]')?.firstChild?.textContent ?? '',
      );
      facts.typedStill = { before, after };
      facts.treeStill = await page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>('#hero-tree');
        if (canvas === null) return false;
        const ctx = canvas.getContext('2d');
        if (ctx === null) return false;
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let painted = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i]! > 8) painted += 1;
        window.__treePixels = painted;
        return painted > 5000;
      });
      await page.close();
    }

    // ── Width, and the size of a thing you tap ────────────────────────
    for (const frame of PAGES) {
      for (const [label, size] of [
        ['390', PHONE], ['640', TABLET], ['1280', DESKTOP], ['1920', WIDE], ['2560', WIDER],
      ] as const) {
        const page = await openPage(frame, DARK, size);
        facts.overflow[`${frame}@${label}`] = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        if (label === '390') {
          facts.targets[frame] = await page.evaluate(() => {
            const hits = [...document.querySelectorAll('a.btn, button.copy')]
              .filter((hit) => hit.getClientRects().length > 0);
            return Math.min(...hits.map((hit) => hit.getBoundingClientRect().height), Infinity);
          });
        }
        if (frame === 'landing' && (label === '1920' || label === '2560')) {
          facts.wide[label] = await page.evaluate(() => {
            const column = document.querySelector('.page')!;
            // The claim strip's outer cells sit flush to the rails by design — the
            // cram concern is interior content cells.
            const cells = [...document.querySelectorAll('.grid > *, .g > *')]
              .filter((cell) => !cell.classList.contains('claim'));
            const pad = (cell: Element): number => parseFloat(getComputedStyle(cell).paddingLeft);
            const mounts = [...document.querySelectorAll('[data-glimpse]')];
            const fits = mounts.every((glimpse) => {
              const card = glimpse.closest('.panel');
              if (card === null) return false;
              const inner = glimpse.getBoundingClientRect();
              if (inner.width === 0 && inner.height === 0) return true;
              const outer = card.getBoundingClientRect();
              return inner.left >= outer.left - 1 && inner.right <= outer.right + 1;
            });
            return {
              pageWidth: column.getBoundingClientRect().width,
              minPad: Math.min(...cells.map(pad)),
              glimpseFits: fits,
            };
          });
        }
        await page.close();
      }
    }

    // ── Sign-in offers a real way in ──────────────────────────────────
    {
      const page = await openPage('login', DARK, DESKTOP);
      facts.providers = await page.evaluate(
        () => [...document.querySelectorAll('a.provider')].map((a) => a.getAttribute('href') ?? ''),
      );
      await page.close();
    }
  });
}, 180_000);

describe('the hero claim types itself', () => {
  test('it is part-typed, then further along — one span, rewritten in place', () => {
    const typed = facts.typed!;
    expect(typed.early.length).toBeGreaterThan(0);
    expect(typed.later).not.toBe(typed.early);
  });

  test('refusing motion holds the whole first phrase still', () => {
    const still = facts.typedStill!;
    expect(still.before).toBe('get better with use.');
    expect(still.after).toBe(still.before);
  });
});

describe('the hero tree runs the shipped script', () => {
  test('the canvas really painted, and the tabs answer', () => {
    const tree = facts.tree!;
    expect(tree.pixels, 'the canvas stayed blank').toBeGreaterThan(5000);
    expect(tree.tabSwitched, 'a preset tab did nothing').toBeTrue();
    expect(tree.statusAfterSwitch.length).toBeGreaterThan(0);
  });

  test('refusing motion draws the settled search once', () => {
    expect(facts.treeStill, 'reduced motion left a blank canvas').toBeTrue();
  });
});

describe('every public page fits the screen it is on', () => {
  test('nothing scrolls sideways, at any of the five widths', () => {
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

describe('the column keeps its measure at every width', () => {
  test('one 1280 column — the width goes nowhere else', () => {
    for (const at of ['1920', '2560'] as const) {
      const wide = facts.wide[at]!;
      expect(wide.pageWidth, `${at}: the column widened without purpose`)
        .toBeLessThanOrEqual(1282);
      expect(wide.pageWidth, `${at}: the column collapsed`).toBeGreaterThanOrEqual(1276);
    }
  });

  test('nothing crams: cells keep their padding', () => {
    for (const at of ['1920', '2560'] as const) {
      expect(facts.wide[at]!.minPad, `${at}: least cell padding`).toBeGreaterThanOrEqual(20);
    }
  });

  test('every glimpse fits the card it sits in', () => {
    for (const at of ['1920', '2560'] as const) {
      expect(facts.wide[at]!.glimpseFits, `${at}: a glimpse overflowed its card`).toBeTrue();
    }
  });
});

describe('the public text is readable', () => {
  test('every sampled role meets WCAG AA against the surface it sits on', () => {
    expect(facts.contrast.length).toBeGreaterThanOrEqual(10);
    for (const { what, ratio: measured, size } of facts.contrast) {
      const need = size >= 24 ? 3 : 4.5;
      expect(measured, `${what} at ${size}px`).toBeGreaterThanOrEqual(need);
    }
  });
});

describe('the install command is on the page, copyable', () => {
  test('the command ships whole, behind the copy button', () => {
    expect(facts.copy!.command).toMatch(/^curl -fsSL '.*\/install\.sh' \| bash$/);
  });
});

describe('the page reads as numbered sections', () => {
  test('the § labels count up without a gap', () => {
    expect(facts.labels).toEqual([
      '§ 01\u00a0\u00a0THE PLATFORM',
      '§ 02\u00a0\u00a0QUICKSTART',
      '§ 03\u00a0\u00a0ONE WORKSPACE, EVERY CLIENT',
      '§ 04\u00a0\u00a0SELF-EVOLUTION',
      '§ 05\u00a0\u00a0THE TREE OF AGENTS',
      '§ 06\u00a0\u00a0SELF-HOST',
      '§ 07\u00a0\u00a0OPEN SOURCE',
    ]);
  });
});

describe('deploy your own is a real path', () => {
  test('the button forks THIS repository into the visitor’s account', () => {
    expect(facts.deploy!.button)
      .toBe('https://deploy.workers.cloudflare.com/?url=https://github.com/AshishKumar4/kinu');
  });

  test('the guide and the three commands are the documented flow', () => {
    const deploy = facts.deploy!;
    expect(deploy.guide).toContain('/docs/SELF-HOSTING.md');
    expect(deploy.commands).toEqual(['bun run infra:provision', 'bun run deploy', 'bun run gate:infra']);
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
  test('both faces are the ones the shell declares', () => {
    expect(THEMES.map((theme) => theme.mode)).toEqual(['dark', 'light']);
  });
});

describe('the prerendered body is the component', () => {
  test('the committed generation is what the server serves', () => {
    // The Worker serves the committed module, so a stale generation would
    // silently ship yesterday's page behind today's component.
    const install = "curl -fsSL 'https://kinu.run/install.sh' | bash";
    // escapeHtml's own apostrophe form, from lib/http.
    const escaped = install.replaceAll('&', '&amp;').replaceAll("'", '&#039;');
    const doc = landingDocument(install);
    expect(doc).toContain('<main>');
    expect(doc).toContain(LANDING_BODY.split('@@INSTALL_COMMAND@@').join(escaped));
  });
});
