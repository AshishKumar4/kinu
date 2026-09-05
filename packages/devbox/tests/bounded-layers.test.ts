// The bounded-layer candidate gate.
//
// One immutable base, newest-first delta layers capped at eight, chunk-level
// content addressing shared with the CAS journal — published through the
// shared CandidatePublicationPlan boundary and read back exclusively through
// digest-bearing RangeReadIntents. Every acceptance property is exercised
// through the codec's public surface against an in-memory object store that
// counts what it serves, so "bounded" and "reused" are measured, not asserted
// rhetorically.
import { describe, expect, test } from 'bun:test';

import { decodeJson } from '../src/cas/types';
import { CHUNK_SIZE, sha256Hex } from '../src/cas/hash';
import type { Sha256Hex } from '../src/cas/types';
import {
  MAX_SEALED_EXTENT_BYTES,
  MutationLog,
  expandContent,
  issueVerifiedJournalCapture,
  manifestSha256,
  prefixState,
  readCaptureRange,
  toCapturedCut,
} from '../src/capture/model';
import type {
  AuditedCapture,
  Capture,
  FileContent,
  NodeEntry,
  SparseRun,
  StateSnapshot,
  StructuralOp,
} from '../src/capture/model';
import type {
  HeadPointerV1,
  ImmutableObjectRef,
  ObjectReceipt,
  OperationRecord,
  PayloadGrant,
  RangeReadIntent,
  RootEnvelopeV1,
  UploadIntent,
} from '../src/durability/contracts';
import {
  LayerDocSchema,
  MAX_LAYER_DEPTH,
  build,
  encodeCanonical,
  isHoleExtent,
  objectKey,
  open,
} from '../src/candidates/bounded-layers';
import type { BoundedLayers, BuiltLayers, Canon } from '../src/candidates/bounded-layers';
import {
  MemoryCandidateObjectSink,
  StaleParentRefused,
  envelopeBytes,
  envelopeIdOf,
  finalizeCandidatePayload,
  publishedParentInfo,
  publishedParentOf,
  readStagedCandidateObjectForTest,
  stageCandidatePayload,
} from '../src/candidates/publication';
import type {
  CandidatePayloadStore,
  CandidatePublicationControl,
  CandidatePublicationPlan,
} from '../src/candidates/publication';

const MIB = 1024 * 1024;
const enc = new TextEncoder();

/** The read identity every intent in this suite carries. */
const IDENTITY = {
  operationId: 'op-bounded',
  attemptId: 'att-bounded',
  boxId: 'box-bounded',
  epoch: '7',
  expiresAt: '99999999999999',
};

// ── fixtures ─────────────────────────────────────────────────────────────────

let nextIno = 100;

interface FileOpts {
  readonly mode?: number;
  readonly ino?: number;
}

function fileE(path: string, content: string | Uint8Array, opts: FileOpts = {}): NodeEntry {
  return {
    path,
    kind: 'file',
    mode: opts.mode ?? 0o644,
    ino: opts.ino ?? nextIno++,
    content: { kind: 'dense', bytes: content instanceof Uint8Array ? content : enc.encode(content) },
  };
}

function sparseE(path: string, size: number, runs: readonly SparseRun[], opts: FileOpts = {}): NodeEntry {
  return {
    path,
    kind: 'file',
    mode: opts.mode ?? 0o644,
    ino: opts.ino ?? nextIno++,
    content: { kind: 'sparse', size, runs },
  };
}

function dirE(path: string, mode = 0o755): NodeEntry {
  return { path, kind: 'dir', mode, ino: nextIno++ };
}

function symE(path: string, target: string): NodeEntry {
  return { path, kind: 'symlink', mode: 0o777, ino: nextIno++, target };
}

function snap(...entries: readonly NodeEntry[]): StateSnapshot {
  return new Map(entries.map((e) => [e.path, e]));
}

/** Build a same-size state distinct from the final capture until the final
 * journal mutation, so auditCapture can prove one unique cut. */
function markerContent(content: FileContent, marker: number): FileContent | undefined {
  if (content.kind === 'dense') {
    if (content.bytes.byteLength === 0) return undefined;
    const bytes = content.bytes.slice();
    const candidate = marker % 255;
    bytes[0] = candidate >= content.bytes[0]! ? candidate + 1 : candidate;
    return { kind: 'dense', bytes };
  }
  if (content.kind === 'sealed' || content.size === 0) return undefined;
  let original = 0;
  for (const run of content.runs) if (run.offset === 0 && run.bytes.byteLength > 0) original = run.bytes[0]!;
  const candidate = marker % 255;
  const byte = candidate >= original ? candidate + 1 : candidate;
  return { kind: 'sparse', size: content.size, runs: [{ offset: 0, bytes: new Uint8Array([byte]) }] };
}

/** Build every codec fixture through the real audit factory. `cut` separates
 * parent generations with journalled intermediate states; it is never
 * hand-stamped onto an unaudited object. */
function audited(snapshot: StateSnapshot, cut: number): AuditedCapture {
  const log = new MutationLog();
  const entries = [...snapshot.values()];
  const comparePath = (a: NodeEntry, b: NodeEntry) => a.path.localeCompare(b.path);
  const dirs = entries.filter((entry) => entry.kind === 'dir')
    .sort((a, b) => a.path.split('/').length - b.path.split('/').length || comparePath(a, b));
  for (const entry of dirs) log.bypassFrozenGate({ op: 'mkdir', path: entry.path, mode: entry.mode });

  const files = entries.filter((entry): entry is NodeEntry & { readonly kind: 'file'; readonly content: FileContent } =>
    entry.kind === 'file' && entry.content !== undefined,
  ).sort(comparePath);
  const anchor = files.find((entry) => markerContent(entry.content, 1) !== undefined);
  const symlinkAnchor = anchor === undefined
    ? entries.find((entry): entry is NodeEntry & { readonly kind: 'symlink'; readonly target: string } =>
      entry.kind === 'symlink' && entry.target !== undefined,
    )
    : undefined;
  const pathsByIno = new Map<number, string>();
  for (const entry of files) {
    const existing = pathsByIno.get(entry.ino);
    if (existing === undefined) {
      const initial = entry === anchor ? markerContent(entry.content, 1)! : entry.content;
      log.bypassFrozenGate({ op: 'write', path: entry.path, content: initial, mode: entry.mode });
      pathsByIno.set(entry.ino, entry.path);
    } else {
      log.bypassFrozenGate({ op: 'link', existingPath: existing, newPath: entry.path });
    }
  }
  for (const entry of entries.filter((entry) => entry.kind === 'symlink').sort(comparePath)) {
    if (entry.target === undefined) throw new Error(`fixture symlink ${entry.path} lacks a target`);
    const target = entry === symlinkAnchor ? `${entry.target}#audit-1` : entry.target;
    log.bypassFrozenGate({ op: 'symlink', path: entry.path, target });
  }
  if (anchor === undefined && symlinkAnchor === undefined && entries.length === 0) {
    log.bypassFrozenGate({ op: 'replace-generation' });
  }
  if (anchor !== undefined) {
    for (let i = 0; i < cut * 10; i++) {
      log.bypassFrozenGate({ op: 'rewrite-in-place', path: anchor.path, content: markerContent(anchor.content, i * 2 + 2)! });
      log.bypassFrozenGate({ op: 'rewrite-in-place', path: anchor.path, content: markerContent(anchor.content, i * 2 + 3)! });
    }
    log.bypassFrozenGate({ op: 'rewrite-in-place', path: anchor.path, content: anchor.content });
  } else if (symlinkAnchor !== undefined) {
    for (let i = 0; i < cut * 10; i++) {
      log.bypassFrozenGate({ op: 'unlink', path: symlinkAnchor.path });
      log.bypassFrozenGate({ op: 'symlink', path: symlinkAnchor.path, target: `${symlinkAnchor.target}#audit-${i + 2}` });
    }
    log.bypassFrozenGate({ op: 'unlink', path: symlinkAnchor.path });
    log.bypassFrozenGate({ op: 'symlink', path: symlinkAnchor.path, target: symlinkAnchor.target });
  }
  const actualCut = log.lastSeq;
  const capture: Capture = {
    mechanism: 'mutation-journal',
    cut: actualCut,
    generation: log.generation,
    entries: [...prefixState(log.entries, actualCut).values()],
  };
  return toCapturedCut(log.entries, capture, {
    captureId: `cap-${cut}`,
    epoch: '7',
    baseRevision: String(cut),
    stableStageHandle: `stage-${cut}`,
  });
}

const defaultJournalMetadata = {
  uid: 1000,
  gid: 1000,
  atimeNs: '1',
  mtimeNs: '2',
  ctimeNs: '3',
  xattrs: {},
};

function withJournalMetadata(entries: readonly NodeEntry[]): readonly NodeEntry[] {
  return entries.map((entry) => entry.metadata === undefined ? { ...entry, metadata: { ...defaultJournalMetadata, xattrs: {} } } : entry);
}

function verifiedJournalCapture(
  entries: readonly NodeEntry[],
  cut: number,
  partial: { partial?: boolean; structural?: readonly StructuralOp[] } = {},
): AuditedCapture {
  const journalEntries = withJournalMetadata(entries);
  const capture = { mechanism: 'mutation-journal' as const, cut, generation: 0, entries: journalEntries };
  return issueVerifiedJournalCapture({
    ...capture,
    identity: {
      captureId: `journal-${cut}`,
      epoch: '7',
      baseRevision: String(cut),
      stableStageHandle: `journal-stage-${cut}`,
    },
    manifestSha256: manifestSha256(capture),
    partial: partial.partial === true,
    structural: partial.structural,
  });
}

/** An in-memory immutable object store serving whole objects behind intents. */
class MemStore {
  readonly map = new Map<string, Uint8Array>();
  head: ImmutableObjectRef | null = null; // the published root object
  gets = 0;

  /** The head's root object, for tests that open without needing a parent. */
  fetchedBytes = 0;

  readonly reader = {
    readRange: async (intent: RangeReadIntent): Promise<Uint8Array> => {
      this.gets++;
      const bytes = this.map.get(intent.exactKey);
      if (bytes === undefined) throw new Error(`missing ${intent.exactKey}`);
      const offset = Number(intent.byteOffset);
      const out = bytes.subarray(offset, offset + Number(intent.byteLength));
      this.fetchedBytes += out.byteLength;
      return out;
    },
  };
  /** Materialize staged objects only through the shared behavior-test seam. */
  async stage(plan: CandidatePublicationPlan): Promise<void> {
    for (const dependency of plan.dependencies) {
      this.map.set(dependency.ref.key, await readStagedCandidateObjectForTest(dependency));
    }
    this.map.set(plan.root.ref.key, await readStagedCandidateObjectForTest(plan.root));
  }

  /** Materialize staged objects then move the local read head. */
  async commit(plan: CandidatePublicationPlan): Promise<void> {
    await this.stage(plan);
    this.head = plan.root.ref;
  }

  async openHead(): Promise<BoundedLayers> {
    if (this.head === null) throw new Error('no head');
    return open(this.head, this.reader, IDENTITY);
  }

  resetCounters(): void {
    this.gets = 0;
    this.fetchedBytes = 0;
  }
}

/** Bytes the split publisher uploads for one fully staged plan. */
function planMovedBytes(plan: CandidatePublicationPlan): number {
  return [...plan.dependencies, plan.root]
    .reduce((total, object) => total + Number(object.ref.byteLength), 0);
}

/** Full resolved state of a view as comparable text. */
function resolvedText(view: BoundedLayers): string {
  const rows = [...view.entryPaths()].sort().map((path) => ({
    path,
    stat: view.stat(path),
    children: view.stat(path)?.kind === 'dir' ? view.readdir(path) : undefined,
  }));
  return JSON.stringify(rows);
}

/** Publish staged payloads through the split container/DO boundary, then
 * reopen the actual envelope root and bind its opaque parent token. */
let publishSequence = 0;
async function publishAndOpen(
  built: BuiltLayers,
  store: MemStore,
  publisher: HarnessPublicationStore,
): Promise<BoundedLayers> {
  const input = pubInput(`op-chain-${++publishSequence}`);
  const draft = await stageCandidatePayload(built.plan, input, publisher);
  const result = await finalizeCandidatePayload(draft, input, publisher);
  await store.commit(built.plan);
  const view = await open(result.envelope.rootObject, store.reader, IDENTITY);
  return view.withPublishedParent(publishedParentOf(result));
}

async function finalizePlan(
  plan: CandidatePublicationPlan,
  store: HarnessPublicationStore,
  operationId: string,
) {
  const input = pubInput(operationId);
  return finalizeCandidatePayload(await stageCandidatePayload(plan, input, store), input, store);
}


// ── lifecycle ────────────────────────────────────────────────────────────────

describe('bounded layers', () => {
  test('create, update, delete and rename round-trip through published roots', async () => {
    const store = new MemStore();
    const publisher = new HarnessPublicationStore();
    const capture0 = audited(snap(dirE('d'), fileE('d/a.txt', 'alpha'), fileE('d/empty', ''), symE('link', 'd/a.txt')), 0);
    const r0 = await build(capture0)
    const v0 = await publishAndOpen(r0, store, publisher);
    expect(r0.view.own.t).toBe('base');
    expect(r0.plan.expectedParentRootId).toBeNull();
    expect(v0.cut).toBe(capture0.cut);
    expect(v0.stat('d/a.txt')).toMatchObject({ kind: 'file', mode: 0o644, size: 5 });
    expect(v0.stat('d/empty')).toMatchObject({ kind: 'file', size: 0 });
    expect(v0.stat('link')).toEqual({ kind: 'symlink', mode: 0o777, ino: v0.stat('link')!.ino, target: 'd/a.txt' });
    expect(await v0.readRange('d/empty', 0, 16)).toHaveLength(0);
    expect(v0.readdir('')).toEqual(['d', 'link']);
    expect(v0.readdir('d')).toEqual(['a.txt', 'empty']);
    expect(v0.stat('missing')).toBeNull();

    // Update: same inode, new bytes, newest layer wins.
    const ino = v0.entryAt('d/a.txt')!.ino;
    const capture1 = audited(
      snap(dirE('d'), fileE('d/a.txt', 'alphabet!', { ino }), fileE('d/empty', ''), symE('link', 'd/a.txt')),
      1,
    );
    const r1 = await build(capture1, v0)
    expect(r1.plan.expectedParentRootId).toBe(publishedParentInfo(v0.parentToken!).envelopeId);
    const v1 = await publishAndOpen(r1, store, publisher);
    expect(v1.cut).toBe(capture1.cut);
    expect(new TextDecoder().decode(await v1.readRange('d/a.txt', 0, 64))).toBe('alphabet!');

    // Rename: the old path is tombstoned; the inode survives under the new
    // one. `stat` answers a view-local identity, the doc the stored number.
    const r2 = await build(audited(snap(dirE('d'), fileE('d/b.txt', 'alphabet!', { ino }), fileE('d/empty', ''), symE('link', 'd/a.txt')), 2),
    v1,)
    const v2 = await publishAndOpen(r2, store, publisher);
    expect(v2.stat('d/a.txt')).toBeNull();
    expect(v2.stat('d/b.txt')).toMatchObject({ kind: 'file', size: 9 });
    expect(v2.entryAt('d/b.txt')).toMatchObject({ kind: 'file', ino, size: 9 });
    expect(v2.readdir('d')).toEqual(['b.txt', 'empty']);

    // Delete, then recreate the SAME path two checkpoints later: the newest
    // layer must win over the older tombstone.
    const r3 = await build(audited(snap(dirE('d'), fileE('d/empty', ''), symE('link', 'd/a.txt')), 3), v2)
    const v3 = await publishAndOpen(r3, store, publisher);
    expect(v3.stat('d/b.txt')).toBeNull();
    const r4 = await build(audited(snap(dirE('d'), fileE('d/b.txt', 'back again', { ino: ino + 50 }), fileE('d/empty', ''), symE('link', 'd/a.txt')), 4),
    v3,)
    const v4 = await publishAndOpen(r4, store, publisher);
    expect(new TextDecoder().decode(await v4.readRange('d/b.txt', 0, 32))).toBe('back again');

    // Determinism: rebuilding the SAME state publishes the same root bytes.
    const twinEntries = [dirE('d'), fileE('d/a.txt', 'alpha'), fileE('d/empty', ''), symE('link', 'd/a.txt')];
    const twinA = await build(audited(snap(...twinEntries), 0));
    const twinB = await build(audited(snap(...twinEntries.map((e) => ({ ...e }))), 0));
    expect(twinA.view.rootId).toBe(twinB.view.rootId);
  });

  test('round-trips POSIX metadata and rejects malformed journal metadata before staging', async () => {
    const metadata = {
      uid: 4242,
      gid: 4343,
      atimeNs: '1700000000000000000',
      mtimeNs: '1700000001000000000',
      ctimeNs: '1700000002000000000',
      xattrs: { 'user.color': 'Ymx1ZQ==', 'user.empty': '' },
    };
    const store = new MemStore();
    const captured = verifiedJournalCapture([
      { ...dirE('d'), metadata },
      { ...fileE('d/file', 'contents'), metadata },
      { ...symE('shortcut', 'd/file'), metadata },
    ], 81);

    const built = await build(captured);
    await store.commit(built.plan);
    const restored = await store.openHead();
    expect(restored.stat('d')?.metadata).toEqual(metadata);
    expect(restored.stat('d/file')?.metadata).toEqual(metadata);
    expect(restored.stat('shortcut')?.metadata).toEqual(metadata);
    expect(restored.entryAt('d/file')?.metadata).toEqual(metadata);

    const exposed = restored.stat('d/file');
    if (exposed?.metadata === undefined) throw new Error('missing restored metadata');
    expect(exposed.metadata.xattrs).not.toBe(metadata.xattrs);
    expect(restored.stat('d/file')?.metadata?.xattrs['user.color']).toBe('Ymx1ZQ==');

    expect(() => verifiedJournalCapture([
      {
        ...fileE('invalid', 'contents'),
        metadata: { ...metadata, xattrs: { 'user.invalid': 'not-base64!' } },
      },
    ], 82)).toThrow('invalid xattr value');
  });

  test('the root commits the format tag and an exact, audit-only advancing cut', async () => {
    const store = new MemStore();
    const publisher = new HarnessPublicationStore();
    const firstCapture = audited(snap(fileE('f', 'one')), 10);
    const r0 = await build(firstCapture)
    const parent = await publishAndOpen(r0, store, publisher);
    await expect(build(audited(snap(fileE('f', 'two')), 10), parent)).rejects.toThrow(/does not advance/);
    const nextCapture = audited(snap(fileE('f', 'two')), 17);
    const r1 = await build(nextCapture, parent)
    const rootBytes = await readStagedCandidateObjectForTest(r1.plan.root);
    expect(JSON.parse(new TextDecoder().decode(rootBytes))).toMatchObject({
      v: 1,
      fmt: 'bounded-layers/v1',
      cut: nextCapture.cut,
    });
    expect(r1.plan.capturedCut.cut).toBe(String(nextCapture.cut));
  });

  test('an unpublished parent cannot be reused structurally', async () => {
    const seed = await build(audited(snap(fileE('seed.txt', 'seed')), 0));
    await expect(
      build(audited(snap(fileE('seed.txt', 'child')), 1), seed.view),
    ).rejects.toThrow(/unpublished parent/);
  });

  test('an empty first capture is an empty base, not an error', async () => {
    const store = new MemStore();
    const r0 = await build(audited(new Map(), 0))
    expect(r0.view.own.t).toBe('base');
    expect(r0.view.depth).toBe(1);
    await store.commit(r0.plan);
    const view = await store.openHead();
    expect(view.stat('anything')).toBeNull();
    expect(view.readdir('')).toEqual([]);
  });

  test('hardlinks share one inode and one stored chunk', async () => {
    const store = new MemStore();
    const publisher = new HarnessPublicationStore();
    const content = enc.encode('shared inode bytes');
    const ino = nextIno++;
    const r0 = await build(audited(snap(fileE('a', content, { ino }), fileE('b', content, { ino })), 0))
    const view = await publishAndOpen(r0, store, publisher);

    // One chunk object serves both paths: the base root and ONE payload.
    expect(store.map.size).toBe(2);
    expect(store.map.has(objectKey(sha256Hex(content)))).toBe(true);
    expect(view.stat('a')!.ino).toBe(view.stat('b')!.ino);
    expect(await view.readRange('a', 0, content.length)).toEqual(content);
    expect(await view.readRange('b', 0, content.length)).toEqual(content);

    // A rewrite of the shared inode changes BOTH paths' bytes next generation.
    const updated = enc.encode('SHARED inode bytes');
    const r1 = await build(audited(snap(fileE('a', updated, { ino }), fileE('b', updated, { ino })), 1), view)
    const v1 = await publishAndOpen(r1, store, publisher);
    expect(await v1.readRange('b', 0, updated.length)).toEqual(updated);
  });

  test('sparse logical bytes survive; holes cost nothing and read as zeros', async () => {
    const store = new MemStore();
    const size = 100 * MIB;
    const runA: SparseRun = { offset: 1024, bytes: enc.encode('A'.repeat(4096)) };
    const runB: SparseRun = { offset: 99 * MIB, bytes: enc.encode('B'.repeat(8192)) };
    const r0 = await build(audited(snap(sparseE('big', size, [runA, runB])), 0))
    await store.commit(r0.plan);

    // Stored bytes stay proportional to what was TOUCHED: each run
    // materializes at most its containing chunk; untouched spans cost nothing.
    expect(planMovedBytes(r0.plan)).toBeLessThan(2 * CHUNK_SIZE + 24 * 1024);
    const storedBytes = [...store.map.values()].reduce((sum, b) => sum + b.byteLength, 0);
    expect(storedBytes).toBeLessThan(2 * CHUNK_SIZE + 24 * 1024);

    const view = await store.openHead();
    expect(view.stat('big')!.size).toBe(size);

    // A run reads back exactly, including its partial-chunk edges.
    const aroundA = await view.readRange('big', 1000, 4144);
    expect(aroundA[23]).toBe(0);
    expect(aroundA[24]).toBe('A'.charCodeAt(0));
    expect(aroundA[24 + 4096]).toBe(0);
    expect(aroundA.slice(24, 24 + 4096).every((b) => b === 'A'.charCodeAt(0))).toBe(true);

    // The deep middle is a hole: ZERO fetches, zeros out. The window over a
    // 100 MiB logical file stays bounded to intersecting chunks (none here).
    store.resetCounters();
    const holeWindow = await view.readRange('big', 50 * MIB, MIB);
    expect(holeWindow.byteLength).toBe(MIB);
    expect(holeWindow.every((b) => b === 0)).toBe(true);
    expect(store.gets).toBe(0);

    // Past-EOF spans truncate like pread.
    expect(await view.readRange('big', size - 10, 1000)).toHaveLength(10);
    expect(await view.readRange('big', size + 10, 100)).toHaveLength(0);
  });

  test('a placeholder is planned from the chunk list, and a read reports what it amplified', async () => {
    // WHAT A LAZY RESTORE READS AT ATTACH: geometry, from documents `open()`
    // already fetched. The extent list of a sparse file says where its bytes
    // are without touching one of them, which is what lets a wake register a
    // 100 MiB placeholder for free.
    const store = new MemStore();
    const size = 100 * MIB;
    const runA: SparseRun = { offset: 1024, bytes: enc.encode('A'.repeat(4096)) };
    const built = await build(audited(snap(sparseE('big', size, [runA])), 0));
    await store.commit(built.plan);
    const view = await store.openHead();

    const extents = view.extents('big');
    expect(extents.filter((extent) => extent.kind === 'data')).toHaveLength(1);
    const data = extents.find((extent) => extent.kind === 'data')!;
    expect(data.offset).toBeLessThanOrEqual(1024);
    expect(data.offset + data.length).toBeGreaterThanOrEqual(1024 + 4096);
    expect(extents.reduce((sum, extent) => sum + extent.length, 0)).toBe(size);
    expect(view.work()).toEqual({ rangeGets: 0, bytesFetched: 0, bytesRequested: 0 });

    // AND WHAT A PAGE-IN COSTS: one chunk fetched for a 4 KiB ask. The
    // difference between the two figures is the amplification a hydrate bound
    // is stated in, which is why the row carries both.
    store.resetCounters();
    await view.readRange('big', 1024, 4096);
    const work = view.work();
    expect(work.rangeGets).toBe(store.gets);
    expect(work.bytesRequested).toBe(4096);
    expect(work.bytesFetched).toBeGreaterThanOrEqual(4096);
    expect(work.bytesFetched).toBeLessThanOrEqual(CHUNK_SIZE);

    // A hole costs nothing, and says so in the row it reports.
    await view.readRange('big', 50 * MIB, MIB);
    expect(view.work().rangeGets).toBe(work.rangeGets);
    expect(view.work().bytesRequested).toBe(4096 + MIB);
  });

  test('a 1 TiB hole uses one exact extent, not one chunk document per hole', async () => {
    const size = 1024 ** 4;
    const built = await build(audited(snap(sparseE('terabyte-hole', size, [])), 0));
    const layerBytes = await readStagedCandidateObjectForTest(built.plan.root);
    const layer = decodeJson(LayerDocSchema, 'terabyte base', layerBytes);
    const entry = layer.entries[0];
    if (entry === undefined || entry.kind !== 'file') throw new Error('missing terabyte file entry');
    expect(entry.chunks).toEqual([{ hole: true, size }]);
    expect(layerBytes.byteLength).toBeLessThan(1024);
    expect(planMovedBytes(built.plan)).toBeLessThan(3 * 1024);
  });


  test('a sealed 1 TiB all-hole file stays constant metadata with zero source reads', async () => {
    const size = 1024 ** 4;
    const entries = withJournalMetadata([
      dirE('sealed'),
      {
        path: 'sealed/hole.bin',
        kind: 'file',
        mode: 0o644,
        ino: nextIno++,
        content: { kind: 'sealed', size, sourceId: 'sealed-hole', extents: [] },
      },
    ]);
    let reads = 0;
    const capture = issueVerifiedJournalCapture({
      cut: 0,
      generation: 0,
      entries,
      identity: { captureId: 'sealed-cap', epoch: '7', baseRevision: '8', stableStageHandle: 'sealed-stage' },
      manifestSha256: manifestSha256({ mechanism: 'mutation-journal', cut: 0, generation: 0, entries }),
      sealedReader: {
        read: async () => {
          reads++;
          throw new Error('all-hole sealed capture must not touch its source');
        },
      },
    });
    const entry = capture.entries.find((candidate) => candidate.path === 'sealed/hole.bin')!;

    expect(MAX_SEALED_EXTENT_BYTES).toBe(CHUNK_SIZE);
    expect(await readCaptureRange(capture, entry, size - 32, 32)).toEqual(new Uint8Array(32));
    expect(reads).toBe(0);
    const built = await build(capture);
    expect(reads).toBe(0);

    const layerBytes = await readStagedCandidateObjectForTest(built.plan.root);
    const layer = decodeJson(LayerDocSchema, 'sealed terabyte base', layerBytes);
    const file = layer.entries.find((candidate) => candidate.path === 'sealed/hole.bin');
    if (file === undefined || file.kind !== 'file') throw new Error('missing sealed hole entry');
    expect(file.chunks).toEqual([{ hole: true, size }]);
    expect(layerBytes.byteLength).toBeLessThan(1024);
  });

  test('sealed source reads are chunk-bounded, never file-sized', async () => {
    const first = new Uint8Array(MAX_SEALED_EXTENT_BYTES).fill(1);
    const second = new Uint8Array(MAX_SEALED_EXTENT_BYTES).fill(2);
    const entries = withJournalMetadata([
      dirE('sealed'),
      {
        path: 'sealed/two-chunks.bin',
        kind: 'file',
        mode: 0o644,
        ino: nextIno++,
        content: {
          kind: 'sealed',
          size: first.byteLength + second.byteLength,
          sourceId: 'sealed-two',
          extents: [
            { offset: 0, length: first.byteLength, sha256: sha256Hex(first) },
            { offset: first.byteLength, length: second.byteLength, sha256: sha256Hex(second) },
          ],
        },
      },
    ]);
    const reads: number[] = [];
    const capture = issueVerifiedJournalCapture({
      cut: 0,
      generation: 0,
      entries,
      identity: { captureId: 'sealed-two-cap', epoch: '7', baseRevision: '8', stableStageHandle: 'sealed-two-stage' },
      manifestSha256: manifestSha256({ mechanism: 'mutation-journal', cut: 0, generation: 0, entries }),
      sealedReader: {
        read: async (_sourceId, offset, length) => {
          reads.push(length);
          const source = offset === 0 ? first : second;
          return source.slice(0, length);
        },
      },
    });

    const built = await build(capture);
    expect(reads).toEqual([MAX_SEALED_EXTENT_BYTES, MAX_SEALED_EXTENT_BYTES]);
    expect(reads.every((length) => length <= MAX_SEALED_EXTENT_BYTES)).toBe(true);
    expect(reads.reduce((total, length) => total + length, 0)).toBe(2 * MAX_SEALED_EXTENT_BYTES);
    expect(planMovedBytes(built.plan)).toBeLessThanOrEqual(2 * MAX_SEALED_EXTENT_BYTES + 8192);
  });
  test('dense zeros and sparse holes canonicalize to ONE root', async () => {
    const zeros = new Uint8Array(CHUNK_SIZE);
    const sparseRoot = await build(audited(snap(sparseE('z.bin', CHUNK_SIZE, [], { ino: 5 })), 0))
    const denseRoot = await build(audited(snap(fileE('z.bin', zeros, { ino: 5 })), 0))
    expect(sparseRoot.view.rootId).toBe(denseRoot.view.rootId);
    // Neither representation stages a payload for the all-zero chunk: the
    // base root is the only object.
    expect(denseRoot.plan.dependencies).toHaveLength(0);

    // Regression: a hole hash in the parent never suppresses a real payload —
    // and after canonicalization there is no dense-zero payload to suppress.
    const store = new MemStore();
    const publisher = new HarnessPublicationStore();
    const parent = await publishAndOpen(sparseRoot, store, publisher);
    const child = await build(audited(snap(sparseE('z.bin', CHUNK_SIZE, [{ offset: 16, bytes: enc.encode('x') }], { ino: 5 })), 1),
    parent,)
    const served = await publishAndOpen(child, store, publisher);
    const out = await served.readRange('z.bin', 0, 40);
    expect(out.slice(16, 17)).toEqual(enc.encode('x'));
    expect(out[0]).toBe(0);
  });

  test('unchanged chunks are reused, not rewritten', async () => {
    const store = new MemStore();
    const publisher = new HarnessPublicationStore();
    const chunk = (fill: number) => new Uint8Array(CHUNK_SIZE).fill(fill);
    const original = new Uint8Array([...chunk(1), ...chunk(2), ...chunk(3)]);
    const ino = nextIno++;
    const r0 = await build(audited(snap(fileE('data.bin', original, { ino })), 0))
    const parent = await publishAndOpen(r0, store, publisher);
    const firstHashes = [...r0.view.chunkHashes];

    // Rewrite ONLY the middle chunk.
    const edited = new Uint8Array(original);
    edited.set(enc.encode('edited middle'), CHUNK_SIZE + 16);
    const r1 = await build(audited(snap(fileE('data.bin', edited, { ino })), 1), parent)
    const afterEdit = await publishAndOpen(r1, store, publisher);

    const writtenKeys = r1.plan.dependencies.map((object) => object.ref.key);
    for (const key of [firstHashes[0], firstHashes[2]].map(objectKey)) {
      expect(writtenKeys).not.toContain(key);
    }
    // One new chunk payload; the delta travels in the root.
    expect(writtenKeys).toHaveLength(1);
    expect(planMovedBytes(r1.plan)).toBeLessThan(CHUNK_SIZE + 8192);

    // An UNCHANGED tick costs the root object alone and reuses the layers.
    const r2 = await build(audited(snap(fileE('data.bin', edited, { ino })), 2), afterEdit);
    expect(r2.plan.dependencies).toHaveLength(0);
    expect(planMovedBytes(r2.plan)).toBe(Number(r2.plan.root.ref.byteLength));
    expect(r2.view.layers).toEqual(r1.view.layers);

    expect(await afterEdit.readRange('data.bin', CHUNK_SIZE + 16, 13)).toEqual(enc.encode('edited middle'));
    expect(await afterEdit.readRange('data.bin', 0, 4)).toEqual(new Uint8Array([1, 1, 1, 1]));
    expect(await afterEdit.readRange('data.bin', 2 * CHUNK_SIZE, 4)).toEqual(new Uint8Array([3, 3, 3, 3]));
  });

  // ── the dirty-window overlay ─────────────────────────────────────────────
  //
  // Cells 6.14 and 6.15 measured the fixed 512 KiB grid: a 64 KiB write
  // re-chunked its whole 64 MiB file, and 64 random pages of a 64 MiB
  // database put 26,798,013 bytes against a 4,194,304-byte bound
  // (2026-09-05). A file the fence stages as windows now re-chunks only the
  // 16 KiB cells the writes touched; the rest of each cell keeps its parent's
  // object by range.

  /** One window-staged capture and the lengths its stage was asked for. */
  interface WindowedCapture {
    readonly capture: AuditedCapture;
    readonly reads: number[];
  }

  /** A partial sealed capture of one file whose stage holds `windows` of
   *  `bytes`, with `dirty` the ranges writes touched. */
  function windowedCapture(
    path: string,
    ino: number,
    bytes: Uint8Array,
    windows: readonly { offset: number; length: number }[],
    dirty: readonly { offset: number; length: number }[],
    cut: number,
    size = bytes.byteLength,
  ): WindowedCapture {
    const reads: number[] = [];
    const extents = windows.flatMap((window) => {
      const pieces: { offset: number; length: number; sha256: string }[] = [];
      for (let at = window.offset; at < window.offset + window.length; at += MAX_SEALED_EXTENT_BYTES) {
        const length = Math.min(MAX_SEALED_EXTENT_BYTES, window.offset + window.length - at);
        pieces.push({ offset: at, length, sha256: sha256Hex(bytes.subarray(at, at + length)) });
      }
      return pieces;
    });
    const entries = withJournalMetadata([
      { path, kind: 'file', mode: 0o644, ino, content: { kind: 'sealed', size, sourceId: path, extents, dirty } },
    ]);
    const capture = { mechanism: 'mutation-journal' as const, cut, generation: 0, entries };
    return {
      reads,
      capture: issueVerifiedJournalCapture({
        ...capture,
        identity: { captureId: `window-${cut}`, epoch: '7', baseRevision: String(cut), stableStageHandle: `window-stage-${cut}` },
        manifestSha256: manifestSha256(capture),
        sealedReader: {
          read: async (_sourceId, offset, length) => {
            reads.push(length);
            return bytes.slice(offset, offset + length);
          },
        },
        partial: true,
      }),
    };
  }

  test('a page write into a large file puts one dirty cell and keeps the rest of its chunk by range', async () => {
    const store = new MemStore();
    const publisher = new HarnessPublicationStore();
    const ino = nextIno++;
    const original = new Uint8Array(4 * CHUNK_SIZE);
    for (let at = 0; at < original.byteLength; at += 1) original[at] = (at % 251) + 1;
    const parent = await publishAndOpen(
      await build(verifiedJournalCapture([{ ...fileE('db.bin', original, { ino }) }], 0)),
      store,
      publisher,
    );
    const edited = original.slice();
    const page = 2 * CHUNK_SIZE + 5 * 4096;
    edited.fill(0xee, page, page + 4096);
    // The daemon stages the cell before the write and four dirty cells after
    // it; the builder re-chunks only the 16 KiB cell the page sits in.
    const { capture, reads } = windowedCapture(
      'db.bin', ino, edited,
      [{ offset: 2 * CHUNK_SIZE, length: 5 * 4096 + 4096 + 4 * 16 * 1024 }],
      [{ offset: page, length: 4096 }],
      1,
    );
    const built = await build(capture, parent);
    expect(built.plan.dependencies.map((object) => Number(object.ref.byteLength))).toEqual([16 * 1024]);
    expect(built.stats.bytesChunked).toBe(16 * 1024);
    expect(built.stats.wholeFiles).toBe(0);
    expect(Math.max(...reads)).toBeLessThanOrEqual(MAX_SEALED_EXTENT_BYTES);
    const entry = built.view.entryAt('db.bin');
    if (entry?.kind !== 'file') throw new Error('db.bin is not a file');
    const cell = parent.entryAt('db.bin');
    if (cell?.kind !== 'file' || cell.chunks.length !== 4) throw new Error('the parent holds four chunks');
    const third = cell.chunks[2]!;
    if (isHoleExtent(third)) throw new Error('the third chunk is stored');
    expect(entry.chunks).toEqual([
      cell.chunks[0], cell.chunks[1],
      { hash: third.hash, size: 16 * 1024, offset: 0, length: CHUNK_SIZE },
      { hash: sha256Hex(edited.subarray(2 * CHUNK_SIZE + 16 * 1024, 2 * CHUNK_SIZE + 32 * 1024)), size: 16 * 1024 },
      { hash: third.hash, size: CHUNK_SIZE - 32 * 1024, offset: 32 * 1024, length: CHUNK_SIZE },
      cell.chunks[3],
    ]);
    // The hand-back names the dirty-cell grid, so the daemon's next window
    // starts at the cell before a write rather than the 512 KiB chunk before it.
    const cells = Array.from({ length: (4 * CHUNK_SIZE) / (16 * 1024) }, (_, index) => index * 16 * 1024);
    expect(built.handback.files).toEqual([{ ino: String(ino), path: 'db.bin', size: 4 * CHUNK_SIZE, boundaries: cells }]);
    expect(built.handback.maxChunkBytes).toBe(16 * 1024);

    // The published root serves the edited bytes across every seam, and a
    // read inside a range part fetches its object once, not once per part.
    const view = await publishAndOpen(built, store, publisher);
    expect(await view.readRange('db.bin', 0, edited.byteLength)).toEqual(edited);
    store.resetCounters();
    const fetchedBefore = view.work().bytesFetched;
    await view.readRange('db.bin', 2 * CHUNK_SIZE, CHUNK_SIZE);
    expect(store.gets).toBe(2);
    expect(view.work().bytesFetched - fetchedBefore).toBe(CHUNK_SIZE + 16 * 1024);

    // A whole-file re-chunk next generation reproduces the grid objects: the
    // range parts fold back into whole ones and only the changed cell is new.
    const rewritten = await build(verifiedJournalCapture([{ ...fileE('db.bin', edited, { ino }) }], 2), view);
    const after = rewritten.view.entryAt('db.bin');
    if (after?.kind !== 'file') throw new Error('db.bin is not a file');
    expect(after.chunks.map((part) => isHoleExtent(part) ? 'hole' : part.offset ?? 'whole')).toEqual(['whole', 'whole', 'whole', 'whole']);
    expect(rewritten.plan.dependencies.map((object) => Number(object.ref.byteLength))).toEqual([CHUNK_SIZE]);
  });

  test('a truncate with no writes cuts the parent\'s parts; a size grown by truncate is a hole', async () => {
    const store = new MemStore();
    const publisher = new HarnessPublicationStore();
    const ino = nextIno++;
    const original = new Uint8Array(CHUNK_SIZE + 4096).fill(7);
    const parent = await publishAndOpen(
      await build(verifiedJournalCapture([{ ...fileE('t.bin', original, { ino }) }], 0)),
      store,
      publisher,
    );
    const shorter = await build(windowedCapture('t.bin', ino, original, [], [], 1, 100).capture, parent);
    expect(shorter.plan.dependencies).toHaveLength(0);
    const cut = await publishAndOpen(shorter, store, publisher);
    expect(cut.stat('t.bin')?.size).toBe(100);
    expect(await cut.readRange('t.bin', 0, 200)).toEqual(original.subarray(0, 100));
    const grown = await build(windowedCapture('t.bin', ino, original, [], [], 2, CHUNK_SIZE + 4096 + 8192).capture, cut);
    const view = await publishAndOpen(grown, store, publisher);
    expect(view.extents('t.bin')).toEqual([
      { kind: 'data', offset: 0, length: 100 },
      { kind: 'hole', offset: 100, length: CHUNK_SIZE + 4096 + 8192 - 100 },
    ]);
  });

  test('a renamed file staged as windows finds its parent entry through the rename', async () => {
    const store = new MemStore();
    const publisher = new HarnessPublicationStore();
    const ino = nextIno++;
    const original = new Uint8Array(2 * CHUNK_SIZE).fill(3);
    const parent = await publishAndOpen(
      await build(verifiedJournalCapture([{ ...fileE('old.bin', original, { ino }) }], 0)),
      store,
      publisher,
    );
    const edited = original.slice();
    edited.fill(9, 0, 4096);
    const windowed = windowedCapture('new.bin', ino, edited, [{ offset: 0, length: 4096 + 64 * 1024 }], [{ offset: 0, length: 4096 }], 1);
    const moved = issueVerifiedJournalCapture({
      cut: 1,
      generation: 0,
      entries: windowed.capture.entries,
      identity: { captureId: 'window-move', epoch: '7', baseRevision: '1', stableStageHandle: 'window-move-stage' },
      manifestSha256: windowed.capture.capturedCut.manifestSha256,
      sealedReader: { read: async (_sourceId, offset, length) => edited.slice(offset, offset + length) },
      partial: true,
      structural: [{ op: 'rename', from: 'old.bin', to: 'new.bin' }],
    });
    const built = await build(moved, parent);
    expect(built.plan.dependencies.map((object) => Number(object.ref.byteLength))).toEqual([16 * 1024]);
    const view = await publishAndOpen(built, store, publisher);
    expect(view.stat('old.bin')).toBeNull();
    expect(await view.readRange('new.bin', 0, edited.byteLength)).toEqual(edited);

    // Windows for a file no published entry holds cannot be merged with anything.
    const orphan = windowedCapture('orphan.bin', nextIno++, edited, [{ offset: 0, length: 4096 }], [{ offset: 0, length: 4096 }], 2);
    await expect(build(orphan.capture, view)).rejects.toThrow(/no published parent entry/);
  });

  test('a rename onto an existing name overlays the moved inode, never the name it replaced', async () => {
    const store = new MemStore();
    const publisher = new HarnessPublicationStore();
    const ino = nextIno++;
    const moving = new Uint8Array(2 * CHUNK_SIZE).fill(3);
    const replaced = new Uint8Array(2 * CHUNK_SIZE).fill(5);
    const parent = await publishAndOpen(
      await build(verifiedJournalCapture([fileE('old.bin', moving, { ino }), fileE('target.bin', replaced)], 0)),
      store,
      publisher,
    );
    const edited = moving.slice();
    edited.fill(9, 0, 4096);
    const windowed = windowedCapture('target.bin', ino, edited, [{ offset: 0, length: 4096 + 64 * 1024 }], [{ offset: 0, length: 4096 }], 1);
    const built = await build(issueVerifiedJournalCapture({
      cut: 1,
      generation: 0,
      entries: windowed.capture.entries,
      identity: { captureId: 'window-over', epoch: '7', baseRevision: '1', stableStageHandle: 'window-over-stage' },
      manifestSha256: windowed.capture.capturedCut.manifestSha256,
      sealedReader: { read: async (_sourceId, offset, length) => edited.slice(offset, offset + length) },
      partial: true,
      structural: [{ op: 'rename', from: 'old.bin', to: 'target.bin' }],
    }), parent);
    const view = await publishAndOpen(built, store, publisher);
    expect(view.stat('old.bin')).toBeNull();
    expect(await view.readRange('target.bin', 0, edited.byteLength)).toEqual(edited);
  });

  test('a renamed directory carries the entries beneath it that the fence did not name', async () => {
    const store = new MemStore();
    const publisher = new HarnessPublicationStore();
    const parent = await publishAndOpen(
      await build(verifiedJournalCapture([
        dirE('src'), fileE('src/a.txt', 'alpha'), dirE('src/deep'), fileE('src/deep/b.txt', 'beta'), fileE('keep.txt', 'kept'),
      ], 0)),
      store,
      publisher,
    );
    // The fence names the moved directory and nothing beneath it, as the
    // daemon does: a rename touches its two names, not the subtree.
    const built = await build(verifiedJournalCapture(
      [dirE('lib')], 1, { partial: true, structural: [{ op: 'rename', from: 'src', to: 'lib' }] },
    ), parent);
    const view = await publishAndOpen(built, store, publisher);
    expect(view.readdir('')).toEqual(['keep.txt', 'lib']);
    expect(view.readdir('lib')).toEqual(['a.txt', 'deep']);
    expect(new TextDecoder().decode(await view.readRange('lib/deep/b.txt', 0, 16))).toBe('beta');
    expect(view.stat('src')).toBeNull();
    expect(built.view.own.tombs).toEqual(['src', 'src/a.txt', 'src/deep', 'src/deep/b.txt']);
  });

  test('an inode number a wake reuses is not the restored file it collides with', async () => {
    // Two lifetimes: the parent's `src.txt` was inode 2 on the filesystem
    // that captured it; after a wake the container's filesystem numbers a
    // new `notes.txt` 2 as well. They are two inodes, and a restore that
    // hardlinked them would serve one file's bytes under the other's name.
    const store = new MemStore();
    const publisher = new HarnessPublicationStore();
    const parent = await publishAndOpen(
      await build(verifiedJournalCapture([fileE('src.txt', 'export const one = 1;', { ino: 2 })], 0)),
      store,
      publisher,
    );
    const built = await build(verifiedJournalCapture(
      [fileE('notes.txt', 'generation two', { ino: 2 })], 1, { partial: true, structural: [{ op: 'create', path: 'notes.txt' }] },
    ), parent);
    const view = await publishAndOpen(built, store, publisher);
    expect(view.stat('notes.txt')!.ino).not.toBe(view.stat('src.txt')!.ino);
    expect(new TextDecoder().decode(await view.readRange('src.txt', 0, 64))).toBe('export const one = 1;');
    expect(new TextDecoder().decode(await view.readRange('notes.txt', 0, 64))).toBe('generation two');
  });

  test('a rewrite through one name of a hardlinked inode reaches every name', async () => {
    const store = new MemStore();
    const publisher = new HarnessPublicationStore();
    const ino = nextIno++;
    const parent = await publishAndOpen(
      await build(verifiedJournalCapture([fileE('a', 'shared bytes', { ino }), fileE('b', 'shared bytes', { ino })], 0)),
      store,
      publisher,
    );
    // The fence reports the name the write used; the inode is both names.
    const built = await build(verifiedJournalCapture(
      [fileE('a', 'SHARED bytes', { ino, mode: 0o600 })], 1, { partial: true },
    ), parent);
    const view = await publishAndOpen(built, store, publisher);
    expect(view.stat('a')!.ino).toBe(view.stat('b')!.ino);
    expect(view.stat('b')).toMatchObject({ mode: 0o600, size: 12 });
    expect(new TextDecoder().decode(await view.readRange('b', 0, 32))).toBe('SHARED bytes');
    expect(built.view.own.entries.map((entry) => entry.path)).toEqual(['a', 'b']);
  });
  test('emitted buffers are copies: mutating the capture afterwards changes nothing', async () => {
    const store = new MemStore();
    const buffer = enc.encode('mutable source');
    const built = await build(audited(snap(fileE('m.txt', buffer)), 0))
    buffer[0] ^= 0xff;
    await store.commit(built.plan);
    const view = await store.openHead();
    expect(await view.readRange('m.txt', 0, buffer.length)).toEqual(enc.encode('mutable source'));
  });

  test('a crash before the head moves leaves the old root serving', async () => {
    const store = new MemStore();
    const publisher = new HarnessPublicationStore();
    const r0 = await build(audited(snap(fileE('state.txt', 'generation one')), 0))
    const parent = await publishAndOpen(r0, store, publisher);

    // Objects land; the process dies BEFORE the head CAS moves.
    const r1 = await build(audited(snap(fileE('state.txt', 'generation two')), 1), parent)
    await store.stage(r1.plan);

    const survived = await store.openHead();
    expect(survived.rootId).toBe(r0.view.rootId);
    expect(await survived.readRange('state.txt', 0, 32)).toEqual(enc.encode('generation one'));

    // Once published, the new root serves from its own immutable objects.
    const promoted = await publishAndOpen(r1, store, publisher);
    expect(await promoted.readRange('state.txt', 0, 32)).toEqual(enc.encode('generation two'));

    // The old root is intact underneath: retirement is GC-only.
    const old = await open(oldRef(r0.view), store.reader, IDENTITY);
    expect(await old.readRange('state.txt', 0, 32)).toEqual(enc.encode('generation one'));
  });
  function oldRef(view: BoundedLayers): ImmutableObjectRef {
    return view.gcClosure()[0]!;
  }
  test('layer depth never exceeds eight; the ninth checkpoint compacts into one base', async () => {
    const store = new MemStore();
    const publisher = new HarnessPublicationStore();
    const ino = nextIno++;

    let parent: BoundedLayers | undefined;
    let preCompaction: string | undefined;
    let compactingBuilds = 0;
    const roots: ImmutableObjectRef[] = [];

    for (let generation = 0; generation <= 13; generation++) {
      const capture = audited(
        snap(fileE('log.txt', enc.encode(`generation ${generation}`), { ino })),
        generation,
      );
      const built = await build(capture, parent)
      expect(built.view.depth).toBeLessThanOrEqual(MAX_LAYER_DEPTH);
      expect(built.view.cut).toBe(capture.cut);
      roots.push(built.plan.root.ref);
      const serving = await publishAndOpen(built, store, publisher);

      if (parent !== undefined && parent.depth === MAX_LAYER_DEPTH) {
        // This was the ninth checkpoint: everything collapsed onto ONE base.
        compactingBuilds++;
        expect(built.view.depth).toBe(1);
        expect(built.view.own.t).toBe('base');
        expect(preCompaction).toBeDefined();
        expect(resolvedText(serving)).toBe(preCompaction!);
        expect(new TextDecoder().decode(await serving.readRange('log.txt', 0, 64)))
          .toBe(`generation ${generation}`);
      }
      if (built.view.depth === MAX_LAYER_DEPTH) {
        preCompaction = resolvedText(serving);
      }
      parent = serving;
    }

    expect(compactingBuilds).toBe(1);
    expect(parent!.depth).toBeLessThanOrEqual(MAX_LAYER_DEPTH);
    // Every historical root still opens by immutable ref: retirement is GC-only.
    for (const ref of roots) {
      expect((await open(ref, store.reader, IDENTITY)).depth).toBeLessThanOrEqual(MAX_LAYER_DEPTH);
    }
  });

  test('a range read stays bounded to the intersecting chunks', async () => {
    const store = new MemStore();
    const chunk = (fill: number) => new Uint8Array(CHUNK_SIZE).fill(fill);
    const r0 = await build(audited(snap(fileE('wide.bin', new Uint8Array([...chunk(7), ...chunk(8), ...chunk(9), ...chunk(10)]))), 0))
    await store.commit(r0.plan);
    const view = await store.openHead();

    // One small window in the middle: exactly ONE chunk crosses the wire.
    store.resetCounters();
    expect(await view.readRange('wide.bin', CHUNK_SIZE + 8, 16)).toEqual(new Uint8Array(16).fill(8));
    expect(store.gets).toBe(1);
    expect(store.fetchedBytes).toBeLessThanOrEqual(CHUNK_SIZE);

    // A span across a boundary fetches exactly the two chunks it touches.
    store.resetCounters();
    await view.readRange('wide.bin', CHUNK_SIZE - 4, 8);
    expect(store.gets).toBe(2);
  });

  test('tampered objects refuse loudly through the shared digest seam', async () => {
    const content = enc.encode('tamper me');

    // A corrupted chunk payload fails its digest at read time.
    const chunkStore = new MemStore();
    const rc = await build(audited(snap(fileE('f.bin', content)), 0))
    await chunkStore.commit(rc.plan);
    const view = await chunkStore.openHead();
    const payload = chunkStore.map.get(objectKey(sha256Hex(content)))!;
    payload[0] ^= 0xff;
    await expect(view.readRange('f.bin', 0, content.length)).rejects.toThrow(/sha256 mismatch|could not be read/);

    // A corrupted older layer document refuses at open time.
    const layerStore = new MemStore();
    const layerPublisher = new HarnessPublicationStore();
    const rl0 = await build(audited(snap(fileE('g.bin', content)), 0));
    const rl = await build(audited(snap(fileE('g.bin', enc.encode('tamper me more'))), 1), await publishAndOpen(rl0, layerStore, layerPublisher));
    await layerStore.commit(rl.plan);
    const layerDoc = layerStore.map.get(rl.view.layers[0].key)!;
    layerDoc[0] ^= 0xff;
    await expect(open(rl.view.rootRef, layerStore.reader, IDENTITY)).rejects.toThrow(/could not be read/);

    // A corrupted root object refuses before anything resolves.
    const rootStore = new MemStore();
    const rr = await build(audited(snap(fileE('h.bin', content)), 0))
    await rootStore.commit(rr.plan);
    const rootObj = rootStore.map.get(objectKey(rr.view.rootId))!;
    rootObj[1] ^= 0xff;
    await expect(open(rr.view.rootRef, rootStore.reader, IDENTITY)).rejects.toThrow(/could not be read/);
  });

  test('open refuses files whose stored geometry disagrees with their docs', async () => {
    const good = enc.encode('geometry');
    const store = new MemStore();

    /** Wind a hand-made base root into the store, bypassing build. */
    const plantCorrupt = (entry: Canon): Uint8Array => {
      const rootBytes = encodeCanonical({
        v: 1, fmt: 'bounded-layers/v1', cut: 0, t: 'base', entries: [entry], tombs: [], layers: [],
      });
      store.map.set(objectKey(sha256Hex(rootBytes)), rootBytes);
      return rootBytes;
    };

    // Declared size exceeds the chunks' span.
    const mismatched = plantCorrupt({
      kind: 'file', path: 'bad-size', mode: 0o644, ino: 1, inoCut: 0, size: 99,
      chunks: [{ hash: sha256Hex(good), size: good.byteLength }],
    });
    await expect(open(mismatched, store.reader, IDENTITY)).rejects.toThrow(/declares size 99 but its 1 chunk\(s\) hold 8/);

    // A stored chunk above CHUNK_SIZE would make one bounded read fetch an
    // object of whatever size the layer declared.
    const oversized = new Uint8Array(CHUNK_SIZE + 1).fill(9);
    const badGeometry = plantCorrupt({
      kind: 'file', path: 'bad-geom', mode: 0o644, ino: 2, inoCut: 0, size: CHUNK_SIZE + 1,
      chunks: [{ hash: sha256Hex(oversized), size: CHUNK_SIZE + 1 }],
    });
    await expect(open(badGeometry, store.reader, IDENTITY)).rejects.toThrow(/above the 524288-byte bound/);

    // A hole carries no digest; one that does is no shape the wire has.
    const badHole = plantCorrupt({
      kind: 'file', path: 'bad-hole', mode: 0o644, ino: 3, inoCut: 0, size: CHUNK_SIZE,
      chunks: [{ hash: sha256Hex(good), size: CHUNK_SIZE, hole: true }],
    });
    await expect(open(badHole, store.reader, IDENTITY)).rejects.toThrow(/does not match its schema/);
  });

  test('open refuses a hash-valid root whose oldest layer is not the sole base', async () => {
    const store = new MemStore();
    const wind = (doc: Canon) => {
      const bytes = encodeCanonical(doc);
      const hash = sha256Hex(bytes);
      const ref = { key: objectKey(hash), byteLength: String(bytes.byteLength), sha256: hash };
      store.map.set(ref.key, bytes);
      return ref;
    };
    const baseRef = wind({ v: 1, fmt: 'bounded-layers/v1', cut: 0, t: 'base', entries: [], tombs: [], layers: [] });
    const deltaRef = wind({ v: 1, fmt: 'bounded-layers/v1', cut: 1, t: 'delta', entries: [], tombs: [], layers: [baseRef] });
    // A delta as the oldest layer: nothing beneath it holds the tree.
    const forgedRoot = encodeCanonical({
      v: 1, fmt: 'bounded-layers/v1', cut: 2, t: 'delta', entries: [], tombs: [], layers: [deltaRef],
    });
    await expect(open(forgedRoot, store.reader, IDENTITY)).rejects.toThrow(/must be the base/);
    // Two bases in one chain: the newer one is not a delta over the older.
    const newerBaseRef = wind({ v: 1, fmt: 'bounded-layers/v1', cut: 1, t: 'base', entries: [], tombs: ['removed'], layers: [] });
    const twoBases = encodeCanonical({
      v: 1, fmt: 'bounded-layers/v1', cut: 2, t: 'delta', entries: [], tombs: [], layers: [newerBaseRef, baseRef],
    });
    await expect(open(twoBases, store.reader, IDENTITY)).rejects.toThrow(/must be the delta/);
    // A root that calls itself a base while naming older layers, or a delta
    // naming none, is no shape the wire has.
    await expect(open(encodeCanonical({
      v: 1, fmt: 'bounded-layers/v1', cut: 2, t: 'base', entries: [], tombs: [], layers: [baseRef],
    }), store.reader, IDENTITY)).rejects.toThrow(/does not match its schema/);
    await expect(open(encodeCanonical({
      v: 1, fmt: 'bounded-layers/v1', cut: 2, t: 'delta', entries: [], tombs: [], layers: [],
    }), store.reader, IDENTITY)).rejects.toThrow(/does not match its schema/);
  });

  test('sparse run order normalizes deterministically and overlapping writes match logical expansion', async () => {
    const runs: SparseRun[] = [
      { offset: 6000, bytes: enc.encode('second') },
      { offset: 1000, bytes: enc.encode('first') },
    ];
    const shuffled = await build(audited(snap(sparseE('s.bin', CHUNK_SIZE * 2, runs, { ino: 42 })), 0))
    const ordered = await build(audited(snap(sparseE('s.bin', CHUNK_SIZE * 2, [...runs].reverse(), { ino: 42 })), 0))
    expect(shuffled.view.rootId).toBe(ordered.view.rootId);

    const overlapping: SparseRun[] = [
      { offset: 0, bytes: enc.encode('aaaaaa') },
      { offset: 2, bytes: enc.encode('bb') },
    ];
    const store = new MemStore();
    const built = await build(audited(snap(sparseE('t.bin', 4096, overlapping)), 0))
    await store.commit(built.plan);
    const view = await store.openHead();
    expect(await view.readRange('t.bin', 0, 4096)).toEqual(
      expandContent({ kind: 'sparse', size: 4096, runs: overlapping }),
    );
  });

  test('gcClosure names exactly the reachable objects, holes excluded', async () => {
    const store = new MemStore();
    const publisher = new HarnessPublicationStore();
    const sparse = sparseE('mix.bin', CHUNK_SIZE * 2, [{ offset: 0, bytes: enc.encode('real') }]);
    const r0 = await build(audited(snap(dirE('d'), sparse), 0))
    const v0 = await publishAndOpen(r0, store, publisher);

    const closure = v0.gcClosure();
    const keys = closure.map((r) => r.key);
    // The base root + the one materialized chunk; both holes absent.
    expect(keys).toHaveLength(2);
    for (const ref of closure) {
      expect(ref.key).toBe(objectKey(ref.sha256));
      expect(store.map.has(ref.key)).toBe(true);
    }
    expect(keys.some((k) => k === objectKey(sha256Hex(new Uint8Array(CHUNK_SIZE))))).toBe(false);

    // Reused across generations: still reachable, still listed once.
    const r1 = await build(audited(snap(dirE('d'), sparse, fileE('new.txt', 'more', { ino: 77 })), 1), v0)
    const v1 = await publishAndOpen(r1, store, publisher);
    const keys1 = v1.gcClosure().map((r) => r.key);
    expect(new Set(keys1).size).toBe(keys1.length);
    for (const key of keys1) expect(store.map.has(key)).toBe(true);
  });

  test('entryAt hands out defensive copies', async () => {
    const store = new MemStore();
    const content = enc.encode('protected');
    const r0 = await build(audited(snap(fileE('e.bin', content)), 0))
    await store.commit(r0.plan);
    const view = await store.openHead();

    const stolen = view.entryAt('e.bin')!;
    if (stolen.kind === 'file') stolen.chunks.push({ hash: '0'.repeat(64), size: 1, hole: true });
    stolen.mode = 0o777;

    const fresh = view.entryAt('e.bin')!;
    expect(fresh.mode).toBe(0o644);
    if (fresh.kind === 'file') expect(fresh.chunks).toHaveLength(1);
    expect(await view.readRange('e.bin', 0, content.length)).toEqual(content);
  });

  test('merged hands out deep copies before the next build', async () => {
    const store = new MemStore();
    const publisher = new HarnessPublicationStore();
    const original = enc.encode('ancestor stays immutable');
    const r0 = await build(audited(snap(fileE('ancestor.bin', original)), 0))
    const parent = await publishAndOpen(r0, store, publisher);

    // Mutate BOTH levels of the outward copy before the next build reads its
    // parent. If merged leaked internals, the child's base reconstruction or
    // a re-open of the published parent would now have a bogus chunk.
    const stolen = parent.merged().get('ancestor.bin')!;
    stolen.mode = 0o777;
    if (stolen.kind === 'file') stolen.chunks.push({ hash: '0'.repeat(64), size: 1, hole: true });

    const child = await build(audited(snap(fileE('ancestor.bin', original), fileE('next.bin', 'next')), 1),
    parent,)
    const reopenedChild = await publishAndOpen(child, store, publisher);
    const reopenedParent = await open(parent.rootRef, store.reader, IDENTITY);

    expect(reopenedParent.stat('ancestor.bin')!.mode).toBe(0o644);
    expect(await reopenedParent.readRange('ancestor.bin', 0, original.length)).toEqual(original);
    expect(reopenedChild.stat('ancestor.bin')!.mode).toBe(0o644);
    expect(await reopenedChild.readRange('ancestor.bin', 0, original.length)).toEqual(original);
  });
  test('hostile paths are refused at build, stat, readdir and range reads', async () => {
    expect(() => audited(snap(fileE('../escape', 'no')), 0)).toThrow(/non-canonical capture path/);
    expect(() => audited(snap(fileE('/absolute', 'no')), 0)).toThrow(/non-canonical capture path/);
    expect(() => audited(snap(fileE('a/../b', 'no')), 0)).toThrow(/non-canonical capture path/);

    const store = new MemStore();
    const r0 = await build(audited(snap(dirE('d'), fileE('d/f', 'fine')), 0))
    await store.commit(r0.plan);
    const view = await store.openHead();
    expect(() => view.stat('../d')).toThrow(/hostile path/);
    expect(() => view.readdir('../d')).toThrow(/hostile path/);
    expect(() => view.stat('/d/f')).toThrow(/hostile path/);
    await expect(view.readRange('/d/f', 0, 4)).rejects.toThrow(/hostile path/);
    await expect(view.readRange('d/f', -1, 4)).rejects.toThrow(/offset/);
  });


  // ── hardening: cost, atomicity, recovery, refusal, and the bound ──────────

  test('per-commit staging cost stays flat as the layer stack deepens', async () => {
    class CountingSink {
      stages = 0;
      readonly inner = new MemoryCandidateObjectSink();
      async stage(key: string, bytes: Uint8Array) {
        this.stages++;
        return this.inner.stage(key, bytes);
      }
    }
    const store = new MemStore();
    const publisher = new HarnessPublicationStore();
    const ino = nextIno++;
    const counts: number[] = [];
    let parent: BoundedLayers | undefined;
    for (let generation = 0; generation < 10; generation++) {
      const sink = new CountingSink();
      const built = await build(
        audited(snap(fileE('log.txt', enc.encode(`generation ${generation}`), { ino })), generation),
        parent,
        sink,
      );
      counts.push(sink.stages);
      parent = await publishAndOpen(built, store, publisher);
    }
    // One content chunk + one root (which is the layer), on every commit —
    // never one object per accumulated layer.
    expect(counts[0]).toBe(2);
    for (const count of counts) expect(count).toBe(counts[0]);
  });

  test('a reader attaching between the two durable writes sees exactly one whole generation', async () => {
    const store = new MemStore();
    const publisher = new HarnessPublicationStore();
    const ino = nextIno++;
    const stateOf = (text: string) => snap(fileE('log.txt', enc.encode(text), { ino }));
    const first = await build(audited(stateOf('first generation'), 0));
    const parent = await publishAndOpen(first, store, publisher);

    // Durable write #1: the new generation's objects land. Durable write #2:
    // the head CAS. A container replacement attaching in between must open
    // the old head and see EXACTLY the first generation — and, handed the new
    // root's ref, EXACTLY the second. Never a blend, never blank.
    const second = await build(audited(stateOf('a different second generation'), 1), parent);
    await store.stage(second.plan);

    const attachedOld = await store.openHead();
    expect(attachedOld.stat('log.txt')).not.toBeNull();
    expect(new TextDecoder().decode(await attachedOld.readRange('log.txt', 0, 64))).toBe('first generation');
    const attachedNew = await open(second.view.rootRef, store.reader, IDENTITY);
    expect(attachedNew.stat('log.txt')).not.toBeNull();
    expect(new TextDecoder().decode(await attachedNew.readRange('log.txt', 0, 64))).toBe('a different second generation');
    expect(resolvedText(attachedOld)).not.toBe(resolvedText(attachedNew));
  });

  test('a commit interrupted at each of its sub-steps re-drives idempotently', async () => {
    const store = new MemStore();
    const publisher = new HarnessPublicationStore();
    const ino = nextIno++;
    const base = await publishAndOpen(
      await build(audited(snap(fileE('log.txt', enc.encode('generation zero'), { ino })), 0)),
      store,
      publisher,
    );
    const capture1 = audited(snap(fileE('log.txt', enc.encode('generation one'), { ino })), 1);
    const reference = await build(capture1, base);
    const referenceText = resolvedText(reference.view);
    const referenceLayers = reference.view.layers.map((ref) => ref.key);
    expect(reference.plan.dependencies.length).toBeGreaterThanOrEqual(1);

    // Interrupt after 0..n staged objects: each dependency in turn, the root,
    // and the fully staged-but-head-unmoved state. Then re-drive the commit.
    const points: number[] = [0];
    reference.plan.dependencies.forEach((_object, index) => points.push(index + 1));
    points.push(reference.plan.dependencies.length + 1);
    points.push(reference.plan.dependencies.length + 2);

    for (const [pointIndex, stagedCount] of points.entries()) {
      const attempt = await build(capture1, base);
      const staged = [...attempt.plan.dependencies, attempt.plan.root];
      const headBeforeAttempt = publisher.head === null ? null : publisher.head.pointer.rootEnvelopeId;
      for (const object of staged.slice(0, stagedCount)) {
        store.map.set(object.ref.key, await readStagedCandidateObjectForTest(object));
      }
      // The interrupted commit never moved the head on its own.
      expect(publisher.head === null ? null : publisher.head.pointer.rootEnvelopeId).toBe(headBeforeAttempt);

      const redo = await build(capture1, base);
      const recovered = await publishAndOpen(redo, store, publisher);
      expect(recovered.rootId).toBe(reference.view.rootId);
      expect(recovered.layers.map((ref) => ref.key)).toEqual(referenceLayers);
      expect(resolvedText(recovered)).toBe(referenceText);
      // The index references nothing the store fails to hold: no orphaned
      // layer survives under a committed root.
      for (const ref of recovered.layers) expect(store.map.has(ref.key)).toBe(true);

      // Re-finalizing the SAME plan after success leaves the head alone.
      const headBeforeRecheck = publisher.head === null ? null : publisher.head.pointer.rootEnvelopeId;
      await finalizePlan(redo.plan, publisher, `op-recheck-${pointIndex}`);
      expect(publisher.head === null ? null : publisher.head.pointer.rootEnvelopeId).toBe(headBeforeRecheck);
    }
  });

  test('an index naming an object the store does not hold refuses, naming the absent object', async () => {
    const store = new MemStore();
    const publisher = new HarnessPublicationStore();
    const first = await build(audited(snap(fileE('f.bin', 'payload')), 0));
    const built = await build(audited(snap(fileE('f.bin', 'payload two')), 1), await publishAndOpen(first, store, publisher));
    await store.commit(built.plan);

    // A missing layer document: the wake refuses and names the absent object
    // rather than resolving to a partial tree.
    const layerRef = built.view.layers[0];
    if (layerRef === undefined) throw new Error('base layer missing');
    store.map.delete(layerRef.key);
    await expect(open(built.view.rootRef, store.reader, IDENTITY)).rejects.toThrow(layerRef.key);

    // A missing root object refuses the same way.
    const rootOnly = new MemStore();
    await expect(open(built.view.rootRef, rootOnly.reader, IDENTITY)).rejects.toThrow(objectKey(built.view.rootId));

    // A missing content chunk refuses at read time, naming its object.
    const chunkStore = new MemStore();
    const chunkBuilt = await build(audited(snap(fileE('g.bin', 'chunk payload')), 0));
    await chunkStore.commit(chunkBuilt.plan);
    const chunkView = await chunkStore.openHead();
    const entry = chunkView.entryAt('g.bin');
    if (entry === undefined || entry.kind !== 'file') throw new Error('missing file entry');
    const chunkPart = entry.chunks[0];
    if (chunkPart === undefined || isHoleExtent(chunkPart)) throw new Error('expected one stored chunk');
    chunkStore.map.delete(objectKey(chunkPart.hash));
    await expect(chunkView.readRange('g.bin', 0, 13)).rejects.toThrow(objectKey(chunkPart.hash));
  });

  test('the bound: a full stack resolves with root-plus-layer reads; one layer more refuses', async () => {
    const store = new MemStore();
    const publisher = new HarnessPublicationStore();
    const ino = nextIno++;
    let parent: BoundedLayers | undefined;
    let full: BoundedLayers | undefined;
    for (let generation = 0; generation < MAX_LAYER_DEPTH; generation++) {
      const built = await build(
        audited(snap(fileE('log.txt', enc.encode(`generation ${generation}`), { ino })), generation),
        parent,
      );
      full = await publishAndOpen(built, store, publisher);
      parent = full;
    }
    if (full === undefined) throw new Error('chain did not build');
    expect(full.depth).toBe(MAX_LAYER_DEPTH);

    // Opening the full stack crosses the wire exactly once per layer, the
    // root included.
    store.resetCounters();
    const opened = await store.openHead();
    expect(store.gets).toBe(MAX_LAYER_DEPTH);
    // Resolution itself is served from the merged map: zero further reads.
    store.resetCounters();
    expect(opened.stat('log.txt')).not.toBeNull();
    expect(opened.readdir('')).toEqual(['log.txt']);
    expect(store.gets).toBe(0);

    // Forge a root naming one MORE layer than the bound: the wake refuses.
    const extraDelta = full.layers[1];
    if (extraDelta === undefined) throw new Error('expected a delta layer to reuse');
    const forgedLayers = [extraDelta, ...full.layers];
    expect(forgedLayers).toHaveLength(MAX_LAYER_DEPTH);
    const forgedBytes = encodeCanonical({
      v: 1, fmt: 'bounded-layers/v1', cut: full.cut, t: 'delta', entries: [], tombs: [], layers: forgedLayers,
    });
    store.map.set(objectKey(sha256Hex(forgedBytes)), forgedBytes);
    const forgedRef = {
      key: objectKey(sha256Hex(forgedBytes)),
      byteLength: String(forgedBytes.byteLength),
      sha256: sha256Hex(forgedBytes),
    };
    await expect(open(forgedRef, store.reader, IDENTITY)).rejects.toThrow(/above the bound/);
  });

  // ── the shared publication boundary ────────────────────────────────────────

  test('an audited journal capture stages and finalizes end to end', async () => {
    const log = new MutationLog();
    await log.perform({ op: 'mkdir', path: 'd' });
    await log.perform({ op: 'write', path: 'd/f.txt', content: { kind: 'dense', bytes: enc.encode('published!') } });
    await log.perform({ op: 'symlink', path: 'd/link', target: 'd/f.txt' });
    const cut = log.lastSeq;
    const capture: Capture = {
      mechanism: 'mutation-journal',
      cut,
      generation: log.generation,
      entries: [...prefixState(log.entries, cut).values()],
    };
    const auditedCapture = toCapturedCut(log.entries, capture, {
      captureId: 'cap-journal', epoch: '7', baseRevision: '8', stableStageHandle: 'stage-1',
    });
    const built = await build(auditedCapture);
    expect(built.plan.format).toBe('bounded-layers/v1');
    expect(built.plan.capturedCut.cut).toBe(String(cut));

    const closureKeys = new Set(built.plan.closure.map((ref) => ref.key));
    for (const key of [built.plan.root.ref.key, ...built.plan.dependencies.map((object) => object.ref.key)]) {
      expect(closureKeys.has(key)).toBe(true);
    }

    const publicationStore = new HarnessPublicationStore();
    const result = await finalizePlan(built.plan, publicationStore, 'op-pub');
    expect(result.envelope.parentRootId).toBeNull();
    expect(result.envelope.cut.cut).toBe(String(cut));
    expect([...result.envelope.closure]).toEqual([...built.plan.closure]);

    const store = new MemStore();
    await store.stage(built.plan);
    const view = await open(result.envelope.rootObject, store.reader, IDENTITY);
    expect(view.cut).toBe(cut);
    expect(new TextDecoder().decode(await view.readRange('d/f.txt', 0, 64))).toBe('published!');
    expect(view.stat('d/link')).toMatchObject({ kind: 'symlink', target: 'd/f.txt' });
  });

  test('a second finalization naming a stale expected parent refuses and keeps the winner', async () => {
    const store = new HarnessPublicationStore();
    const first = await build(audited(snap(fileE('w.txt', 'winner')), 0));
    await finalizePlan(first.plan, store, 'op-1');
    const headAfterFirst = store.head!.pointer.rootEnvelopeId;

    const loser = await build(audited(snap(fileE('l.txt', 'loser')), 0));
    await expect(finalizePlan(loser.plan, store, 'op-loser')).rejects.toBeInstanceOf(StaleParentRefused);
    expect(store.head!.pointer.rootEnvelopeId).toBe(headAfterFirst);
  });

  test('only the published envelope that names an opened root may supply its parent', async () => {
    const store = new MemStore();
    const publisher = new HarnessPublicationStore();
    const built = await build(audited(snap(fileE('parent.txt', 'parent')), 0));
    const published = await finalizePlan(built.plan, publisher, 'op-authenticated-parent');
    await store.commit(built.plan);
    const opened = await open(published.envelope.rootObject, store.reader, IDENTITY);
    const parent = opened.withPublishedParent(publishedParentOf(published));
    const child = await build(audited(snap(fileE('parent.txt', 'child')), 1), parent);
    expect(child.plan.expectedParentRootId).toBe(published.resultRootId);

    const forged = {
      ...published,
      envelope: {
        ...published.envelope,
        rootObject: { ...published.envelope.rootObject, key: objectKey('0'.repeat(64)) },
      },
    };
    expect(() => opened.withPublishedParent(publishedParentOf(forged))).toThrow(/root|envelope|issued/);
  });
});

// ── shared-boundary helpers ──────────────────────────────────────────────────

function pubInput(operationId: string) {
  return {
    operationId,
    attemptId: `${operationId}-att`,
    boxId: 'box-pub',
    epoch: '7',
    bootId: 'boot-pub',
    expiresAt: '99999999999999',
    kind: 'tick' as const,
  };
}

/** Minimal faithful split fake: payload receives staged streams; control sees
 * only receipts, immutable metadata facts, and the head CAS. */
class HarnessPublicationStore implements CandidatePayloadStore, CandidatePublicationControl {
  readonly objects = new Map<string, Uint8Array>();
  readonly envelopes = new Map<Sha256Hex, Uint8Array>();
  readonly records: OperationRecord[] = [];
  head: { envelope: RootEnvelopeV1; pointer: HeadPointerV1 } | null = null;

  recordOperation(record: OperationRecord): void {
    this.records.push(record);
  }

  async issuePayloadGrant(intent: UploadIntent): Promise<PayloadGrant> {
    return {
      operationId: intent.operationId,
      attemptId: intent.attemptId,
      expiresAt: intent.expiresAt,
      opaque: `grant-for-${intent.exactKey}`,
    };
  }

  async uploadObject(grant: PayloadGrant, body: ReadableStream<Uint8Array>): Promise<ObjectReceipt> {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
      size += next.value.byteLength;
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const key = grant.opaque.replace('grant-for-', '');
    this.objects.set(key, bytes);
    return {
      operationId: grant.operationId,
      attemptId: grant.attemptId,
      key,
      byteLength: String(bytes.byteLength),
      sha256: sha256Hex(bytes),
      etag: `etag-${key.slice(0, 8)}`,
      verified: true,
    };
  }

  async writeEnvelope(envelope: RootEnvelopeV1, rootEnvelopeId: Sha256Hex): Promise<void> {
    if (rootEnvelopeId !== envelopeIdOf(envelope)) {
      throw new Error(`envelope key ${rootEnvelopeId} does not match canonical envelope digest`);
    }
    const bytes = envelopeBytes(envelope);
    const existing = this.envelopes.get(rootEnvelopeId);
    if (existing !== undefined) {
      if (existing.byteLength !== bytes.byteLength || !existing.every((byte, index) => byte === bytes[index])) {
        throw new Error(`immutable envelope ${rootEnvelopeId} already has different canonical bytes`);
      }
      return;
    }
    this.envelopes.set(rootEnvelopeId, bytes);
  }

  async verifyObject(ref: ImmutableObjectRef): Promise<void> {
    const bytes = this.objects.get(ref.key);
    if (bytes === undefined) throw new Error(`missing candidate object ${ref.key}`);
    if (String(bytes.byteLength) !== ref.byteLength || sha256Hex(bytes) !== ref.sha256) {
      throw new Error(`candidate object metadata mismatches ${ref.key}`);
    }
  }

  async compareAndSwapHead(envelope: RootEnvelopeV1, expected: string | null): Promise<HeadPointerV1> {
    const current = this.head?.pointer.rootEnvelopeId ?? null;
    const next = envelopeIdOf(envelope);
    if (current !== next && current !== expected) throw new StaleParentRefused(expected, current);
    if (this.head === null || current !== next) {
      this.head = { envelope, pointer: { version: 1, rootEnvelopeId: next, lastOperationId: 'op-current' } };
    }
    return this.head.pointer;
  }


  markFailed(operationId: string, failureCode: string): void {
    this.records.push({
      operationId,
      kind: 'tick',
      epoch: '7',
      bootId: 'boot-pub',
      baseRevision: '0',
      expectedParent: null,
      phase: 'failed',
      failureCode,
    });
  }
  async markComplete(): Promise<void> {}
}

// ── the partial capture the v2 delta fence presents ─────────────────────────
//
// The journal daemon now fences v2 DELTA manifests: only the touched paths (and
// their ancestors) appear, and removals are named explicitly rather than implied
// by absence. The tombstone sweep in `build()` is a WHOLE-TREE claim — on a
// partial capture it would DELETE every untouched path in the tree. This test
// pins the merge: unnamed paths carry forward from the parent, and only the
// capture's explicit `removed` list deletes.

describe('bounded layers — partial captures against a parent', () => {
  test('a partial capture carries unnamed paths forward and removes only what it names', async () => {
    const store = new MemStore();
    const publisher = new HarnessPublicationStore();
    const parent = await publishAndOpen(
      await build(verifiedJournalCapture([
        dirE('pkg'),
        fileE('pkg/kept.bin', 'the untouched bytes'),
        fileE('pkg/changed.bin', 'generation one'),
        fileE('pkg/doomed.bin', 'about to be removed'),
      ], 0)),
      store,
      publisher,
    );

    // THE PARTIAL CAPTURE: the touched file and its ancestor, plus an explicit
    // removal — the exact shape a v2 delta manifest presents for that write.
    const built = await build(verifiedJournalCapture([
      dirE('pkg'),
      fileE('pkg/changed.bin', 'generation two'),
    ], 10, { partial: true, structural: [{ op: 'remove', path: 'pkg/doomed.bin' }] }), parent);

    // The built view resolves entry metadata only; bytes are the opened
    // child's to serve. Publish the merge and read it back through the real
    // serving path.
    const child = await publishAndOpen(built, store, publisher);
    const read = async (path: string): Promise<string> => {
      const doc = child.entryAt(path);
      if (doc === undefined || doc.kind !== 'file') throw new Error(`no file at ${path}`);
      return new TextDecoder().decode(await child.readRange(path, 0, Number(doc.chunks.reduce((n, c) => n + c.size, 0))));
    };
    expect(child.entryAt('pkg/kept.bin')).toBeDefined();
    expect(await read('pkg/kept.bin')).toBe('the untouched bytes');
    expect(await read('pkg/changed.bin')).toBe('generation two');
    expect(child.entryAt('pkg/doomed.bin')).toBeUndefined();
  });
});
