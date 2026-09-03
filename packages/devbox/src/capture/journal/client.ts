import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { resolve } from 'node:path';

import * as v from 'valibot';
import { BeneathRoot } from '../../native-openat2';

import { journalDaemonArgv, type JournalDaemonPaths } from './command';
import { issueVerifiedJournalCapture, manifestSha256 } from '../model';
import { sha256Hex } from '../../cas/hash';
import type { AuditedCapture, CapturedCutIdentity, NodeEntry, NodeKind, SealedContentReader } from '../model';

const NonEmptyString = v.pipe(v.string(), v.minLength(1));
const SafeNumber = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const Digest = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
const ExtentSchema = v.strictObject({ offset: SafeNumber, length: v.pipe(SafeNumber, v.minValue(1)), sha256: Digest });
const ContentSchema = v.strictObject({ kind: v.literal('sealed'), size: SafeNumber, sourceId: NonEmptyString, extents: v.array(ExtentSchema) });
const Nanoseconds = v.pipe(v.string(), v.regex(/^(?:0|[1-9]\d*)$/));
const XattrValue = v.pipe(v.string(), v.regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/));
const PosixMetadataSchema = v.strictObject({
  uid: SafeNumber,
  gid: SafeNumber,
  atimeNs: Nanoseconds,
  mtimeNs: Nanoseconds,
  ctimeNs: Nanoseconds,
  xattrs: v.record(v.string(), XattrValue),
});
const EntrySchema = v.strictObject({
  path: NonEmptyString,
  kind: v.picklist(['file', 'dir', 'symlink'] as const),
  mode: SafeNumber,
  ino: v.pipe(SafeNumber, v.minValue(1)),
  metadata: PosixMetadataSchema,
  target: v.optional(NonEmptyString),
  content: v.optional(ContentSchema),
});
const ManifestSchema = v.strictObject({ cut: SafeNumber, generation: SafeNumber, stageRoot: NonEmptyString, entries: v.array(EntrySchema) });

/**
 * The delta manifest a v2 fence writes: the files and directories the journal
 * shows changed since the previous fence, the ordered metadata operations that
 * changed them, and the staged bytes of the dirty clusters.
 *
 * It is NOT a whole tree, which is the entire point: a seal costs O(k) rather
 * than O(n). Reconstructing a tree from one is the incremental builder's job,
 * against the head this manifest names in `base`.
 */
const InoDecimal = v.pipe(v.string(), v.regex(/^[1-9]\d*$/));
const DeltaRangeSchema = v.strictObject({
  offset: SafeNumber,
  length: v.pipe(SafeNumber, v.minValue(1)),
  sha256: Digest,
});
const DeltaEntrySchema = v.strictObject({
  path: NonEmptyString,
  kind: v.picklist(['file', 'dir', 'symlink'] as const),
  ino: InoDecimal,
  mode: SafeNumber,
  uid: SafeNumber,
  gid: SafeNumber,
  atimeNs: Nanoseconds,
  mtimeNs: Nanoseconds,
  ctimeNs: Nanoseconds,
  xattrs: v.record(v.string(), XattrValue),
  target: v.optional(NonEmptyString),
  size: v.optional(SafeNumber),
  whole: v.optional(v.boolean()),
  /** The byte ranges writes touched since the previous fence: where a re-chunk
   *  has to begin. Not the same as `ranges`, which is what the stage holds. */
  dirty: v.optional(v.array(v.strictObject({ offset: SafeNumber, length: v.pipe(SafeNumber, v.minValue(1)) }))),
  ranges: v.optional(v.array(DeltaRangeSchema)),
});
const MetadataOpSchema = v.strictObject({
  sequence: v.pipe(SafeNumber, v.minValue(1)),
  op: NonEmptyString,
  path: v.string(),
  argument: v.string(),
  result: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});
const SealWorkSchema = v.strictObject({
  bytesStaged: SafeNumber,
  bytesChunked: SafeNumber,
  chunksHashed: SafeNumber,
  nodesRewritten: SafeNumber,
  wholeFiles: SafeNumber,
});
const BaseIdentitySchema = v.strictObject({ cut: Nanoseconds, generation: Nanoseconds, root: Digest });
const DeltaManifestSchema = v.strictObject({
  version: v.literal(2),
  cut: SafeNumber,
  generation: SafeNumber,
  stageRoot: NonEmptyString,
  base: v.nullable(BaseIdentitySchema),
  entries: v.array(DeltaEntrySchema),
  metadataOps: v.array(MetadataOpSchema),
  sealWork: SealWorkSchema,
});

const ControlResponseSchema = v.strictObject({
  id: NonEmptyString,
  ok: v.boolean(),
  error: v.optional(NonEmptyString),
  cut: v.optional(SafeNumber),
  generation: v.optional(SafeNumber),
  manifestPath: v.optional(NonEmptyString),
  baseCut: v.optional(Nanoseconds),
  baseGeneration: v.optional(Nanoseconds),
  baseRoot: v.optional(Digest),
  sealWork: v.optional(SealWorkSchema),
  boundaryFiles: v.optional(SafeNumber),
});

type ControlResponse = v.InferOutput<typeof ControlResponseSchema>;

/** What one seal cost, in the field names the durability contract declares. */
export type JournalSealWork = v.InferOutput<typeof SealWorkSchema>;
/** One staged run of a dirty file, with the digest of the bytes in the stage. */
export type JournalDeltaRange = v.InferOutput<typeof DeltaRangeSchema>;
/** One path the delta describes, as it stands at the cut. */
export type JournalDeltaEntry = v.InferOutput<typeof DeltaEntrySchema>;
/** One metadata operation to replay, in journal order. */
export type JournalMetadataOp = v.InferOutput<typeof MetadataOpSchema>;
/** A parsed delta manifest. */
export type JournalDeltaManifest = v.InferOutput<typeof DeltaManifestSchema>;

/** The immutable published head a journal WAL starts from. */
export interface JournalBase {
  readonly cut: string;
  readonly generation: string;
  readonly root: string;
}

/**
 * One file's published chunk boundaries, as the publish that created them saw
 * them: offsets in ascending order, including the file's start and end.
 */
export interface PublishedFileBoundaries {
  readonly ino: string;
  readonly path: string;
  readonly size: number;
  readonly boundaries: readonly number[];
}

/**
 * What the sidecar hands back after a successful head CAS. Only the files whose
 * boundaries CHANGED are sent, plus the paths the generation stopped needing;
 * a full map per publish would be O(total extents) and would put the O(n) the
 * fence just shed back on the publish path.
 */
export interface PublishedBoundaries {
  readonly base: JournalBase;
  readonly maxChunkBytes: number;
  readonly files: readonly PublishedFileBoundaries[];
  readonly removed: readonly string[];
}

/** One line on the daemon's AF_UNIX control socket; `id` must echo back. */
interface ControlRequest {
  readonly id: string;
  readonly op: 'base' | 'fence' | 'boundaries';
  readonly cut?: string;
  readonly generation?: string;
  readonly root?: string;
  readonly maxChunkBytes?: number;
  readonly files?: readonly PublishedFileBoundaries[];
  readonly removed?: readonly string[];
}

export interface JournalFence {
  readonly cut: number;
  readonly generation: number;
  readonly manifestPath: string;
  readonly base: JournalBase | null;
  readonly sealWork: JournalSealWork;
}

export interface JournalDaemonStartOptions extends JournalDaemonPaths {
  readonly signal?: AbortSignal;
}

export interface StartedJournalDaemon {
  readonly process: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
  readonly client: JournalDaemonClient;
}

function decodeEntry(entry: v.InferOutput<typeof EntrySchema>): NodeEntry {
  const kind: NodeKind = entry.kind;
  if (kind === 'file') {
    if (!entry.content || entry.target !== undefined) throw new Error(`journal file ${entry.path} has invalid metadata`);
    return { path: entry.path, kind, mode: entry.mode, ino: entry.ino, metadata: entry.metadata, content: entry.content };
  }
  if (kind === 'symlink') {
    if (entry.content !== undefined || entry.target === undefined) throw new Error(`journal symlink ${entry.path} has invalid metadata`);
    return { path: entry.path, kind, mode: entry.mode, ino: entry.ino, metadata: entry.metadata, target: entry.target };
  }
  if (entry.content !== undefined || entry.target !== undefined) throw new Error(`journal directory ${entry.path} has invalid metadata`);
  return { path: entry.path, kind, mode: entry.mode, ino: entry.ino, metadata: entry.metadata };
}

function stagedReader(stageRoot: string): SealedContentReader {
  const root = new BeneathRoot(resolve(stageRoot));
  return {
    async read(sourceId, offset, length) {
      return root.readRange(sourceId, offset, length);
    },
  };
}

async function request(socketPath: string, body: ControlRequest, signal?: AbortSignal): Promise<ControlResponse> {
  if (signal?.aborted) throw signal.reason;
  return await new Promise<ControlResponse>((resolveRequest, reject) => {
    const socket = connect(socketPath);
    let received = '';
    let settled = false;
    const settle = (resolve: () => void): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const fail = (error: Error): void => settle(() => reject(error));
    const abort = () => socket.destroy(signal?.reason instanceof Error ? signal.reason : new Error('journal request aborted'));
    signal?.addEventListener('abort', abort, { once: true });
    socket.setEncoding('utf8');
    socket.once('error', (error) => fail(error));
    socket.on('data', (chunk: string) => {
      received += chunk;
      const newline = received.indexOf('\n');
      if (newline < 0) return;
      socket.end();
      try {
        const response = v.parse(ControlResponseSchema, JSON.parse(received.slice(0, newline)));
        settle(() => resolveRequest(response));
      } catch (error) {
        fail(new Error('journal control response is invalid', { cause: error }));
      }
    });
    socket.once('connect', () => socket.write(`${JSON.stringify(body)}\n`));
    socket.once('close', () => {
      if (!settled) fail(new Error('journal control closed before a complete response'));
    });
  });
}

export class JournalDaemonClient {
  constructor(readonly socket: string) {}

  async seed(base: JournalBase, signal?: AbortSignal): Promise<void> {
    const id = crypto.randomUUID();
    const response = await request(this.socket, { id, op: 'base', ...base }, signal);
    if (response.id !== id) throw new Error('journal control response id mismatch');
    if (!response.ok) throw new Error(`journal base seed failed: ${response.error ?? 'malformed response'}`);
  }

  /**
   * Hands the daemon the chunk boundaries a publish created, together with the
   * head they belong to. One request, so the daemon can never hold boundaries
   * from one generation against the base of another: the seed and the merge
   * happen in the same admission-closed window.
   *
   * Answers how many files the daemon merged, which is `files.length` for a
   * request it accepted.
   */
  async publishBoundaries(published: PublishedBoundaries, signal?: AbortSignal): Promise<number> {
    const id = crypto.randomUUID();
    const response = await request(this.socket, {
      id,
      op: 'boundaries',
      cut: published.base.cut,
      generation: published.base.generation,
      root: published.base.root,
      maxChunkBytes: published.maxChunkBytes,
      files: published.files,
      removed: published.removed,
    }, signal);
    if (response.id !== id) throw new Error('journal control response id mismatch');
    if (!response.ok || response.boundaryFiles === undefined) {
      throw new Error(`journal boundary publication failed: ${response.error ?? 'malformed response'}`);
    }
    if (response.boundaryFiles !== published.files.length) {
      throw new Error(`journal merged ${response.boundaryFiles} boundary files, sent ${published.files.length}`);
    }
    return response.boundaryFiles;
  }

  async fence(signal?: AbortSignal): Promise<JournalFence> {
    const id = crypto.randomUUID();
    const response = await request(this.socket, { id, op: 'fence' }, signal);
    if (response.id !== id) throw new Error('journal control response id mismatch');
    if (!response.ok || response.cut === undefined || response.generation === undefined || response.manifestPath === undefined
      || response.sealWork === undefined) {
      throw new Error(`journal fence failed: ${response.error ?? 'malformed response'}`);
    }
    const seeded = [response.baseCut, response.baseGeneration, response.baseRoot];
    if (response.baseCut === undefined) {
      if (!seeded.every((value) => value === undefined)) throw new Error('journal fence has an incomplete base identity');
      return {
        cut: response.cut,
        generation: response.generation,
        manifestPath: response.manifestPath,
        base: null,
        sealWork: response.sealWork,
      };
    }
    if (response.baseGeneration === undefined || response.baseRoot === undefined) {
      throw new Error('journal fence has an incomplete base identity');
    }
    return {
      cut: response.cut,
      generation: response.generation,
      manifestPath: response.manifestPath,
      base: { cut: response.baseCut, generation: response.baseGeneration, root: response.baseRoot },
      sealWork: response.sealWork,
    };
  }
}

export function startJournalDaemon(options: JournalDaemonStartOptions): StartedJournalDaemon {
  const argv = [...journalDaemonArgv(options)];
  const process = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe', signal: options.signal });
  return { process, client: new JournalDaemonClient(resolve(options.socket)) };
}

/** Every staged byte the delta names, addressed the way it was staged. */
export interface JournalDeltaStage {
  /** Reads one staged range and refuses bytes that do not match its digest. */
  read(entry: JournalDeltaEntry, range: JournalDeltaRange): Promise<Uint8Array>;
}

export interface JournalDeltaCapture {
  readonly manifest: JournalDeltaManifest;
  readonly stage: JournalDeltaStage;
}

/**
 * Reads the delta manifest a fence wrote and binds it to its stage.
 *
 * The manifest must be the fence's own — the cut and generation are compared —
 * and every staged read is verified against the digest the fence recorded, so
 * a stage mutated after the fence is refused rather than consumed. Paths are
 * resolved beneath the stage root, so a swapped symlink cannot reach outside
 * it.
 */
export async function readJournalDelta(fence: JournalFence): Promise<JournalDeltaCapture> {
  const bytes = await readFile(fence.manifestPath);
  const manifest = v.parse(DeltaManifestSchema, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  if (manifest.cut !== fence.cut || manifest.generation !== fence.generation) {
    throw new Error('journal delta manifest is not the fenced manifest');
  }
  const root = new BeneathRoot(resolve(manifest.stageRoot));
  return {
    manifest,
    stage: {
      async read(entry, range) {
        if (entry.kind !== 'file') throw new Error(`journal delta entry ${entry.path} stages no bytes`);
        const staged = await root.readRange(entry.path, range.offset, range.length);
        if (staged.byteLength !== range.length) {
          throw new Error(`journal delta stage is short for ${entry.path} at ${range.offset}`);
        }
        if (sha256Hex(staged) !== range.sha256) {
          throw new Error(`journal delta stage failed integrity verification for ${entry.path} at ${range.offset}`);
        }
        return staged;
      },
    },
  };
}

/**
 * Issues an audited capture from a WHOLE-TREE fence manifest.
 *
 * A v2 delta manifest is refused by name here rather than parsed into a
 * partial tree: a delta is the input to an incremental build against the head
 * it names, never a capture of a whole filesystem.
 */
export async function captureFromJournalFence(fence: JournalFence, identity: CapturedCutIdentity): Promise<AuditedCapture> {
  const bytes = await readFile(fence.manifestPath);
  const decoded: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  const versioned = v.safeParse(v.looseObject({ version: v.optional(v.number()) }), decoded);
  if (versioned.success && versioned.output.version !== undefined) {
    throw new Error(`journal manifest version ${versioned.output.version} is a delta; read it with readJournalDelta`);
  }
  const manifest = v.parse(ManifestSchema, decoded);
  if (manifest.cut !== fence.cut || manifest.generation !== fence.generation) throw new Error('journal manifest is not the fenced manifest');
  const entries = manifest.entries.map(decodeEntry);
  return issueVerifiedJournalCapture({
    cut: manifest.cut,
    generation: manifest.generation,
    entries,
    identity,
    sealedReader: stagedReader(manifest.stageRoot),
    manifestSha256: manifestSha256({ mechanism: 'mutation-journal', cut: manifest.cut, generation: manifest.generation, entries }),
  });
}
