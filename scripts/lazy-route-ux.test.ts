/**
 * Stale-chunk recovery for a code-split route, driven in a real browser.
 *
 * The unit suite pins the policy's arms. Only a browser can say whether the
 * things around it are true, and all four of them are the point:
 *
 *   1. A reload really happens, exactly once, and the route really renders after
 *      it. A navigation count is the only honest way to assert "once".
 *   2. `React.lazy` memoises a REJECTION, so the ErrorBoundary's "Try again" was
 *      decorative on these routes. Nothing but a real mount/unmount through the
 *      real boundary can prove it is not any more.
 *   3. Regenerating one route's loader leaves its siblings alone. Two lazy routes
 *      are on the page, and the healthy one's attempt count is the assertion.
 *   4. A reader whose failure is NOT a stale chunk, and a reader whose reload has
 *      already been spent, both get the error screen rather than a round trip.
 *
 * The origin's build stamp is moved between load and navigation, which is what
 * makes the skew real rather than declared.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import type { HTTPRequest, Page } from 'puppeteer';
import { renderThrownChain } from '@kinu.run/core/obs';

import { withGallery, type Gallery } from './gallery-harness';
import { CHUNK_FIXED_KEY, CHUNK_RELOAD_KEY } from '../packages/cf-backend/src/lazy-route';

const LOADED_SHA = 'abc1234';
const LATER_SHA = 'deadbee';
const STAMP = { version: '0.1.0+abc1234', sha: LOADED_SHA, builtAt: '2026-08-07T00:00:00.000Z' };

/** What one drive observed. */
interface Observed {
  /** Main-frame navigations, including the opening one. A reload is the second. */
  navigations: number;
  routeLoaded: boolean;
  fallbackVisible: boolean;
  siblingLoaded: boolean;
  /** Import attempts for the failing route, read before the retry and after it.
   *  Relative, because React re-renders a failed subtree in development to build
   *  a component stack: the claim is that a retry ATTEMPTS AGAIN, not that the
   *  total lands on a number a dev-only pass can move. */
  staleAttemptsBeforeRetry: number;
  staleAttempts: number;
  /** The healthy sibling's attempts, either side of the retry. Unchanged is the
   *  claim: regenerating one route's loader must not re-import another's. */
  healthyAttemptsBeforeRetry: number;
  healthyAttempts: number;
  /** Whether the failing route had loaded before the retry was taken. False is
   *  what makes the retry the cause of what follows. */
  loadedBeforeRetry: boolean;
  reloadClaim: string | null;
  /** `/api/health` reads the whole drive made. Bounded, because React re-invokes
   *  a rejected lazy's loader and an unbounded examination aims a request storm
   *  at our own origin. */
  healthReads: number;
  pageErrors: string[];
}

/**
 * Serve `/api/health`, optionally moving the build under the page.
 *
 * `moves` answers the FIRST read with the old build and every later one with the
 * new, which is not a trick: the first read is `index.tsx`'s baseline capture at
 * load, and the later one is the recovery asking what the origin is serving now.
 * Ordering it by request rather than by a wall-clock flip from this process is
 * what makes the skew deterministic — the chunk fails during the first render,
 * microseconds after the baseline read, and no timer could land between them.
 */
async function serve(page: Page, mode: 'stable' | 'moves', served: { count: number }): Promise<void> {
  await page.setRequestInterception(true);
  page.on('request', (request: HTTPRequest): Promise<void> => {
    if (new URL(request.url()).pathname !== '/api/health') {
      return request.continue();
    }
    served.count += 1;
    const sha = mode === 'moves' && served.count > 1 ? LATER_SHA : LOADED_SHA;
    return request.respond({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, build: { ...STAMP, sha } }),
    });
  });
}

/** Whether the boundary's fallback is on screen. */
async function fallbackVisible(page: Page): Promise<boolean> {
  return page.evaluate(() => [...document.querySelectorAll('div')]
    .some((node) => (node.textContent ?? '').startsWith('Something went wrong rendering this view')));
}

async function tryAgain(page: Page): Promise<void> {
  await page.evaluate(() => {
    const retry = [...document.querySelectorAll('button')]
      .find((node) => (node.textContent ?? '').trim() === 'Try again');
    retry?.click();
  });
}

/** Either the route rendered or its boundary caught. Waiting for the SETTLED
 *  state rather than for one outcome is what lets a failure report which it was. */
async function chunkSettled(page: Page): Promise<void> {
  await page.waitForFunction(() => document.querySelector('[data-lazy-loaded]') !== null
    || (document.body.textContent ?? '').includes('Something went wrong rendering this view'));
}

async function readAttempt(page: Page, which: 'lazyStaleAttempts' | 'lazyHealthyAttempts'): Promise<number> {
  return page.evaluate((key: string) => Number(document.body.dataset[key] ?? '0'), which);
}

interface Scenario {
  /** Move the origin to a new build after the document has loaded. */
  skew?: boolean;
  /** Spend the one reload before the page even loads. */
  claimSpent?: boolean;
  /** Fail with an application error rather than a module-load one. */
  appFailure?: boolean;
  /** Take the boundary's own recovery action after it catches. */
  retry?: boolean;
}

async function drive(gallery: Gallery, options: Scenario): Promise<Observed> {
  const { browser, origin } = gallery;
  const page = await browser.newPage();
  const served = { count: 0 };
  const pageErrors: string[] = [];
  let navigations = 0;
  page.on('pageerror', (error) => pageErrors.push(renderThrownChain({ cause: error })));
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations += 1; });
  await serve(page, options.skew === true ? 'moves' : 'stable', served);

  // The guard is per-origin session storage, so it has to be seeded on the
  // origin — which means a document first, then the seed, then the real drive.
  if (options.claimSpent === true) {
    await page.goto(`${origin}/gallery.html?frame=palette`, { waitUntil: 'load' });
    await page.evaluate(
      (key: string, value: string) => { sessionStorage.setItem(key, value); },
      CHUNK_RELOAD_KEY, LATER_SHA,
    );
    navigations = 0;
    served.count = 0;
  }

  const query = options.appFailure === true ? '&failure=app' : '';
  await page.goto(`${origin}/gallery.html?frame=lazyroute${query}`, { waitUntil: 'load' });
  await chunkSettled(page);
  if (options.retry === true) {
    // The chunk is declared present before the retry, so the retry has something
    // to succeed at. Without it a re-attempt is indistinguishable from no attempt:
    // both end on the same error screen.
    await page.evaluate((key: string) => { sessionStorage.setItem(key, '1'); }, CHUNK_FIXED_KEY);
  }
  // Read AFTER the declaration and before the click, so "the retry re-attempted"
  // cannot pass on an attempt the declaration itself provoked.
  const staleAttemptsBeforeRetry = await readAttempt(page, 'lazyStaleAttempts');
  const healthyAttemptsBeforeRetry = await readAttempt(page, 'lazyHealthyAttempts');
  const loadedBeforeRetry = await page.$('[data-lazy-loaded]') !== null;
  if (options.retry === true) {
    await tryAgain(page);
    await chunkSettled(page);
  }

  return {
    navigations,
    routeLoaded: await page.$('[data-lazy-loaded]') !== null,
    fallbackVisible: await fallbackVisible(page),
    siblingLoaded: await page.$('[data-lazy-healthy]') !== null,
    staleAttemptsBeforeRetry,
    staleAttempts: await readAttempt(page, 'lazyStaleAttempts'),
    healthyAttemptsBeforeRetry,
    loadedBeforeRetry,
    healthyAttempts: await readAttempt(page, 'lazyHealthyAttempts'),
    reloadClaim: await page.evaluate((key: string) => sessionStorage.getItem(key), CHUNK_RELOAD_KEY),
    healthReads: served.count,
    pageErrors,
  };
}

let recovered: Observed;
let noSkew: Observed;
let retried: Observed;
let spent: Observed;
let appError: Observed;

beforeAll(async () => {
  await withGallery(async (gallery) => {
    recovered = await drive(gallery, { skew: true });
    noSkew = await drive(gallery, {});
    retried = await drive(gallery, { retry: true });
    spent = await drive(gallery, { skew: true, claimSpent: true });
    appError = await drive(gallery, { skew: true, appFailure: true });
  });
}, 600_000);

describe('a stale chunk with the origin on a new build', () => {
  test('the page reloads, exactly once', () => {
    // Two main-frame navigations: the open, and the recovery. Three would be the
    // loop this feature has to be incapable of.
    expect(recovered.navigations).toBe(2);
  });

  test('and the route the reader asked for renders', () => {
    expect(recovered.routeLoaded).toBe(true);
    expect(recovered.fallbackVisible).toBe(false);
  });

  test('the reload is recorded against the build it was for', () => {
    expect(recovered.reloadClaim).toBe(LATER_SHA);
  });

  test('and nothing throws on the way', () => {
    expect(recovered.pageErrors).toEqual([]);
  });
});

describe('a stale chunk with the origin unchanged', () => {
  test('the page is not reloaded', () => {
    // No skew is no evidence. Reloading here would loop a reader through a
    // broken deploy or a broken network, neither of which a reload fixes.
    expect(noSkew.navigations).toBe(1);
    expect(noSkew.reloadClaim).toBeNull();
  });

  test('the reader gets the error screen instead', () => {
    expect(noSkew.fallbackVisible).toBe(true);
    expect(noSkew.routeLoaded).toBe(false);
  });

  test('the origin is asked about the build once, not once per render attempt', () => {
    // One baseline read at load plus one examination. React re-invokes a rejected
    // lazy's loader on later render attempts, and an unbounded examination turned
    // that into 47 reads in five seconds before `lazyRoute` bounded it.
    expect(noSkew.healthReads).toBeLessThanOrEqual(2);
  });

  test('the rest of the page keeps working', () => {
    // The contained-blast-radius claim: the sibling split route beside it loaded
    // and rendered while this one failed.
    expect(noSkew.siblingLoaded).toBe(true);
  });
});

describe('the boundary’s own recovery action', () => {
  test('the route had not loaded before the retry was taken', () => {
    // Without this the next test would pass on a route React had already
    // re-imported on its own, and the retry would be proving nothing.
    expect(retried.loadedBeforeRetry).toBe(false);
  });

  test('re-attempts the import that failed', () => {
    // `lazy()` memoises a rejection for the life of the component, so before this
    // the retry reset the boundary and the same failure was rethrown without the
    // loader being called at all. One more attempt than before the retry is the
    // whole fix.
    expect(retried.staleAttemptsBeforeRetry).toBeGreaterThan(0);
    expect(retried.staleAttempts).toBeGreaterThan(retried.staleAttemptsBeforeRetry);
  });

  test('and the route then renders, with no reload involved', () => {
    expect(retried.routeLoaded).toBe(true);
    expect(retried.fallbackVisible).toBe(false);
    expect(retried.navigations).toBe(1);
  });

  test('while the sibling loader is left alone', () => {
    // Only the REJECTED loader is regenerated. A retry that cleared every lazy
    // route would re-import the healthy one too and remount a working page under
    // its own state. Relative rather than absolute: React mounts a subtree more
    // than once while surfacing an error, and the claim is about what the RETRY
    // did.
    expect(retried.healthyAttempts).toBe(retried.healthyAttemptsBeforeRetry);
    expect(retried.siblingLoaded).toBe(true);
  });
});

describe('a reload already spent on this build', () => {
  test('is not spent again', () => {
    expect(spent.navigations).toBe(1);
    expect(spent.reloadClaim).toBe(LATER_SHA);
  });

  test('and the reader gets the error screen', () => {
    // Reached when the first reload did not fix it, which means the assumption
    // behind reloading was wrong. Another round trip would be a loop.
    expect(spent.fallbackVisible).toBe(true);
  });

  test('having been recognised and confirmed first, so the GUARD is what stopped it', () => {
    // The paired discriminator. Two reads — the load-time baseline and one
    // examination — prove this failure was recognised AND the origin was asked
    // and found to have moved. Only then did the claim already on record refuse
    // the reload. One read would mean recognition rejected it, which is the
    // different refusal tested above.
    expect(spent.healthReads).toBe(2);
  });
});

describe('a failure that is not a chunk at all', () => {
  test('is never reloaded at, even with the origin on a new build', () => {
    // Skew alone must not authorise a reload: the page's own code threw, and
    // discarding what the reader had on screen would not change that.
    expect(appError.navigations).toBe(1);
    expect(appError.reloadClaim).toBeNull();
  });

  test('and RECOGNITION is what refused it, not a missing skew', () => {
    // THE DISCRIMINATOR. "Not reloaded" is what both worlds look like, so without
    // this the test would pass on a drive that simply had no skew and would prove
    // nothing about recognition. One health read is the load-time baseline alone:
    // the recovery never even asked what the origin is serving, because the
    // message gate rejected the failure first. The spent-claim drive below asks
    // twice, which is what tells the two refusals apart.
    expect(appError.healthReads).toBe(1);
  });

  test('and reaches the boundary as the error it is', () => {
    expect(appError.fallbackVisible).toBe(true);
    expect(appError.routeLoaded).toBe(false);
  });
});
