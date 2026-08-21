/**
 * Infinite scroll is a claim about pixels, so its gate is a browser.
 *
 * `gallery.tsx`'s `?frame=chathistory` was built expressly to be measured: the
 * real `usePagedScroll` and `useGrowingScroll`, the real merge rule and the real
 * `HistoryBoundary`, over a stub page source whose latency, failure and
 * live-arrival timing are driven from the URL (`?latency= ?fail= ?depth=`) and a
 * `gallery:arrive` event. Its own comment says the messages are long enough
 * "so the scroll anchoring is measured against a container that actually
 * overflows". Nothing measured it: `chathistory` appeared nowhere outside
 * gallery.tsx. The harness was built and the test was not.
 *
 * What it guards, and none of it is visible to a source-reading instrument:
 *
 *   · A prepend must not move the message the reader is looking at. The hook
 *     turns the browser's own scroll anchoring OFF (`overflowAnchor: none`)
 *     because the engines' heuristic ran BEFORE its layout effect and the two
 *     corrections double-counted, throwing the reader to the newest message the
 *     instant older history arrived. Both halves are asserted: that the opt-out
 *     is on the element, and that the drift is zero anyway.
 *   · One request per prepend. `usePagedScroll` guards on a ref rather than on
 *     `loading` state because a fast scroll fires several handlers inside one
 *     frame, and each would read the same uncommitted `false`.
 *   · A failed page is not the end of history. `exhausted` is set only by a page
 *     that SAID `end`, so a broken read can never render "beginning of the
 *     conversation" — the same lie a bare `LIMIT` tells one layer up.
 *   · A live turn landing while an older page is in flight must not
 *     double-render a message the walk also returns.
 *
 * One server, one browser. Each scenario needs its own page because the knobs
 * are read once at module scope.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Browser, Page } from 'puppeteer';
import * as v from 'valibot';
import { renderThrownChain } from '@kinu.run/core/obs';

import { withGallery } from './gallery-harness';

/**
 * The frame's hidden `[data-testid="probe"]` blob — the hooks' own state, which
 * the frame serializes on every render.
 *
 * Parsed rather than asserted: it crosses a process boundary as text, so a
 * renamed field would otherwise read as `undefined` and every assertion over it
 * would go quietly vacuous instead of red.
 */
const ProbeSchema = v.object({
  ids: v.array(v.string()),
  /** One entry per `fetchPage` call, in order, holding the cursor it was given. */
  calls: v.array(v.string()),
  loading: v.boolean(),
  exhausted: v.boolean(),
  error: v.nullable(v.string()),
});

type Probe = v.InferOutput<typeof ProbeSchema>;

/**
 * One prepend, measured on both sides of the commit.
 *
 * `refused` carries why a walk step could not be measured instead of ending the
 * whole pass. Losing the correction does not merely move the anchor: with the
 * view left pinned at the top edge, the prefetch re-arms on the page it just
 * received and the walk consumes the ENTIRE history in one cascade, so later
 * steps have no page left to ask for. Both consequences are findings, and a
 * pass that stopped at the first of them would report neither number.
 */
interface Prepend {
  /** How much taller the scrollable content became. The harness's claim that
   *  the container overflows is only true if this is large. */
  readonly grewPx: number;
  /**
   * How far the anchor row moved in the VIEWPORT. This is the property: the
   * reader's row must stay where it was while content is inserted above it.
   */
  readonly driftPx: number;
  /** Requests the step caused. One, unless the walk ran away. */
  readonly calls: number;
  readonly rows: number;
  readonly refused: string | null;
}

const SCROLL = '[data-testid="chat-scroll"]';
const PROBE = '[data-testid="probe"]';

/** The headline of a cause chain — what a scenario reports when it could not be
 *  measured. The full chain is several frames of puppeteer internals, and the
 *  first line is the part that names what did not happen. */
function firstLine(input: { cause: unknown }): string {
  return renderThrownChain(input).split('\n')[0] ?? 'no reason reported';
}

async function probe(page: Page): Promise<Probe> {
  return v.parse(ProbeSchema, JSON.parse(await page.$eval(PROBE, (el) => el.textContent ?? 'null')));
}

/**
 * A predicate over the probe, run in the browser.
 *
 * The condition is a string of JS rather than a closure because it executes in
 * the page, where the schema does not exist; `probe()` above is what pins the
 * shape, and every field these conditions name is one it parses.
 */
async function untilProbe(page: Page, condition: string, timeout = 30_000): Promise<void> {
  await page.waitForFunction(
    `(() => { const el = document.querySelector('${PROBE}');
       if (!el || !el.textContent) return false;
       const state = JSON.parse(el.textContent);
       return Boolean(${condition}); })()`,
    { timeout, polling: 50 },
  );
}

/** A gallery frame, loaded twice: a first load can trip vite's dependency
 *  optimizer, which answers with a full reload and destroys the execution
 *  context of anything waiting on the page. */
async function openFrame(browser: Browser, origin: string, query: string): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewport({ width: 720, height: 620 });
  await page.goto(`${origin}/gallery.html?frame=chathistory&${query}`, { waitUntil: 'networkidle0' });
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector(SCROLL);
  return page;
}

/** Wait until the frame is settled: nothing in flight, and the first page in. */
async function settled(page: Page): Promise<void> {
  await untilProbe(page, 'state.loading === false && state.calls.length > 0');
}

/** The scroller and one anchor row, before a page lands. `id` and `top` are
 *  nullable because a frame that drew nothing is a finding rather than a crash
 *  — it is the shape a sibling gate reported clean over. */
const BeforeSchema = v.object({
  id: v.nullable(v.string()),
  top: v.nullable(v.number()),
  height: v.number(),
  scrollTop: v.number(),
  rows: v.number(),
});

/** The same, after. A null `top` means the anchor left the document, which is a
 *  distinct failure from it having moved. */
const AfterSchema = v.object({
  top: v.nullable(v.number()),
  height: v.number(),
  rows: v.number(),
});

/**
 * Wait for the next page and report what it moved.
 *
 * The anchor is a row the reader is looking at, chosen BEFORE anything happens
 * so the prepend cannot pick it. `scroll` is how the page is asked for: a
 * reader's flick to the growing edge, or nothing at all for the first page,
 * which the hook requests itself the moment the container mounts.
 *
 * Two things can move the anchor: the test's own scroll, and the hook.
 * Scrolling from `scrollTop` to 0 carries every row DOWN the viewport by
 * `scrollTop`, so that much is subtracted back out and `driftPx` holds only the
 * hook's contribution — 0 when the correction is exact, and the whole height of
 * the inserted page when it is missing.
 */
async function prepend(page: Page, scroll: boolean): Promise<Prepend> {
  const before = v.parse(BeforeSchema, await page.$eval(SCROLL, (el) => {
    // The bottom-most row still fully on screen: a row the reader is reading.
    const rows = [...el.querySelectorAll('[data-msg]')];
    const bottom = el.getBoundingClientRect().bottom;
    const anchor = rows.filter((row) => row.getBoundingClientRect().bottom <= bottom).pop()
      ?? rows[0];
    return {
      id: anchor?.getAttribute('data-msg') ?? null,
      top: anchor?.getBoundingClientRect().top ?? null,
      height: el.scrollHeight,
      scrollTop: el.scrollTop,
      rows: rows.length,
    };
  }));
  if (before.id === null || before.top === null) {
    throw new Error(`the frame drew no message rows (scrollHeight ${before.height})`);
  }

  const callsBefore = (await probe(page)).calls.length;
  let carriedDownPx = 0;
  if (scroll) {
    // Straight to the top edge, which is inside PREFETCH_THRESHOLD and
    // therefore the same trigger a reader's flick produces.
    await page.$eval(SCROLL, (el) => { el.scrollTop = 0; });
    // Content moves down the viewport by however far the scroll went up.
    carriedDownPx = before.scrollTop;
  }

  // A landed page is one whose rows are RENDERED and whose walk is asleep. Not
  // one that was asked for: the first page is requested by the hook the moment
  // the container mounts, so a request count taken here has already counted it,
  // and waiting for a second one waits for a page a correct hook never asks for.
  await untilProbe(page, `state.ids.length > ${before.rows} && state.loading === false`);
  // The page has landed in state; the correction is a layout effect, so let the
  // browser commit a frame before measuring where anything is.
  await page.evaluate(() => {
    const painted = Promise.withResolvers<void>();
    requestAnimationFrame(() => requestAnimationFrame(() => painted.resolve()));
    return painted.promise;
  });

  const after = v.parse(AfterSchema, await page.$eval(SCROLL, (el, id: string) => ({
    top: el.querySelector(`[data-msg="${id}"]`)?.getBoundingClientRect().top ?? null,
    height: el.scrollHeight,
    rows: el.querySelectorAll('[data-msg]').length,
  }), before.id));

  if (after.top === null) throw new Error(`anchor ${before.id} left the document`);
  const state = await probe(page);
  return {
    grewPx: after.height - before.height,
    driftPx: Math.round(after.top - before.top - carriedDownPx),
    calls: state.calls.length - callsBefore,
    rows: after.rows,
    refused: null,
  };
}

/**
 * One walk step, with a step that could not be taken NAMED rather than thrown —
 * see {@link Prepend.refused}.
 *
 * The probe is re-read to say what the frame was doing when the step gave up,
 * and a probe that will not parse is itself part of the answer rather than
 * something to hide: it means the frame stopped serializing its state, which is
 * a different finding from a walk that ran out of pages.
 */
async function prependStep(page: Page, scroll = true): Promise<Prepend> {
  try {
    return await prepend(page, scroll);
  } catch (cause) {
    let state = 'the frame reported no state';
    try {
      const settledState = await probe(page);
      state = `exhausted=${settledState.exhausted}, calls=${settledState.calls.length}`
        + `, rows=${settledState.ids.length}`;
    } catch (probeFailure) {
      state = `the probe itself failed: ${renderThrownChain({ cause: probeFailure })}`;
    }
    return {
      grewPx: 0, driftPx: 0, calls: 0, rows: 0,
      refused: `${firstLine({ cause })} (${state})`,
    };
  }
}

/**
 * The four scenarios, each measured or each REFUSED with its reason.
 *
 * Independent on purpose. They share one browser for cost, and nothing else:
 * losing the prepend correction makes the walk consume the whole history in one
 * cascade, which then starves every later scenario of the page it was waiting
 * for. Under one shared throw that regression reports as a bare 30-second
 * timeout on the first assertion in the file — a failure none of the assertions
 * is about. Held per scenario, the anchor drift and the runaway each speak.
 */
interface Walk {
  readonly refused: string | null;
  /** The opt-out the hook installs, as the browser resolves it. */
  readonly overflowAnchor: string;
  readonly firstRows: number;
  /**
   * The FIRST page, landing under the reader's eyes with no scroll involved.
   *
   * Measured before anything settles, because it is the only prepend that can
   * be measured whatever the hook does. Every later one needs the walk to be
   * asleep first, and a hook that loses its correction never sleeps: the view
   * stays pinned at the top edge, the prefetch re-arms on the page it just
   * received, and the entire history arrives in one cascade before a reader
   * could scroll at all.
   */
  readonly firstPage: Prepend;
  readonly prepends: readonly Prepend[];
}

interface Race {
  readonly refused: string | null;
  readonly ids: readonly string[];
  readonly duplicates: readonly string[];
}

interface Broken {
  readonly refused: string | null;
  /** After the first (failed) fetch, and after the retry. */
  readonly failed: Probe | null;
  readonly boundary: string;
  readonly retried: Probe | null;
}

interface Walked {
  readonly refused: string | null;
  readonly state: Probe | null;
  readonly boundary: string;
}

interface Observed {
  readonly walk: Walk;
  readonly race: Race;
  readonly broken: Broken;
  readonly walked: Walked;
}

async function measureWalk(browser: Browser, origin: string): Promise<Walk> {
  // Slow on purpose. The first page is requested the moment the container
  // mounts, so the before-state exists only until the stub answers — at the
  // 400ms default it had already landed by the time the harness finished its
  // second load, and the measurement was of nothing.
  const page = await openFrame(browser, origin, 'latency=3000&depth=5');
  const empty = { grewPx: 0, driftPx: 0, calls: 0, rows: 0, refused: 'not reached' };
  try {
    const overflowAnchor = await page.$eval(SCROLL, (el) => getComputedStyle(el).overflowAnchor);
    // Asserted rather than assumed: the live rows alone, with the first page
    // still in flight. A measurement taken after it landed would report zero
    // drift for the trivial reason that nothing moved while we watched.
    await untilProbe(page, 'state.loading === true && state.ids.length === 3');
    const firstPage = await prependStep(page, false);
    await settled(page);
    const firstRows = await page.$$eval('[data-msg]', (rows) => rows.length);
    const prepends: Prepend[] = [];
    for (let i = 0; i < 3; i++) prepends.push(await prependStep(page));
    return { refused: null, overflowAnchor, firstPage, firstRows, prepends };
  } catch (err) {
    return { refused: firstLine({ cause: err }), overflowAnchor: '', firstPage: empty, firstRows: 0, prepends: [] };
  } finally {
    await page.close();
  }
}

/**
 * A live turn landing while an older page is in flight.
 *
 * Deliberately slow, so the arrival is INSIDE the window rather than near it:
 * the walk and the socket overlap by construction — the walk seeks strictly
 * older than an anchor minted from a list the socket keeps extending — and the
 * merge rule is what stops one message being drawn twice.
 */
async function measureRace(browser: Browser, origin: string): Promise<Race> {
  const page = await openFrame(browser, origin, 'latency=1200&depth=4');
  try {
    await settled(page);
    await page.$eval(SCROLL, (el) => { el.scrollTop = 0; });
    await untilProbe(page, 'state.loading === true');
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('gallery:arrive', { detail: 'race-1' }));
    });
    await settled(page);
    const ids = (await probe(page)).ids;
    const seen = new Set<string>();
    return { refused: null, ids, duplicates: ids.filter((id) => seen.size === seen.add(id).size) };
  } catch (err) {
    return { refused: firstLine({ cause: err }), ids: [], duplicates: [] };
  } finally {
    await page.close();
  }
}

async function measureBroken(browser: Browser, origin: string): Promise<Broken> {
  const page = await openFrame(browser, origin, 'latency=100&fail=1&depth=4');
  try {
    await untilProbe(page, 'state.error !== null');
    const failed = await probe(page);
    const boundary = await page.$eval(SCROLL, (el) => el.firstElementChild?.textContent ?? '');
    // The harness clears its own failure after one throw, so the retry the
    // boundary offers is the real recovery path and not a second failure.
    await page.evaluate(() => {
      const button = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Retry');
      button?.click();
    });
    await untilProbe(
      page, 'state.error === null && state.loading === false && state.ids.length > 3');
    return { refused: null, failed, boundary, retried: await probe(page) };
  } catch (err) {
    return { refused: firstLine({ cause: err }), failed: null, boundary: '', retried: null };
  } finally {
    await page.close();
  }
}

async function measureWalked(browser: Browser, origin: string): Promise<Walked> {
  const page = await openFrame(browser, origin, 'latency=80&depth=1');
  try {
    await untilProbe(page, 'state.exhausted === true');
    return {
      refused: null,
      state: await probe(page),
      boundary: await page.$eval(SCROLL, (el) => el.firstElementChild?.textContent ?? ''),
    };
  } catch (err) {
    return { refused: firstLine({ cause: err }), state: null, boundary: '' };
  } finally {
    await page.close();
  }
}

async function run(): Promise<Observed> {
  return withGallery(async ({ browser, origin }) => ({
    walk: await measureWalk(browser, origin),
    race: await measureRace(browser, origin),
    broken: await measureBroken(browser, origin),
    walked: await measureWalked(browser, origin),
  }));
}

let observed: Observed;
/** Only a failure to boot the gallery at all — every scenario holds its own.
 *  Rendered rather than held raw, because the whole cause chain is what says
 *  whether vite, Chrome or the frame is the thing that did not come up. */
let bootFailure: string | null = null;
beforeAll(async () => {
  try { observed = await run(); } catch (cause) { bootFailure = renderThrownChain({ cause }); }
}, 300_000);

afterAll(() => { if (bootFailure !== null) throw new Error(bootFailure); });

describe('the transcript this gate measures', () => {
  test('the frame rendered, and it overflows', () => {
    expect(observed.walk.refused, 'the anchoring walk could not be measured').toBeNull();
    // 3 live + one 12-message page. A frame that renders nothing is the defect
    // class that made a sibling gate report clean over a blank document.
    expect(observed.walk.firstRows).toBeGreaterThanOrEqual(15);
    for (const [i, p] of observed.walk.prepends.filter((s) => s.refused === null).entries()) {
      expect(p.grewPx, `prepend ${i + 1} inserted nothing`).toBeGreaterThan(400);
    }
  });

  test('the browser is not also anchoring — one mechanism, not two', () => {
    expect(observed.walk.overflowAnchor).toBe('none');
  });
});

describe('a prepend does not move what the reader is reading', () => {
  test('the first page lands without moving the live rows', () => {
    const first = observed.walk.firstPage;
    expect(first.refused, 'the first page could not be measured').toBeNull();
    expect(first.grewPx, 'the first page inserted nothing').toBeGreaterThan(400);
    // The one prepend that is measurable whatever the hook does, and therefore
    // the one that carries the number. Without `scrollTop += grew` the reader's
    // rows are pushed down the viewport by the whole height of the page that
    // arrived — which is what "the chat jumps when history loads" is.
    expect(Math.abs(first.driftPx), `the first page moved the anchor ${first.driftPx}px`)
      .toBeLessThanOrEqual(1);
  });

  test('the anchor holds, prepend by prepend', () => {
    const measured = observed.walk.prepends.filter((p) => p.refused === null);
    expect(measured, 'no prepend could be measured at all').not.toBeEmpty();
    for (const [i, p] of measured.entries()) {
      // One pixel of tolerance and no more: sub-pixel layout rounding is real,
      // a lost correction is not. Without `scrollTop += grew` this is the whole
      // height of the inserted page.
      expect(Math.abs(p.driftPx), `prepend ${i + 1} moved the anchor ${p.driftPx}px`)
        .toBeLessThanOrEqual(1);
    }
  });

  test('the walk takes three steps and does not run away', () => {
    // Said in its own words rather than as a bare timeout. Losing the
    // correction leaves the view pinned at the top edge, so the prefetch
    // re-arms on the page it just received and the whole history arrives at
    // once — after which there is no further page for a step to measure.
    expect(observed.walk.prepends.map((p) => p.refused)).toEqual([null, null, null]);
  });

  test('each prepend is one request, not a burst', () => {
    for (const [i, p] of observed.walk.prepends.filter((s) => s.refused === null).entries()) {
      expect(p.calls, `prepend ${i + 1} fired ${p.calls} requests`).toBe(1);
    }
  });

  test('every page adds rows, so the walk is going somewhere', () => {
    const counts = observed.walk.prepends.filter((p) => p.refused === null).map((p) => p.rows);
    expect(counts).not.toBeEmpty();
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
    expect(counts[counts.length - 1]).toBeGreaterThan(observed.walk.firstRows);
  });
});

describe('a live turn arriving while an older page is in flight', () => {
  test('the two sources do not draw the same message twice', () => {
    expect(observed.race.refused, 'the race could not be arranged').toBeNull();
    expect(observed.race.duplicates).toEqual([]);
  });

  test('the arrival is in the transcript, at the end where it happened', () => {
    expect(observed.race.ids).toContain('race-1');
    expect(observed.race.ids[observed.race.ids.length - 1]).toBe('race-1');
  });
});

describe('a failed read is not a finished conversation', () => {
  test('the failure is reported and history is not declared exhausted', () => {
    expect(observed.broken.refused, 'the failure path could not be driven').toBeNull();
    expect(observed.broken.failed?.error).not.toBeNull();
    expect(observed.broken.failed?.exhausted).toBe(false);
  });

  test('the boundary offers a retry instead of claiming the beginning', () => {
    expect(observed.broken.boundary).toContain('Could not load earlier messages.');
    expect(observed.broken.boundary).toContain('Retry');
    expect(observed.broken.boundary).not.toContain('Beginning of the conversation');
  });

  test('the retry recovers the page the failure lost', () => {
    expect(observed.broken.retried?.error).toBeNull();
    expect(observed.broken.retried?.ids.length ?? 0)
      .toBeGreaterThan(observed.broken.failed?.ids.length ?? 0);
  });
});

describe('the beginning of the conversation, said by the store', () => {
  test('a page that said `end` is the only thing that exhausts the walk', () => {
    expect(observed.walked.refused, 'the walk to the end could not be driven').toBeNull();
    expect(observed.walked.state?.exhausted).toBe(true);
    expect(observed.walked.state?.error).toBeNull();
    expect(observed.walked.boundary).toContain('Beginning of the conversation');
  });
});
