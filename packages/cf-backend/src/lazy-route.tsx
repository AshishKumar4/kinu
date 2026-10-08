/**
 * Lazily-loaded routes that recover from a chunk gone stale across a deploy.
 * Reload once only when the origin serves a different build than this page; `lazy()` memoises rejection, so a failed lazy is re-minted.
 */

import { Effect } from 'effect';
import { settle } from '@kinu.run/core/obs';
import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import { fetchDeployedBuildSha, loadRouteChunk, pageDeployedBuildSha } from '@kinu.run/core';

/** Written by a browser gate to declare a chunk present; nothing in production reads it. */
export const CHUNK_FIXED_KEY = 'kinu.chunk-fixed';

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

  return function LazyRoute(props: Props) {
    const Loaded = current ??= lazy(() => settle(Effect.onError(Effect.promise(attempt), () => Effect.sync(() => {
      current = null;
    }))));

    return <Loaded {...props} />;
  };
}
