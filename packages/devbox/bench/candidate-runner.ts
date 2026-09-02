import { createHash } from 'node:crypto';
import { closeSync, constants as FS, createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { sha256Hex } from '../src/cas/hash';
import * as v from 'valibot';
import type { AuditedCapture } from '../src/capture/model';
import { build as buildBounded, isHoleExtent, open as openBounded } from '../src/candidates/bounded-layers';
import { buildMerklePack, openMerklePack, parentFromPublishedParent } from '../src/candidates/merkle-pack';
import type { MerklePackView } from '../src/candidates/merkle-pack';
import { JournalDaemonClient, captureFromJournalFence } from '../src/capture/journal/client';
import type { JournalBase, JournalFence } from '../src/capture/journal/client';
import type { PosixMetadata } from '../src/capture/model';
import { FileCandidateObjectSink, envelopeBytes, recoverPublishedParent, requireEnvelopeAt, stageCandidatePayload } from '../src/candidates/publication';
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
async function restoreBounded(options: CandidateRunOptions, head: StoredHead, store: FusePayloadStore): Promise<void> {
  const view = await openBounded(head.envelope.rootObject, store, restoreIdentity(options, head));
  const root = new BeneathRoot(options.workspace);
  const inodes = new Map<number, string>();
  try {
    const directories: { readonly path: string; readonly metadata: PosixMetadata | undefined }[] = [];
    for (const path of view.entryPaths()) {
      const entry = view.stat(path)!;
      if (entry.kind === 'dir') {
        root.mkdir(path, entry.mode);
        directories.push({ path, metadata: entry.metadata });
      } else if (entry.kind === 'symlink') {
        root.symlink(entry.target!, path);
        restoreMetadata(root, path, entry.metadata, true);
      } else {
        if (entry.size === undefined) throw new Error(`published bounded file has no size: ${path}`);
        const source = inodes.get(entry.ino);
        if (source !== undefined) {
          root.hardlink(source, path);
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
      }
    }
    for (const directory of directories.reverse()) {
      restoreMetadata(root, directory.path, directory.metadata);
    }
  } finally {
    root.close();
  }
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
  await Promise.all(Array.from({ length: Math.min(RESTORE_POOL_WIDTH, items.length) }, () => worker()));
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
  });
  // A link worker waits on its source WITHOUT taking a data worker's slot. A
  // directory with many aliases therefore cannot deadlock by filling the pool
  // with waiters while the one source it needs is still queued.
  const linking = runRestorePool(links, async (link) => {
    await link.claim.ready;
    root.hardlink(link.claim.source, link.path);
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

async function restoreMerkle(options: CandidateRunOptions, head: StoredHead, store: FusePayloadStore): Promise<void> {
  // WHERE THE TIME WENT, phase by phase, on stderr. The overrun this repairs
  // reported one line — that it had overrun — and nothing about which half of
  // the walk spent the budget. The container hands this stream back with a
  // failed run, so a partial breakdown is what a killed restore leaves behind.
  const startedAt = Date.now();
  const notes: string[] = [];
  const identity = restoreIdentity(options, head);
  try {
    const manifestBytes = await store.readRange({
      ...identity, exactKey: head.envelope.rootObject.key, method: 'GET', byteOffset: '0',
      byteLength: head.envelope.rootObject.byteLength, sha256: head.envelope.rootObject.sha256,
    });
    const view = await openMerklePack({ rootId: sha256Hex(manifestBytes), manifestBytes }, store, identity);
    notes.push(`manifest+index ${String(Date.now() - startedAt)} ms`);
    const root = new BeneathRoot(options.workspace);
    try {
      await restoreMerkleTree(view, root, notes);
    } finally {
      root.close();
    }
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
  const capture = await captureFromJournalFence(fence, {
    captureId: grant.operationId,
    epoch: grant.epoch,
    baseRevision: grant.baseRevision,
    stableStageHandle: `journal-${fence.generation}-${fence.cut}`,
  });
  return await publishCapturedCandidate(options, capture);
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
  if (head.envelope.format === 'bounded-layers/v1') await restoreBounded(options, head, payload);
  else await restoreMerkle(options, head, payload);
  return { ok: true, rootId: head.pointer.rootEnvelopeId };
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

function parseCli(argv: readonly string[]): CandidateRunnerCliOptions {
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
      control: JSON.parse(Buffer.from(value('--control-state'), 'base64').toString('utf8')),
    },
    resultPath: value('--result'),
  };
}

if (import.meta.main) {
  try {
    const cli = parseCli(process.argv.slice(2));
    await atomicWrite(cli.resultPath, new TextEncoder().encode(JSON.stringify(await runCandidate(cli.options))));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
