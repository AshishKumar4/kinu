import { beforeAll, describe, expect, test } from 'bun:test';
import { TimeoutError, type Browser, type Page } from 'puppeteer';

import { withGallery } from './gallery-harness';

type Mode = 'dark' | 'light';

/** The viewer's floating action strip, as Kinu narrows it: the copy control
 *  moved into the document header, so an editable plan shows one button and a
 *  settled plan shows none — and the strip itself must then stop spending its
 *  margin above the first block. */
const ACTION_STRIP = '[data-plan-document] [data-print-region="article"] > [data-print-hide]';

interface ActionStrip {
  readonly actionStripDisplay: string;
  readonly actionStripButtons: number;
}

interface DesktopPlan extends ActionStrip {
  readonly mode: string | undefined;
  readonly title: string;
  readonly titleCodeCount: number;
  readonly headingCount: number;
  readonly titlePx: number;
  readonly sectionPx: number;
  readonly bodyPx: number;
  readonly documentWidth: number;
  readonly railInitiallyOpen: boolean;
  readonly railWidth: number;
  readonly codeLabel: string;
  readonly codeBackground: string;
  readonly pageBackground: string;
  readonly codeBorder: string;
  readonly codeOverflow: string;
  readonly overflow: number;
  readonly scrimDisplay: string;
}

interface MobilePlan {
  readonly overflow: number;
  readonly codeOverflow: string;
  readonly codeScrollable: boolean;
  readonly railPosition: string;
  readonly railWidth: number;
  readonly rootWidth: number;
  readonly footerInsideViewport: boolean;
}

interface WorkspacePlan {
  readonly title: string;
  readonly rootWidth: number;
  readonly railPosition: string;
  readonly railWidth: number;
  readonly documentWidthBefore: number;
  readonly documentWidthWithRail: number;
  readonly overflow: number;
  readonly scrimDisplay: string;
  readonly railClosedByScrim: boolean;
}

/** What the header promoted, and what the document kept. */
interface PromotedPlan {
  readonly headerTitle: string;
  readonly documentH1s: readonly string[];
  readonly firstBlockTag: string;
  readonly titleHighlights: number;
}

interface SettledPlan extends ActionStrip {
  readonly status: string;
}

interface ObservedPlan {
  readonly desktop: Record<Mode, DesktopPlan>;
  readonly mobile: MobilePlan;
  readonly workspace: WorkspacePlan;
  readonly lateHeading: PromotedPlan;
  readonly annotatedHeading: PromotedPlan;
  readonly settled: SettledPlan;
}

/**
 * Did `wait` settle before its own deadline?
 *
 * Some of what this suite measures is an affordance that can go MISSING — a
 * highlight that never paints, a scrim that dims and does not dismiss. Letting
 * the wait throw turns either into one unnamed aborted suite, so the deadline
 * becomes an observation the caller asserts on. Only a `TimeoutError` is
 * tolerated: anything else is an infrastructure fault, and a suite that
 * reported a lost affordance when the browser died would name the wrong defect.
 */
async function settledWithin(wait: Promise<unknown>): Promise<boolean> {
  try {
    await wait;
    return true;
  } catch (cause) {
    if (cause instanceof TimeoutError) return false;
    throw cause;
  }
}

async function openFrame(
  browser: Browser,
  origin: string,
  frame: string,
  mode: Mode,
  viewport: { width: number; height: number },
  params: Record<string, string> = {},
): Promise<Page> {
  const page = await browser.newPage();
  // Every implicit wait in this suite is on a SYNCHRONOUS React state change —
  // a toggle opening the rail, a toggle closing it — so a timeout on one is
  // machine contention and never a lost affordance: a broken handler fails at
  // once and on every run. Puppeteer's 30s default was measured failing once
  // in seven on a box running four other browser suites, so it is raised here
  // rather than left to read as a product defect. The two waits that ARE
  // findings keep their own shorter deadlines and report absence instead of
  // throwing — see `settledWithin`.
  page.setDefaultTimeout(60_000);
  await page.setViewport(viewport);
  await page.evaluateOnNewDocument((nextMode: Mode) => localStorage.setItem('theme', nextMode), mode);
  const query = new URLSearchParams({ frame, ...params });
  await page.goto(`${origin}/gallery.html?${query.toString()}`, { waitUntil: 'networkidle0' });
  return page;
}

async function readActionStrip(page: Page, selector: string): Promise<ActionStrip> {
  return await page.$eval(selector, (strip) => ({
    actionStripDisplay: getComputedStyle(strip).display,
    actionStripButtons: strip.querySelectorAll('button').length,
  }));
}

async function observeDesktop(browser: Browser, origin: string, mode: Mode): Promise<DesktopPlan> {
  const page = await openFrame(browser, origin, 'planreview', mode, { width: 1280, height: 900 });
  await page.waitForSelector('[data-plan-review-root]');
  const strip = await readActionStrip(page, ACTION_STRIP);
  const before = await page.evaluate(() => {
    const titleRoot = document.querySelector<HTMLElement>('[data-plan-title]');
    const title = titleRoot?.matches('h1') ? titleRoot : titleRoot?.querySelector<HTMLElement>('h1');
    const section = document.querySelector<HTMLElement>('[data-plan-document] h2');
    const body = document.querySelector<HTMLElement>('[data-plan-document] p[data-block-id]');
    const plan = document.querySelector<HTMLElement>('[data-plan-document]');
    const code = document.querySelector<HTMLElement>('[data-plan-document] pre');
    const scroll = document.querySelector<HTMLElement>('[data-plan-scroll]');
    if (!title || !section || !body || !plan || !code || !scroll) throw new Error('plan fixture did not render its document contract');
    return {
      mode: document.documentElement.dataset.mode,
      title: title.textContent ?? '',
      titleCodeCount: title.querySelectorAll('code').length,
      headingCount: document.querySelectorAll('h1').length,
      titlePx: Number.parseFloat(getComputedStyle(title).fontSize),
      sectionPx: Number.parseFloat(getComputedStyle(section).fontSize),
      bodyPx: Number.parseFloat(getComputedStyle(body).fontSize),
      documentWidth: Math.round(plan.getBoundingClientRect().width),
      railInitiallyOpen: document.querySelector('[data-annotation-panel="true"]') !== null,
      codeLabel: getComputedStyle(code, '::before').content.replace(/^['"]|['"]$/g, ''),
      codeBackground: getComputedStyle(code).backgroundColor,
      pageBackground: getComputedStyle(document.querySelector<HTMLElement>('[data-plan-review-root]')!).backgroundColor,
      codeBorder: getComputedStyle(code).borderTopStyle,
      codeOverflow: getComputedStyle(code).overflowX,
      overflow: document.documentElement.scrollWidth - innerWidth,
    };
  });

  await page.click('[data-plan-annotations-toggle]');
  await page.waitForSelector('[data-annotation-panel="true"]');
  const opened = await page.evaluate(() => {
    const rail = document.querySelector<HTMLElement>('[data-annotation-panel="true"]');
    const scrim = document.querySelector<HTMLElement>('[data-plan-scrim]');
    if (!rail || !scrim) throw new Error('the open rail did not render beside a scrim element');
    return {
      railWidth: Math.round(rail.getBoundingClientRect().width),
      scrimDisplay: getComputedStyle(scrim).display,
    };
  });
  await page.click('[data-plan-annotations-toggle]');
  await page.waitForFunction(() => document.querySelector('[data-annotation-panel="true"]') === null);
  await page.close();
  return { ...before, ...strip, ...opened };
}

async function observeMobile(browser: Browser, origin: string): Promise<MobilePlan> {
  const page = await openFrame(browser, origin, 'planreview', 'dark', { width: 390, height: 844 });
  await page.waitForSelector('[data-plan-review-root]');
  await page.$eval('[data-plan-document] pre', (code) => code.scrollIntoView({ block: 'center' }));
  const before = await page.evaluate(() => {
    const code = document.querySelector<HTMLElement>('[data-plan-document] pre');
    const footer = document.querySelector<HTMLElement>('[data-plan-footer]');
    if (!code || !footer) throw new Error('mobile plan fixture is incomplete');
    const footerBox = footer.getBoundingClientRect();
    return {
      overflow: document.documentElement.scrollWidth - innerWidth,
      codeOverflow: getComputedStyle(code).overflowX,
      codeScrollable: code.scrollWidth > code.clientWidth,
      footerInsideViewport: footerBox.left >= 0 && footerBox.right <= innerWidth && footerBox.bottom <= innerHeight,
    };
  });

  await page.click('[data-plan-annotations-toggle]');
  await page.waitForSelector('[data-annotation-panel="true"]');
  const rail = await page.$eval('[data-annotation-panel="true"]', (panel) => ({
    railPosition: getComputedStyle(panel).position,
    railWidth: Math.round(panel.getBoundingClientRect().width),
    rootWidth: Math.round(document.querySelector<HTMLElement>('[data-plan-review-root]')?.getBoundingClientRect().width ?? 0),
  }));
  // The panel's OWN close control: the narrow-container scrim carries the same
  // label for the same action and is display:none at this viewport, so the
  // selector names which one this assertion is about.
  await page.click('[data-annotation-panel="true"] button[aria-label="Close annotations"]');
  await page.waitForFunction(() => document.querySelector('[data-annotation-panel="true"]') === null);
  await page.close();
  return { ...before, ...rail };
}

async function observeWorkspace(browser: Browser, origin: string): Promise<WorkspacePlan> {
  const page = await openFrame(browser, origin, 'workspacepage', 'dark', { width: 1280, height: 900 });
  await page.waitForSelector('[data-composer-root]');
  await page.waitForFunction(() => document.querySelectorAll('[data-panel]').length === 2);
  await page.evaluate(() => {
    const panel = document.querySelectorAll('[data-panel]')[1];
    const output = [...(panel?.querySelectorAll('button') ?? [])].find((button) => button.textContent?.trim() === 'Output');
    if (!(output instanceof HTMLButtonElement)) throw new Error('WorkspacePage has no Output tab');
    output.click();
  });
  await page.waitForFunction(() => {
    const panel = document.querySelectorAll('[data-panel]')[1];
    return [...(panel?.querySelectorAll('button') ?? [])].some((button) => button.textContent?.trim() === 'plan');
  });
  await page.evaluate(() => {
    const panel = document.querySelectorAll('[data-panel]')[1];
    const plan = [...(panel?.querySelectorAll('button') ?? [])].find((button) => button.textContent?.trim() === 'plan');
    if (!(plan instanceof HTMLButtonElement)) throw new Error('Output has no Plan tab');
    plan.click();
  });
  await page.waitForSelector('[data-plan-review-root]');
  await page.waitForFunction(
    () => document.querySelector('[data-plan-title] h1, h1[data-plan-title]')?.textContent?.includes('applyCoupon') === true,
    { timeout: 20_000 },
  );
  const before = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('[data-plan-review-root]');
    const plan = document.querySelector<HTMLElement>('[data-plan-document]');
    if (!root || !plan) throw new Error('WorkspacePage did not mount the real plan document');
    return {
      title: document.querySelector('[data-plan-title] h1, h1[data-plan-title]')?.textContent ?? '',
      rootWidth: Math.round(root.getBoundingClientRect().width),
      documentWidthBefore: Math.round(plan.getBoundingClientRect().width),
      overflow: document.documentElement.scrollWidth - innerWidth,
    };
  });
  await page.click('[data-plan-annotations-toggle]');
  await page.waitForSelector('[data-annotation-panel="true"]');
  const opened = await page.evaluate(() => {
    const rail = document.querySelector<HTMLElement>('[data-annotation-panel="true"]');
    const plan = document.querySelector<HTMLElement>('[data-plan-document]');
    const scrim = document.querySelector<HTMLElement>('[data-plan-scrim]');
    if (!rail || !plan || !scrim) throw new Error('WorkspacePage annotation rail did not open over a scrim');
    return {
      railPosition: getComputedStyle(rail).position,
      railWidth: Math.round(rail.getBoundingClientRect().width),
      documentWidthWithRail: Math.round(plan.getBoundingClientRect().width),
      scrimDisplay: getComputedStyle(scrim).display,
    };
  });
  // The rail covers the document here and the panel's own backdrop is gated on
  // a mobile VIEWPORT, so the scrim is the only in-place way back to the plan.
  // Whether clicking it CLOSES the rail is the assertion, so a scrim that only
  // dims is reported as a lost dismissal rather than as a timed-out suite.
  //
  // A real hit-tested mouse click at the scrim's top-left rather than
  // `page.click`, which aims at an element's CENTRE: the rail is inset to the
  // end edge and covers the middle of this narrow column, so a centre click
  // lands on the rail and proves nothing about the scrim.
  const scrim = await page.$('[data-plan-scrim]');
  const scrimBox = await scrim?.boundingBox();
  if (!scrimBox) throw new Error('the open rail left no scrim box to click');
  await page.mouse.click(scrimBox.x + 8, scrimBox.y + 8);
  const railClosedByScrim = await settledWithin(page.waitForFunction(
    () => document.querySelector('[data-annotation-panel="true"]') === null,
    { timeout: 15_000 },
  ));
  await page.close();
  return { ...before, ...opened, railClosedByScrim };
}

async function observePromotion(
  browser: Browser,
  origin: string,
  variant: string,
  settle?: string,
): Promise<PromotedPlan> {
  const page = await openFrame(browser, origin, 'planreview', 'dark', { width: 1280, height: 900 }, { plan: variant });
  const highlightWarnings: string[] = [];
  page.on('console', (message) => {
    // The vendored highlighter reports an anchor it could not paint as a bare
    // console.warn. A warning here means one viewer was handed an annotation
    // for a block it does not render — exactly what the split below prevents.
    if (message.type() === 'warn' && message.text().includes('Could not find text for annotation')) {
      highlightWarnings.push(message.text());
    }
  });
  if (settle !== undefined) {
    // A missing highlight is the FINDING here, so its absence is tolerated and
    // left to `titleHighlights` below, which names the contract that went
    // missing rather than reporting a suite that timed out.
    await settledWithin(page.waitForSelector(settle, { timeout: 20_000 }));
  }
  const observed = await page.evaluate(() => {
    const header = document.querySelector<HTMLElement>('[data-plan-title]');
    const heading = header?.matches('h1') ? header : header?.querySelector<HTMLElement>('h1');
    const plan = document.querySelector<HTMLElement>('[data-plan-document]');
    if (!heading || !plan) throw new Error('plan variant did not render a titled document');
    return {
      headerTitle: heading.textContent ?? '',
      documentH1s: [...plan.querySelectorAll('h1[data-block-id]')].map((block) => block.textContent ?? ''),
      firstBlockTag: plan.querySelector('[data-block-id]')?.tagName.toLowerCase() ?? '',
      titleHighlights: heading.querySelectorAll('.annotation-highlight').length,
    };
  });
  await page.close();
  if (highlightWarnings.length > 0) {
    throw new Error(`the plan viewers logged unpaintable anchors: ${highlightWarnings.join(' | ')}`);
  }
  return observed;
}

async function observeSettled(browser: Browser, origin: string): Promise<SettledPlan> {
  const page = await openFrame(browser, origin, 'planreview', 'dark', { width: 1280, height: 900 }, { plan: 'read-only' });
  await page.waitForSelector('[data-plan-document] [data-block-id]');
  const status = await page.$eval('[data-plan-status]', (badge) => badge.textContent ?? '');
  const strip = await readActionStrip(page, ACTION_STRIP);
  await page.close();
  return { status, ...strip };
}

let observed: ObservedPlan;
beforeAll(async () => {
  observed = await withGallery(async ({ browser, origin }) => ({
    desktop: {
      dark: await observeDesktop(browser, origin, 'dark'),
      light: await observeDesktop(browser, origin, 'light'),
    },
    mobile: await observeMobile(browser, origin),
    workspace: await observeWorkspace(browser, origin),
    lateHeading: await observePromotion(browser, origin, 'late-heading'),
    annotatedHeading: await observePromotion(
      browser, origin, 'annotated-heading',
      '[data-plan-document] h1[data-block-id] .annotation-highlight',
    ),
    settled: await observeSettled(browser, origin),
  }));
}, 300_000);

describe('the plan review document, as a browser lays it out', () => {
  test('both themes keep one document title, a readable measure, and a structured file tree', () => {
    for (const [mode, plan] of Object.entries(observed.desktop)) {
      expect(plan.mode).toBe(mode);
      // Viewer renders the promoted h1. Its inline renderer turns the Markdown
      // code span into one `code` element, not literal backticks.
      expect(plan.title).toBe('Repair the applyCoupon eligibility guard');
      expect(plan.titleCodeCount).toBe(1);
      expect(plan.headingCount).toBe(1);
      expect(plan.titlePx).toBeGreaterThan(plan.sectionPx);
      expect(plan.sectionPx).toBeGreaterThan(plan.bodyPx);
      expect(plan.documentWidth).toBeGreaterThan(600);
      expect(plan.documentWidth).toBeLessThan(800);
      expect(plan.railInitiallyOpen).toBe(false);
      expect(plan.railWidth).toBeGreaterThanOrEqual(300);
      expect(plan.codeLabel).toBe('File tree');
      expect(plan.codeBackground).not.toBe(plan.pageBackground);
      expect(plan.codeBorder).toBe('solid');
      expect(plan.codeOverflow).toBe('auto');
      expect(plan.overflow).toBe(0);
      // An editable plan keeps the global-comment control, so the strip is
      // still a strip: the collapse rule below must not reach this state.
      expect(plan.actionStripButtons).toBe(2);
      expect(plan.actionStripDisplay).not.toBe('none');
      // Wide enough for the rail to sit BESIDE the document, so there is
      // nothing to dim and nothing to click through.
      expect(plan.scrimDisplay).toBe('none');
    }
    expect(observed.desktop.dark.pageBackground).not.toBe(observed.desktop.light.pageBackground);
  });

  test('mobile scrolls wide blocks and opens annotations as a drawer without page overflow', () => {
    expect(observed.mobile.overflow).toBe(0);
    expect(observed.mobile.codeOverflow).toBe('auto');
    expect(observed.mobile.codeScrollable).toBe(true);
    expect(observed.mobile.railPosition).toBe('fixed');
    expect(observed.mobile.railWidth).toBeLessThanOrEqual(observed.mobile.rootWidth);
    expect(observed.mobile.rootWidth - observed.mobile.railWidth).toBeLessThan(8);
    expect(observed.mobile.footerInsideViewport).toBe(true);
  });

  test('the real WorkspacePage route keeps the rail over its narrow Output column', () => {
    expect(observed.workspace.title).toBe('Repair the applyCoupon eligibility guard');
    expect(observed.workspace.rootWidth).toBeLessThan(500);
    expect(observed.workspace.railPosition).toBe('absolute');
    expect(observed.workspace.railWidth).toBeLessThanOrEqual(observed.workspace.rootWidth);
    expect(observed.workspace.documentWidthWithRail).toBe(observed.workspace.documentWidthBefore);
    expect(observed.workspace.overflow).toBe(0);
    // Painted, and therefore obliged to close the rail: a scrim that only dims
    // leaves a reader looking at a greyed document with no way back to it.
    expect(observed.workspace.scrimDisplay).toBe('block');
    expect(observed.workspace.railClosedByScrim).toBe(true);
  });

  test('an h1 the agent did not lead with stays where the agent put it', () => {
    // Promotion moves a block out of the document. Applied to a LATER h1 it
    // silently reorders the plan, which is why it is gated on the first block
    // rather than on the first h1 found.
    expect(observed.lateHeading.headerTitle).toBe('Plan');
    expect(observed.lateHeading.firstBlockTag).toBe('p');
    expect(observed.lateHeading.documentH1s).toEqual(['Rejected: map the failure at the edge']);
  });

  test('an annotated title stays promoted and its anchor still draws', () => {
    // Both promoted and body blocks use Viewer. Splitting their annotations by
    // block keeps the title in the header without stranding its highlight.
    expect(observed.annotatedHeading.headerTitle).toBe('Repair the applyCoupon eligibility guard');
    expect(observed.annotatedHeading.firstBlockTag).toBe('p');
    expect(observed.annotatedHeading.documentH1s).toEqual([]);
    expect(observed.annotatedHeading.titleHighlights).toBeGreaterThan(0);
  });

  test('a settled plan collapses the action strip instead of leaving its gap', () => {
    // Read-only hides the copy button but leaves it in the DOM, so `:empty`
    // never matched and a zero-height strip kept spending its bottom margin
    // above the first block.
    expect(observed.settled.status).toBe('Superseded');
    expect(observed.settled.actionStripButtons).toBe(1);
    expect(observed.settled.actionStripDisplay).toBe('none');
  });
});
