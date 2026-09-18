/**
 * Lazily-loaded routes, and the two things `React.lazy` alone cannot do for a
 * content-hashed chunk.
 *
 * ## The failure
 *
 * A code-split route is an `import()` of `/assets/<name>-<hash>.js`. The hash
 * changes every build, and a deploy replaces the asset bundle, so a tab that has
 * been open across a deploy is holding a document whose chunk URLs no longer
 * exist. The moment its reader opens the MCTS explorer or the control plane, the
 * import 404s and React throws — and what they see is "Something went wrong
 * rendering this view", for a view that is not broken at all. Reloading fixes it
 * completely, and nothing else does.
 *
 * ## Two mechanisms, and why both
 *
 * ONE GUARDED RELOAD, for a recognised stale chunk only. Recognition is two
 * independent facts, and both are required: the failure has to be a module-load
 * failure by its message ({@link isStaleChunkFailure} — the only signal a browser
 * gives), and the origin has to be serving a DIFFERENT build than this page
 * loaded. The second is the authority. It reuses the release identity that
 * already exists — `pageDeployedBuildSha` for the page, `fetchDeployedBuildSha`
 * for the origin, both reading `/api/health` — so a chunk that fails while the
 * build is unchanged is treated as what it is, a broken deploy or a broken
 * network, and is shown as an error rather than reloaded at.
 *
 * A REGENERATED LOADER, for everything else. `lazy()` memoises its loader's
 * REJECTION for the life of the component: once a chunk fails, every later render
 * of that same lazy component rethrows the old failure without re-attempting the
 * import. So the ErrorBoundary's "Try again" was decorative on these two routes —
 * it reset the boundary, the lazy component rethrew, and the fallback came
 * straight back. A fresh `lazy()` per mount is what clears it, and it clears only
 * THIS route's memo: a sibling lazy route keeps whatever it already had.
 *
 * ## What this is not
 *
 * Not a generic retry or resource framework. There is no backoff, no attempt
 * budget, no cache, and nothing here is reachable except by naming a route
 * loader. The reload is bounded by a per-tab guard keyed on the build being
 * reloaded TO ({@link CHUNK_RELOAD_KEY}), so one build transition can cost at
 * most one reload even if the skew check is somehow satisfied twice.
 */

import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import { fetchDeployedBuildSha, isNewerDeployedBuild, pageDeployedBuildSha } from '@kinu.run/core';

/**
 * The messages browsers use when a dynamic import does not load, lowercased.
 *
 * Matching on prose is the weakest kind of recognition and it is the only kind
 * available: a failed `import()` rejects with a plain `TypeError` carrying no
 * code, no status and no structured cause, and the wording differs per engine.
 * Vite's own guidance for its `vite:preloadError` event is this same test. Which
 * is why the message is a GATE and never the decision — the release comparison in
 * {@link loadRouteChunk} is what authorises a reload, and a message this list
 * fails to recognise costs an error screen rather than a wrong reload.
 *
 * The fourth entry is Vite's own preload helper rather than an engine: a chunk's
 * stylesheet is fetched by `__vitePreload`, which throws its own message when the
 * CSS is the file that has gone.
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

/** Whether a caught value is a module that would not load. */
function isStaleChunkFailure<Failure>(cause: Failure): boolean {
  if (!(cause instanceof Error)) return false;
  const message = cause.message.toLowerCase();

  return STALE_CHUNK_MESSAGES.some((known) => message.includes(known));
}

/**
 * Where the one-reload-per-build claim is kept.
 *
 * `sessionStorage`, so it survives the reload it is guarding and dies with the
 * tab: a guard in memory would be erased by the very reload it exists to bound,
 * and one in `localStorage` would outlive the tab and suppress a legitimate
 * recovery in a session that comes later.
 */
export const CHUNK_RELOAD_KEY = 'kinu.chunk-reload';

/**
 * The two methods the guard uses.
 *
 * Narrower than `Storage` for the same reason the feedback store is narrower than
 * `R2Bucket`: two methods, because two are used. `sessionStorage` satisfies it
 * structurally, and a policy that can be driven without a browser is a policy
 * that gets tested.
 */
export interface ChunkReloadStore {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

/**
 * Claim the one reload allowed for `target`.
 *
 * One key holding the build most recently reloaded TO, not a key per build: the
 * question is only ever "have I already reloaded for this one?", and a growing
 * set of keys would answer it no better. A third build landing rewrites the value
 * and earns its own single reload, so the bound is one reload per build
 * transition per tab, and a loop is impossible in either direction.
 */
function claimChunkReload(session: ChunkReloadStore, target: string): boolean {
  if (session.getItem(CHUNK_RELOAD_KEY) === target) return false;
  session.setItem(CHUNK_RELOAD_KEY, target);

  return true;
}

/**
 * The key a browser gate writes to declare a chunk present.
 *
 * Owned here rather than by the gallery fixture, because it is read by the
 * fixture and written by the suite and a key with two spellings is a test that
 * passes for the wrong reason. Nothing in production reads it: the recovery's
 * only signal is the release comparison above.
 */
export const CHUNK_FIXED_KEY = 'kinu.chunk-fixed';

/** Everything the recovery policy reaches outside itself, so it can be driven
 *  without a browser and without a deploy. */
export interface ChunkRecoveryDeps {
  /** The build this page loaded. */
  baseline: () => Promise<string | null>;
  /** The build the origin is serving now. */
  live: () => Promise<string | null>;
  session: ChunkReloadStore;
  reload: () => void;
}

/**
 * Load a route's chunk, recovering from a stale one exactly once.
 *
 * Every arm that is not a recognised, confirmed, unclaimed stale chunk rethrows
 * the original failure unchanged, so the ErrorBoundary above shows the same error
 * it would have shown before this existed. That is the whole shape: one narrow
 * recovery, and no change to any other outcome.
 *
 * On the recovery path it never settles. Resolving would render a route out of a
 * bundle we have just established is gone, and rejecting would flash an error
 * screen over a document that is about to be replaced; leaving the promise open
 * holds the Suspense fallback until the reload lands, which is the honest picture
 * of what is happening.
 */
export async function loadRouteChunk<Module>(
  load: () => Promise<Module>,
  deps: ChunkRecoveryDeps,
): Promise<Module> {
  try {
    return await load();
  } catch (cause) {
    if (!isStaleChunkFailure(cause)) throw cause;
    // The origin first, because it is the read that costs a request; the page's
    // own baseline was captured at load and is already resolved.
    const live = await deps.live();

    if (live === null) throw cause;

    if (!isNewerDeployedBuild(await deps.baseline(), live)) throw cause;

    if (!claimChunkReload(deps.session, live)) throw cause;
    deps.reload();
    const { promise } = Promise.withResolvers<Module>();

    return await promise;
  }
}

/**
 * One lazily-loaded route.
 *
 * ## The lazy, and where it may NOT live
 *
 * `lazy()` caches its loader's outcome for the life of the component, rejection
 * included, so the ErrorBoundary's "Try again" was decorative on these routes:
 * it reset the boundary, the same `lazy()` rethrew the cached failure without
 * touching the network, and the fallback came straight back. The lazy is
 * therefore REPLACED after a rejection: the loader clears the shared slot on
 * its way out, and the next mount — the boundary's retry — mints a fresh one and
 * re-attempts the import. A failure costs the small fixed number of renders
 * React performs while surfacing it, each minting at most once.
 *
 * It is emphatically not held in the component's own state. A component that
 * suspends on its first render is thrown away with its hooks: React commits the
 * fallback while the chunk crosses the network and retries the mount from
 * scratch once the promise settles, so a `useState(() => lazy(...))` handed
 * every retry a NEW pending lazy and the route never rendered at all. Measured
 * on the deployed build 2f4f3b27d (2026-09-18): `/deploy` stayed on its
 * fallback for good with the chunk loaded, while the gallery fixture — whose
 * loader resolved before the fallback committed — kept rendering. The slot
 * below is module-scoped for that reason: every mount of this route shares the
 * one lazy until it is known to have failed.
 *
 * ## The examination, which is a different bound
 *
 * The recovery is examined ONCE per route per document. A repeat attempt goes
 * straight to the import: it re-runs the thing that failed, and if the chunk has
 * since become reachable the route renders — but it does not re-litigate the
 * build comparison, which would be a request to our own origin per attempt.
 *
 * Both pieces of state are per `lazyRoute` CALL, and that is what "clear only the
 * rejected loader" means here: a sibling split route has its own slot and its
 * own examination, and is never re-imported because this one failed.
 */
export function lazyRoute<Props extends object>(
  load: () => Promise<{ default: ComponentType<Props> }>,
): ComponentType<Props> {
  let examined = false;

  const attempt = async (): Promise<{ default: ComponentType<Props> }> => {
    if (examined) return await load();
    examined = true;

    return await loadRouteChunk(load, {
      baseline: pageDeployedBuildSha,
      live: fetchDeployedBuildSha,
      session: sessionStorage,
      reload: () => { location.reload(); },
    });
  };

  let current: LazyExoticComponent<ComponentType<Props>> | null = null;

  const mint = (): LazyExoticComponent<ComponentType<Props>> => lazy(async () => {
    try {
      return await attempt();
    } catch (cause) {
      current = null;
      throw cause;
    }
  });

  return function LazyRoute(props: Props) {
    const Loaded = current ??= mint();

    return <Loaded {...props} />;
  };
}
