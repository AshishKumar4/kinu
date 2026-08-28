import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { lstat, link, mkdtemp, mkdir, readdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FileCasStore,
  nextScanCache,
  runOverlayRunner,
} from '../src/cas/overlay-runner';
import { blobKey, readFoldedSeq } from '../src/cas';
import type { UpperSignature } from '../src/cas/state';

async function fixture(name: string): Promise<{ upper: string; store: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), `overlay-runner-${name}-`));
  const upper = join(root, 'upper');
  const store = join(root, 'store');
  await Promise.all([mkdir(upper), mkdir(store)]);
  return { root, upper, store };
}

/** The scan cache the runner keeps beside the bytes, by path. */
async function scanCache(store: string): Promise<Record<string, UpperSignature>> {
  return JSON.parse(await readFile(join(store, 'scan.json'), 'utf8')).signatures;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

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
    expect(next.get('late.txt')?.mtimeMs).toBe(1);
  });

  test('a journalled path takes the row the scan just measured', () => {
    const previous = new Map([['done.txt', signature(1, 'a')]]);
    const scanned = new Map([['done.txt', signature(2, 'b')]]);
    const next = nextScanCache(previous, scanned, new Set(), new Set());
    expect(next.get('done.txt')?.mtimeMs).toBe(2);
  });

  test('a tombstoned path loses its row, because it no longer exists to detect', () => {
    const previous = new Map([['gone.txt', signature(1, 'a')]]);
    const next = nextScanCache(previous, new Map(), new Set(), new Set(['gone.txt']));
    expect(next.has('gone.txt')).toBe(false);
  });

  test('a path the scan found unchanged survives, so it is not re-read next time', () => {
    const previous = new Map([['stable.txt', signature(1, 'a')]]);
    const next = nextScanCache(previous, new Map(), new Set(), new Set());
    expect(next.get('stable.txt')?.mtimeMs).toBe(1);
  });
});

describe('FileCasStore', () => {
  test('keeps exact CAS keys, metadata and stream counters on a mounted prefix', async () => {
    const paths = await fixture('store');
    try {
      const store = new FileCasStore(paths.store);
      await store.put('tree/bin/run', new TextEncoder().encode('run'), { mode: 0o100755, mtimeMs: 1_700_000_000_000 });
      const bytes = await store.get('tree/bin/run');
      if (bytes === null) throw new Error('blob missing after put');
      expect(new TextDecoder().decode(bytes)).toBe('run');
      expect(await store.list('tree/')).toEqual(['tree/bin/run']);
      expect((await lstat(join(paths.store, 'tree/bin/run'))).mode & 0o777).toBe(0o755);
      expect(store.counters).toMatchObject({ putCalls: 1, getCalls: 1, listCalls: 1, bytesPut: 3, bytesGot: 3 });
    } finally {
      await rm(paths.root, { recursive: true, force: true });
    }
  });

  test('streams a blob without converting the stream to a string', async () => {
    const paths = await fixture('stream');
    try {
      const store = new FileCasStore(paths.store);
      await store.putStream('blobs/ab/blob', new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('one'));
          controller.enqueue(new TextEncoder().encode('two'));
          controller.close();
        },
      }), 6);
      const blob = await store.get('blobs/ab/blob');
      if (blob === null) throw new Error('blob missing after putStream');
      expect(new TextDecoder().decode(blob)).toBe('onetwo');
      expect(store.counters.bytesPut).toBe(6);
    } finally {
      await rm(paths.root, { recursive: true, force: true });
    }
  });

  /** Everything under the blob's own directory, so a leaked `.tmp-<uuid>` is
   *  visible rather than inferred from the key being absent. */
  async function blobDir(store: string): Promise<readonly string[]> {
    return await readdir(join(store, 'blobs/ab'));
  }

  test('a drained stream is released, not left locked', async () => {
    // The reader is taken from the caller's stream, so the caller gets it back:
    // a lock this method kept would make the stream unusable to anything else
    // and hide a leak behind a successful put.
    const paths = await fixture('release');
    try {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('done'));
          controller.close();
        },
      });
      await new FileCasStore(paths.store).putStream('blobs/ab/blob', stream, 4);
      expect(stream.locked).toBe(false);
    } finally {
      await rm(paths.root, { recursive: true, force: true });
    }
  });

  test('a stream that fails mid-flight leaves no blob and no temp file', async () => {
    // The partial write is real: the first chunk reached the temp file before
    // the producer died. The rename is what publishes, so nothing is corrupt —
    // but a `.tmp-<uuid>` left under this box's prefix is bytes no key names and
    // no orphan sweep can recognise, which makes the leak permanent.
    const paths = await fixture('stream-fault');
    try {
      const store = new FileCasStore(paths.store);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('half'));
        },
        pull(controller) {
          controller.error(new Error('the upper vanished mid-read'));
        },
      });

      await expect(store.putStream('blobs/ab/blob', stream, 8))
        .rejects.toThrow('the upper vanished mid-read');

      expect(await store.get('blobs/ab/blob')).toBeNull();
      expect(await blobDir(paths.store)).toEqual([]);
      // And the reader was handed back, so the failure left nothing holding the
      // caller's stream either.
      expect(stream.locked).toBe(false);
    } finally {
      await rm(paths.root, { recursive: true, force: true });
    }
  });

  test('a stream that disagrees with its declared size publishes nothing', async () => {
    // A size measured before the read is how a file still settling gets
    // published as a complete blob. The check refuses, and it leaves the store
    // exactly as it found it.
    const paths = await fixture('stream-short');
    try {
      const store = new FileCasStore(paths.store);
      await expect(store.putStream('blobs/ab/blob', new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('three'));
          controller.close();
        },
      }), 9)).rejects.toThrow('streamed 5 bytes, expected 9');

      expect(await store.get('blobs/ab/blob')).toBeNull();
      expect(await blobDir(paths.store)).toEqual([]);
      // A refused put moved no bytes, and the counter must not claim otherwise.
      expect(store.counters.bytesPut).toBe(0);
    } finally {
      await rm(paths.root, { recursive: true, force: true });
    }
  });
});

describe('overlay CAS runner', () => {
  test('stages a changed upper file, records a receipt, and folds through the mounted store', async () => {
    const paths = await fixture('fold');
    try {
      await writeFile(join(paths.upper, 'hello.txt'), 'hello');
      const receipt = await runOverlayRunner({ operation: 'fold', upper: paths.upper, store: paths.store });
      expect(receipt).toMatchObject({ operation: 'fold', entries: 1, stagedBytes: 5, foldedEntries: 1 });
      expect((await scanCache(paths.store))['hello.txt']?.kind).toBe('file');
      expect(await readFoldedSeq(new FileCasStore(paths.store))).toBe(1);
      const blob = await readFile(join(paths.store, blobKey('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')));
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
      expect(second.stagedBytes).toBe(0);
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
      await writeFile(join(paths.store, 'scan.json'), '{"version":1,"signatures":{"a.txt":"nonsense"}}\n');
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
      await expect(readFile(join(paths.store, blobKey(sha256('version-one'))))).rejects.toThrow();
      expect(await readFile(join(paths.store, blobKey(sha256('version-two-longer'))), 'utf8'))
        .toBe('version-two-longer');
      expect(await readFile(join(paths.store, 'tree/doc.txt'), 'utf8')).toBe('version-two-longer');
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
      expect(await readFile(join(paths.store, blobKey(sha256('one'))), 'utf8')).toBe('one');
    } finally {
      await rm(paths.root, { recursive: true, force: true });
    }
  });
});