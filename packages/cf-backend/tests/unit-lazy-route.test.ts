/**
 * Stale-chunk recovery via `loadRouteChunk`. A reload discards the reader's screen, so the recognised set is closed
 * and every other arm rethrows the original failure: the feature only adds one narrow recovery.
 */
import { describe, expect, test } from 'bun:test';
import {
  CHUNK_RELOAD_KEY,
  loadRouteChunk,
  type ChunkReloadStore,
  type ChunkRecoveryDeps,
} from '../src/lazy-route';

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

interface Drive {
  deps: ChunkRecoveryDeps;
  /** Awaiting the event makes the non-settlement assertion exact rather than a guessed wait. */
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

/** Called only after the reload, so an already-settled `pending` queues its reaction before the sentinel; no clock. */
async function stillOpen(pending: Promise<unknown>): Promise<boolean> {
  const OPEN = Symbol('open');

  const first = await Promise.race([
    pending.then(() => 'settled', () => 'settled'),
    Promise.resolve(OPEN),
  ]);

  return first === OPEN;
}

const stale = async (): Promise<never> => { throw new TypeError(ENGINE_MESSAGES.chromium); };

async function reloadsOnce(run: Drive): Promise<void> {
  const pending = loadRouteChunk(stale, run.deps);
  await run.reloaded;
  expect(await stillOpen(pending)).toBe(true);
  expect(run.reloads()).toBe(1);
  expect(run.claimed()).toBe(LIVE);
}

async function refusesToReload(run: Drive): Promise<void> {
  await expect(loadRouteChunk(stale, run.deps)).rejects.toThrow(TypeError);
  expect(run.reloads()).toBe(0);
}

describe('recognising a module that would not load', () => {
  for (const [engine, message] of Object.entries(ENGINE_MESSAGES)) {
    test(`${engine}'s wording reloads once the origin has moved`, async () => {
      const run = drive();
      const pending = loadRouteChunk(async (): Promise<never> => { throw new TypeError(message); }, run.deps);
      await run.reloaded;
      expect(await stillOpen(pending)).toBe(true);
      expect(run.reloads()).toBe(1);
      expect(run.claimed()).toBe(LIVE);
    });
  }

  test('an application error is not, even with the origin moved', async () => {
    // A page whose own code threw must never reload: the reader would land on the same fault.
    const run = drive();
    const thrown = new TypeError("Cannot read properties of undefined (reading 'kind')");
    await expect(loadRouteChunk(async (): Promise<never> => { throw thrown; }, run.deps)).rejects.toBe(thrown);
    expect(run.liveReads()).toBe(0);
    expect(run.reloads()).toBe(0);
    expect(run.claimed()).toBeNull();
  });

  test('prose that merely mentions a module is not', async () => {
    const run = drive();
    await expect(loadRouteChunk(async (): Promise<never> => {
      throw new Error('the module registry is confusing');
    }, run.deps)).rejects.toThrow('the module registry is confusing');
    expect(run.liveReads()).toBe(0);
    expect(run.reloads()).toBe(0);
    expect(run.claimed()).toBeNull();
  });

  test('a thrown non-Error is not', async () => {
    for (const thrown of ['Failed to fetch dynamically imported module', null, undefined]) {
      const run = drive();
      await expect(loadRouteChunk(async (): Promise<never> => { throw thrown; }, run.deps)).rejects.toBe(thrown);
      expect(run.reloads()).toBe(0);
      expect(run.claimed()).toBeNull();
    }
  });

  test('an empty message is not', async () => {
    const run = drive();
    await expect(loadRouteChunk(async (): Promise<never> => { throw new Error(''); }, run.deps)).rejects.toThrow('');
    expect(run.reloads()).toBe(0);
    expect(run.claimed()).toBeNull();
  });
});

describe('the one-reload-per-build guard', () => {
  test('the first attempt for a build reloads and records it', async () => {
    await reloadsOnce(drive());
  });

  test('the second attempt for the same build is an error, not a reload', async () => {
    // Loop bound: a second failure means reloading was the wrong assumption.
    await refusesToReload(drive({ seed: LIVE }));
  });

  test('a further build earns its own single reload', async () => {
    // One reload per build transition, not per tab.
    await reloadsOnce(drive({ seed: 'c0ffee0' }));
  });
});

describe('a chunk that loads', () => {
  test('the module is returned and no build is read', async () => {
    const run = drive();
    expect(await loadRouteChunk(async () => ({ default: 'page' }), run.deps)).toEqual({ default: 'page' });
    expect(run.liveReads()).toBe(0);
    expect(run.reloads()).toBe(0);
  });
});

describe('a chunk that fails for a reason this is not about', () => {
  test('the original failure is rethrown, by identity', async () => {
    // By identity: the ErrorBoundary reports class and stack, so a wrapped error would describe this file.
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
  test('one attempt costs exactly one build read', async () => {
    // React re-invokes a rejected lazy's loader, so reading the build on every attempt would storm `/api/health`.
    const run = drive({ live: LOADED });
    await expect(loadRouteChunk(stale, run.deps)).rejects.toThrow(TypeError);
    expect(run.liveReads()).toBe(1);
  });

  test('with the origin on a different build, the page reloads once', async () => {
    await reloadsOnce(drive());
  });

  test('and the promise never settles, so no error flashes over the reload', async () => {
    // Neither resolving nor rejecting is honest on a document about to be replaced; hold the Suspense fallback.
    const run = drive();
    const pending = loadRouteChunk(stale, run.deps);
    await run.reloaded;
    expect(await stillOpen(pending)).toBe(true);
  });

  test('with the origin on the SAME build, it is an error and not a reload', async () => {
    // No skew is no evidence of a stale chunk; reloading would loop the reader through an unfixable fault.
    const run = drive({ live: LOADED });
    await expect(loadRouteChunk(stale, run.deps)).rejects.toThrow('Failed to fetch dynamically imported module');
    expect(run.reloads()).toBe(0);
    expect(run.claimed()).toBeNull();
  });

  test('with no build served at all, it is an error and not a reload', async () => {
    // `vite dev` publishes no stamp, so there is nothing to compare.
    await refusesToReload(drive({ live: null }));
  });

  test('with the page unable to name its own build, it is an error and not a reload', async () => {
    await refusesToReload(drive({ baseline: null }));
  });

  test('with the reload already spent on this build, it is an error', async () => {
    // Loop bound: a second failure means reloading was the wrong assumption.
    await refusesToReload(drive({ seed: LIVE }));
  });

  test('the failure rethrown after a refused reload is still the original', async () => {
    const run = drive({ seed: LIVE });
    const thrown = new TypeError(ENGINE_MESSAGES.firefox);
    await expect(loadRouteChunk(async () => { throw thrown; }, run.deps)).rejects.toBe(thrown);
  });
});
