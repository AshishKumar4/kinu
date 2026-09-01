// Asking the store about a prefix.
//
// WHAT USED TO BE HERE, AND WHY IT IS NOT. This file existed because a mutant
// survived: every strategy test stubbed the upload port, so `putStream` — the
// isolate-side multipart uploader — had no coverage at all while three deployed
// runs were bricked by a byte count. That function has left the product.
// Payload now moves container-side through a prefix-scoped store mount, so
// there is no isolate-side upload left to cover, and its tests went with it
// rather than standing as coverage of a code path the product no longer has.
// The code moved to the benchmark that priced it
// (`scripts/fixtures/payload-transport/isolate-relay.ts`), where the geometry
// it must keep is held by `scripts/payload-transport.test.ts`.
//
// What remains is the listing work a box really does from its own binding, and
// the property both helpers exist for: a paged answer, never a first page
// reported as a total.
import { describe, expect, test } from 'bun:test';

import { deletePrefix, prefixInventory } from '../src/object-store';

/** Enough of an R2 bucket for the listing helpers, and NOTHING that could move
 *  a payload byte: a fake with no `put` is a fake that cannot pass a test which
 *  went back to uploading from here. */
function fakeBucket() {
  const bucket = {
    list: () => Promise.resolve({ objects: [], truncated: false }),
    delete: () => Promise.resolve(),
  };
  // SAFETY: constructed against the R2Bucket contract — the fake provides
  // exactly the members `deletePrefix` and `prefixInventory` reach, verified by
  // this suite driving both through their paging branches.
  const r2Bucket: R2Bucket = Object.create(bucket);
  return { bucket: r2Bucket };
}

describe('prefix helpers page rather than reporting a first page as a total', () => {
  test('an empty prefix is zero of both, not a missing answer', async () => {
    const store = fakeBucket();
    expect(await prefixInventory(store.bucket, 'boxes/x/')).toEqual({ objects: 0, bytes: 0 });
    expect(await deletePrefix(store.bucket, 'boxes/x/')).toBe(0);
  });

  test('an inventory follows the cursor to the end, and sums every page', async () => {
    // ONE LIST CALL IS BOUNDED. A helper that reported its first page as a total
    // is how a box under-reports what it is storing, so the paging is the
    // property under test rather than an implementation detail.
    const pages = [
      { objects: [{ key: 'a', size: 10 }, { key: 'b', size: 5 }], truncated: true, cursor: 'c1' },
      { objects: [{ key: 'c', size: 7 }], truncated: false },
    ];
    const asked: (string | undefined)[] = [];
    const bucket: R2Bucket = Object.create({
      list: (options: R2ListOptions) => {
        asked.push(options.cursor);
        return Promise.resolve(pages[asked.length - 1]);
      },
    });
    expect(await prefixInventory(bucket, 'boxes/x/')).toEqual({ objects: 3, bytes: 22 });
    expect(asked).toEqual([undefined, 'c1']);
  });

  test('a delete keeps listing until the prefix is empty, and counts every key', async () => {
    // Same hazard, other direction: a partial delete that reported success would
    // leave a box's bytes behind while claiming they were gone.
    const remaining = [['a', 'b'], ['c'], []];
    const deleted: string[][] = [];
    const bucket: R2Bucket = Object.create({
      list: () => {
        const keys = remaining[deleted.length] ?? [];
        return Promise.resolve({
          objects: keys.map(key => ({ key, size: 1 })),
          truncated: keys.length > 0,
        });
      },
      delete: (keys: string[]) => {
        deleted.push(keys);
        return Promise.resolve();
      },
    });
    expect(await deletePrefix(bucket, 'boxes/x/')).toBe(3);
    expect(deleted).toEqual([['a', 'b'], ['c']]);
  });
});
