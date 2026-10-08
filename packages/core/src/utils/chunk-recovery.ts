/**
 * A route chunk gone stale across a deploy: reload once, and only when the origin serves a different build than this
 * page. Every other failure to load is the caller's.
 */
import { Effect, Cause } from 'effect';
import { settle } from '../obs/index';
import { isNewerDeployedBuild } from './session-recovery';

/**
 * Lowercased browser messages for a failed dynamic import; a failed `import()` is a bare `TypeError`.
 * The message is only a gate: the release comparison in {@link loadRouteChunk} authorises a reload.
 */
const STALE_CHUNK_MESSAGES = [
  // Chromium, and what Vite's preload helper rethrows.
  'failed to fetch dynamically imported module',
  // Firefox.
  'error loading dynamically imported module',
  // Safari.
  'importing a module script failed',
  // Vite's preload helper, for the chunk's stylesheet.
  'unable to preload css for',
] as const;

/** Whether a caught error is a module that would not load. */
function isStaleChunkFailure(cause: Error): boolean {
  const message = cause.message.toLowerCase();

  return STALE_CHUNK_MESSAGES.some((known) => message.includes(known));
}

/** `sessionStorage` key: must survive the reload it guards and die with the tab. */
export const CHUNK_RELOAD_KEY = 'kinu.chunk-reload';

interface ChunkReloadStore {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

/** Claim the one reload allowed per build transition per tab; the key holds the build reloaded to. */
function claimChunkReload(session: ChunkReloadStore, target: string): boolean {
  if (session.getItem(CHUNK_RELOAD_KEY) === target) return false;
  session.setItem(CHUNK_RELOAD_KEY, target);

  return true;
}

interface ChunkRecoveryDeps {
  baseline: () => Promise<string | null>;
  live: () => Promise<string | null>;
  session: ChunkReloadStore;
  reload: () => void;
}

/**
 * Load a route's chunk, reloading once for a confirmed stale one; every other failure rethrows unchanged.
 * On reload it never settles, so the Suspense fallback holds until the document is replaced.
 */
export function loadRouteChunk<Module>(
  load: () => Promise<Module>,
  deps: ChunkRecoveryDeps,
): Promise<Module> {
  return settle(Effect.catchCause(Effect.promise(async () => load()), (failed) => Effect.gen(function* () {
    const cause = Cause.squash(failed);

    if (!(cause instanceof Error) || !isStaleChunkFailure(cause)) return yield* Effect.failCause(failed);
    const live = yield* Effect.promise(async () => deps.live());

    if (live === null) return yield* Effect.failCause(failed);

    if (!isNewerDeployedBuild(yield* Effect.promise(async () => deps.baseline()), live)) return yield* Effect.failCause(failed);

    if (!claimChunkReload(deps.session, live)) return yield* Effect.failCause(failed);
    deps.reload();
    const { promise } = Promise.withResolvers<Module>();

    return yield* Effect.promise(async () => promise);
  })));
}
