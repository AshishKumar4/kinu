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
 *   - The bright line is the accent's own face. The picture's argument is
 *     that colour means measurement, and it is made of computed strokes.
 *   - The claim is one static line inside the champagne block, and its ink
 *     meets AA against the block itself — the one surface assembled in
 *     TypeScript rather than declared by a token.
 *   - Nothing overflows at 390px. A public page that scrolls sideways on a
 *     phone is the one defect a visitor cannot work around.
 *   - The frame holds its measure at every width: one centered column whose
 *     rules run full-bleed, never a column that widens without purpose.
 *   - Text meets AA against the surface it actually lands on. The palette test
 *     proves the tokens; only a browser can say which token ended up on which
 *     background in a stylesheet assembled in TypeScript.
 *
 * One server, one browser: booting vite costs seconds and every assertion here
 * reads from a handful of loads.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, Page } from 'puppeteer';

import { cliFilmFigure } from '../packages/cf-backend/src/lib/cli-film';
import { landingDocument } from '../packages/cf-backend/src/lib/public-pages';
import { withGallery } from './gallery-harness';
import { THEMES, type Theme } from './computed-style';

declare global {
  /** Globals of the PAGE under test, read through `page.evaluate`: the weave's
   *  shipped script plants `__kinuWeave`, and the budget probe plants
   *  `__tasks`. Declared here so the probes read them without assertions. */
  interface Window {
    __tasks?: number;
    __kinuWeave?: { frames: number; maxFrameMs: number };
    /** The first part-drawn frame of the hero tree, recorded by the watcher
     *  installed before navigation. Read after the reveal settles, so proving
     *  "there was such a moment" never depends on the observer attaching
     *  before the reveal finishes on a slow first compile. */
    __growth?: { early: number; total: number; announced: boolean };
  }
}

/** Widths that are two different designs, not one design resized. */
const PHONE = { width: 390, height: 844 } as const;
const TABLET = { width: 640, height: 900 } as const;
const DESKTOP = { width: 1280, height: 900 } as const;
/** The wide screens the page is now designed for, not merely tolerated on. */
const WIDE = { width: 1920, height: 1000 } as const;
const WIDER = { width: 2560, height: 1200 } as const;

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
  /** The hero claim: how many h1 elements exist, what the block's says,
   *  whether any rotation machinery remains, and how many pill actions the
   *  block asks the visitor to choose between. */
  claim?: { headlines: number; text: string; rotators: number; chip: string; pills: number };
  /** The same claim read twice across more than one former rotation period:
   *  a static line must not move. */
  claimStill?: { before: string; after: string };
  /** Section labels in document order, and the § 06 self-deploy facts. */
  labels?: string[];
  deploy?: { button: string | null; guide: string | null; commands: string[] };
  /** The silk: whether the canvas woke, what its worst frame cost, and what
   *  the browser counted while it ran. */
  weave?: {
    live: boolean; frames: number; maxFrameMs: number;
    layoutDelta: number; longTasks: number; stillPaths: number;
  };
  /** The weave under refused motion: the still's paths, painted; no canvas. */
  weaveStill?: { live: boolean; stillShown: boolean; canvasPainted: boolean };
  /** The CLI film: playback observed as a pair of moments, then the settled
   *  text, plus how it behaves when motion is refused. */
  cliFilm?: {
    playing: { shown: number; total: number };
    settled: { shown: number; total: number; text: string };
  };
  cliFilmStill?: { played: boolean; visibleLines: number; total: number };
  /** The web film as fetched from the server the page names. */
  webFilm?: { loading: string | null; status: number; bytes: number; decodedWidth: number };
  /** What the page does with a wide screen: how much width it takes, how much
   *  padding a cell keeps, the narrowest mode cell, and whether every glimpse
   *  still fits the card it sits in. Keyed by viewport width. */
  wide: Record<string, {
    pageWidth: number; minPad: number; cellInner: number; glimpseFits: boolean;
    heroLines: number; filmWidth: number; emptyMountHeight: number; ruleWidth: number;
  }>;
}

let browser: Browser;
let origin: string;
const facts: Facts = { overflow: {}, targets: {}, contrast: [], wide: {} };

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
  // The hero's reveal is over in about 1.6s, so an observer that attaches after
  // load can miss it entirely on a cold vite compile. This watcher runs from
  // the document's first frame and keeps the first part-drawn frame it sees.
  await page.evaluateOnNewDocument(() => {
    const watch = (): void => {
      const tree = document.querySelector('#hero-tree');
      if (tree !== null && window.__growth === undefined) {
        const shown = tree.querySelectorAll('.n[data-shown]').length;
        const total = tree.querySelectorAll('.n').length;
        if (shown > 0 && shown < total) {
          window.__growth = { early: shown, total, announced: tree.hasAttribute('data-growing') };
        }
      }
      requestAnimationFrame(watch);
    };
    requestAnimationFrame(watch);
  });
  await page.bringToFront();
  await page.goto(`${origin}/gallery.html?frame=${frame}`, { waitUntil: 'networkidle0' });
  const applied = await page.evaluate(() => ({
    mode: document.documentElement.dataset.mode,
  }));
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

    // ── The tree grows, and it settles ────────────────────────────────
    {
      const page = await openPage('landing', DARK, DESKTOP);
      // The first moment the tree is PART drawn. Recorded from inside the page
      // by a watcher planted before navigation: polling from here raced the
      // reveal, and a slow first compile could finish all 35 nodes before the
      // first poll, which failed the suite for a reason that was never about
      // the page.
      await page.waitForFunction(() => !document.querySelector('[data-growing]'), { timeout: 8000 });
      const partial = await page.evaluate(() => window.__growth ?? null);
      if (partial === null) throw new Error('the hero tree was never observed part-drawn');
      const settled = await page.evaluate(() => document.querySelectorAll('#hero-tree .n[data-shown]').length);
      facts.growth = {
        early: partial.early,
        total: partial.total,
        settled,
        announced: partial.announced,
      };

      // ── The silk is awake, and it is cheap ───────────────────────────
      // Measured with the tree settled AND the canvas cross-fade finished,
      // so the window contains only what the hero runs at rest: the weave's
      // frame loop and the headline clock. The budget is the contract's — no
      // main-thread task over 8 ms, no layout thrash — read three ways: the
      // loop's own worst-frame meter, a longtask observer, and the renderer's
      // layout counter.
      await page.waitForSelector('#hero-weave[data-live]', { timeout: 8000 });
      await page.waitForFunction(
        () => Number(getComputedStyle(document.querySelector('#hero-weave canvas')!).opacity) === 1,
        { timeout: 8000 },
      );
      await page.evaluate(() => {
        // Not buffered: the budget under test is the hero AT REST, and a
        // buffered observer would re-report the document's own load-time
        // parse.
        window.__tasks = 0;
        new PerformanceObserver((list) => { window.__tasks = (window.__tasks ?? 0) + list.getEntries().length; })
          .observe({ type: 'longtask' });
      });
      // At rest the only thing running on this page is the weave's frame
      // loop: the tree reveal has settled and the claim is static. Open a
      // plain timed window — anything counted in it belongs to the weave,
      // which claims to touch nothing but its canvas.
      const layoutsBefore = (await page.metrics()).LayoutCount ?? 0;
      // A real delay on purpose: the clock under measurement is a rAF loop
      // inside a real browser, which no fake timer in this process can
      // advance — the same reason the headline's stillness test waits.
      const watched = Promise.withResolvers<void>();
      setTimeout(watched.resolve, 1400);
      await watched.promise;
      const layoutsAfter = (await page.metrics()).LayoutCount ?? 0;
      const weave = await page.evaluate(() => ({
        live: document.getElementById('hero-weave')?.hasAttribute('data-live') === true,
        meter: window.__kinuWeave,
        tasks: window.__tasks ?? 0,
        stillPaths: document.querySelectorAll('#hero-weave .weave-still path').length,
      }));
      facts.weave = {
        live: weave.live,
        frames: weave.meter?.frames ?? 0,
        maxFrameMs: weave.meter?.maxFrameMs ?? Infinity,
        layoutDelta: layoutsAfter - layoutsBefore,
        longTasks: weave.tasks,
        stillPaths: weave.stillPaths,
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
          accent: root.getPropertyValue('--c-accent-fg').trim(),
          prunedDash: getComputedStyle(pruned).strokeDasharray,
          keptWidth: Number(keptNode.getAttribute('r')),
          siblingWidth: Number(other.getAttribute('r')),
        };
      });

      // ── Contrast, measured where the text actually sits ─────────────
      facts.contrast = await page.evaluate(() => {
        const samples: { what: string; selector: string }[] = [
          { what: 'hero claim on the block', selector: '.block h1' },
          { what: 'block support line', selector: '.block .say' },
          { what: 'block chip', selector: '.block .chip' },
          { what: 'section label', selector: '.label' },
          { what: 'section title', selector: '.head h2' },
          { what: 'section lede', selector: '.head .lede' },
          { what: 'figure annotation', selector: '.anno span' },
          { what: 'figure caption', selector: 'figcaption' },
          { what: 'claim row heading', selector: '.stat strong' },
          { what: 'claim row body', selector: '.stat span' },
          { what: 'capability body', selector: '.cell p' },
          { what: 'command text', selector: '.cmd code' },
          { what: 'copy button', selector: '.copy' },
          { what: 'footer', selector: 'footer span' },
          { what: 'nav link', selector: '.nav .quiet' },
          { what: 'deep prose', selector: '.body' },
          { what: 'pull-quote', selector: '.pull' },
          { what: 'spec term', selector: '.spec dt' },
          { what: 'spec value', selector: '.spec dd' },
          { what: 'clock kicker', selector: '.cell .num' },
          { what: 'section foot', selector: '.foot' },
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

      // ── The claim is static ───────────────────────────────────────────
      // One h1, no rotation machinery in the document at all: the defect
      // this replaces showed two variants ghosting through each other
      // mid-fade, so the honest state is "there is nothing to rotate".
      facts.claim = await page.evaluate(() => ({
        headlines: document.querySelectorAll('h1').length,
        text: document.querySelector('.block h1')?.textContent?.trim() ?? '',
        rotators: document.querySelectorAll('[data-taglines]').length,
        chip: document.querySelector('.block .chip')?.textContent?.trim() ?? '',
        pills: [...document.querySelectorAll('.block .actions .btn')].length,
      }));
      // Read the claim twice across a wait longer than the old rotation
      // period, so a regression back to a rotator shows up as movement.
      const claimBefore = facts.claim.text;
      await new Promise((resolve) => setTimeout(resolve, 4300));
      const claimAfter = await page.evaluate(
        () => document.querySelector('.block h1')?.textContent?.trim() ?? '',
      );
      facts.claimStill = { before: claimBefore, after: claimAfter };

      // ── The page's own table of contents, and § 06's way out ─────────
      facts.labels = await page.evaluate(
        () => [...document.querySelectorAll('.label b')].map((label) => label.textContent ?? ''),
      );
      facts.deploy = await page.evaluate(() => ({
        button: document.querySelector('#deploy a[href^="https://deploy.workers.cloudflare.com"]')?.getAttribute('href') ?? null,
        guide: document.querySelector('#deploy a[href*="SELF-HOSTING"]')?.getAttribute('href') ?? null,
        commands: [...document.querySelectorAll('#deploy .cmd code')].map((code) => code.textContent?.trim() ?? ''),
      }));

      // ── The CLI film plays back, and the web film is really there ────
      // Playback, like growth, is a pair of moments: a frame where the
      // transcript is part-shown under `data-playing`, then a settled frame
      // where every line is back and `data-played` stands.
      await page.evaluate(() => document.getElementById('cli-film')?.scrollIntoView({ block: 'center' }));
      const playing = await page.waitForFunction(() => {
        const film = document.getElementById('cli-film');
        if (film === null || !film.hasAttribute('data-playing')) return null;
        const shown = film.querySelectorAll('.line[data-shown]').length;
        const total = film.querySelectorAll('.line').length;
        return shown < total ? { shown, total } : null;
      }, { polling: 'raf', timeout: 8000 }).then((handle) => handle.jsonValue());
      if (playing === null) throw new Error('the CLI film was never observed mid-playback');
      await page.waitForFunction(
        () => document.getElementById('cli-film')?.hasAttribute('data-played'),
        { timeout: 30_000 },
      );
      const playedBack = await page.evaluate(() => {
        const film = document.getElementById('cli-film')!;
        return {
          shown: film.querySelectorAll('.line[data-shown]').length,
          total: film.querySelectorAll('.line').length,
          text: film.textContent ?? '',
        };
      });
      facts.cliFilm = { playing, settled: playedBack };

      const webFilmLoading = await page.evaluate(
        () => document.querySelector('.webfilm')?.getAttribute('loading') ?? null,
      );
      await page.evaluate(() => document.querySelector('.webfilm')?.scrollIntoView({ block: 'center' }));
      const decodedWidth = await page.waitForFunction(() => {
        const img = document.querySelector<HTMLImageElement>('.webfilm');
        return img && img.complete && img.naturalWidth > 0 ? img.naturalWidth : null;
      }, { timeout: 8000 }).then((handle) => handle.jsonValue());
      const asset = await fetch(`${origin}/assets/kinu-film-web.webp`);
      facts.webFilm = {
        loading: webFilmLoading,
        status: asset.status,
        bytes: (await asset.arrayBuffer()).byteLength,
        decodedWidth: Number(decodedWidth),
      };
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
      // A reader who refused motion gets the same static claim. Read it,
      // outwait a former rotation period, read it again — the same hold the
      // live page is held to.
      const before = await page.evaluate(
        () => document.querySelector('.block h1')?.textContent?.trim() ?? '',
      );
      const still = Promise.withResolvers<void>();
      setTimeout(still.resolve, 4300);
      await still.promise;
      const after = await page.evaluate(
        () => document.querySelector('.block h1')?.textContent?.trim() ?? '',
      );
      facts.claimStill = { before, after };

      // ── Motion refused: the designed still, and the whole transcript ──
      facts.weaveStill = await page.evaluate(() => {
        const weave = document.getElementById('hero-weave');
        const still = weave?.querySelector('.weave-still');
        const canvas = weave?.querySelector('canvas');
        return {
          live: weave?.hasAttribute('data-live') === true,
          stillShown: still !== null && still !== undefined
            && Number(getComputedStyle(still).opacity) > 0.9
            && getComputedStyle(still).display !== 'none',
          canvasPainted: canvas !== null && canvas !== undefined
            && getComputedStyle(canvas).display !== 'none',
        };
      });
      await page.evaluate(() => document.getElementById('cli-film')?.scrollIntoView({ block: 'center' }));
      facts.cliFilmStill = await page.evaluate(() => {
        const film = document.getElementById('cli-film')!;
        return {
          played: film.hasAttribute('data-played') || film.hasAttribute('data-playing'),
          visibleLines: [...film.querySelectorAll('.line')]
            .filter((line) => line.getClientRects().length > 0 || getComputedStyle(line).display !== 'none').length,
          total: film.querySelectorAll('.line').length,
        };
      });
      await page.close();
    }

    // ── Width, and the size of a thing you tap ────────────────────────
    for (const frame of PAGES) {
      for (const [label, size] of [
        ['390', PHONE], ['640', TABLET], ['1280', DESKTOP], ['1920', WIDE], ['2560', WIDER],
      ] as const) {
        const page = await openPage(frame, DARK, size);
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
        // ── The wide screens: room used, and nothing crammed ──────────
        // Measured rather than declared: the column's real width, the least
        // padding any grid cell keeps, the narrowest cell on the page (the
        // four-across grids at this width, not the mode cells), and whether any
        // glimpse breaks out of its card.
        if (frame === 'landing' && (label === '1920' || label === '2560')) {
          facts.wide[label] = await page.evaluate(() => {
            const column = document.querySelector('.page')!;
            const cells = [...document.querySelectorAll('.grid > .cell')];
            const pad = (cell: Element): number => parseFloat(getComputedStyle(cell).paddingLeft);
            // An unfilled mount is collapsed, so it has no box: nothing to
            // overflow, and the assertion below holds it to zero height rather
            // than letting emptiness reserve space.
            const mounts = [...document.querySelectorAll('[data-glimpse]')];
            const fits = mounts.every((glimpse) => {
              const card = glimpse.closest('.cell');
              if (card === null) return false;
              const inner = glimpse.getBoundingClientRect();
              if (inner.width === 0 && inner.height === 0) return true;
              const outer = card.getBoundingClientRect();
              return inner.left >= outer.left - 1 && inner.right <= outer.right + 1;
            });
            const lineHeight = (node: Element): number => parseFloat(getComputedStyle(node).lineHeight);
            const claim = document.querySelector('.block h1');
            const rules = [...document.querySelectorAll('hr.rule')];
            const widestRule = Math.max(...rules.map(
              (rule) => rule.getBoundingClientRect().width), 0);
            return {
              pageWidth: column.getBoundingClientRect().width,
              minPad: Math.min(...cells.map(pad)),
              cellInner: Math.min(...cells.map((cell) => cell.clientWidth - pad(cell) * 2)),
              glimpseFits: fits,
              // The rag: the claim, in lines.
              heroLines: claim === null ? 99 : Math.round(
                claim.getBoundingClientRect().height / lineHeight(claim)),
              // A single reading surface, at its widest on this page.
              filmWidth: Math.max(...[...document.querySelectorAll('.film,.dag,.dag-wrap')]
                .map((film) => film.getBoundingClientRect().width), 0),
              emptyMountHeight: Math.max(...[...document.querySelectorAll('.film,.dag-wrap,[data-glimpse]')]
                .filter((mount) => mount.childElementCount === 0)
                .map((mount) => mount.getBoundingClientRect().height), 0),
              // The frame spends the width, not the column: separators run
              // the full viewport while the content stays measured.
              ruleWidth: widestRule,
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

describe('the silk behind the hero', () => {
  test('the canvas woke, and the still it replaced is the designed field', () => {
    const weave = facts.weave!;
    expect(weave.live, 'the weave never declared itself live').toBeTrue();
    expect(weave.stillPaths, 'the still is not the field the module declares').toBe(30);
    expect(weave.frames, 'the loop is not actually producing frames').toBeGreaterThan(20);
  });

  test('it holds the measured budget: no frame over 8 ms, no layout, no long task', () => {
    const weave = facts.weave!;
    expect(weave.maxFrameMs, 'a weave frame exceeded the 8 ms budget').toBeLessThan(8);
    expect(weave.longTasks, 'the main thread saw a long task while the hero was at rest').toBe(0);
    // The window is synchronised to open just after a headline swap, so the
    // rotator's own two visibility layouts sit outside it: whatever remains
    // would be the weave's, and the weave touches nothing but its canvas.
    expect(weave.layoutDelta, 'something forced layout while only the weave was running').toBe(0);
  });

  test('refusing motion gets the still, and no canvas at all', () => {
    const still = facts.weaveStill!;
    expect(still.live, 'the canvas started against prefers-reduced-motion').toBeFalse();
    expect(still.stillShown, 'the designed still was not painted').toBeTrue();
    expect(still.canvasPainted, 'the canvas is displayed under reduced motion').toBeFalse();
  });
});

describe('the CLI film is the recording', () => {
  const RECORDING = readFileSync(join(import.meta.dir, 'fixtures', 'cli-film-run.jsonl'), 'utf8');
  const FILM_SOURCE = readFileSync(
    join(import.meta.dir, '..', 'packages', 'cf-backend', 'src', 'lib', 'cli-film.ts'), 'utf8');
  const ELIDED = ' …';

  const unescape = (html: string): string => html
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&');

  /** The film as it SHIPS: one entry per line the reader sees, with the prompt
   *  or the label stripped, so what remains is the recorded text itself. Read
   *  off the rendered figure rather than the projection behind it, so a frame
   *  that never reaches the page cannot pass. */
  const shippedLines = (): string[] => {
    const pre = /<pre class="term" id="cli-film">(.*?)<\/pre>/s.exec(cliFilmFigure());
    expect(pre, 'the film figure no longer renders a terminal').not.toBeNull();
    return (pre?.[1] ?? '').split('<span class="line"').slice(1)
      // The split leaves each opening tag's own remainder ahead of the text.
      .map((chunk) => chunk.slice(chunk.indexOf('>') + 1))
      .map((chunk) => unescape(chunk.replace(/<b>.*?<\/b>/gs, '').replace(/<[^>]+>/g, '')).trim());
  };

  /** Both annotation rails, as the reader reads them. */
  const shippedRails = (): string =>
    (cliFilmFigure().match(/<div class="anno ruled">.*?<\/div>/gs) ?? []).map(unescape).join(' ');

  test('every frame is a verbatim substring of the recorded session', () => {
    const lines = shippedLines();
    expect(lines.length, 'the film renders no frames').toBeGreaterThan(0);
    for (const line of lines) {
      const text = line.endsWith(ELIDED) ? line.slice(0, -ELIDED.length) : line;
      // The prompt inside the command line is recorded on `turn_start`; the
      // rest of that line is the invocation itself, checked below.
      const candidate = text.replace(/^kinu run \S+ "(.*)"$/, '$1');
      const escaped = JSON.stringify(candidate).slice(1, -1);
      expect(
        RECORDING.includes(candidate) || RECORDING.includes(escaped),
        `not in the recording: ${candidate.slice(0, 60)}`,
      ).toBeTrue();
    }
  });

  test('the rail quotes the session, not a legend', () => {
    const rows = RECORDING.split('\n').filter((row) => row !== '').map((row) => JSON.parse(row));
    const session = rows.find((row) => row.type === 'session');
    const turnEnd = rows.find((row) => row.type === 'turn_end');
    const rails = shippedRails();
    expect(rails).toContain(session.workspace);
    expect(rails).toContain(session.backend);
    expect(rails).toContain(`${String(turnEnd.steps)} steps`);
    expect(rails).toContain(`${String(Math.round(turnEnd.durationMs / 1000))} s`);
    // The rails carry no session id — a reader has no use for one — so the
    // projection is held to the recording's identity here instead. If either
    // side is replaced without the other, this fails.
    expect(FILM_SOURCE).toContain(session.id);
  });

  test('it plays on approach and settles on the whole transcript', () => {
    const film = facts.cliFilm!;
    const lines = shippedLines();
    expect(film.playing.shown, 'playback was never part way').toBeLessThan(film.playing.total);
    expect(film.settled.shown).toBe(film.settled.total);
    expect(film.settled.total).toBe(lines.length);
    for (const line of lines) {
      expect(film.settled.text, 'a frame is missing from the settled player').toContain(line);
    }
  });

  test('refusing motion reads the finished transcript', () => {
    const still = facts.cliFilmStill!;
    expect(still.played, 'playback started against prefers-reduced-motion').toBeFalse();
    expect(still.visibleLines).toBe(still.total);
  });
});

describe('the web film is real, lazy, and inside the budget', () => {
  test('the page asks for it lazily and the server really has it', () => {
    const film = facts.webFilm!;
    expect(film.loading).toBe('lazy');
    expect(film.status).toBe(200);
    expect(film.decodedWidth).toBe(1280);
  });

  test('it is an animation, not a poster', () => {
    const bytes = readFileSync(join(import.meta.dir, '..', 'packages', 'cf-backend', 'public', 'assets', 'kinu-film-web.webp'));
    expect(bytes.includes('ANIM'), 'no animation header').toBeTrue();
    let frames = 0;
    for (let at = bytes.indexOf('ANMF'); at !== -1; at = bytes.indexOf('ANMF', at + 4)) frames += 1;
    expect(frames, 'a film of one frame is a poster').toBeGreaterThan(1);
  });

  test('the page and its films hold the weight budget', () => {
    const html = Buffer.byteLength(landingDocument("curl -fsSL 'https://kinu.run/install.sh' | bash"));
    expect(html, 'the landing document grew past its budget').toBeLessThan(96_000);
    const film = statSync(join(import.meta.dir, '..', 'packages', 'cf-backend', 'public', 'assets', 'kinu-film-web.webp')).size;
    expect(film + 0, 'combined film assets over 2.5 MB').toBeLessThan(2_500_000);
    expect(facts.webFilm!.bytes, 'served bytes differ from the committed asset').toBe(film);
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

/**
 * A wide screen is where the reference language earns its keep: the FRAME
 * takes the room — full-bleed rules, generous rhythm — and the reading
 * column stays measured. These are the numbers that catch both failure
 * modes: a column that widens without purpose (the owner's complaint about
 * the previous tier system) and cells squeezed below legibility.
 */
describe('the landing is designed for the wide screens', () => {
  test('the column keeps its measure and the frame spends the room', () => {
    for (const at of ['1920', '2560'] as const) {
      const wide = facts.wide[at]!;
      // One centered column, 1200px plus its hairlines — never wider.
      expect(wide.pageWidth, `${at}: the column widened without purpose`)
        .toBeLessThanOrEqual(1202);
      expect(wide.pageWidth, `${at}: the column collapsed`).toBeGreaterThan(1100);
      // Separators run the full viewport: the width goes to the frame.
      expect(wide.ruleWidth, `${at}: rules stopped short of full bleed`)
        .toBeGreaterThanOrEqual(wide.pageWidth);
    }
  });

  test('nothing crams: cells keep their padding and a mode cell stays legible', () => {
    for (const at of ['1920', '2560'] as const) {
      const wide = facts.wide[at]!;
      expect(wide.minPad, `${at}: least cell padding`).toBeGreaterThanOrEqual(26);
      // 300px is the width below which a terminal row and a sidebar both stop
      // being readable, so it is the floor the glimpses are built against.
      expect(wide.cellInner, `${at}: narrowest mode cell`).toBeGreaterThanOrEqual(300);
    }
  });

  test('every glimpse fits the card it sits in', () => {
    for (const at of ['1920', '2560'] as const) {
      expect(facts.wide[at]!.glimpseFits, `${at}: a glimpse overflowed its card`).toBeTrue();
    }
  });

  test('the headline holds three lines, so the rag never orphans a word', () => {
    // Measured with a sweep before the sizes were set: at these columns every
    // tagline holds three lines up to 81px (1920) and 108px (2560), and the
    // tiers ship 72 and 84. The 1280 base belongs to the shell, not here.
    for (const at of ['1920', '2560'] as const) {
      expect(facts.wide[at]!.heroLines, `${at}: headline lines`).toBeLessThanOrEqual(3);
    }
  });

  test('a reading surface caps its measure instead of stretching to the viewport', () => {
    // A figure may take the column; a terminal or a demo may not exceed it.
    expect(facts.wide['2560']!.filmWidth, 'a film or demo stretched past its measure')
      .toBeLessThanOrEqual(1200);
    expect(facts.wide['2560']!.filmWidth, 'no film or demo was measured at all').toBeGreaterThan(0);
  });

  test('an unfilled mount collapses instead of reserving void', () => {
    for (const at of ['1920', '2560'] as const) {
      expect(facts.wide[at]!.emptyMountHeight, `${at}: an empty mount held height`).toBe(0);
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

describe('the claim is one confident line', () => {
  test('one h1 in the block, no rotation machinery anywhere', () => {
    const claim = facts.claim!;
    expect(claim.headlines, 'more than one headline on the page').toBe(1);
    expect(claim.rotators, 'rotation machinery survived the rebuild').toBe(0);
    expect(claim.text).toStartWith('An agent of your own that');
    expect(claim.chip, 'the block lost its kicker').toContain('self-evolving');
    // The reference block carries exactly one pill action: choice is the
    // section's job, not the hero's.
    expect(claim.pills, 'the hero asked for more than one action').toBe(1);
  });

  test('the claim does not move, live or under refused motion', () => {
    expect(facts.claimStill!.before).not.toBe('');
    expect(facts.claimStill!.after).toBe(facts.claimStill!.before);
  });
});

describe('deploy your own is a real path', () => {
  test('the button forks THIS repository into the visitor\u2019s account', () => {
    expect(facts.deploy!.button).toBe('https://deploy.workers.cloudflare.com/?url=https://github.com/AshishKumar4/kinu');
  });

  test('the guide and the three commands are the documented flow', () => {
    const deploy = facts.deploy!;
    expect(deploy.guide).toContain('/docs/SELF-HOSTING.md');
    expect(deploy.commands).toEqual(['bun run infra:provision', 'bun run deploy', 'bun run gate:infra']);
  });
});

/**
 * The positioning gates. The owner rejected a page that led with search
 * mechanics, so the structure itself is held: the platform promise leads, the
 * quickstart opens with where it runs, and the search's configuration ships
 * behind a disclosure. These read the rendered document offline — the same
 * pure function the server sends — so they need no browser.
 */
describe('the front page leads with the platform', () => {
  const INSTALL = "curl -fsSL 'https://kinu.run/install.sh' | bash";
  const section = (from: string, to: string): string => {
    const doc = landingDocument(INSTALL);
    return doc.slice(doc.indexOf(from), doc.indexOf(to));
  };

  test('the stat band carries four visitor claims, not engineering counts', () => {
    const html = landingDocument(INSTALL);
    for (const claim of ['Learns from use', 'Crafts its own tools', 'Commands agent swarms', 'Your cloud or yours alone']) {
      expect(html).toContain(claim);
    }
    expect(html.match(/<li class="stat">/g)?.length).toBe(4);
    // The counts moved out entirely: no bare figure leads a stat, and the
    // search's own vocabulary is not headline material.
    expect(html).not.toMatch(/<strong>\d+<\/strong>/);
    expect(html).not.toContain('named searches');
  });

  test('quickstart opens with where it runs, not with installing', () => {
    const s01 = section('§ 01', '§ 02');
    expect(s01).toContain('Start in the cloud on kinu.run');
    // All three modes are visible, web first, each with its glimpse mount for
    // the animated miniature that plays there.
    const order = ['data-glimpse="web"', 'data-glimpse="tui"', 'data-glimpse="cli"'].map((g) => s01.indexOf(g));
    expect(order.every((at) => at > -1), 'a mode cell is missing its glimpse mount').toBeTrue();
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(s01).toContain('kinu create triage');
    expect(s01).toContain('kinu chat triage');
    expect(s01).toContain('curl -fsSL');
    // The regression this gate exists for: installation was the first thing
    // the section asked of a visitor who may never open a terminal.
    expect(s01).not.toContain('Install the CLI</h2>');
  });

  test('the search configuration is absent, not merely disclosed', () => {
    // The ruling hardened: the spec rail left the page entirely — axes,
    // presets and depth vocabulary live in the exploration doc, nowhere on
    // the landing. The story stays in the open: scored nodes, pruning, a
    // winner.
    const s03 = section('§ 03', '§ 04');
    expect(s03).not.toContain('<details class="config">');
    expect(s03).not.toContain('unit · context · expand · score · advance · carry');
    expect(s03).toContain('directed graph');
    expect(s03).toContain('pruned');
  });

  test('the configuration keeps its home in the exploration doc', () => {
    const exploration = readFileSync(join(import.meta.dir, '..', 'docs', 'EXPLORATION.md'), 'utf8');
    expect(exploration).toContain('The six axes');
    expect(exploration).toContain('`ideate`');
  });
});

describe('the page reads as numbered sections', () => {
  test('the § labels count up without a gap', () => {
    expect(facts.labels).toEqual(['§ 01', '§ 02', '§ 03', '§ 04', '§ 05', '§ 06', '§ 07']);
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
    // The overflow and contrast passes above run dark. This names the set
    // they are a sample of, so a theme added without a public projection
    // fails here rather than silently going unphotographed.
    expect(THEMES.map((theme) => theme.mode)).toEqual(['dark', 'light']);
  });
});
