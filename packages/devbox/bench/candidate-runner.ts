import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { closeSync, constants as FS, createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { sha256Hex } from '../src/cas/hash';
import * as v from 'valibot';
import type { AuditedCapture } from '../src/capture/model';
import { build as buildBounded, isHoleExtent, open as openBounded } from '../src/candidates/bounded-layers';
import { buildMerklePack, openMerklePack, parentFromPublishedParent } from '../src/candidates/merkle-pack';
import type { MerklePackView } from '../src/candidates/merkle-pack';
import { JournalDaemonClient, readJournalDelta } from '../src/capture/journal/client';
import type { JournalBase, JournalDelta, JournalFence } from '../src/capture/journal/client';
import { issueVerifiedJournalCapture, manifestSha256 } from '../src/capture/model';
import type { Capture, NodeEntry } from '../src/capture/model';
import type { PosixMetadata } from '../src/capture/model';
import { FileCandidateObjectSink, envelopeBytes, recoverPublishedParent, requireEnvelopeAt, stageCandidatePayload } from '../src/candidates/publication';
import type { CandidateRestoreBound, CandidateRestoreWork } from '../src/candidates/restore-receipt';
import { BeneathRoot } from '../src/native-openat2';
import type {
  CandidatePayloadStore,
  CandidatePublicationDraft,
  PublishIdentityInput,
  PublishedParent,
} from '../src/candidates/publication';
import { CandidateRunControlV1Schema, ImmutableObjectRefSchema } from '../src/durability/contracts';
import type {
  CandidateRunControlV1,
  CandidateRunHeadV1,
  ObjectReceipt,
  PayloadGrant,
  RangeReadIntent,
  UploadIntent,
} from '../src/durability/contracts';

export type CandidateFormat = 'bounded-layers' | 'merkle-pack';

/** The host supplies only a read-only control snapshot to the container. */
export interface CandidateRunnerPort {
  readonly control: CandidateRunControlV1;
}

export interface CandidateRunOptions extends CandidateRunnerPort {
  readonly action: 'checkpoint' | 'restore' | 'seed';
  readonly format: CandidateFormat;
  /** The tree a restore materializes: the journal's backing root, not its mount. */
  readonly workspace: string;
  /** A FUSE-mounted R2 prefix. Payload data moves only through this mount. */
  readonly store: string;
  readonly boxId: string;
  /** The mutation journal's control socket; a checkpoint fences its cut here. */
  readonly journalSocket: string;
}

export interface CandidateCheckpointPublishedResult {
  readonly ok: true;
  readonly movedBytes: number;
  readonly heldBytes: number;
  readonly draft: CandidatePublicationDraft;
}

/** A fenced manifest already authenticated by the current published head. */
export interface CandidateCheckpointSkippedResult {
  readonly ok: true;
  readonly noChange: true;
}

export type CandidateCheckpointResult = CandidateCheckpointPublishedResult | CandidateCheckpointSkippedResult;

export interface CandidateSeedResult {
  readonly ok: true;
}

export interface CandidateRestoreResult {
  readonly ok: true;
  readonly rootId: string | null;
  /** The counted cost of this restore. It stays absent when no head was restored. */
  readonly work?: CandidateRestoreWork;
  /** The evidence the restore bound is checked against. It stays absent with `work`. */
  readonly bound?: CandidateRestoreBound;
}

type StoredHead = CandidateRunHeadV1;

interface CandidateCheckpointGrant extends PublishIdentityInput {
  readonly expectedParent: string | null;
  readonly baseRevision: string;
}

function objectPath(store: string, key: string): string {
  const target = resolve(store, key);
  const root = `${resolve(store)}${sep}`;
  if (!target.startsWith(root)) throw new Error(`candidate object key escapes FUSE store: ${key}`);
  return target;
}

async function atomicWrite(path: string, body: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${crypto.randomUUID()}`;
  try {
    await writeFile(temp, body);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

async function writeStream(path: string, body: ReadableStream<Uint8Array>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${crypto.randomUUID()}`;
  try {
    await pipeline(Readable.fromWeb(body), createWriteStream(temp));
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

async function fileDigest(path: string): Promise<{ readonly byteLength: number; readonly sha256: string }> {
  const hash = createHash('sha256');
  let byteLength = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    byteLength += chunk.byteLength;
  }
  return { byteLength, sha256: hash.digest('hex') };
}

/** Container-local FUSE adapter. Payload streams never cross the host boundary. */
class FusePayloadStore implements CandidatePayloadStore {
  constructor(private readonly store: string) {}

  async issuePayloadGrant(intent: UploadIntent): Promise<PayloadGrant> {
    return {
      operationId: intent.operationId,
      attemptId: intent.attemptId,
      expiresAt: intent.expiresAt,
      opaque: intent.exactKey,
    };
  }

  async uploadObject(grant: PayloadGrant, body: ReadableStream<Uint8Array>): Promise<ObjectReceipt> {
    const path = objectPath(this.store, grant.opaque);
    await writeStream(path, body);
    const digest = await fileDigest(path);
    return {
      operationId: grant.operationId,
      attemptId: grant.attemptId,
      key: grant.opaque,
      byteLength: String(digest.byteLength),
      sha256: digest.sha256,
      etag: `fuse-${digest.sha256.slice(0, 16)}`,
      verified: true,
    };
  }

  async readRange(intent: RangeReadIntent): Promise<Uint8Array> {
    const start = Number(intent.byteOffset);
    const end = start + Number(intent.byteLength);
    return new Uint8Array(await Bun.file(objectPath(this.store, intent.exactKey)).slice(start, end).arrayBuffer());
  }
}

/** Which side of a restore a store read serves. The restore sets it at each phase. */
type RestoreReadClass = 'metadata' | 'payload';

/** One async path's chain of awaited store reads. `runRestorePool` forks it
 *  per worker, so a chain counts the reads one path issued in sequence and
 *  the longest chain is the restore's critical path. */
interface ReadChain {
  length: number;
}
const readChains = new AsyncLocalStorage<ReadChain>();

/** The store reads one restore issued, split by what each read served, and
 *  the longest chain of them one path awaited in sequence. */
interface RestoreReadTotals {
  readonly ops: number;
  readonly metadataBytes: number;
  readonly payloadBytes: number;
  readonly criticalPath: number;
}

class RestoreReadCounter {
  private ops = 0;
  private metadataBytes = 0;
  private payloadBytes = 0;
  private criticalPath = 0;

  note(byteLength: number, cls: RestoreReadClass): void {
    this.ops += 1;
    if (cls === 'metadata') this.metadataBytes += byteLength;
    else this.payloadBytes += byteLength;
    const chain = readChains.getStore();
    if (chain === undefined) throw new Error('a restore read ran outside its read chain');
    chain.length += 1;
    if (chain.length > this.criticalPath) this.criticalPath = chain.length;
  }

  snapshot(): RestoreReadTotals {
    return { ops: this.ops, metadataBytes: this.metadataBytes, payloadBytes: this.payloadBytes, criticalPath: this.criticalPath };
  }
}

/** Run one restore inside a fresh read chain, so every read it issues is
 *  counted on a path. */
function withReadChain<T>(run: () => Promise<T>): Promise<T> {
  return readChains.run({ length: 0 }, run);
}

/** A payload store that counts every range read for the restore it serves. */
class CountedRestoreStore {
  cls: RestoreReadClass = 'metadata';

  constructor(
    private readonly inner: FusePayloadStore,
    private readonly counter: RestoreReadCounter,
  ) {}

  async readRange(intent: RangeReadIntent): Promise<Uint8Array> {
    const bytes = await this.inner.readRange(intent);
    this.counter.note(bytes.byteLength, this.cls);
    return bytes;
  }
}

/** What a Merkle restore reports through its tally: one call per resolved path. */
export interface RestoreMerkleTally {
  /** One non-root path the walk resolved. */
  readonly resolve: (path: string) => void;
  /** The walk finished and the first byte fetch is next. It runs exactly once. */
  readonly materializing: () => void;
  /** One entry the restore finished materializing. */
  readonly materialize: () => void;
}

/** Accept the host snapshot only when its envelope matches the digest its pointer names. */
function controlState(options: CandidateRunOptions): CandidateRunControlV1 {
  const control = v.parse(CandidateRunControlV1Schema, options.control);
  if (control.head !== null) requireEnvelopeAt(control.head.envelope, control.head.pointer.rootEnvelopeId);
  return control;
}

function publishedJournalBase(control: CandidateRunControlV1): JournalBase | null {
  const head = control.head;
  if (head === null) return null;
  return {
    cut: head.envelope.cut.cut,
    generation: head.envelope.generation,
    root: head.pointer.rootEnvelopeId,
  };
}

function checkpointGrant(options: CandidateRunOptions, control: CandidateRunControlV1): CandidateCheckpointGrant {
  const operation = control.operation;
  if (operation === null || operation.phase !== 'transferring') {
    throw new Error('candidate checkpoint requires a transferring host operation');
  }
  const headId = control.head?.pointer.rootEnvelopeId ?? null;
  if (headId !== operation.expectedParent) {
    throw new Error('candidate checkpoint grant does not bind its host head snapshot');
  }
  return {
    operationId: operation.operationId,
    attemptId: operation.attemptId,
    boxId: options.boxId,
    epoch: operation.epoch,
    bootId: operation.bootId,
    kind: operation.kind,
    expiresAt: String(Date.now() + 60_000),
    expectedParent: operation.expectedParent,
    baseRevision: operation.baseRevision,
  };
}

function restoreIdentity(options: CandidateRunOptions, head: StoredHead) {
  return {
    operationId: `restore-${head.pointer.lastOperationId}`,
    attemptId: '1',
    boxId: options.boxId,
    epoch: head.envelope.epoch,
    expiresAt: String(Date.now() + 60_000),
  };
}

async function recoverParent(
  head: StoredHead,
  store: FusePayloadStore,
  input: CandidateCheckpointGrant,
): Promise<PublishedParent> {
  const rootBytes = await store.readRange({
    operationId: input.operationId,
    attemptId: input.attemptId,
    boxId: input.boxId,
    epoch: input.epoch,
    exactKey: head.envelope.rootObject.key,
    method: 'GET',
    byteOffset: '0',
    byteLength: head.envelope.rootObject.byteLength,
    sha256: head.envelope.rootObject.sha256,
    expiresAt: input.expiresAt,
  });
  return recoverPublishedParent({
    head: head.pointer,
    currentHead: head.pointer,
    envelope: head.envelope,
    envelopeBytes: envelopeBytes(head.envelope),
    rootBytes,
    expected: {
      format: head.envelope.format,
      capturedCut: head.envelope.cut,
      lastOperationId: head.pointer.lastOperationId,
    },
  });
}

const RESTORE_SLICE_BYTES = 512 * 1024;

/** Write a logical data range through the same bounded native restore path both codecs use. */
export async function restoreCandidateRange(
  root: BeneathRoot,
  path: string,
  offset: number,
  length: number,
  readRange: (offset: number, length: number) => Promise<Uint8Array>,
): Promise<void> {
  for (let cursor = 0; cursor < length; cursor += RESTORE_SLICE_BYTES) {
    const sliceLength = Math.min(RESTORE_SLICE_BYTES, length - cursor);
    root.writeRange(path, offset + cursor, await readRange(offset + cursor, sliceLength));
  }
}

/** Create the logical file once; omitted sparse extents remain filesystem holes. */
export function createCandidateRestoreFile(root: BeneathRoot, path: string, mode: number, size: number): void {
  const parent = dirname(path);
  if (parent !== '.') root.mkdir(parent);
  const fd = root.createFile(path, FS.O_WRONLY | FS.O_CREAT | FS.O_TRUNC, mode);
  closeSync(fd);
  root.truncate(path, size);
}


function restoreMetadata(
  root: BeneathRoot,
  path: string,
  metadata: PosixMetadata | undefined,
  symlink = false,
): void {
  if (metadata === undefined) return;
  if (symlink) root.lchown(path, metadata.uid, metadata.gid);
  else root.chown(path, metadata.uid, metadata.gid);
  root.utimens(path, BigInt(metadata.atimeNs), BigInt(metadata.mtimeNs));
  for (const [name, value] of Object.entries(metadata.xattrs)) {
    const bytes = Buffer.from(value, 'base64');
    if (symlink) root.lsetxattr(path, name, bytes);
    else root.setxattr(path, name, bytes);
  }
}
async function restoreBounded(
  options: CandidateRunOptions,
  head: StoredHead,
  store: FusePayloadStore,
): Promise<{ readonly work: CandidateRestoreWork; readonly bound: CandidateRestoreBound }> {
  const counter = new RestoreReadCounter();
  const counted = new CountedRestoreStore(store, counter);
  const view = await openBounded(head.envelope.rootObject, counted, restoreIdentity(options, head));
  const layersConsulted = view.layers.length;
  const openReads = counter.snapshot().ops;
  counted.cls = 'payload';
  const root = new BeneathRoot(options.workspace);
  const inodes = new Map<number, string>();
  let cpuSteps = 0;
  try {
    const directories: { readonly path: string; readonly metadata: PosixMetadata | undefined }[] = [];
    for (const path of view.entryPaths()) {
      const entry = view.stat(path)!;
      if (entry.kind === 'dir') {
        root.mkdir(path, entry.mode);
        directories.push({ path, metadata: entry.metadata });
        cpuSteps += 1;
      } else if (entry.kind === 'symlink') {
        root.symlink(entry.target!, path);
        restoreMetadata(root, path, entry.metadata, true);
        cpuSteps += 1;
      } else {
        if (entry.size === undefined) throw new Error(`published bounded file has no size: ${path}`);
        const source = inodes.get(entry.ino);
        if (source !== undefined) {
          root.hardlink(source, path);
          cpuSteps += 1;
          continue;
        }
        createCandidateRestoreFile(root, path, entry.mode, entry.size);
        const document = view.entryAt(path);
        if (document === undefined || document.kind !== 'file') throw new Error(`published bounded file disappeared: ${path}`);
        let offset = 0;
        for (const part of document.chunks) {
          if (!isHoleExtent(part)) {
            await restoreCandidateRange(root, path, offset, part.size, async (at, bytes) =>
              await view.readRange(path, at, bytes));
          }
          offset += part.size;
        }
        restoreMetadata(root, path, entry.metadata);
        inodes.set(entry.ino, path);
        cpuSteps += 1;
      }
    }
    for (const directory of directories.reverse()) {
      restoreMetadata(root, directory.path, directory.metadata);
    }
  } finally {
    root.close();
  }
  const figured = counter.snapshot();
  const totalRemoteOps = figured.ops;
  return {
    work: {
      serialRemoteOps: figured.criticalPath,
      totalRemoteOps,
      metadataBytes: figured.metadataBytes,
      payloadBytes: figured.payloadBytes,
      cpuSteps,
      replayUnits: layersConsulted,
    },
    bound: {
      openReads,
      layersConsulted,
      maxNodeDepth: null,
      nodeFetches: null,
      pathsResolved: cpuSteps,
    },
  };
}

/**
 * How much of one Merkle restore runs at once.
 *
 * It bounds directory children AND file materialization. The reader owns the
 * separate transport bound beneath this: a pool slot holds metadata or one
 * slice's bytes, while the reader decides how many authenticated reads reach
 * the FUSE store. Twelve leaves a few megabytes of slice buffers live, rather
 * than one per file in an npm-shaped tree.
 */
const RESTORE_POOL_WIDTH = 12;

/** Run a finite restore phase through one shared-width work pool. Directory
 * children, data files and deferred hardlinks all use this exact scheduler, so
 * their bound cannot drift apart when one phase changes shape. */
async function runRestorePool<Item>(
  items: readonly Item[],
  run: (item: Item) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await run(items[index]!);
    }
  };
  // Each worker forks the caller's read chain and the caller continues from
  // the longest fork, so the chain length is the longest sequence of awaited
  // reads through the pool rather than their total.
  const parent = readChains.getStore();
  const forks: ReadChain[] = [];
  await Promise.all(Array.from({ length: Math.min(RESTORE_POOL_WIDTH, items.length) }, () => {
    const fork: ReadChain = { length: parent?.length ?? 0 };
    forks.push(fork);
    return readChains.run(fork, worker);
  }));
  if (parent !== undefined) parent.length = Math.max(parent.length, ...forks.map((fork) => fork.length));
}

interface InodeClaim {
  /** The one pathname that receives this inode's bytes. */
  readonly source: string;
  /** Settles only after those bytes and their metadata landed. */
  readonly ready: Promise<void>;
  /** Publish that the source is safe to hardlink. */
  readonly complete: () => void;
}

/**
 * Restore one opened Merkle tree into `root`: every directory's children run
 * through a bounded pool, then files and hardlinks materialize through the
 * same bound. Each phase appends `<name> <elapsed> ms` to `notes`, so a run
 * that threw still says how far it got.
 *
 * THE DEFECT THIS SHAPE REPAIRS. The walk was strictly sequential — one
 * `stat`, one `readdir`, one 512 KiB slice at a time, each an awaited round
 * trip against a FUSE-mounted store — so a 30 MiB tree chunked at the default
 * 4 KiB target cost thousands of serialized reads and the wake overran its
 * 300 s attach budget with nothing but latency.
 *
 * BeneathRoot's mkdir is synchronous and tolerates EEXIST, so the only points
 * that interleave are the view reads. The inode claim is made between one read
 * and the next await; a later occurrence holds the same deferred and cannot
 * hardlink until the source resolved it. That makes two concurrent paths one
 * inode rather than two coincidentally equal files.
 *
 * Directory metadata still has to run after all children: every child, and a
 * hardlink too, changes its parent mtime. The reversed directory pass is the
 * same ordering `restoreBounded` uses.
 *
 * TAKES THE VIEW, NOT THE HEAD, so the walk can be driven against a store that
 * holds its reads: what it must prove is that it does not serialize, and that
 * is a property of the calls it makes rather than of the bytes behind them.
 */
export async function restoreMerkleTree(
  view: MerklePackView,
  root: BeneathRoot,
  notes: string[] = [],
  tally?: RestoreMerkleTally,
): Promise<void> {
  let phaseAt = Date.now();
  const mark = (phase: string): void => {
    const now = Date.now();
    notes.push(`${phase} ${String(now - phaseAt)} ms`);
    phaseAt = now;
  };
  /** One deferred source per captured inode. */
  const inodes = new Map<number, InodeClaim>();
  const files: {
    path: string;
    mode: number;
    size: number;
    metadata: PosixMetadata | undefined;
    claim: InodeClaim;
  }[] = [];
  const links: { path: string; claim: InodeClaim }[] = [];
  const directories: { path: string; metadata: PosixMetadata | undefined }[] = [];
  const discover = async (path: string): Promise<void> => {
    const entry = await view.stat(path);
    if (entry === null) throw new Error(`published Merkle path disappeared: ${path}`);
    if (path !== '') tally?.resolve(path);
    if (entry.kind === 'dir') {
      if (path !== '') {
        root.mkdir(path, entry.mode);
        directories.push({ path, metadata: entry.metadata });
      }
      const children = await view.readdir(path);
      await runRestorePool(children, async (child) =>
        await discover(path === '' ? child : `${path}/${child}`));
      return;
    }
    if (entry.kind === 'symlink') {
      root.symlink(entry.target!, path);
      restoreMetadata(root, path, entry.metadata, true);
      tally?.materialize();
      return;
    }
    if (entry.size === undefined || entry.ino === undefined) {
      throw new Error(`published Merkle file has incomplete metadata: ${path}`);
    }
    // CLAIM BEFORE THE NEXT AWAIT. JavaScript cannot interleave this read and
    // write, so exactly one occurrence owns the source; every later one sees
    // its deferred and waits for the source rather than creating a second file.
    const held = inodes.get(entry.ino);
    if (held !== undefined) {
      links.push({ path, claim: held });
      return;
    }
    const deferred = Promise.withResolvers<void>();
    const claim: InodeClaim = {
      source: path,
      ready: deferred.promise,
      complete: deferred.resolve,
    };
    inodes.set(entry.ino, claim);
    files.push({ path, mode: entry.mode, size: entry.size, metadata: entry.metadata, claim });
  };

  await discover('');
  mark(`tree walk (${String(directories.length)} dirs, ${String(files.length)} files, ${String(links.length)} links)`);
  tally?.materializing();

  let restoredBytes = 0;
  const materializing = runRestorePool(files, async (file) => {
    createCandidateRestoreFile(root, file.path, file.mode, file.size);
    for (const extent of await view.extents(file.path)) {
      if (extent.kind !== 'data') continue;
      await restoreCandidateRange(root, file.path, extent.offset, extent.length,
        async (offset, length) => await view.readRange(file.path, offset, length));
      restoredBytes += extent.length;
    }
    restoreMetadata(root, file.path, file.metadata);
    file.claim.complete();
    tally?.materialize();
  });
  // A link worker waits on its source WITHOUT taking a data worker's slot. A
  // directory with many aliases therefore cannot deadlock by filling the pool
  // with waiters while the one source it needs is still queued.
  const linking = runRestorePool(links, async (link) => {
    await link.claim.ready;
    root.hardlink(link.claim.source, link.path);
    tally?.materialize();
  });
  await Promise.all([materializing, linking]);
  mark(`data (${String(restoredBytes)} bytes)`);

  // LAST, and deepest first: creating a child is what moved a directory's
  // mtime, so its captured timestamps can only be restored once no child is
  // still to come.
  for (const directory of directories.reverse()) {
    restoreMetadata(root, directory.path, directory.metadata);
  }
  mark('directory metadata');
}

async function restoreMerkle(
  options: CandidateRunOptions,
  head: StoredHead,
  store: FusePayloadStore,
): Promise<{ readonly work: CandidateRestoreWork; readonly bound: CandidateRestoreBound }> {
  // WHERE THE TIME WENT, phase by phase, on stderr. The overrun this repairs
  // reported one line — that it had overrun — and nothing about which half of
  // the walk spent the budget. The container hands this stream back with a
  // failed run, so a partial breakdown is what a killed restore leaves behind.
  const startedAt = Date.now();
  const notes: string[] = [];
  const identity = restoreIdentity(options, head);
  const counter = new RestoreReadCounter();
  const counted = new CountedRestoreStore(store, counter);
  let pathsResolved = 0;
  let maxNodeDepth = 0;
  let cpuSteps = 0;
  let walkedOps = 0;
  let walkedMetadataBytes = 0;
  const tally: RestoreMerkleTally = {
    resolve: (path) => {
      pathsResolved += 1;
      const depth = path.split('/').length + 1;
      if (depth > maxNodeDepth) maxNodeDepth = depth;
    },
    materializing: () => {
      const walked = counter.snapshot();
      walkedOps = walked.ops;
      walkedMetadataBytes = walked.metadataBytes;
      counted.cls = 'payload';
    },
    materialize: () => {
      cpuSteps += 1;
    },
  };
  try {
    const manifestBytes = await counted.readRange({
      ...identity, exactKey: head.envelope.rootObject.key, method: 'GET', byteOffset: '0',
      byteLength: head.envelope.rootObject.byteLength, sha256: head.envelope.rootObject.sha256,
    });
    const view = await openMerklePack({ rootId: sha256Hex(manifestBytes), manifestBytes }, counted, identity);
    const openReads = counter.snapshot().ops;
    notes.push(`manifest+index ${String(Date.now() - startedAt)} ms`);
    const root = new BeneathRoot(options.workspace);
    try {
      await restoreMerkleTree(view, root, notes, tally);
    } finally {
      root.close();
    }
    const figured = counter.snapshot();
    const nodeFetches = walkedOps - openReads;
    return {
      work: {
        serialRemoteOps: figured.criticalPath,
        totalRemoteOps: figured.ops,
        metadataBytes: walkedMetadataBytes,
        payloadBytes: figured.payloadBytes,
        cpuSteps,
        replayUnits: nodeFetches,
      },
      bound: {
        openReads,
        layersConsulted: null,
        maxNodeDepth,
        nodeFetches,
        pathsResolved,
      },
    };
  } finally {
    process.stderr.write(`merkle-pack restore: ${notes.join(', ')}, `
      + `wall ${String(Date.now() - startedAt)} ms\n`);
  }
}

async function checkpointResult(
  draft: CandidatePublicationDraft,
  store: FusePayloadStore,
): Promise<CandidateCheckpointPublishedResult> {
  const closureBytes = await store.readRange({
    operationId: draft.operationId,
    attemptId: draft.attemptId,
    boxId: 'closure-accounting',
    epoch: draft.capturedCut.epoch,
    exactKey: draft.closureObject.key,
    method: 'GET',
    byteOffset: '0',
    byteLength: draft.closureObject.byteLength,
    sha256: draft.closureObject.sha256,
    expiresAt: String(Date.now() + 60_000),
  });
  const closure = v.parse(v.array(ImmutableObjectRefSchema), JSON.parse(new TextDecoder().decode(closureBytes)));
  return {
    ok: true,
    movedBytes: [...draft.dependencyReceipts, draft.rootReceipt, draft.closureReceipt]
      .reduce((bytes, receipt) => bytes + Number(receipt.byteLength), 0),
    heldBytes: closure.reduce((bytes, ref) => bytes + Number(ref.byteLength), 0),
    draft,
  };
}

/** No journal daemon is serving this container, so no cut can be fenced. */
export class CandidateCaptureUnavailable extends Error {
  constructor(socket: string, cause?: Error) {
    super(`candidate capture unavailable: no mutation journal answers at ${socket}`, { cause });
    this.name = 'CandidateCaptureUnavailable';
  }
}

/** Stages FUSE-owned payloads and returns a draft for the host to finalize. */
export async function publishCapturedCandidate(
  options: CandidateRunOptions,
  capture: AuditedCapture,
): Promise<CandidateCheckpointPublishedResult> {
  if (options.action !== 'checkpoint') throw new Error('captured candidate publication requires checkpoint action');
  await mkdir(options.store, { recursive: true });
  const control = controlState(options);
  const input = checkpointGrant(options, control);
  if (capture.capturedCut.captureId !== input.operationId
    || capture.capturedCut.epoch !== input.epoch
    || capture.capturedCut.baseRevision !== input.baseRevision) {
    throw new Error('captured cut does not belong to the host checkpoint grant');
  }
  const head = control.head;
  const payload = new FusePayloadStore(options.store);
  const sink = new FileCandidateObjectSink({
    write: async (key, sealedBytes) => await atomicWrite(objectPath(options.store, key), sealedBytes),
    open: (key) => Bun.file(objectPath(options.store, key)).stream(),
  });
  if (options.format === 'bounded-layers') {
    const parent = head === null
      ? undefined
      : (await openBounded(head.envelope.rootObject, payload, input)).withPublishedParent(
        await recoverParent(head, payload, input),
      );
    const built = await buildBounded(capture, parent, sink);
    return await checkpointResult(await stageCandidatePayload(built.plan, input, payload), payload);
  }
  let parent = null;
  if (head !== null) {
    const manifestBytes = await payload.readRange({
      operationId: input.operationId,
      attemptId: input.attemptId,
      boxId: input.boxId,
      epoch: input.epoch,
      exactKey: head.envelope.rootObject.key,
      method: 'GET',
      byteOffset: '0',
      byteLength: head.envelope.rootObject.byteLength,
      sha256: head.envelope.rootObject.sha256,
      expiresAt: input.expiresAt,
    });
    parent = parentFromPublishedParent(
      await openMerklePack({ rootId: sha256Hex(manifestBytes), manifestBytes }, payload, input),
      await recoverParent(head, payload, input),
    );
  }
  const built = await buildMerklePack(capture, { parent, sink });
  return await checkpointResult(await stageCandidatePayload(built.plan, input, payload), payload);
}

/** A lower cut proves corruption only after the daemon authenticated its base. */
export class CandidateFenceRefused extends Error {
  constructor(fencedCut: number, publishedCut: string) {
    super(`candidate journal fence cut ${fencedCut} is lower than published cut ${publishedCut}`);
    this.name = 'CandidateFenceRefused';
  }
}

/** A journal that did not start at the durable head cannot publish or skip it. */
export class CandidateFenceBaseRefused extends Error {
  constructor() {
    super('candidate journal fence does not authenticate the published head base');
    this.name = 'CandidateFenceBaseRefused';
  }
}

function fencePublishedHead(control: CandidateRunControlV1, fence: JournalFence): boolean {
  const base = publishedJournalBase(control);
  if (base === null) return false;
  if (
    fence.base === null
    || fence.base.cut !== base.cut
    || fence.base.generation !== base.generation
    || fence.base.root !== base.root
  ) {
    throw new CandidateFenceBaseRefused();
  }
  const fencedCut = BigInt(fence.cut);
  const publishedCut = BigInt(base.cut);
  if (fencedCut < publishedCut) throw new CandidateFenceRefused(fence.cut, base.cut);
  return fencedCut === publishedCut;
}

/**
 * Fence the container's mutation journal and publish that exact cut. The
 * daemon owns the tree the workload writes through, so the capture is the
 * journal's own manifest and no code walks the workspace.
 */
async function checkpointCandidate(options: CandidateRunOptions): Promise<CandidateCheckpointResult> {
  const control = controlState(options);
  const grant = checkpointGrant(options, control);
  let fence: JournalFence;
  try {
    fence = await new JournalDaemonClient(options.journalSocket).fence();
  } catch (error) {
    // No socket and nothing listening are the two shapes of "this container has
    // no journal". Every other failure is a daemon that answered badly.
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code !== 'ENOENT' && code !== 'ECONNREFUSED') throw error;
    throw new CandidateCaptureUnavailable(
      options.journalSocket,
      error instanceof Error ? error : new Error(String(error)),
    );
  }
  if (fencePublishedHead(control, fence)) return { ok: true, noChange: true };
  // THE DAEMON SPEAKS v2, AND ONLY v2: `write_manifest_head` in
  // `bench/journal-daemon/journal-delta.c` is its one manifest writer and it
  // emits `{"version":2,...`, a baseless fence differing only in
  // `"base":null`. So the capture is read through `readJournalDelta` — the
  // manifest proven the fence's own, every staged read held to the digest the
  // fence recorded and resolved beneath the stage root — and converted into
  // the sealed capture both codecs consume: partial against the head the delta
  // names, whole-tree when it names no base because there is no parent to
  // merge against. A manifest that is not version 2 is refused by
  // `parseDeltaManifest`, where manifests are parsed.
  const delta = await readJournalDelta(fence);
  try {
    const capture = await captureFromDelta(delta, {
      captureId: grant.operationId,
      epoch: grant.epoch,
      baseRevision: grant.baseRevision,
      stableStageHandle: `journal-${fence.generation}-${fence.cut}`,
    });
    return await publishCapturedCandidate(options, capture);
  } finally {
    delta.close();
  }
}

/**
 * One v2 delta manifest as the PARTIAL sealed capture both codecs merge.
 *
 * The entries are the delta's own rows — every touched path plus its
 * ancestors, which is exactly the consistent partial tree the capture model's
 * partial rule demands — with file content read from the delta's stage, where
 * every read is held to the digest the fence recorded for exactly those bytes.
 * The removals are the WAL's own structural deletions (unlink/rmdir, and the
 * old name of a rename), which is what the daemon's `removed` semantics state.
 *
 * A delta with no base is a FIRST fence (no published head to build against):
 * its rows are the whole tree as the daemon sees it, so it publishes as a
 * whole-tree capture — `partial: false`, which also carries no `removed`,
 * because there is no parent state to remove from.
 */
async function captureFromDelta(
  delta: JournalDelta,
  identity: { captureId: string; epoch: string; baseRevision: string; stableStageHandle: string },
) {
  const manifest = delta.manifest;
  const partial = manifest.base !== null;
  const entries: NodeEntry[] = [];
  for (const row of manifest.entries) {
    const metadata: PosixMetadata = {
      uid: row.uid,
      gid: row.gid,
      atimeNs: row.atimeNs,
      mtimeNs: row.mtimeNs,
      ctimeNs: row.ctimeNs,
      xattrs: { ...row.xattrs },
    };
    if (row.kind === 'symlink') {
      if (row.target === undefined) throw new Error(`delta row ${row.path} is a symlink with no target`);
      entries.push({ path: row.path, kind: 'symlink', mode: row.mode, ino: Number(row.ino), metadata, target: row.target });
      continue;
    }
    if (row.kind === 'dir') {
      entries.push({ path: row.path, kind: 'dir', mode: row.mode, ino: Number(row.ino), metadata });
      continue;
    }
    const sealed = {
      kind: 'sealed' as const,
      size: row.size,
      sourceId: row.path,
      extents: row.ranges.map((range) => ({ offset: range.offset, length: range.length, sha256: range.sha256 })),
    };
    entries.push({ path: row.path, kind: 'file', mode: row.mode, ino: Number(row.ino), metadata, content: sealed });
  }
  // THE REMOVALS the WAL recorded: unlink, rmdir, and a rename's old name. A
  // failed op (`result < 0`) removed nothing, and non-structural ops touch
  // only what their own rows state.
  const removed: string[] = [];
  if (partial) {
    for (const op of manifest.metadataOps) {
      if (op.result < 0) continue;
      if (op.op === 'unlink' || op.op === 'rmdir') removed.push(op.path);
      if (op.op === 'rename') removed.push(op.path);
    }
  }
  const capture: Capture = {
    mechanism: 'mutation-journal',
    cut: manifest.cut,
    generation: manifest.generation,
    entries,
  };
  return issueVerifiedJournalCapture({
    cut: manifest.cut,
    generation: manifest.generation,
    entries,
    identity,
    manifestSha256: manifestSha256(capture),
    sealedReader: {
      read: async (sourceId, offset, length) => await delta.stage.read(sourceId, offset, length),
    },
    partial,
    removed: partial ? removed : [],
  });
}

async function seedCandidateJournal(options: CandidateRunOptions): Promise<CandidateSeedResult> {
  const base = publishedJournalBase(controlState(options));
  if (base !== null) await new JournalDaemonClient(options.journalSocket).seed(base);
  return { ok: true };
}

async function restoreCandidate(options: CandidateRunOptions): Promise<CandidateRestoreResult> {
  const head = controlState(options).head;
  if (head === null) return { ok: true, rootId: null };
  const payload = new FusePayloadStore(options.store);
  const counted = await withReadChain(async () => head.envelope.format === 'bounded-layers/v1'
    ? await restoreBounded(options, head, payload)
    : await restoreMerkle(options, head, payload));
  return { ok: true, rootId: head.pointer.rootEnvelopeId, work: counted.work, bound: counted.bound };
}

export async function runCandidate(
  options: CandidateRunOptions,
): Promise<CandidateRestoreResult | CandidateCheckpointResult | CandidateSeedResult> {
  await mkdir(options.store, { recursive: true });
  await mkdir(options.workspace, { recursive: true });
  if (options.action === 'checkpoint') return await checkpointCandidate(options);
  if (options.action === 'restore') return await restoreCandidate(options);
  return await seedCandidateJournal(options);
}

interface CandidateRunnerCliOptions {
  readonly options: CandidateRunOptions;
  readonly resultPath: string;
}

async function parseCli(argv: readonly string[]): Promise<CandidateRunnerCliOptions> {
  const value = (key: string): string => {
    const index = argv.indexOf(key);
    if (index === -1 || argv[index + 1] === undefined) throw new Error(`missing ${key}`);
    return argv[index + 1]!;
  };
  const action = value('--action');
  const format = value('--format');
  if (
    (action !== 'checkpoint' && action !== 'restore' && action !== 'seed')
    || (format !== 'bounded-layers' && format !== 'merkle-pack')
  ) {
    throw new Error('invalid candidate action or format');
  }
  return {
    options: {
      action,
      format,
      workspace: value('--workspace'),
      store: value('--store'),
      boxId: value('--box'),
      journalSocket: value('--journal-socket'),
      control: JSON.parse(await readFile(value('--control'), 'utf8')),
    },
    resultPath: value('--result'),
  };
}

if (import.meta.main) {
  try {
    const cli = await parseCli(process.argv.slice(2));
    await atomicWrite(cli.resultPath, new TextEncoder().encode(JSON.stringify(await runCandidate(cli.options))));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
