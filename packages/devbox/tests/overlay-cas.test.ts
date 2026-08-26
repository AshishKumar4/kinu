// The overlay-cas gate.
//
// Regenerated from the r2-overlay prototype's proven invariants after that
// directory was deleted. Two suites share this file because they are one
// strategy: the CAS helpers are what make a crash safe, and the DevboxStorage
// adapter is what makes those helpers a third arm.
//
// The last two tests assert the denominator: every outcome kind the
// implementation enumerates has to be produced above.
import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';

import {
  appendJournalBatch,
  blobKey,
  coalesce,
  CHUNK_SIZE,
  digestBytes,
  emptyCounters,
  foldJournalIntoTree,
  journalKey,
  JournalBatchSchema,
  decodeJson,
  listJournalAfter,
  pendingBatches,
  readFoldedSeq,
  replayPending,
  sha256Hex,
  stageBlobs,
  sweepOrphanBlobs,
  type CasStore,
  type FileEntry,
  type JournalEntry,
  type StoreCounters,
} from '../src/cas';
import {
  capSignatures,
  CAS_TREE_MOUNT,
  DIGEST_SCRIPT,
  parseDigestStream,
  normalizeOverlayCasState,
  OVERLAY_CAS_STATE_MAX_BYTES,
  overlayCasStorage,
  overlayCasStateBytes,
  SIGNATURE_ROWS_MAX,
  type OverlayCasPorts,
  type OverlayCasState,
  type UpperSignature,
} from '../src/overlay-cas';
import {
  ATTACH_OUTCOME_KINDS,
  CHECKPOINT_OUTCOME_KINDS,
  DEVBOX_RUNTIME_DIR,
  DEVBOX_WORKDIR,
  type AttachOutcome,
  type CheckpointKind,
  type CheckpointOutcome,
} from '../src/storage';

// ── in-memory store ─────────────────────────────────────────────────────────

class MemoryStore implements CasStore {
  readonly counters: StoreCounters = emptyCounters();
  readonly objects = new Map<string, Uint8Array>();
  /** Every mutating call, in order. The crash-ordering assertions read this:
   *  an end-state check cannot tell a safe order from an unsafe one. */
  readonly writes: string[] = [];
  requireBlobGetsInsideStream = false;
  private insidePutStream = false;

  async put(key: string, bytes: Uint8Array): Promise<void> {
    this.counters.putCalls += 1;
    this.counters.bytesPut += bytes.byteLength;
    this.writes.push(`put:${key}`);
    this.objects.set(key, bytes);
  }

  async putStream(
    key: string,
    stream: ReadableStream<Uint8Array>,
    size: number,
  ): Promise<void> {
    const reader = stream.getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    this.insidePutStream = true;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        total += value.byteLength;
      }
    } finally {
      this.insidePutStream = false;
    }
    expect(total).toBe(size);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    await this.put(key, bytes);
  }
  async get(key: string): Promise<Uint8Array | null> {
    if (this.requireBlobGetsInsideStream && key.startsWith('blobs/') && !this.insidePutStream) {
      throw new Error(`eager blob read outside putStream: ${key}`);
    }
    const value = this.objects.get(key);
    this.counters.getCalls += 1;
    if (value === undefined) return null;
    this.counters.bytesGot += value.byteLength;
    return value;
  }

  async head(key: string): Promise<{ size: number } | null> {
    this.counters.headCalls += 1;
    const value = this.objects.get(key);
    return value === undefined ? null : { size: value.byteLength };
  }

  async delete(key: string): Promise<void> {
    this.counters.deleteCalls += 1;
    this.writes.push(`delete:${key}`);
    this.objects.delete(key);
  }

  async list(prefix: string): Promise<string[]> {
    this.counters.listCalls += 1;
    return [...this.objects.keys()].filter(key => key.startsWith(prefix)).sort();
  }
}

class FailSecondJournalStore extends MemoryStore {
  private journalPuts = 0;
  private failed = false;

  override async put(key: string, bytes: Uint8Array): Promise<void> {
    if (key.startsWith('journal/')) {
      this.journalPuts += 1;
      if (this.journalPuts === 2 && !this.failed) {
        this.failed = true;
        throw new Error('second journal batch failed');
      }
    }
    await super.put(key, bytes);
  }
}

function fileBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function fileEntry(seq: number, path: string, text: string): FileEntry {
  const bytes = fileBytes(text);
  const digest = digestBytes(bytes);
  return {
    kind: 'file',
    seq,
    path,
    mode: 0o644,
    mtimeMs: 0,
    size: digest.size,
    hash: digest.hash,
    chunks: digest.chunks,
  };
}

function readerFor(contents: ReadonlyMap<string, Uint8Array>) {
  return async (entry: FileEntry, index: number, size: number): Promise<Uint8Array | null> => {
    const held = contents.get(entry.path);
    if (held === undefined) return null;
    const start = index * 512 * 1024;
    const view = held.subarray(start, start + size);
    return view.byteLength === size ? view : null;
  };
}

/** Every file entry in every journal BATCH object must have all of its blobs.
 *  Returns how many entries it checked, so a caller can assert it really
 *  looked at something. */
async function assertNoDanglingJournal(store: MemoryStore): Promise<number> {
  const keys = await store.list('journal/');
  let checked = 0;
  for (const key of keys) {
    const raw = await store.get(key);
    if (raw === null) continue;
    const batch = decodeJson(JournalBatchSchema, key, raw);
    for (const entry of batch) {
      if (entry.kind !== 'file') continue;
      for (const chunk of entry.chunks) {
        expect(store.objects.has(blobKey(chunk.hash))).toBe(true);
      }
      checked += 1;
    }
  }
  return checked;
}

// ── CAS: coalesce, tombstones, crash order, rename, replay ──────────────────

describe('coalesce — latest state per path, sequence order', () => {
  test('collapses repeated writes of one path to its latest state', () => {
    const first = fileEntry(1, 'a', 'one');
    const second = fileEntry(4, 'a', 'four');
    expect(coalesce([first, fileEntry(2, 'a', 'two'), second]).map(e => e.seq)).toEqual([4]);
  });

  test('a delete after a write wins, so the write is never uploaded', () => {
    const write = fileEntry(1, 'a', 'x');
    const gone: JournalEntry = { kind: 'delete', seq: 2, path: 'a' };
    expect(coalesce([write, gone])).toEqual([gone]);
  });

  test('a write after a delete resurrects the path', () => {
    const gone: JournalEntry = { kind: 'delete', seq: 1, path: 'a' };
    const write = fileEntry(2, 'a', 'back');
    expect(coalesce([gone, write])).toEqual([write]);
  });

  test('distinct paths all survive, in sequence order', () => {
    const a = fileEntry(3, 'a', 'a');
    const b = fileEntry(1, 'b', 'b');
    expect(coalesce([a, b]).map(e => e.path)).toEqual(['b', 'a']);
  });
});


describe('crash ordering — blob before journal, journal before fold, fold before cursor', () => {
  test('a crash after blobs land but before the journal entry leaves no dangling entry', async () => {
    const store = new MemoryStore();
    const bytes = fileBytes('hello');
    const entry = fileEntry(1, 'a.txt', 'hello');
    const contents = new Map([['a.txt', bytes]]);
    const staged = await stageBlobs({ store, entries: [entry], readChunk: readerFor(contents) });
    expect(staged.uploaded).toBe(1);
    expect(store.objects.has(blobKey(entry.hash))).toBe(true);
    expect(store.objects.has(journalKey(1))).toBe(false);
    expect(await assertNoDanglingJournal(store)).toBe(0);
  });

  test('resuming after that crash redoes one batch and re-uploads nothing', async () => {
    const store = new MemoryStore();
    const bytes = fileBytes('hello');
    const entry = fileEntry(1, 'a.txt', 'hello');
    const contents = new Map([['a.txt', bytes]]);
    await stageBlobs({ store, entries: [entry], readChunk: readerFor(contents) });
    const putsBefore = store.counters.putCalls;
    const again = await stageBlobs({ store, entries: [entry], readChunk: readerFor(contents) });
    expect(again.uploaded).toBe(0);
    expect(again.skipped).toBe(1);
    expect(store.counters.putCalls).toBe(putsBefore);
  });

  test('each batch commits only after ITS OWN blobs are durable', async () => {
    // The bound on a crash. With one commit at the end, a crash mid-upload
    // loses the whole change set; per batch, it loses one batch. The assertion
    // is that at every commit, every blob named so far is already in the store.
    const store = new MemoryStore();
    const entries: JournalEntry[] = [];
    const contents = new Map<string, Uint8Array>();
    for (let i = 0; i < 5; i += 1) {
      const text = `body-${i}`;
      entries.push(fileEntry(i + 1, `f${i}.txt`, text));
      contents.set(`f${i}.txt`, fileBytes(text));
    }

    const commits: number[] = [];
    const staged = await stageBlobs({
      store,
      entries,
      readChunk: readerFor(contents),
      batchSize: 2,
      commitBatch: async (batch) => {
        for (const entry of batch) {
          if (entry.kind !== 'file') continue;
          for (const chunk of entry.chunks) {
            expect(store.objects.has(blobKey(chunk.hash))).toBe(true);
          }
        }
        commits.push(batch.length);
        await appendJournalBatch(store, batch);
      },
    });

    expect(commits).toEqual([2, 2, 1]);
    expect(staged.batches).toBe(3);
    expect(await assertNoDanglingJournal(store)).toBe(5);
  });

  test('a stale file stops staging, so later batches are never committed', async () => {
    const store = new MemoryStore();
    const good = fileEntry(1, 'good.txt', 'aaaa');
    const stale = fileEntry(2, 'stale.txt', 'original');
    const never = fileEntry(3, 'never.txt', 'cccc');
    const contents = new Map([
      ['good.txt', fileBytes('aaaa')],
      ['stale.txt', fileBytes('OVERWRIT')],
      ['never.txt', fileBytes('cccc')],
    ]);
    const committed: string[] = [];
    const staged = await stageBlobs({
      store,
      entries: [good, stale, never],
      readChunk: readerFor(contents),
      batchSize: 1,
      commitBatch: async (batch) => {
        for (const entry of batch) committed.push(entry.path);
        await appendJournalBatch(store, batch);
      },
    });
    expect(committed).toEqual(['good.txt']);
    expect(staged.stalePaths).toEqual(['stale.txt']);
    expect(store.objects.has(journalKey(3))).toBe(false);
  });

  test('a file rewritten after it was journalled is refused, not stored under a wrong hash', async () => {
    // SAME LENGTH, different bytes. A short read cannot catch this — only the
    // digest can — so this test fails if the content check is ever dropped.
    // Storing these bytes under the journalled hash would corrupt the CAS
    // permanently rather than costing a retry.
    const store = new MemoryStore();
    const entry = fileEntry(1, 'a.txt', 'original');
    const contents = new Map([['a.txt', fileBytes('OVERWRIT')]]);
    expect(fileBytes('OVERWRIT').byteLength).toBe(fileBytes('original').byteLength);
    const staged = await stageBlobs({ store, entries: [entry], readChunk: readerFor(contents) });
    expect(staged.stalePaths).toEqual(['a.txt']);
    expect(staged.staged).toEqual([]);
    expect(store.objects.has(journalKey(1))).toBe(false);
    expect(store.objects.has(blobKey(entry.hash))).toBe(false);
  });

  test('a tick over N paths costs exactly ONE journal PUT, not N', async () => {
    // THE COST CLAIM. An npm-shaped tick touches thousands of paths. One
    // journal object per ENTRY would make the journal cost proportional to the
    // changed-path COUNT rather than to the bytes that changed, which is the
    // efficiency this strategy exists to deliver. Found by the Lean model
    // before it was found here.
    const store = new MemoryStore();
    const entries: JournalEntry[] = [];
    const contents = new Map<string, Uint8Array>();
    for (let i = 0; i < 40; i += 1) {
      const text = `body-${i}`;
      entries.push(fileEntry(i + 1, `f${i}.txt`, text));
      contents.set(`f${i}.txt`, fileBytes(text));
    }

    await stageBlobs({
      store,
      entries,
      readChunk: readerFor(contents),
      commitBatch: async (batch) => { await appendJournalBatch(store, batch); },
    });

    const journalPuts = store.writes.filter(write => write.startsWith('put:journal/'));
    expect(journalPuts).toHaveLength(1);
    // And the one object really carries every entry, so nothing was dropped to
    // make the count small.
    expect(await assertNoDanglingJournal(store)).toBe(40);
    expect(await listJournalAfter(store, 0)).toHaveLength(40);
  });

  test('fold writes tree and manifest before the cursor advances', async () => {
    const store = new MemoryStore();
    const entry = fileEntry(1, 'a.txt', 'body');
    await stageBlobs({ store, entries: [entry],
      readChunk: readerFor(new Map([['a.txt', fileBytes('body')]])) });
    await appendJournalBatch(store, [entry]);
    expect(await readFoldedSeq(store)).toBe(0);
    store.writes.length = 0;

    const folded = await foldJournalIntoTree(store);
    expect(folded.cursorAfter).toBe(1);
    expect(await readFoldedSeq(store)).toBe(1);

    // ORDER, not just end state. A cursor that moves before the tree it names
    // is durable turns a crash into a fold that is claimed and absent, and an
    // end-state assertion cannot tell the two orders apart.
    const tree = store.writes.indexOf('put:tree/a.txt');
    const manifest = store.writes.indexOf('put:meta/manifest.jsonl');
    const cursor = store.writes.indexOf('put:cursor.json');
    const reap = store.writes.indexOf(`delete:${journalKey(1)}`);
    expect(tree).toBeGreaterThanOrEqual(0);
    expect(tree).toBeLessThan(manifest);
    expect(manifest).toBeLessThan(cursor);
    // Reaping AFTER the cursor: a crash between them leaves a harmless orphan
    // journal object, never a hole where a folded entry used to be.
    expect(cursor).toBeLessThan(reap);
  });

  test('fold only consumes journal objects that already exist', async () => {
    const store = new MemoryStore();
    const folded = await foldJournalIntoTree(store);
    expect(folded.foldedEntries).toBe(0);
    expect(await readFoldedSeq(store)).toBe(0);
  });
});

describe('rename — delete plus create, blob reuse', () => {
  test('a rename moves no content, because the blobs already exist', async () => {
    const store = new MemoryStore();
    const bytes = fileBytes('same-bytes');
    const created = fileEntry(1, 'old.txt', 'same-bytes');
    await stageBlobs({ store, entries: [created], readChunk: readerFor(new Map([['old.txt', bytes]])) });
    await appendJournalBatch(store, [created]);

    const renamed = fileEntry(3, 'new.txt', 'same-bytes');
    const gone: JournalEntry = { kind: 'delete', seq: 2, path: 'old.txt' };
    const work = coalesce([gone, renamed]);
    const putsBefore = store.counters.putCalls;
    const staged = await stageBlobs({ store, entries: work, readChunk: readerFor(new Map([['new.txt', bytes]])) });
    expect(staged.uploaded).toBe(0);
    expect(staged.dedupHits).toBe(1);
    expect(staged.staged.map(e => e.kind)).toEqual(['delete', 'file']);
    expect(store.counters.putCalls).toBe(putsBefore);
  });

});

describe('replay — O(pending), never the tree', () => {
  test('after a fold, replay returns no pending entries', async () => {
    const store = new MemoryStore();
    const entry = fileEntry(1, 'a.txt', 'body');
    await stageBlobs({ store, entries: [entry],
      readChunk: readerFor(new Map([['a.txt', fileBytes('body')]])) });
    await appendJournalBatch(store, [entry]);
    await foldJournalIntoTree(store);

    const replayed = await replayPending(store);
    expect(replayed.foldedSeq).toBe(1);
    expect(replayed.pending).toEqual([]);
    expect(replayed.replayed).toEqual([]);
  });

  test('only entries newer than the folded cursor are replayed', async () => {
    const store = new MemoryStore();
    const first = fileEntry(1, 'a.txt', 'one');
    const second = fileEntry(2, 'b.txt', 'two');
    await stageBlobs({
      store,
      entries: [first, second],
      readChunk: readerFor(new Map([
        ['a.txt', fileBytes('one')],
        ['b.txt', fileBytes('two')],
      ])),
    });
    await appendJournalBatch(store, [first]);
    await foldJournalIntoTree(store);
    await appendJournalBatch(store, [second]);

    const replayed = await replayPending(store);
    expect(replayed.foldedSeq).toBe(1);
    expect(replayed.pending.map(entry => entry.path)).toEqual(['b.txt']);
    expect(replayed.replayed).toHaveLength(1);
    expect(replayed.replayed[0]?.entry.path).toBe('b.txt');
  });

  test('replay returns a lazy stream before it reads one blob', async () => {
    const store = new MemoryStore();
    const entry = fileEntry(1, 'lazy.txt', 'streamed');
    await stageBlobs({
      store,
      entries: [entry],
      readChunk: readerFor(new Map([['lazy.txt', fileBytes('streamed')]])),
    });
    await appendJournalBatch(store, [entry]);
    store.requireBlobGetsInsideStream = true;

    const replayed = await replayPending(store);
    store.requireBlobGetsInsideStream = false;
    const reader = replayed.replayed[0]?.stream?.getReader();
    if (reader === undefined) throw new Error('file replay returned no stream');
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    expect(new TextDecoder().decode(chunks[0])).toBe('streamed');
  });

  test('a delete entry replays as a whiteout instruction, not as tree bytes', async () => {
    const store = new MemoryStore();
    const gone: JournalEntry = { kind: 'delete', seq: 1, path: 'gone.txt' };
    await appendJournalBatch(store, [gone]);
    const replayed = await replayPending(store);
    expect(replayed.replayed).toEqual([{ entry: gone, stream: null }]);
  });
});

describe('the stored record is untrusted input', () => {
  const sound = {
    lastCheckpointAt: 5,
    signatures: { 'a.txt': { kind: 'file', mode: 0o644, mtimeMs: 1, size: 4, hash: 'a'.repeat(64) } },
    knownBlobs: ['b'.repeat(64)],
  };

  test('a legacy knownBlobs cache is ignored while the state still parses', () => {
    const state = normalizeOverlayCasState(sound);
    expect(state?.lastCheckpointAt).toBe(5);
    expect(state?.signatures['a.txt']?.hash).toBe('a'.repeat(64));
    expect(Object.hasOwn(state ?? {}, 'knownBlobs')).toBe(false);
    expect(state !== null && 'lastFailure' in state).toBe(true);
    expect(state?.lastFailure).toBeUndefined();
  });

  test('A CHAIN ROW READS AS ABSENT, so a box never attaches from a record it did not write', () => {
    // The hazard this parser exists for. Both strategies keep durable state on
    // the same object; an unchecked cast would read a chain record as a CAS
    // record, and the box would attach from signatures that were never its own.
    const chainRow = {
      mode: 'chain',
      rev: 2,
      base: { id: 'a1b2c3d4-0000-4000-8000-000000000001', bytes: 4096 },
      at: 1,
    };
    expect(normalizeOverlayCasState(chainRow)).toBeNull();
  });

  test('a malformed or half-written row reads as absent rather than as broken forever', () => {
    expect(normalizeOverlayCasState(undefined)).toBeNull();
    expect(normalizeOverlayCasState(null)).toBeNull();
    expect(normalizeOverlayCasState({ ...sound, lastCheckpointAt: 'soon' })).toBeNull();
    // A signature whose hash is not a sha256 is not a signature this code
    // wrote, and trusting its length would let a short string name a blob.
    expect(normalizeOverlayCasState({
      ...sound,
      signatures: { 'a.txt': { kind: 'file', mode: 0o644, mtimeMs: 1, size: 4, hash: 'abc' } },
    })).toBeNull();
  });

  test('the folded flag survives the round trip, because losing it deletes a workspace', () => {
    // A folded signature that came back without its flag would make every
    // folded path look vanished on the next scan. That is the mass-tombstone
    // defect reached through the parser rather than through the scan.
    const state = normalizeOverlayCasState({
      ...sound,
      signatures: {
        'f.txt': {
          kind: 'file', mode: 0o644, mtimeMs: 1, size: 4, hash: 'c'.repeat(64), folded: true,
        },
      },
    });
    expect(state?.signatures['f.txt']?.folded).toBe(true);
  });
});

describe('digest identity', () => {

  test('captures whole and chunk digests from the same source bytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devbox-digest-'));
    try {
      const source = join(dir, 'source.txt');
      const script = join(dir, 'digest.sh');
      const bin = join(dir, 'bin');
      const marker = join(dir, 'mutated');
      const oldBytes = fileBytes('before');
      const newBytes = fileBytes('after!');
      mkdirSync(bin);
      writeFileSync(source, oldBytes);
      writeFileSync(script, DIGEST_SCRIPT);
      writeFileSync(join(bin, 'sha256sum'), [
        '#!/bin/sh',
        'if [ ! -e "$MARKER" ]; then',
        '  : > "$MARKER"',
        '  /usr/bin/sha256sum "$@"',
        '  rc=$?',
        '  printf "%s" "$REPLACEMENT" > "$TARGET"',
        '  exit "$rc"',
        'fi',
        'exec /usr/bin/sha256sum "$@"',
      ].join('\n'));
      chmodSync(script, 0o755);
      chmodSync(join(bin, 'sha256sum'), 0o755);

      const proc = Bun.spawnSync({
        cmd: ['sh', script, source],
        env: {
          ...process.env,
          MARKER: marker,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          REPLACEMENT: new TextDecoder().decode(newBytes),
          TARGET: source,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(proc.exitCode).toBe(0);
      const digest = parseDigestStream(new TextDecoder().decode(proc.stdout)).get(source);
      expect(digest).toEqual(digestBytes(oldBytes));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test('the same bytes produce the same hash, so a rename can reuse them', () => {
    expect(sha256Hex(fileBytes('x'))).toBe(digestBytes(fileBytes('x')).hash);
    expect(digestBytes(fileBytes('x')).hash).not.toBe(digestBytes(fileBytes('y')).hash);
  });
});

// ── strategy decision matrix ────────────────────────────────────────────────

const MOUNTED = [
  'sysfs /sys sysfs rw,relatime 0 0',
  `fuse-overlayfs ${DEVBOX_WORKDIR} fuse.fuse-overlayfs rw,nosuid,nodev,relatime 0 0`,
].join('\n');
const NOT_MOUNTED = 'proc /proc proc rw,relatime 0 0\n/dev/vdc / ext4 rw 0 0';
const INTERVAL_MS = 5 * 60_000;

const seenAttach = new Set<string>();
const seenCheckpoint = new Set<string>();

interface Harness {
  readonly ports: OverlayCasPorts;
  readonly calls: string[];
  readonly store: MemoryStore;
  /** The fake container's upper, so a test can assert what a replay wrote. */
  readonly upper: Map<string, UpperNode>;
  /** The durable Durable-Object state, so a RECYCLE test can carry exactly the
   *  two things that really survive one: the store and this. */
  readonly stateNow: () => OverlayCasState | null;
}

/** One entry in the fake container's overlay upper. */
type UpperNode =
  | { kind: 'file'; mode: number; mtimeMs: number; content: Uint8Array }
  | { kind: 'dir'; mode: number; mtimeMs: number }
  | { kind: 'symlink'; mode: number; mtimeMs: number; target: string }
  | { kind: 'whiteout' };

const UPPER_DIR = `${DEVBOX_RUNTIME_DIR}/cas-upper`;

function unquote(token: string): string {
  return token.startsWith("'") && token.endsWith("'")
    ? token.slice(1, -1).replaceAll(`'\\''`, "'")
    : token;
}

/**
 * A container that answers the commands this strategy really builds.
 *
 * It parses the actual `find`, digest-script and `tail | head | base64`
 * invocations rather than matching on a label, so the shell the strategy
 * emits is under test rather than assumed. A stubbed `scanUpper` port would
 * have proved only that the test's own fake agrees with itself.
 */
function fakeContainer(upper: Map<string, UpperNode>, calls: string[]) {
  const ok = (stdout: string) => ({ stdout, stderr: '', exitCode: 0 });

  const findOutput = (): string => {
    let out = '';
    for (const [path, node] of [...upper].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const absolute = `${UPPER_DIR}/${path}`;
      const type = node.kind === 'file' ? 'f'
        : node.kind === 'dir' ? 'd'
          : node.kind === 'symlink' ? 'l' : 'c';
      const mode = node.kind === 'whiteout' ? 0 : node.mode;
      const size = node.kind === 'file' ? node.content.byteLength : 0;
      const mtime = node.kind === 'whiteout' ? 0 : node.mtimeMs / 1000;
      const target = node.kind === 'symlink' ? node.target : '';
      out += `${type}\0${mode.toString(8)}\0${size}\0${mtime}\0${1}\0${target}\0${absolute}\0`;
    }
    return out;
  };

  const digestOutput = (paths: readonly string[]): string => {
    let out = '';
    for (const absolute of paths) {
      const node = upper.get(absolute.slice(UPPER_DIR.length + 1));
      if (node === undefined || node.kind !== 'file') continue;
      const digest = digestBytes(node.content);
      out += `F\0${absolute}\0${digest.size}\0${digest.hash}\0`;
      for (const chunk of digest.chunks) out += `C\0${chunk.hash}\0`;
    }
    return out;
  };

  return (command: string) => {
    if (command.startsWith('cat /proc/mounts')) return ok('');
    if (command.includes('UPPER-GONE')) {
      calls.push('scanUpper');
      return ok(`UPPER-OK:${Buffer.from(findOutput()).toString('base64')}`);
    }
    if (command.includes('cas-digest.sh')) {
      calls.push('digest');
      const paths = [...upper]
        .filter(([, node]) => node.kind === 'file')
        .map(([path]) => `${UPPER_DIR}/${path}`);
      return ok(Buffer.from(digestOutput(paths)).toString('base64'));
    }
    if (command.includes('| head -c ') && command.includes('base64')) {
      const absolute = unquote(/test -f (\S+) &&/.exec(command)?.[1] ?? '');
      const node = upper.get(absolute.slice(UPPER_DIR.length + 1));
      if (node === undefined || node.kind !== 'file') return { stdout: '', stderr: '', exitCode: 1 };
      const offset = Number(/tail -c \+(\d+)/.exec(command)?.[1] ?? '1') - 1;
      const want = Number(/head -c (\d+)/.exec(command)?.[1] ?? '0');
      const view = node.content.subarray(offset, offset + want);
      let binary = '';
      for (const byte of view) binary += String.fromCharCode(byte);
      return ok(btoa(binary));
    }
    const touch = /touch (?:-h )?-m -d @([0-9.]+) -- (.+)$/.exec(command);
    if (touch?.[1] && touch[2]) {
      const absolute = unquote(touch[2]);
      const node = upper.get(absolute.slice(UPPER_DIR.length + 1));
      if (node !== undefined && node.kind !== 'whiteout') {
        node.mtimeMs = Number(touch[1]) * 1000;
      }
    }
    return ok('');
  };
}

function harness(overrides: {
  running?: boolean;
  mountedAtStart?: boolean;
  mountLands?: boolean;
  overlayLands?: boolean;
  upperExists?: boolean;
  lowerExists?: boolean;
  objects?: number;
  bytes?: number;
  now?: number;
  lastCheckpointAt?: number;
  upper?: Map<string, UpperNode>;
  signatures?: OverlayCasState['signatures'];
  mkdirFails?: boolean;
  writeStateFails?: boolean;
  /** Reuse a prior box's store across a recycle. */
  store?: MemoryStore;
  /** Reuse a prior box's durable state across a recycle. */
  state?: OverlayCasState | null;
  /** Simulate GNU find failing MID-WALK: the upper exists but traversal hit
   *  an error, e.g. a file the workload deleted between listing and stat. */
  findFailsMidWalk?: boolean;
  materializeRefusal?: (entry: JournalEntry) => string | undefined;
} = {}): Harness {
  const calls: string[] = [];
  let mounted = overrides.mountedAtStart ?? false;
  const store = overrides.store ?? new MemoryStore();
  const upper = overrides.upper ?? new Map<string, UpperNode>();
  let state: OverlayCasState | null = overrides.state !== undefined
    ? overrides.state
    : overrides.lastCheckpointAt === undefined && overrides.signatures === undefined
      ? null
      : {
        lastCheckpointAt: overrides.lastCheckpointAt ?? 0,
        signatures: overrides.signatures ?? {},
        lastFailure: undefined,
      };
  let objects = overrides.objects ?? 0;
  let bytes = overrides.bytes ?? 0;
  const container = fakeContainer(upper, calls);

  const ports: OverlayCasPorts = {
    containerRunning: () => overrides.running ?? true,
    exec: async (command) => {
      if (command.startsWith('cat /proc/mounts')) {
        return Promise.resolve({
          stdout: mounted ? MOUNTED : NOT_MOUNTED, stderr: '', exitCode: 0,
        });
      }
      if (command.includes('fuse-overlayfs')) {
        calls.push('exec:overlayAttach');
        mounted = overrides.overlayLands ?? true;
        return Promise.resolve({
          stdout: '', stderr: mounted ? '' : 'fuse: mount failed', exitCode: mounted ? 0 : 1,
        });
      }
      if (command.startsWith('test -e ')) {
        const path = unquote(command.slice('test -e '.length).split(' ')[0] ?? '');
        calls.push(`pathExists:${path}`);
        const present = path === UPPER_DIR
          ? overrides.upperExists ?? true
          : path === CAS_TREE_MOUNT ? overrides.lowerExists ?? true : true;
        return Promise.resolve({ stdout: present ? 'yes' : 'no', stderr: '', exitCode: 0 });
      }
      // The combined attach postcondition: both layers, one exec, one disk.
      if (command.includes('&& echo upper') && command.includes('&& echo lower')) {
        calls.push('probeLayers');
        const lines: string[] = [];
        if (overrides.upperExists ?? true) lines.push('upper');
        if (overrides.lowerExists ?? true) lines.push('lower');
        return Promise.resolve({ stdout: lines.join('\n'), stderr: '', exitCode: 0 });
      }
      if (command.includes('UPPER-GONE')) {
        calls.push('scanUpper');
        const findErr = 'find: /var/tmp/devbox/cas-upper/a.txt: No such file or directory';
        // Emulate EACH COMMAND SHAPE's real shell semantics, because the
        // classifier under test must be judged against what its own command
        // actually emits — not against one canned answer.
        if (command.includes('if ! test -d')) {
          // New shape: absent exits 0 via marker; a failed find keeps the
          // already-printed marker on stdout and carries a non-zero exit.
          if (overrides.upperExists === false) {
            return Promise.resolve({ stdout: 'UPPER-GONE', stderr: '', exitCode: 0 });
          }
          if (overrides.findFailsMidWalk === true) {
            return Promise.resolve({
              stdout: 'UPPER-OK:',
              stderr: findErr,
              exitCode: 1,
            });
          }
          return Promise.resolve(container(command));
        }
        // Old shape: find is chained into the same && as test -d with an
        // `|| UPPER-GONE` fallback, so a traversal error appends the gone
        // marker AFTER the records, exits ZERO, and the walk looks complete.
        if (overrides.upperExists === false) {
          return Promise.resolve({ stdout: 'UPPER-GONE\0', stderr: '', exitCode: 0 });
        }
        const healthy = await Promise.resolve(container(
          command.replace(/ \|\| printf 'UPPER-GONE.*$/, ''),
        )).then(r => r.stdout);
        if (overrides.findFailsMidWalk === true) {
          return Promise.resolve({ stdout: `${healthy}UPPER-GONE\0`, stderr: '', exitCode: 0 });
        }
        return Promise.resolve({ stdout: healthy, stderr: '', exitCode: 0 });
      }
      if (command.startsWith('mkdir -p') && command.includes('mknod')) {
        calls.push('whiteout');
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }
      if (command.startsWith('mkdir -p')) {
        calls.push('mkdir');
        if (overrides.mkdirFails === true) {
          return Promise.resolve({
            stdout: '', stderr: 'mkdir: cannot create directory: Read-only file system',
            exitCode: 1,
          });
        }
      }
      return Promise.resolve(container(command));
    },
    writeFileBase64: (path, base64) => {
      calls.push(`writeFile:${path}`);
      if (path.endsWith('.sh')) return Promise.resolve();
      const bytesIn = atob(base64);
      const content = new Uint8Array(bytesIn.length);
      for (let at = 0; at < bytesIn.length; at += 1) content[at] = bytesIn.charCodeAt(at);
      upper.set(path.slice(UPPER_DIR.length + 1), {
        kind: 'file', mode: 0o644, mtimeMs: 0, content,
      });
      return Promise.resolve();
    },
    materializeBeneath: async ({ root, entry, stream }) => {
      calls.push(`materialize:${entry.kind}:${entry.path}`);
      if (root !== UPPER_DIR) return { kind: 'refused', reason: `unexpected root ${root}` };
      const refusal = overrides.materializeRefusal?.(entry);
      if (refusal !== undefined) return { kind: 'refused', reason: refusal };
      if (entry.kind === 'file') {
        if (stream === null) return { kind: 'refused', reason: 'file stream missing' };
        const reader = stream.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          size += value.byteLength;
        }
        const content = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          content.set(chunk, offset);
          offset += chunk.byteLength;
        }
        upper.set(entry.path, {
          kind: 'file', mode: entry.mode, mtimeMs: entry.mtimeMs, content,
        });
      } else if (entry.kind === 'dir') {
        upper.set(entry.path, { kind: 'dir', mode: entry.mode, mtimeMs: entry.mtimeMs });
      } else if (entry.kind === 'symlink') {
        upper.set(entry.path, {
          kind: 'symlink', mode: entry.mode, mtimeMs: entry.mtimeMs, target: entry.target,
        });
      } else {
        upper.set(entry.path, { kind: 'whiteout' });
      }
      return { kind: 'materialized' };
    },
    mountTree: () => {
      calls.push('mountTree');
      if (overrides.mountLands === false) return Promise.reject(new Error('mount refused'));
      return Promise.resolve();
    },
    unmountTree: () => {
      calls.push('unmountTree');
      return Promise.resolve();
    },
    store: () => store,
    inventory: () => Promise.resolve({ objects, bytes }),
    clearPrefix: () => {
      calls.push('clearPrefix');
      const deleted = objects;
      objects = 0;
      store.objects.clear();
      bytes = 0;
      return Promise.resolve(deleted);
    },
    readState: () => Promise.resolve(state),
    writeState: (next) => {
      calls.push('writeState');
      if (overrides.writeStateFails === true) {
        return Promise.reject(new Error('state write failed'));
      }
      state = next;
      return Promise.resolve();
    },
    clearState: () => {
      calls.push('clearState');
      state = null;
      return Promise.resolve();
    },
    checkpointIntervalMs: () => INTERVAL_MS,
    now: () => overrides.now ?? 1_000_000,
    log: (message) => calls.push(`log:${message}`),
  };
  return { ports, calls, store, upper, stateNow: () => state };
}

async function attachOf(record: Harness): Promise<AttachOutcome> {
  const outcome = await overlayCasStorage(record.ports).attach();
  seenAttach.add(outcome.kind);
  return outcome;
}

async function checkpointOf(record: Harness, kind: CheckpointKind): Promise<CheckpointOutcome> {
  const outcome = await overlayCasStorage(record.ports).checkpoint(kind);
  seenCheckpoint.add(outcome.kind);
  return outcome;
}

describe('attach — the mount must be observed to have landed', () => {
  test('a fresh box attaches an empty overlay', async () => {
    const record = harness({ objects: 0, bytes: 0 });
    const outcome = await attachOf(record);
    expect(outcome.kind).toBe('empty');
    expect(record.calls).toContain('mountTree');
    expect(record.calls.some(call => call === 'exec:overlayAttach')).toBe(true);
  });

  test('a prefix that already holds bytes attaches and reports them', async () => {
    const record = harness({ objects: 4, bytes: 800 });
    const outcome = await attachOf(record);
    expect(outcome.kind).toBe('attached');
    expect(outcome.detail).toContain('800B');
  });

  test('an already-mounted work directory is not remounted', async () => {
    const record = harness({ mountedAtStart: true, objects: 2, bytes: 10 });
    const outcome = await attachOf(record);
    expect(outcome.kind).toBe('already-attached');
    expect(record.calls.filter(call => call === 'mountTree')).toEqual([]);
  });

  test('THE REPLAY LANDS BEFORE THE OVERLAY, so mounted implies replayed', async () => {
    // THE ORDERING INVARIANT, and it supersedes repairing the state on retry.
    // A replay is many RPCs, so one can throw partway. If the overlay were
    // mounted FIRST, that throw would leave a half-replayed upper under a
    // mounted overlay, and the next attach would early-return over it — a
    // workspace silently missing changes the journal recorded, reporting an
    // outcome that reads like success. Mounting LAST makes the bad state
    // unrepresentable rather than repaired, so the early return is correct for
    // free and needs no marker.
    const record = harness({ objects: 2, bytes: 40 });
    const entry = { ...fileEntry(1, 'pending.txt', 'body'), mtimeMs: 123_456 };
    await stageBlobs({
      store: record.store,
      entries: [entry],
      readChunk: readerFor(new Map([['pending.txt', fileBytes('body')]])),
      commitBatch: async (batch) => { await appendJournalBatch(record.store, batch); },
    });

    await attachOf(record);

    // The bytes really landed, and they landed BEFORE the mount command ran.
    const wrote = record.calls.findIndex(call => call === 'materialize:file:pending.txt');
    const mount = record.calls.indexOf('exec:overlayAttach');
    expect(wrote).toBeGreaterThanOrEqual(0);
    expect(mount).toBeGreaterThanOrEqual(0);
    expect(wrote).toBeLessThan(mount);
    const replayedNode = record.upper.get('pending.txt');
    expect(replayedNode?.kind === 'file' ? replayedNode.mtimeMs : null).toBe(123_456);
  });

  test('an already-mounted box does NOT replay again, because the mount proves it happened', async () => {
    // The other half of the ordering invariant. Once mounting implies replayed,
    // re-replaying on every attach would be work done to maintain a property
    // the order already guarantees.
    const record = harness({ mountedAtStart: true, objects: 2, bytes: 40 });
    await appendJournalBatch(record.store, [fileEntry(1, 'pending.txt', 'body')]);
    const outcome = await attachOf(record);
    expect(outcome.kind).toBe('already-attached');
    expect(record.calls.some(call => call.includes('cas-upper/pending.txt'))).toBe(false);
  });

  test('a successful mount call that did not land fails the attach', async () => {
    const record = harness({ overlayLands: false });
    await expect(overlayCasStorage(record.ports).attach())
      .rejects.toThrow(/fuse-overlayfs attach/);
  });

  test('an overlay whose upper is missing fails rather than serving a lie', async () => {
    const record = harness({ upperExists: false });
    await expect(overlayCasStorage(record.ports).attach())
      .rejects.toThrow(/upper directory/);
  });

  test('an overlay whose tree/ lower is missing fails', async () => {
    const record = harness({ lowerExists: false });
    await expect(overlayCasStorage(record.ports).attach())
      .rejects.toThrow(/cas-lower/);
  });

  test('NOTHING RUNS BETWEEN mounting tree/ AND the overlay landing', async () => {
    // THE WAKE BRICK FROM THE VERDICT RUN. The replay is many RPCs, and it
    // sat between mountTree and fuse-overlayfs. A container replaced inside
    // that window left the fresh instance with nothing under /var/tmp, so
    // fuse-overlayfs answered `cannot resolve path .../cas-lower` for a lower
    // this same attach had mounted moments earlier on the previous instance.
    // The replay only needs the store binding and the upper directory, so it
    // runs BEFORE mountTree and the two mount steps are adjacent RPCs.
    const record = harness({ objects: 2, bytes: 40 });
    const entry = fileEntry(1, 'pending.txt', 'body');
    await stageBlobs({
      store: record.store,
      entries: [entry],
      readChunk: readerFor(new Map([['pending.txt', fileBytes('body')]])),
      commitBatch: async (batch) => { await appendJournalBatch(record.store, batch); },
    });
    await attachOf(record);
    const mount = record.calls.indexOf('mountTree');
    const fuse = record.calls.findIndex(call => call === 'exec:overlayAttach');
    expect(mount).toBeGreaterThanOrEqual(0);
    expect(fuse).toBeGreaterThan(mount);
    expect(fuse - mount).toBe(1);
  });

  test('A QUIESCE NEVER REPORTS SKIPPED AFTER IT HAS STAGED AND FOLDED', async () => {
    // THE VERDICT2 DATA LOSS. verify wrote a marker, called checkpointNow
    // ('quiesce'), and got back `skipped 0B /workspace holds no objects yet`.
    // The box then stopped and the marker was MISSING after the recycle. The
    // skip was returned AFTER staging, journalling, folding and advancing the
    // cursor — so it described completed work as not-done, and the caller had
    // no reason to treat the stop as unsafe. A quiesce is the last chance
    // before the container dies; it must report what it did, never `skipped`.
    const record = harness({ mountedAtStart: true, objects: 0, bytes: 0 });
    record.upper.set('marker.txt', { kind: 'file', mode: 0o644, mtimeMs: 5, content: fileBytes('m') });
    const outcome = await checkpointOf(record, 'quiesce');
    expect(outcome.kind).not.toBe('skipped');
  });

  test('a failed directory setup fails NAMING THE CAUSE, not two RPCs later', async () => {
    // The exit code used to be discarded, so a failed setup ran on to the mount
    // and surfaced as "cas-upper does not exist" — the symptom — while the
    // container's own words about the cause were thrown away.
    const record = harness({ mkdirFails: true });
    await expect(overlayCasStorage(record.ports).attach())
      .rejects.toThrow(/Read-only file system/);
  });

  test('a refused tree/ mount fails the start rather than degrading', async () => {
    const record = harness({ mountLands: false });
    await expect(overlayCasStorage(record.ports).attach())
      .rejects.toThrow(/could not be mounted/);
  });
});

describe('checkpoint — gated on a real overlay, proportional to the change', () => {
  test('a tick against an unattached directory cannot be skipped or committed', async () => {
    const record = harness({ mountedAtStart: false });
    const outcome = await checkpointOf(record, 'tick');
    expect(outcome.kind).toBe('failed');
    expect(outcome.reason).toMatch(/is not an overlay mount/);
  });

  test('a stopped container is skipped, not woken', async () => {
    const record = harness({ running: false, mountedAtStart: true });
    const outcome = await checkpointOf(record, 'tick');
    expect(outcome.kind).toBe('skipped');
    expect(outcome.reason).toBe('container is not running');
  });

  test('an unchanged tick is skipped', async () => {
    const record = harness({ mountedAtStart: true, objects: 3, bytes: 90 });
    const outcome = await checkpointOf(record, 'tick');
    expect(outcome.kind).toBe('skipped');
    expect(outcome.reason).toBe('work directory is unchanged');
  });

  test('a tick inside the interval is skipped even when there is a change', async () => {
    const record = harness({
      mountedAtStart: true,
      objects: 3,
      bytes: 90,
      lastCheckpointAt: 900_000,
      now: 1_000_000,
      upper: new Map([['x', { kind: 'whiteout' }]]),
    });
    const outcome = await checkpointOf(record, 'tick');
    expect(outcome.kind).toBe('skipped');
    expect(outcome.reason).toBe('within the minimum checkpoint interval');
  });

  test('a quiesce with a new file commits durable bytes', async () => {
    const content = fileBytes('payload');
    const record = harness({
      mountedAtStart: true,
      objects: 2,
      bytes: 64,
      upper: new Map([['a.txt', { kind: 'file', mode: 0o644, mtimeMs: 1000, content }]]),
    });
    const outcome = await checkpointOf(record, 'quiesce');
    expect(outcome.kind).toBe('committed');
    // `bytes` is HELD-AFTER-COMMIT per storage.ts, which the harness fixes at
    // 64 for this box. The durability evidence is the store reads below, NOT
    // this number — reading a held/inventory figure as proof that a checkpoint
    // did work is exactly what let a quiesce answer `skipped 0B` after it had
    // staged, folded and advanced the cursor.
    expect(outcome.bytes).toBe(64);
    // movedBytes is the OTHER quantity: what THIS checkpoint actually staged,
    // which is the 7-byte payload. A caller can no longer get this by
    // differencing held bytes across ticks — that goes negative at a rebase.
    expect(outcome.movedBytes).toBe(content.byteLength);
    // The whole lifecycle really ran: the blob landed, the fold materialized
    // the tree, and the cursor advanced. Read from the store, not from a call.
    expect(record.store.objects.has(blobKey(digestBytes(content).hash))).toBe(true);
    expect(record.store.objects.has('tree/a.txt')).toBe(true);
    expect(record.store.objects.has('cursor.json')).toBe(true);
  });

  test('A FAILED FIND IS NOT AN ABSENT UPPER', async () => {
    // THE DEPLOYED DEFECT FROM ABC-3. The walk chained find into the same
    // && as test -d, so any traversal error — a file the workload deleted
    // between listing and stat, ESTALE on the fuse mount — printed
    // UPPER-GONE and the checkpoint refused claiming the container was
    // replaced, while /proc/mounts and a later probe showed the upper
    // present. An absent upper and a failed walk are different facts and
    // the refusal must say which one happened.
    const record = harness({ mountedAtStart: true, objects: 3, bytes: 90, findFailsMidWalk: true });
    const outcome = await checkpointOf(record, 'quiesce');
    // A truncated walk must FAIL, never commit. Under the old && chain this
    // exact scenario exited zero with the gone-marker appended after partial
    // records, and the fold would have published half the changed set while
    // advancing the cursor past it — losing the rest for good.
    expect(outcome.kind).toBe('failed');
    expect(outcome.reason).toMatch(/walk of .*failed/i);
    expect(outcome.reason).toMatch(/No such file or directory/);
    expect(outcome.reason).not.toMatch(/does not exist/);
    expect(record.store.objects.has(journalKey(1))).toBe(false);
    expect(outcome.reason).not.toMatch(/does not exist/);
  });

  test('an exec-level failure is a FAILED WALK, never an absent upper', async () => {
    // Classification order: the GONE marker decides absence, an unsuccessful
    // exit decides failure, and only then may records be parsed. Checking the
    // OK marker first let an exec that died before printing anything lie about
    // an upper it never saw.
    const record = harness({ mountedAtStart: true, objects: 3, bytes: 90 });
    const inner = record.ports.exec;
    record.ports.exec = async (command) => {
      // Only the walk dies at the transport level; everything else, including
      // the /proc/mounts probe that decides attachment, answers normally.
      if (command.includes('UPPER-GONE')) {
        return { stdout: '', stderr: 'connection reset by peer', exitCode: 1 };
      }
      return await inner(command);
    };
    const outcome = await checkpointOf(record, 'quiesce');
    expect(outcome.kind).toBe('failed');
    expect(outcome.kind).toBe('failed');
    expect(outcome.reason).toMatch(/walk of .*failed/i);
    expect(outcome.reason).toMatch(/connection reset/);
  });

  test('an absent upper refuses instead of tombstoning every pending path', async () => {
    // THE CONTAINER-REPLACEMENT HAZARD. A scan is two RPCs and a spot container
    // can be replaced between them. On the fresh container the upper does not
    // exist, so the walk returns nothing — which read as an emptied workspace
    // would journal a delete for every path the previous generation held.
    const record = harness({
      mountedAtStart: true,
      objects: 3,
      bytes: 90,
      upperExists: false,
      signatures: {
        'kept.txt': { kind: 'file', mode: 0o644, mtimeMs: 1, size: 4, hash: 'a'.repeat(64) },
      },
    });
    const outcome = await checkpointOf(record, 'quiesce');
    expect(outcome.kind).toBe('failed');
    expect(outcome.reason).toMatch(/does not exist/);
    // Nothing was journalled, and above all no tombstone was written.
    expect([...record.store.objects.keys()]).toEqual([]);
  });
});

describe('discard — prefix then the pointer', () => {
  test('a live overlay is released before the prefix is deleted', async () => {
    const record = harness({ mountedAtStart: true, objects: 5 });
    await overlayCasStorage(record.ports).discard();
    expect(record.calls.indexOf('clearPrefix')).toBeLessThan(record.calls.indexOf('clearState'));
    expect(record.calls).toContain('clearPrefix');
  });

  test('a SECOND discard is harmless, because a box can be deleted twice', async () => {
    // The third entry point's second call. attach and checkpoint are both
    // idempotent by design and tested for it; discard was not, and a delete
    // path that throws the second time turns a retried teardown into an
    // incident about a box that is already gone.
    const record = harness({ mountedAtStart: true, objects: 5 });
    const storage = overlayCasStorage(record.ports);
    await storage.discard();
    await storage.discard();
    expect(record.calls.filter(call => call === 'clearPrefix')).toHaveLength(2);
    expect(record.calls.filter(call => call === 'clearState')).toHaveLength(2);
  });

  test('a stopped box still deletes the prefix', async () => {
    const record = harness({ running: false, mountedAtStart: false, objects: 3 });
    await overlayCasStorage(record.ports).discard();
    expect(record.calls).toContain('clearPrefix');
    expect(record.calls).toContain('clearState');
  });
});

describe('denominator', () => {
  test('every attach kind is produced', () => {
    expect([...seenAttach].sort()).toEqual([...ATTACH_OUTCOME_KINDS].sort());
  });

  test('every checkpoint kind is produced', () => {
    expect([...seenCheckpoint].sort()).toEqual([...CHECKPOINT_OUTCOME_KINDS].sort());
  });
});

// ── stored rows are parsed, never cast ──────────────────────────────────────
//
// A journal object, the manifest and the cursor are durable rows read back from
// the store. Each goes through a schema, so a valid-JSON-wrong-shape row
// refuses at the boundary naming its key instead of flowing onward as an entry
// whose fields are undefined.

/** A store whose LISTING names a key its GET cannot serve. That combination is
 *  the one the reap-after-cursor rule makes impossible, so it must refuse. */
class HollowStore extends MemoryStore {
  override async get(key: string): Promise<Uint8Array | null> {
    if (key.startsWith('journal/')) return null;
    return await super.get(key);
  }
}


describe('stored rows are parsed, never cast', () => {
  test('rejects every noncanonical stored path before it touches the container', async () => {
    const paths = [
      '', '/absolute', '.', '..', 'a//b', 'a/./b', 'a/../b', 'trailing/',
      `nul\0path`, 'x'.repeat(4_096), `dir/${'x'.repeat(256)}`,
    ];
    for (const path of paths) {
      const store = new MemoryStore();
      await store.put(journalKey(1), new TextEncoder().encode(`${JSON.stringify([{
        kind: 'file', seq: 1, path, mode: 0o644, mtimeMs: 0,
        size: 0, hash: sha256Hex(new Uint8Array()), chunks: [],
      }])}\n`));
      const record = harness({ store });
      await expect(overlayCasStorage(record.ports).attach()).rejects.toThrow(/does not match its schema/);
      expect(record.calls).toEqual([]);
    }
  });

  test('a journal batch that is valid JSON but the wrong shape refuses, naming the key', async () => {
    const store = new MemoryStore();
    await store.put(journalKey(1), new TextEncoder().encode('{"notABatch":true}\n'));
    await expect(listJournalAfter(store, 0)).rejects.toThrow(/journal\/000000000001\.json/);
  });

  test('a journal entry whose hash is truncated refuses rather than naming a short blob', async () => {
    const store = new MemoryStore();
    const bad = [{
      kind: 'file', seq: 1, path: 'a.txt', mode: 420, mtimeMs: 0,
      size: 4, hash: 'abc', chunks: [{ hash: 'abc', size: 4 }],
    }];
    await store.put(journalKey(1), new TextEncoder().encode(`${JSON.stringify(bad)}\n`));
    await expect(listJournalAfter(store, 0)).rejects.toThrow(/does not match its schema/);
  });

  test('a chunk of ZERO bytes refuses, because it would name a blob holding nothing', async () => {
    const store = new MemoryStore();
    const bad = [{
      kind: 'file', seq: 1, path: 'a.txt', mode: 420, mtimeMs: 0,
      size: 4, hash: 'a'.repeat(64), chunks: [{ hash: 'a'.repeat(64), size: 0 }],
    }];
    await store.put(journalKey(1), new TextEncoder().encode(`${JSON.stringify(bad)}\n`));
    await expect(listJournalAfter(store, 0)).rejects.toThrow(/does not match its schema/);
  });

  test('a beneath-only refusal blocks a symlink-ancestor write without materializing it', async () => {
    const store = new MemoryStore();
    await appendJournalBatch(store, [{
      kind: 'file', seq: 1, path: 'escape/payload', mode: 0o644, mtimeMs: 0,
      size: 0, hash: sha256Hex(new Uint8Array()), chunks: [],
    }]);
    const record = harness({
      store,
      // This is the host boundary's observation. It can only be made safely
      // during an fd-relative write, not by testing a path before that write.
      materializeRefusal: (entry) => entry.path === 'escape/payload'
        ? 'an ancestor resolves through a symlink'
        : undefined,
    });
    await expect(overlayCasStorage(record.ports).attach())
      .rejects.toThrow(/ancestor resolves through a symlink/);
    expect(record.upper.has('escape/payload')).toBe(false);
    expect(record.calls).toContain('materialize:file:escape/payload');
  });

  test('a zero-byte FILE is accepted, because an empty file is ordinary', async () => {
    // The bound that deliberately differs from the chunk above. Same field
    // name, different referent: a file may be empty, a chunk may not.
    const store = new MemoryStore();
    const empty = [{
      kind: 'file', seq: 1, path: 'empty.txt', mode: 420, mtimeMs: 0,
      size: 0, hash: 'a'.repeat(64), chunks: [],
    }];
    await store.put(journalKey(1), new TextEncoder().encode(`${JSON.stringify(empty)}\n`));
    expect(await listJournalAfter(store, 0)).toHaveLength(1);
  });

  test('A CORRUPT CURSOR REFUSES rather than reading as nothing-folded', async () => {
    // Defaulting to 0 would re-fold the whole store from the beginning AND make
    // every already-folded path look pending, which is the mass-tombstone path
    // reached through the cursor instead of through the scan.
    const store = new MemoryStore();
    await store.put('cursor.json', new TextEncoder().encode('{"foldedSeq":"soon"}\n'));
    await expect(readFoldedSeq(store)).rejects.toThrow(/cursor\.json/);
  });

  test('an ABSENT cursor still reads as zero, because a fresh store has folded nothing', async () => {
    expect(await readFoldedSeq(new MemoryStore())).toBe(0);
  });

  test('a listed journal object whose bytes are gone refuses, because it cannot have been reaped', async () => {
    const store = new HollowStore();
    await appendJournalBatch(store, [fileEntry(1, 'a.txt', 'x')]);
    await expect(listJournalAfter(store, 0)).rejects.toThrow(/journal has a hole/);
  });
});

// ── survival across a recycle, on a FRESH ISOLATE ───────────────────────────
//
// The deployed shape the in-memory harness never modelled: between a quiesce
// and the next attach the container is destroyed and the Durable Object may be
// evicted. Anything not written to the STORE or to durable state is gone. The
// fixtures below carry only those two things across the boundary.

describe('a pre-stop write survives the recycle', () => {
  test('a marker written before quiesce is readable after a fresh attach', async () => {
    // THE VERDICT2 FAILURE, end to end: verify wrote a marker, quiesced,
    // recycled, and the marker was MISSING.
    const first = harness({ mountedAtStart: true, objects: 0, bytes: 0 });
    first.upper.set('marker.txt', {
      kind: 'file', mode: 0o644, mtimeMs: 5, content: fileBytes('survive-me'),
    });
    const committed = await checkpointOf(first, 'quiesce');
    expect(committed.kind).toBe('committed');

    // THE RECYCLE. A brand-new container (empty upper, nothing mounted) and a
    // brand-new isolate: only the store and the durable state cross over.
    const second = harness({
      mountedAtStart: false,
      store: first.store,
      state: first.stateNow(),
    });
    await attachOf(second);

    // The bytes are reachable again: either replayed into the upper from a
    // pending journal batch, or already folded into tree/ and served by the
    // lower. Both are survival; neither is MISSING.
    const inTree = [...first.store.objects.keys()].some(key => key.startsWith('tree/'));
    const replayed = second.upper.has('marker.txt');
    expect(inTree || replayed).toBe(true);
  });

  test('the fold published the marker, so tree/ can serve it with no journal left', async () => {
    const box = harness({ mountedAtStart: true, objects: 0, bytes: 0 });
    box.upper.set('keep.txt', {
      kind: 'file', mode: 0o644, mtimeMs: 7, content: fileBytes('durable'),
    });
    await checkpointOf(box, 'quiesce');
    // A quiesce folds, so nothing may be left pending: a reader that only
    // consults tree/ must still find the bytes.
    expect(await pendingBatches(box.store, await readFoldedSeq(box.store))).toHaveLength(0);
    expect([...box.store.objects.keys()].some(key => key.startsWith('tree/'))).toBe(true);
  });

  test('a crash after fold and cursor cannot tombstone the folded file', async () => {
    const first = harness({ mountedAtStart: true, objects: 0, bytes: 0 });
    first.upper.set('committed.txt', {
      kind: 'file', mode: 0o644, mtimeMs: 9, content: fileBytes('kept'),
    });
    expect((await checkpointOf(first, 'tick')).kind).toBe('committed');
    const oldState = first.stateNow();

    const folding = harness({
      mountedAtStart: true,
      store: first.store,
      state: oldState,
      upper: first.upper,
      writeStateFails: true,
    });
    await expect(checkpointOf(folding, 'quiesce')).rejects.toThrow('state write failed');
    expect(first.store.objects.has('tree/committed.txt')).toBe(true);
    expect(await readFoldedSeq(first.store)).toBeGreaterThan(0);

    const recovered = harness({
      mountedAtStart: true,
      store: first.store,
      state: oldState,
      upper: new Map(),
    });
    await checkpointOf(recovered, 'quiesce');
    expect(first.store.objects.has('tree/committed.txt')).toBe(true);
  });
});

describe('movedBytes says what this checkpoint moved', () => {
  test('a skipped tick moved nothing, and says 0 rather than unanswerable', async () => {
    // 0 and undefined are different claims. A skip KNOWS it moved nothing.
    const record = harness({
      mountedAtStart: true, objects: 2, bytes: 64,
      now: 1_000, lastCheckpointAt: 900,
      upper: new Map([['a.txt', { kind: 'file', mode: 0o644, mtimeMs: 1, content: fileBytes('x') }]]),
    });
    const outcome = await checkpointOf(record, 'tick');
    expect(outcome.kind).toBe('skipped');
    expect(outcome.movedBytes).toBe(0);
  });

  test('a FAILED checkpoint answers undefined, because it cannot know', async () => {
    // A checkpoint that threw mid-flight may have landed blobs before failing.
    // Reporting 0 would assert nothing moved — a stronger claim than it can make.
    const record = harness({ mountedAtStart: true, objects: 3, bytes: 90, findFailsMidWalk: true });
    const outcome = await checkpointOf(record, 'quiesce');
    expect(outcome.kind).toBe('failed');
    expect(outcome.movedBytes).toBeUndefined();
  });
});

// ── accepted review findings ────────────────────────────────────────────────

describe('the stale bystander rule — unjournalled paths stay detectable', () => {
  function bystanderHarness() {
    const record = harness({ mountedAtStart: true, objects: 0, bytes: 0 });
    record.upper.set('a-fresh.txt', {
      kind: 'file', mode: 0o644, mtimeMs: 100, content: fileBytes('AAAA'),
    });
    record.upper.set('m-stale.txt', {
      kind: 'file', mode: 0o644, mtimeMs: 100, content: fileBytes('BBBBBB'),
    });
    record.upper.set('z-fresh.txt', {

      kind: 'file', mode: 0o644, mtimeMs: 100, content: fileBytes('CCCCCC'),
    });
    // THE STALE EVENT: the middle file's bytes change between the digest and
    // the chunk read, which is exactly what a writer mid-tick produces.
    const inner = record.ports.exec;
    let stale = true;
    record.ports.exec = async (command) => {
      if (stale && command.includes('| head -c ') && command.includes('/m-stale.txt')) {
        return { stdout: btoa('XXXXXX'), stderr: '', exitCode: 0 };
      }
      return await inner(command);
    };
    return { record, clearStale: () => { stale = false; } };
  }

  test('a stale entry stops staging and NOTHING unjournalled is recorded', async () => {
    const { record } = bystanderHarness();
    const outcome = await checkpointOf(record, 'quiesce');
    // The stale file aborts its WHOLE batch (stageBlobs stops there), so this
    // quiesce journalled none of the three changes.
    expect(outcome.kind).toBe('failed');
    expect(outcome.reason).toContain('changed while their checkpoint chunks were read');
    // The sweep reclaimed the blob staging uploaded before the stale stop;
    // nothing durable names any of the three changes.
    expect([...record.store.objects.keys()].filter(k => k.startsWith('blobs/'))).toEqual([]);
    // AND THE FIX ITSELF: no path carries a fresh signature (a fresh box has
    // none to carry forward), so the next scan re-detects all three instead
    // of believing they were saved. The OLD code persisted every scanned
    // signature here, and these three asserts are what failed.
    const state = record.stateNow();
    expect(state?.signatures['a-fresh.txt']).toBeUndefined();
    expect(state?.signatures['m-stale.txt']).toBeUndefined();
    expect(state?.signatures['z-fresh.txt']).toBeUndefined();
  });

  test('every non-stale change survives the next checkpoint AND a recycle', async () => {
    const { record, clearStale } = bystanderHarness();
    await checkpointOf(record, 'quiesce');
    clearStale();

    // THE RE-DETECTION TICK. Carried-back signatures mean all three files are
    // seen as changed again and journalled. Under the old persist-everything
    // behaviour this quiesce saw fresh signatures for unchanged-looking paths
    // and committed nothing — the silent loss on recycle.
    const second = await checkpointOf(record, 'quiesce');
    expect(second.kind).toBe('committed');

    // THE RECYCLE. Fresh container, fresh isolate; only the store and the
    const journalPutsBefore = record.store.writes
      .filter(write => write.startsWith('put:journal/')).length;
    const unchanged = await checkpointOf(record, 'tick');
    expect(unchanged.kind).toBe('skipped');
    expect(record.store.writes.filter(write => write.startsWith('put:journal/')))
      .toHaveLength(journalPutsBefore);
    // durable state cross. Every non-stale change must be readable again.
    const recycled = harness({
      mountedAtStart: false,
      store: record.store,
      state: record.stateNow(),
    });
    await attachOf(recycled);

    for (const [path, text] of [
      ['a-fresh.txt', 'AAAA'], ['m-stale.txt', 'BBBBBB'], ['z-fresh.txt', 'CCCCCC'],
    ] as const) {
      const inTree = record.store.objects.get(`tree/${path}`);
      expect(inTree !== undefined || recycled.upper.has(path)).toBe(true);
      if (inTree !== undefined) {
        expect(new TextDecoder().decode(inTree)).toBe(text);
      }
    }
  });
});
  test('a failed later batch reloads ownership and sequence before retry', async () => {
    const store = new FailSecondJournalStore();
    const record = harness({ mountedAtStart: true, objects: 0, bytes: 0, store });
    for (let at = 0; at < 65; at += 1) {
      record.upper.set(`batch-${String(at).padStart(2, '0')}.txt`, {
        kind: 'file', mode: 0o644, mtimeMs: at + 1, content: fileBytes(String(at)),
      });
    }
    const storage = overlayCasStorage(record.ports);
    const first = await storage.checkpoint('tick');
    expect(first.kind).toBe('failed');
    expect(first.reason).toContain('second journal batch failed');

    record.upper.delete('batch-00.txt');
    const retry = await storage.checkpoint('quiesce');

    expect(retry.kind).toBe('committed');
    expect(store.objects.has('tree/batch-00.txt')).toBe(false);
    const journalPuts = store.writes.filter(write => write.startsWith('put:journal/'));
    expect(new Set(journalPuts).size).toBe(journalPuts.length);
  });

describe('durable state bounds — named ceilings at the bound and one past', () => {

  test('capSignatures keeps the newest cache rows regardless of fold state', () => {
    const sig = (folded?: boolean): UpperSignature => {
      const signature: UpperSignature = {
        kind: 'file', mode: 0o644, mtimeMs: 1, size: 1, hash: 'a'.repeat(64),
      };
      return folded === undefined ? signature : { ...signature, folded };
    };
    const rows = new Map<string, UpperSignature>();
    rows.set('old-folded', sig(true));
    for (let at = 0; at < SIGNATURE_ROWS_MAX; at += 1) rows.set(`p${at}`, sig());

    const capped = capSignatures(rows);
    expect(capped.size).toBe(SIGNATURE_ROWS_MAX);
    expect(capped.has('old-folded')).toBe(false);
    expect(capped.has('p0')).toBe(true);
    expect(capped.has(`p${SIGNATURE_ROWS_MAX - 1}`)).toBe(true);
  });

  test('evicting a signature cannot resurrect an upper-only file after delete', async () => {
    const record = harness({ mountedAtStart: true, objects: 0, bytes: 0 });
    for (let at = 0; at <= SIGNATURE_ROWS_MAX + 1; at += 1) {
      record.upper.set(`p${at}`, {
        kind: 'file', mode: 0o644, mtimeMs: at + 1, content: fileBytes('x'),
      });
    }
    const tick = await checkpointOf(record, 'tick');
    expect(tick.kind).toBe('committed');
    expect(record.stateNow()?.signatures['p0']).toBeUndefined();
    const journalPutsBefore = record.store.writes
      .filter(write => write.startsWith('put:journal/')).length;
    const unchanged = await checkpointOf(record, 'tick');
    expect(unchanged.kind).toBe('skipped');
    expect(record.store.writes.filter(write => write.startsWith('put:journal/')))
      .toHaveLength(journalPutsBefore);

    record.upper.delete('p0');
    const quiesce = await checkpointOf(record, 'quiesce');

    expect(quiesce.kind).toBe('committed');
    expect(record.store.objects.has('tree/p0')).toBe(false);
    expect(await listJournalAfter(record.store, await readFoldedSeq(record.store)))
      .toEqual([]);
    const journalPutsAfterFold = record.store.writes
      .filter(write => write.startsWith('put:journal/')).length;
    const unchangedAfterFold = await checkpointOf(record, 'tick');
    expect(unchangedAfterFold.kind).toBe('skipped');
    expect(record.store.writes.filter(write => write.startsWith('put:journal/')))
      .toHaveLength(journalPutsAfterFold);
  }, 30_000);

  test('overlayCasStateBytes crosses OVERLAY_CAS_STATE_MAX_BYTES at a measurable boundary',
    () => {
      const row = (pathChars: number): OverlayCasState['signatures'] => ({
        [`${'x'.repeat(pathChars)}`]: {
          kind: 'file', mode: 0o644, mtimeMs: 1, size: 1, hash: 'a'.repeat(64),
        },
      });
      // Grow the single row's path until the serialized row passes the ceiling;
      // one step back is the last shape that still fits. At the bound it fits;
      // one past, it does not.
      let low = 0;
      let high = 0;
      for (let chars = 100; chars <= 2_000_000; chars += 100) {
        const bytes = overlayCasStateBytes(new Map(Object.entries(row(chars))));
        if (bytes > OVERLAY_CAS_STATE_MAX_BYTES) {
          high = chars;
          break;
        }
        low = chars;
      }
      expect(low).toBeGreaterThan(0);
      expect(overlayCasStateBytes(new Map(Object.entries(row(low)))))
        .toBeLessThanOrEqual(OVERLAY_CAS_STATE_MAX_BYTES);
      expect(overlayCasStateBytes(new Map(Object.entries(row(high)))))
        .toBeGreaterThan(OVERLAY_CAS_STATE_MAX_BYTES);
      // And the measurement is the payload's own byte length, so the gate
      // cannot drift from what writeState actually puts.
      expect(overlayCasStateBytes(new Map())).toBe(
        new TextEncoder().encode(JSON.stringify({
          lastCheckpointAt: 0, signatures: {},
        })).byteLength,
      );
    });

  test('a state row past the ceiling refuses BEFORE any journal effect', async () => {
    // Long-path rows keep the row count far under SIGNATURE_ROWS_MAX while the
    // serialized size blows past the byte ceiling — the shape the count cap
    // cannot fix and the byte bound exists for.
    const signatures: Record<string, UpperSignature> = {};
    for (let at = 0; at < 400; at += 1) {
      signatures[`${String(at).padStart(4, '0')}${'p'.repeat(3000)}`] = {
        kind: 'file', mode: 0o644, mtimeMs: 1, size: 1, hash: 'a'.repeat(64),
      };
    }
    const record = harness({ mountedAtStart: true, signatures });
    const outcome = await checkpointOf(record, 'quiesce');
    expect(outcome.kind).toBe('failed');
    expect(outcome.reason ?? '').toMatch(/state row would hold/);
    expect(outcome.reason ?? '').toContain(String(OVERLAY_CAS_STATE_MAX_BYTES));
    // Nothing was staged, nothing was journalled: the refusal landed before
    // any durable effect.
    expect(record.store.objects.size).toBe(0);
    expect(record.stateNow()?.lastFailure?.reason).toMatch(/state row would hold/);
  });
});

describe('the off-hot-path orphan blob sweep', () => {
  test('superseded versions go; manifest-reachable and pending blobs stay', async () => {
    const store = new MemoryStore();
    const v1 = fileEntry(1, 'doc.txt', 'version-one');
    const v2 = fileEntry(2, 'doc.txt', 'version-two!');
    const contents = new Map([
      ['doc.txt', fileBytes('version-one')],
    ]);
    await stageBlobs({ store, entries: [v1], readChunk: readerFor(contents) });
    await appendJournalBatch(store, [v1]);
    await foldJournalIntoTree(store);
    contents.set('doc.txt', fileBytes('version-two!'));
    await stageBlobs({ store, entries: [v2], readChunk: readerFor(contents) });
    await appendJournalBatch(store, [v2]);
    await foldJournalIntoTree(store);

    // v1's chunks are unreachable: the manifest names only v2 now, and no
    // journal is pending.
    const swept = await sweepOrphanBlobs(store);
    expect(swept.deleted).toBeGreaterThanOrEqual(1);
    expect(store.objects.has(blobKey(v1.hash))).toBe(false);
    expect(store.objects.has(blobKey(v2.hash))).toBe(true);

    // A tombstone folds: its target's blobs become unreachable too.
    const gone: JournalEntry = { kind: 'delete', seq: 3, path: 'doc.txt' };
    await appendJournalBatch(store, [gone]);
    await foldJournalIntoTree(store);
    await sweepOrphanBlobs(store);
    expect(store.objects.has(blobKey(v2.hash))).toBe(false);

    // PENDING entries reach their blobs without a fold: a sweep between ticks
    // must never delete what an attach replay would need.
    const kept = fileEntry(4, 'new.txt', 'pending-bytes');
    await stageBlobs({
      store, entries: [kept],
      readChunk: readerFor(new Map([['new.txt', fileBytes('pending-bytes')]])),
    });
    await appendJournalBatch(store, [kept]);
    const afterPending = await sweepOrphanBlobs(store);
    expect(afterPending.deleted).toBe(0);
    expect(store.objects.has(blobKey(kept.hash))).toBe(true);
  });

  test('a quiesce sweeps superseded blobs; reachable ones survive', async () => {
    const box = harness({ mountedAtStart: true, objects: 0, bytes: 0 });
    box.upper.set('m.txt', {
      kind: 'file', mode: 0o644, mtimeMs: 5, content: fileBytes('generation-one'),
    });
    expect((await checkpointOf(box, 'quiesce')).kind).toBe('committed');
    box.upper.set('m.txt', {
      kind: 'file', mode: 0o644, mtimeMs: 9, content: fileBytes('generation-two'),
    });
    expect((await checkpointOf(box, 'quiesce')).kind).toBe('committed');

    const blobKeys = [...box.store.objects.keys()].filter(key => key.startsWith('blobs/'));
    expect(blobKeys).toEqual([blobKey(digestBytes(fileBytes('generation-two')).hash)]);
    // The fold's own tree copy of the current version is intact.
    expect(box.store.objects.has('tree/m.txt')).toBe(true);
  });

  test('the sweep never runs on a tick', async () => {
    const record2 = harness({
      mountedAtStart: true, objects: 3, bytes: 90,
      lastCheckpointAt: 900_000, now: 10_000_000,
      upper: new Map([['n.txt', {
        kind: 'file' as const, mode: 0o644, mtimeMs: 5, content: fileBytes('tick-me'),
      }]]),
    });
    const tick = await checkpointOf(record2, 'tick');
    expect(tick.kind).toBe('committed');
    // A tick folds nothing and therefore sweeps nothing.
    expect(record2.calls.filter(call => call.includes('log:quiesce folded'))).toEqual([]);
  });
});

describe('large file assembly stays on the streaming path', () => {
  test('a file above the old 16 MiB ceiling folds byte-exactly', async () => {
    const record = harness({ mountedAtStart: true, objects: 0, bytes: 0 });
    record.store.requireBlobGetsInsideStream = true;
    const size = 20 * 1024 * 1024 + 123;
    const content = Uint8Array.from({ length: size }, (_, i) => (i % 251) + 1);
    record.upper.set('large.bin', {
      kind: 'file', mode: 0o644, mtimeMs: 1, content,
    });

    const outcome = await checkpointOf(record, 'quiesce');

    expect(outcome.kind).toBe('committed');
    expect(outcome.movedBytes).toBe(size);
    expect(record.store.objects.get('tree/large.bin')).toEqual(content);
    expect([...record.store.objects.keys()].filter(key => key.startsWith('blobs/')))
      .toHaveLength(Math.ceil(size / CHUNK_SIZE));
  }, 30_000);
});

describe('movedBytes counts blob bytes, not staged file sizes', () => {
  test('a rename moves zero bytes into the store', async () => {
    const record = harness({ mountedAtStart: true, objects: 0, bytes: 0 });
    record.upper.set('old.txt', {
      kind: 'file', mode: 0o644, mtimeMs: 5, content: fileBytes('payload'),
    });
    const first = await checkpointOf(record, 'quiesce');
    expect(first.kind).toBe('committed');
    expect(first.movedBytes).toBe(fileBytes('payload').byteLength);

    // RENAME: whiteout the folded path, create the new one with the SAME
    // bytes. Content addressing dedups the chunk; the only PUTs this
    // checkpoint makes are journal objects, and those are subtracted out.
    record.upper.delete('old.txt');
    record.upper.set('old.txt', { kind: 'whiteout' });
    record.upper.set('new.txt', {
      kind: 'file', mode: 0o644, mtimeMs: 9, content: fileBytes('payload'),
    });
    const renamed = await checkpointOf(record, 'quiesce');
    expect(renamed.kind).toBe('committed');
    expect(renamed.movedBytes).toBe(0);
    // And the fold still published both halves of the rename.
    expect(record.store.objects.has('tree/new.txt')).toBe(true);
    expect(record.store.objects.has('tree/old.txt')).toBe(false);
  });
});

describe('discard clears activation caches', () => {
  test('reusing one DO instance after discard cannot suppress the next PUT', async () => {
    const record = harness({ mountedAtStart: true, objects: 0, bytes: 0 });
    record.upper.set('same.txt', {
      kind: 'file', mode: 0o644, mtimeMs: 1, content: fileBytes('same'),
    });
    const storage = overlayCasStorage(record.ports);
    expect((await storage.checkpoint('tick')).kind).toBe('committed');
    await storage.discard();

    record.upper.clear();
    record.upper.set('same.txt', {
      kind: 'file', mode: 0o644, mtimeMs: 1, content: fileBytes('same'),
    });
    const after = await storage.checkpoint('tick');
    expect(after.kind).toBe('committed');
    expect(after.movedBytes).toBeGreaterThan(0);
  });
});

describe('manifest-backed blob reuse', () => {
  test('a metadata-only rewrite skips R2 HEAD for a manifest-reachable blob', async () => {
    const record = harness({ mountedAtStart: true, objects: 0, bytes: 0 });
    record.upper.set('reuse.txt', {
      kind: 'file', mode: 0o644, mtimeMs: 1, content: fileBytes('same bytes'),
    });
    expect((await checkpointOf(record, 'quiesce')).kind).toBe('committed');
    const headCalls = record.store.counters.headCalls;

    record.upper.set('reuse.txt', {
      kind: 'file', mode: 0o644, mtimeMs: 2, content: fileBytes('same bytes'),
    });
    const quiesce = await checkpointOf(record, 'quiesce');

    expect(quiesce.kind).toBe('committed');
    expect(quiesce.movedBytes).toBe(0);
    expect(record.store.counters.headCalls).toBe(headCalls);
  });
});
