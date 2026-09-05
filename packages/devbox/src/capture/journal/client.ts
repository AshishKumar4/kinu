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

import { sha256Hex } from '../../cas/hash';
import { parseDeltaManifest } from '../../candidates/merkle-pack/delta';
import type { BoundaryHandback, DeltaDirtyFile, DeltaManifestV2, DeltaStagedRange } from '../../candidates/merkle-pack/delta';
import { SealWorkSchema } from '../../durability/contracts';
import type { SealWork } from '../../durability/contracts';
import { issueVerifiedJournalCapture, manifestSha256 } from '../model';
import type { AuditedCapture, Capture, NodeEntry, PosixMetadata, SealedContent, StructuralOp } from '../model';

const NonEmptyString = v.pipe(v.string(), v.minLength(1));
const SafeNumber = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const Digest = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
const Nanoseconds = v.pipe(v.string(), v.regex(/^(?:0|[1-9]\d*)$/));
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
 * One file row's content. A row a partial fence staged as windows carries its
 * `dirty` ranges, so a builder re-chunks only those and takes the rest from
 * the parent; a row staged whole, and every row of a first fence, carries none
 * and its extents are the file.
 */
function sealedRowContent(row: DeltaDirtyFile, partial: boolean): SealedContent {
  const extents = row.ranges.map((range) => ({ offset: range.offset, length: range.length, sha256: range.sha256 }));
  if (partial && !row.whole) {
    return {
      kind: 'sealed',
      size: row.size,
      sourceId: row.path,
      extents,
      dirty: row.dirty.map((range) => ({ offset: range.offset, length: range.length })),
    };
  }
  return { kind: 'sealed', size: row.size, sourceId: row.path, extents };
}

/**
 * The structural ops of one delta, in the capture model's four verbs. A failed
 * op (`result < 0`) changed nothing; a write is a dirty range and not an op;
 * truncates and attribute changes touch bytes and stat, never names. The
 * daemon's `argument` carries the rename destination and the link SOURCE
 * (`journal-daemon.c`, `pass_rename` and `pass_link`).
 */
function structuralOps(manifest: DeltaManifestV2): StructuralOp[] {
  const ops: StructuralOp[] = [];
  for (const op of manifest.metadataOps) {
    if (op.result < 0) continue;
    switch (op.op) {
      case 'create': case 'mkdir': case 'mknod': case 'symlink':
        ops.push({ op: 'create', path: op.path });
        break;
      case 'unlink': case 'rmdir':
        ops.push({ op: 'remove', path: op.path });
        break;
      case 'rename':
        ops.push({ op: 'rename', from: op.path, to: op.argument });
        break;
      case 'link':
        ops.push({ op: 'link', from: op.argument, to: op.path });
        break;
      default:
        break;
    }
  }
  return ops;
}

/**
 * One v2 delta manifest as the PARTIAL sealed capture both v1 codecs merge.
 *
 * The entries are the delta's own rows — every touched path plus its
 * ancestors, which is exactly the consistent partial tree the capture model's
 * partial rule demands — with file content read from the delta's stage, where
 * every read is held to the digest the fence recorded for exactly those bytes.
 * The structural ops are the WAL's own, in order, so the merge learns what
 * was removed and where a renamed or linked inode came from.
 *
 * A delta with no base is a FIRST fence (no published head to build against):
 * its rows are the whole tree as the daemon sees it, so it publishes as a
 * whole-tree capture — `partial: false`, which also carries no ops, because
 * there is no parent state to relate them to.
 */
export function captureFromJournalDelta(
  delta: JournalDelta,
  identity: { captureId: string; epoch: string; baseRevision: string; stableStageHandle: string },
): AuditedCapture {
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
    entries.push({
      path: row.path, kind: 'file', mode: row.mode, ino: Number(row.ino), metadata, content: sealedRowContent(row, partial),
    });
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
    structural: partial ? structuralOps(manifest) : [],
  });
}
