// Lazy page-in and clean eviction, measured against a store that counts what
// it serves.
//
// The three properties lane 4 rests on, each asserted from the ports rather
// than from a number the residency reports about itself:
//
//   1. A wake costs nothing per file. Registering a head's files issues no
//      read at all; the first touch is what pays.
//   2. A touch pays for what it touched. One coalesced range read per run of
//      missing pages, holes fetched never, and a second read of the same page
//      free.
//   3. Eviction risks nothing but a re-read. Drop a clean page, read it again,
//      and the bytes are the bytes — which is the only reason a box under disk
//      pressure may drop them at all.
import { describe, expect, test } from 'bun:test';

import { Residency, type FileGeometry } from '../src/candidates/residency';

/** The geometry of a file with no holes: one span over everything. Local to
 *  this suite; production builds geometry from the manifest, never from a
 *  size alone. */
function denseGeometry(size: number): FileGeometry {
  return { size, data: size === 0 ? [] : [{ offset: 0, length: size }] };
}
import { HYDRATE_PAGE_BYTES } from '../src/durability/contracts';

/** One immutable object per path, and the local file the container holds. */
class ModeledContainer {
  /** What the head serves: the true bytes, never mutated. */
  readonly stored = new Map<string, Uint8Array>();
  /** What the container holds: full length, zeros where nothing is resident. */
  readonly local = new Map<string, Uint8Array>();
  /** Every range read, in order: the remote operations a page-in paid for. */
  readonly reads: { path: string; offset: number; length: number }[] = [];
  clock = 1_000;

  /** Plant one file in the store and the placeholder that stands for it. */
  plant(path: string, bytes: Uint8Array): void {
    this.stored.set(path, bytes);
    this.local.set(path, new Uint8Array(bytes.byteLength));
  }

  residency(options: { pageBytes?: number; idleMs?: number } = {}): Residency {
    return new Residency({
      read: async (path, offset, length) => {
        this.reads.push({ path, offset, length });
        const held = this.stored.get(path);
        if (held === undefined) throw new Error(`no stored object at ${path}`);
        return held.subarray(offset, offset + length);
      },
      place: (path, offset, bytes) => {
        this.local.get(path)!.set(bytes, offset);
      },
      drop: (path, offset, length) => {
        this.local.get(path)!.fill(0, offset, offset + length);
      },
      now: () => this.clock,
      ...options,
    });
  }
}

/** Bytes that cannot be mistaken for a zero-filled placeholder. */
function pattern(size: number, seed = 1): Uint8Array {
  const bytes = new Uint8Array(size);
  let state = seed;
  for (let at = 0; at < size; at += 1) {
    state = (state * 1_103_515_245 + 12_345) & 0x7fffffff;
    bytes[at] = (state >>> 16) & 0xff;
  }
  return bytes;
}

describe('a residency pages in on first touch', () => {
  test('registering a head reads nothing, whatever the head holds', () => {
    // THE WAKE PROPERTY. A thousand files enter the residency and the store
    // serves none of them: an attach that costs one read per file is exactly
    // the 200,006-operation wake cell 6.13 measured on 2026-09-02.
    const container = new ModeledContainer();
    const residency = container.residency();
    for (let index = 0; index < 1_000; index += 1) {
      const path = `pkg/file-${index}.bin`;
      container.plant(path, pattern(16, index + 1));
      residency.register(path, denseGeometry(16));
    }
    expect(container.reads).toEqual([]);
    expect(residency.work()).toEqual({ rangeGets: 0, bytesFetched: 0, bytesRequested: 0 });
    expect(residency.hydration()).toEqual({ residentBytes: 0, treeBytes: 16_000, placeholders: 1_000 });
  });

  test('one touch pays for one file, and a second touch of it pays nothing', async () => {
    const container = new ModeledContainer();
    const residency = container.residency();
    for (const index of [0, 1, 2]) {
      container.plant(`f-${index}`, pattern(16, index + 7));
      residency.register(`f-${index}`, denseGeometry(16));
    }
    await residency.hydrate('f-1', 0, 16);
    expect(container.reads).toEqual([{ path: 'f-1', offset: 0, length: 16 }]);
    expect(container.local.get('f-1')).toEqual(container.stored.get('f-1'));
    // The other two are still placeholders: nothing read them.
    expect(container.local.get('f-0')).toEqual(new Uint8Array(16));
    expect(residency.hydration()).toEqual({ residentBytes: 16, treeBytes: 48, placeholders: 2 });

    await residency.hydrate('f-1', 0, 16);
    expect(container.reads).toHaveLength(1);
    expect(residency.work()).toEqual({ rangeGets: 1, bytesFetched: 16, bytesRequested: 32 });
  });

  test('a page-in fetches one window, not the file, and coalesces its misses', async () => {
    // The 1 MiB quantum, and the reason it is one: a 64 KiB read of an 8 MiB
    // file brings back its page and leaves the other seven alone.
    const container = new ModeledContainer();
    const size = 8 * HYDRATE_PAGE_BYTES;
    container.plant('big.bin', pattern(size, 3));
    const residency = container.residency();
    residency.register('big.bin', denseGeometry(size));

    await residency.hydrate('big.bin', 3 * HYDRATE_PAGE_BYTES + 4096, 64 * 1024);
    expect(container.reads).toEqual([
      { path: 'big.bin', offset: 3 * HYDRATE_PAGE_BYTES, length: HYDRATE_PAGE_BYTES },
    ]);
    expect(residency.work()).toEqual({
      rangeGets: 1,
      bytesFetched: HYDRATE_PAGE_BYTES,
      bytesRequested: 64 * 1024,
    });

    // Three adjacent misses are ONE range read, not three: the window is the
    // unit of the round trip, and the round trip is what a page-in pays for.
    container.reads.length = 0;
    await residency.hydrate('big.bin', 5 * HYDRATE_PAGE_BYTES, 3 * HYDRATE_PAGE_BYTES);
    expect(container.reads).toEqual([
      { path: 'big.bin', offset: 5 * HYDRATE_PAGE_BYTES, length: 3 * HYDRATE_PAGE_BYTES },
    ]);
  });

  test('a hole is never fetched, so a sparse file costs its data', async () => {
    // Cell 6.14's file: 1 GiB long, 1 MiB of data. A wake that read its SIZE
    // would move a gigabyte for a megabyte of content.
    const container = new ModeledContainer();
    const size = 1024 * HYDRATE_PAGE_BYTES;
    const data = pattern(HYDRATE_PAGE_BYTES, 5);
    const whole = new Uint8Array(size);
    whole.set(data, 512 * HYDRATE_PAGE_BYTES);
    container.plant('sparse.bin', whole);
    const geometry: FileGeometry = {
      size,
      data: [{ offset: 512 * HYDRATE_PAGE_BYTES, length: HYDRATE_PAGE_BYTES }],
    };
    const residency = container.residency();
    residency.register('sparse.bin', geometry);

    await residency.hydrate('sparse.bin', 0, size);
    expect(container.reads).toEqual([
      { path: 'sparse.bin', offset: 512 * HYDRATE_PAGE_BYTES, length: HYDRATE_PAGE_BYTES },
    ]);
    expect(container.local.get('sparse.bin')).toEqual(whole);
    expect(residency.hydration()).toEqual({
      residentBytes: HYDRATE_PAGE_BYTES,
      treeBytes: HYDRATE_PAGE_BYTES,
      placeholders: 0,
    });
  });

  test('a read past the end pays for nothing, as pread answers nothing', async () => {
    const container = new ModeledContainer();
    container.plant('short.bin', pattern(32, 9));
    const residency = container.residency();
    residency.register('short.bin', denseGeometry(32));
    await residency.hydrate('short.bin', 64, 4096);
    expect(container.reads).toEqual([]);
    await residency.hydrate('short.bin', 16, 4096);
    expect(container.reads).toEqual([{ path: 'short.bin', offset: 0, length: 32 }]);
  });
});

describe('eviction drops clean bytes and risks only a re-read', () => {
  test('evict, re-read, bytes identical', async () => {
    // THE WHOLE BET, stated as an assertion. A dropped page is gone from the
    // container — the local file reads as zeros again — and the re-read brings
    // back exactly the bytes the head declares, because the range read is
    // idempotent and held to its digest by the view underneath.
    const container = new ModeledContainer();
    const size = 4 * HYDRATE_PAGE_BYTES;
    const bytes = pattern(size, 11);
    container.plant('db.bin', bytes);
    const residency = container.residency();
    residency.register('db.bin', denseGeometry(size));

    await residency.hydrate('db.bin', 0, size);
    expect(container.local.get('db.bin')).toEqual(bytes);
    const beforeEviction = residency.work();

    container.clock += 600_000;
    const swept = residency.evict();
    expect(swept).toEqual({ deletes: 4, markPages: 4, markBytes: size });
    expect(container.local.get('db.bin')).toEqual(new Uint8Array(size));
    expect(residency.hydration().residentBytes).toBe(0);

    await residency.hydrate('db.bin', 0, size);
    expect(container.local.get('db.bin')).toEqual(bytes);
    expect(residency.work().rangeGets).toBe(beforeEviction.rangeGets + 1);
  });

  test('a page touched inside the window survives the sweep', async () => {
    // The window is what makes eviction a cache policy rather than a coin
    // toss: a page the workload is reading right now is not a candidate.
    const container = new ModeledContainer();
    const size = 2 * HYDRATE_PAGE_BYTES;
    container.plant('hot.bin', pattern(size, 13));
    const residency = container.residency({ idleMs: 60_000 });
    residency.register('hot.bin', denseGeometry(size));
    await residency.hydrate('hot.bin', 0, size);

    container.clock += 30_000;
    expect(residency.evict()).toEqual({ deletes: 0, markPages: 2, markBytes: size });
    expect(container.local.get('hot.bin')).toEqual(container.stored.get('hot.bin'));

    // One page is read again at the 30-second mark; the other is not touched.
    await residency.hydrate('hot.bin', 0, 4096);
    container.clock += 31_000;
    expect(residency.evict()).toMatchObject({ deletes: 1 });
    expect(residency.hydration().residentBytes).toBe(HYDRATE_PAGE_BYTES);
  });

  test('disk pressure sweeps with the window at zero', async () => {
    // What cell 6.18 buys with an eviction hook: the room for the next write,
    // now, rather than a refusal.
    const container = new ModeledContainer();
    container.plant('a.bin', pattern(HYDRATE_PAGE_BYTES, 17));
    const residency = container.residency();
    residency.register('a.bin', denseGeometry(HYDRATE_PAGE_BYTES));
    await residency.hydrate('a.bin', 0, HYDRATE_PAGE_BYTES);

    expect(residency.evict()).toMatchObject({ deletes: 0 });
    expect(residency.evict({ idleMs: 0 })).toMatchObject({ deletes: 1 });
    expect(residency.residentBytes).toBe(0);
    expect(residency.gcWork()).toEqual({ deletes: 1, markPages: 2, markBytes: 2 * HYDRATE_PAGE_BYTES });
  });

  test('a path the workload wrote is out of the sweep\'s reach', async () => {
    // The only way a drop could lose data is by dropping a byte the head does
    // not hold. A write takes the path out of the residency, so there is no
    // such page to find.
    const container = new ModeledContainer();
    container.plant('w.bin', pattern(HYDRATE_PAGE_BYTES, 19));
    const residency = container.residency();
    residency.register('w.bin', denseGeometry(HYDRATE_PAGE_BYTES));
    await residency.hydrate('w.bin', 0, HYDRATE_PAGE_BYTES);

    residency.forget('w.bin');
    container.local.get('w.bin')!.fill(0xab);
    expect(residency.evict({ idleMs: 0 })).toEqual({ deletes: 0, markPages: 0, markBytes: 0 });
    expect(container.local.get('w.bin')).toEqual(new Uint8Array(HYDRATE_PAGE_BYTES).fill(0xab));
    expect(residency.holds('w.bin')).toBe(false);
  });

  test('a publish makes the whole tree clean again, and evictable', async () => {
    // After a publish every byte in the tree is a cache of the new head: that
    // is what lets a box that just committed give its disk back.
    const container = new ModeledContainer();
    container.plant('p.bin', pattern(3 * HYDRATE_PAGE_BYTES, 23));
    const residency = container.residency();
    residency.registerResident('p.bin', denseGeometry(3 * HYDRATE_PAGE_BYTES));
    expect(residency.hydration()).toEqual({
      residentBytes: 3 * HYDRATE_PAGE_BYTES,
      treeBytes: 3 * HYDRATE_PAGE_BYTES,
      placeholders: 0,
    });
    expect(container.reads).toEqual([]);

    expect(residency.evict({ idleMs: 0 })).toMatchObject({ deletes: 3 });
    await residency.hydrate('p.bin', 0, 3 * HYDRATE_PAGE_BYTES);
    expect(container.local.get('p.bin')).toEqual(container.stored.get('p.bin'));
  });

  test('a geometry that lies about its file refuses at registration', () => {
    const container = new ModeledContainer();
    const residency = container.residency();
    expect(() => residency.register('bad.bin', { size: 16, data: [{ offset: 8, length: 32 }] }))
      .toThrow(/lies outside a 16-byte file/u);
  });
});
