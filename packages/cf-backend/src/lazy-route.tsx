/**
 * Lazily-loaded routes that recover from a chunk gone stale across a deploy.
 * Reload once only when the origin serves a different build than this page; `lazy()` memoises rejection, so a failed lazy is re-minted.
 */

import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import { fetchDeployedBuildSha, isNewerDeployedBuild, pageDeployedBuildSha } from '@kinu.run/core';

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

export interface ChunkReloadStore {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

/** Claim the one reload allowed per build transition per tab; the key holds the build reloaded to. */
function claimChunkReload(session: ChunkReloadStore, target: string): boolean {
  if (session.getItem(CHUNK_RELOAD_KEY) === target) return false;
  session.setItem(CHUNK_RELOAD_KEY, target);

  return true;
}

/** Written by a browser gate to declare a chunk present; nothing in production reads it. */
export const CHUNK_FIXED_KEY = 'kinu.chunk-fixed';

export interface ChunkRecoveryDeps {
  baseline: () => Promise<string | null>;
  live: () => Promise<string | null>;
  session: ChunkReloadStore;
  reload: () => void;
}

/**
 * Load a route's chunk, reloading once for a confirmed stale one; every other failure rethrows unchanged.
 * On reload it never settles, so the Suspense fallback holds until the document is replaced.
 */
export async function loadRouteChunk<Module>(
  load: () => Promise<Module>,
  deps: ChunkRecoveryDeps,
): Promise<Module> {
  try {
    return await load();
  } catch (cause) {
    if (!(cause instanceof Error) || !isStaleChunkFailure(cause)) throw cause;
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
 * One lazily-loaded route. The lazy slot is per call, not component state: a component that suspends on first
 * mount loses its hooks, so `useState(() => lazy(...))` never rendered (measured 2026-09-18 on build c324cae9d).
 * A rejection clears the slot so a retry re-imports; the build comparison runs once per route per document.
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
