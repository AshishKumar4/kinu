import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { link, mkdtemp, mkdir, readdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  HttpCasStore,
  nextScanCache,
  runOverlayRunner,
  type OverlayRunnerReceipt,
} from '../src/cas/overlay-runner';
import {
  KEY_CURSOR,
  KEY_MANIFEST,
  PREFIX_BLOBS,
  PREFIX_JOURNAL,
  PREFIX_TREE,
  blobKey,
  digestBytes,
  readFoldedSeq,
  stageBlobs,
  treeDirKey,
  type CasStore,
  type FileEntry,
} from '../src/cas';
import type { UpperSignature } from '../src/cas/state';
import {
  EgressFake,
  FIXED_ATTACH_TRACE,
  MemoryCasStore,
  WatchedCasStore,
  isPayloadKey,
  treeHeavyStore,
} from './support/cas-cost-probe';

/** An upper on disk, which the runner walks with real syscalls, and the store
 *  in memory, which is the seam every runner test asserts through. */
async function fixture(name: string): Promise<{ upper: string; store: MemoryCasStore; root: string }> {
  const root = await mkdtemp(join(tmpdir(), `overlay-runner-${name}-`));
  const upper = join(root, 'upper');
  await mkdir(upper);
  return { root, upper, store: new MemoryCasStore() };
}

/** The scan cache the runner keeps beside the bytes, by path. */
async function scanCache(store: CasStore): Promise<Record<string, UpperSignature>> {
  const bytes = await store.get('scan.json');
  if (bytes === null) throw new Error('no scan cache in the store');
  return JSON.parse(new TextDecoder().decode(bytes)).signatures;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

const text = (bytes: Uint8Array | null | undefined): string | undefined =>
  bytes === undefined || bytes === null ? undefined : new TextDecoder().decode(bytes);

describe('the stale bystander rule — an unjournalled path stays detectable', () => {
  const signature = (mtimeMs: number, hash: string): UpperSignature =>
    ({ kind: 'file', mode: 0o644, mtimeMs, size: 4, hash: hash.repeat(64) });

  test('a scanned path that was never journalled KEEPS ITS PREVIOUS ROW', () => {
    // The defect this rule exists for: staging stops at the first file that
    // changed under it, so later entries were scanned and never journalled.
    // Caching their fresh signatures tells the next scan the change was already
    // committed, and it is then lost on the recycle.
    const previous = new Map([['late.txt', signature(1, 'a')]]);
    const scanned = new Map([['late.txt', signature(2, 'b')]]);
    const next = nextScanCache(previous, scanned, new Set(['late.txt']), new Set());
    expect(next.signatures.get('late.txt')?.mtimeMs).toBe(1);
    expect(next.changed).toBe(false);
  });

  test('a journalled path takes the row the scan just measured', () => {
    const previous = new Map([['done.txt', signature(1, 'a')]]);
    const scanned = new Map([['done.txt', signature(2, 'b')]]);
    const next = nextScanCache(previous, scanned, new Set(), new Set());
    expect(next.signatures.get('done.txt')?.mtimeMs).toBe(2);
    expect(next.changed).toBe(true);
  });

  test('a tombstoned path loses its row, because it no longer exists to detect', () => {
    const previous = new Map([['gone.txt', signature(1, 'a')]]);
    const next = nextScanCache(previous, new Map(), new Set(), new Set(['gone.txt']));
    expect(next.signatures.has('gone.txt')).toBe(false);
    expect(next.changed).toBe(true);
  });

  test('a path the scan found unchanged survives, so it is not re-read next time', () => {
    const previous = new Map([['stable.txt', signature(1, 'a')]]);
    const next = nextScanCache(previous, new Map(), new Set(), new Set());
    expect(next.signatures.get('stable.txt')?.mtimeMs).toBe(1);
    expect(next.changed).toBe(false);
  });

  test('A RE-MEASURED ROW IDENTICAL TO THE STORED ONE IS NOT A CHANGE, which is what '
    + 'keeps an idle tick from writing', () => {
    // The condition the caller used to infer from entry counts. A scan that
    // measures the same bytes it measured last time produces the same row, and
    // storing it again would cost a PUT proportional to the whole upper to
    // publish bytes already there.
    const previous = new Map([['same.txt', signature(1, 'a')]]);
    const scanned = new Map([['same.txt', signature(1, 'a')]]);
    const next = nextScanCache(previous, scanned, new Set(), new Set());
    expect(next.changed).toBe(false);
  });

  test('a tombstone for a path with no row is not a change either', () => {
    const next = nextScanCache(new Map(), new Map(), new Set(), new Set(['never-cached.txt']));
    expect(next.changed).toBe(false);
  });
});

// ── the store, on the wire ──────────────────────────────────────────────────
//
// The runner stores through the SDK's egress endpoint, so these tests speak
// HTTP to an in-process fake of it and assert on the REQUESTS: which method,
// which path, how many. The deployed defect was on the wire — a 922 KB tick
// spent 97.9% of 400 s on 131 PUT + 128 HEAD through s3fs's write-temp-rename
// path (probe ocs09011400, 2026-09-01) — so the wire is where the bill is read.

describe('HttpCasStore', () => {
  const stream = (...parts: string[]): ReadableStream<Uint8Array> => new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
      controller.close();
    },
  });

  test('ONE PUT PER STAGED BLOB, receipt verified, no HEAD, no temp object, no rename', async () => {
    // The assignment's count. Three new files through the shipped `stageBlobs`
    // over the wire: exactly three requests, every one a PUT of the blob's own
    // key, answered by the store's receipt — and nothing else. Before
    // 2026-09-02 the same staging asked HEAD per blob first (three 404s here),
    // and the mount-backed store behind it wrote a `.tmp-<uuid>` and renamed.
    const egress = new EgressFake();
    try {
      const store = new HttpCasStore(egress.url);
      const bodies = new Map(['alpha', 'beta', 'gamma'].map(name => [`${name}.txt`, new TextEncoder().encode(`${name} body`)]));
      const entries: FileEntry[] = [...bodies].map(([path, bytes], at) => {
        const digest = digestBytes(bytes);
        return { kind: 'file', seq: at + 1, path, mode: 0o644, mtimeMs: 0, size: digest.size, hash: digest.hash, parts: digest.parts };
      });
      const staged = await stageBlobs({
        store, entries, readChunk: async (entry, _index, size) => bodies.get(entry.path)?.subarray(0, size) ?? null,
      });
      expect(staged.uploaded).toBe(3);
      expect(egress.requests).toEqual(entries.map(entry => `PUT /STORE/${blobKey(entry.hash)}`));
      expect(egress.requests.some(row => row.startsWith('HEAD') || row.includes('.tmp-'))).toBe(false);
      for (const entry of entries) expect(egress.objects.get(blobKey(entry.hash))?.bytes).toEqual(bodies.get(entry.path));
      expect(store.counters).toMatchObject({ putCalls: 3, getCalls: 0, listCalls: 0, bytesPut: 29 });
    } finally {
      await egress.stop();
    }
  });

  test('a receipt that names other bytes refuses the put, and the counter does not bill it', async () => {
    // THE RECEIPT IS CHECKED, not merely received. R2 answers a single-part PUT
    // with the MD5 of the body; an ETag for different bytes is a store that did
    // not keep what was sent, and a put that passed on the status alone would
    // journal a blob the store does not hold.
    const egress = new EgressFake();
    try {
      const store = new HttpCasStore(egress.url);
      egress.forgedEtag = 'd41d8cd98f00b204e9800998ecf8427e';
      await expect(store.put('blobs/ab/blob', new TextEncoder().encode('bytes'))).rejects.toThrow(/did not confirm blobs\/ab\/blob/);
      expect(store.counters).toMatchObject({ putCalls: 1, bytesPut: 0 });
      await store.put('blobs/ab/blob', new TextEncoder().encode('bytes'));
      expect(store.counters).toMatchObject({ putCalls: 2, bytesPut: 5 });
    } finally {
      await egress.stop();
    }
  });

  test('a streamed object is one PUT whose receipt covers the streamed bytes', async () => {
    const egress = new EgressFake();
    try {
      const store = new HttpCasStore(egress.url);
      await store.putStream('tree/bin/run', stream('one', 'two'), 6, { mode: 0o100755, mtimeMs: 1_700_000_000_000 });
      expect(egress.requests).toEqual(['PUT /STORE/tree/bin/run']);
      expect(text(egress.objects.get('tree/bin/run')?.bytes)).toBe('onetwo');
      expect(text(await store.get('tree/bin/run'))).toBe('onetwo');
      expect(store.counters).toMatchObject({ putCalls: 1, getCalls: 1, bytesPut: 6, bytesGot: 6 });
    } finally {
      await egress.stop();
    }
  });

  test('a stream that fails mid-flight publishes nothing and hands the stream back', async () => {
    const egress = new EgressFake();
    try {
      const store = new HttpCasStore(egress.url);
      const failing = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('half'));
        },
        pull(controller) {
          controller.error(new Error('the upper vanished mid-read'));
        },
      });
      await expect(store.putStream('blobs/ab/blob', failing, 8)).rejects.toThrow('the upper vanished mid-read');
      expect(egress.objects.has('blobs/ab/blob')).toBe(false);
      expect(failing.locked).toBe(false);
      expect(store.counters.bytesPut).toBe(0);
    } finally {
      await egress.stop();
    }
  });

  test('a stream that disagrees with its declared size publishes nothing', async () => {
    // A size measured before the read is how a file still settling gets
    // published as a complete object. The check refuses before the endpoint
    // could, and it leaves the store exactly as it found it.
    const egress = new EgressFake();
    try {
      const store = new HttpCasStore(egress.url);
      await expect(store.putStream('blobs/ab/blob', stream('three'), 9)).rejects.toThrow('streamed 5 bytes, expected 9');
      expect(egress.objects.has('blobs/ab/blob')).toBe(false);
      expect(store.counters.bytesPut).toBe(0);
    } finally {
      await egress.stop();
    }
  });

  test('a directory is an empty object under `tree/<path>/` typed as one', async () => {
    // The shape s3fs lists as a directory when it serves `tree/` as the lower,
    // and the one header the SDK's endpoint keeps on a PUT.
    const egress = new EgressFake();
    try {
      const store = new HttpCasStore(egress.url);
      await store.put(treeDirKey('a/b'), new Uint8Array(0), { mode: 0o40755 });
      expect(egress.requests).toEqual(['PUT /STORE/tree/a/b/']);
      expect(egress.objects.get('tree/a/b/')).toEqual({ bytes: new Uint8Array(0), contentType: 'application/x-directory' });
      await store.put('tree/a/file', new TextEncoder().encode('f'), { mode: 0o100644 });
      expect(egress.objects.get('tree/a/file')?.contentType).toBe('application/octet-stream');
    } finally {
      await egress.stop();
    }
  });

  test('keys are spelled the way the mount spells them, and a listing pages through', async () => {
    // s3fs percent-encodes everything outside the RFC 3986 unreserved set and
    // the endpoint keeps the path as it arrives, so the lower can only find a
    // `tree/` object the runner wrote under the same spelling. The listing
    // comes back XML-escaped and paged; the store hands back plain keys.
    const egress = new EgressFake(2);
    try {
      const store = new HttpCasStore(egress.url);
      const odd = 'tree/dir one/we&b<c>"d\'(e)*f!.txt';
      await store.put(odd, new TextEncoder().encode('x'));
      expect(egress.requests).toEqual(['PUT /STORE/tree/dir%20one/we%26b%3Cc%3E%22d%27%28e%29%2Af%21.txt']);
      for (const name of ['a', 'b', 'c']) await store.put(`tree/${name}`, new TextEncoder().encode(name));
      egress.requests.length = 0;
      expect(await store.list(PREFIX_TREE)).toEqual(['tree/a', 'tree/b', 'tree/c', odd]);
      expect(egress.requests).toHaveLength(2);
      expect(store.counters.listCalls).toBe(2);
      expect(text(await store.get(odd))).toBe('x');
      await store.delete(odd);
      expect(await store.get(odd)).toBeNull();
      expect(await store.list(PREFIX_TREE)).toEqual(['tree/a', 'tree/b', 'tree/c']);
      await expect(store.get('tree/../cursor.json')).rejects.toThrow('refused unsafe key');
    } finally {
      await egress.stop();
    }
  });

  test('a refusal from the endpoint is thrown with its status and its words', async () => {
    // The one diagnosis a runner can give: an unmounted binding answers 403
    // with a sentence, and that sentence has to reach the receipt's stderr.
    const egress = new EgressFake();
    try {
      const store = new HttpCasStore(egress.url);
      egress.refuseNext = { status: 403, words: 'Call mountBucket() with this bucket before accessing it.' };
      await expect(store.get('cursor.json')).rejects.toThrow('GET cursor.json: HTTP 403 Call mountBucket()');
      egress.refuseNext = { status: 500, words: 'binding not found' };
      await expect(store.put('cursor.json', new Uint8Array(1))).rejects.toThrow(/HTTP 500.*binding not found/);
      egress.refuseNext = { status: 403, words: 'read-only' };
      await expect(store.delete('cursor.json')).rejects.toThrow('DELETE cursor.json: HTTP 403 read-only');
      egress.refuseNext = { status: 403, words: 'not permitted' };
      await expect(store.list(PREFIX_JOURNAL)).rejects.toThrow('LIST journal/: HTTP 403 not permitted');
    } finally {
      await egress.stop();
    }
  });
});

describe('overlay CAS runner', () => {
  test('stages a changed upper file, records a receipt, and folds through the mounted store', async () => {
    const paths = await fixture('fold');
    try {
      await writeFile(join(paths.upper, 'hello.txt'), 'hello');
      const receipt = await runOverlayRunner({ operation: 'fold', upper: paths.upper, store: paths.store });
      // 5 content bytes plus the journal batch, the scan cache, the tree copy,
      // the manifest and the cursor — every object a fold writes, which is what
      // `movedBytes` now means. Asserted exactly below in its own suite.
      expect(receipt).toMatchObject({ operation: 'fold', entries: 1, foldedEntries: 1, foldedSeq: 1 });
      expect(receipt.movedBytes).toBeGreaterThan(5);
      expect((await scanCache(paths.store))['hello.txt']?.kind).toBe('file');
      expect(await readFoldedSeq(paths.store)).toBe(1);
      const blob = paths.store.objects.get(blobKey('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'));
      expect(new TextDecoder().decode(blob)).toBe('hello');
    } finally {
      await rm(paths.root, { recursive: true, force: true });
    }
  });

  test('writes symlinks as metadata-preserving journal entries without dereferencing them', async () => {
    const paths = await fixture('symlink');
    try {
      await symlink('../outside', join(paths.upper, 'link'));
      const receipt = await runOverlayRunner({ operation: 'checkpoint', upper: paths.upper, store: paths.store });
      expect(receipt.entries).toBe(1);
      expect((await scanCache(paths.store)).link).toMatchObject({ kind: 'symlink', target: '../outside' });
    } finally {
      await rm(paths.root, { recursive: true, force: true });
    }
  });
  test('selects one canonical file and records remaining inode aliases as hardlinks', async () => {
    const paths = await fixture('hardlink');
    try {
      await writeFile(join(paths.upper, 'a.txt'), 'same inode');
      await link(join(paths.upper, 'a.txt'), join(paths.upper, 'b.txt'));
      const receipt = await runOverlayRunner({ operation: 'checkpoint', upper: paths.upper, store: paths.store });
      expect(receipt.entries).toBe(2);
      const cached = await scanCache(paths.store);
      expect(cached['a.txt']?.inode).toBe(cached['b.txt']?.inode);
    } finally {
      await rm(paths.root, { recursive: true, force: true });
    }
  });

  test('restores a pending file through the beneath-only native writer', async () => {
    const paths = await fixture('restore');
    try {
      await writeFile(join(paths.upper, 'pending.txt'), 'restore me');
      await runOverlayRunner({ operation: 'checkpoint', upper: paths.upper, store: paths.store });
      await rm(join(paths.upper, 'pending.txt'));
      const receipt = await runOverlayRunner({ operation: 'restore', upper: paths.upper, store: paths.store });
      expect(receipt).toMatchObject({ operation: 'restore', entries: 1 });
      expect(await readFile(join(paths.upper, 'pending.txt'), 'utf8')).toBe('restore me');
    } finally {
      await rm(paths.root, { recursive: true, force: true });
    }
  });

  test('AN UNCHANGED FILE IS NOT RE-READ, because the cache is what bounds a tick', async () => {
    // THE COST CLAIM. The scan skips a file whose mode, size, mtime and inode
    // still match the cache, so this test writes DIFFERENT BYTES behind an
    // identical signature: a second checkpoint that reports one entry re-read
    // the file and the cache is doing nothing.
    const paths = await fixture('cache');
    try {
      const file = join(paths.upper, 'stable.txt');
      // A FIXED whole-millisecond stamp on both writes. `lstat().mtime` is a
      // Date, so reading the kernel's sub-millisecond mtime and setting it back
      // rounds differently on either side of the write and the signature would
      // differ for a reason this test is not about.
      const stamp = new Date(1_700_000_000_000);
      await writeFile(file, 'aaaa');
      await utimes(file, stamp, stamp);
      expect((await runOverlayRunner({ operation: 'checkpoint', upper: paths.upper, store: paths.store })).entries)
        .toBe(1);
      await writeFile(file, 'bbbb');
      await utimes(file, stamp, stamp);
      const second = await runOverlayRunner({ operation: 'checkpoint', upper: paths.upper, store: paths.store });
      expect(second.entries).toBe(0);
      expect(second.movedBytes).toBe(0);
    } finally {
      await rm(paths.root, { recursive: true, force: true });
    }
  });

  test('a cache this release did not write reads as absent instead of refusing', async () => {
    // A cache is not authority — the pending journal is. A row from another
    // format has to cost one re-scan, never brick every checkpoint.
    const paths = await fixture('cache-refused');
    try {
      await writeFile(join(paths.upper, 'a.txt'), 'body');
      await paths.store.put('scan.json', new TextEncoder().encode('{"version":1,"signatures":{"a.txt":"nonsense"}}\n'));
      const receipt = await runOverlayRunner({
        operation: 'checkpoint', upper: paths.upper, store: paths.store,
      });
      expect(receipt.entries).toBe(1);
      expect((await scanCache(paths.store))['a.txt']?.hash).toBe(sha256('body'));
    } finally {
      await rm(paths.root, { recursive: true, force: true });
    }
  });

  test('A FOLD REAPS THE SUPERSEDED BLOB AND KEEPS THE REACHABLE ONE', async () => {
    // The off-hot-path sweep. Without it every rewritten file leaves its old
    // bytes in the prefix forever, which is a cost regression no counter would
    // report. The reap runs after the fold's cursor, so a blob a pending entry
    // still names is never the one that goes.
    const paths = await fixture('sweep');
    try {
      const file = join(paths.upper, 'doc.txt');
      await writeFile(file, 'version-one');
      await runOverlayRunner({ operation: 'checkpoint', upper: paths.upper, store: paths.store });
      await writeFile(file, 'version-two-longer');
      const receipt = await runOverlayRunner({ operation: 'fold', upper: paths.upper, store: paths.store });

      expect(receipt.sweptBlobs).toBe(1);
      expect(paths.store.objects.has(blobKey(sha256('version-one')))).toBe(false);
      expect(text(paths.store.objects.get(blobKey(sha256('version-two-longer'))))).toBe('version-two-longer');
      expect(text(paths.store.objects.get('tree/doc.txt'))).toBe('version-two-longer');
    } finally {
      await rm(paths.root, { recursive: true, force: true });
    }
  });

  test('a tick never reaps, because listing the whole blob prefix is the sweep cost', async () => {
    const paths = await fixture('no-sweep');
    try {
      await writeFile(join(paths.upper, 'doc.txt'), 'one');
      await runOverlayRunner({ operation: 'checkpoint', upper: paths.upper, store: paths.store });
      await writeFile(join(paths.upper, 'doc.txt'), 'two-longer');
      const receipt = await runOverlayRunner({
        operation: 'checkpoint', upper: paths.upper, store: paths.store,
      });
      expect(receipt.sweptBlobs).toBe(0);
      expect(text(paths.store.objects.get(blobKey(sha256('one'))))).toBe('one');
    } finally {
      await rm(paths.root, { recursive: true, force: true });
    }
  });
});

// ── the attach bill ─────────────────────────────────────────────────────────
//
// THE CLAIM THIS STRATEGY IS FOR: recovery costs O(pending change), and when
// nothing is pending it costs a fixed amount no matter how large the tree has
// grown. That is unobservable from an end state — a store looks identical
// whether attach listed its whole prefix or read one object — so these tests
// assert the TRACE. They run the real runner over a real store through a
// wrapper that writes down every call.
//
// WHAT IS AND IS NOT PROVED HERE. These are store-level facts: which keys the
// CAS was asked for, how many listings were paid for, what was written. That
// the overlay's lower then serves `tree/` lazily through the mount is a
// platform premise, not something a test in this process can observe.

/** One restore against a watched store, and everything it was asked for. */
async function watchedRestore(paths: { upper: string; store: CasStore }): Promise<{
  readonly receipt: OverlayRunnerReceipt;
  readonly watched: WatchedCasStore;
}> {
  const watched = new WatchedCasStore(paths.store);
  const receipt = await runOverlayRunner({ operation: 'restore', upper: paths.upper, store: watched });
  return { receipt, watched };
}

/** Total bytes the recorded puts carried. */
function bytesWritten(watched: WatchedCasStore): number {
  return watched.calls
    .filter(call => call.op === 'put')
    .reduce((sum, call) => sum + call.bytes, 0);
}

describe('attach cost — fixed when nothing is pending, whatever the tree holds', () => {
  test('A 100× LARGER TREE COSTS THE SAME ATTACH, byte for byte and call for call', async () => {
    // THE TREE-SIZE TERM, measured. attach used to call `inventory()`, a LIST
    // over the whole prefix, to decide whether a store was empty and to describe
    // one already mounted — so the operation advertised as O(pending change)
    // carried a term that grew with every fold. Two stores differing 100× in
    // object count have to produce the IDENTICAL trace; a listing anywhere in
    // the attach path makes the second one longer or its bytes larger.
    //
    // THE CURSOR IS HELD EQUAL ON PURPOSE. Only the object count varies here,
    // because `foldedSeq` is written as a decimal and a larger one is a longer
    // `cursor.json` — a real difference, but a difference in the LOG of the
    // sequence rather than in the size of the tree. Varying both would let a
    // genuine prefix scan hide behind an explainable byte delta.
    const small = await fixture('scale-small');
    const large = await fixture('scale-large');
    try {
      await treeHeavyStore(small.store, 20, 7);
      await treeHeavyStore(large.store, 2_000, 7);

      const thin = await watchedRestore(small);
      const fat = await watchedRestore(large);

      expect(thin.watched.trace()).toEqual([...FIXED_ATTACH_TRACE]);
      expect(fat.watched.trace()).toEqual(thin.watched.trace());
      expect(fat.watched.bytes('get')).toBe(thin.watched.bytes('get'));
      // And the classification came from the cursor, not from the prefix: both
      // stores hold thousands of objects between them and neither was listed to
      // find out that they are not fresh.
      expect(thin.receipt).toMatchObject({ entries: 0, movedBytes: 0, foldedSeq: 7 });
      expect(fat.receipt).toMatchObject({ entries: 0, movedBytes: 0, foldedSeq: 7 });
    } finally {
      await rm(small.root, { recursive: true, force: true });
      await rm(large.root, { recursive: true, force: true });
    }
  });

  test('A HUGE PREFIX WITH AN EMPTY JOURNAL READS NO PAYLOAD AND LISTS NOTHING BUT `journal/`',
    async () => {
      // The two halves stated separately, because they fail separately. A
      // listing of `tree/` or `blobs/` is the cost term; a GET under either is
      // payload this operation has no reason to touch.
      const paths = await fixture('huge-empty-journal');
      try {
        await treeHeavyStore(paths.store, 2_000, 41);
        const { receipt, watched } = await watchedRestore(paths);

        expect(watched.keys('list')).toEqual([PREFIX_JOURNAL]);
        expect(watched.keys('get')).toEqual([KEY_CURSOR]);
        expect(watched.calls.filter(call => isPayloadKey(call.key))).toEqual([]);
        expect(watched.payloadBytes('get')).toBe(0);
        // Nothing was written either: a restore materializes into the upper
        // through the native writer, never back through the store.
        expect(watched.keys('put')).toEqual([]);
        expect(receipt.movedBytes).toBe(0);
        // And the upper stayed empty, because nothing was pending.
        expect(await readdir(paths.upper)).toEqual([]);
      } finally {
        await rm(paths.root, { recursive: true, force: true });
      }
    });

  test('A FRESH STORE PRODUCES THE SAME TRACE, so the zero-payload claim is not the empty case',
    async () => {
      // The boundary the previous test cannot cover on its own. A fresh prefix
      // has no cursor at all, so its GET returns nothing — and if that were the
      // only case asserted, "attach reads no payload" would be proved only where
      // there is no payload to read.
      const paths = await fixture('fresh');
      try {
        const { receipt, watched } = await watchedRestore(paths);
        expect(watched.trace()).toEqual([...FIXED_ATTACH_TRACE]);
        expect(receipt).toMatchObject({ entries: 0, movedBytes: 0, foldedSeq: 0 });
        // `foldedSeq === 0` with no pending entry is what the adapter reads as a
        // fresh overlay. The tree-heavy stores above report 20 and 2000, so the
        // two states are distinguishable without either one being listed.
        expect(watched.bytes('get')).toBe(0);
      } finally {
        await rm(paths.root, { recursive: true, force: true });
      }
    });

  test('A PENDING REPLAY READS THE PENDING BYTES AND NOT ONE BYTE OF THE TREE', async () => {
    // O(pending change), stated as an equality rather than a bound. The tree
    // below holds a file 1000× the size of the pending one; a replay that
    // touched it shows up as payload bytes above the pending total.
    const paths = await fixture('pending-only');
    try {
      const folded = 'x'.repeat(40_000);
      const pending = 'the only bytes a replay may read';
      await writeFile(join(paths.upper, 'folded.bin'), folded);
      await runOverlayRunner({ operation: 'fold', upper: paths.upper, store: paths.store });
      await writeFile(join(paths.upper, 'pending.txt'), pending);
      await runOverlayRunner({ operation: 'checkpoint', upper: paths.upper, store: paths.store });

      // The container is replaced: the upper is gone, the store is not.
      await rm(paths.upper, { recursive: true, force: true });
      await mkdir(paths.upper);

      const { receipt, watched } = await watchedRestore(paths);

      expect(receipt.entries).toBe(1);
      expect(receipt.foldedSeq).toBe(1);
      // EXACTLY the pending blob, and nothing under `tree/`.
      expect(watched.keys('get').filter(isPayloadKey)).toEqual([blobKey(sha256(pending))]);
      expect(watched.payloadBytes('get')).toBe(pending.length);
      expect(watched.keys('get').some(key => key.startsWith(PREFIX_TREE))).toBe(false);
      expect(watched.keys('list')).toEqual([PREFIX_JOURNAL]);
      // Only the pending path is written into the upper. The folded one is not
      // replayed, because it is already an object the lower is mounted over.
      expect(await readFile(join(paths.upper, 'pending.txt'), 'utf8')).toBe(pending);
      expect(await readdir(paths.upper)).toEqual(['pending.txt']);
    } finally {
      await rm(paths.root, { recursive: true, force: true });
    }
  });

  test('EVERY POST-CURSOR VERSION IS FETCHED, because nothing coalesces before a fold', async () => {
    // THE EXACT SHAPE OF THE PENDING BOUND, and it is not the coalesced one. A
    // replay walks the RAW post-cursor entries, so a path journalled twice
    // between folds is materialized twice and both blobs are read — the second
    // write simply lands last. A test written against the coalesced count would
    // assert a cheaper replay than the one that runs, and a cost model built on
    // it would under-predict recovery for exactly the workload that rewrites the
    // same paths every tick.
    const paths = await fixture('superseded');
    try {
      const file = join(paths.upper, 'twice.txt');
      await writeFile(file, 'first version');
      await runOverlayRunner({ operation: 'checkpoint', upper: paths.upper, store: paths.store });
      await writeFile(file, 'second version!');
      await runOverlayRunner({ operation: 'checkpoint', upper: paths.upper, store: paths.store });

      await rm(paths.upper, { recursive: true, force: true });
      await mkdir(paths.upper);
      const { receipt, watched } = await watchedRestore(paths);

      expect(receipt.entries).toBe(2);
      expect(receipt.foldedSeq).toBe(0);
      expect(watched.keys('get').filter(isPayloadKey))
        .toEqual([blobKey(sha256('first version')), blobKey(sha256('second version!'))]);
      expect(watched.payloadBytes('get')).toBe('first version'.length + 'second version!'.length);
      // Both batches were read, and the later write is the one on the upper.
      expect(watched.keys('get').filter(key => key.startsWith(PREFIX_JOURNAL))).toHaveLength(2);
      expect(await readFile(file, 'utf8')).toBe('second version!');
    } finally {
      await rm(paths.root, { recursive: true, force: true });
    }
  });
});

describe('the receipt’s byte figure is the bytes that were written', () => {
  test('A TICK REPORTS EVERY OBJECT IT WROTE — blob, journal batch and scan cache', async () => {
    // The old figure was the logical size of the journalled files, so it
    // reported 5 here and said nothing about the two metadata objects that also
    // landed. A caller differencing cost per checkpoint was therefore comparing
    // content bytes against a bill that included metadata.
    const paths = await fixture('tick-bytes');
    try {
      await writeFile(join(paths.upper, 'hello.txt'), 'hello');
      const watched = new WatchedCasStore(paths.store);
      const receipt = await runOverlayRunner({ operation: 'checkpoint', upper: paths.upper, store: watched });

      expect(receipt.movedBytes).toBe(bytesWritten(watched));
      expect(receipt.movedBytes).toBeGreaterThan(5);
      expect(watched.keys('put')).toEqual([
        blobKey(sha256('hello')), 'journal/000000000001.json', 'scan.json',
      ]);
      expect(watched.payloadBytes('put')).toBe(5);
    } finally {
      await rm(paths.root, { recursive: true, force: true });
    }
  });

  test('A RENAME MOVES NO CONTENT, and the receipt bills only the metadata it wrote', async () => {
    // Content-hash dedup: the blob for these bytes is already in the store, so
    // the rename journals its entries and uploads no chunk. The receipt has to
    // show BOTH halves — zero payload bytes, and a nonzero figure for the
    // journal batch and the refreshed cache that really landed. A figure of 0
    // would claim the commit was free; the old logical-size figure claimed the
    // whole file moved again.
    const paths = await fixture('rename-bytes');
    try {
      const body = 'bytes that survive a rename';
      await writeFile(join(paths.upper, 'before.txt'), body);
      await runOverlayRunner({ operation: 'checkpoint', upper: paths.upper, store: paths.store });

      await rm(join(paths.upper, 'before.txt'));
      await writeFile(join(paths.upper, '.wh.before.txt'), '');
      await writeFile(join(paths.upper, 'after.txt'), body);
      const watched = new WatchedCasStore(paths.store);
      const receipt = await runOverlayRunner({ operation: 'checkpoint', upper: paths.upper, store: watched });

      expect(receipt.entries).toBe(2);
      expect(watched.keys('put').some(key => key.startsWith(PREFIX_BLOBS))).toBe(false);
      expect(watched.payloadBytes('put')).toBe(0);
      expect(receipt.movedBytes).toBeGreaterThan(0);
      expect(receipt.movedBytes).toBe(bytesWritten(watched));
    } finally {
      await rm(paths.root, { recursive: true, force: true });
    }
  });

  test('AN IDLE TICK WRITES NOTHING AT ALL, so its zero is a measurement', async () => {
    // The defect the byte redefinition exposed: the scan cache was PUT on every
    // tick, and that object carries one row per path in the upper. So an idle
    // box paid a PUT proportional to its own size every interval to store bytes
    // identical to the ones already there — and the adapter, reading a receipt
    // that reported only content bytes, called it a skip that moved nothing.
    const paths = await fixture('idle-tick');
    try {
      const stamp = new Date(1_700_000_000_000);
      for (let at = 0; at < 40; at += 1) {
        const file = join(paths.upper, `file-${at}.txt`);
        await writeFile(file, `body-${at}`);
        await utimes(file, stamp, stamp);
      }
      const first = await runOverlayRunner({
        operation: 'checkpoint', upper: paths.upper, store: paths.store,
      });
      expect(first.entries).toBe(40);

      const watched = new WatchedCasStore(paths.store);
      const idle = await runOverlayRunner({ operation: 'checkpoint', upper: paths.upper, store: watched });

      expect(idle.entries).toBe(0);
      expect(watched.keys('put')).toEqual([]);
      expect(idle.movedBytes).toBe(0);
      // The cache the first tick wrote is still there and still authoritative —
      // not writing it is not the same as losing it.
      expect(Object.keys(await scanCache(paths.store))).toHaveLength(40);
    } finally {
      await rm(paths.root, { recursive: true, force: true });
    }
  });

  test('AN IDLE TICK OVER A DELETION STILL WRITES NOTHING, because a whiteout is not news',
    async () => {
      // MEASURED LIVE, and the reason the invariant above was not the whole
      // rule. A whiteout carries no signature, so no cache row can ever satisfy
      // it and the scan re-emits its `delete` on every pass; `filterChanged`
      // then drops it, because the pending journal already holds that exact
      // tombstone. The old condition — "the scan measured more entries than
      // staging took" — is therefore PERMANENTLY true for any upper holding one
      // deletion, so the box rewrote its whole scan cache every interval,
      // forever, storing bytes identical to the ones already there.
      //
      // On the deployed 1 MB arm that cost one 25,072 B PUT of 1,975 ms per idle
      // tick (probe ocs09011400, tick-unchanged). An opaque directory does the
      // same thing for the same reason: `scanUpper` re-emits it unconditionally.
      const paths = await fixture('idle-tick-whiteout');
      try {
        const stamp = new Date(1_700_000_000_000);
        for (let at = 0; at < 8; at += 1) {
          const file = join(paths.upper, `file-${at}.txt`);
          await writeFile(file, `body-${at}`);
          await utimes(file, stamp, stamp);
        }
        await writeFile(join(paths.upper, '.wh.removed.txt'), '');
        await mkdir(join(paths.upper, 'shadowed'));
        await writeFile(join(paths.upper, 'shadowed', '.wh..wh..opq'), '');
        const first = await runOverlayRunner({
          operation: 'checkpoint', upper: paths.upper, store: paths.store,
        });
        expect(first.entries).toBe(10);

        const watched = new WatchedCasStore(paths.store);
        const idle = await runOverlayRunner({ operation: 'checkpoint', upper: paths.upper, store: watched });

        expect(idle.entries).toBe(0);
        expect(watched.keys('put')).toEqual([]);
        expect(idle.movedBytes).toBe(0);
        // Still authoritative: the eight files and the opaque directory keep
        // their rows, so the next tick re-digests nothing.
        expect(Object.keys(await scanCache(paths.store))).toHaveLength(9);
      } finally {
        await rm(paths.root, { recursive: true, force: true });
      }
    });

  test('A LOST SCAN CACHE IS REWRITTEN AND NOTHING IS RE-JOURNALLED', async () => {
    // THE OTHER HALF OF THE CACHE-WRITE RULE, and the case that makes the
    // adapter's residual branch reachable. The journal batch is already durable
    // but the cache is gone, so the scan re-digests the file, emits an entry for
    // it, and `filterChanged` then drops it because the pending journal holds
    // that exact state. Nothing is staged — and the cache still has to be
    // written, or the box re-digests its whole workspace on every tick until the
    // next fold.
    //
    // So this run reports `entries: 0` with a nonzero `movedBytes`. That pair is
    // exactly what the adapter must NOT read as a skip.
    const paths = await fixture('cache-lost');
    try {
      await writeFile(join(paths.upper, 'kept.txt'), 'already journalled');
      const first = await runOverlayRunner({
        operation: 'checkpoint', upper: paths.upper, store: paths.store,
      });
      expect(first.entries).toBe(1);
      await paths.store.delete('scan.json');

      const watched = new WatchedCasStore(paths.store);
      const again = await runOverlayRunner({ operation: 'checkpoint', upper: paths.upper, store: watched });

      expect(again.entries).toBe(0);
      expect(watched.keys('put')).toEqual(['scan.json']);
      expect(again.movedBytes).toBe(bytesWritten(watched));
      expect(again.movedBytes).toBeGreaterThan(0);
      // No second journal batch: the change was already recorded, and recording
      // it twice is what the pending-state filter exists to prevent.
      expect(await readFoldedSeq(paths.store)).toBe(0);
      expect(Object.keys(await scanCache(paths.store))).toEqual(['kept.txt']);
      expect(watched.keys('put').filter(key => key.startsWith(PREFIX_JOURNAL))).toEqual([]);
    } finally {
      await rm(paths.root, { recursive: true, force: true });
    }
  });

  test('A FOLD BILLS THE TREE, THE MANIFEST AND THE CURSOR, and reports the cursor it set',
    async () => {
      const paths = await fixture('fold-bytes');
      try {
        await writeFile(join(paths.upper, 'doc.txt'), 'folded body');
        const watched = new WatchedCasStore(paths.store);
        const receipt = await runOverlayRunner({ operation: 'fold', upper: paths.upper, store: watched });

        expect(receipt).toMatchObject({ entries: 1, foldedEntries: 1, foldedSeq: 1 });
        const put = watched.keys('put');
        expect(put).toContain('tree/doc.txt');
        expect(put).toContain(KEY_MANIFEST);
        expect(put).toContain(KEY_CURSOR);
        expect(receipt.movedBytes).toBe(bytesWritten(watched));
        // Content landed twice — once as a chunk blob, once as the tree object
        // the lower serves — and the figure says so rather than counting the
        // file's logical size once.
        expect(watched.payloadBytes('put')).toBe('folded body'.length * 2);
      } finally {
        await rm(paths.root, { recursive: true, force: true });
      }
    });

  test('THE COMMIT ORDER IS UNCHANGED: blob, journal, tree, manifest, cursor, reap', async () => {
    // The crash-safety order, asserted on the real runner rather than on the
    // helpers alone. Every pair here is a different lost-data shape if inverted:
    // a journal entry ahead of its blob names bytes that are not there; a cursor
    // ahead of the tree marks entries folded that were not; a reap ahead of the
    // cursor deletes a batch the next replay would still be asked for.
    const paths = await fixture('commit-order');
    try {
      await writeFile(join(paths.upper, 'ordered.txt'), 'ordered body');
      const watched = new WatchedCasStore(paths.store);
      await runOverlayRunner({ operation: 'fold', upper: paths.upper, store: watched });

      const trace = watched.trace();
      const at = (needle: string): number => trace.findIndex(row => row.startsWith(needle));
      const blob = at(`put ${blobKey(sha256('ordered body'))}`);
      const journal = at(`put ${PREFIX_JOURNAL}`);
      const tree = at(`put ${PREFIX_TREE}`);
      const manifest = at(`put ${KEY_MANIFEST}`);
      const cursor = at(`put ${KEY_CURSOR}`);
      const reap = at(`delete ${PREFIX_JOURNAL}`);

      expect(blob).toBeGreaterThanOrEqual(0);
      expect(reap).toBeGreaterThanOrEqual(0);
      expect(blob).toBeLessThan(journal);
      expect(journal).toBeLessThan(tree);
      expect(tree).toBeLessThan(manifest);
      expect(manifest).toBeLessThan(cursor);
      expect(cursor).toBeLessThan(reap);
    } finally {
      await rm(paths.root, { recursive: true, force: true });
    }
  });
});