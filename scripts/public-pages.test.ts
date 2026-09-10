import { beforeAll, describe, expect, test } from 'bun:test';
import type { Browser, Page } from 'puppeteer';

import { withGallery } from './gallery-harness';
import { THEMES, type Theme } from './computed-style';

// The walkthrough's deterministic drive, declared here rather than imported:
// the timeline module lives in component-land (its story quotes the product's
// fixtures), and importing it would drag the product's DOM components under
// this gate's own JSX runtime. The shape below is kept identical to
// `LandingMovieHandle` in `landing-movie-timeline.ts`.
interface LandingMovieHandle {
  readonly duration: number;
  readonly cues: Record<string, number>;
  seek(at: number): Promise<void>;
  play(): void;
  pause(): void;
  state(): { t: number; playing: boolean; settled: boolean };
}

declare global {
  interface Window {
    __kinuLandingMovie?: LandingMovieHandle;
  }
}

const PHONE = { width: 390, height: 844 } as const;

const DESKTOP = { width: 1280, height: 900 } as const;

const LANDING_WIDTHS = [
  ['390', PHONE],
  ['640', { width: 640, height: 900 }],
  ['900', { width: 900, height: 900 }],
  ['1280', DESKTOP],
  ['1568', { width: 1568, height: 940 }],
  ['1920', { width: 1920, height: 1000 }],
  ['2560', { width: 2560, height: 1200 }],
  ['3840', { width: 3840, height: 1400 }],
] as const;

const PUBLIC_FRAMES = ['login', 'install', 'approve'] as const;

interface Contrast {
  readonly what: string;
  readonly ratio: number;
  readonly size: number;
}

interface SurfaceFact {
  readonly present: boolean;
  readonly width: number;
  readonly height: number;
  readonly text: string;
}

/** Horizontal integrity of one landing width. `scroll` alone cannot prove it:
 *  the landing root is `overflow-x-clip`, so a child wider than the viewport
 *  produces NO scrollable overflow — documentElement.scrollWidth stays equal
 *  to clientWidth while the browser silently cuts the child (the 390px hero
 *  shipped exactly that way). `clipped` counts elements whose box leaves the
 *  viewport with no ancestor that legitimately contains them. */
interface WidthIntegrity {
  readonly scroll: number;
  readonly clipped: number;
  readonly worst: readonly string[];
  readonly cut: number;
  readonly cutWorst: readonly string[];
}

interface RailFact {
  readonly frames: number;
  readonly classes: readonly string[];
  readonly visible: boolean;
  readonly roster: string;
}

interface MovieFact {
  readonly typing: boolean;
  readonly tools: boolean;
  readonly decisions: readonly { label: string; disabled: boolean }[];
  readonly cursorShown: boolean;
  readonly decided: boolean;
  readonly slate: boolean;
  readonly settled: boolean;
}

interface MovieReducedFact {
  readonly settled: boolean;
  readonly cursor: boolean;
  readonly slate: boolean;
  readonly decided: boolean;
  readonly frozen: boolean;
}

interface Facts {
  reduced?: { before: string; after: string; pixels: number; animations: number };
  treeFlows?: boolean;
  prunedNodes?: number;
  hiddenNodes?: number;
  heroGraphWidth?: number;
  workspace?: SurfaceFact;
  tui?: SurfaceFact;
  cli?: SurfaceFact;
  interactions?: { workspace: boolean; decision: boolean; plan: boolean; slate: boolean; tui: boolean; cli: boolean; evolution: boolean };
  command?: string;
  copied?: boolean;
  rail?: RailFact;
  railPhoneHidden?: boolean;
  movie?: MovieFact;
  movieReduced?: MovieReducedFact;
  heroA11y?: { label: string; phrases: string[] };
  homeLink?: { visible: boolean; hasGraphic: boolean };
  deploy?: { button: string | null; guide: string | null };
  providers?: string[];
  loginLayout?: { dialog: boolean; cardOffset: number; barOffset: number; footer: boolean };
  landingOverflow: Record<string, WidthIntegrity>;
  publicOverflow: Record<string, number>;
  landingTargets?: number[];
  publicTargets?: number[];
  wideColumns: Record<string, number>;
  contrast: Contrast[];
}

let browser: Browser;

let origin: string;

const facts: Facts = {
  landingOverflow: {},
  publicOverflow: {},
  wideColumns: {},
  contrast: [],
};

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label} was not measured`);

  return value;
}

function luminance(rgb: readonly [number, number, number]): number {
  const linear = (channel: number): number => {
    const c = channel / 255;

    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };

  return 0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2]);
}

function contrastRatio(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  const high = Math.max(luminance(a), luminance(b));
  const low = Math.min(luminance(a), luminance(b));

  return (high + 0.05) / (low + 0.05);
}

function parseRgb(value: string): [number, number, number] {
  const channels = value.match(/-?[\d.]+/g);

  if (channels === null || channels.length < 3) throw new Error(`not a colour: ${value}`);

  return [Number(channels[0]), Number(channels[1]), Number(channels[2])];
}

async function openLanding(
  size: { width: number; height: number },
  reducedMotion = false,
): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewport(size);
  await page.emulateMediaFeatures([
    { name: 'prefers-color-scheme', value: 'dark' },
    { name: 'prefers-reduced-motion', value: reducedMotion ? 'reduce' : 'no-preference' },
  ]);
  await page.bringToFront();
  await page.goto(`${origin}/landing.html`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(
    () => document.querySelector('h1') !== null,
    { timeout: 15_000 },
  );

  return page;
}

async function openPublic(
  frame: string,
  theme: Theme,
  size: { width: number; height: number },
): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewport(size);
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme.mode }]);
  await page.goto(`${origin}/gallery.html?frame=${frame}`, { waitUntil: 'networkidle0' });
  const mode = await page.evaluate(() => document.documentElement.dataset.mode);

  if (mode !== theme.mode) {
    await page.close();
    throw new Error(`${frame}: expected ${theme.mode}, got ${String(mode)}`);
  }

  return page;
}

async function opaqueCanvasPixels(page: Page): Promise<number> {
  const handle = await page.waitForFunction(() => {
    const canvas = document.querySelector('canvas');
    const context = canvas?.getContext('2d');

    if (canvas === null || context === null || context === undefined || canvas.width === 0 || canvas.height === 0) return null;
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let opaque = 0;

    for (let index = 3; index < data.length; index += 4) {
      if (data[index] !== 0) opaque += 1;
    }

    return opaque > 0 ? opaque : null;
  }, { polling: 100, timeout: 5_000 });

  return Number(await handle.jsonValue());
}

beforeAll(async () => {
  await withGallery(async (gallery) => {
    browser = gallery.browser;
    origin = gallery.origin;

    {
      const page = await openLanding(DESKTOP);
      await page.waitForSelector('canvas[data-settled="true"]', { timeout: 10_000 });
      facts.prunedNodes = await page.$eval('canvas', (canvas) => Number(canvas.dataset.pruned ?? 0));
      facts.hiddenNodes = await page.$eval('canvas', (canvas) => Number(canvas.dataset.hidden ?? 0));
      facts.heroGraphWidth = await page.$eval('[data-hero-graph]', (graph) => (
        Math.round(graph.getBoundingClientRect().width)
      ));
      const settledTree = await page.$eval('canvas', (canvas) => canvas.toDataURL());
      await page.waitForFunction(
        (previous: string) => document.querySelector('canvas')?.toDataURL() !== previous,
        { polling: 100, timeout: 8_000 },
        settledTree,
      );
      facts.treeFlows = await page.$eval('canvas', (canvas, first) => (
        canvas.dataset.settled === 'true' && canvas.toDataURL() !== first
      ), settledTree);
      const headline = await page.$eval('h1', (element) => ({ height: element.getBoundingClientRect().height, label: element.getAttribute('aria-label') }));
      const phrase = await page.$eval('[data-typewriter]', (element) => element.textContent);
      await page.waitForFunction((previous) => document.querySelector('[data-typewriter]')?.textContent !== previous, { timeout: 5_000 }, phrase);
      expect(await page.$eval('h1', (element) => ({ height: element.getBoundingClientRect().height, label: element.getAttribute('aria-label') }))).toEqual(headline);
      // The heading animates one phrase at a time, so its accessible name is
      // the only place a screen reader gets the whole rotation. The sizers
      // carry every visible phrase; the label must contain each of them.
      facts.heroA11y = await page.evaluate(() => ({
        label: document.querySelector('h1')?.getAttribute('aria-label') ?? '',
        phrases: [...document.querySelectorAll('h1 span.invisible')].map((sizer) => sizer.textContent ?? ''),
      }));
      await page.$eval('#platform', (element) => element.scrollIntoView());
      await new Promise((resolve) => setTimeout(resolve, 100));
      const offscreen = await page.$eval('[data-typewriter]', (element) => element.textContent);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await page.$eval('[data-typewriter]', (element) => element.textContent)).toBe(offscreen);

      const surfaces = await page.evaluate(() => {
        const measure = (element: Element | null): SurfaceFact => {
          const box = element?.getBoundingClientRect();

          return {
            present: element !== null,
            width: Math.round(box?.width ?? 0),
            height: Math.round(box?.height ?? 0),
            text: element?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
          };
        };

        return {
          workspace: measure(document.querySelector('[aria-label="Kinu workspace interface preview"]')),
          tui: measure(document.querySelector('[aria-label="Kinu terminal interface preview"]')),
          cli: measure(document.querySelector('[aria-label="Kinu command line preview"]')),
        };
      });

      facts.workspace = surfaces.workspace;
      facts.tui = surfaces.tui;
      facts.cli = surfaces.cli;
      // The frames are the product's own components, loaded as their own
      // chunk; `networkidle0` has fetched it, this proves it mounted.
      await page.waitForSelector('[data-landing-frame="checkout"] textarea', { timeout: 10_000 });
      // The plan frame is the walkthrough movie, driven through its own
      // handle: at load it holds the story's start (an empty composer), and
      // each beat below seeks it before asserting that beat's DOM.
      await page.waitForFunction(() => window.__kinuLandingMovie !== undefined, { timeout: 10_000 });
      await page.waitForSelector('[data-landing-frame="slate"] [data-slate-dashboard]', { timeout: 10_000 });
      await page.evaluate(() => {
        const root = document.querySelector('[data-landing-frame="checkout"]');

        const supervise = [...(root?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])]
          .find((button) => button.textContent?.trim() === 'Supervise');

        supervise?.click();
      });
      await page.waitForFunction(
        () => document.querySelector('[data-landing-frame="checkout"]')?.getAttribute('data-workspace-mode') === 'supervise'
          && document.querySelector('[data-workspace-panel="supervise"]')?.textContent?.includes('Curriculum') === true,
      );
      await page.evaluate(() => {
        const root = document.querySelector('[data-landing-frame="checkout"]');

        const run = [...(root?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])]
          .find((button) => button.textContent?.trim() === 'Run');

        run?.click();
      });
      await page.waitForSelector('[data-landing-frame="checkout"] button[aria-label="Retry"]');
      await page.click('[data-landing-frame="checkout"] button[aria-label="Retry"]');
      await page.waitForFunction(
        () => document.querySelector('[data-landing-frame="checkout"]')?.textContent?.includes('Retried as') === true,
      );
      // The plan frame is the walkthrough movie, and every beat below is a DOM
      // or computed-style read off the seek the handle settles first.
      const cues = await page.evaluate(() => window.__kinuLandingMovie?.cues);

      if (cues === undefined) throw new Error('the walkthrough publishes no cues');

      const seek = (at: number): Promise<void> => page.evaluate(async (seekTo: number) => {
        await window.__kinuLandingMovie?.seek(seekTo);
      }, at);

      // The rail rides every workspace frame, populated through the real
      // roster transport, marked on the frame's own workspace.
      facts.rail = await page.evaluate(() => {
        const frames = [...document.querySelectorAll('[data-landing-frame]')];
        const asides = frames.map((frame) => frame.querySelector(':scope > aside'));
        const first = asides[0];

        return {
          frames: asides.filter((aside) => aside !== null).length,
          classes: asides.map((aside) => aside?.getAttribute('class') ?? ''),
          visible: first !== null
            && first !== undefined
            && getComputedStyle(first).display !== 'none'
            && first.getClientRects().length > 0,
          roster: first?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        };
      });
      // The request types into the real composer before anything else exists.
      await seek((cues.typeStart + cues.sent) / 2);
      await page.waitForFunction(() => {
        const area = document.querySelector('[data-landing-frame="plan"] textarea');

        return area instanceof HTMLTextAreaElement && area.value.length > 0;
      }, { timeout: 10_000 });

      const typing = await page.$eval('[data-landing-frame="plan"] textarea', (area) => (
        area instanceof HTMLTextAreaElement ? area.value : ''
      ));

      // The agent's tool calls stream into the transcript the way a real turn
      // renders them.
      await seek(cues.searchDone + 100);
      await page.waitForFunction(() => (
        document.querySelector('[data-landing-frame="plan"] [data-tool-group]') !== null
        && document.querySelector('[data-landing-frame="plan"]')?.textContent?.includes('apply-coupon') === true
      ), { timeout: 10_000 });
      // The plan pops up in the right-hand panel with Approve live: the movie
      // submits a clean plan, so Request changes stays disabled.
      await seek(cues.planReady + 200);
      await page.waitForSelector('[data-landing-frame="plan"] [data-plan-decisions]', { timeout: 15_000 });

      const decisions = await page.$$eval('[data-landing-frame="plan"] [data-plan-decisions] button', (buttons) => (
        buttons.map((button) => ({ label: button.textContent?.trim() ?? '', disabled: button.disabled }))
      ));

      // The cursor's click approves through the product's own decision path.
      await seek(cues.approve + 200);
      await page.waitForFunction(() => (
        document.querySelector('[data-landing-frame="plan"] [data-plan-status]')?.textContent === 'Approved'
      ), { timeout: 15_000 });

      const cursorShown = await page.$eval('[data-landing-frame="plan"] [data-movie-cursor]', (cursor) => (
        getComputedStyle(cursor).opacity !== '0'
      ));

      // The build lands a slate, opened in its own tab: the settled state.
      await seek(cues.end);
      await page.waitForSelector('[data-landing-frame="plan"] [data-slate-dashboard]', { timeout: 15_000 });
      facts.movie = {
        typing: typing.length > 0,
        tools: true,
        decisions,
        cursorShown,
        decided: true,
        slate: true,
        settled: await page.$eval('[data-landing-frame="plan"]', (frame) => (
          frame.getAttribute('data-movie-settled') === 'true'
        )),
      };
      expect(await page.evaluate(() => {
        const pinned = document.querySelector('[aria-label="Pinned workspaces"]');
        const trigger = document.querySelector('[aria-controls="landing-tui-workspaces"]');
        const user = document.querySelector('[data-tui-role="user"]');
        const assistant = document.querySelector('[data-tui-role="assistant"]');
        const buttons = [...(pinned?.querySelectorAll<HTMLButtonElement>('button') ?? [])];

        return {
          pinned: (pinned?.getClientRects().length ?? 0) > 0,
          trigger: (trigger?.getClientRects().length ?? 0) > 0,
          userLabel: user?.textContent?.includes('YOU') === true,
          assistantLabel: assistant?.querySelector('span')?.textContent ?? null,
          adaptiveHint: document.querySelector('[data-tui-agent]')?.textContent?.includes('Alt+W workspaces') === true,
          groupHeader: buttons.some((button) => button.textContent?.replace(/\s+/gu, ' ').includes('checkout · 2') === true),
          subordinate: pinned?.textContent?.includes('└ reviewer · auditor') === true,
          cloudCollapsedHidesJarvis: buttons.every((button) => button.textContent?.includes('Jarvis') !== true),
        };
      })).toEqual({
        pinned: true,
        trigger: false,
        userLabel: true,
        assistantLabel: null,
        adaptiveHint: true,
        groupHeader: true,
        subordinate: true,
        cloudCollapsedHidesJarvis: true,
      });
      // Expanding the collapsed cloud section reveals the remote workspace;
      // selecting the agent, not the section, swaps the surface.
      await page.evaluate(() => {
        const pinned = document.querySelector('[aria-label="Pinned workspaces"]');

        const cloud = [...(pinned?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
          .find((button) => button.getAttribute('aria-expanded') === 'false' && button.textContent?.includes('Cloud') === true);

        cloud?.click();
      });
      await page.waitForFunction(() => {
        const pinned = document.querySelector('[aria-label="Pinned workspaces"]');

        return [...(pinned?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
          .some((button) => button.textContent?.includes('Jarvis') === true);
      });
      expect(await page.evaluate(() => document.querySelector('[data-tui-agent]')?.getAttribute('data-tui-agent'))).toBe('audit');
      await page.evaluate(() => {
        const pinned = document.querySelector('[aria-label="Pinned workspaces"]');

        const jarvis = [...(pinned?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
          .find((button) => button.textContent?.includes('Jarvis') === true);

        jarvis?.click();
      });
      await page.waitForFunction(
        () => document.querySelector('[data-tui-agent]')?.getAttribute('data-tui-agent') === 'jarvis',
      );
      await page.click('[data-cli-mode] [role="tab"][aria-selected="false"]');
      await page.waitForSelector('[data-cli-mode="ci"]');
      await page.evaluate(() => {
        const stages = [...document.querySelectorAll<HTMLButtonElement>('#evolution button[aria-pressed]')];
        stages[1]?.click();
      });
      await page.waitForFunction(
        () => document.getElementById('evolution')?.getAttribute('data-evolution-stage') === '1',
      );
      facts.interactions = await page.evaluate(() => ({
        workspace: document.querySelector('[data-landing-frame="checkout"] [data-workspace-panel="run"] textarea') !== null,
        decision: document.querySelector('[data-landing-frame="checkout"]')?.textContent?.includes('Retried as') === true,
        plan: document.querySelector('[data-landing-frame="plan"] [data-plan-status]')?.textContent === 'Approved',
        slate: document.querySelectorAll('[data-landing-frame="slate"] [data-slate-dashboard] .landing-draw').length === 2,
        tui: document.querySelector('[data-tui-agent="jarvis"]') !== null,
        cli: document.querySelector('[data-cli-mode="ci"] pre')?.textContent?.includes('kinu exec --workspace') === true,
        evolution: document.getElementById('evolution')?.getAttribute('data-evolution-stage') === '1',
      }));

      facts.command = await page.$eval(
        '[data-install-command]',
        (element) => element.textContent?.trim() ?? '',
      );
      facts.homeLink = await page.$eval('a[aria-label="Kinu home"]', (element) => ({
        visible: element.getClientRects().length > 0,
        hasGraphic: element.querySelector('svg') !== null,
      }));
      await page.click('button[aria-label="Copy install command"]');
      facts.copied = await page.waitForFunction(
        () => document.querySelector('button[aria-label="Copy install command"]')?.textContent?.trim() === 'Copied',
      ).then(() => true);
      facts.deploy = await page.evaluate(() => ({
        button: document.querySelector<HTMLAnchorElement>(
          '#deploy a[href^="https://deploy.workers.cloudflare.com"]',
        )?.href ?? null,
        guide: document.querySelector<HTMLAnchorElement>(
          '#deploy a[href*="SELF-HOSTING.md"]',
        )?.href ?? null,
      }));

      facts.contrast = await page.evaluate(() => {
        const samples = [
          ['hero title', 'h1'],
          ['hero body', '#top p'],
          ['cloud title', '#platform article h3'],
          ['cloud body', '#platform article p'],
          ['local heading', '[data-showcase="tui"] h2'],
          ['workspace body', '[data-landing-frame="checkout"] [data-workspace-panel] p'],
          ['terminal body', '[data-showcase="tui"] p'],
          ['section title', '#platform h2'],
          ['section body', '#platform p'],
          ['primary action', '#top a[href="/login"]'],
        ] as const;

        const background = (node: Element): string => {
          for (let element: Element | null = node; element !== null; element = element.parentElement) {
            const colour = getComputedStyle(element).backgroundColor;

            if (colour !== 'rgba(0, 0, 0, 0)' && colour !== 'transparent') return colour;
          }

          return getComputedStyle(document.body).backgroundColor;
        };

        return samples.flatMap(([what, selector]) => {
          const element = document.querySelector(selector);

          if (element === null) return [];
          const style = getComputedStyle(element);

          return [{ what, ink: style.color, paper: background(element), size: parseFloat(style.fontSize) }];
        });
      }).then((rows) => rows.map((row) => ({
        what: row.what,
        size: row.size,
        ratio: contrastRatio(parseRgb(row.ink), parseRgb(row.paper)),
      })));
      await page.close();
    }

    {
      const page = await openLanding(DESKTOP, true);
      const before = await page.evaluate(() => document.querySelector('h1')?.textContent ?? '');
      await new Promise((resolve) => setTimeout(resolve, 1600));
      const after = await page.evaluate(() => document.querySelector('h1')?.textContent ?? '');
      facts.reduced = {
        before,
        after,
        pixels: await opaqueCanvasPixels(page),
        animations: await page.evaluate(
          () => document.getAnimations().filter((animation) => animation.playState === 'running').length,
        ),
      };
      // Under reduced motion the walkthrough never plays: the frame holds its
      // settled state, publishes no cursor, and does not advance. The pause
      // below is wall-clock on purpose: only the platform clock can prove a
      // rAF-driven movie did not advance, and fake timers cannot reach the
      // browser's frame loop from this process.
      await page.waitForSelector('[data-landing-frame="plan"][data-movie-settled="true"] [data-slate-dashboard]', { timeout: 15_000 });
      const movieT0 = await page.evaluate(() => window.__kinuLandingMovie?.state());
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const movieT1 = await page.evaluate(() => window.__kinuLandingMovie?.state());

      const reducedBits = await page.evaluate(() => ({
        settled: document.querySelector('[data-landing-frame="plan"]')?.getAttribute('data-movie-settled') === 'true',
        cursor: document.querySelector('[data-landing-frame="plan"] [data-movie-cursor]') !== null,
        slate: document.querySelector('[data-landing-frame="plan"] [data-slate-dashboard]') !== null,
        decided: document.querySelector('[data-landing-frame="plan"] [data-plan-status]')?.textContent === 'Approved',
      }));

      facts.movieReduced = {
        ...reducedBits,
        frozen: movieT0 !== undefined && movieT1 !== undefined
          && movieT0.t === movieT1.t && movieT0.playing === false && movieT1.playing === false,
      };
      await page.close();
    }

    for (const [label, size] of LANDING_WIDTHS) {
      const page = await openLanding(size);
      // documentElement.scrollWidth CANNOT see this defect class: the landing
      // root is overflow-x-clip, so an oversized child creates no scrollable
      // overflow and the browser just cuts it. Prove containment per element:
      // a box may leave the viewport only under an ancestor that itself fits
      // and either scrolls (overflow-x auto/scroll) or is a single-line
      // ellipsis truncation. Everything else is silent clipping.
      facts.landingOverflow[label] = await page.evaluate(() => {
        const viewport = document.documentElement.clientWidth;

        const contained = (start: Element): boolean => {
          for (let node = start.parentElement; node !== null && node !== document.body; node = node.parentElement) {
            const style = getComputedStyle(node);
            const scrollable = style.overflowX === 'auto' || style.overflowX === 'scroll';

            const truncation = (style.overflowX === 'hidden' || style.overflowX === 'clip')
              && style.textOverflow === 'ellipsis';

            if (!scrollable && !truncation) continue;
            const box = node.getBoundingClientRect();

            if (box.left >= -1 && box.right <= viewport + 1) return true;
          }

          return false;
        };

        const worst: string[] = [];
        const cutWorst: string[] = [];

        for (const element of document.querySelectorAll('main *, header *, footer *')) {
          const box = element.getBoundingClientRect();

          if (box.width === 0 || box.height === 0) continue;

          if ((box.right > viewport + 1 || box.left < -1) && !contained(element)) {
            worst.push(`${element.tagName.toLowerCase()}.${element.className.toString().slice(0, 60)} [${String(Math.round(box.left))},${String(Math.round(box.right))}]`);
          }

          // The second half of the same defect, which the viewport axis above
          // cannot see: an element whose OWN content is wider than its box, with
          // `overflow-x: visible`, is cut by whichever ancestor clips — no
          // ellipsis to say so and nothing to scroll. Its box may sit entirely
          // inside the viewport, so containment is not the question here.
          const style = getComputedStyle(element);

          if (style.overflowX !== 'visible' || element.scrollWidth <= element.clientWidth + 2) continue;

          if (!contained(element)) {
            cutWorst.push(`${element.tagName.toLowerCase()}.${element.className.toString().slice(0, 60)} [${String(element.clientWidth)}<${String(element.scrollWidth)}]`);
          }
        }

        return {
          scroll: document.documentElement.scrollWidth - viewport,
          clipped: worst.length,
          worst: worst.slice(0, 6),
          cut: cutWorst.length,
          cutWorst: cutWorst.slice(0, 6),
        };
      });

      const surfacesFit = await page.evaluate(() => {
        const viewport = document.documentElement.clientWidth;

        return [
          document.querySelector('[aria-label="Kinu workspace interface preview"]'),
          document.querySelector('[data-landing-frame="plan"]'),
          document.querySelector('[data-landing-frame="slate"]'),
          document.querySelector('[aria-label="Kinu terminal interface preview"]'),
          document.querySelector('[aria-label="Kinu command line preview"]'),
        ].every((element) => {
          const box = element?.getBoundingClientRect();

          return box !== undefined && box.left >= -1 && box.right <= viewport + 1;
        });
      });

      expect(surfacesFit, `landing@${label}: a preview left the viewport`).toBeTrue();

      if (label === '390') {
        facts.landingTargets = await page.evaluate(() => [
          ...document.querySelectorAll('#top a[href="/login"], #top a[href="#deploy"]'),
        ].map((element) => Math.round(element.getBoundingClientRect().height)));
        facts.railPhoneHidden = await page.evaluate(() => {
          const asides = [...document.querySelectorAll('[data-landing-frame] > aside')];

          return asides.length === 3
            && asides.every((aside) => getComputedStyle(aside).display === 'none');
        });
      }

      if (label === '1568' || label === '1920' || label === '2560' || label === '3840') {
        facts.wideColumns[label] = await page.$eval(
          '#platform',
          (element) => Math.round(element.getBoundingClientRect().width),
        );
      }

      await page.close();
    }

    for (const frame of PUBLIC_FRAMES) {
      for (const theme of THEMES) {
        for (const [label, size] of [['390', PHONE], ['1280', DESKTOP]] as const) {
          const page = await openPublic(frame, theme, size);
          facts.publicOverflow[`${frame}@${theme.mode}@${label}`] = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );

          if (frame === 'login' && theme.mode === 'dark' && label === '390') {
            facts.publicTargets = await page.evaluate(() => [
              ...document.querySelectorAll('a.provider, a.btn, button'),
            ].filter((element) => element.getClientRects().length > 0)
              .map((element) => Math.round(element.getBoundingClientRect().height)));
          }

          if (frame === 'login' && theme.mode === 'dark' && label === '1280') {
            facts.providers = await page.evaluate(() => [
              ...document.querySelectorAll<HTMLAnchorElement>('a.provider'),
            ].map((element) => element.getAttribute('href') ?? ''));
            facts.loginLayout = await page.evaluate(() => {
              const viewportCenter = document.documentElement.clientWidth / 2;
              const card = document.querySelector('.card')?.getBoundingClientRect();
              const bar = document.querySelector('.bar-inner')?.getBoundingClientRect();

              return {
                dialog: document.querySelector('[role="dialog"]')?.getAttribute('aria-modal') === 'true',
                cardOffset: Math.abs((card?.left ?? 0) + (card?.width ?? 0) / 2 - viewportCenter),
                barOffset: Math.abs((bar?.left ?? 0) + (bar?.width ?? 0) / 2 - viewportCenter),
                footer: document.querySelector('footer') !== null,
              };
            });
          }

          await page.close();
        }
      }
    }
  });
}, 180_000);

describe('the standalone landing runs', () => {
  test('the settled graph keeps flowing without restarting its reveal', () => {
    expect(required(facts.treeFlows, 'settled tree motion')).toBeTrue();
  });

  test('the abstract tree cuts pruned branches before their descendants', () => {
    expect(required(facts.prunedNodes, 'pruned branch count')).toBeGreaterThan(3);
    expect(required(facts.hiddenNodes, 'hidden descendant count')).toBeGreaterThan(0);
    expect(required(facts.heroGraphWidth, 'hero graph width')).toBeGreaterThan(620);
  });

  test('reduced motion serves one settled result', () => {
    const reduced = required(facts.reduced, 'reduced-motion page');
    expect(reduced.before).toBe(reduced.after);
    expect(reduced.before.length).toBeGreaterThan(12);
    expect(reduced.pixels).toBeGreaterThan(20);
    expect(reduced.animations).toBe(0);
  });

  test('the workspace, terminal, and CLI are visible and distinct', () => {
    const workspace = required(facts.workspace, 'workspace preview');
    const tui = required(facts.tui, 'terminal preview');
    const cli = required(facts.cli, 'CLI preview');

    for (const surface of [workspace, tui, cli]) {
      expect(surface.present).toBeTrue();
      expect(surface.width).toBeGreaterThan(500);
    }

    expect(workspace.height).toBeGreaterThan(600);
    expect(tui.height).toBeGreaterThan(600);
    expect(cli.height).toBeGreaterThan(150);
    expect(new Set([workspace.text, tui.text, cli.text]).size).toBe(3);
  });

  test('workspace, plan, slate, TUI, CLI, and evolution controls change their surfaces', () => {
    const interactions = required(facts.interactions, 'landing interactions');
    expect(interactions.workspace).toBeTrue();
    expect(interactions.decision).toBeTrue();
    expect(interactions.plan).toBeTrue();
    expect(interactions.slate).toBeTrue();
    expect(interactions.tui).toBeTrue();
    expect(interactions.cli).toBeTrue();
    expect(interactions.evolution).toBeTrue();
  });
});

describe('the landing frames reuse the app rail', () => {
  test('every workspace frame shows the app rail populated at desktop width', () => {
    const rail = required(facts.rail, 'frame rail');
    expect(rail.frames).toBe(3);

    for (const classes of rail.classes) {
      expect(classes).toBe('hidden w-60 shrink-0 h-full p-sidebar border-r p-border md:block');
    }

    expect(rail.visible).toBeTrue();
    expect(rail.roster).toContain('Checkout coupon bug');
    expect(rail.roster).toContain('ashish@example.com');
  });

  test('the rail hides below md the way the app hides it', () => {
    expect(facts.railPhoneHidden).toBeTrue();
  });
});

describe('the plan frame walks through the session', () => {
  test('the request types into the composer before anything else exists', () => {
    expect(required(facts.movie, 'walkthrough').typing).toBeTrue();
  });

  test('tool calls stream into the transcript the way a real turn renders', () => {
    expect(required(facts.movie, 'walkthrough').tools).toBeTrue();
  });

  test('the plan pops up in the right panel with Approve live', () => {
    expect(required(facts.movie, 'walkthrough').decisions).toEqual([
      { label: 'Request changes', disabled: true },
      { label: 'Approve & implement', disabled: false },
    ]);
  });

  test('the cursor approves and the slate opens in its own tab', () => {
    const movie = required(facts.movie, 'walkthrough');
    expect(movie.cursorShown).toBeTrue();
    expect(movie.decided).toBeTrue();
    expect(movie.slate).toBeTrue();
    expect(movie.settled).toBeTrue();
  });

  test('reduced motion holds the settled state with no cursor and no playback', () => {
    const reduced = required(facts.movieReduced, 'reduced-motion walkthrough');
    expect(reduced.settled).toBeTrue();
    expect(reduced.cursor).toBeFalse();
    expect(reduced.slate).toBeTrue();
    expect(reduced.decided).toBeTrue();
    expect(reduced.frozen).toBeTrue();
  });
});

describe('the hero heading names its rotation', () => {
  test('the h1 accessible name contains every visible phrase', () => {
    const hero = required(facts.heroA11y, 'hero heading');
    expect(hero.phrases.length).toBeGreaterThan(1);

    for (const phrase of hero.phrases) {
      expect(phrase.length).toBeGreaterThan(0);
      expect(hero.label).toContain(phrase.replace(/\.$/, ''));
    }
  });
});

describe('public actions work', () => {
  test('the install command uses this origin and copies', () => {
    expect(required(facts.command, 'install command')).toBe(
      `curl -fsSL '${origin}/install.sh' | bash`,
    );
    expect(facts.copied).toBeTrue();
  });

  test('the wordmark links home and has a visible graphic', () => {
    expect(required(facts.homeLink, 'home link')).toEqual({ visible: true, hasGraphic: true });
  });

  test('self-host actions reach the deploy flow and guide', () => {
    const deploy = required(facts.deploy, 'self-host links');
    expect(deploy.button).toBe(
      'https://deploy.workers.cloudflare.com/?url=https://github.com/AshishKumar4/kinu',
    );
    expect(deploy.guide).toContain('/docs/SELF-HOSTING.md');
  });

  test('each configured sign-in provider starts OAuth', () => {
    const providers = required(facts.providers, 'sign-in providers');
    expect(providers.length).toBeGreaterThan(0);

    for (const href of providers) expect(href).toMatch(/^\/auth\/[^/]+\/start/);
  });

  test('sign in is a centered modal under one centered header', () => {
    const layout = required(facts.loginLayout, 'sign-in layout');
    expect(layout.dialog).toBeTrue();
    expect(layout.cardOffset).toBeLessThanOrEqual(1);
    expect(layout.barOffset).toBeLessThanOrEqual(1);
    expect(layout.footer).toBeFalse();
  });
});

describe('public pages are responsive', () => {
  test('the landing fits every required viewport', () => {
    for (const [where, integrity] of Object.entries(facts.landingOverflow)) {
      expect(integrity.scroll, `landing@${where} scrolls sideways`).toBeLessThanOrEqual(0);
      expect(
        integrity.clipped,
        `landing@${where} silently clips: ${integrity.worst.join(' · ')}`,
      ).toBe(0);
      expect(
        integrity.cut,
        `landing@${where} cuts its own content: ${integrity.cutWorst.join(' · ')}`,
      ).toBe(0);
    }
  });

  test('utility pages fit both colour modes', () => {
    for (const [where, overflow] of Object.entries(facts.publicOverflow)) {
      expect(overflow, where).toBeLessThanOrEqual(0);
    }
  });

  test('primary phone actions remain usable', () => {
    for (const height of required(facts.landingTargets, 'landing phone targets')) {
      expect(height).toBeGreaterThanOrEqual(36);
    }

    for (const height of required(facts.publicTargets, 'public phone targets')) {
      expect(height).toBeGreaterThanOrEqual(34);
    }
  });

  test('the wide landing keeps its intended measure', () => {
    // The shell is `clamp(82.5rem, 68vw, 120rem)`: the editorial 1320px column
    // (1240 inside its 40px gutters) holds through 1920, then 2K/4K screens
    // spend their real estate — 68vw at 2560, capped at 120rem for 4K — while
    // copy blocks keep their own max-width.
    const expected = { '1568': 1240, '1920': 1240, '2560': 1661, '3840': 1840 };

    for (const [where, target] of Object.entries(expected)) {
      const width = required(facts.wideColumns[where], `measured width @${where}`);
      expect(Math.abs(width - target), `${where}: measured ${String(width)}`).toBeLessThanOrEqual(2);
    }
  });
});

describe('rendered landing text is readable', () => {
  test('sampled roles meet WCAG AA on their actual surfaces', () => {
    expect(facts.contrast.length).toBeGreaterThanOrEqual(8);

    for (const { what, ratio, size } of facts.contrast) {
      expect(ratio, `${what} at ${String(size)}px`).toBeGreaterThanOrEqual(size >= 24 ? 3 : 4.5);
    }
  });
});
