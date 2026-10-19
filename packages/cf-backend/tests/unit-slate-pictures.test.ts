/**
 * A slate's picture over real SQLite and an R2 bucket over a Map: when a picture falls due after renders, what a shot
 * stores and replaces, how a failed shot waits, and that a capture's own handle opens its port only while it shoots.
 */
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { pragmaStamps, repairSchema, sha256Hex } from '@kinu.run/core';
import { initSlatePictureTable, pictureKey, shareCaptureUrl, sharePictureKey, SlatePictures, type Camera, type PictureCapture } from '../src/slates/pictures';
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

/** `share` answers a listed share's host and publication: by default, no share is listed. */
function capture(lens: Camera, bucket: MemoryBucket = memoryBucket(), live: readonly string[] = ['board'], share: PictureCapture['share'] = async () => null): PictureCapture {
  return {
    workspace: 'ledger', bucket, url: async (port, token) => `https://${String(port)}-${token}.preview.test/`, share,
    slates: async () => new Set(live), camera: async () => lens,
  };
}

const A = new Uint8Array([1, 2, 3]);

const B = new Uint8Array([4, 5, 6]);

describe('when a picture falls due', () => {
  test('continued renders do not starve picture capture', async () => {
    const store = pictures();
    const until = T0 + 300_000;

    store.rendered('board', PORT, T0);
    expect(await store.captureDue(capture(shooting(A)), T0)).toBe(false);

    for (let at = T0 + 20_000; at <= until; at += 20_000) store.rendered('board', PORT, at);

    expect(await store.captureDue(capture(shooting(A)), until)).toBe(true);
    expect(store.digests().get('board')).toBe(sha256Hex(A));
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
    const firstRetryAt = Number(store.nextDueAt());
    expect(firstRetryAt).toBeGreaterThan(T0 + 90_000);

    setSystemTime(firstRetryAt);
    await store.captureDue(capture(failing, bucket), firstRetryAt);
    const secondRetryAt = Number(store.nextDueAt());
    expect(secondRetryAt - firstRetryAt).toBeGreaterThan(firstRetryAt - (T0 + 90_000));

    setSystemTime(secondRetryAt);
    await store.captureDue(capture(failing, bucket), secondRetryAt);
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

  test('is three a wake at most, oldest due first; the rest stay due for the next', async () => {
    const store = pictures();
    const bucket = memoryBucket();

    for (const [index, slate] of ['a', 'b', 'c', 'd'].entries()) store.rendered(slate, PORT + index, T0 + index);
    await store.captureDue(capture(shooting(A, B, new Uint8Array([7]), new Uint8Array([8])), bucket, ['a', 'b', 'c', 'd']), T0 + 40_000);

    expect([...store.digests().keys()].sort()).toEqual(['a', 'b', 'c']);
    expect(store.nextDueAt()).not.toBeNull();
  });

  test('of a slate removed while it ran keeps nothing', async () => {
    const store = pictures();
    const bucket = memoryBucket();

    const removing: Camera = {
      async shoot() {
        await store.forget('ledger', 'board', bucket);

        return A;
      },
      async close() {},
    };

    store.rendered('board', PORT, T0);

    expect(await store.captureDue(capture(removing, bucket), T0 + 30_000)).toBe(false);
    expect([...bucket.objects.keys()]).toEqual([]);
  });
});

describe("a removed slate's pictures", () => {
  async function pictured(bucket: MemoryBucket): Promise<SlatePictures> {
    const store = pictures();
    store.rendered('board', PORT, T0);
    await store.captureDue(capture(shooting(A), bucket), T0 + 30_000);

    return store;
  }

  test('go, and then its row', async () => {
    const bucket = memoryBucket();
    const store = await pictured(bucket);

    await store.forget('ledger', 'board', bucket);

    expect([...bucket.objects.keys()]).toEqual([]);
    expect(store.digests().size).toBe(0);
  });

  test('R2 refusing keeps the row that names them, and the removal still goes on', async () => {
    const bucket = memoryBucket();
    const store = await pictured(bucket);
    const refusing: MemoryBucket = { ...bucket, delete: async () => { throw new Error('R2 is unavailable'); } };

    await store.forget('ledger', 'board', refusing);

    expect(store.digests().get('board')).toBe(sha256Hex(A));
  });

  test('that R2 refused go on a later pass, which deletes rather than shoots a slate that is gone', async () => {
    const bucket = memoryBucket();
    const store = await pictured(bucket);
    setSystemTime(T0 + 60_000);

    await store.forget('ledger', 'board', { ...bucket, delete: async () => { throw new Error('R2 is unavailable'); } });
    const retryAt = Number(store.nextDueAt());
    expect(retryAt).toBeGreaterThan(T0 + 60_000);

    const unshot: PictureCapture = { ...capture(failing, bucket, []), camera: async () => { throw new Error('a gone slate was photographed'); } };

    expect(await store.captureDue(unshot, retryAt)).toBe(false);
    expect([...bucket.objects.keys()]).toEqual([]);
    expect(store.nextDueAt()).toBeNull();
  });
});

describe("a listed share's view", () => {
  const HOST = 'https://s1handle-token-ledger.preview.test/';

  /** Share s1 listed, serving `publication` now; listed no more once `listed` says so. */
  const s1 = (publication: () => string, listed: () => boolean = () => true): PictureCapture['share'] => async (share) =>
    (share === 's1' && listed() ? { url: shareCaptureUrl(HOST), publication: publication() } : null);

  /** A camera whose shots are `frames` in turn, keeping each address it was pointed at in `seen`. */
  function aimed(seen: string[], ...frames: Uint8Array[]): Camera {
    const lens = shooting(...frames);

    return {
      shoot: async (url) => {
        seen.push(url);

        return lens.shoot(url);
      },
      close: async () => {},
    };
  }

  test('is taken through its own host past its consent page, kept under the share, apart from the preview', async () => {
    const store = pictures();
    const bucket = memoryBucket();
    const seen: string[] = [];

    store.rendered('board', PORT, T0);
    store.listed('board', 's1', 'rev-1', T0);
    expect(store.shareDigest('board', 's1')).toBeNull();
    expect(await store.captureDue(capture(aimed(seen, A, B), bucket, ['board'], s1(() => 'rev-1')), T0 + 300_000)).toBe(true);

    // The preview's shot by its port and handle, the share's past its host's consent page: each in its own place.
    expect(seen.filter((url) => url.startsWith(HOST))).toEqual([`${HOST}__kinu/viewer?consent=1`]);
    const preview = store.digests().get('board');
    const shared = store.shareDigest('board', 's1');

    expect(new Set([preview, shared])).toEqual(new Set([sha256Hex(A), sha256Hex(B)]));
    expect([...bucket.objects.keys()].sort()).toEqual([pictureKey('ledger', 'board', preview ?? ''), sharePictureKey('ledger', 'board', 's1', shared ?? '')].sort());
    // A preview's capture handle is never a share view's.
    expect(store.shareDigest('board', 'preview')).toBeNull();
  });

  test('is taken again only at a new publication, which replaces the one before', async () => {
    const store = pictures();
    const bucket = memoryBucket();
    let publication = 'rev-1';

    store.listed('board', 's1', publication, T0);
    await store.captureDue(capture(shooting(A), bucket, ['board'], s1(() => publication)), T0 + 30_000);
    // Told again at the same publication (each start relists it): nothing is due.
    store.listed('board', 's1', publication, T0 + 30_000);
    expect(store.nextDueAt()).toBeNull();
    // Published anew: due again, and its new picture replaces the old.
    publication = 'rev-2';
    store.listed('board', 's1', publication, T0 + 30_000);
    expect(store.nextDueAt()).toBe(T0 + 60_000);
    expect(await store.captureDue(capture(shooting(B), bucket, ['board'], s1(() => publication)), T0 + 60_000)).toBe(true);
    expect(store.shareDigest('board', 's1')).toBe(sha256Hex(B));
    expect([...bucket.objects.keys()]).toEqual([sharePictureKey('ledger', 'board', 's1', sha256Hex(B))]);
  });

  test('of a share listed no more is not taken, and goes with its listing, leaving the preview', async () => {
    const store = pictures();
    const bucket = memoryBucket();
    const seen: string[] = [];

    store.listed('board', 's1', 'rev-1', T0);
    expect(await store.captureDue(capture(aimed(seen, A), bucket, ['board'], s1(() => 'rev-1', () => false)), T0 + 30_000)).toBe(false);
    expect(seen).toEqual([]);
    expect(store.nextDueAt()).toBeNull();

    store.rendered('board', PORT, T0);
    store.listed('board', 's1', 'rev-2', T0);
    await store.captureDue(capture(shooting(A, B), bucket, ['board'], s1(() => 'rev-2')), T0 + 300_000);
    expect(bucket.objects.size).toBe(2);
    await store.unlisted('ledger', 'board', 's1', bucket);
    expect(store.shareDigest('board', 's1')).toBeNull();
    expect([...bucket.objects.keys()]).toEqual([pictureKey('ledger', 'board', store.digests().get('board') ?? '')]);
  });
});

describe('a picture store from before views', () => {
  test("is rebuilt with its rows, each one its slate's preview, and takes share views beside them", () => {
    const database = new Database(':memory:');
    databases.push(database);
    database.exec(`CREATE TABLE slate_pictures (slate TEXT PRIMARY KEY, port INTEGER NOT NULL, digest TEXT, due_at INTEGER, due_since INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0, capture_handle TEXT, capture_until INTEGER);
      INSERT INTO slate_pictures (slate, port, digest) VALUES ('board', ${String(PORT)}, '${sha256Hex(A)}');
      PRAGMA user_version = 1;`);
    const sql = durableSqlStorage(database);

    const repair = repairSchema(sql, {
      schema: 'agent', tables: ['slate_pictures'], stamps: pragmaStamps(sql), transactionSync: (write) => database.transaction(write)(),
      init: () => { initSlatePictureTable((ddl) => { sql.exec(ddl); }); },
    }, 'pictures');

    expect({ rebuilt: repair?.rebuilt, refilled: repair?.refilled, refused: repair?.refused }).toEqual({ rebuilt: ['slate_pictures'], refilled: [], refused: null });
    const store = new SlatePictures(sql);

    expect(store.digests().get('board')).toBe(sha256Hex(A));
    store.listed('board', 's1', 'rev-1', T0);
    expect(store.shareDigest('board', 's1')).toBeNull();
    expect(store.nextDueAt()).toBe(T0 + 30_000);
  });
});

