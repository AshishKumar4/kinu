import { describe, expect, test } from 'bun:test';

import { sha256Hex } from '../src/cas/hash';
import type { Capture, FileContent, LogEntry, NodeEntry } from '../src/capture/model';
import { AuditedCapture, expandContent, issueVerifiedJournalCapture, manifestSha256, prefixState, toCapturedCut } from '../src/capture/model';
import type {
  ImmutableObjectRef,
  ObjectReceipt,
  OperationRecord,
  PayloadGrant,
  RangeReadIntent,
  RootEnvelopeV1,
  UploadIntent,
} from '../src/durability/contracts';
import { DURABLE_ROOT_FORMATS } from '../src/durability/contracts';
import {
  MemoryCandidateObjectSink,
  StaleParentRefused,
  envelopeIdOf,
  finalizeCandidatePayload,
  publishedParentOf,
  readStagedCandidateObjectForTest,
  stageCandidatePayload,
} from '../src/candidates/publication';
import type {
  CandidatePayloadStore,
  CandidatePublicationControl,
} from '../src/candidates/publication';
import {
  MERKLE_PACK_FORMAT,
  MerklePackError,
  buildMerklePack as buildRaw,
  openMerklePack,
  parentFromPublishedParent,
} from '../src/candidates/merkle-pack';
import type {
  BuildOptions,
  MerklePackBuild,
  MerklePackReader,
  MerklePackRoot,
  MerklePackView,
  PublishedMerkleParent,
} from '../src/candidates/merkle-pack';
import { hashNodeBytes, serializeNode } from '../src/candidates/merkle-pack/wire';
import { readBarrier } from './support/read-barrier';
import type { ReadBarrier } from './support/read-barrier';

// ── fixtures ──────────────────────────────────────────────────────────────────

let inoSeq = 100;

function file(path: string, content: FileContent, mode = 0o644, ino = ++inoSeq): NodeEntry {
  return { path, kind: 'file', mode, ino, content };
}

function dir(path: string, mode = 0o755, ino = ++inoSeq): NodeEntry {
  return { path, kind: 'dir', mode, ino };
}

function sym(path: string, target: string, mode = 0o777, ino = ++inoSeq): NodeEntry {
  return { path, kind: 'symlink', mode, ino, target };
}

function dense(bytes: Uint8Array): FileContent {
  return { kind: 'dense', bytes };
}

/** Deterministic pseudo-random bytes; a fixed seed keeps every test reproducible. */
function prng(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let s = seed | 0;
  for (let i = 0; i < length; i++) {
    s ^= s << 13; s |= 0;
    s ^= s >>> 17;
    s ^= s << 5; s |= 0;
    out[i] = s & 0xff;
  }
  return out;
}

/** Build every codec fixture through the real audit factory. Padding preserves
 * the cut values used by parent-advance cases without forging a capture. */
const CAPTURE_IDENTITY = Object.freeze({
  captureId: 'cap-merkle',
  epoch: '7',
  baseRevision: '0',
  stableStageHandle: 'stage-merkle',
});

function audited(entries: readonly NodeEntry[], cut = '4096'): AuditedCapture {
  const ordered = [...entries].sort((a, b) => {
    const depth = (path: string): number => path.split('/').length;
    return depth(a.path) - depth(b.path) || a.path.localeCompare(b.path);
  });
  const owners = new Map<number, string>();
  const operations: LogEntry['op'][] = [];
  for (const entry of ordered) {
    if (entry.kind === 'dir') {
      operations.push({ op: 'mkdir', path: entry.path, mode: entry.mode });
    } else if (entry.kind === 'symlink') {
      operations.push({ op: 'symlink', path: entry.path, target: entry.target! });
    } else {
      const owner = owners.get(entry.ino);
      if (owner === undefined) {
        owners.set(entry.ino, entry.path);
        operations.push({ op: 'write', path: entry.path, content: entry.content!, mode: entry.mode });
      } else {
        operations.push({ op: 'link', existingPath: owner, newPath: entry.path });
      }
    }
  }
  const targetCut = Number(cut);
  if (!Number.isSafeInteger(targetCut) || targetCut < operations.length - 1) {
    throw new Error(`fixture cut ${cut} cannot contain ${operations.length} mutations`);
  }
  const filler = targetCut + 1 - operations.length;
  const log: LogEntry[] = [
    ...Array.from({ length: filler }, (_, seq) => ({ seq, op: { op: 'replace-generation' } as const })),
    ...operations.map((op, index) => ({ seq: filler + index, op })),
  ];
  const capture: Capture = {
    mechanism: 'mutation-journal',
    cut: targetCut,
    generation: filler,
    entries: [...prefixState(log, targetCut).values()],
  };
  return toCapturedCut(log, capture, CAPTURE_IDENTITY);
}

function withJournalMetadata(entries: readonly NodeEntry[]): readonly NodeEntry[] {
  return entries.map((entry) => entry.metadata === undefined
    ? { ...entry, metadata: { uid: 1000, gid: 1000, atimeNs: '1', mtimeNs: '2', ctimeNs: '3', xattrs: {} } }
    : entry);
}

function sealedAudited(entries: readonly NodeEntry[], sources: ReadonlyMap<string, Uint8Array>, cut = '4096'): AuditedCapture {
  const journalEntries = withJournalMetadata(entries);
  const cutNumber = Number(cut);
  const capture: Capture = {
    mechanism: 'mutation-journal',
    cut: cutNumber,
    generation: 0,
    entries: journalEntries,
  };
  return issueVerifiedJournalCapture({
    cut: cutNumber,
    generation: 0,
    entries: journalEntries,
    identity: CAPTURE_IDENTITY,
    manifestSha256: manifestSha256(capture),
    sealedReader: {
      async read(sourceId, offset, length): Promise<Uint8Array> {
        const bytes = sources.get(sourceId);
        if (bytes === undefined) throw new Error(`missing sealed source ${sourceId}`);
        return bytes.slice(offset, offset + length);
      },
    },
  });
}

/** Test-only staging: production builders receive a file-backed sink. */
async function buildMerklePack(
  capture: AuditedCapture,
  options: Omit<BuildOptions, 'sink'> = {},
): Promise<MerklePackBuild> {
  return buildRaw(capture, { ...options, sink: new MemoryCandidateObjectSink() });
}

const RANGE_IDENTITY = {
  operationId: 'op-read-1',
  attemptId: 'try-read-1',
  boxId: 'box-merkle',
  epoch: '7',
  expiresAt: '99999999999999',
};

/** An object reader over in-memory bytes that counts what a read actually
 *  fetched and records every validated intent it served. */
class MemStore implements MerklePackReader {
  readonly objects = new Map<string, Uint8Array>();
  fetchedBytes = 0;
  rangeReads = 0;
  /** When set, every returned range flips its last bit — bit rot anywhere in the fetched span. */
  corruptRanges = false;
  readonly intents: RangeReadIntent[] = [];


  async readRange(intent: RangeReadIntent): Promise<Uint8Array> {
    this.intents.push(intent);
    const bytes = this.objects.get(intent.exactKey);
    if (bytes === undefined) throw new Error(`missing object: ${intent.exactKey}`);
    const offset = Number(intent.byteOffset);
    const length = Number(intent.byteLength);
    if (offset < 0 || offset + length > bytes.byteLength) {
      throw new Error(`range out of bounds: ${intent.exactKey}`);
    }
    this.rangeReads += 1;
    this.fetchedBytes += length;
    const slice = bytes.slice(offset, offset + length);
    if (this.corruptRanges) slice[slice.byteLength - 1] ^= 0xff;
    return slice;
  }

  tamper(key: string): void {
    const bytes = this.objects.get(key);
    if (bytes === undefined) throw new Error(`missing object: ${key}`);
    const copy = bytes.slice();
    copy[Math.floor(copy.byteLength / 2)] ^= 0xff;
    this.objects.set(key, copy);
  }

  async restore(build: MerklePackBuild): Promise<void> {
    for (const object of build.staged) {
      this.objects.set(object.ref.key, await readStagedCandidateObjectForTest(object));
    }
  }
}

async function publish(build: MerklePackBuild, store: MemStore): Promise<MerklePackView> {
  await store.restore(build);
  return openMerklePack(build.root, store, RANGE_IDENTITY);
}

let parentSequence = 0;
async function publishedParent(build: MerklePackBuild, view: MerklePackView) {
  const sequence = parentSequence++;
  const published = await finalizePlan(build.plan, {
    operationId: `parent-op-${sequence}`,
    attemptId: `parent-try-${sequence}`,
    boxId: 'box-merkle',
    bootId: 'parent-boot',
    expiresAt: '99999999999999',
  }, new FakePublicationStore());
  return parentFromPublishedParent(view, publishedParentOf(published));
}

async function expectRejects(promise: Promise<unknown>, reason: MerklePackError['reason']): Promise<void> {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof MerklePackError)) {
      throw new Error(`expected a MerklePackError, got ${String(error)}`, { cause: error });
    }
    expect(error.reason).toBe(reason);
    return;
  }
  throw new Error(`expected a MerklePackError with reason ${reason}, got a resolution`);
}

// ── acceptance ────────────────────────────────────────────────────────────────

describe('merkle-pack/v1', () => {
  test('the format name is the one the durability contracts reserve', () => {
    // Agreement between the two declarations, not a restated literal: the
    // wire constant and the contract registry must name the same format, and
    // either side renaming alone fails here.
    expect(DURABLE_ROOT_FORMATS).toContain(MERKLE_PACK_FORMAT);
  });

  test('the root is identical under any input order permutation', async () => {
    const entries = [
      dir('docs'),
      file('docs/spec.txt', dense(prng(50_000, 1))),
      file('a.txt', dense(prng(70_000, 2))),
      sym('docs/latest', '../a.txt'),
    ];
    const forward = await buildMerklePack(audited(entries));
    const backward = await buildMerklePack(audited([...entries].reverse()));

    expect(backward.root.rootId).toBe(forward.root.rootId);
    expect(backward.movedBytes).toBe(forward.movedBytes);
    expect(backward.staged.map((object) => object.ref.key).sort())
      .toEqual(forward.staged.map((object) => object.ref.key).sort());
    for (const object of forward.staged) {
      const peer = backward.staged.find((candidate) => candidate.ref.key === object.ref.key);
      expect(peer?.ref).toEqual(object.ref);
      expect(await readStagedCandidateObjectForTest(peer!))
        .toEqual(await readStagedCandidateObjectForTest(object));
    }

    const store = new MemStore();
    const view = await publish(forward, store);
    expect(view.capturedCut).toMatchObject({ ...CAPTURE_IDENTITY, cut: '4096' });
    expect(await view.stat('docs/latest')).toMatchObject({ kind: 'symlink', target: '../a.txt' });
  });

  test('a one-byte insertion reuses most chunks and moves few bytes', async () => {
    const base = prng(96 * 1024, 3);
    const sharedIno = ++inoSeq;
    const first = await buildMerklePack(audited([file('data.bin', dense(base), 0o644, sharedIno)]));
    expect(first.plan.expectedParentRootId).toBeNull();

    const store = new MemStore();
    const v1 = await publish(first, store);

    const offset = 48 * 1024;
    const inserted = new Uint8Array(base.byteLength + 1);
    inserted.set(base.subarray(0, offset), 0);
    inserted[offset] = 0x5a;
    inserted.set(base.subarray(offset), offset + 1);

    const parent = await publishedParent(first, v1);
    const second = await buildMerklePack(audited([file('data.bin', dense(inserted), 0o644, sharedIno)], '4097'), {
      parent,
    });

    expect(second.plan.expectedParentRootId).toBe(parent.headRootId);
    expect(second.root.rootId).not.toBe(first.root.rootId);
    expect(second.stats.chunkInstances).toBeGreaterThan(12);
    expect(second.stats.chunkInstancesReused / second.stats.chunkInstances).toBeGreaterThan(0.8);
    expect(second.movedBytes).toBeLessThan(48 * 1024);

    const v2store = new MemStore();
    await     v2store.restore(first);
    await     v2store.restore(second);
    const v2 = await openMerklePack(second.root, v2store, RANGE_IDENTITY);
    expect(Buffer.from(await v2.readRange('data.bin', 0, inserted.byteLength))).toEqual(
      Buffer.from(inserted),
    );
  });

  test('sealed CDC reuses most chunks after a one-byte insertion', async () => {
    const base = prng(96 * 1024, 31);
    const ino = ++inoSeq;
    const firstEntry: NodeEntry = {
      path: 'sealed.bin',
      kind: 'file',
      mode: 0o644,
      ino,
      content: {
        kind: 'sealed',
        size: base.byteLength,
        sourceId: 'sealed-before',
        extents: [{ offset: 0, length: base.byteLength, sha256: sha256Hex(base) }],
      },
    };
    const first = await buildMerklePack(sealedAudited([firstEntry], new Map([['sealed-before', base]])));
    const v1 = await publish(first, new MemStore());

    const insertion = 48 * 1024;
    const inserted = new Uint8Array(base.byteLength + 1);
    inserted.set(base.subarray(0, insertion));
    inserted[insertion] = 0x5a;
    inserted.set(base.subarray(insertion), insertion + 1);
    const secondEntry: NodeEntry = {
      ...firstEntry,
      content: {
        kind: 'sealed',
        size: inserted.byteLength,
        sourceId: 'sealed-after',
        extents: [{ offset: 0, length: inserted.byteLength, sha256: sha256Hex(inserted) }],
      },
    };
    const parent = await publishedParent(first, v1);
    const second = await buildMerklePack(
      sealedAudited([secondEntry], new Map([['sealed-after', inserted]]), '4097'),
      { parent },
    );

    expect(second.stats.chunkInstances).toBeGreaterThan(12);
    expect(second.stats.chunkInstancesReused / second.stats.chunkInstances).toBeGreaterThan(0.8);
    expect(second.movedBytes).toBeLessThan(48 * 1024);

    const store = new MemStore();
    await store.restore(first);
    await store.restore(second);
    const view = await openMerklePack(second.root, store, RANGE_IDENTITY);
    expect(Buffer.from(await view.readRange('sealed.bin', 0, inserted.byteLength))).toEqual(Buffer.from(inserted));
  });

  test('POSIX metadata survives Merkle encoding for every node kind', async () => {
    const metadata = {
      uid: 1000,
      gid: 1001,
      atimeNs: '1700000000000000000',
      mtimeNs: '1700000000000000001',
      ctimeNs: '1700000000000000002',
      xattrs: { 'user.z': 'eg==', 'user.a': 'YQ==' },
    };
    const bytes = new Uint8Array([1, 2, 3]);
    const entries: NodeEntry[] = [
      { path: 'dir', kind: 'dir', mode: 0o755, ino: ++inoSeq, metadata },
      {
        path: 'dir/file',
        kind: 'file',
        mode: 0o640,
        ino: ++inoSeq,
        metadata,
        content: {
          kind: 'sealed',
          size: bytes.byteLength,
          sourceId: 'metadata-file',
          extents: [{ offset: 0, length: bytes.byteLength, sha256: sha256Hex(bytes) }],
        },
      },
      { path: 'dir/link', kind: 'symlink', mode: 0o777, ino: ++inoSeq, metadata, target: 'file' },
    ];
    const view = await publish(
      await buildMerklePack(sealedAudited(entries, new Map([['metadata-file', bytes]]))),
      new MemStore(),
    );

    expect((await view.stat('dir'))?.metadata).toEqual(metadata);
    expect((await view.stat('dir/file'))?.metadata).toEqual(metadata);
    expect((await view.stat('dir/link'))?.metadata).toEqual(metadata);
  });

  test('a rename moves no content bytes', async () => {
    const bytes = prng(80 * 1024, 4);
    const renameIno = ++inoSeq;
    const before = await buildMerklePack(audited([file('old-name.txt', dense(bytes), 0o644, renameIno)]));
    const store = new MemStore();
    const v1 = await publish(before, store);

    const parent = await publishedParent(before, v1);
    const after = await buildMerklePack(audited([file('new-name.txt', dense(bytes), 0o644, renameIno)], '4097'), {
      parent,
    });

    expect(after.stats.chunkInstances).toBeGreaterThan(0);
    expect(after.stats.chunkInstancesReused).toBe(after.stats.chunkInstances);
    expect(after.stats.nodesReused).toBeGreaterThanOrEqual(1);
    expect(after.movedBytes).toBeLessThan(16 * 1024);

    const v2store = new MemStore();
    await     v2store.restore(before);
    await     v2store.restore(after);
    const v2 = await openMerklePack(after.root, v2store, RANGE_IDENTITY);
    expect(await v2.stat('old-name.txt')).toBeNull();
    expect(await v2.stat('new-name.txt')).toMatchObject({ kind: 'file', size: bytes.byteLength });
  });

  test('a child requires published-head identity and an advancing captured cut', async () => {
    const entry = file('cut.txt', dense(prng(64, 25)));
    const first = await buildMerklePack(audited([entry]));
    const view = await publish(first, new MemStore());
    const parent = await publishedParent(first, view);

    await expect(buildMerklePack(audited([entry]), { parent })).rejects.toBeInstanceOf(MerklePackError);

    const child = await buildMerklePack(audited([entry], '4097'), { parent });
    expect(child.plan.expectedParentRootId).toBe(parent.headRootId);
    expect(child.plan.capturedCut.cut).toBe('4097');
  });

  test('a relabeled or mismatched published parent is refused before reuse', async () => {
    const first = await buildMerklePack(audited([file('first.txt', dense(prng(32, 28)))]));
    const view = await publish(first, new MemStore());
    const relabeled: PublishedMerkleParent = {
      view,
      headRootId: 'a'.repeat(64),
      reachable: view.referencedObjects(),
    };
    await expect(
      buildMerklePack(audited([file('child.txt', dense(prng(32, 29)))], '4097'), { parent: relabeled }),
    ).rejects.toBeInstanceOf(MerklePackError);

    const other = await buildMerklePack(audited([file('other.txt', dense(prng(32, 30)))]));
    const publishedOther = await finalizePlan(other.plan, {
      operationId: 'other-parent',
      attemptId: 'other-parent-try',
      boxId: 'box-merkle',
      bootId: 'parent-boot',
      expiresAt: '99999999999999',
    }, new FakePublicationStore());
    expect(() => parentFromPublishedParent(view, publishedParentOf(publishedOther))).toThrow('does not authenticate this opened Merkle root');
  });

  test('hardlinks share one inode node and stay one inode across generations', async () => {

    const bytes = prng(30_000, 5);
    const linkedIno = ++inoSeq;
    const linked = [
      dir('x'),
      file('x/one', dense(bytes), 0o644, linkedIno),
      file('x/two', dense(bytes), 0o644, linkedIno),
    ];

    const build = await buildMerklePack(audited(linked));
    expect(build.stats.fileInodes).toBe(1);

    const store = new MemStore();
    const v1 = await publish(build, store);
    const one = await v1.stat('x/one');
    const two = await v1.stat('x/two');
    expect(one).toMatchObject({ kind: 'file', size: bytes.byteLength });
    expect(two).toEqual(one);
    expect(Buffer.from(await v1.readRange('x/two', 0, bytes.byteLength))).toEqual(Buffer.from(bytes));

    // The shared inode changes through one name; both names observe it.
    const rewritten = prng(30_000, 6);
    const nextLinks = [
      dir('x'),
      file('x/one', dense(rewritten), 0o644, linkedIno),
      file('x/two', dense(rewritten), 0o644, linkedIno),
    ];
    const parent = await publishedParent(build, v1);
    const second = await buildMerklePack(audited(nextLinks, '4097'), {
      parent,
    });
    const v2 = await publish(second, new MemStore());
    expect(Buffer.from(await v2.readRange('x/two', 0, rewritten.byteLength))).toEqual(
      Buffer.from(rewritten),
    );
    expect(Buffer.from(await v2.readRange('x/one', 0, rewritten.byteLength))).toEqual(
      Buffer.from(rewritten),
    );
  });

  test('an unaudited lookalike is refused before codec construction', async () => {
    const forged = Object.create(AuditedCapture.prototype);
    await expect(buildMerklePack(forged)).rejects.toThrow('issued by the capture factory');
  });

  test('overlapping sparse runs match expandContent exactly', async () => {
    const runA = prng(5_000, 9);
    const runB = prng(8_000, 10);
    const size = 64 * 1024;
    // Listed out of order and overlapping: run B overwrites A's tail, exactly
    // like sequential out.set calls would.
    const content: FileContent = {
      kind: 'sparse',
      size,
      runs: [
        { offset: 20_000, bytes: runB },
        { offset: 16_000, bytes: runA },
      ],
    };
    const store = new MemStore();
    const view = await publish(await buildMerklePack(audited([file('overlap.bin', content)])), store);

    const whole = await view.readRange('overlap.bin', 0, size);
    expect(whole.byteLength).toBe(size);
    expect(Buffer.from(whole)).toEqual(Buffer.from(expandContent(content)));

    const seam = await view.readRange('overlap.bin', 18_000, 6_000);
    expect(Buffer.from(seam)).toEqual(Buffer.from(expandContent(content).subarray(18_000, 24_000)));
  });

  test('sparse logical bytes survive exactly, holes included', async () => {
    const runA = prng(1_000, 9);
    const runB = prng(500, 10);
    const size = 1 << 20;
    const content: FileContent = {
      kind: 'sparse',
      size,
      runs: [
        { offset: 4096, bytes: runA },
        { offset: 600_000, bytes: runB },
      ],
    };
    const store = new MemStore();
    const view = await publish(await buildMerklePack(audited([file('holey.bin', content)])), store);

    expect(await view.stat('holey.bin')).toMatchObject({ kind: 'file', size });

    const whole = await view.readRange('holey.bin', 0, size);
    expect(Buffer.from(whole)).toEqual(Buffer.from(expandContent(content)));

    // Reads past EOF are short reads, never errors.
    const tail = await view.readRange('holey.bin', size - 10, 100);
    expect(tail.byteLength).toBe(10);
  });

  test('a 100 MiB range read fetches only the intersecting packed bytes over GET intents', async () => {
    const MIB = 1024 * 1024;

    const size = 112 * MIB;
    const runBytes = prng(4 * MIB, 11);
    const content: FileContent = {
      kind: 'sparse',
      size,
      runs: [{ offset: 32 * MIB, bytes: runBytes }],
    };
    const store = new MemStore();
    const view = await publish(await buildMerklePack(audited([file('big.bin', content)])), store);

    store.fetchedBytes = 0;
    store.rangeReads = 0;
    store.intents.length = 0;
    const out = await view.readRange('big.bin', 8 * MIB, 100 * MIB);

    expect(out.byteLength).toBe(100 * MIB);
    // One intent per DISTINCT extent: the hole dedupes to one fetch, the dense
    // run costs one fetch per ~4 KiB chunk, and repeats are free.
    expect(store.rangeReads).toBeLessThan(2048);
    expect(store.intents.length).toBe(store.rangeReads);
    for (const intent of store.intents) {
      expect(intent.method).toBe('GET');
      expect(intent.boxId).toBe(RANGE_IDENTITY.boxId);
    }
    expect(store.fetchedBytes).toBeLessThan(32 * MIB);

    // Sampled sweep without materializing a second buffer.
    let checked = 0;
    for (let i = 0; i < out.byteLength; i += 997) {
      const logical = 8 * MIB + i;
      const expected =
        logical >= 32 * MIB && logical < 36 * MIB ? runBytes[logical - 32 * MIB] : 0;
      expect(out[i]).toBe(expected);
      checked++;
    }
    expect(checked).toBeGreaterThan(10_000);
    // The run edges themselves: window offset 24 MiB is logical MiB 32.
    expect(out[24 * MIB]).toBe(runBytes[0]);
    expect(out[24 * MIB + 4 * MIB - 1]).toBe(runBytes[4 * MIB - 1]);
    expect(out[24 * MIB + 4 * MIB]).toBe(0);
    expect(out[24 * MIB - 1]).toBe(0);
  });
  test('a 1 TiB hole has constant metadata and reads only its intersecting extent', async () => {
    const TIB = 1024 ** 4;
    const build = await buildMerklePack(audited([
      file('terabyte-hole.bin', { kind: 'sparse', size: TIB, runs: [] }),
    ]));
    expect(build.stats.chunkInstances).toBe(TIB / 4096);
    expect(build.plan.dependencies.length).toBeLessThan(4);

    const store = new MemStore();
    const view = await publish(build, store);
    store.rangeReads = 0;
    const extents = await view.extents('terabyte-hole.bin');
    expect(extents).toEqual([{ kind: 'hole', offset: 0, length: TIB }]);
    expect(store.rangeReads).toBe(2);
    const beforeTailReads = store.rangeReads;
    const tail = await view.readRange('terabyte-hole.bin', TIB - 17, 17);
    expect(tail).toEqual(new Uint8Array(17));
    expect(store.rangeReads).toBe(beforeTailReads + 1);
  });
  test('extents reports alternating holes and data without reading holes', async () => {
    const content: FileContent = {
      kind: 'sparse',
      size: 1_000_000,
      runs: [
        { offset: 10, bytes: new Uint8Array([1, 2, 3]) },
        { offset: 500_000, bytes: new Uint8Array([4, 5]) },
      ],
    };
    const store = new MemStore();
    const view = await publish(await buildMerklePack(audited([file('alternating.bin', content)])), store);
    store.rangeReads = 0;
    expect(await view.extents('alternating.bin')).toEqual([
      { kind: 'hole', offset: 0, length: 10 },
      { kind: 'data', offset: 10, length: 3 },
      { kind: 'hole', offset: 13, length: 499_987 },
      { kind: 'data', offset: 500_000, length: 2 },
      { kind: 'hole', offset: 500_002, length: 499_998 },
    ]);
    expect(store.rangeReads).toBe(2);
  });

  test('the metadata cap covers the generation-wide index and every staged object', async () => {
    const directories: NodeEntry[] = [];
    for (let group = 0; group < 10; group++) {
      directories.push(dir(`g${group}`));
      for (let child = 0; child < 5; child++) directories.push(dir(`g${group}/d${child}`));
    }
    await expect(buildMerklePack(audited(directories), { maxPackBytes: 1024 })).rejects.toThrow(/index is .*maxPackBytes/);

    const build = await buildMerklePack(audited([file('small.bin', dense(prng(500, 27)))]), { maxPackBytes: 1024 });
    for (const object of [...build.plan.dependencies, build.plan.root]) {
      expect(Number(object.ref.byteLength)).toBeLessThanOrEqual(1024);
    }
  });

  test('bit rot is refused by the digest-bearing range path before any consumer sees bytes', async () => {
    const store = new MemStore();
    const build = await buildMerklePack(audited([file('data.bin', dense(prng(64 * 1024, 12)))]));
    const view = await publish(build, store);
    // Warm the walked nodes so the chunk stage is exercised alone below.
    expect(await view.stat('data.bin')).not.toBeNull();

    store.corruptRanges = true;
    // The warmed view's chunk fetch fails at the shared intent layer: the
    // returned bytes no longer match the digest the intent authenticated.
    await expect(view.readRange('data.bin', 0, 1024)).rejects.toThrow(/expected/);
    // A COLD open under the same rot refuses at its first authenticated fetch
    // (the index object) — the open promise itself rejects.
    await expect(openMerklePack(build.root, store, RANGE_IDENTITY)).rejects.toThrow(/range read of/);
    store.corruptRanges = false;

    // The root manifest travels by value, so its integrity IS its id: that
    // check is the candidate's own, and refuses with a tagged error.
    const tamperedManifest = build.root.manifestBytes.slice();
    tamperedManifest[Math.floor(tamperedManifest.byteLength / 2)] ^= 0xff;
    await expect(
      openMerklePack({ rootId: build.root.rootId, manifestBytes: tamperedManifest }, store, RANGE_IDENTITY),
    ).rejects.toBeInstanceOf(MerklePackError);
  });

  test('a hash-valid file node with forged extent geometry is never served', async () => {
    const encoder = new TextEncoder();
    const chunk = new Uint8Array(8);
    const chunkDigest = sha256Hex(chunk);
    const fileBytes = serializeNode({
      t: 'f', m: 0o644, i: 2, s: 16, c: [{ d: chunkDigest, l: 8, n: 1 }], h: [],
    });
    const fileDigest = hashNodeBytes(fileBytes);
    const rootBytes = serializeNode({
      t: 'd', m: 0o755, i: 1, e: [{ n: 'bad.bin', k: 'file', r: fileDigest }],
    });
    const rootDigest = hashNodeBytes(rootBytes);
    const pack = new Uint8Array(rootBytes.byteLength + fileBytes.byteLength + chunk.byteLength);
    pack.set(rootBytes);
    pack.set(fileBytes, rootBytes.byteLength);
    pack.set(chunk, rootBytes.byteLength + fileBytes.byteLength);
    const packKey = 'forged-pack';
    const indexBytes = encoder.encode(JSON.stringify({
      v: 1,
      p: [{ key: packKey, byteLength: String(pack.byteLength), sha256: sha256Hex(pack) }],
      e: [
        [rootDigest, sha256Hex(rootBytes), packKey, 0, rootBytes.byteLength],
        [fileDigest, sha256Hex(fileBytes), packKey, rootBytes.byteLength, fileBytes.byteLength],
        [chunkDigest, sha256Hex(chunk), packKey, rootBytes.byteLength + fileBytes.byteLength, chunk.byteLength],
      ],
    }));
    const indexKey = 'forged-index';
    const manifestBytes = encoder.encode(JSON.stringify({
      format: MERKLE_PACK_FORMAT,
      v: 1,
      root: rootDigest,
      index: { key: indexKey, byteLength: String(indexBytes.byteLength), sha256: sha256Hex(indexBytes) },
      capturedCut: {
        captureId: 'forged-capture', epoch: '7', baseRevision: '0', cut: '1',
        stableStageHandle: 'forged-stage', manifestSha256: 'a'.repeat(64),
      },
    }));
    const store = new MemStore();
    store.objects.set(packKey, pack);
    store.objects.set(indexKey, indexBytes);
    const view = await openMerklePack(
      { rootId: sha256Hex(manifestBytes), manifestBytes },
      store,
      RANGE_IDENTITY,
    );
    await expectRejects(view.stat('bad.bin'), 'malformed-node');
  });


  test('Merkle build inputs enforce path and metadata bounds', async () => {
    // No silent oversize objects: a record above the pack bound refuses prepublish.
    await expect(
      buildMerklePack(audited([file('wide.bin', dense(prng(64 * 1024, 19)))]), { maxPackBytes: 1024 }),
    ).rejects.toBeInstanceOf(MerklePackError);

    // Chunk parameters outside the 32-bit domain refuse instead of wrapping.
    const huge = 2 ** 31;
    await expect(
      buildMerklePack(audited([file('x', dense(prng(16, 20)))]), {
        chunkParams: { minBytes: huge, targetBytes: huge, maxBytes: huge },
      }),
    ).rejects.toBeInstanceOf(MerklePackError);
  });

  test('complete audited trees retain ancestor metadata; incomplete ones are refused', async () => {
    const store = new MemStore();
    const view = await publish(
      await buildMerklePack(audited([
        dir('deeply', 0o750, 810),
        dir('deeply/nested', 0o751, 811),
        dir('deeply/nested/tree', 0o752, 812),
        file('deeply/nested/tree/leaf.txt', dense(prng(2_000, 14))),
      ])),
      store,
    );

    expect(await view.readdir('deeply')).toEqual(['nested']);
    expect(await view.stat('deeply/nested/tree')).toMatchObject({ kind: 'dir', mode: 0o752 });
    expect(await view.stat('deeply/nested/tree/leaf.txt')).toMatchObject({ kind: 'file' });
    // The factory refuses an incomplete tree before candidate construction.
    expect(() =>
      audited([file('missing/parent.txt', dense(prng(2, 24)))]),
    ).toThrow();

    await expectRejects(view.stat('/absolute'), 'hostile-path');
    await expectRejects(view.stat('..'), 'hostile-path');
    await expectRejects(view.stat('deeply//nested'), 'hostile-path');
    await expectRejects(view.readRange('missing.txt', 0, 10), 'no-entry');
  });

  test('hostile symlink metadata cannot escape through a read', async () => {
    const store = new MemStore();
    const view = await publish(
      await buildMerklePack(
        audited([sym('escape', '../../../etc/passwd'), file('real.txt', dense(prng(64, 15)))]),
      ),
      store,
    );

    expect(await view.stat('escape')).toMatchObject({ kind: 'symlink', target: '../../../etc/passwd' });
    expect(await view.readdir('')).toEqual(['escape', 'real.txt']);
    await expectRejects(view.readRange('escape', 0, 11), 'symlink-refused');
    await expectRejects(view.stat('escape/child'), 'symlink-traversal');

    await expectRejects(view.readdir('real.txt'), 'not-a-directory');
    await expectRejects(view.readRange('', 0, 1), 'is-a-directory');
  });

  test('stat exposes distinct directory and symlink inodes', async () => {
    const payload = prng(2_000, 21);
    const entries = [
      dir('d1', 0o755, 700),
      dir('d2', 0o755, 701),
      file('d1/same.txt', dense(payload)),
      file('d2/same.txt', dense(payload)),
      sym('l1', 't', 0o777, 702),
      sym('l2', 't', 0o777, 703),
    ];
    const build = await buildMerklePack(audited(entries));
    // root + two dirs + two files + two symlinks: identical-payload
    // directories do NOT merge because their inodes differ.
    expect(build.stats.nodes).toBe(7);
    const view = await publish(build, new MemStore());
    expect(await view.stat('d1')).toMatchObject({ kind: 'dir' });
    expect(await view.stat('l1')).toMatchObject({ kind: 'symlink' });
  });

  test('the previous root stays readable after a new build; exclusive objects turn GC-only', async () => {
    const c1 = prng(90 * 1024, 16);
    const c2 = prng(90 * 1024, 17);
    const shared = prng(20 * 1024, 18);

    const first = await buildMerklePack(audited([file('f1', dense(c1)), file('f2', dense(shared))]));
    const store = new MemStore();
    const v1 = await publish(first, store);

    const replaceIno = ++inoSeq;
    const parent = await publishedParent(first, v1);
    const second = await buildMerklePack(
      audited([
        file('f1', dense(c2), 0o644, replaceIno),
        file('f2', dense(shared), 0o644, ++inoSeq),
      ], '4097'),
      { parent },
    );
    const v2store = new MemStore();
    await     v2store.restore(first);
    await     v2store.restore(second);
    const v2 = await openMerklePack(second.root, v2store, RANGE_IDENTITY);

    expect(Buffer.from(await v2.readRange('f1', 0, c2.byteLength))).toEqual(Buffer.from(c2));
    const oldView = await openMerklePack(first.root, v2store, RANGE_IDENTITY);
    expect(Buffer.from(await oldView.readRange('f1', 0, c1.byteLength))).toEqual(Buffer.from(c1));

    // Both mark sets include their own root manifest object.
    expect(v1.referencedKeys().has(`v1/merkle-pack/root/${first.root.rootId}`)).toBe(true);
    expect(v2.referencedKeys().has(`v1/merkle-pack/root/${second.root.rootId}`)).toBe(true);

    // The replaced file left objects behind that nothing live references.
    const gcOnly = [...v1.referencedKeys()].filter((k) => !v2.referencedKeys().has(k));
    expect(gcOnly.length).toBeGreaterThan(0);
    for (const key of gcOnly) expect(second.staged.some((object) => object.ref.key === key)).toBe(false);
  });

  test('an empty state builds a readable empty root carrying the audited cut', async () => {
    const store = new MemStore();
    const view = await publish(await buildMerklePack(audited([])), store);
    expect(await view.readdir('')).toEqual([]);
    expect(await view.stat('')).toMatchObject({ kind: 'dir', mode: 0o755 });
    expect(view.capturedCut.cut).toBe('4096');
    await expectRejects(view.readRange('anything', 0, 1), 'no-entry');
  });
});

class FakePublicationStore implements CandidatePayloadStore, CandidatePublicationControl {
  readonly operations: OperationRecord[] = [];
  readonly uploadedKeys: string[] = [];
  readonly payloads = new Map<string, Uint8Array>();
  readonly envelopes = new Map<string, RootEnvelopeV1>();
  private head: { rootEnvelopeId: string } | null = null;

  recordOperation(record: OperationRecord): void {
    this.operations.push(record);
  }

  async issuePayloadGrant(intent: UploadIntent): Promise<PayloadGrant> {
    return {
      operationId: intent.operationId,
      attemptId: intent.attemptId,
      expiresAt: intent.expiresAt,
      opaque: `grant:${intent.exactKey}`,
    };
  }

  async uploadObject(grant: PayloadGrant, body: ReadableStream<Uint8Array>): Promise<ObjectReceipt> {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
      length += next.value.byteLength;
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const key = grant.opaque.slice('grant:'.length);
    this.uploadedKeys.push(key);
    this.payloads.set(key, bytes);
    return {
      operationId: grant.operationId,
      attemptId: grant.attemptId,
      key,
      byteLength: String(bytes.byteLength),
      sha256: sha256Hex(bytes),
      etag: 'etag-1',
      verified: true,
    };
  }

  async verifyObject(ref: ImmutableObjectRef): Promise<void> {
    const bytes = this.payloads.get(ref.key);
    if (bytes === undefined) throw new Error(`missing candidate object ${ref.key}`);
    if (String(bytes.byteLength) !== ref.byteLength || sha256Hex(bytes) !== ref.sha256) {
      throw new Error(`candidate object metadata mismatches ${ref.key}`);
    }
  }
  async writeEnvelope(envelope: RootEnvelopeV1, rootEnvelopeId: string): Promise<void> {
    if (envelopeIdOf(envelope) !== rootEnvelopeId) {
      throw new Error(`envelope id does not match immutable body: ${rootEnvelopeId}`);
    }
    const prior = this.envelopes.get(rootEnvelopeId);
    if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(envelope)) {
      throw new Error(`immutable envelope ${rootEnvelopeId} was rewritten`);
    }
    this.envelopes.set(rootEnvelopeId, Object.freeze({ ...envelope }));
  }


  async compareAndSwapHead(envelope: RootEnvelopeV1, expectedParentRootId: string | null) {
    const id = envelopeIdOf(envelope);
    if (this.head !== null && this.head.rootEnvelopeId !== expectedParentRootId) {
      throw new StaleParentRefused(expectedParentRootId, this.head.rootEnvelopeId);
    }
    this.head = { rootEnvelopeId: id };
    return { version: 1 as const, rootEnvelopeId: id, lastOperationId: 'cas-op' };
  }
  markFailed(_operationId: string, _failureCode: string): void {}


  async markComplete(): Promise<void> {}
}

async function finalizePlan(
  plan: MerklePackBuild['plan'],
  input: { operationId: string; attemptId: string; boxId: string; bootId: string; expiresAt: string },
  store: FakePublicationStore,
) {
  const fullInput = { ...input, epoch: '7', kind: 'tick' as const };
  return finalizeCandidatePayload(await stageCandidatePayload(plan, fullInput, store), fullInput, store);
}

describe('merkle-pack/v1 publication adapter', () => {
  test('stage/finalize commits a built plan; the envelope carries the full CapturedCut', async () => {
    const build = await buildMerklePack(audited([file('pub.txt', dense(prng(8_000, 22)))]));
    const store = new FakePublicationStore();

    const published = await finalizePlan(build.plan, {
      operationId: 'pub-op-1',
      attemptId: 'try-1',
      boxId: 'box-merkle',
      bootId: 'boot-1',
      expiresAt: '99999999999999',
    }, store);

    expect(published.envelope.format).toBe(MERKLE_PACK_FORMAT);
    expect(published.envelope.parentRootId).toBeNull();
    expect(published.envelope.cut).toEqual(build.plan.capturedCut);
    expect(published.resultRootId).toBe(envelopeIdOf(published.envelope));
    expect(published.head.rootEnvelopeId).toBe(published.resultRootId);
    const expectedKeys = build.staged.map((object) => object.ref.key);
    for (const key of expectedKeys) expect(store.uploadedKeys).toContain(key);

    // A second generation supersedes the committed HEAD: its plan names the
    // parent's published envelope id, not the parent's pack root id.
    const store2 = new MemStore();
    const v1 = await publish(build, store2);
    const changed = prng(9_000, 23);
    const parent = parentFromPublishedParent(v1, publishedParentOf(published));
    const gen2 = await buildMerklePack(audited([file('pub.txt', dense(changed))], '4097'), { parent });
    expect(gen2.plan.expectedParentRootId).toBe(published.resultRootId);

    const gen2Published = await buildMerklePack(audited([file('pub.txt', dense(changed))], '4097'), { parent });
    const published2 = await finalizePlan(gen2Published.plan, {
      operationId: 'pub-op-2',
      attemptId: 'try-2',
      boxId: 'box-merkle',
      bootId: 'boot-1',
      expiresAt: '99999999999999',
    }, store);
    expect(published2.envelope.parentRootId).toBe(published.resultRootId);

    // A stale expectation leaves the head untouched and raises.
    await expect(
      finalizePlan(build.plan, {
        operationId: 'pub-op-3',
        attemptId: 'try-3',
        boxId: 'box-merkle',
        bootId: 'boot-1',
        expiresAt: '99999999999999',
      }, store),
    ).rejects.toBeInstanceOf(StaleParentRefused);
  });
});

// ── the attach contract ───────────────────────────────────────────────────────
//
// A deployed run lost the merkle-pack arm to `Devbox.attach exceeded its
// 300000ms budget`. Attach (restoreMerkle) opens the published head and walks
// the whole tree; every stat/readdir/readRange the walk issues crosses the
// store as a digest-bearing intent. These tests pin the properties that decide
// whether that walk stays bounded in the history behind the head and whether
// it serves exactly what was committed.

describe('merkle-pack/v1 attach', () => {
  /** Build, stage into the shared store, open, and publish one generation.
   *  `publication` may be shared across generations: a child that reuses
   *  parent packs names them in its closure, so the publication store that
   *  finalizes it must already hold them. */
  async function commitGeneration(
    store: MemStore,
    parent: PublishedMerkleParent | null,
    files: readonly NodeEntry[],
    cut: string,
    publication: FakePublicationStore = new FakePublicationStore(),
  ): Promise<{ build: MerklePackBuild; view: MerklePackView; parent: PublishedMerkleParent }> {
    const build = await buildMerklePack(audited(files, cut), parent === null ? {} : { parent });
    await store.restore(build);
    const view = await openMerklePack(build.root, store, RANGE_IDENTITY);
    const published = await finalizePlan(build.plan, {
      operationId: `attach-op-${cut}`,
      attemptId: `attach-try-${cut}`,
      boxId: 'box-merkle',
      bootId: 'attach-boot',
      expiresAt: '99999999999999',
    }, publication);
    return { build, view, parent: parentFromPublishedParent(view, publishedParentOf(published)) };
  }

  /** Counts one attach-shaped pass over `root`: open, then the same
   *  readdir/stat/readRange walk restoreMerkle performs, in 512 KiB slices.
   *  This is the store work a wake pays, not merely the lazy open. */
  async function measureAttachWalk(
    store: MemStore,
    root: MerklePackRoot,
  ): Promise<{ intents: number; fetchedBytes: number; indexBytes: number; namedPacks: number }> {
    store.intents.length = 0;
    store.rangeReads = 0;
    store.fetchedBytes = 0;
    const view = await openMerklePack(root, store, RANGE_IDENTITY);
    const visit = async (path: string): Promise<void> => {
      const entry = await view.stat(path);
      if (entry === null) throw new Error(`attach walk lost ${path}`);
      if (entry.kind === 'dir') {
        for (const child of await view.readdir(path)) await visit(path === '' ? child : `${path}/${child}`);
        return;
      }
      if (entry.kind !== 'file' || entry.size === undefined) return;
      for (let at = 0; at < entry.size; at += 512 * 1024) {
        await view.readRange(path, at, Math.min(512 * 1024, entry.size - at));
      }
    };
    for (const child of await view.readdir('')) await visit(child);
    const indexRef = view.referencedObjects().find((ref) => ref.key.startsWith('v1/merkle-pack/index/'));
    return {
      intents: store.intents.length,
      fetchedBytes: store.fetchedBytes,
      indexBytes: indexRef === undefined ? 0 : Number(indexRef.byteLength),
      namedPacks: [...view.referencedKeys()].filter((key) => key.startsWith('v1/merkle-pack/pack/')).length,
    };
  }

  test('opening the head through an 8-generation history stays bounded by the served tree', async () => {
    const store = new MemStore();
    let parent: PublishedMerkleParent | null = null;
    const measured: { intents: number; fetchedBytes: number; indexBytes: number; namedPacks: number }[] = [];
    let headRoot: MerklePackRoot | null = null;

    // Every generation rewrites the same eight 24 KiB files under one
    // directory, so the tree the head serves is constant while the store
    // accumulates one pack set per generation. Open cost may depend on the
    // tree but not on the number of packs or generations behind it.
    for (let generation = 0; generation < 8; generation++) {
      const files = [
        dir('gen', 0o755, 899),
        ...Array.from({ length: 8 }, (_, index) =>
          file(`gen/data-${index}.bin`, dense(prng(24 * 1024, 40 + generation)), 0o644, 900 + index)),
      ];
      const committed = await commitGeneration(store, parent, files, String(4096 + generation));
      measured.push(await measureAttachWalk(store, committed.build.root));
      headRoot = committed.build.root;
      parent = committed.parent;
    }

    const oldest = measured[0]!;
    const newest = measured.at(-1)!;
    // One intent per distinct extent the walk needs: manifest by value, then
    // index + one fetch per node. Eight generations of packs sit in the
    // store; none of them may enter the count, and the index must not absorb
    // ancestor state generation over generation.
    expect(newest.intents).toBeLessThanOrEqual(oldest.intents * 2);
    expect(newest.indexBytes).toBeLessThan(oldest.indexBytes * 3);
    expect(newest.namedPacks).toBeLessThanOrEqual(oldest.namedPacks * 2);
    expect(newest.fetchedBytes).toBeLessThan(1 << 20);

    // The head still serves the eighth generation's exact bytes.
    const head = await openMerklePack(headRoot!, store, RANGE_IDENTITY);
    expect(Buffer.from(await head.readRange('gen/data-0.bin', 0, 24 * 1024)))
      .toEqual(Buffer.from(prng(24 * 1024, 40 + 7)));
  });

  test('the index names every pack the served tree needs, across four consecutive commits', async () => {
    const store = new MemStore();
    const publication = new FakePublicationStore();
    let parent: PublishedMerkleParent | null = null;
    const payloads = [prng(64 * 1024, 50), prng(64 * 1024, 51)];
    const churn = [0, 1, 0, 1];
    const keep = prng(32 * 1024, 52);

    // keep.txt is written once and never again: its chunks live in the FIRST
    // generation's packs, so every later generation's index must name a pack
    // an EARLIER commit staged — its closure reaches backward. churn.bin is
    // replaced wholesale each commit (A,B,A,B), so reuse also crosses
    // non-adjacent generations. The parent handoff (parentFromPublishedParent
    // over referencedObjects) is exactly the step that refused with "index
    // extent is outside its declared pack" when an index listed only the
    // packs its own build staged.
    for (let commit = 0; commit < 4; commit++) {
      const files = [
        file('keep.txt', dense(keep), 0o644, 950),
        file('churn.bin', dense(payloads[churn[commit]!]!), 0o644, 951),
      ];
      const { view, parent: next } = await commitGeneration(store, parent, files, String(4096 + commit), publication);
      expect(Buffer.from(await view.readRange('keep.txt', 0, keep.byteLength))).toEqual(Buffer.from(keep));
      expect(Buffer.from(await view.readRange('churn.bin', 0, payloads[churn[commit]!].byteLength)))
        .toEqual(Buffer.from(payloads[churn[commit]!]));
      parent = next;
    }
    // The pattern really accumulated: four roots, four indexes, and churn
    // packs from both payload shapes are all present in the one store.
    expect(store.objects.size).toBeGreaterThanOrEqual(8);
  });

  /** A degraded transport that answers blank bytes for absent objects. */
  class BlankServingStore extends MemStore {
    override async readRange(intent: RangeReadIntent): Promise<Uint8Array> {
      const bytes = this.objects.get(intent.exactKey);
      if (bytes === undefined) return new Uint8Array(Number(intent.byteLength));
      return await super.readRange(intent);
    }
  }

  test('a pack the index names but the store lacks refuses every read; blank answers refuse too', async () => {
    const build = await buildMerklePack(audited([
      dir('w'),
      file('w/one.bin', dense(prng(48 * 1024, 54))),
      file('w/two.bin', dense(prng(48 * 1024, 55))),
    ]));

    // 1. Plain absence: the open resolves the index (lazy by design), and the
    //    first tree query refuses with the absent pack's key in the reason.
    //    Nothing partial or blank is ever served; in production the same
    //    refusal aborts the restore before the journal mounts.
    const store = new MemStore();
    await store.restore(build);
    const packKey = build.staged.map((object) => object.ref.key)
      .find((key) => key.startsWith('v1/merkle-pack/pack/'));
    expect(packKey).toBeDefined();
    store.objects.delete(packKey!);
    const absentView = await openMerklePack(build.root, store, RANGE_IDENTITY);
    await expect(absentView.stat('w/one.bin')).rejects.toThrow(packKey!);
    await expect(absentView.readRange('w/one.bin', 0, 16)).rejects.toThrow(packKey!);
    await expect(absentView.stat('')).rejects.toThrow(packKey!);

    // 2. A lying transport that answers zeros for the same absence must ALSO
    //    refuse: the authenticated range path holds bytes to their digest, so
    //    blank bytes cannot become a blank tree.
    const blankStore = new BlankServingStore();
    await blankStore.restore(build);
    blankStore.objects.delete(packKey!);
    await expect((async () => {
      const view = await openMerklePack(build.root, blankStore, RANGE_IDENTITY);
      return await view.stat('w/one.bin');
    })()).rejects.toThrow(packKey!);
  });

  test('a container replaced mid-commit and mid-attach serves exactly one committed generation', async () => {
    const shared = prng(96 * 1024, 56);
    const updated = prng(96 * 1024, 57);
    const originalChurn = prng(8 * 1024, 58);
    const stableIno = 960;
    const churnIno = 961;

    const first = await buildMerklePack(audited([
      file('stable.txt', dense(shared), 0o644, stableIno),
      file('churn.txt', dense(originalChurn), 0o644, churnIno),
    ]));
    const store = new MemStore();
    const v1 = await publish(first, store);
    const parent = await publishedParent(first, v1);

    // The replacement arrives after the head was durable but during the
    // attach: the previous generation's bytes are still in the store, and the
    // replacement re-opens from the head. Each root must serve its own
    // committed generation byte-exactly — never a blend, never a blank.
    const second = await buildMerklePack(audited([
      file('stable.txt', dense(shared), 0o644, stableIno),
      file('churn.txt', dense(updated), 0o644, churnIno),
    ], '4097'), { parent });
    await store.restore(second);

    const headView = await openMerklePack(second.root, store, RANGE_IDENTITY);
    const oldView = await openMerklePack(first.root, store, RANGE_IDENTITY);
    const headAgain = await openMerklePack(second.root, store, RANGE_IDENTITY);

    expect(Buffer.from(await headView.readRange('churn.txt', 0, updated.byteLength)))
      .toEqual(Buffer.from(updated));
    expect(Buffer.from(await headAgain.readRange('churn.txt', 0, updated.byteLength)))
      .toEqual(Buffer.from(updated));
    // A partial range through the head is sliced by offset, not from zero.
    expect(Buffer.from(await headView.readRange('churn.txt', 1024, 4096)))
      .toEqual(Buffer.from(updated.subarray(1024, 5120)));
    expect(Buffer.from(await oldView.readRange('churn.txt', 0, originalChurn.byteLength)))
      .toEqual(Buffer.from(originalChurn));
    expect(await headView.stat('churn.txt')).toMatchObject({ kind: 'file', size: updated.byteLength });
    expect(await oldView.stat('churn.txt')).toMatchObject({ kind: 'file', size: originalChurn.byteLength });
    // The untouched file is ONE committed fact: same inode identity through
    // both roots, resolved from the same reused pack.
    expect((await headView.stat('stable.txt'))?.ino).toBe((await oldView.stat('stable.txt'))?.ino);
    expect(headView.capturedCut.cut).toBe('4097');
    expect(oldView.capturedCut.cut).toBe('4096');
  });

  test('a commit that changes one small file moves bytes proportional to the change, not to the tree', async () => {
    const store = new MemStore();
    const big = prng(2 * 1024 * 1024, 59);
    const neighbourB = prng(1024 * 1024, 60);

    const base = await buildMerklePack(audited([
      dir('big'),
      file('big/a.bin', dense(big), 0o644, 970),
      file('big/b.bin', dense(neighbourB), 0o644, 971),
      file('big/c.bin', dense(prng(1024 * 1024, 61)), 0o644, 972),
    ]));
    await store.restore(base);
    const baseView = await openMerklePack(base.root, store, RANGE_IDENTITY);
    const parent = await publishedParent(base, baseView);

    // One 8 KiB file changes; the ~4 MiB of neighbours do not.
    const child = await buildMerklePack(audited([
      dir('big'),
      file('big/a.bin', dense(big), 0o644, 970),
      file('big/b.bin', dense(neighbourB), 0o644, 971),
      file('big/c.bin', dense(prng(8 * 1024, 62)), 0o644, 972),
    ], '4097'), { parent });

    // Pack bytes: only the two fresh chunks plus rewritten dir nodes move.
    const freshPackBytes = child.staged
      .filter((object) => object.ref.key.startsWith('v1/merkle-pack/pack/'))
      .reduce((sum, object) => sum + Number(object.ref.byteLength), 0);
    expect(freshPackBytes).toBeLessThan(64 * 1024);
    expect(child.stats.chunkInstancesReused / child.stats.chunkInstances).toBeGreaterThan(0.99);
    // Total moved (packs + the generation-wide index) stays a small fraction
    // of the tree it did NOT rewrite.
    expect(child.movedBytes).toBeLessThan(child.stats.logicalBytes / 4);
    // And at the object boundary: no pack carrying the untouched megabyte
    // files is staged again.
    const stagedKeys = new Set(child.staged.map((object) => object.ref.key));
    for (const object of base.staged) {
      if (object.ref.key.startsWith('v1/merkle-pack/pack/')) {
        expect(stagedKeys.has(object.ref.key)).toBe(false);
      }
    }
  });
  test('attach fetch granularity is one intent per packed chunk, not per restore slice', async () => {
    const MIB = 1024 * 1024;
    // 96 MiB in eight dense 12 MiB files: the LARGEST dense tree the codec
    // publishes at all. A 400 MiB workspace — the scale the deployed r2fs arm
    // attached in 990 s — produces a pack index of ~16.5 MB, and
    // buildMerklePack REFUSES it (index is 16461981 bytes, above maxPackBytes
    // 4194304). The refusal is the finding this test pins.
    const files = [dir('work'), ...Array.from({ length: 8 }, (_, index) =>
      file(`work/blob-${index}.bin`, dense(prng(12 * MIB, 70 + index)), 0o644, 980 + index))];
    const build = await buildMerklePack(audited(files, '4110'));
    const store = new MemStore();
    await store.restore(build);

    const measured = await measureAttachWalk(store, build.root);

    // One intent per packed CDC chunk (target 4 KiB, max 16 KiB), NOT one per
    // 512 KiB restore slice: ~24k chunk round-trips, ~85 slice round-trips.
    // The chunk count is what bounds a wake, so granularity is pinned here.
    expect(measured.intents).toBeGreaterThan(12_000);
    expect(measured.intents).toBeLessThan(24_000);
    // Bytes move at chunk granularity: byte-proportional, chunk-sized intents.
    expect(measured.fetchedBytes).toBeGreaterThan(88 * MIB);
    expect(measured.fetchedBytes).toBeLessThan(112 * MIB);
    // Average intent size: chunk-scaled (4-16 KiB), never slice-scaled
    // (512 KiB) — the restore never coalesces chunks into slices.
    expect(measured.fetchedBytes / measured.intents).toBeGreaterThan(4 * 1024);
    expect(measured.fetchedBytes / measured.intents).toBeLessThan(17 * 1024);
    // A DECLARED BUDGET, not a guessed wait: every assertion above is a COUNT
    // over deterministic bytes, so this number can only ever end a run that
    // stopped making progress. It exists because the work is real — 96 MiB of
    // PRNG, CDC-chunked into ~24k chunks and hashed — and measures 3.2 s idle
    // on a 12900K, which leaves 1.6x against bun's 5 s default. That margin is
    // not enough: this test timed out ONCE at 5,705 ms on a box also running
    // three live container probes, and a deterministic assertion that loses to
    // machine load is a CI flake with no defect behind it. Reported by
    // BoundedLayersAttachDebug, 2026-09-01. The tree size is load-bearing —
    // it is the largest the codec publishes at all — so the budget moves
    // rather than the workload.
  }, 30_000);

  /** The shared group barrier in front of an in-memory store: a reader that
   *  serializes its reads never assembles a group, and `widest` says so. */
  class BarrierStore extends MemStore {
    readonly barrier: ReadBarrier;

    constructor(width: number) {
      super();
      this.barrier = readBarrier(width);
    }

    override async readRange(intent: RangeReadIntent): Promise<Uint8Array> {
      await this.barrier.hold();
      return await super.readRange(intent);
    }
  }

  test('one slice fetches its distinct extents together, not one round trip at a time', async () => {
    // THE DOMINANT TERM of the deployed overrun. A restore reads each file in
    // 512 KiB slices, and a slice of a file chunked at the default 4 KiB
    // target is 128 authenticated reads — which the reader awaited strictly
    // one after another, so a 30 MiB tree paid thousands of round trips of
    // pure store latency and the wake never finished inside its attach budget.
    const store = new BarrierStore(4);
    const bytes = prng(64 * 1024, 91);
    const build = await buildMerklePack(audited([file('slice.bin', dense(bytes))]));
    await store.restore(build);
    const view = await openMerklePack(build.root, store, RANGE_IDENTITY);

    const out = await view.readRange('slice.bin', 0, bytes.byteLength);

    // Same bytes, still one authenticated intent per distinct extent — the
    // parallelism is in the waiting, not in what is fetched or verified.
    expect(Buffer.from(out)).toEqual(Buffer.from(bytes));
    expect(store.barrier.widest).toBeGreaterThanOrEqual(4);
  });

  test('two walks that need the same node in flight share one fetch', async () => {
    // The node cache holds the PROMISE. Holding the settled value dedupes
    // nothing while a fetch is in flight, so a parallel walk paid for the same
    // interior node once per branch that wanted it.
    const store = new MemStore();
    const build = await buildMerklePack(audited([
      dir('pkg'),
      file('pkg/one.bin', dense(prng(2_000, 92))),
      file('pkg/two.bin', dense(prng(2_000, 93))),
    ]));
    await store.restore(build);
    const view = await openMerklePack(build.root, store, RANGE_IDENTITY);
    store.intents.length = 0;

    await Promise.all([view.stat('pkg/one.bin'), view.stat('pkg/two.bin')]);

    // Both walks pass through the root node and `pkg`. Every intent issued is
    // for a DIFFERENT extent: nothing was fetched twice.
    const fetched = store.intents.map((intent) => `${intent.exactKey}@${intent.byteOffset}`);
    expect(new Set(fetched).size).toBe(fetched.length);
  });

});
