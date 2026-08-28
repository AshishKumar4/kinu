/**
 * The browser render-failure report, driven in a real browser.
 *
 * Every claim this endpoint makes is a claim about a page that has just broken,
 * and none of them can be checked without one. A unit test can assert that the
 * builder strips a message; only a browser can say whether React calls the
 * boundary once or three times, whether the fallback survives a refused send,
 * and whether the sha the report carries is the build the document loaded or
 * whichever the origin is serving by the time the fault happens.
 *
 * So the fixture is the SHIPPED ErrorBoundary, at a resolved
 * `/workspace/:agentId`, inside the shipped `Layout` — and the network is
 * intercepted rather than stubbed, so what is asserted is the request that
 * really left the page.
 *
 * Four things are measured that nothing else can measure:
 *
 *   1. ONE report for one caught error, across three catches of it. The gate
 *      breaks the view, takes the fallback's "Try again", and takes it again.
 *   2. The report carries the build the page LOADED. The stamp is moved between
 *      load and fault; a report that read it live would carry the new one.
 *   3. A refused send — network failure, and a 401 — leaves the fallback usable
 *      and raises no second error on a page that already has one.
 *   4. An oversized stack is FITTED by the client, not sent and refused.
 *   5. A send that NEVER SETTLES blocks nothing. There is no deadline on the
 *      request by design, so this is the assertion that carries that decision:
 *      the fallback renders, recovery works, the page navigates, and nothing
 *      throws, all while one POST hangs open.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import type { HTTPRequest, Page } from 'puppeteer';
import * as v from 'valibot';
import { renderThrownChain } from '@kinu.run/core/obs';

import { withGallery, type Gallery } from './gallery-harness';
import { CLIENT_ERROR_MAX_REQUEST_BYTES } from '../packages/cf-backend/src/client-error/contract';

const CLIENT_ERRORS = '/api/client-errors';
const HEALTH = '/api/health';

/** The build the document loads with, and the one the origin moves to after. */
const LOADED_SHA = 'abc1234';
const LATER_SHA = 'deadbee';
const STAMP = { version: '0.1.0+abc1234', sha: LOADED_SHA, builtAt: '2026-08-07T00:00:00.000Z' };

/** The needle `gallery.tsx` puts in the thrown error's message. */
const MESSAGE_NEEDLE = 'MESSAGE_LEAKS_IF_REPORTED_0001';
/** The workspace the route resolves for. A report must carry the TEMPLATE. */
const WORKSPACE = 'checkout-fixes';

const ReportSchema = v.object({
  event: v.string(),
  release: v.optional(v.string()),
  route: v.string(),
  errorName: v.string(),
  stack: v.string(),
  componentStack: v.string(),
});
type Report = v.InferOutput<typeof ReportSchema>;

/** One POST the page really made. */
interface Sent {
  method: string;
  contentType: string;
  bytes: number;
  report: Report;
}

/** How the intercepted endpoint answers. `stalled` never settles at all, which
 *  is the state a report with no deadline has to be harmless in. */
type Answer = 'accept' | 'refuse' | 'unreachable' | 'stalled';

/** What one scenario observed. */
interface Observed {
  sent: Sent[];
  /** Errors the PAGE raised — an unhandled rejection or a second throw. */
  pageErrors: string[];
  fallbackVisible: boolean;
  fallbackText: string;
  sceneIntact: boolean;
  retryPresent: boolean;
  /** Times the view actually threw. The dedupe claim is vacuous without it: a
   *  page that broke ONCE also sends one report, and every other reading is
   *  identical either way. */
  faultThrows: number;
  /** Whether the page's own report fetch SETTLED. The never-settles claim is
   *  vacuous without it: an answered request and a hanging one leave the same
   *  fallback, the same scene and the same single POST. */
  reportAnswered: boolean;
  /** Whether the page could still be navigated afterwards. Null when the drive
   *  did not ask. */
  navigated: boolean | null;
}

/**
 * Serve the two endpoints and record what the page sends.
 *
 * `stamp` is a mutable box: the gate flips the sha after load, which is the whole
 * mechanism of the release-binding claim.
 */
/**
 * Whether the PAGE's own report fetch has settled.
 *
 * The one claim the stalled drive rests on is that the browser never got an
 * answer, and nothing else observable on the page distinguishes that from an
 * answered request: same fallback, same scene, same single POST, and no resource
 * timing entry either way. So the gate wraps `window.fetch` before any page script
 * runs and records the settlement of the production code's own promise. That is a
 * fact about the page rather than the gate's bookkeeping about what it chose to
 * answer.
 *
 * Installed first, so the gallery's own fetch stub binds THIS wrapper as its
 * `realFetch` and the report still travels through it.
 */
declare global {
  interface Window {
    __clientErrorSettled?: number;
  }
}

async function watchReportSettlement(page: Page): Promise<void> {
  await page.evaluateOnNewDocument((endpoint: string) => {
    const real = window.fetch.bind(window);
    window.__clientErrorSettled = 0;
    // `Object.assign` carrying `preconnect` forward, exactly as the gallery's own
    // fetch stub does it: `typeof fetch` is a callable WITH that member, so a bare
    // arrow is not assignable to it.
    window.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const pending = real(input, init);
      if (url.includes(endpoint)) {
        const settled = () => {
          window.__clientErrorSettled = (window.__clientErrorSettled ?? 0) + 1;
        };
        pending.then(settled, settled);
      }
      return pending;
    }, { preconnect: real.preconnect });
  }, CLIENT_ERRORS);
}

async function serve(
  page: Page,
  stamp: { sha: string },
  answer: () => Answer,
  sent: Sent[],
): Promise<void> {
  await page.setRequestInterception(true);
  page.on('request', (request: HTTPRequest) => {
    const path = new URL(request.url()).pathname;
    if (path === HEALTH) {
      void request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, build: { ...STAMP, sha: stamp.sha } }),
      });
      return;
    }
    if (path !== CLIENT_ERRORS) {
      void request.continue();
      return;
    }
    const body = request.postData() ?? '';
    sent.push({
      method: request.method(),
      contentType: request.headers()['content-type'] ?? '',
      bytes: new TextEncoder().encode(body).byteLength,
      report: v.parse(ReportSchema, JSON.parse(body)),
    });
    const decided = answer();
    if (decided === 'stalled') {
      // Neither answered nor aborted: the request stays open for the life of the
      // page. Nothing on the page is allowed to be waiting on it.
      return;
    }
    if (decided === 'unreachable') {
      void request.abort('failed');
      return;
    }
    if (decided === 'refuse') {
      void request.respond({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'sign in to report a render failure' }),
      });
      return;
    }
    void request.respond({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ releaseMatch: 'match' }),
    });
  });
}

/** The boundary's fallback, as a reader sees it. */
async function fallback(page: Page): Promise<{ visible: boolean; text: string; retry: boolean }> {
  return page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button')];
    const retry = buttons.find((node) => (node.textContent ?? '').trim() === 'Try again');
    const heading = [...document.querySelectorAll('div')]
      .find((node) => (node.textContent ?? '').startsWith('Something went wrong rendering this view'));
    return {
      visible: heading !== undefined,
      text: heading?.textContent ?? '',
      retry: retry !== undefined,
    };
  });
}

/** Take the fallback's own recovery action. */
async function tryAgain(page: Page): Promise<void> {
  await page.evaluate(() => {
    const retry = [...document.querySelectorAll('button')]
      .find((node) => (node.textContent ?? '').trim() === 'Try again');
    retry?.click();
  });
}

/**
 * A bounded real pause.
 *
 * EXCEPTION to the no-real-timers rule, and the reason is structural rather than
 * convenience: half of what this suite asserts is that a SECOND report does NOT
 * arrive, and absence has no event to await. The clock that would have to be
 * faked belongs to a real Chromium driven over CDP from another process, where
 * nothing in this file can reach it. So the window is real, short, and stated.
 */
function pause(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** Wait until `count` reports have really left the page. Condition-driven, so a
 *  failure reports what arrived rather than only that time ran out. */
async function reportsSettled(sent: readonly Sent[], count: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (sent.length < count && Date.now() < deadline) await pause(25);
  if (sent.length < count) {
    throw new Error(`only ${String(sent.length)} of ${String(count)} report(s) left the page`);
  }
}

interface Scenario {
  answer: Answer;
  retries?: number;
  moveStampAfterLoad?: boolean;
  huge?: boolean;
  navigateAfter?: boolean;
}

/** Break the view, take "Try again" `retries` times, and read what left the page.
 *  One fresh page per scenario: the build baseline and the cached fault are both
 *  per-document, which is the state under test. */
async function drive(gallery: Gallery, options: Scenario): Promise<Observed> {
  {
    const { browser, origin } = gallery;
    const page = await browser.newPage();
    const sent: Sent[] = [];
    const pageErrors: string[] = [];
    const stamp = { sha: LOADED_SHA };
    // Rendered through the cause chain rather than read off `.message`: the
    // handler's argument is untyped at this seam, and a page error's own cause is
    // the part that would say WHY a second failure happened on a page that
    // already has one. Every assertion below expects this list empty, so a
    // failure has to arrive readable.
    page.on('pageerror', (error) => {
      const rendered = renderThrownChain({ cause: error });
      // The dev client's own failed HMR socket, which the harness disables. It is
      // the harness's noise rather than anything this page did, and filtering it
      // by exact text keeps every other second error loud.
      if (rendered.startsWith('WebSocket closed without opened')) return;
      pageErrors.push(rendered);
    });
    await watchReportSettlement(page);
    await serve(page, stamp, () => options.answer, sent);
    const query = options.huge === true ? '&huge=1' : '';
    await page.goto(`${origin}/gallery.html?frame=errorboundary${query}`, {
      waitUntil: 'networkidle0',
    });
    await page.waitForSelector('[data-break]');
    if (options.moveStampAfterLoad === true) stamp.sha = LATER_SHA;

    await page.click('[data-break]');
    await page.waitForFunction(
      () => document.body.textContent?.includes('Something went wrong rendering this view') === true,
    );
    for (let attempt = 0; attempt < (options.retries ?? 0); attempt += 1) {
      await tryAgain(page);
      await page.waitForFunction(
        () => document.body.textContent?.includes('Something went wrong rendering this view') === true,
      );
    }
    // The report, awaited as an event. Then a quiet window in which a duplicate
    // would have arrived: every send this endpoint makes is issued synchronously
    // from `componentDidCatch`, so a second one is already in flight by the time
    // the fallback the gate waited for is on screen.
    await reportsSettled(sent, 1);
    await pause(1_000);

    const seen = await fallback(page);
    const sceneIntact = await page.$('[data-scene-copy]') !== null;
    const faultThrows = await page.evaluate(
      () => Number(document.body.dataset.renderFaultThrows ?? '0'),
    );
    // Read BEFORE any navigation discards the page that holds it. Asserted TRUE on
    // the answered drive as well as false on the stalled one, so the discriminator
    // is shown able to tell the two apart rather than assumed to.
    //
    // Resource timing was tried first and REJECTED by that positive control: a
    // `keepalive` fetch answered through request interception produces no
    // PerformanceResourceTiming entry, so it read false on both paths and would
    // have proved nothing.
    const reportAnswered = await page.evaluate(
      () => (window.__clientErrorSettled ?? 0) > 0,
    );
    // Asked last, because it replaces the document the assertions above read.
    let navigated: boolean | null = null;
    if (options.navigateAfter === true) {
      await page.goto(`${origin}/gallery.html?frame=errorboundary`, { waitUntil: 'load' });
      navigated = await page.$('[data-break]') !== null;
    }
    return {
      sent,
      pageErrors,
      fallbackVisible: seen.visible,
      fallbackText: seen.text,
      retryPresent: seen.retry,
      sceneIntact,
      faultThrows,
      reportAnswered,
      navigated,
    };
  }
}

let accepted: Observed;
let unreachable: Observed;
let refused: Observed;
let moved: Observed;
let fitted: Observed;
let stalled: Observed;

beforeAll(async () => {
  // One gallery for all five: booting a Vite server and a Chromium per scenario
  // costs five times as long and widens the window in which a sibling edit can
  // hot-reload the page out from under a run.
  await withGallery(async (gallery) => {
    accepted = await drive(gallery, { answer: 'accept', retries: 2 });
    unreachable = await drive(gallery, { answer: 'unreachable', retries: 1 });
    refused = await drive(gallery, { answer: 'refuse' });
    moved = await drive(gallery, { answer: 'accept', moveStampAfterLoad: true });
    fitted = await drive(gallery, { answer: 'accept', huge: true });
    stalled = await drive(gallery, { answer: 'stalled', retries: 1, navigateAfter: true });
  });
}, 600_000);

describe('one caught error, one report', () => {
  test('the fault really was caught more than once', () => {
    // THE DISCRIMINATOR. The fixture throws one cached error object and the gate
    // took "Try again" twice, so the view threw repeatedly. Without this count the
    // next assertion passes on a page that broke ONCE and never exercised the
    // dedupe at all: one report is what both worlds produce, and the fallback and
    // its retry affordance read identically in each.
    expect(accepted.faultThrows).toBeGreaterThan(1);
    expect(accepted.fallbackVisible).toBe(true);
    expect(accepted.retryPresent).toBe(true);
  });

  test('and exactly one report left the page', () => {
    expect(accepted.sent).toHaveLength(1);
  });

  test('and the same probe DOES see an answered report, so it can tell them apart', () => {
    // The positive control for the stalled block's discriminator. One that read
    // false on both paths would prove nothing.
    expect(accepted.reportAnswered).toBe(true);
  });

  test('as a same-origin JSON POST', () => {
    expect(accepted.sent[0]?.method).toBe('POST');
    expect(accepted.sent[0]?.contentType).toBe('application/json');
  });
});

describe('what the report carries', () => {
  test('the route TEMPLATE, never the workspace the owner named', () => {
    expect(accepted.sent[0]?.report.route).toBe('/workspace/:agentId');
    expect(JSON.stringify(accepted.sent[0]?.report)).not.toContain(WORKSPACE);
  });

  test('the error’s class, which is the greppable part', () => {
    expect(accepted.sent[0]?.report.errorName).toBe('TypeError');
    expect(accepted.sent[0]?.report.event).toBe('client.render_failed');
  });

  test('never the message, in any field', () => {
    // V8 puts `${name}: ${message}` on the first line of `stack`. This is the
    // assertion that says that line was dropped rather than shipped.
    expect(JSON.stringify(accepted.sent[0]?.report)).not.toContain(MESSAGE_NEEDLE);
  });

  test('stack frames a person can reproduce from', () => {
    const stack = accepted.sent[0]?.report.stack ?? '';
    expect(stack.length).toBeGreaterThan(0);
    for (const line of stack.split('\n')) {
      // Every line is a coordinate: `…:<line>:<column>`, optionally in V8's
      // parentheses. Prose cannot satisfy it.
      expect(line).toMatch(/:\d+:\d+\)?$/u);
    }
  });

  test('and the component path through the tree, as PRODUCTION carries it', () => {
    // Asserted on shape rather than on component NAMES, and that is a correction
    // rather than a weakening. The harness serves a built bundle, so this stack
    // reads `at DV (…/assets/gallery-BUjNqvKO.js:312:10904)` — minified, which is
    // exactly what a deployed page produces. An assertion on `BreakableView`
    // passed only against the dev server and would have gone red the day anyone
    // pointed this gate at a real build, while claiming to test production.
    //
    // What survives minification is what an operator actually works from: a PATH
    // through the tree, several frames deep, carrying coordinates the reported SHA
    // resolves against a locally generated map.
    const frames = (accepted.sent[0]?.report.componentStack ?? '').split('\n').filter(Boolean);
    expect(frames.length).toBeGreaterThan(1);
    for (const frame of frames) {
      expect(frame).toMatch(/^\s*at\s+[A-Za-z_$][\w$.]*(?:\s+\(\S+:\d+:\d+\))?$/u);
    }
    expect(frames.some((frame) => /:\d+:\d+\)$/u.test(frame))).toBe(true);
  });

  test('no query string, no user agent, no cookie, no field nobody asked for', () => {
    expect(Object.keys(accepted.sent[0]?.report ?? {}).sort()).toEqual([
      'componentStack', 'errorName', 'event', 'release', 'route', 'stack',
    ]);
  });
});

describe('the build the report is bound to', () => {
  test('is the one the page loaded', () => {
    expect(accepted.sent[0]?.report.release).toBe(LOADED_SHA);
  });

  test('and stays that one when the origin moves under the page', () => {
    // A tab open across a deploy is the case this field exists for. Reading the
    // stamp at fault time would report the NEW build and make the stack
    // unreproducible for the exact reports where that matters most.
    expect(moved.sent[0]?.report.release).toBe(LOADED_SHA);
    expect(moved.sent[0]?.report.release).not.toBe(LATER_SHA);
  });
});

describe('a report the network never delivers', () => {
  test('the reader still gets the fallback, with its recovery action', () => {
    expect(unreachable.fallbackVisible).toBe(true);
    expect(unreachable.retryPresent).toBe(true);
  });

  test('the fallback still names what broke', () => {
    // The product affordance is unchanged by reporting, delivered or not.
    expect(unreachable.fallbackText).toContain('(workspace)');
  });

  test('the surrounding view is untouched', () => {
    expect(unreachable.sceneIntact).toBe(true);
  });

  test('and no second error is raised on the page', () => {
    // A failed send must not become an unhandled rejection on a page that
    // already has one error on it.
    expect(unreachable.pageErrors).toEqual([]);
  });

  test('recovery still works after the failed send', () => {
    // The gate took "Try again" once with the send already failed; the boundary
    // reset, the view threw again, and the fallback came back.
    expect(unreachable.sent).toHaveLength(1);
    expect(unreachable.fallbackVisible).toBe(true);
  });
});

describe('a report the origin refuses', () => {
  test('a 401 changes nothing the reader sees', () => {
    expect(refused.fallbackVisible).toBe(true);
    expect(refused.retryPresent).toBe(true);
    expect(refused.sceneIntact).toBe(true);
  });

  test('and is not retried into a storm', () => {
    expect(refused.sent).toHaveLength(1);
  });

  test('and raises no second error', () => {
    expect(refused.pageErrors).toEqual([]);
  });
});

describe('a send that never settles', () => {
  // There is no deadline on the report, by design: the promise is voided and the
  // fallback is on screen before it exists, so a timer could only abort a request
  // the browser is already managing. These are the assertions that decision rests
  // on, and the request really is still open while every one of them is made.
  test('one report left the page', () => {
    expect(stalled.sent).toHaveLength(1);
  });

  test('and the browser really never got an answer for it', () => {
    // THE DISCRIMINATOR for this whole block. Every other reading here — the
    // fallback, the retry, the scene, the absence of page errors — is identical
    // whether the request hung or was answered, so without this the block measures
    // the fixture rather than the behaviour. Chrome's resource timing is the
    // browser's own record, not the gate's word for it.
    expect(stalled.reportAnswered).toBe(false);
  });

  test('the fallback renders anyway, with its recovery action', () => {
    expect(stalled.fallbackVisible).toBe(true);
    expect(stalled.retryPresent).toBe(true);
    expect(stalled.fallbackText).toContain('(workspace)');
  });

  test('recovery still works while the request hangs', () => {
    // The drive took "Try again" with the send still open: the boundary reset,
    // the view threw the same error again, and the fallback came back — without
    // a second report.
    expect(stalled.sceneIntact).toBe(true);
    expect(stalled.sent).toHaveLength(1);
  });

  test('the page still navigates', () => {
    expect(stalled.navigated).toBe(true);
  });

  test('and nothing throws', () => {
    expect(stalled.pageErrors).toEqual([]);
  });
});

describe('a stack too big for the bound', () => {
  test('the client fits the report instead of sending an oversized one', () => {
    // 600 frames is far over the bound. The route would answer 413; a client
    // that made it send anyway would lose the report entirely.
    expect(fitted.sent).toHaveLength(1);
    expect(fitted.sent[0]?.bytes).toBeLessThanOrEqual(CLIENT_ERROR_MAX_REQUEST_BYTES);
  });

  test('and keeps the fields that make it actionable', () => {
    expect(fitted.sent[0]?.report.release).toBe(LOADED_SHA);
    expect(fitted.sent[0]?.report.errorName).toBe('TypeError');
    expect(fitted.sent[0]?.report.route).toBe('/workspace/:agentId');
    expect(fitted.sent[0]?.report.stack.length).toBeGreaterThan(0);
  });

  test('with whole frames, never half of one', () => {
    for (const line of (fitted.sent[0]?.report.stack ?? '').split('\n')) {
      expect(line).toMatch(/:\d+:\d+\)?$/u);
    }
  });
});
