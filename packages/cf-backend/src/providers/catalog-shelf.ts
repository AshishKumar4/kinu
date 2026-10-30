/**
 * The catalog's shelf on a Worker: the colo's cache (the Cache API), which every isolate the colo runs reads. A Worker's
 * request rarely meets an isolate that read the catalog before it, so the isolate's own copy rarely holds there.
 */
import type { CatalogShelf } from '@kinu.run/core';

const SHELF = 'models-dev-slices';

const keyOf = (key: string): string => `https://models.dev/slices/${encodeURIComponent(key)}`;

export const colocatedCatalogShelf: CatalogShelf = {
  async read(key) {
    const kept = await (await caches.open(SHELF)).match(keyOf(key));

    return kept === undefined ? null : await kept.text();
  },
  async write(key, body, ttlSeconds) {
    await (await caches.open(SHELF)).put(keyOf(key), new Response(body, {
      headers: { 'content-type': 'application/json', 'cache-control': `max-age=${String(ttlSeconds)}` },
    }));
  },
};
