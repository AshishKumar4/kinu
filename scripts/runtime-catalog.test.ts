// The deployment's runtime catalog: the digest-addressed copy a hosted `nimbus install` reads is made from the latest
// catalog only when that is the pinned one, and an object untrue to its name is never trusted.
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { ensureRuntimeCatalog, type CatalogBucket } from './runtime-catalog';

const CATALOG = new TextEncoder().encode('{"version":1,"runtimes":{"cpython":{"default":"3.13.14"}}}');

const PINNED = createHash('sha256').update(CATALOG).digest('hex');

/** A bucket over a map, recording what it was asked to write. */
function bucketOf(objects: Record<string, Uint8Array>): CatalogBucket & { readonly written: string[] } {
  const held = new Map(Object.entries(objects));
  const written: string[] = [];

  return {
    written,
    read: async (key) => held.get(key),
    write: async (key, bytes) => {
      written.push(key);
      held.set(key, bytes);
    },
  };
}

describe('the runtime catalog a deployment pins', () => {
  test('is copied from the latest catalog when that is the pin, and found in place the next time', async () => {
    const bucket = bucketOf({ 'catalog/v1.json': CATALOG });

    expect(await ensureRuntimeCatalog(bucket, PINNED)).toEqual({ kind: 'copied', key: `catalog/sha256/${PINNED}.json` });
    expect(await ensureRuntimeCatalog(bucket, PINNED)).toEqual({ kind: 'present', key: `catalog/sha256/${PINNED}.json` });
    expect(bucket.written).toEqual([`catalog/sha256/${PINNED}.json`]);
  });

  test('is refused, and nothing written, when the latest catalog is another one', async () => {
    const bucket = bucketOf({ 'catalog/v1.json': new TextEncoder().encode('{"version":1,"runtimes":{}}') });
    const outcome = await ensureRuntimeCatalog(bucket, PINNED);

    expect(outcome.kind).toBe('refused');
    expect(outcome.kind === 'refused' ? outcome.reason : '').toContain(`not the pinned ${PINNED}`);
    expect(bucket.written).toEqual([]);
  });

  test('is refused when the copy under its name hashes to something else', async () => {
    const bucket = bucketOf({ [`catalog/sha256/${PINNED}.json`]: new TextEncoder().encode('{}'), 'catalog/v1.json': CATALOG });
    const outcome = await ensureRuntimeCatalog(bucket, PINNED);

    expect(outcome.kind === 'refused' ? outcome.reason : '').toContain('not its name');
    expect(bucket.written).toEqual([]);
  });

  test('is refused when neither copy is there, or the pin is not a digest', async () => {
    expect(await ensureRuntimeCatalog(bucketOf({}), PINNED)).toMatchObject({ kind: 'refused' });
    expect(await ensureRuntimeCatalog(bucketOf({ 'catalog/v1.json': CATALOG }), 'latest')).toMatchObject({ kind: 'refused' });
  });
});
