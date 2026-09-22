import { beforeAll, describe, expect, test } from 'bun:test';
import type { Page } from 'puppeteer';

import { withGallery, type Gallery } from './gallery-harness';
import { THEMES, type Theme } from './computed-style';

// The shared contract is dependency-free: this gate reads the handle shape
// and its `declare global` without typechecking the timeline's
// component-land imports, and the drive cannot drift from the product's own
// declaration.
import type { LandingMovieHandle } from '@kinu.run/core';
// The inspector's own default width, read from the policy the frames now
// inherit rather than restated as a number this gate believes in.
import { INSPECTOR_DEFAULT_PX } from '@kinu.run/core/web/inspector-layout';

// The hero's own `declare global` lives under packages/cf-backend and is out
// of this gate's program, so the handle is named here instead.
interface SearchTreeHandle {
  renderer(): 'webgpu' | 'canvas' | 'static' | 'pending';
  time(): number;
  forceFault?(error: Error): void;
}

declare global {
  interface Window {
    /** Constructed by SearchTreeHero's mount when the mount lands, which the
     *  suite's `data-settled` waits observe before reading it. */
    __kinuSearchTree?: SearchTreeHandle;
    /** The device the WebGPU row's own init script keeps hold of, so the row
     *  can destroy it and watch the mount rebind to canvas. */
    __kinuHeroDevice?: { destroy(): void };
    /** The late-chunk row's own reading, taken in the page: `null` until the
     *  drive it starts settles, then whether the plan frame kept its decisions. */
    __lateChunk?: { decisions: boolean | null };
  }
}

const PHONE = { width: 390, height: 844 } as const;

const DESKTOP = { width: 1280, height: 900 } as const;

/** The app's open rail lane (`w-60`), which every frame's rail lane is. */
const RAIL_LANE_PX = 240;

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

/**
 * The measurement itself, run IN the page — passed to `page.evaluate`, so it
 * closes over nothing and every name in it is a browser global.
 *
 * Two axes. `clipped`: a box that leaves the viewport with no ancestor that
 * legitimately contains it. `cut`: a box whose OWN content is wider than
 * itself, where the overflow crosses a clipping ancestor's edge — that content
 * is gone with no ellipsis to say so and nothing to scroll. An overhang that
 * lands inside every clipping ancestor is in full view and is not a defect:
 * the sidebar rail's collapse handle sits in the gutter beside its box by
 * design, and a rule that counted the overhang alone called that a cut.
 */
function widthIntegrity(): WidthIntegrity {
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

  /** Where this element's overflow is actually lost: the nearest ancestor
   *  that clips it, or null when the overflow stays in view — nothing clips,
   *  or a scrollable ancestor reaches it. */
  const clipEdge = (start: Element): number | null => {
    for (let node = start.parentElement; node !== null && node !== document.body; node = node.parentElement) {
      const overflow = getComputedStyle(node).overflowX;

      if (overflow === 'hidden' || overflow === 'clip') return node.getBoundingClientRect().right;

      if (overflow === 'auto' || overflow === 'scroll') return null;
    }

    return null;
  };

  const worst: string[] = [];
  const cutWorst: string[] = [];

  for (const element of document.querySelectorAll('main *, header *, footer *')) {
    const box = element.getBoundingClientRect();

    if (box.width === 0 || box.height === 0) continue;

    if ((box.right > viewport + 1 || box.left < -1) && !contained(element)) {
      worst.push(`${element.tagName.toLowerCase()}.${element.className.toString().slice(0, 60)} [${String(Math.round(box.left))},${String(Math.round(box.right))}]`);
    }

    const style = getComputedStyle(element);

    if (style.overflowX !== 'visible' || element.scrollWidth <= element.clientWidth + 2) continue;

    if (contained(element)) continue;
    const edge = clipEdge(element);

    // The ink's right edge: `scrollWidth` is measured from the padding box,
    // so this is where the widest content actually ends on the page.
    if (edge === null || box.left + element.scrollWidth <= edge + 1) continue;
    cutWorst.push(`${element.tagName.toLowerCase()}.${element.className.toString().slice(0, 60)} [${String(element.clientWidth)}<${String(element.scrollWidth)}]`);
  }

  return {
    scroll: document.documentElement.scrollWidth - viewport,
    clipped: worst.length,
    worst: worst.slice(0, 6),
    cut: cutWorst.length,
    cutWorst: cutWorst.slice(0, 6),
  };
}

interface RailFact {
  readonly frames: number;
  /** Each frame's rail lane, in px: the app's open lane is `w-60`. */
  readonly lanes: readonly number[];
  readonly visible: boolean;
  readonly roster: string;
}

/**
 * The plan frame's inspector column, measured through the product's own rules
 * rather than through a height the frame picked: which tabs `surfaceHasContent`
 * leaves on the strip for the sample's `tabPresence`, and what `decideInspector`
 * does with a column that has nothing to show yet.
 */
interface ShellFact {
  readonly labels: readonly string[];
  readonly widthAtStart: number;
  readonly widthOnPlan: number;
  /** The reopen handle a collapsed column leaves behind. */
  readonly expandAtStart: boolean;
  /** Every mounted workbench's panel element ids, in document order. */
  readonly panelIds: readonly string[];
}

interface HeroBackdropFact {
  /** The living search tree's host is in the DOM. */
  readonly tree: boolean;
  /** The dust layer's canvas is in the DOM and drawing. */
  readonly dust: boolean;
  /** Column tracks of the hero copy's grid: one where the copy stacks, two beside the tree. */
  readonly columns: number;
  /** The mounted backdrop's canvas holds painted pixels — the still counts: it must exist, not merely mount. */
  readonly painted: boolean;
}

interface MovieFact {
  readonly typing: boolean;
  readonly tools: boolean;
  readonly decisions: readonly { label: string; disabled: boolean }[];
  readonly cursorShown: boolean;
  readonly decided: boolean;
  readonly slate: boolean;
  readonly settled: boolean;
  /** Read while the story is mid-investigation: nothing to review yet. */
  readonly noPlanYet: { status: string | null; decisions: boolean; plansList: boolean };
  /** Read after seeking back to 0: the decided plan must leave the pane. */
  readonly cleared: { status: string | null; plansList: boolean };
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
  /** Which renderer the hero mount landed on, and the canvas's own answer. */
  heroMount?: { renderer?: string; canvasRenderer?: string };
  workspace?: SurfaceFact;
  tui?: SurfaceFact;
  cli?: SurfaceFact;
  interactions?: { workspace: boolean; decision: boolean; plan: boolean; slate: boolean; tui: boolean; cli: boolean; evolution: boolean };
  command?: string;
  copied?: boolean;
  rail?: RailFact;
  railPhoneHidden?: boolean;
  /** Which backdrop the hero mounted at a width, beside how many columns the copy's grid has there. */
  heroBackdrop: Record<string, HeroBackdropFact>;
  movie?: MovieFact;
  shell?: ShellFact;
  movieReduced?: MovieReducedFact;
  heroA11y?: { label: string; phrases: string[] };
  persists?: { text: string; caption: string };
  heroTreeText?: { text: string };
  checkoutLead?: { firstIsProse: boolean; firstIsTool: boolean };
  homeLink?: { visible: boolean; hasGraphic: boolean };
  deploy?: { button: string | null; guide: string | null };
  providers?: string[];
  loginLayout?: { dialog: boolean; cardOffset: number; barOffset: number; footer: boolean };
  landingOverflow: Record<string, WidthIntegrity>;
  /** The `cut` rule measured in both directions on one page: the landing's
   *  own count, that count with a clipped row injected, and with an overhang
   *  that nothing clips. */
  integrityRule?: { base: number; clipped: number; overhang: number };
  /** The plan beat with its renderer held back on the wire: whether the beat
   *  held when the seek resolved. */
  lateChunk?: { decisionsOnReturn: boolean };
  publicOverflow: Record<string, number>;
  landingTargets?: number[];
  publicTargets?: number[];
  wideColumns: Record<string, number>;
  contrast: Contrast[];
}

let newPage: Gallery['newPage'];

let origin: string;

const facts: Facts = {
  heroBackdrop: {},
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
  /** Installed on the page BEFORE it loads — a row that has to shape the
   *  network (a chunk held back) cannot do it after the first request. */
  prepare?: (page: Page) => Promise<void>,
): Promise<Page> {
  const page = await newPage();
  await page.setViewport(size);
  await page.emulateMediaFeatures([
    { name: 'prefers-color-scheme', value: 'dark' },
    { name: 'prefers-reduced-motion', value: reducedMotion ? 'reduce' : 'no-preference' },
  ]);
  await prepare?.(page);
  await page.bringToFront();
  await page.goto(`${origin}/landing.html`, { waitUntil: 'networkidle0' });
  // Mutation-observed, not raf-polled: the h1 mounts inside one React commit,
  // and under a six-gate wave a rAF-driven predicate can be starved long enough
  // to report absence on a mounted page. The observer fires on the insertion
  // itself, so the wait measures the DOM event, never the scheduler.
  await page.waitForFunction(
    () => document.querySelector('h1') !== null,
    { polling: 'mutation' },
  );

  return page;
}

async function openPublic(
  frame: string,
  theme: Theme,
  size: { width: number; height: number },
): Promise<Page> {
  const page = await newPage();
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
  }, { polling: 100 });

  return Number(await handle.jsonValue());
}

beforeAll(async () => {
  await withGallery(async (gallery) => {
    newPage = gallery.newPage;
    origin = gallery.origin;

    {
      const page = await openLanding(DESKTOP);
      await page.waitForSelector('canvas[data-settled="true"]');
      facts.prunedNodes = await page.$eval('canvas', (canvas) => Number(canvas.dataset.pruned ?? 0));
      facts.hiddenNodes = await page.$eval('canvas', (canvas) => Number(canvas.dataset.hidden ?? 0));
      facts.heroGraphWidth = await page.$eval('[data-hero-graph]', (graph) => (
        Math.round(graph.getBoundingClientRect().width)
      ));
      // The mount's own answer: which renderer took the canvas, and that the
      // canvas carries the same answer — the mount landed, whatever it landed on.
      facts.heroMount = await page.evaluate(() => ({
        renderer: window.__kinuSearchTree?.renderer(),
        canvasRenderer: document.querySelector('canvas')?.dataset.renderer,
      }));
      const settledTree = await page.$eval('canvas', (canvas) => canvas.toDataURL());
      await page.waitForFunction(
        (previous: string) => document.querySelector('canvas')?.toDataURL() !== previous,
        { polling: 100 },
        settledTree,
      );
      facts.treeFlows = await page.$eval('canvas', (canvas, first) => (
        canvas.dataset.settled === 'true' && canvas.toDataURL() !== first
      ), settledTree);
      const headline = await page.$eval('h1', (element) => ({ height: element.getBoundingClientRect().height, label: element.getAttribute('aria-label') }));
      const phrase = await page.$eval('[data-typewriter]', (element) => element.textContent);
      await page.waitForFunction((previous) => document.querySelector('[data-typewriter]')?.textContent !== previous, {}, phrase);
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
      await page.waitForSelector('[data-landing-frame="checkout"] textarea');
      // The plan frame is the walkthrough movie, driven through its own
      // handle: at load it holds the story's start (an empty composer), and
      // each beat below seeks it before asserting that beat's DOM.
      await page.waitForFunction(() => window.__kinuLandingMovie !== undefined);
      await page.waitForSelector('[data-landing-frame="slate"] [data-slate-dashboard]');
      await page.evaluate(() => {
        const root = document.querySelector('[data-landing-frame="checkout"]');

        const supervise = [...(root?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])]
          .find((button) => button.textContent?.trim() === 'Supervise');

        supervise?.click();
      });
      await page.waitForFunction(
        () => document.querySelector('[data-landing-frame="checkout"]')?.getAttribute('data-workspace-mode') === 'supervise'
          && document.querySelector('[data-workspace-panel="supervise"]')?.textContent?.includes('Automations') === true,
      );
      await page.evaluate(() => {
        const root = document.querySelector('[data-landing-frame="checkout"]');

        const work = [...(root?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])]
          .find((button) => button.textContent?.trim() === 'Work');

        work?.click();
      });
      await page.waitForSelector('[data-landing-frame="checkout"] button[aria-label="Retry"]');
      await page.click('[data-landing-frame="checkout"] button[aria-label="Retry"]');
      await page.waitForFunction(
        () => document.querySelector('[data-landing-frame="checkout"]')?.textContent?.includes('Retried as') === true,
      );

      // Only the cue table crosses the boundary — the handle's methods are
      // not serializable, so asking for it would read a lie.
      const cues = await page.evaluate(
        (): LandingMovieHandle['cues'] | undefined => window.__kinuLandingMovie?.cues,
      );

      if (cues === undefined) throw new Error('the walkthrough publishes no cues');

      const seek = (at: number): Promise<void> => page.evaluate(async (seekTo: number) => {
        await window.__kinuLandingMovie?.seek(seekTo);
      }, at);

      // The rail rides every workspace frame, populated through the real
      // roster transport, marked on the frame's own workspace. `SidebarRail`
      // is the app's own lane, so the measurement is the lane, not a class
      // string that says nothing about what the reader sees.
      facts.rail = await page.evaluate(() => {
        const frames = [...document.querySelectorAll('[data-landing-frame]')];
        const asides = frames.map((frame) => frame.querySelector(':scope > aside[data-rail]'));
        const first = asides[0];

        return {
          frames: asides.filter((aside) => aside !== null).length,
          lanes: asides.map((aside) => Math.round(aside?.getBoundingClientRect().width ?? 0)),
          visible: first !== null
            && first !== undefined
            && getComputedStyle(first).display !== 'none'
            && first.getClientRects().length > 0,
          roster: first?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        };
      });

      // The plan frame at its first beat: the strip carries exactly the tabs
      // the sample has content for, and the column the product would shut on a
      // workspace with nothing to inspect is shut — a measured zero, before any
      // seek moves the story on.
      const readShell = () => page.evaluate(() => {
        const frame = document.querySelector('[data-landing-frame="plan"]');
        const column = frame?.querySelector('[data-panel][id^="inspector"]');
        const strip = column?.querySelector('.p-tabstrip');

        return {
          labels: [...(strip?.querySelectorAll('button') ?? [])]
            .map((button) => (button.textContent ?? '').trim())
            .filter((label) => label.length > 0),
          width: Math.round(column?.getBoundingClientRect().width ?? -1),
          expand: frame?.querySelector('[data-inspector-expand]') !== null,
          panelIds: [...document.querySelectorAll('[data-panel]')].map((panel) => panel.id),
        };
      });

      const shellAtStart = await readShell();
      // The request types into the real composer before anything else exists.
      await seek((cues.typeStart + cues.sent) / 2);
      await page.waitForFunction(() => {
        const area = document.querySelector('[data-landing-frame="plan"] textarea');

        return area instanceof HTMLTextAreaElement && area.value.length > 0;
      });

      const typing = await page.$eval('[data-landing-frame="plan"] textarea', (area) => (
        area instanceof HTMLTextAreaElement ? area.value : ''
      ));

      // The agent's tool calls stream into the transcript the way a real turn
      // renders them — and before the plan exists the Work pane must not
      // advertise one: the Plans read serves the timeline's plan, not a
      // fixture's.
      await seek(cues.searchDone + 100);

      const noPlanYet = await page.evaluate(() => {
        const frame = document.querySelector('[data-landing-frame="plan"]');

        return {
          status: frame?.querySelector('[data-plan-status]')?.textContent ?? null,
          decisions: frame?.querySelector('[data-plan-decisions]') !== null,
          plansList: frame?.querySelector('[data-work-plans]') !== null,
        };
      });

      await page.waitForFunction(() => (
        document.querySelector('[data-landing-frame="plan"] [data-tool-group]') !== null
        && document.querySelector('[data-landing-frame="plan"]')?.textContent?.includes('apply-coupon') === true
      ));
      // The plan pops up in the right-hand panel with Approve live: the movie
      // submits a clean plan, so Request changes stays disabled.
      await seek(cues.planReady + 200);
      await page.waitForSelector('[data-landing-frame="plan"] [data-plan-decisions]');

      const decisions = await page.$$eval('[data-landing-frame="plan"] [data-plan-decisions] button', (buttons) => (
        buttons.map((button) => ({ label: button.textContent?.trim() ?? '', disabled: button.disabled }))
      ));

      // The plan's arrival is what opens the column — the same signal the
      // product opens it on. Awaited, not sampled: the decision lands on a
      // committed layout.
      await page.waitForFunction(() => {
        const column = document.querySelector('[data-landing-frame="plan"] [data-panel][id^="inspector"]');

        return column !== null && column.getBoundingClientRect().width > 0;
      });

      const shellOnPlan = await readShell();

      facts.shell = {
        labels: shellAtStart.labels,
        widthAtStart: shellAtStart.width,
        widthOnPlan: shellOnPlan.width,
        expandAtStart: shellAtStart.expand,
        panelIds: shellAtStart.panelIds,
      };

      // The cursor's click approves through the product's own decision path.
      await seek(cues.approve + 200);
      await page.waitForFunction(() => (
        document.querySelector('[data-landing-frame="plan"] [data-plan-status]')?.textContent === 'Approved'
      ));

      const cursorShown = await page.$eval('[data-landing-frame="plan"] [data-movie-cursor]', (cursor) => (
        getComputedStyle(cursor).opacity !== '0'
      ));

      // The build lands a slate, opened in its own tab: the settled state.
      await seek(cues.end);
      await page.waitForSelector('[data-landing-frame="plan"] [data-slate-dashboard]');

      const settled = await page.$eval('[data-landing-frame="plan"]', (frame) => (
        frame.getAttribute('data-movie-settled') === 'true'
      ));

      // Seeking back to the story's start clears the plan the pane served:
      // the read model and the pane share one source. The Plans read refires
      // on the cleared prop, so the empty answer is awaited, not sampled.
      await seek(0);
      await page.waitForFunction(() => (
        document.querySelector('[data-landing-frame="plan"] [data-plan-status]') === null
        && document.querySelector('[data-landing-frame="plan"] [data-work-plans]') === null
      ));

      const cleared = { status: null, plansList: false };

      // The clear check parked the story at t0 with no plan under review;
      // the interactions read still asserts the approved one, so the pane
      // has to re-decide it: seek the review back in, then a real click on
      // the product's Approve runs decidePlanReview again.
      await seek(cues.planReady + 200);
      await page.waitForSelector(
        '[data-landing-frame="plan"] [data-plan-decisions] button:not([disabled])',
      );
      await page.evaluate(() => {
        const stage = document.querySelector('[data-landing-frame="plan"]');

        const approve = [...(stage?.querySelectorAll<HTMLButtonElement>('[data-plan-decisions] button') ?? [])]
          .find((button) => !button.disabled && /approve/i.test(button.textContent ?? ''));

        approve?.click();
      });
      await page.waitForFunction(() => (
        document.querySelector('[data-landing-frame="plan"] [data-plan-status]')?.textContent === 'Approved'
      ));

      facts.movie = {
        typing: typing.length > 0,
        tools: true,
        decisions,
        cursorShown,
        decided: true,
        slate: true,
        settled,
        noPlanYet,
        cleared,
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
        button: document.querySelector<HTMLAnchorElement>('#deploy a[href="/deploy"]')?.href ?? null,
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

      facts.persists = await page.evaluate(() => ({
        text: document.querySelector('[data-landing-persists]')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        // The checkout frame's own caption, behind the same stable hook the
        // card used to carry.
        caption: document.querySelector('[data-landing-caption]')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      }));

      facts.heroTreeText = await page.evaluate(() => ({
        text: document.querySelector('#top p.sr-only')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      }));

      facts.checkoutLead = await page.evaluate(() => {
        const root = document.querySelector('[data-landing-frame="checkout"]');

        const assistants = [...(root?.querySelectorAll('div.animate-fade-in') ?? [])]
          .filter((node) => node.querySelector('.prose-chat, [data-tool-group]') !== null);

        // The lead is whichever content comes first in document order, not
        // the first child of some wrapper: how the blocks are boxed is layout.
        const lead = assistants[0]?.querySelector('.prose-chat, [data-tool-group]') ?? null;

        return {
          firstIsProse: lead?.classList.contains('prose-chat') === true,
          firstIsTool: lead?.hasAttribute('data-tool-group') === true,
        };
      });
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
      await page.waitForSelector('[data-landing-frame="plan"][data-movie-settled="true"] [data-slate-dashboard]');
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
      // overflow and the browser just cuts it. `widthIntegrity` proves
      // containment per element instead, on both axes.
      facts.landingOverflow[label] = await page.evaluate(widthIntegrity);

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

      if (label === '390' || label === '1280') {
        // The backdrop swaps at the width where the copy's grid gains its
        // second column: a phone must never mount the tree (it runs through
        // the stacked paragraph) and a desktop must never mount the dust.
        await page.waitForSelector('[data-hero-graph] canvas[data-renderer], [data-hero-dust] canvas[data-renderer]');
        // Mounted is not drawn: the still counts as the backdrop, so the
        // canvas must hold painted pixels, whichever renderer owns it.
        await page.waitForFunction(() => {
          const canvas = document.querySelector('[data-hero-graph] canvas, [data-hero-dust] canvas');

          if (!(canvas instanceof HTMLCanvasElement)) return false;
          const context = canvas.getContext('2d');

          if (context === null || canvas.width === 0 || canvas.height === 0) return false;
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;

          for (let index = 3; index < pixels.length; index += 4) {
            if (pixels[index] !== 0) return true;
          }

          return false;
        }, { polling: 100 });
        facts.heroBackdrop[label] = await page.evaluate(() => {
          const grid = document.querySelector('#top [class*="lg:grid-cols-"]');

          return {
            tree: document.querySelector('[data-hero-graph]') !== null,
            dust: document.querySelector('[data-hero-dust] canvas')?.getAttribute('data-renderer') === 'canvas',
            columns: grid === null ? 0 : getComputedStyle(grid).gridTemplateColumns.split(' ').length,
            painted: true,
          };
        });
      }

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

    // The `cut` rule's own two directions, proved on a page rather than
    // asserted about. A row whose content runs past a clipping ancestor's
    // edge is cut; a decoration that overhangs into the space beside its box
    // and stays inside every clipper is in full view. Both are measured
    // against the same landing page the rows above count, so the reading is
    // the delta this rule contributes and not a number about a blank page.
    {
      const page = await openLanding(DESKTOP);

      const withProbe = async (markup: string): Promise<number> => {
        await page.evaluate((inner: string) => {
          document.querySelector('#integrity-probe')?.remove();
          const host = document.createElement('div');
          host.id = 'integrity-probe';
          host.innerHTML = inner;
          document.querySelector('main')?.append(host);
        }, markup);

        return (await page.evaluate(widthIntegrity)).cut;
      };

      const base = (await page.evaluate(widthIntegrity)).cut;

      facts.integrityRule = {
        base,
        clipped: await withProbe(
          '<div style="width:120px;overflow-x:hidden">'
          + '<div style="width:80px"><span style="display:block;width:400px;height:12px"></span></div></div>',
        ),
        overhang: await withProbe(
          '<div style="width:120px;overflow-x:hidden">'
          + '<div style="position:relative;width:80px;height:20px">'
          + '<span style="position:absolute;right:-10px;top:0;width:20px;height:12px"></span></div></div>',
        ),
      };
      await page.close();
    }

    // The plan beat's renderer is a lazy chunk, held on the wire here until
    // the drive has had more frames than any budget it could have carried.
    // What the seek PROMISES is that the beat holds when it resolves — it
    // awaits the chunk's own promise, so nothing downstream waits again. A
    // 90-frame budget resolved first and parked the story at t=6400 with no
    // plan on screen, and every later beat then measured a movie that had
    // stopped. The hold is counted in FRAMES because the defect was written
    // in frames: only a hold that outlasts a budget tells the two drives
    // apart.
    {
      const requested = Promise.withResolvers<void>();

      // Every held request, because the chunk has two importers: the drive's
      // own `import()` and the lazy boundary that renders it. Rollup answers
      // the second with a facade that re-exports the first, so both are the
      // same module and both have to be let go.
      const held: (() => Promise<void>)[] = [];

      const page = await openLanding(DESKTOP, false, async (target) => {
        await target.setRequestInterception(true);
        target.on('request', async (request) => {
          if (!/PlanReviewView-/u.test(request.url())) {
            await request.continue();

            return;
          }

          held.push(() => request.continue());
          requested.resolve();
        });
      });

      const cues = await page.evaluate(() => window.__kinuLandingMovie?.cues);

      if (cues === undefined) throw new Error('the walkthrough publishes no cues');
      // Driven, not awaited: the beat's own state at the moment the seek
      // resolves is the reading, and it is taken in the page. A drive that
      // rejects reads as a beat that did not hold, which is this row's red.
      await page.evaluate((at: number) => {
        window.__lateChunk = { decisions: null };
        window.__kinuLandingMovie?.seek(at).then(
          () => {
            window.__lateChunk = {
              decisions: document.querySelector('[data-landing-frame="plan"] [data-plan-decisions]') !== null,
            };
          },
          () => { window.__lateChunk = { decisions: false }; },
        );
      }, cues.planReady + 200);

      await requested.promise;
      await page.evaluate(() => {
        const { promise, resolve } = Promise.withResolvers<void>();
        let frames = 0;

        const tick = (): void => {
          frames += 1;

          if (frames >= 150) {
            resolve();

            return;
          }

          requestAnimationFrame(tick);
        };

        requestAnimationFrame(tick);

        return promise;
      });

      for (const release of held) await release();

      await page.waitForFunction(() => window.__lateChunk?.decisions !== null);

      facts.lateChunk = {
        decisionsOnReturn: await page.evaluate(() => window.__lateChunk?.decisions === true),
      };
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
});

describe('the standalone landing runs', () => {
  test('the abstract tree cuts pruned branches before their descendants', () => {
    expect(required(facts.prunedNodes, 'pruned branch count')).toBeGreaterThan(3);
    expect(required(facts.hiddenNodes, 'hidden descendant count')).toBeGreaterThan(0);
    expect(required(facts.heroGraphWidth, 'hero graph width')).toBeGreaterThan(620);
  });

  test('the settled graph keeps flowing without restarting its reveal', () => {
    // Measured after the reveal settled: the canvas changed again under a
    // settled mark, so the picture is alive after the reveal rather than a
    // frozen still or a restarted one.
    expect(required(facts.treeFlows, 'tree flow after settle')).toBe(true);
  });

  test('the hero mount landed: the handle and the canvas name the same renderer', () => {
    const mount = required(facts.heroMount, 'hero mount');

    // WebGPU where the box has it, Canvas2D where it does not — both are the
    // mount answering an outcome; 'pending' and 'static' would mean it never
    // finished picking one.
    expect(mount.renderer).toBeOneOf(['webgpu', 'canvas']);
    expect(mount.canvasRenderer).toBe(mount.renderer);
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

  test('a device loss mid-run swaps the mount to Canvas2D and keeps the clock', async () => {
    // The REAL boundary, not a test seam: a page init script wraps
    // `GPUAdapter.requestDevice` so the GPUDevice the hero's mount obtains is
    // captured on `window`; the test then destroys it — exactly what a dead
    // device means — and the next frame() throws VGPU-DEVICE-DISPOSED into
    // the mount's fault path. Headless needs --enable-unsafe-webgpu to expose
    // navigator.gpu on this lane.
    //
    // WHICH PATH RAN IS ASSERTED, never glossed: a lane where the mount
    // landed on WebGPU must swap on the destroy; a lane where it landed on
    // canvas (no adapter, or SwiftShader gone before the destroy) has no
    // device to destroy, proves only the resting renderer, and says so. The
    // swap itself is proved on every lane by
    // packages/cf-backend/tests/unit-search-tree-mount.test.ts, through the
    // real mount over a faked vgpu.
    await withGallery(async ({ newPage: freshPage, origin: freshOrigin }) => {
      const page = await freshPage();
      await page.setViewport(DESKTOP);
      await page.evaluateOnNewDocument(() => {
        // `gpu` in navigator is the capability itself; GPUAdapter is only
        // declared to pages where the flag landed, so reading it bare would
        // throw on a lane without WebGPU.
        const adapter: Pick<GPUAdapter, 'requestDevice'> | undefined = 'gpu' in navigator ? GPUAdapter.prototype : undefined;
        const requestDevice = adapter?.requestDevice;

        if (requestDevice !== undefined) {
          GPUAdapter.prototype.requestDevice = async function (this: GPUAdapter, descriptor?: GPUDeviceDescriptor) {
            const device = await requestDevice.call(this, descriptor);
            window.__kinuHeroDevice = device;

            return device;
          };
        }
      });
      await page.goto(`${freshOrigin}/landing.html`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('canvas[data-settled="true"]');

      const landed = await page.evaluate(
        () => ({ renderer: window.__kinuSearchTree?.renderer(), time: window.__kinuSearchTree?.time() }),
      );

      const destroyed = await page.evaluate(() => {
        if (window.__kinuHeroDevice === undefined) return false;
        window.__kinuHeroDevice.destroy();

        return true;
      });

      await page.waitForFunction(() => window.__kinuSearchTree?.renderer() === 'canvas');

      const after = await page.evaluate(() => ({
        renderer: window.__kinuSearchTree?.renderer(),
        time: window.__kinuSearchTree?.time(),
        canvasRenderer: document.querySelector('canvas')?.dataset.renderer,
      }));

      // The fallback is installed and named, and the clock went on rather
      // than restarting — the simulation itself survived the swap, which is
      // the point of the mount's rebind.
      expect(after.renderer).toBe('canvas');
      expect(after.canvasRenderer).toBe('canvas');
      expect(after.time).toBeGreaterThanOrEqual(landed.time ?? 0);

      // The path that ran, asserted: a WebGPU landing had a device and it
      // was destroyed — the full real-device path, and a landing there with
      // no captured device is a harness fault. A canvas landing proves the
      // resting renderer; a device may still have been captured (SwiftShader
      // hands one out and the start fails after), so nothing is claimed of
      // the destroy there.
      if (landed.renderer === 'webgpu') expect(destroyed).toBe(true);
      console.log(`hero loss path: landed=${landed.renderer ?? 'none'} destroyed=${destroyed}`);

      await page.close();
    }, ['--enable-unsafe-webgpu']);
  });
});

describe('the landing demonstration leads with its result', () => {
  test('the crafted-tool card is gone and the frame names itself a sample', () => {
    const persists = required(facts.persists, 'persists card');
    // The owner rejected the coupon_replay card outright: no card, no reuse
    // line, and the caption that introduces the frame is the short form.
    expect(persists.text).toBe('');
    expect(persists.caption).toContain('Sample workspace');
    expect(persists.caption).not.toContain('Example UI');
  });

  test('the hero tree carries its text equivalent', () => {
    const hero = required(facts.heroTreeText, 'hero tree text');
    expect(hero.text).toBe('Kinu tries several approaches to a task, checks each, and keeps the one that passes, along with any tool it built along the way.');
  });

  test('the checkout frame leads with prose, not a tool row', () => {
    const lead = required(facts.checkoutLead, 'checkout lead block');
    expect(lead.firstIsProse).toBeTrue();
    expect(lead.firstIsTool).toBeFalse();
  });
});

describe('the landing frames reuse the app rail', () => {
  test('every workspace frame shows the app rail populated at desktop width', () => {
    const rail = required(facts.rail, 'frame rail');
    expect(rail.frames).toBe(3);

    for (const lane of rail.lanes) {
      expect(lane).toBe(RAIL_LANE_PX);
    }

    expect(rail.visible).toBeTrue();
    expect(rail.roster).toContain('Checkout coupon bug');
    expect(rail.roster).toContain('ashish@example.com');
  });

  test('the rail hides below md the way the app hides it', () => {
    expect(facts.railPhoneHidden).toBeTrue();
  });
});

describe('the landing frames mount the product shell', () => {
  test("the strip carries only the tabs the sample's tabPresence has content for", () => {
    expect(required(facts.shell, 'plan frame shell').labels).toEqual(['Work', 'Files', 'Agent', 'Env']);
  });

  test('the inspector column is shut until the plan arrives, then opens at the policy width', () => {
    const shell = required(facts.shell, 'plan frame shell');
    expect(shell.widthAtStart).toBe(0);
    expect(shell.expandAtStart).toBeTrue();
    expect(shell.widthOnPlan).toBe(INSPECTOR_DEFAULT_PX);
  });

  test("each frame's workbench owns its own panel elements", () => {
    const ids = required(facts.shell, 'plan frame shell').panelIds;
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('the hero backdrop follows the copy', () => {
  test('a phone gets the dust under one column, a desktop the tree beside two', () => {
    expect(required(facts.heroBackdrop['390'], 'phone hero backdrop')).toEqual({ tree: false, dust: true, columns: 1, painted: true });
    expect(required(facts.heroBackdrop['1280'], 'desktop hero backdrop')).toEqual({ tree: true, dust: false, columns: 2, painted: true });
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

  test('no plan is advertised before the story submits one, and seeking back clears it', () => {
    const movie = required(facts.movie, 'walkthrough');

    // Mid-investigation: no status, no decisions row, no Plans list.
    expect(movie.noPlanYet).toEqual({ status: null, decisions: false, plansList: false });
    // Back at t0 after approval: the approved plan is gone from the pane.
    expect(movie.cleared).toEqual({ status: null, plansList: false });
  });

  test('reduced motion holds the settled state with no cursor and no playback', () => {
    const reduced = required(facts.movieReduced, 'reduced-motion walkthrough');
    expect(reduced.settled).toBeTrue();
    expect(reduced.cursor).toBeFalse();
    expect(reduced.slate).toBeTrue();
    expect(reduced.decided).toBeTrue();
    expect(reduced.frozen).toBeTrue();
  });

  test('a plan renderer that lands late still holds the beat the seek returns on', () => {
    expect(
      required(facts.lateChunk, 'the late plan chunk').decisionsOnReturn,
      'the seek resolved on a plan beat with no decisions on screen',
    ).toBeTrue();
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

  test('self-host actions reach the guided door and the guide', () => {
    const deploy = required(facts.deploy, 'self-host links');
    expect(deploy.button).toMatch(/\/deploy$/);
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

  // The rule above is only worth its green if it still fails on the thing it
  // names: a row cut by a clipping ancestor counts, and an overhang that
  // stays inside every clipper does not.
  test('the cut rule counts a clipped row and spares an overhang in view', () => {
    const rule = required(facts.integrityRule, 'the cut rule in both directions');
    expect(rule.clipped, 'a row running past a clipping ancestor was not counted').toBe(rule.base + 1);
    expect(rule.overhang, 'an overhang nothing clips was counted as a cut').toBe(rule.base);
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
    // The shell is one measure, 84rem: 1264 inside its 40px gutters on every
    // screen from a device to 4K, so the page reads as one page rather than
    // growing with the viewport. Copy blocks keep their own max-width.
    const expected = { '1568': 1264, '1920': 1264, '2560': 1264, '3840': 1264 };

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
