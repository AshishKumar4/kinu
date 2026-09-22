import { beforeAll, describe, expect, test } from 'bun:test';
import type { Page } from 'puppeteer';

import { withGallery, type Gallery } from './gallery-harness';

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
  readonly railDismissed: boolean;
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

/** The gallery frame a row opens: the fixture's name, the theme it boots in,
 *  the viewport it is measured at, and any query the fixture itself reads. */
interface FrameRequest {
  readonly frame: string;
  readonly mode: Mode;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly params?: Record<string, string>;
}

async function openFrame(newPage: Gallery['newPage'], origin: string, request: FrameRequest): Promise<Page> {
  const page = await newPage();
  await page.setViewport(request.viewport);
  await page.evaluateOnNewDocument((nextMode: Mode) => localStorage.setItem('theme', nextMode), request.mode);
  const query = new URLSearchParams({ frame: request.frame, ...request.params });
  await page.goto(`${origin}/gallery.html?${query.toString()}`, { waitUntil: 'networkidle0' });

  return page;
}

async function readActionStrip(page: Page, selector: string): Promise<ActionStrip> {
  return await page.$eval(selector, (strip) => ({
    actionStripDisplay: getComputedStyle(strip).display,
    actionStripButtons: strip.querySelectorAll('button').length,
  }));
}

async function observeDesktop(newPage: Gallery['newPage'], origin: string, mode: Mode): Promise<DesktopPlan> {
  const page = await openFrame(newPage, origin, { frame: 'planreview', mode, viewport: { width: 1280, height: 900 } });
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
    const root = document.querySelector<HTMLElement>('[data-plan-review-root]');

    if (!title || !section || !body || !plan || !code || !scroll || !root) throw new Error('plan fixture did not render its document contract');

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
      pageBackground: getComputedStyle(root).backgroundColor,
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

async function observeMobile(newPage: Gallery['newPage'], origin: string): Promise<MobilePlan> {
  const page = await openFrame(newPage, origin, { frame: 'planreview', mode: 'dark', viewport: { width: 390, height: 844 } });
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

async function observeWorkspace(newPage: Gallery['newPage'], origin: string): Promise<WorkspacePlan> {
  const page = await openFrame(newPage, origin, { frame: 'workspacepage', mode: 'dark', viewport: { width: 1280, height: 900 } });
  await page.waitForSelector('[data-composer-root]');
  await page.waitForFunction(() => document.querySelectorAll('[data-panel]').length === 2);
  await page.click('[aria-label="Work"]');
  await page.waitForSelector('[data-plan-review-root]');
  await page.waitForFunction(
    () => document.querySelector('[data-plan-title] h1, h1[data-plan-title]')?.textContent?.includes('applyCoupon') === true,
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
  // a mobile VIEWPORT, so the scrim is the only in-place way back to the plan —
  // when a strip of it is left. Under the inspector's decided 340px the Work
  // column (298px here) is NARROWER than the rail's `min(20rem, 100%)` floor,
  // the rail covers the column whole, and the scrim it sits on is unreachable.
  // The dismissal a reader can actually use is the control that opened the
  // rail — the header's annotations toggle. Whether it CLOSES the rail is the
  // assertion, so a rail that cannot be left is reported as a lost dismissal
  // rather than as a timed-out suite.
  // The toggle's handler is a synchronous React state change, committed
  // before the click resolves, so the rail's presence is read at once: a
  // rail still open here is the lost dismissal, not a page still working.
  await page.click('[data-plan-annotations-toggle]');

  const railDismissed = await page.evaluate(
    () => document.querySelector('[data-annotation-panel="true"]') === null,
  );

  await page.close();

  return { ...before, ...opened, railDismissed };
}

async function observePromotion(
  newPage: Gallery['newPage'],
  origin: string,
  variant: string,
  settle?: string,
): Promise<PromotedPlan> {
  const page = await openFrame(
    newPage, origin,
    { frame: 'planreview', mode: 'dark', viewport: { width: 1280, height: 900 }, params: { plan: variant } });

  const highlightWarnings: string[] = [];
  const unpaintable = new AbortController();
  page.on('console', (message) => {
    // The vendored highlighter reports an anchor it could not paint as a bare
    // console.warn. A warning here means one viewer was handed an annotation
    // for a block it does not render — exactly what the split below prevents.
    if (message.type() === 'warn' && message.text().includes('Could not find text for annotation')) {
      highlightWarnings.push(message.text());
      unpaintable.abort();
    }
  });

  if (settle !== undefined) {
    // The highlighter paints after mount, so the wait ends on either of ITS
    // outcomes: the highlight in the DOM, or the warning above naming the
    // anchor it could not paint. A missing highlight is the finding here and
    // is left to `titleHighlights` below, which names the contract that went
    // missing rather than reporting a suite that timed out.
    try {
      await page.waitForSelector(settle, { signal: unpaintable.signal });
    } catch (cause) {
      if (!unpaintable.signal.aborted) throw cause;
    }
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

async function observeSettled(newPage: Gallery['newPage'], origin: string): Promise<SettledPlan> {
  const page = await openFrame(
    newPage, origin,
    { frame: 'planreview', mode: 'dark', viewport: { width: 1280, height: 900 }, params: { plan: 'read-only' } });

  await page.waitForSelector('[data-plan-document] [data-block-id]');
  const status = await page.$eval('[data-plan-status]', (badge) => badge.textContent ?? '');
  const strip = await readActionStrip(page, ACTION_STRIP);
  await page.close();

  return { status, ...strip };
}

let observed: ObservedPlan;

beforeAll(async () => {
  observed = await withGallery(async ({ newPage, origin }) => ({
    desktop: {
      dark: await observeDesktop(newPage, origin, 'dark'),
      light: await observeDesktop(newPage, origin, 'light'),
    },
    mobile: await observeMobile(newPage, origin),
    workspace: await observeWorkspace(newPage, origin),
    lateHeading: await observePromotion(newPage, origin, 'late-heading'),
    // The settle names the element the assertion reads — the promoted title
    // in the header. The document's own h1 never carries this highlight (the
    // split hands it to the header's viewer), and a wait on it timed out on
    // every run while the assertion below passed on the header: a wait that
    // could not end on its condition, hidden by the deadline it had.
    annotatedHeading: await observePromotion(
      newPage, origin, 'annotated-heading',
      '[data-plan-title] .annotation-highlight',
    ),
    settled: await observeSettled(newPage, origin),
  }));
});

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

  test('the real WorkspacePage route keeps the rail over its narrow Work column', () => {
    expect(observed.workspace.title).toBe('Repair the applyCoupon eligibility guard');
    expect(observed.workspace.rootWidth).toBeLessThan(500);
    expect(observed.workspace.railPosition).toBe('absolute');
    expect(observed.workspace.railWidth).toBeLessThanOrEqual(observed.workspace.rootWidth);
    expect(observed.workspace.documentWidthWithRail).toBe(observed.workspace.documentWidthBefore);
    expect(observed.workspace.overflow).toBe(0);
    // Painted over the whole column — the rail's own close control is the
    // reachable way out here, and it must actually close the rail.
    expect(observed.workspace.scrimDisplay).toBe('block');
    expect(observed.workspace.railDismissed).toBe(true);
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
