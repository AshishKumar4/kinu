// The deployment's runtime catalog: the digest-addressed copy a hosted `nimbus install` reads is made from the latest
// catalog only when that is the pinned one, and an object untrue to its name is never trusted.
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { scratchDir } from '@kinu.run/test-utils';
import { ensureRuntimeCatalog, type CatalogBucket } from './runtime-catalog';

const CATALOG = new TextEncoder().encode('{"version":1,"runtimes":{"cpython":{"default":"3.13.14"}}}');

const PINNED = createHash('sha256').update(CATALOG).digest('hex');

const PINNED_KEY = `catalog/sha256/${PINNED}.json`;

function bucketOf(objects: Record<string, Uint8Array>): CatalogBucket & { readonly directory: string } {
  const directory = scratchDir('runtime-catalog-bucket');

  for (const [key, bytes] of Object.entries(objects)) {
    const file = join(directory, key);

    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  }

  return {
    directory,
    read: async (key) => existsSync(join(directory, key)) ? new Uint8Array(readFileSync(join(directory, key))) : undefined,
    write: async (key, bytes) => {
      const file = join(directory, key);

      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, bytes);
    },
  };
}

describe('the runtime catalog a deployment pins', () => {
  test('is copied from the latest catalog when that is the pin, and found in place the next time', async () => {
    const bucket = bucketOf({ 'catalog/v1.json': CATALOG });

    expect((await ensureRuntimeCatalog(bucket, PINNED)).kind).not.toBe('refused');
    expect(new Uint8Array(readFileSync(join(bucket.directory, PINNED_KEY)))).toEqual(CATALOG);
    expect(new Uint8Array(readFileSync(join(bucket.directory, 'catalog/v1.json')))).toEqual(CATALOG);

    const next = new TextEncoder().encode('{"version":1,"runtimes":{}}');

    writeFileSync(join(bucket.directory, 'catalog/v1.json'), next);

    expect((await ensureRuntimeCatalog(bucket, PINNED)).kind).not.toBe('refused');
    expect(new Uint8Array(readFileSync(join(bucket.directory, PINNED_KEY)))).toEqual(CATALOG);
    expect(new Uint8Array(readFileSync(join(bucket.directory, 'catalog/v1.json')))).toEqual(next);
  });

  test('is refused, and nothing written, when the latest catalog is another one', async () => {
    const latest = new TextEncoder().encode('{"version":1,"runtimes":{}}');
    const bucket = bucketOf({ 'catalog/v1.json': latest });
    const outcome = await ensureRuntimeCatalog(bucket, PINNED);

    expect(outcome.kind).toBe('refused');
    expect(existsSync(join(bucket.directory, PINNED_KEY))).toBe(false);
    expect(new Uint8Array(readFileSync(join(bucket.directory, 'catalog/v1.json')))).toEqual(latest);
  });

  test('is refused when the copy under its name hashes to something else', async () => {
    const corrupt = new TextEncoder().encode('{}');
    const bucket = bucketOf({ [PINNED_KEY]: corrupt, 'catalog/v1.json': CATALOG });
    const outcome = await ensureRuntimeCatalog(bucket, PINNED);

    expect(outcome.kind).toBe('refused');
    expect(new Uint8Array(readFileSync(join(bucket.directory, PINNED_KEY)))).toEqual(corrupt);
    expect(new Uint8Array(readFileSync(join(bucket.directory, 'catalog/v1.json')))).toEqual(CATALOG);
  });

  test('is refused when neither copy is there, or the pin is not a digest', async () => {
    const absent = bucketOf({});

    expect((await ensureRuntimeCatalog(absent, PINNED)).kind).toBe('refused');
    expect(readdirSync(absent.directory, { recursive: true })).toEqual([]);

    const invalidPin = bucketOf({ 'catalog/v1.json': CATALOG });

    expect((await ensureRuntimeCatalog(invalidPin, 'latest')).kind).toBe('refused');
    expect(existsSync(join(invalidPin.directory, 'catalog/sha256/latest.json'))).toBe(false);
    expect(existsSync(join(invalidPin.directory, PINNED_KEY))).toBe(false);
    expect(new Uint8Array(readFileSync(join(invalidPin.directory, 'catalog/v1.json')))).toEqual(CATALOG);
  });
});
