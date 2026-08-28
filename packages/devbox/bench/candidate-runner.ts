import { createHash } from 'node:crypto';
import { closeSync, constants as FS, createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { sha256Hex } from '../src/cas/hash';
import * as v from 'valibot';
import type { AuditedCapture } from '../src/capture/model';
import { build as buildBounded, open as openBounded } from '../src/candidates/bounded-layers';
import { buildMerklePack, openMerklePack, parentFromPublishedParent } from '../src/candidates/merkle-pack';
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
          const length = part.size * ('count' in part ? part.count : 1);
          if (part.hole !== true) {
            await restoreCandidateRange(root, path, offset, length, async (at, bytes) =>
              await view.readRange(path, at, bytes));
          }
          offset += length;
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

async function restoreMerkle(options: CandidateRunOptions, head: StoredHead, store: FusePayloadStore): Promise<void> {
  const identity = restoreIdentity(options, head);
  const manifestBytes = await store.readRange({
    ...identity, exactKey: head.envelope.rootObject.key, method: 'GET', byteOffset: '0',
    byteLength: head.envelope.rootObject.byteLength, sha256: head.envelope.rootObject.sha256,
  });
  const view = await openMerklePack({ rootId: sha256Hex(manifestBytes), manifestBytes }, store, identity);
  const root = new BeneathRoot(options.workspace);
  const inodes = new Map<number, string>();
  const restoreAt = async (path: string): Promise<void> => {
    const entry = await view.stat(path);
    if (entry === null) throw new Error(`published Merkle path disappeared: ${path}`);
    if (entry.kind === 'dir') {
      if (path !== '') root.mkdir(path, entry.mode);
      for (const child of await view.readdir(path)) await restoreAt(path === '' ? child : `${path}/${child}`);
      if (path !== '') restoreMetadata(root, path, entry.metadata);
    } else if (entry.kind === 'symlink') {
      root.symlink(entry.target!, path);
      restoreMetadata(root, path, entry.metadata, true);
    } else {
      if (entry.size === undefined || entry.ino === undefined) throw new Error(`published Merkle file has incomplete metadata: ${path}`);
      const source = inodes.get(entry.ino);
      if (source !== undefined) {
        root.hardlink(source, path);
        return;
      }
      createCandidateRestoreFile(root, path, entry.mode, entry.size);
      for (const extent of await view.extents(path)) {
        if (extent.kind === 'data') {
          await restoreCandidateRange(root, path, extent.offset, extent.length, async (offset, length) =>
            await view.readRange(path, offset, length));
        }
      }
      restoreMetadata(root, path, entry.metadata);
      inodes.set(entry.ino, path);
    }
  };
  try {
    for (const path of await view.readdir('')) await restoreAt(path);
  } finally {
    root.close();
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
