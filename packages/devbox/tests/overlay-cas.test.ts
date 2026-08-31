// The overlay-cas gate.
//
// Two suites share this file because they are one strategy: the CAS helpers are
// what make a crash safe, and the DevboxStorage adapter is what turns them into
// a third arm. The helpers are driven through an in-memory store; the adapter is
// driven through its ports, whose one interesting member hands back a receipt
// the container-side runner printed.
//
// The last two tests assert the denominator: every outcome kind the
// implementation enumerates has to be produced above.
import { describe, expect, test } from 'bun:test';

import {
  appendJournalBatch,
  CAS_FORMAT_VERSION,
  blobKey,
  coalesce,
  digestBytes,
  emptyCounters,
  foldJournalIntoTree,
  journalKey,
  JournalBatchSchema,
  decodeJson,
  listJournalAfter,
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
  CAS_RUNNER_PATH,
  CAS_STORE_MOUNT,
  CAS_TREE_MOUNT,
  CAS_UPPER_DIR,
  normalizeOverlayCasState,
  overlayCasStorage,
  type OverlayCasOperation,
  type OverlayCasPorts,
  type OverlayCasState,
} from '../src/overlay-cas';
import type { OverlayRunnerReceipt } from '../src/cas/overlay-runner';
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
    parts: digest.parts,
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
    const batch = decodeJson(JournalBatchSchema, key, raw).entries;
    for (const entry of batch) {
      if (entry.kind !== 'file') continue;
      for (const part of entry.parts) {
        if (part.kind === 'data') expect(store.objects.has(blobKey(part.hash))).toBe(true);
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
          for (const part of entry.parts) {
            if (part.kind === 'data') expect(store.objects.has(blobKey(part.hash))).toBe(true);
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
  const sound = { lastCheckpointAt: 5, lastFailure: { at: 7, reason: 'a refusal' } };

  test('the row this release writes round-trips both of its fields', () => {
    const state = normalizeOverlayCasState(sound);
    expect(state?.lastCheckpointAt).toBe(5);
    expect(state?.lastFailure).toEqual({ at: 7, reason: 'a refusal' });
  });

  test('A CHAIN ROW READS AS ABSENT, so a box never attaches from a record it did not write', () => {
    // The hazard this parser exists for. Both strategies keep durable state on
    // the same object; an unchecked cast would read a chain record as a CAS
    // record, and the box would report a checkpoint clock that was never its own.
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
    expect(normalizeOverlayCasState({ ...sound, lastFailure: { at: 'later', reason: 'x' } })).toBeNull();
  });

  test('THE SIGNATURE ROWS AN OLDER ROW CARRIED ARE NOT READ BACK', () => {
    // The scan cache moved into the store, beside the bytes it describes and
    // beside the scan that consumes it. A row from the release that kept those
    // rows here still parses — its clock and its failure are the two facts this
    // object acts on — and the cache it carried is deliberately dropped rather
    // than copied forward into state nothing reads.
    const legacy = {
      lastCheckpointAt: 11,
      signatures: { 'a.txt': { kind: 'file', mode: 0o644, mtimeMs: 1, size: 4, hash: 'a'.repeat(64) } },
    };
    const state = normalizeOverlayCasState(legacy);
    expect(state?.lastCheckpointAt).toBe(11);
    expect(Object.hasOwn(state ?? {}, 'signatures')).toBe(false);
  });
});

describe('digest identity', () => {
  test('the same bytes produce the same hash, so a rename can reuse them', () => {
    expect(sha256Hex(fileBytes('x'))).toBe(digestBytes(fileBytes('x')).hash);
    expect(digestBytes(fileBytes('x')).hash).not.toBe(digestBytes(fileBytes('y')).hash);
  });
});

// ── the adapter: mounts, one runner invocation, and the durable row ─────────
//
// THE SEAM IS THE RECEIPT. Every byte this strategy moves is moved by the
// container-side runner, so these tests drive the ports the Durable Object
// really has — mount, invoke, validate, write down — and assert what it does
// with what the runner printed. Nothing here fakes a shell, because the
// adapter no longer builds one.

const INTERVAL_MS = 5 * 60_000;

const seenAttach = new Set<string>();
const seenCheckpoint = new Set<string>();

type RunnerRun = {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
};

interface Harness {
  readonly ports: OverlayCasPorts;
  /** Every port call, in order. The ordering assertions read this: an
   *  end-state check cannot tell a safe order from an unsafe one. */
  readonly calls: string[];
  /** Every console line the strategy emitted. Separate from `calls`, because a
   *  diagnostic is not a port call and the ordering assertions read that. */
  readonly logs: string[];
  readonly stateNow: () => OverlayCasState | null;
  /** What the upper holds. Only the salvage writes it here, which is what makes
   *  "these bytes reached the upper" assertable. */
  readonly upperNow: () => readonly string[];
}

/** One receipt, exactly as the runner prints it. */
function receipt(
  operation: OverlayCasOperation,
  counters: Partial<Omit<OverlayRunnerReceipt, 'operation'>> = {},
): string {
  return `${JSON.stringify({
    operation, entries: 0, movedBytes: 0, foldedEntries: 0, sweptBlobs: 0, foldedSeq: 0,
    ...counters,
  })}\n`;
}

function harness(overrides: {
  running?: boolean;
  mounted?: boolean;
  /** Whether the mount call makes the work directory read as an overlay. */
  overlayLands?: boolean;
  mountOverlayFails?: boolean;
  objects?: number;
  bytes?: number;
  state?: OverlayCasState | null;
  now?: number;
  intervalMs?: number;
  runs?: { readonly [K in OverlayCasOperation]?: RunnerRun };
  /** Which `writeState` calls reject, by 1-based order of arrival. A rejected
   *  write records the attempt and changes nothing durable. */
  rejectWrites?: readonly number[];
  /** Top-level entries a replaced container left in the BARE work directory:
   *  writes that landed while no overlay was mounted. */
  workdirResidue?: readonly string[];
} = {}): Harness {
  const calls: string[] = [];
  const logs: string[] = [];
  let mounted = overrides.mounted ?? false;
  let state = overrides.state ?? null;
  let writes = 0;
  let residue = [...overrides.workdirResidue ?? []];
  const upper: string[] = [];
  const ports: OverlayCasPorts = {
    containerRunning: () => overrides.running ?? true,
    mountStore: async () => {
      calls.push('mountStore');
    },
    unmountStore: async () => {
      calls.push('unmountStore');
    },
    mountOverlay: async () => {
      calls.push('mountOverlay');
      if (overrides.mountOverlayFails === true) {
        throw new Error(`fuse-overlayfs attach of ${DEVBOX_WORKDIR} failed: exit 1`);
      }
      if (overrides.overlayLands ?? true) mounted = true;
    },
    salvageWorkdirResidue: async () => {
      calls.push('salvageWorkdirResidue');
      upper.push(...residue);
      const moved = residue.length;
      residue = [];
      return moved;
    },
    unmountOverlay: async () => {
      calls.push('unmountOverlay');
      mounted = false;
    },
    overlayMounted: async () => {
      calls.push('overlayMounted');
      return mounted;
    },
    invokeRunner: async (operation) => {
      calls.push(`invokeRunner:${operation}`);
      const run = overrides.runs?.[operation] ?? {};
      return {
        stdout: run.stdout ?? receipt(operation),
        stderr: run.stderr ?? '',
        exitCode: run.exitCode ?? 0,
      };
    },
    // RECORDED, because its ABSENCE is the assertion. This is a LIST over the
    // whole prefix, so an attach that calls it carries a term that grows with
    // the tree, and no end-state check can see the difference.
    inventory: async () => {
      calls.push('inventory');
      return { objects: overrides.objects ?? 0, bytes: overrides.bytes ?? 0 };
    },
    clearPrefix: async () => {
      calls.push('clearPrefix');
      return overrides.objects ?? 0;
    },
    readState: async () => state,
    writeState: async (next) => {
      writes += 1;
      calls.push('writeState');
      if (overrides.rejectWrites?.includes(writes) === true) {
        throw new Error('durable storage unreachable');
      }
      state = next;
    },
    clearState: async () => {
      calls.push('clearState');
      state = null;
    },
    checkpointIntervalMs: () => overrides.intervalMs ?? INTERVAL_MS,
    now: () => overrides.now ?? 10_000_000,
    log: (message) => logs.push(message),
  };
  return { ports, calls, logs, stateNow: () => state, upperNow: () => [...upper] };
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

describe('the container layout this strategy asks the host for', () => {
  test('THE LOWER IS INSIDE THE STORE MOUNT, so a fold and the lower are one object', () => {
    // One mount, not two. The runner folds `tree/` through the read-write store
    // mount and the overlay serves its lower from the same path, so there is no
    // second mount whose cache could disagree with what the fold just wrote.
    expect(CAS_TREE_MOUNT.startsWith(`${CAS_STORE_MOUNT}/`)).toBe(true);
  });

  test('THE UPPER IS NOT INSIDE THE STORE MOUNT, because every write there would be an upload', () => {
    // The property the whole strategy rests on: the workload writes to a local
    // upper and a checkpoint decides what of it becomes an object. An upper
    // under the mount would upload every intermediate byte a build produces.
    expect(CAS_UPPER_DIR.startsWith(`${CAS_STORE_MOUNT}/`)).toBe(false);
    expect(CAS_UPPER_DIR.startsWith(`${DEVBOX_RUNTIME_DIR}/`)).toBe(true);
  });

  test('the runner is named by an absolute baked path', () => {
    expect(CAS_RUNNER_PATH.startsWith('/')).toBe(true);
  });
});

describe('attach — replay first, mount last, receipt believed only when it parses', () => {
  test('a fresh box attaches an empty overlay', async () => {
    const record = harness();
    const outcome = await attachOf(record);
    expect(outcome.kind).toBe('empty');
    expect(record.calls).toContain('invokeRunner:restore');
  });

  test('A STORE THAT HAS FOLDED IS NOT EMPTY, and the cursor is how attach knows', async () => {
    // The classification the prefix listing used to answer. A folded store has
    // a cursor past zero and may have nothing pending at all, so "no pending
    // entries" alone would call it fresh — and a box that reports `empty` for a
    // workspace holding a folded tree is a box a caller may re-seed over.
    const record = harness({ runs: { restore: { stdout: receipt('restore', { foldedSeq: 12 }) } } });
    const outcome = await attachOf(record);
    expect(outcome.kind).toBe('attached');
    expect(outcome.detail).toContain('folded 12');
  });

  test('the replayed pending count reaches the outcome', async () => {
    const record = harness({
      runs: { restore: { stdout: receipt('restore', { entries: 3 }) } },
    });
    const outcome = await attachOf(record);
    expect(outcome.kind).toBe('attached');
    expect(outcome.detail).toContain('3P');
  });

  test('A HUGE PREFIX COSTS NO PREFIX LISTING, which is the whole recovery claim', async () => {
    // THE TREE-SIZE TERM. `inventory()` is a LIST over every object this box
    // holds, and attach called it on both of its paths — once to describe an
    // already-mounted overlay, once to decide whether a fresh one was empty. So
    // the operation advertised as O(pending change) grew with every fold, and
    // the counters it produced were the only thing that read as suspicious. The
    // numbers below are what a mature box looks like; the assertion is that
    // attach never asks for them.
    const record = harness({ objects: 1_000_000, bytes: 9_000_000_000 });
    const outcome = await attachOf(record);
    expect(record.calls).not.toContain('inventory');
    // And the fixed control work is all of it: release the stale store mount,
    // mount the store, one runner invocation, mount the overlay, confirm.
    expect(record.calls).toEqual([
      'overlayMounted', 'unmountStore', 'mountStore', 'invokeRunner:restore',
      'salvageWorkdirResidue', 'mountOverlay', 'overlayMounted',
    ]);
    // A million objects and an empty journal is a FRESH classification now,
    // because the receipt says nothing was ever folded and nothing is pending.
    // Those objects cannot exist without a cursor, so this state is
    // unreachable in a real store — it is here to prove the prefix is not read.
    expect(outcome.kind).toBe('empty');
  });

  test('THE REPLAY LANDS BEFORE THE OVERLAY, so mounted implies replayed', async () => {
    // THE ORDERING INVARIANT, and it supersedes repairing the state on retry.
    // A replay is many operations, so one can fail partway. If the overlay were
    // mounted FIRST, that failure would leave a half-replayed upper under a live
    // overlay, and the next attach would see a mounted overlay and early-return
    // over it — a workspace silently missing changes the journal recorded.
    const record = harness({ objects: 1, bytes: 10 });
    await attachOf(record);
    const store = record.calls.indexOf('mountStore');
    const restore = record.calls.indexOf('invokeRunner:restore');
    const overlay = record.calls.indexOf('mountOverlay');
    expect(store).toBeGreaterThanOrEqual(0);
    expect(store).toBeLessThan(restore);
    expect(restore).toBeLessThan(overlay);
  });

  test('a stale store mount is released before this generation mounts its own', async () => {
    const record = harness();
    await attachOf(record);
    expect(record.calls.indexOf('unmountStore')).toBeLessThan(record.calls.indexOf('mountStore'));
  });

  test('an already-mounted work directory is neither remounted nor replayed again', async () => {
    // The other half of the ordering invariant. Once mounting implies replayed,
    // re-replaying on every attach would be work done to maintain a property
    // the order already guarantees.
    const record = harness({ mounted: true, objects: 2, bytes: 10 });
    const outcome = await attachOf(record);
    expect(outcome.kind).toBe('already-attached');
    expect(record.calls).not.toContain('invokeRunner:restore');
    expect(record.calls).not.toContain('mountOverlay');
    expect(record.calls).not.toContain('mountStore');
    // AND IT DOES NOT LIST THE PREFIX EITHER. This path holds no receipt, so
    // describing the store would mean paying for the listing — which is what it
    // used to do, making the cheapest attach carry the tree-size term twice over
    // a container's life.
    expect(record.calls).not.toContain('inventory');
    expect(outcome.detail).toBe('overlay-cas overlay already mounted');
  });

  test('a second attach on the same container replays exactly once', async () => {
    const record = harness({ objects: 1, bytes: 10 });
    await attachOf(record);
    const again = await attachOf(record);
    expect(again.kind).toBe('already-attached');
    expect(record.calls.filter(call => call === 'invokeRunner:restore')).toHaveLength(1);
  });

  test('a mount call that returned success but did not land fails the attach', async () => {
    const record = harness({ overlayLands: false });
    await expect(overlayCasStorage(record.ports).attach())
      .rejects.toThrow(/is not an overlay mount/);
  });

  test('a refused overlay mount fails the start rather than degrading', async () => {
    const record = harness({ mountOverlayFails: true });
    await expect(overlayCasStorage(record.ports).attach())
      .rejects.toThrow(/fuse-overlayfs attach/);
  });

  test('A RESTORE WHOSE RECEIPT DOES NOT PARSE NEVER REACHES THE MOUNT', async () => {
    // An unparseable receipt is not evidence that the replay finished, and the
    // ordering invariant is exactly the claim that a mounted overlay carries
    // that evidence. So the mount must not happen.
    const record = harness({ runs: { restore: { stdout: 'Killed\n' } } });
    await expect(overlayCasStorage(record.ports).attach())
      .rejects.toThrow(/produced no receipt/);
    expect(record.calls).not.toContain('mountOverlay');
  });

  test('A RESTORE THAT DIED NEVER REACHES THE MOUNT, so mounted implies restore-done', async () => {
    // THE CRASH-PREFIX GUARD, stated as its own claim rather than inferred from
    // the ordering test above. A killed runner is the ordinary failure on a spot
    // container, and its exit code is the only evidence the adapter gets. If the
    // mount happened anyway, the next attach would see a mounted overlay, take
    // the already-attached path and report success over a half-replayed upper —
    // and because that path deliberately runs no runner, nothing downstream
    // would ever discover the missing changes.
    const record = harness({
      runs: { restore: { stdout: '', stderr: 'Killed', exitCode: 137 } },
    });
    await expect(overlayCasStorage(record.ports).attach()).rejects.toThrow(/exit 137/);
    expect(record.calls).not.toContain('mountOverlay');
    // The store mount is what the runner needed, and it was taken before the
    // runner ran; the OVERLAY is what publishes the workspace, and it was not.
    expect(record.calls).toContain('mountStore');
  });
});

describe('the receipt is untrusted input, because it crossed a process boundary', () => {
  test('a nonzero exit fails carrying the runner’s own words', async () => {
    const record = harness({
      mounted: true, runs: { checkpoint: { exitCode: 2, stderr: 'store mount is gone' } },
    });
    const outcome = await checkpointOf(record, 'tick');
    expect(outcome.kind).toBe('failed');
    expect(outcome.reason).toContain('store mount is gone');
    expect(outcome.reason).toContain('exit 2');
  });

  test('stdout that is not JSON refuses instead of reading as nothing changed', async () => {
    const record = harness({ mounted: true, runs: { checkpoint: { stdout: '{"entries": ' } } });
    const outcome = await checkpointOf(record, 'tick');
    expect(outcome.kind).toBe('failed');
    expect(outcome.reason).toMatch(/is not JSON/);
  });

  test('A RECEIPT MISSING A COUNTER REFUSES, never defaulting the number to zero', async () => {
    const record = harness({
      mounted: true,
      runs: {
        checkpoint: {
          stdout: '{"operation":"checkpoint","entries":1,"movedBytes":4,"foldedEntries":0,'
            + '"sweptBlobs":0}\n',
        },
      },
    });
    const outcome = await checkpointOf(record, 'tick');
    expect(outcome.kind).toBe('failed');
    expect(outcome.reason).toMatch(/does not match its schema/);
  });

  test('a receipt carrying an unknown field refuses, because that runner is not this release', async () => {
    const record = harness({
      mounted: true,
      runs: {
        checkpoint: {
          stdout: `${JSON.stringify({
            operation: 'checkpoint', entries: 1, movedBytes: 4, foldedEntries: 0, sweptBlobs: 0,
            foldedSeq: 0, uploadedLayers: 3,
          })}\n`,
        },
      },
    });
    const outcome = await checkpointOf(record, 'tick');
    expect(outcome.kind).toBe('failed');
    expect(outcome.reason).toMatch(/does not match its schema/);
  });

  test('THE PREVIOUS RELEASE’S RECEIPT REFUSES, rather than reading `stagedBytes` as moved', async () => {
    // The rename is a wire change, and the two fields do not mean the same
    // thing: `stagedBytes` was the logical size of the journalled files, while
    // `movedBytes` is the bytes the run wrote. A runner bundle left behind by an
    // older image would report the first under the second's name, and a caller
    // measuring cost per checkpoint would silently compare two quantities. It
    // also cannot report `foldedSeq`, which is what attach now classifies on, so
    // accepting it would mean calling a folded store fresh.
    const record = harness({
      mounted: true,
      runs: {
        checkpoint: {
          stdout: `${JSON.stringify({
            operation: 'checkpoint', entries: 1, stagedBytes: 4, foldedEntries: 0, sweptBlobs: 0,
          })}\n`,
        },
      },
    });
    const outcome = await checkpointOf(record, 'tick');
    expect(outcome.kind).toBe('failed');
    expect(outcome.reason).toMatch(/does not match its schema/);
  });

  test('a negative or fractional counter refuses', async () => {
    const record = harness({
      mounted: true, runs: { checkpoint: { stdout: receipt('checkpoint', { movedBytes: -1 }) } },
    });
    expect((await checkpointOf(record, 'tick')).kind).toBe('failed');
    const fractional = harness({
      mounted: true, runs: { checkpoint: { stdout: receipt('checkpoint', { entries: 1.5 }) } },
    });
    expect((await checkpointOf(fractional, 'tick')).kind).toBe('failed');
  });

  test('A RECEIPT FOR ANOTHER OPERATION IS NOT EVIDENCE ABOUT THIS ONE', async () => {
    // A restore receipt reports no staged entries. Accepting one for a
    // checkpoint would report "unchanged" for a scan that never ran.
    const record = harness({
      mounted: true, runs: { checkpoint: { stdout: receipt('restore', { entries: 0 }) } },
    });
    const outcome = await checkpointOf(record, 'tick');
    expect(outcome.kind).toBe('failed');
    expect(outcome.reason).toMatch(/not evidence/);
  });

  test('container noise ahead of the receipt is not a malformed receipt', async () => {
    const record = harness({
      mounted: true,
      objects: 1,
      bytes: 40,
      runs: {
        checkpoint: {
          stdout: `warning: fuse: mount options ignored\n${receipt('checkpoint', { entries: 2, movedBytes: 9 })}`,
        },
      },
    });
    const outcome = await checkpointOf(record, 'tick');
    expect(outcome.kind).toBe('committed');
    expect(outcome.movedBytes).toBe(9);
  });
});

// ── bytes written with no overlay mounted ───────────────────────────────────

describe('a work directory written to with nothing mounted', () => {
  test('reaches the upper, where the next checkpoint journals it', async () => {
    // MEASURED, TWICE. The deployed `overlay-cas` arm of runs 20260831031426
    // and 20260831143544 answered `wake restored empty, expected attached` for a
    // box that had been written to all through its checkpoint ladder. A
    // container replaced under an attached box has no overlay, so those writes
    // landed in the bare work directory — and the attach that followed laid the
    // overlay straight OVER them. They were still on the disk, invisible under
    // the mount, so the upper this strategy scans was empty, no journal entry
    // was ever written, the fold had nothing to fold, and the cursor stayed at
    // zero. The bytes were not lost by a store failure; they were hidden by a
    // mount.
    const record = harness({ workdirResidue: ['ladder', '.devbox-verify-marker.txt'] });

    const outcome = await attachOf(record);

    expect(outcome.kind).toBe('empty');
    expect(record.upperNow()).toEqual(['ladder', '.devbox-verify-marker.txt']);
    expect(record.logs.join(' ')).toContain('moved into the upper');
  });

  test('is salvaged AFTER the replay and BEFORE the mount, so the newer bytes win', async () => {
    // Order is the whole correctness. The replay writes the upper from the
    // journal; the residue was written after that journal batch, so it is the
    // newer of the two and must land on top — and both must be in place before
    // the overlay takes the upper as a parameter.
    const record = harness({ workdirResidue: ['notes.txt'] });

    await attachOf(record);

    const replay = record.calls.indexOf('invokeRunner:restore');
    const salvage = record.calls.indexOf('salvageWorkdirResidue');
    const mount = record.calls.indexOf('mountOverlay');
    expect(replay).toBeGreaterThanOrEqual(0);
    expect(salvage).toBeGreaterThan(replay);
    expect(mount).toBeGreaterThan(salvage);
  });

  test('an already-attached box salvages nothing: its work directory IS the mount', async () => {
    const record = harness({ mounted: true, workdirResidue: ['notes.txt'] });
    expect((await attachOf(record)).kind).toBe('already-attached');
    expect(record.calls).not.toContain('salvageWorkdirResidue');
  });
});

describe('checkpoint — gated on a real overlay, one invocation, receipt believed', () => {
  test('a stopped container is skipped, not woken', async () => {
    const record = harness({ running: false, mounted: true });
    const outcome = await checkpointOf(record, 'tick');
    expect(outcome.kind).toBe('skipped');
    expect(outcome.reason).toBe('container is not running');
    expect(record.calls).not.toContain('invokeRunner:checkpoint');
  });

  test('a tick against an unattached directory FAILS AND RECORDS THE REASON', async () => {
    // Through recordFailure like every other refusal, so the reason reaches
    // durable state. A repeatedly unattached box is exactly the one whose
    // failures have to stay visible after the object is evicted.
    const record = harness({
      mounted: false, state: { lastCheckpointAt: 5, lastFailure: undefined },
    });
    const outcome = await checkpointOf(record, 'tick');
    expect(outcome.kind).toBe('failed');
    expect(outcome.reason).toMatch(/not an overlay mount/);
    expect(record.stateNow()?.lastFailure?.reason).toMatch(/not an overlay mount/);
    expect(record.calls).not.toContain('invokeRunner:checkpoint');
  });

  test('a refusal the stamp cannot record still answers `failed` with its own reason',
    async () => {
      // The stamp is a durable write, so the storage that refuses it is the
      // storage a refusal has to survive. Letting its rejection travel turned
      // the one answer a scheduled callback can act on into a throw, and the
      // throw named the STORAGE failure rather than the refusal.
      const record = harness({
        mounted: false,
        state: { lastCheckpointAt: 5, lastFailure: undefined },
        rejectWrites: [1],
      });
      const outcome = await checkpointOf(record, 'tick');

      expect(outcome.kind).toBe('failed');
      expect(outcome.reason).toMatch(/not an overlay mount/);
      // The row is untouched, and the diagnostic says both what failed and that
      // it never reached the record.
      expect(record.stateNow()).toEqual({ lastCheckpointAt: 5, lastFailure: undefined });
      expect(record.logs.some(line => /checkpoint failed:.*not an overlay mount/.test(line)))
        .toBe(true);
      expect(record.logs).toContain(
        `${DEVBOX_WORKDIR} that failure could not be stamped on the durable record`,
      );
    });

  test('A TICK INSIDE THE INTERVAL NEVER INVOKES THE RUNNER', async () => {
    // The scan and the byte work are one invocation now, so asking whether
    // anything changed IS the tick. A gate applied after the call would pay the
    // whole cost to report a skip.
    const record = harness({
      mounted: true,
      state: { lastCheckpointAt: 9_900_000, lastFailure: undefined },
      now: 9_900_001,
      intervalMs: INTERVAL_MS,
    });
    const outcome = await checkpointOf(record, 'tick');
    expect(outcome.kind).toBe('skipped');
    expect(outcome.reason).toBe('within the minimum checkpoint interval');
    expect(record.calls).not.toContain('invokeRunner:checkpoint');
  });

  test('a tick asks for a checkpoint; a quiesce asks for a fold', async () => {
    const tick = harness({ mounted: true, objects: 1, bytes: 5 });
    await checkpointOf(tick, 'tick');
    expect(tick.calls).toContain('invokeRunner:checkpoint');

    const quiesce = harness({ mounted: true, objects: 1, bytes: 5 });
    await checkpointOf(quiesce, 'quiesce');
    expect(quiesce.calls).toContain('invokeRunner:fold');
    expect(quiesce.calls).not.toContain('invokeRunner:checkpoint');
  });

  test('an unchanged tick is skipped WITHOUT advancing the interval clock', async () => {
    // Advancing the clock on a no-op would delay the next real change by a
    // whole interval, which is the change signal being thrown away.
    const record = harness({
      mounted: true, objects: 3, bytes: 90,
      state: { lastCheckpointAt: 5, lastFailure: undefined },
    });
    const outcome = await checkpointOf(record, 'tick');
    expect(outcome.kind).toBe('skipped');
    expect(outcome.reason).toBe('work directory is unchanged');
    expect(outcome.movedBytes).toBe(0);
    expect(record.calls).not.toContain('writeState');
    expect(record.stateNow()?.lastCheckpointAt).toBe(5);
  });

  test('A TICK THAT JOURNALLED NOTHING BUT WROTE BYTES IS NOT A SKIP', async () => {
    // THE RESIDUAL CASE, and the reason the skip is gated on two facts rather
    // than one. A redrive whose journal batch already landed re-measures the
    // upper, finds the pending journal already holds every path, and journals
    // nothing — but it refreshes the scan cache so the next tick does not
    // re-digest the whole workspace. So `entries === 0` and bytes moved.
    //
    // A skip would deny those bytes twice over: CheckpointOutcome says a skip
    // KNOWS it moved nothing, and the verdict2 rule says never report
    // nothing-happened after durable state has changed. Testing only
    // entries>0/moved>0 and entries=0/moved=0 would leave the second half of
    // that gate free to be deleted.
    const record = harness({
      mounted: true, objects: 4, bytes: 512, now: 22_000_000,
      state: { lastCheckpointAt: 5, lastFailure: undefined },
      runs: { checkpoint: { stdout: receipt('checkpoint', { entries: 0, movedBytes: 4_096 }) } },
    });
    const outcome = await checkpointOf(record, 'tick');
    expect(outcome.kind).toBe('committed');
    expect(outcome.movedBytes).toBe(4_096);
    expect(record.stateNow()?.lastCheckpointAt).toBe(22_000_000);
  });

  test('an empty prefix says so, rather than calling an untouched box unchanged', async () => {
    const record = harness({ mounted: true, objects: 0, bytes: 0 });
    const outcome = await checkpointOf(record, 'tick');
    expect(outcome.kind).toBe('skipped');
    expect(outcome.reason).toMatch(/holds no objects yet/);
  });

  test('a tick that moved bytes is committed and reports what the runner wrote', async () => {
    const record = harness({
      mounted: true, objects: 6, bytes: 4_096, now: 12_345_000,
      runs: { checkpoint: { stdout: receipt('checkpoint', { entries: 7, movedBytes: 2_048 }) } },
    });
    const outcome = await checkpointOf(record, 'tick');
    expect(outcome.kind).toBe('committed');
    expect(outcome.movedBytes).toBe(2_048);
    expect(outcome.bytes).toBe(4_096);
    expect(record.stateNow()?.lastCheckpointAt).toBe(12_345_000);
  });

  test('A DEDUPLICATED TICK COMMITS WHILE MOVING ONLY ITS METADATA', async () => {
    // Content-hash dedup means a pure rename journals entries and uploads no
    // content. `movedBytes` is the runner's own `bytesPut` delta, so what it
    // reports here is the journal batch and the scan cache and NOTHING for the
    // reused blobs — the property the header advertises, visible in the outcome
    // without claiming the metadata objects were free.
    const record = harness({
      mounted: true, objects: 3, bytes: 1_000,
      runs: { checkpoint: { stdout: receipt('checkpoint', { entries: 2, movedBytes: 190 }) } },
    });
    const outcome = await checkpointOf(record, 'tick');
    expect(outcome.kind).toBe('committed');
    expect(outcome.movedBytes).toBe(190);
  });

  test('A QUIESCE NEVER REPORTS SKIPPED AFTER IT HAS FOLDED', async () => {
    // THE VERDICT2 DATA LOSS. verify wrote a marker, called checkpointNow
    // ('quiesce') and got back `skipped 0B /workspace holds no objects yet`.
    // The box then stopped and the marker was MISSING after the recycle. A
    // quiesce folded, advanced the cursor and reaped, so reporting nothing
    // happened is a claim about durable state that had already changed.
    const record = harness({
      mounted: true, objects: 0, bytes: 0,
      runs: { fold: { stdout: receipt('fold', { entries: 0, foldedEntries: 5, sweptBlobs: 2 }) } },
    });
    const outcome = await checkpointOf(record, 'quiesce');
    expect(outcome.kind).toBe('committed');
    expect(record.calls).toContain('writeState');
  });

  test('a commit clears the failure the previous attempt recorded', async () => {
    const record = harness({
      mounted: true, objects: 2, bytes: 64,
      state: { lastCheckpointAt: 4, lastFailure: { at: 4, reason: 'the runner was killed' } },
      runs: { checkpoint: { stdout: receipt('checkpoint', { entries: 1, movedBytes: 12 }) } },
    });
    expect((await checkpointOf(record, 'tick')).kind).toBe('committed');
    expect(record.stateNow()?.lastFailure).toBeUndefined();
  });

  test('a cursor that cannot be written leaves the commit committed', async () => {
    // THE RECEIPT IS THE COMMIT here: the runner has folded, advanced its own
    // cursor and reaped before this row is touched, and the row names no
    // object. So a storage failure on it costs one early re-check and a stale
    // refusal — never the commit. Throwing denied bytes that are durable, which
    // is the shape that lost a folded marker on a live box.
    const record = harness({
      mounted: true, objects: 2, bytes: 64,
      state: { lastCheckpointAt: 4, lastFailure: { at: 4, reason: 'the runner was killed' } },
      runs: { checkpoint: { stdout: receipt('checkpoint', { entries: 1, movedBytes: 12 }) } },
      rejectWrites: [1],
    });
    const outcome = await checkpointOf(record, 'tick');

    expect(outcome.kind).toBe('committed');
    expect(outcome.bytes).toBe(64);
    expect(outcome.movedBytes).toBe(12);
    // Unadvanced and uncleared, which is the whole cost.
    expect(record.stateNow()).toEqual({
      lastCheckpointAt: 4, lastFailure: { at: 4, reason: 'the runner was killed' },
    });
    expect(record.logs.some(line => line.includes('checkpoint committed (overlay-cas'))).toBe(true);
    expect(record.logs.some(line => line.includes('cursor could not be written'))).toBe(true);
  });

  test('a FAILED checkpoint answers undefined bytes, because it cannot know', async () => {
    // A run that failed mid-flight may have landed blobs and a journal batch
    // before it died. Reporting 0 would assert nothing moved, which is a
    // stronger claim than this path can make.
    const record = harness({
      mounted: true, runs: { checkpoint: { exitCode: 137, stderr: 'Killed' } },
    });
    const outcome = await checkpointOf(record, 'tick');
    expect(outcome.kind).toBe('failed');
    expect(outcome.bytes).toBeUndefined();
    expect(outcome.movedBytes).toBeUndefined();
  });

  test('A REDRIVE AFTER A FAILURE RUNS AGAIN AND COMMITS, so nothing is stuck failed', async () => {
    // Idempotence at the entry point that matters: the runner is a fresh
    // process holding no cache, so a retry re-scans and re-journals whatever
    // the failed attempt left unjournalled.
    let attempt = 0;
    const base = harness({
      mounted: true, objects: 2, bytes: 64,
      state: { lastCheckpointAt: 4, lastFailure: undefined },
    });
    const ports: OverlayCasPorts = {
      ...base.ports,
      invokeRunner: async (operation) => {
        attempt += 1;
        base.calls.push(`invokeRunner:${operation}`);
        return attempt === 1
          ? { stdout: '', stderr: 'transport closed', exitCode: 1 }
          : { stdout: receipt(operation, { entries: 3, movedBytes: 30 }), stderr: '', exitCode: 0 };
      },
    };
    const storage = overlayCasStorage(ports);
    const first = await storage.checkpoint('tick');
    seenCheckpoint.add(first.kind);
    expect(first.kind).toBe('failed');

    const second = await storage.checkpoint('tick');
    seenCheckpoint.add(second.kind);
    expect(second.kind).toBe('committed');
    expect(second.movedBytes).toBe(30);
    expect(base.calls.filter(call => call === 'invokeRunner:checkpoint')).toHaveLength(2);
  });
});

describe('detach and discard — the mount, then the bytes, then the pointer', () => {
  test('the overlay is released before the store it reads from', async () => {
    const record = harness({ mounted: true });
    await overlayCasStorage(record.ports).detach?.();
    expect(record.calls.indexOf('unmountOverlay'))
      .toBeLessThan(record.calls.indexOf('unmountStore'));
  });

  test('an unattached container still releases the store mount', async () => {
    const record = harness({ mounted: false });
    await overlayCasStorage(record.ports).detach?.();
    expect(record.calls).not.toContain('unmountOverlay');
    expect(record.calls).toContain('unmountStore');
  });

  test('a stopped container is left alone, because there is nothing to release', async () => {
    const record = harness({ running: false, mounted: true });
    await overlayCasStorage(record.ports).detach?.();
    expect(record.calls).toEqual([]);
  });

  test('a live overlay is released before the prefix is deleted, and the pointer goes last', async () => {
    const record = harness({ mounted: true, objects: 5 });
    await overlayCasStorage(record.ports).discard();
    expect(record.calls.indexOf('unmountOverlay')).toBeLessThan(record.calls.indexOf('clearPrefix'));
    expect(record.calls.indexOf('clearPrefix')).toBeLessThan(record.calls.indexOf('clearState'));
    expect(record.stateNow()).toBeNull();
  });

  test('a SECOND discard is harmless, because a box can be deleted twice', async () => {
    // attach and checkpoint are both idempotent by design and tested for it;
    // a delete path that throws the second time turns a retried teardown into
    // an incident about a box that is already gone.
    const record = harness({ mounted: true, objects: 3 });
    const storage = overlayCasStorage(record.ports);
    await storage.discard();
    await storage.discard();
    expect(record.calls.filter(call => call === 'clearPrefix')).toHaveLength(2);
  });

  test('a stopped box still deletes the prefix and the pointer', async () => {
    const record = harness({ running: false, mounted: false, objects: 3 });
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
  test('rejects every noncanonical stored path before anything is asked to materialize it', async () => {
    const paths = [
      '', '/absolute', '.', '..', 'a//b', 'a/./b', 'a/../b', 'trailing/',
      `nul\0path`, 'x'.repeat(4_096), `dir/${'x'.repeat(256)}`,
    ];
    for (const path of paths) {
      const store = new MemoryStore();
      await store.put(journalKey(1), new TextEncoder().encode(`${JSON.stringify({
        version: CAS_FORMAT_VERSION,
        entries: [{
          kind: 'file', seq: 1, path, mode: 0o644, mtimeMs: 0,
          size: 0, hash: sha256Hex(new Uint8Array()), parts: [],
        }],
      })}\n`));
      // The refusal is in the READER, so it holds for every consumer of a
      // stored batch — the fold, the replay and the sweep alike — rather than
      // for whichever caller remembered to check.
      await expect(listJournalAfter(store, 0)).rejects.toThrow(/does not match its schema/);
      await expect(replayPending(store)).rejects.toThrow(/does not match its schema/);
    }
  });

  test('a journal batch that is valid JSON but the wrong shape refuses, naming the key', async () => {
    const store = new MemoryStore();
    await store.put(journalKey(1), new TextEncoder().encode('{"notABatch":true}\n'));
    await expect(listJournalAfter(store, 0)).rejects.toThrow(/journal\/000000000001\.json/);
  });

  test('refuses an unversioned journal batch instead of guessing its old entry format', async () => {
    const store = new MemoryStore();
    await store.put(journalKey(1), new TextEncoder().encode('[]\n'));
    await expect(listJournalAfter(store, 0)).rejects.toThrow(/does not match its schema/);
  });

  test('a journal entry whose hash is truncated refuses rather than naming a short blob', async () => {
    const store = new MemoryStore();
    const bad = {
      version: CAS_FORMAT_VERSION,
      entries: [{
        kind: 'file', seq: 1, path: 'a.txt', mode: 420, mtimeMs: 0,
        size: 4, hash: 'abc', parts: [{ kind: 'data', hash: 'abc', size: 4 }],
      }],
    };
    await store.put(journalKey(1), new TextEncoder().encode(`${JSON.stringify(bad)}\n`));
    await expect(listJournalAfter(store, 0)).rejects.toThrow(/does not match its schema/);
  });

  test('a chunk of ZERO bytes refuses, because it would name a blob holding nothing', async () => {
    const store = new MemoryStore();
    const bad = {
      version: CAS_FORMAT_VERSION,
      entries: [{
        kind: 'file', seq: 1, path: 'a.txt', mode: 420, mtimeMs: 0,
        size: 4, hash: 'a'.repeat(64), parts: [{ kind: 'data', hash: 'a'.repeat(64), size: 0 }],
      }],
    };
    await store.put(journalKey(1), new TextEncoder().encode(`${JSON.stringify(bad)}\n`));
    await expect(listJournalAfter(store, 0)).rejects.toThrow(/does not match its schema/);
  });

  test('a zero-byte FILE is accepted, because an empty file is ordinary', async () => {
    // The bound that deliberately differs from the chunk above. Same field
    // name, different referent: a file may be empty, a chunk may not.
    const store = new MemoryStore();
    const empty = {
      version: CAS_FORMAT_VERSION,
      entries: [{
        kind: 'file', seq: 1, path: 'empty.txt', mode: 420, mtimeMs: 0,
        size: 0, hash: 'a'.repeat(64), parts: [],
      }],
    };
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

});
