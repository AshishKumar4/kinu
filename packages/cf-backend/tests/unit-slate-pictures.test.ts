/**
 * A slate's picture over real SQLite and an R2 bucket over a Map: when a picture falls due after renders, what a shot
 * stores and replaces, how a failed shot waits, and that a capture's own handle opens its port only while it shoots.
 */
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { sha256Hex } from '@kinu.run/core';
import { initSlatePictureTable, pictureKey, SlatePictures, type Camera, type PictureCapture } from '../src/slates/pictures';
import { durableSqlStorage } from './helpers/programmatic-host';
import { memoryBucket, type MemoryBucket } from './helpers/r2';

const databases: Database[] = [];

afterEach(() => {
  setSystemTime();

  for (const database of databases.splice(0)) database.close();
});

const T0 = 1_800_000_000_000;

const PORT = 3000;

function pictures(): SlatePictures {
  const database = new Database(':memory:');
  databases.push(database);
  const sql = durableSqlStorage(database);
  initSlatePictureTable((ddl) => { sql.exec(ddl); });

  return new SlatePictures(sql);
}

/** A camera whose shots are `frames` in turn. */
function shooting(...frames: Uint8Array[]): Camera {
  return {
    async shoot() {
      const frame = frames.shift();

      if (frame === undefined) throw new Error('no frame');

      return frame;
    },
    async close() {},
  };
}

/** A camera whose page never loads. */
const failing: Camera = {
  async shoot() { throw new Error('the page never loaded'); },
  async close() {},
};

function capture(lens: Camera, bucket: MemoryBucket = memoryBucket()): PictureCapture {
  return { workspace: 'ledger', bucket, url: async (port, token) => `https://${String(port)}-${token}.preview.test/`, camera: async () => lens };
}

const A = new Uint8Array([1, 2, 3]);

const B = new Uint8Array([4, 5, 6]);

describe('when a picture falls due', () => {
  test('30 s after the last render, and never more than 2 min after the first of a burst', () => {
    const store = pictures();

    store.rendered('board', PORT, T0);
    expect(store.nextDueAt()).toBe(T0 + 30_000);

    store.rendered('board', PORT, T0 + 20_000);
    expect(store.nextDueAt()).toBe(T0 + 50_000);

    for (let at = T0 + 40_000; at <= T0 + 110_000; at += 20_000) store.rendered('board', PORT, at);
    expect(store.nextDueAt()).toBe(T0 + 120_000);
  });
});

describe('a shot', () => {
  test('stores the picture under its digest and replaces the one before; the same bytes write nothing', async () => {
    const store = pictures();
    const bucket = memoryBucket();

    store.rendered('board', PORT, T0);
    expect(await store.captureDue(capture(shooting(A), bucket), T0 + 30_000)).toBe(true);
    expect(store.digests().get('board')).toBe(sha256Hex(A));
    expect([...bucket.objects.keys()]).toEqual([pictureKey('ledger', 'board', sha256Hex(A))]);
    expect(store.nextDueAt()).toBeNull();

    store.rendered('board', PORT, T0 + 60_000);
    expect(await store.captureDue(capture(shooting(B), bucket), T0 + 90_000)).toBe(true);
    expect([...bucket.objects.keys()]).toEqual([pictureKey('ledger', 'board', sha256Hex(B))]);

    store.rendered('board', PORT, T0 + 120_000);
    expect(await store.captureDue(capture(shooting(B), bucket), T0 + 150_000)).toBe(false);
    expect([...bucket.objects.keys()]).toEqual([pictureKey('ledger', 'board', sha256Hex(B))]);
  });

  test('that fails keeps the old picture and waits longer each time, three tries at most', async () => {
    const store = pictures();
    const bucket = memoryBucket();

    store.rendered('board', PORT, T0);
    await store.captureDue(capture(shooting(A), bucket), T0 + 30_000);
    store.rendered('board', PORT, T0 + 60_000);

    // A failure waits from when it failed.
    setSystemTime(T0 + 90_000);
    await store.captureDue(capture(failing, bucket), T0 + 90_000);
    expect(store.nextDueAt()).toBe(T0 + 150_000);

    setSystemTime(T0 + 150_000);
    await store.captureDue(capture(failing, bucket), T0 + 150_000);
    expect(store.nextDueAt()).toBe(T0 + 270_000);

    setSystemTime(T0 + 270_000);
    await store.captureDue(capture(failing, bucket), T0 + 270_000);
    expect(store.nextDueAt()).toBeNull();
    expect(store.digests().get('board')).toBe(sha256Hex(A));
    expect([...bucket.objects.keys()]).toEqual([pictureKey('ledger', 'board', sha256Hex(A))]);
  });

  test('with no browser session free waits its backoff, so the wake is not due again at once', async () => {
    const store = pictures();
    store.rendered('board', PORT, T0);
    setSystemTime(T0 + 30_000);

    const busy: PictureCapture = { ...capture(shooting(A)), camera: async () => { throw new Error('no session is free'); } };

    await expect(store.captureDue(busy, T0 + 30_000)).rejects.toThrow('no session is free');
    expect(store.nextDueAt()).toBe(T0 + 90_000);
  });

  test('opens its slate\'s port with a handle of its own, only while it shoots and for 2 minutes at most', async () => {
    const store = pictures();
    const handles: Array<{ handle: string; open: boolean; otherPort: boolean; pastItsLife: boolean }> = [];

    const watching: Camera = {
      async shoot(url) {
        const handle = /^https:\/\/\d+-([a-f0-9]{24})\./u.exec(url)?.[1]?.slice(0, 10) ?? '';
        handles.push({
          handle,
          open: store.captures(PORT, handle, T0 + 30_000),
          otherPort: store.captures(PORT + 1, handle, T0 + 30_000),
          pastItsLife: store.captures(PORT, handle, T0 + 150_000),
        });

        return A;
      },
      async close() {},
    };

    store.rendered('board', PORT, T0);
    setSystemTime(T0 + 30_000);
    await store.captureDue(capture(watching), T0 + 30_000);

    const [shot] = handles;
    expect(shot).toMatchObject({ open: true, otherPort: false, pastItsLife: false });
    expect(store.captures(PORT, shot?.handle ?? '', T0 + 30_000)).toBe(false);
  });
});
