/**
 * The smart container, in one process: a modeled daemon over a live tree, a
 * memory object store that answers like R2, and the SHIPPED sidecar driving
 * both.
 *
 * WHY A MODELED DAEMON AND NOT A FAKE ONE. The daemon's half of a seal is
 * mechanical — observe every mutation, expand each dirty cluster to the window
 * its boundaries imply, copy that window into a stage, write the manifest —
 * and it is the half that decides whether the sidecar's work is O(k). Modeling
 * it here means the counters a test reads come from the same window rule the
 * deployed daemon runs, and the SIDECAR half is not modeled at all: the
 * chunker, the builder, the packer, the publisher, the ledger and the head CAS
 * are the shipped ones.
 *
 * WHAT THE STORE PROVES. Every PUT answers the ETag R2 answers — the MD5 of
 * the body it took, quoted — because ETag-only receipts are what the deployed
 * transport gives (2026-09-02, `bench/measure-first/MEASUREMENTS.md` § (d)),
 * and a test that wants a mismatch flips one byte of the answer rather than
 * reaching inside the publisher.
 */

import { createHash } from 'node:crypto';

import { sha256Hex } from '../../src/cas/hash';
import { MemoryControlStore } from './candidate-control';
import { LiveTree, cloneMetadata, holesOf, runBytes, sortedByPath } from './tree-model';
import type { NodeEntry } from '../../src/capture/model';
import { SidecarCore } from '../../bench/sidecar/core';
import type { SidecarDaemon, SidecarPayloadStore } from '../../bench/sidecar/core';
import { DEFAULT_CHUNK_PARAMS } from '../../src/candidates/merkle-pack/chunk';
import type { ChunkParams, StagedRange } from '../../src/candidates/merkle-pack/chunk';
import { chunkWindows } from '../../src/candidates/merkle-pack/delta';
import type {
  BoundaryHandback,
  DeltaDirtyFile,
  DeltaManifestV2,
  DeltaStage,
  DeltaStagedRange,
} from '../../src/candidates/merkle-pack/delta';
import { DEFAULT_MAX_PACK_BYTES_V2 } from '../../src/candidates/merkle-pack/build-v2';
import { envelopeV2Bytes, envelopeV2IdOf } from '../../src/candidates/publication';
import * as v from 'valibot';
import { RootEnvelopeV2Schema, CandidateRunControlV2Schema } from '../../src/durability/contracts';
import type { MerkleV2View } from '../../src/candidates/merkle-pack/view-v2';
import type { PackRun } from '../../src/candidates/merkle-pack/read';
import type { CandidateEnvelopeStoreV2, CandidateControlStore } from '../../src/candidates/control';
import type {
  CandidateRunControlV2,
  ObjectReceipt,
  PayloadGrant,
  RangeReadIntent,
  RootEnvelopeV2,
  SealWork,
  UploadIntent,
} from '../../src/durability/contracts';
import type { JournalDelta, JournalFence } from '../../src/capture/journal/client';
type DeltaMetadataOp = DeltaManifestV2['metadataOps'][number];

/**
 * THE TEST-SIDE MIRRORS. `candidateRunControlV2` and `parseEnvelopeV2Bytes`
 * were test-only exports — production reaches neither — so both are gone from
 * the module surface, and these two restate the literals they served. Drift
 * fails these tests on purpose: if the control record's shape or the envelope
 * canonicality rule changes, the mirror must be updated in the same commit or
 * the sidecar harness is measuring the wrong record.
 */
export function parseEnvelopeV2Bytes(bytes: Uint8Array, rootEnvelopeId: string): RootEnvelopeV2 {
  const envelope = v.parse(RootEnvelopeV2Schema, JSON.parse(new TextDecoder().decode(bytes)));
  if (envelopeV2IdOf(envelope) !== rootEnvelopeId) {
    throw new Error(`candidate v2 envelope does not match pointer ${rootEnvelopeId}`);
  }
  if (!bytesEqual(envelopeV2Bytes(envelope), bytes)) {
    throw new Error(`candidate v2 envelope body at ${rootEnvelopeId} is not canonical`);
  }
  return envelope;
}

export async function candidateRunControlV2(
  store: CandidateControlStore,
  envelopes: CandidateEnvelopeStoreV2,
): Promise<CandidateRunControlV2> {
  const control = await store.read();
  const pointer = control.head;
  return v.parse(CandidateRunControlV2Schema, {
    version: 2,
    head: pointer === null ? null : { pointer, envelope: await envelopes.read(pointer.rootEnvelopeId) },
    operation: control.operation,
  });
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let at = 0; at < a.byteLength; at += 1) {
    if (a[at] !== b[at]) return false;
  }
  return true;
}

/** One remote operation against the store, as the work rows count them. */
export interface StoreOp {
  readonly op: 'put' | 'get' | 'head' | 'list' | 'delete';
  readonly key: string;
  readonly bytes: number;
}

export class MemoryEnvelopeStoreV2 implements CandidateEnvelopeStoreV2 {
  readonly objects = new Map<string, Uint8Array>();
  readonly ops: StoreOp[] = [];

  async write(envelope: RootEnvelopeV2, rootEnvelopeId: string): Promise<void> {
    const bytes = envelopeV2Bytes(envelope);
    const existing = this.objects.get(rootEnvelopeId);
    if (existing !== undefined) {
      parseEnvelopeV2Bytes(existing, rootEnvelopeId);
      return;
    }
    this.objects.set(rootEnvelopeId, bytes);
    this.ops.push({ op: 'put', key: `envelopes/${rootEnvelopeId}`, bytes: bytes.byteLength });
  }

  async read(rootEnvelopeId: string): Promise<RootEnvelopeV2> {
    const bytes = this.objects.get(rootEnvelopeId);
    if (bytes === undefined) throw new Error(`candidate v2 envelope is absent: ${rootEnvelopeId}`);
    this.ops.push({ op: 'get', key: `envelopes/${rootEnvelopeId}`, bytes: bytes.byteLength });
    return parseEnvelopeV2Bytes(bytes, rootEnvelopeId);
  }
}

/**
 * The payload store, as R2 answers: a single PUT returns the quoted MD5 of the
 * body and nothing else, a range GET returns exactly those bytes, and a delete
 * removes the object. Every call is logged, because "no HEAD per existing
 * object" and "no prefix listing" are properties of the CALLS, not of the
 * bytes.
 */
export class MemoryPayloadStore implements SidecarPayloadStore {
  readonly objects = new Map<string, Uint8Array>();
  readonly ops: StoreOp[] = [];
  /** Answer the next PUT with a wrong ETag, as a corrupted transport would. */
  corruptNextEtag = false;

  async issuePayloadGrant(intent: UploadIntent): Promise<PayloadGrant> {
    return {
      operationId: intent.operationId,
      attemptId: intent.attemptId,
      expiresAt: intent.expiresAt,
      opaque: intent.exactKey,
    };
  }

  async uploadObject(grant: PayloadGrant, body: ReadableStream<Uint8Array>): Promise<ObjectReceipt> {
    const bytes = new Uint8Array(await new Response(body).arrayBuffer());
    this.objects.set(grant.opaque, bytes);
    this.ops.push({ op: 'put', key: grant.opaque, bytes: bytes.byteLength });
    const md5 = createHash('md5').update(bytes).digest('hex');
    const etag = this.corruptNextEtag ? `"${md5.slice(0, 31)}${md5[31] === '0' ? '1' : '0'}"` : `"${md5}"`;
    this.corruptNextEtag = false;
    return {
      operationId: grant.operationId,
      attemptId: grant.attemptId,
      key: grant.opaque,
      byteLength: String(bytes.byteLength),
      sha256: sha256Hex(bytes),
      etag,
      verified: true,
    };
  }

  async readRange(intent: RangeReadIntent): Promise<Uint8Array> {
    return this.#range(intent.exactKey, Number(intent.byteOffset), Number(intent.byteLength));
  }

  async readRun(run: PackRun): Promise<Uint8Array> {
    return this.#range(run.key, run.offset, run.length);
  }

  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
    this.ops.push({ op: 'delete', key, bytes: 0 });
  }

  /** Flip one byte of a stored object, as a corrupt payload would read back. */
  corrupt(key: string): void {
    const bytes = this.objects.get(key);
    if (bytes === undefined || bytes.byteLength === 0) throw new Error(`nothing stored at ${key}`);
    const copy = bytes.slice();
    copy[0] ^= 0xff;
    this.objects.set(key, copy);
  }

  #range(key: string, offset: number, length: number): Uint8Array {
    const bytes = this.objects.get(key);
    if (bytes === undefined) throw new Error(`missing candidate object: ${key}`);
    this.ops.push({ op: 'get', key, bytes: length });
    return bytes.slice(offset, offset + length);
  }
}

/** One file the modeled fence found dirty, before the manifest is written. */
interface DirtyFile {
  whole: boolean;
  readonly ranges: StagedRange[];
}

/**
 * The daemon, modeled: it observes mutations, holds the boundary map the
 * sidecar hands it, and answers a fence with the same windows the deployed
 * fence would have staged.
 */
export class ModeledDaemon implements SidecarDaemon {
  readonly boundaryMap = new Map<string, { readonly size: number; readonly boundaries: readonly number[] }>();
  readonly fences: DeltaManifestV2[] = [];
  /** One line per admitted write, plus the lines a refusal cancelled. */
  readonly wal: string[] = [];
  readonly cancelledWal: string[] = [];
  #dirty = new Map<string, DirtyFile>();
  #touched = new Set<string>();
  #ops: DeltaMetadataOp[] = [];
  #sequence = 1;
  #cut = 0;
  #generation = 0;
  #base: { cut: string; generation: string; root: string } | null = null;
  #manifest: DeltaManifestV2 | null = null;
  #walBytes = 0;
  #tree: LiveTree;
  #params: ChunkParams;

  /**
   * The tree is the container's, not the daemon's: a conformance arm hands it
   * the disk-charged tree whose quota an ENOSPC cell fills, and the focused
   * tests hand it one of their own.
   */
  constructor(tree: LiveTree, params: ChunkParams = DEFAULT_CHUNK_PARAMS) {
    this.#tree = tree;
    this.#params = params;
  }

  /** The tree this daemon fences from: the container's own. */
  get tree(): LiveTree {
    return this.#tree;
  }

  /** A replaced container hands its new disk tree over; the WAL history and
   *  the boundary map stay, because both live with the daemon's state. */
  adopt(tree: LiveTree): void {
    this.#tree = tree;
  }

  /** Forget the box: what discard owes the next container. */
  reset(): void {
    this.#tree.clear();
    this.#dirty = new Map();
    this.#touched = new Set();
    this.#ops = [];
    this.boundaryMap.clear();
    this.#base = null;
    this.#manifest = null;
    this.#cut = 0;
    this.#generation = 0;
    this.#walBytes = 0;
    this.wal.length = 0;
    this.cancelledWal.length = 0;
  }

  /** Bytes of writes the WAL has recorded, as the seal cadence reads it. */
  get walBytes(): number {
    return this.#walBytes;
  }

  // ── the workload's mutations ─────────────────────────────────────────────

  plant(entries: readonly NodeEntry[]): void {
    this.tree.plant(entries);
    for (const entry of sortedByPath(entries)) {
      if (entry.kind === 'dir') {
        this.#touched.add(entry.path);
        continue;
      }
      if (entry.kind === 'symlink') {
        this.#touched.add(entry.path);
        continue;
      }
      this.#markWhole(entry.path);
      this.#walBytes += entry.content === undefined ? 0 : runBytes(entry.content);
    }
  }

  write(path: string, bytes: Uint8Array): void {
    const existed = this.tree.has(path);
    this.tree.writeFile(path, bytes);
    if (!existed) {
      for (const ancestor of ancestorsOfPath(path)) {
        if (this.tree.has(ancestor)) this.#touched.add(ancestor);
      }
    }
    this.#markWhole(path);
    this.#walBytes += bytes.byteLength;
  }

  pwrite(path: string, offset: number, bytes: Uint8Array): void {
    this.tree.pwrite(path, offset, bytes);
    this.#markRange(path, offset, bytes.byteLength);
    this.#walBytes += bytes.byteLength;
  }

  /** A rename, as the WAL records it: the structure moves, bytes do not. */
  rename(from: string, to: string): void {
    const node = this.tree.node(from);
    if (node === undefined) throw new Error(`no node at ${from}`);
    const snapshot = this.tree.snapshot().filter((entry) => entry.path === from || entry.path.startsWith(`${from}/`));
    this.tree.remove(from);
    this.tree.plant(snapshot.map((entry) => ({ ...entry, path: `${to}${entry.path.slice(from.length)}` })));
    this.#op('rename', from, to);
    const held = this.#dirty.get(from);
    if (held !== undefined) {
      this.#dirty.delete(from);
      this.#dirty.set(to, held);
    }
    for (const ancestor of ancestorsOfPath(to)) {
      if (this.tree.has(ancestor)) this.#touched.add(ancestor);
    }
    this.#touched.add(to);
  }

  remove(path: string): void {
    const node = this.tree.node(path);
    this.tree.remove(path);
    this.#op(node?.kind === 'dir' ? 'rmdir' : 'unlink', path, '');
    this.#dirty.delete(path);
    this.#touched.delete(path);
    this.boundaryMap.delete(path);
    for (const ancestor of ancestorsOfPath(path)) {
      if (this.tree.has(ancestor)) this.#touched.add(ancestor);
    }
  }

  // ── the fence ────────────────────────────────────────────────────────────

  async fence(): Promise<JournalFence> {
    this.#cut += 1;
    this.#generation += 1;
    // THE TOUCHED PATHS PLUS THEIR ANCESTORS, which is what makes a delta a
    // consistent partial tree: a rewritten directory needs its own stat, and
    // the sidecar rewrites every ancestor of everything that changed.
    const paths = new Set<string>();
    for (const path of [...this.#dirty.keys(), ...this.#touched]) {
      if (!this.tree.has(path)) continue;
      paths.add(path);
      for (const ancestor of ancestorsOfPath(path)) {
        if (this.tree.has(ancestor)) paths.add(ancestor);
      }
    }
    const inos = new Map(this.tree.snapshot().map((entry) => [entry.path, entry.ino]));
    const dirtyFiles: DeltaDirtyFile[] = [];
    let bytesStaged = 0;
    let wholeFiles = 0;
    for (const path of [...paths].sort()) {
      const node = this.tree.node(path);
      if (node === undefined) continue;
      const metadata = cloneMetadata(node.metadata);
      const ino = inos.get(path);
      if (ino === undefined) throw new Error(`no inode for ${path}`);
      const row = {
        ino: String(ino),
        path,
        size: 0,
        mode: node.mode,
        uid: metadata.uid,
        gid: metadata.gid,
        atimeNs: metadata.atimeNs,
        mtimeNs: metadata.mtimeNs,
        ctimeNs: metadata.ctimeNs,
        xattrs: { ...metadata.xattrs },
        whole: false,
        dirty: stagedRanges(),
        ranges: deltaStagedRanges(),
      };
      if (node.kind === 'dir') {
        dirtyFiles.push({ ...row, kind: 'dir' });
        continue;
      }
      if (node.kind === 'symlink') {
        dirtyFiles.push({ ...row, kind: 'symlink', target: node.target ?? '' });
        continue;
      }
      const content = node.content;
      const size = content === undefined ? 0 : (content.kind === 'dense' ? content.bytes.byteLength : content.size);
      const entry = this.#dirty.get(path) ?? { whole: true, ranges: [] };
      const known = this.boundaryMap.get(path);
      const whole = entry.whole || known === undefined || known.size !== size;
      const dataRuns = content === undefined ? [] : dataRunsOf(content, size);
      const dirty = whole ? dataRuns : mergeRanges(entry.ranges);
      const windows = chunkWindows({
        size,
        ranges: dirty,
        boundaries: whole ? null : known.boundaries,
        params: this.#params,
        whole,
      });
      const ranges = await this.#stageWindows(path, windows, dataRuns);
      bytesStaged += ranges.reduce((sum, range) => sum + range.length, 0);
      if (whole) wholeFiles += 1;
      dirtyFiles.push({ ...row, kind: 'file', size, whole, dirty, ranges });
    }
    const sealWork: SealWork = { bytesStaged, bytesChunked: 0, chunksHashed: 0, nodesRewritten: 0, wholeFiles };
    const manifest: DeltaManifestV2 = {
      version: 2,
      cut: this.#cut,
      generation: this.#generation,
      stageRoot: `/stage/${this.#generation}`,
      base: this.#base,
      entries: dirtyFiles,
      metadataOps: this.#ops,
      sealWork,
    };
    this.#manifest = manifest;
    this.fences.push(manifest);
    this.#dirty = new Map();
    this.#touched = new Set();
    this.#ops = [];
    this.#walBytes = 0;
    return {
      cut: manifest.cut,
      generation: manifest.generation,
      manifestPath: `${manifest.stageRoot}/manifest.json`,
      base: this.#base,
      sealWork,
    };
  }

  /**
   * The stage: each window intersected with the file's data runs, split at
   * 512 KiB, every piece carrying the digest of exactly those bytes. Holes
   * stay holes, which is why a 1 GiB sparse file costs its data and not its
   * size.
   */
  async #stageWindows(
    path: string,
    windows: readonly StagedRange[],
    dataRuns: readonly StagedRange[],
  ): Promise<DeltaStagedRange[]> {
    const staged: DeltaStagedRange[] = [];
    for (const window of windows) {
      const end = window.offset + window.length;
      for (const run of dataRuns) {
        const from = Math.max(window.offset, run.offset);
        const to = Math.min(end, run.offset + run.length);
        for (let at = from; at < to; at += STAGE_SPLIT_BYTES) {
          const length = Math.min(STAGE_SPLIT_BYTES, to - at);
          const bytes = await this.stage.read(path, at, length);
          staged.push({ offset: at, length, sha256: sha256Hex(bytes) });
        }
      }
    }
    return staged.sort((a, b) => a.offset - b.offset);
  }

  /** The delta the sidecar reads after a fence: the manifest just written,
   *  bound to the stage that reads the live tree at the same offsets. */
  async delta(fence: JournalFence): Promise<JournalDelta> {
    const held = this.#manifest;
    if (held === null || held.cut !== fence.cut || held.generation !== fence.generation) {
      throw new Error(`no delta for the fence at cut ${fence.cut}`);
    }
    return {
      manifest: held,
      stage: this.stage,
      close: () => {},
    };
  }

  async boundaries(handback: BoundaryHandback): Promise<number> {
    // MERGE, never replace: a full map is O(total extents) and this is the
    // request that would put an O(n) term back into every publish.
    for (const file of handback.files) {
      this.boundaryMap.set(file.path, { size: file.size, boundaries: [...file.boundaries] });
    }
    for (const path of handback.removed) this.boundaryMap.delete(path);
    this.#base = { cut: handback.cut, generation: handback.generation, root: handback.root };
    return handback.files.length;
  }

  /** The stage, as the sidecar reads it: the live bytes at identical offsets. */
  get stage(): DeltaStage {
    return {
      read: async (path, offset, length) => {
        const node = this.tree.node(path);
        if (node?.content === undefined) throw new Error(`no staged file at ${path}`);
        const content = node.content;
        const out = new Uint8Array(length);
        if (content.kind === 'dense') {
          out.set(content.bytes.subarray(offset, Math.min(offset + length, content.bytes.byteLength)));
          return out;
        }
        if (content.kind === 'sparse') {
          for (const run of content.runs) {
            const from = Math.max(offset, run.offset);
            const to = Math.min(offset + length, run.offset + run.bytes.byteLength);
            if (from < to) out.set(run.bytes.subarray(from - run.offset, to - run.offset), from - offset);
          }
          return out;
        }
        throw new Error(`sealed content cannot be staged: ${path}`);
      },
    };
  }

  #op(op: DeltaMetadataOp['op'], path: string, argument: string): void {
    this.#ops.push({ sequence: this.#sequence++, op, path, argument, result: 0 });
  }

  #markWhole(path: string): void {
    const held = this.#dirty.get(path);
    if (held === undefined) this.#dirty.set(path, { whole: true, ranges: [] });
    else held.whole = true;
  }

  #markRange(path: string, offset: number, length: number): void {
    const held = this.#dirty.get(path) ?? { whole: false, ranges: [] };
    held.ranges.push({ offset, length });
    held.ranges.sort((a, b) => a.offset - b.offset);
    this.#dirty.set(path, held);
  }
}

function ancestorsOfPath(path: string): string[] {
  const parts = path.split('/').filter((part) => part !== '');
  const out: string[] = [];
  let at = '';
  for (const part of parts.slice(0, -1)) {
    at = at === '' ? part : `${at}/${part}`;
    out.push(at);
  }
  return out;
}

/** A file's data runs: everything its holes do not cover. */
function dataRunsOf(
  content: NonNullable<NodeEntry['content']>,
  size: number,
): StagedRange[] {
  const holes = holesOf(content);
  const runs: StagedRange[] = [];
  let cursor = 0;
  for (const [from, to] of holes) {
    if (from > cursor) runs.push({ offset: cursor, length: from - cursor });
    cursor = to;
  }
  if (size > cursor) runs.push({ offset: cursor, length: size - cursor });
  return runs;
}
/** SAFETY: an empty array is a StagedRange[] by construction — there is
 *  nothing in it to mis-type. */
function stagedRanges(): StagedRange[] {
  return [];
}

/** SAFETY: an empty array is a DeltaStagedRange[] by construction — there is
 *  nothing in it to mis-type. */
function deltaStagedRanges(): DeltaStagedRange[] {
  return [];
}

/** How far the fence splits one staged window: the verify unit of a read. */
const STAGE_SPLIT_BYTES = 512 * 1024;

/** Overlapping or touching writes are one dirty range. */
function mergeRanges(ranges: readonly StagedRange[]): StagedRange[] {
  const merged: StagedRange[] = [];
  for (const range of [...ranges].sort((a, b) => a.offset - b.offset)) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range.offset <= last.offset + last.length) {
      merged[merged.length - 1] = {
        offset: last.offset,
        length: Math.max(last.offset + last.length, range.offset + range.length) - last.offset,
      };
      continue;
    }
    merged.push({ offset: range.offset, length: range.length });
  }
  return merged;
}

export interface SidecarFixture {
  readonly core: SidecarCore;
  readonly daemon: ModeledDaemon;
  readonly payload: MemoryPayloadStore;
  readonly envelopes: MemoryEnvelopeStoreV2;
  readonly control: MemoryControlStore;
  snapshot(): Promise<CandidateRunControlV2>;
}

export interface FixtureOptions {
  readonly boxId?: string;
  readonly bootId?: string;
  readonly chunkParams?: ChunkParams;
  readonly maxPackBytes?: number;
  readonly graceMs?: number;
  readonly now?: () => number;
  readonly charge?: (delta: number) => void;
  /** Share a store, a control record and a daemon with an earlier fixture. */
  readonly share?: Pick<SidecarFixture, 'daemon' | 'payload' | 'envelopes' | 'control'>;
}

/** One sidecar over one modeled container, wired to the shipped code. */
export function openSidecar(options: FixtureOptions = {}): SidecarFixture {
  const daemon = options.share?.daemon
    ?? new ModeledDaemon(new LiveTree(options.charge), options.chunkParams ?? DEFAULT_CHUNK_PARAMS);
  const payload = options.share?.payload ?? new MemoryPayloadStore();
  const envelopes = options.share?.envelopes ?? new MemoryEnvelopeStoreV2();
  const control = options.share?.control ?? new MemoryControlStore();
  const snapshot = async (): Promise<CandidateRunControlV2> => await candidateRunControlV2(control, envelopes);
  const core = new SidecarCore({
    boxId: options.boxId ?? 'box-sidecar',
    bootId: options.bootId ?? 'boot-1',
    snapshot,
    head: { control, envelopes },
    payload,
    daemon,
    now: options.now ?? (() => 1_000),
    chunkParams: options.chunkParams,
    maxPackBytes: options.maxPackBytes ?? DEFAULT_MAX_PACK_BYTES_V2,
    graceMs: options.graceMs,
  });
  return { core, daemon, payload, envelopes, control, snapshot };
}


/**
 * One node a published head serves, as a capture-model entry: what a restore
 * would write at that path, read back through the shipped v2 view.
 *
 * THE INODE IS THE RECORD'S OWN. A v2 file node carries the inode number the
 * fence saw, and two names for one inode ARE one record, so hardlink identity
 * survives a hydrate that pages the two paths in at different times.
 */
export async function nodeEntryFrom(view: MerkleV2View, path: string): Promise<NodeEntry | null> {
  const stat = await view.stat(path);
  if (stat === null) return null;
  const metadata = stat.metadata ?? { uid: 0, gid: 0, atimeNs: '0', mtimeNs: '0', ctimeNs: '0', xattrs: {} };
  // A v2 record always carries its inode; a view that lost it would silently
  // unshare a hardlink, so this refuses rather than inventing one.
  const ino = stat.ino;
  if (ino === undefined) throw new Error(`the head's record for ${path} carries no inode`);
  if (stat.kind === 'dir') return { path, kind: 'dir', mode: stat.mode, ino, metadata };
  if (stat.kind === 'symlink') {
    return { path, kind: 'symlink', mode: stat.mode, ino, metadata, target: stat.target ?? '' };
  }
  const runs: { offset: number; bytes: Uint8Array }[] = [];
  let holes = false;
  for (const extent of await view.extents(path)) {
    if (extent.kind === 'hole') {
      holes = true;
      continue;
    }
    runs.push({ offset: extent.offset, bytes: await view.readRange(path, extent.offset, extent.length) });
  }
  // A file's holes stay holes, so a comparison can say `sparse` rather than
  // "different bytes".
  const content = holes
    ? { kind: 'sparse' as const, size: stat.size, runs }
    : { kind: 'dense' as const, bytes: runs[0]?.bytes ?? new Uint8Array(0) };
  return { path, kind: 'file', mode: stat.mode, ino, metadata, content };
}

/** Every path a published head names, in tree order: the listing a lazy
 *  restore walks before it pages a single file in. */
export async function headPaths(view: MerkleV2View): Promise<string[]> {
  const paths: string[] = [];
  const walk = async (at: string): Promise<void> => {
    for (const name of await view.readdir(at)) {
      const child = at === '' ? name : `${at}/${name}`;
      paths.push(child);
      const stat = await view.stat(child);
      if (stat?.kind === 'dir') await walk(child);
    }
  };
  await walk('');
  return paths;
}

/** The whole tree a published head serves, read back through the v2 view. */
export async function readTree(view: MerkleV2View): Promise<NodeEntry[]> {
  const entries: NodeEntry[] = [];
  for (const path of await headPaths(view)) {
    const entry = await nodeEntryFrom(view, path);
    if (entry === null) throw new Error(`the head lists ${path} and cannot stat it`);
    entries.push(entry);
  }
  return sortedByPath(entries);
}