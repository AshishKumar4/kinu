/**
 * The stale-chunk recovery policy, driven without a browser.
 *
 * Two claims are worth pinning here rather than only in a browser, because both
 * are about what the policy REFUSES to do:
 *
 *   1. The recognised set is closed. A reload is the most destructive thing this
 *      app does to a reader without being asked — it discards whatever they had
 *      on screen — so the four engine messages that authorise one are a list, and
 *      this suite is what stops a fifth being waved through by a substring.
 *   2. Every arm that is not a recognised, confirmed, unclaimed stale chunk
 *      rethrows the ORIGINAL failure and touches nothing. That is the whole
 *      safety property: the feature can only ever add one narrow recovery, never
 *      change another outcome.
 */
import { describe, expect, test } from 'bun:test';
import {
  CHUNK_RELOAD_KEY,
  claimChunkReload,
  isStaleChunkFailure,
  loadRouteChunk,
  type ChunkReloadStore,
  type ChunkRecoveryDeps,
} from '../src/lazy-route';

/** The build the page loaded, and the one the origin moved to. */
const LOADED = 'abc1234';
const LIVE = 'deadbee';

/** The messages the four engines and Vite's preload helper really produce. */
const ENGINE_MESSAGES = {
  chromium: 'Failed to fetch dynamically imported module: https://kinu.run/assets/MCTSExplorer-a1b2c3.js',
  firefox: 'error loading dynamically imported module: https://kinu.run/assets/MCTSExplorer-a1b2c3.js',
  safari: 'Importing a module script failed.',
  viteCss: 'Unable to preload CSS for https://kinu.run/assets/MCTSExplorer-a1b2c3.css',
} as const;

function store(seed: string | null = null): ChunkReloadStore & { read: () => string | null } {
  const cells = new Map<string, string>();
  if (seed !== null) cells.set(CHUNK_RELOAD_KEY, seed);
  return {
    getItem: (key) => cells.get(key) ?? null,
    setItem: (key, value) => { cells.set(key, value); },
    read: () => cells.get(CHUNK_RELOAD_KEY) ?? null,
  };
}

/** One drive of the policy, with everything it reached recorded. */
interface Drive {
  deps: ChunkRecoveryDeps;
  /** Resolves when the policy has actually reloaded. Awaiting the EVENT is what
   *  makes the non-settlement assertion below exact rather than a guessed wait. */
  reloaded: Promise<void>;
  reloads: () => number;
  liveReads: () => number;
  claimed: () => string | null;
}

function drive(options: { live?: string | null; baseline?: string | null; seed?: string | null } = {}): Drive {
  const session = store(options.seed ?? null);
  const reloadHappened = Promise.withResolvers<void>();
  let reloads = 0;
  let liveReads = 0;
  return {
    deps: {
      baseline: async () => options.baseline === undefined ? LOADED : options.baseline,
      live: async () => {
        liveReads += 1;
        return options.live === undefined ? LIVE : options.live;
      },
      session,
      reload: () => { reloads += 1; reloadHappened.resolve(); },
    },
    reloaded: reloadHappened.promise,
    reloads: () => reloads,
    liveReads: () => liveReads,
    claimed: () => session.read(),
  };
}

/**
 * Whether `pending` is still open.
 *
 * Called only after the policy has already reached its reload, which is the last
 * thing it does before holding the promise: anything that was going to settle has
 * settled by then, so racing an immediately-resolved sentinel decides it exactly.
 * No clock is involved — a settled `pending` queues its reaction before the
 * sentinel, which is created after it.
 */
async function stillOpen(pending: Promise<unknown>): Promise<boolean> {
  const OPEN = Symbol('open');
  const first = await Promise.race([
    pending.then(() => 'settled', () => 'settled'),
    Promise.resolve(OPEN),
  ]);
  return first === OPEN;
}

describe('recognising a module that would not load', () => {
  for (const [engine, message] of Object.entries(ENGINE_MESSAGES)) {
    test(`${engine}'s wording is recognised`, () => {
      expect(isStaleChunkFailure(new TypeError(message))).toBe(true);
    });
  }

  test('an application error is not', () => {
    // The case that must never reload: a page whose own code threw. Reloading
    // would discard the reader's context and land them on the same fault.
    expect(isStaleChunkFailure(new TypeError("Cannot read properties of undefined (reading 'kind')"))).toBe(false);
  });

  test('prose that merely mentions a module is not', () => {
    expect(isStaleChunkFailure(new Error('the module registry is confusing'))).toBe(false);
  });

  test('a thrown non-Error is not', () => {
    expect(isStaleChunkFailure('Failed to fetch dynamically imported module')).toBe(false);
    expect(isStaleChunkFailure(null)).toBe(false);
    expect(isStaleChunkFailure(undefined)).toBe(false);
  });

  test('an empty message is not', () => {
    expect(isStaleChunkFailure(new Error(''))).toBe(false);
  });
});

describe('the one-reload-per-build guard', () => {
  test('the first claim for a build is granted', () => {
    const session = store();
    expect(claimChunkReload(session, LIVE)).toBe(true);
    expect(session.read()).toBe(LIVE);
  });

  test('the second claim for the same build is refused', () => {
    const session = store();
    claimChunkReload(session, LIVE);
    expect(claimChunkReload(session, LIVE)).toBe(false);
  });

  test('a claim already on record refuses without being asked twice', () => {
    expect(claimChunkReload(store(LIVE), LIVE)).toBe(false);
  });

  test('a further build earns its own single reload', () => {
    // The bound is one reload per build TRANSITION, not one per tab: a tab left
    // open across three deploys may recover from each, once.
    const session = store();
    expect(claimChunkReload(session, LIVE)).toBe(true);
    expect(claimChunkReload(session, 'c0ffee0')).toBe(true);
    expect(claimChunkReload(session, 'c0ffee0')).toBe(false);
  });
});

describe('a chunk that loads', () => {
  test('the module is returned and no build is read', async () => {
    // The health read is a request. A route that loads must not make one.
    const run = drive();
    expect(await loadRouteChunk(async () => ({ default: 'page' }), run.deps)).toEqual({ default: 'page' });
    expect(run.liveReads()).toBe(0);
    expect(run.reloads()).toBe(0);
  });
});

describe('a chunk that fails for a reason this is not about', () => {
  test('the original failure is rethrown, by identity', async () => {
    // By identity, because the ErrorBoundary above reports the error's class and
    // its stack: a wrapped or re-created error would arrive in Workers Logs
    // describing this file instead of the fault.
    const run = drive();
    const thrown = new Error('the module threw while evaluating');
    await expect(loadRouteChunk(async () => { throw thrown; }, run.deps)).rejects.toBe(thrown);
  });

  test('nothing is read and nothing is reloaded', async () => {
    const run = drive();
    await expect(loadRouteChunk(async () => { throw new Error('boom'); }, run.deps)).rejects.toThrow('boom');
    expect(run.liveReads()).toBe(0);
    expect(run.reloads()).toBe(0);
    expect(run.claimed()).toBeNull();
  });
});

describe('a stale chunk', () => {
  const stale = async (): Promise<never> => { throw new TypeError(ENGINE_MESSAGES.chromium); };

  test('one attempt costs exactly one build read', async () => {
    // The read is a request to our own origin. React re-invokes a rejected lazy's
    // loader on later render attempts, so a policy that read the build on every
    // attempt would aim a storm at `/api/health` — measured at 47 reads in five
    // seconds before the examination was bounded (see `lazyRoute`).
    const run = drive({ live: LOADED });
    await expect(loadRouteChunk(stale, run.deps)).rejects.toThrow(TypeError);
    expect(run.liveReads()).toBe(1);
  });

  test('with the origin on a different build, the page reloads once', async () => {
    const run = drive();
    const pending = loadRouteChunk(stale, run.deps);
    await run.reloaded;
    expect(await stillOpen(pending)).toBe(true);
    expect(run.reloads()).toBe(1);
    expect(run.claimed()).toBe(LIVE);
  });

  test('and the promise never settles, so no error flashes over the reload', async () => {
    // Resolving would render a route out of a bundle just established to be
    // gone; rejecting would show an error screen on a document about to be
    // replaced. Holding the Suspense fallback is the honest picture.
    const run = drive();
    const pending = loadRouteChunk(stale, run.deps);
    await run.reloaded;
    expect(await stillOpen(pending)).toBe(true);
  });

  test('with the origin on the SAME build, it is an error and not a reload', async () => {
    // No skew is no evidence of a stale chunk: the deploy or the network is
    // broken, and reloading would loop a reader through a fault they cannot fix.
    const run = drive({ live: LOADED });
    await expect(loadRouteChunk(stale, run.deps)).rejects.toThrow('Failed to fetch dynamically imported module');
    expect(run.reloads()).toBe(0);
    expect(run.claimed()).toBeNull();
  });

  test('with no build served at all, it is an error and not a reload', async () => {
    // A `vite dev` server publishes no stamp, so there is nothing to compare and
    // no honest claim to make.
    const run = drive({ live: null });
    await expect(loadRouteChunk(stale, run.deps)).rejects.toThrow(TypeError);
    expect(run.reloads()).toBe(0);
  });

  test('with the page unable to name its own build, it is an error and not a reload', async () => {
    const run = drive({ baseline: null });
    await expect(loadRouteChunk(stale, run.deps)).rejects.toThrow(TypeError);
    expect(run.reloads()).toBe(0);
  });

  test('with the reload already spent on this build, it is an error', async () => {
    // The loop bound. Reached when the first reload did not fix it, which means
    // the assumption behind reloading was wrong and the reader deserves the
    // error rather than another round trip.
    const run = drive({ seed: LIVE });
    await expect(loadRouteChunk(stale, run.deps)).rejects.toThrow(TypeError);
    expect(run.reloads()).toBe(0);
  });

  test('the failure rethrown after a refused reload is still the original', async () => {
    const run = drive({ seed: LIVE });
    const thrown = new TypeError(ENGINE_MESSAGES.firefox);
    await expect(loadRouteChunk(async () => { throw thrown; }, run.deps)).rejects.toBe(thrown);
  });
});
