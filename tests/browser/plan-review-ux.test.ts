import { beforeAll, describe, expect, test } from 'bun:test';
import type { Page } from 'puppeteer';
import * as v from 'valibot';

import { unruledClasses, withGallery, type Gallery } from '../../scripts/gallery-harness';

type Mode = 'dark' | 'light';

/** The viewer's floating action strip, as Kinu narrows it: an editable plan shows its one global-comment button
 *  and a settled plan shows none, and the strip itself must then stop spending its margin above the first block. */
const ACTION_STRIP = '[data-plan-document] [data-print-region="article"] > [data-print-hide]';

/** Every styled element of the review. A code fence's classes are highlighter handles (`pn-code`,
 *  `language-*`), not styles. */
const PLAN_CLASSES = '[data-plan-review-root] [class]:not(pre > code)';

interface ActionStrip {
  readonly actionStripDisplay: string;
  readonly actionStripButtons: number;
}

interface DesktopPlan extends ActionStrip {
  readonly mode: string | undefined;
  /** The header's controls, by their text. */
  readonly headerControls: readonly string[];
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
  /** Classes the review carries, rail closed or open, that no served rule selects. */
  readonly unruled: readonly string[];
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
  /** Where the decision bar sits as the Work tab opens on the plan, before anything scrolls. */
  readonly footerInView: boolean;
}

/** What the header promoted, and what the document kept. */
interface PromotedPlan {
  readonly headerTitle: string;
  readonly documentH1s: readonly string[];
  readonly firstBlockTag: string;
  readonly titleHighlights: number;
}

/** A code path in a plan, hovered: whether it rendered as a control, and what the page asked for from the hover on. */
interface CodePathHover {
  readonly interactive: boolean;
  /** Paths the page fetched, through the gallery's fetch. */
  readonly fetched: readonly string[];
  /** Requests that reached the network. */
  readonly requested: readonly string[];
  readonly links: readonly { readonly text: string; readonly href: string | null; readonly target: string | null; readonly rel: readonly string[] }[];
  readonly cells: readonly string[];
  readonly numberedItems: readonly string[];
  readonly codeBlocks: readonly string[];
  /** The display math as drawn: KaTeX's rendering, the TeX it keeps, and any link inside it. */
  readonly math: { readonly rendered: boolean; readonly tex: string | null; readonly links: number };
}

interface SettledPlan {
  readonly status: string;
  /** Whether the document draws an action strip at all. */
  readonly strip: boolean;
}

interface ObservedPlan {
  readonly desktop: Record<Mode, DesktopPlan>;
  readonly mobile: MobilePlan;
  readonly workspace: WorkspacePlan;
  readonly lateHeading: PromotedPlan;
  readonly annotatedHeading: PromotedPlan;
  readonly settled: SettledPlan;
  readonly codePath: CodePathHover;
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
      headerControls: [...document.querySelectorAll<HTMLElement>('[data-plan-actions] button')].map((button) => button.textContent?.trim() ?? ''),
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

  const unruledClosed = await page.evaluate(unruledClasses, PLAN_CLASSES, '', []);

  await page.click('[data-plan-comments-toggle]');
  await page.waitForSelector('[data-annotation-panel="true"]');

  const unruledOpen = await page.evaluate(unruledClasses, PLAN_CLASSES, '', []);

  const opened = await page.evaluate(() => {
    const rail = document.querySelector<HTMLElement>('[data-annotation-panel="true"]');
    const scrim = document.querySelector<HTMLElement>('[data-plan-scrim]');

    if (!rail || !scrim) throw new Error('the open rail did not render beside a scrim element');

    return {
      railWidth: Math.round(rail.getBoundingClientRect().width),
      scrimDisplay: getComputedStyle(scrim).display,
    };
  });

  await page.click('[data-plan-comments-toggle]');
  await page.waitForFunction(() => document.querySelector('[data-annotation-panel="true"]') === null);
  await page.close();

  return { ...before, ...strip, ...opened, unruled: [...new Set([...unruledClosed, ...unruledOpen])] };
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

  await page.click('[data-plan-comments-toggle]');
  await page.waitForSelector('[data-annotation-panel="true"]');

  const rail = await page.$eval('[data-annotation-panel="true"]', (panel) => ({
    railPosition: getComputedStyle(panel).position,
    railWidth: Math.round(panel.getBoundingClientRect().width),
    rootWidth: Math.round(document.querySelector<HTMLElement>('[data-plan-review-root]')?.getBoundingClientRect().width ?? 0),
  }));

  // The panel's OWN close control: the narrow-container scrim carries the same
  // label for the same action and is display:none at this viewport, so the
  // selector names which one this assertion is about.
  await page.click('[data-annotation-panel="true"] button[aria-label="Close comments"]');
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

    const footer = document.querySelector<HTMLElement>('[data-plan-footer]')?.getBoundingClientRect();

    return {
      title: document.querySelector('[data-plan-title] h1, h1[data-plan-title]')?.textContent ?? '',
      footerInView: footer !== undefined && footer.top >= 0 && footer.bottom <= innerHeight,
      rootWidth: Math.round(root.getBoundingClientRect().width),
      documentWidthBefore: Math.round(plan.getBoundingClientRect().width),
      overflow: document.documentElement.scrollWidth - innerWidth,
    };
  });

  await page.click('[data-plan-comments-toggle]');
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
  await page.click('[data-plan-comments-toggle]');

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
  const strip = await page.$(ACTION_STRIP);
  await page.close();

  return { status, strip: strip !== null };
}

/**
 * The file-and-line text Plannotator's inline renderer makes a control whose hover, after 150 ms, fetches a preview
 * from `/api/doc`, a route Kinu does not serve. Hovered, then the page's virtual time run a full second on, so every
 * timer the hover set has fired before the page is read.
 */
async function observeCodePath(newPage: Gallery['newPage'], origin: string): Promise<CodePathHover> {
  const page = await openFrame(
    newPage, origin,
    { frame: 'planreview', mode: 'dark', viewport: { width: 1280, height: 900 }, params: { plan: 'code-path' } });

  try {
    await page.waitForSelector('[data-plan-document] [data-block-id]');
    const path = await page.$('[data-plan-document] code ::-p-text(apply-coupon.ts:42)');

    if (path === null) throw new Error('the plan rendered no code element holding its file and line');
    const before = await page.evaluate(() => window.galleryRequests?.length ?? 0);
    const requested: string[] = [];

    page.on('request', (request) => { requested.push(new URL(request.url()).pathname); });
    await path.hover();
    const cdp = await page.createCDPSession();
    const spent = new Promise<void>((resolve) => { cdp.once('Emulation.virtualTimeBudgetExpired', () => resolve()); });
    await cdp.send('Emulation.setVirtualTimePolicy', { policy: 'advance', budget: 1_000 });
    await spent;

    return {
      interactive: await path.evaluate((node) => node.closest('button, a[href], [role="button"], [tabindex]') !== null),
      fetched: await page.evaluate((from) => (window.galleryRequests ?? []).slice(from), before),
      requested,
      links: await page.$$eval('[data-plan-document] a[href]', (links) => links.map((link) => ({
        text: link.textContent ?? '', href: link.getAttribute('href'), target: link.getAttribute('target')?.toLowerCase() ?? null,
        rel: (link.getAttribute('rel') ?? '').split(/\s+/u).filter(Boolean).sort(),
      }))),
      cells: await page.$$eval('[data-plan-document] tbody td', (cells) => cells.map((cell) => cell.textContent ?? '')),
      numberedItems: await page.$$eval('[data-plan-document] [data-block-id]', (blocks) => blocks
        .map((block) => block.textContent?.replace(/\s+/g, '').trim() ?? '')
        .filter((text) => text.includes('Firstoperation') || text.includes('Secondoperation'))),
      codeBlocks: await page.$$eval('[data-plan-document] pre code', (blocks) => blocks.map((block) => block.textContent?.trim() ?? '')),
      math: await page.$eval('[data-plan-document] [data-math-display]', (block) => ({
        rendered: block.querySelector('.katex-html') !== null && block.querySelector('math') !== null,
        tex: block.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim() ?? null,
        links: block.querySelectorAll('a').length,
      })),
    };
  } finally {
    await page.close();
  }
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
    codePath: await observeCodePath(newPage, origin),
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
      // The header offers the comments and the two marking modes, no Copy; the document keeps the global comment.
      expect(plan.headerControls).toEqual(['Comments 0', 'Comment', 'Remove']);
      expect(plan.actionStripButtons).toBe(1);
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
    // The decision is in reach as the plan opens, however long the plan.
    expect(observed.workspace.footerInView).toBe(true);
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

  test('a settled plan draws no action strip, so no gap sits above its first block', () => {
    expect(observed.settled.status).toBe('Superseded');
    expect(observed.settled.strip).toBe(false);
  });
});

/** Nothing in a plan review reaches the network of its own accord: the old unit pin's intent, held at the page. */
describe('a plan review sends nothing of its own', () => {
  test('a file and line in a plan is plain code, and hovering it past the preview delay sends nothing', () => {
    const { interactive, fetched, requested } = observed.codePath;

    expect({ interactive, fetched, requested }).toEqual({ interactive: false, fetched: [], requested: [] });
  });

  test('external links isolate their opener, anchors stay local, and executable or file links are not controls', () => {
    expect(observed.codePath.links).toEqual([
      { text: 'Reference', href: 'https://example.test/reference', target: '_blank', rel: ['noopener', 'noreferrer'] },
      { text: 'Jump', href: '#details', target: null, rel: [] },
    ]);
  });

  test('escaped table pipes stay in their cell and ordered-list numbering survives parsing', () => {
    expect(observed.codePath.cells).toEqual(['Separator', 'alpha|beta']);
    expect(observed.codePath.numberedItems).toEqual(['4.Firstoperation', '5.Secondoperation']);
  });

  test('a diagram fence remains the agent\'s code, not an executable diagram', () => {
    expect(observed.codePath.codeBlocks).toEqual(['graph TD; A-->B']);
  });

  // GHSA-238p-pmpm-9mq7 moved KaTeX to 0.18: display math still draws, and with `trust: false` an \href in it stays text.
  test('display math draws through KaTeX, and a link inside it is never a control', () => {
    expect(observed.codePath.math).toMatchObject({ rendered: true, links: 0 });
    expect(observed.codePath.math.tex).toContain('\\frac{\\text{saved}}');
  });
});

/** Adds a comment on the whole plan through its own control, and sends it. */
async function addGlobalComment(page: Page, text: string): Promise<void> {
  await page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>('[data-plan-document] button, [data-plan-review-root] button')]
    .find((button) => button.textContent?.trim() === 'Global comment')?.click());
  await page.waitForSelector('[role="dialog"][aria-label="Global plan comment"] textarea');
  await page.type('[role="dialog"][aria-label="Global plan comment"] textarea', text);
  await page.keyboard.down('Control');
  await page.keyboard.press('Enter');
  await page.keyboard.up('Control');
  await page.waitForFunction(() => document.querySelector('[role="dialog"][aria-label="Global plan comment"]') === null);
}

const decisionEnabled = (page: Page, label: string) => page.evaluate((name) => {
  const button = [...document.querySelectorAll<HTMLButtonElement>('[data-plan-decisions] button')].find((each) => each.textContent?.includes(name));

  return button !== undefined && !button.disabled;
}, label);

/** Waits until the decision named `label` can be pressed. */
async function decisionOpens(page: Page, label: string): Promise<void> {
  await page.waitForFunction((name) => [...document.querySelectorAll<HTMLButtonElement>('[data-plan-decisions] button')]
    .some((button) => button.textContent?.includes(name) === true && !button.disabled), {}, label);
}

/** Presses the decision named `label`. */
const pressDecision = (page: Page, label: string): Promise<void> => page.evaluate((name) => {
  [...document.querySelectorAll<HTMLButtonElement>('[data-plan-decisions] button')].find((button) => button.textContent?.includes(name))?.click();
}, label);

const landedSaves = async (page: Page) => v.parse(v.array(v.array(v.string())),
  JSON.parse(await page.evaluate(() => document.documentElement.dataset.galleryAnnotationsSaved ?? '[]')));

/** Annotations are saved one write at a time with the newest set landing last; a refused save is named and the next
 *  edit saves everything; no decision is offered while a save is pending, and the decision carries every comment. */
describe('annotating a plan', () => {
  test('rapid comments save in order, one at a time, and the decision waits for them and carries them', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await openFrame(newPage, origin, { frame: 'planreview', mode: 'dark', viewport: { width: 1280, height: 900 }, params: { annotationSaves: 'held' } });
      await page.waitForSelector('[data-plan-review-root]');

      await addGlobalComment(page, 'Cover the guest cart first');
      await addGlobalComment(page, 'Keep the refusal shape');
      expect(await decisionEnabled(page, 'Request changes')).toBe(false);

      // Let each held save land in turn: one is waiting, then it lands, until the newest has.
      for (const landed of [1, 2]) {
        await page.waitForFunction(() => document.documentElement.dataset.galleryAnnotationsWaiting === '1');
        await page.evaluate(() => window.dispatchEvent(new Event('gallery:annotation-save')));
        await page.waitForFunction((count) => JSON.parse(document.documentElement.dataset.galleryAnnotationsSaved ?? '[]').length === count, {}, landed);
      }

      await decisionOpens(page, 'Request changes');

      const saves = await landedSaves(page);

      expect(saves.at(-1)).toEqual(['Cover the guest cart first', 'Keep the refusal shape']);
      expect(await page.evaluate(() => document.documentElement.dataset.galleryAnnotationsMostInFlight)).toBe('1');

      // The decision saves the comments once more before it is sent.
      await pressDecision(page, 'Request changes');
      await page.waitForFunction(() => document.documentElement.dataset.galleryAnnotationsWaiting === '1');
      await page.evaluate(() => window.dispatchEvent(new Event('gallery:annotation-save')));
      await page.waitForFunction(() => (document.documentElement.dataset.galleryPlanFeedback ?? '').length > 0);
      const feedback = await page.evaluate(() => document.documentElement.dataset.galleryPlanFeedback ?? '');

      expect(feedback).toContain('Cover the guest cart first');
      expect(feedback).toContain('Keep the refusal shape');
      await page.close();
    });
  });

  test('a refused save is named, and the next comment saves every comment', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await openFrame(newPage, origin, { frame: 'planreview', mode: 'dark', viewport: { width: 1280, height: 900 }, params: { annotationSaves: 'fail-first' } });
      await page.waitForSelector('[data-plan-review-root]');

      await addGlobalComment(page, 'Cover the guest cart first');
      await page.waitForFunction(() => document.body.innerText.includes('the plan store is busy'));
      expect(await landedSaves(page)).toEqual([]);

      await addGlobalComment(page, 'Keep the refusal shape');
      await page.waitForFunction(() => JSON.parse(document.documentElement.dataset.galleryAnnotationsSaved ?? '[]').length === 1);
      expect(await landedSaves(page)).toEqual([['Cover the guest cart first', 'Keep the refusal shape']]);
      expect(await page.evaluate(() => document.body.innerText.includes('the plan store is busy'))).toBe(false);
      await page.close();
    });
  });
});

/** Each comment in the open panel: its id, where it came from, its replies, and what the owner can do with it. */
const commentCards = (page: Page) => page.$$eval('[data-annotation-panel="true"] [data-annotation-id]', (cards) => cards.map((card) => ({
  id: card.getAttribute('data-annotation-id'),
  place: card.querySelector('[data-annotation-place]')?.textContent ?? null,
  replies: [...card.querySelectorAll('[data-comment-reply]')].map((reply) => ({
    by: reply.getAttribute('data-comment-reply'), fresh: reply.querySelector('[data-comment-reply-new]') !== null,
  })),
  controls: [...card.querySelectorAll('button')].map((button) => button.textContent?.trim() ?? ''),
})));

/**
 * The agent answers the owner's comments in their threads. A plan sent back shows the replies as they land, marked
 * unread until the comments are opened; the next revision carries the threads read-only, and the owner's reply in
 * one is saved through the review's admission and sent with the next decision.
 */
describe('comment threads', () => {
  test('a sent-back plan marks the agent\'s unread replies, and its comments show each reply under its comment', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await openFrame(newPage, origin, { frame: 'planreview', mode: 'dark', viewport: { width: 1280, height: 900 }, params: { plan: 'replied' } });
      await page.waitForSelector('[data-plan-review-root]');
      expect(await page.$('[data-plan-comments-unread]')).not.toBeNull();

      await page.click('[data-plan-comments-toggle]');
      await page.waitForSelector('[data-annotation-panel="true"] [data-comment-reply]');
      expect(await commentCards(page)).toEqual([
        { id: 'gallery-plan-scope', place: null, replies: [{ by: 'agent', fresh: true }], controls: [] },
        { id: 'gallery-plan-all', place: null, replies: [{ by: 'agent', fresh: true }], controls: [] },
      ]);
      expect(await page.$('[data-plan-comments-unread]')).toBeNull();
      await page.close();
    });
  });

  test('the next revision carries its threads read-only, and the owner\'s reply in one is saved and sent back', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await openFrame(newPage, origin, { frame: 'planreview', mode: 'light', viewport: { width: 1280, height: 900 }, params: { plan: 'threads' } });
      await page.waitForSelector('[data-plan-review-root]');
      await page.click('[data-plan-comments-toggle]');
      await page.waitForSelector('[data-annotation-panel="true"] [data-comment-reply]');

      expect(await commentCards(page)).toEqual([
        { id: 'gallery-plan-scope', place: 'From revision 1', replies: [{ by: 'agent', fresh: true }], controls: ['Reply'] },
        { id: 'gallery-plan-all', place: 'From revision 1', replies: [{ by: 'agent', fresh: true }], controls: ['Reply'] },
      ]);
      expect(await decisionEnabled(page, 'Approve')).toBe(true);

      await page.click('[data-annotation-id="gallery-plan-all"] [data-comment-reply-open]');
      await page.type('[data-annotation-id="gallery-plan-all"] textarea[aria-label="Reply"]', 'Fine; keep the route as it is.');
      await page.$$eval('[data-annotation-id="gallery-plan-all"] button', (buttons) => {
        const send = buttons.find((button) => button.textContent?.trim() === 'Reply' && !button.hasAttribute('data-comment-reply-open'));

        if (!(send instanceof HTMLElement)) throw new Error('the reply composer has no Reply control');
        send.click();
      });
      await page.waitForFunction(() => JSON.parse(document.documentElement.dataset.galleryAnnotationsSaved ?? '[]').length === 1);
      expect(await landedSaves(page)).toEqual([['Fine; keep the route as it is.']]);
      await decisionOpens(page, 'Request changes');
      expect(await decisionEnabled(page, 'Approve')).toBe(false);

      await pressDecision(page, 'Request changes');
      await page.waitForFunction(() => (document.documentElement.dataset.galleryPlanFeedback ?? '').length > 0);
      const feedback = await page.evaluate(() => document.documentElement.dataset.galleryPlanFeedback ?? '');

      expect(feedback).toContain('Comment gallery-plan-all on the whole plan, from revision 1: Split the route change');
      expect(feedback).toContain("  - Owner's reply: Fine; keep the route as it is.");
      expect(feedback).not.toContain('gallery-plan-scope');
      await page.close();
    });
  });

  test('a comment on the whole plan is admitted as the review stores it, and sends', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const page = await openFrame(newPage, origin, { frame: 'planreview', mode: 'dark', viewport: { width: 1280, height: 900 } });
      await page.waitForSelector('[data-plan-review-root]');
      await addGlobalComment(page, 'Ship the guard alone first.');
      await page.waitForFunction(() => JSON.parse(document.documentElement.dataset.galleryAnnotationsSaved ?? '[]').length === 1);
      expect(await page.evaluate(() => document.querySelector('[role="alert"]')?.textContent ?? null)).toBeNull();
      await decisionOpens(page, 'Request changes');
      await page.close();
    });
  });
});

/** The main composer's turn mode: the button pressed, and whether every mode can be chosen. */
function turnMode(page: Page): Promise<{ pressed: string | null; open: boolean }> {
  return page.$$eval('[data-composer-root] [role="group"][aria-label="Turn mode"] button', (buttons) => ({
    pressed: buttons.find((button) => button.getAttribute('aria-pressed') === 'true')?.textContent?.trim() ?? null,
    open: buttons.every((button) => !(button instanceof HTMLButtonElement) || !button.disabled),
  }));
}

async function chooseMode(page: Page, mode: string): Promise<void> {
  await page.$$eval('[data-composer-root] [role="group"][aria-label="Turn mode"] button', (buttons, label) => {
    const button = buttons.find((each) => each.textContent?.trim() === label);

    if (!(button instanceof HTMLElement)) throw new Error(`no ${label} mode`);
    button.click();
  }, mode);
  await page.waitForFunction((label) => [...document.querySelectorAll('[data-composer-root] [role="group"][aria-label="Turn mode"] button')]
    .some((button) => button.getAttribute('aria-pressed') === 'true' && button.textContent?.trim() === label), {}, mode);
}

/** Opens the workspace's pending plan from the Work tab and presses one of its controls; the server then says the plan moved. */
async function decidePlan(page: Page, control: string, landed: string): Promise<void> {
  await page.click('.p-tabstrip button[aria-label="Work"]');
  await page.waitForSelector('[data-plan-review-root]');
  await page.$$eval('[data-plan-review-root] button', (buttons, label) => {
    const button = buttons.find((each) => each.textContent?.includes(label));

    if (!(button instanceof HTMLElement)) throw new Error(`no ${label} on the plan`);
    button.click();
  }, control);
  await page.waitForFunction((key) => document.documentElement.dataset[key] !== undefined, {}, landed);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('gallery:push-frame', { detail: { type: 'reads_changed', reads: ['getActivePlanReview'] } })));
}

/**
 * The composer under a plan: while it waits for a decision, or once dismissed, the turn mode is the one the owner
 * chose and every mode stays open; an approval hands the work to a build turn, so a Plan composer returns to Auto.
 */
describe('the composer under the workspace plan', () => {
  test('a pending or dismissed plan leaves the chosen mode, and an approval returns a Plan composer to Auto', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const open = async () => {
        const page = await newPage();
        await page.setViewport({ width: 1440, height: 900 });
        await page.goto(`${origin}/gallery.html?frame=workspacepage`, { waitUntil: 'networkidle0' });
        await page.waitForSelector('[data-composer-root] [role="group"][aria-label="Turn mode"]');

        return page;
      };

      const approved = await open();
      expect(await turnMode(approved)).toEqual({ pressed: 'Auto', open: true });
      await chooseMode(approved, 'Plan');
      await decidePlan(approved, 'Approve', 'galleryPlanFeedback');
      await approved.waitForFunction(() => [...document.querySelectorAll('[data-composer-root] [role="group"][aria-label="Turn mode"] button')]
        .some((button) => button.getAttribute('aria-pressed') === 'true' && button.textContent?.trim() === 'Auto'));
      await approved.close();

      const dismissed = await open();
      await chooseMode(dismissed, 'Plan');
      await decidePlan(dismissed, 'Dismiss', 'galleryPlanDismissed');
      await dismissed.waitForFunction(() => document.querySelector('[data-plan-decisions]') === null);
      expect(await turnMode(dismissed)).toEqual({ pressed: 'Plan', open: true });
      await dismissed.close();
    });
  });
});

const decisions = (page: Page): Promise<number> => page.evaluate(() => Number(document.documentElement.dataset.galleryDecisions ?? '0'));

/**
 * A decision is one at a time: pressed twice before it answers, it is sent once, and the plan's controls hold until it
 * answers. A decision that fails says why and can be taken again.
 */
describe('deciding a plan', () => {
  test('a decision is sent once however often it is pressed, and a failed one can be taken again', async () => {
    await withGallery(async ({ newPage, origin }) => {
      const open = (decision: string) => openFrame(newPage, origin, {
        frame: 'planreview', mode: 'dark', viewport: { width: 1280, height: 900 }, params: { decision },
      });

      const held = await open('held');
      await held.waitForSelector('[data-plan-decisions]');
      // Both presses in one task, before React can draw the first one's busy state.
      await held.evaluate(() => {
        const approve = [...document.querySelectorAll<HTMLButtonElement>('[data-plan-decisions] button')].find((button) => button.textContent?.includes('Approve'));

        approve?.click();
        approve?.click();
      });
      await held.waitForFunction(() => document.documentElement.dataset.galleryDecisions === '1');
      expect(await decisionEnabled(held, 'Approve')).toBe(false);
      await held.evaluate(() => window.dispatchEvent(new CustomEvent('gallery:decision-answer', { detail: null })));
      // Answered: the plan settles and Approve goes, or Approve comes back; either way the second press sent nothing.
      await held.waitForFunction(() => {
        const approve = [...document.querySelectorAll<HTMLButtonElement>('[data-plan-decisions] button')].find((button) => button.textContent?.includes('Approve'));

        return approve === undefined || !approve.disabled;
      });
      expect(await decisions(held)).toBe(1);
      await held.close();

      const failing = await open('fail-first');
      await failing.waitForSelector('[data-plan-decisions]');
      await pressDecision(failing, 'Approve');
      await failing.waitForFunction(() => document.body.textContent?.includes('review-fixture-rpc-failed'));
      await decisionOpens(failing, 'Approve');
      await pressDecision(failing, 'Approve');
      await failing.waitForFunction(() => document.documentElement.dataset.galleryDecisions === '2');
      await failing.close();
    });
  });
});
