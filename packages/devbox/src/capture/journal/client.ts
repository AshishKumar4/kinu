/**
 * The one client of the journal daemon's control socket, and the stage it
 * reads. Two lanes built the two halves of one wire in parallel and each
 * wrote a client; this is the survivor.
 *
 * THREE OPS. `fence` closes admission, stages the dirty windows, and answers
 * the cut; `boundaries` hands the chunk boundaries of the files a published
 * generation rewrote BACK to the daemon after that generation's head CAS, so
 * the next fence can stage windows instead of whole files; `seed` names the
 * published head a WAL starts from. Everything here goes through
 * `request()`'s one framing: one NDJSON line per connection, `id` echoed
 * back, reply parsed at this boundary.
 *
 * WHY `boundaries` MERGES. A full boundary map is O(total extents) — one
 * 64 MiB file is about 16,000 offsets — so re-sending it per publish would put
 * an O(n) term back into the path this design just made O(k). The request
 * therefore carries only the files this generation changed plus the paths it
 * dropped; the daemon merges by ino and path and replaces only the base.
 *
 * THE DELTA MANIFEST ITSELF LIVES IN ONE PLACE, `merkle-pack/delta.ts`, with
 * the builder that consumes it — this client PARSES it, and the wire shape is
 * the daemon's, which is declared beside its only reader.
 */

import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { resolve } from 'node:path';

import * as v from 'valibot';
import { BeneathRoot } from '../../native-openat2';

import { issueVerifiedJournalCapture, manifestSha256 } from '../model';
import { sha256Hex } from '../../cas/hash';
import { parseDeltaManifest } from '../../candidates/merkle-pack/delta';
import type { BoundaryHandback, DeltaDirtyFile, DeltaManifestV2, DeltaStagedRange } from '../../candidates/merkle-pack/delta';
import { SealWorkSchema } from '../../durability/contracts';
import type { SealWork } from '../../durability/contracts';
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

/** The immutable published head a journal WAL starts from. */
export interface JournalBase {
  readonly cut: string;
  readonly generation: string;
  readonly root: string;
}

/** One line on the daemon's AF_UNIX control socket; `id` must echo back. */
interface ControlRequest {
  readonly id: string;
  readonly op: 'base' | 'fence' | 'boundaries';
  readonly cut?: string;
  readonly generation?: string;
  readonly root?: string;
  readonly maxChunkBytes?: number;
  readonly files?: readonly { readonly ino: string; readonly path: string; readonly size: number; readonly boundaries: readonly number[] }[];
  readonly removed?: readonly string[];
}

export interface JournalFence {
  readonly cut: number;
  readonly generation: number;
  readonly manifestPath: string;
  readonly base: JournalBase | null;
  readonly sealWork: SealWork;
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
  async boundaries(handback: BoundaryHandback, signal?: AbortSignal): Promise<number> {
    const id = crypto.randomUUID();
    const response = await request(this.socket, {
      id,
      op: 'boundaries',
      cut: handback.cut,
      generation: handback.generation,
      root: handback.root,
      maxChunkBytes: handback.maxChunkBytes,
      files: handback.files,
      removed: handback.removed,
    }, signal);
    if (response.id !== id) throw new Error('journal control response id mismatch');
    if (!response.ok || response.boundaryFiles === undefined) {
      throw new Error(`journal boundary publication failed: ${response.error ?? 'malformed response'}`);
    }
    if (response.boundaryFiles !== handback.files.length) {
      throw new Error(`journal merged ${response.boundaryFiles} boundary files, sent ${handback.files.length}`);
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

/** The delta a fence wrote: its manifest, and the staged bytes it names. */
export interface JournalDelta {
  readonly manifest: DeltaManifestV2;
  /** Reads staged bytes beneath the manifest's own stage root, holding every
   *  read to the digest the fence recorded for exactly those bytes. */
  readonly stage: {
    read(path: string, offset: number, length: number): Promise<Uint8Array>;
  };
  /** Releases the stage root's directory handle. */
  close(): void;
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
export async function readJournalDelta(fence: JournalFence): Promise<JournalDelta> {
  const manifest = parseDeltaManifest(await readFile(fence.manifestPath));
  if (manifest.cut !== fence.cut || manifest.generation !== fence.generation) {
    throw new Error('journal delta manifest is not the fenced manifest');
  }
  const root = new BeneathRoot(resolve(manifest.stageRoot));
  const byPath = new Map(manifest.entries.map((entry) => [entry.path, entry]));
  return {
    manifest,
    stage: {
      read: async (path, offset, length) => {
        const entry: DeltaDirtyFile | undefined = byPath.get(path);
        if (entry === undefined) throw new Error(`journal delta names no entry ${path}`);
        if (entry.kind !== 'file') throw new Error(`journal delta entry ${path} stages no bytes`);
        const covering = entry.ranges.find(
          (range: DeltaStagedRange) => range.offset <= offset && offset + length <= range.offset + range.length,
        );
        if (covering === undefined) {
          throw new Error(`journal delta stages no range covering ${path} at ${offset}+${length}`);
        }
        const staged = await root.readRange(path, offset, length);
        if (staged.byteLength !== length) {
          throw new Error(`journal delta stage is short for ${path} at ${offset}`);
        }
        if (sha256Hex(staged) !== covering.sha256) {
          throw new Error(`journal delta stage failed integrity verification for ${path} at ${offset}`);
        }
        return staged;
      },
    },
    close: () => root.close(),
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
