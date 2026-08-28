/**
 * Candidate storage codec: bounded-layer snapshots, on the shared
 * publication boundary.
 *
 * One immutable base plus newest-first DELTA layers, capped at eight total.
 * A delta stores only what changed since the parent root: changed entries,
 * tombstones, and content-chunk refs — never inline bytes. Resolving a path
 * walks the layers once, newest first, and stops at the first hit; a
 * tombstone stops it too. The FIRST checkpoint — and the ninth, which would
 * exceed the bound — streams the resolved entries into ONE base object.
 * Nothing tracks per-path retirement — the merged map IS the state, and
 * superseded objects simply stop being referenced (GC-only; published
 * objects are immutable and never rewritten or deleted here).
 *
 * Input is an AUDITED capture (`AuditedCapture`): the audit-proven cut and
 * its full CapturedCut identity ride along, so the codec never invents a cut
 * and never trusts an unaudited scan. Output is a
 * `CandidatePublicationPlan`: staged immutable objects, the identified
 * expected parent (the head envelope id this publication supersedes), and
 * the derived GC closure — ready for `publishCandidate`. A crash anywhere
 * before the head CAS leaves the old root fully serving.
 *
 * Content is content-addressed in fixed-size chunks (`CHUNK_SIZE`, shared
 * with the CAS journal). An all-zero chunk has no object. Sparse runs retain
 * their order, including last-write-wins overlaps. Untouched spans compress
 * into arithmetic hole extents, so holes cost no stored bytes.
 *
 * Every byte this module reads crosses a validated, digest-bearing
 * `RangeReadIntent` through the shared `readCandidateRange` seam: a wrong
 * body never reaches a caller. Opened roots re-verify each layer document's
 * internal geometry — declared size equals the chunk span, chunk sizes fit
 * their offsets, hole digests equal the all-zero digest — before any path
 * resolves.
 */

import * as v from 'valibot';

import { CHUNK_SIZE, sha256Hex } from '../cas/hash';
import { decodeJson, isCanonicalJournalPath } from '../cas/types';
import {
  readCaptureRange,
  requireAuditedCapture,
} from '../capture/model';
import type {
  AuditedCapture,
  FileContent,
  NodeEntry,
  NodeKind,
  PosixMetadata,
  UpperPath,
} from '../capture/model';
import { ImmutableObjectRefSchema, RangeReadIntentSchema } from '../durability/contracts';
import type { ImmutableObjectRef, RangeReadIntent } from '../durability/contracts';
import {
  MemoryCandidateObjectSink,
  planCandidatePublication,
  publishedParentInfo,
  readCandidateRange,
} from './publication';
import type {
  CandidateObjectSink,
  CandidatePublicationPlan,
  PublishedParent,
  StagedCandidateObject,
} from './publication';
export const BOUNDED_LAYERS_FORMAT = 'bounded-layers/v1';

/** Maximum layers a root may name, base included. The checkpoint that would
 *  exceed this compacts instead. Eight consulted layers bound one resolution. */
export const MAX_LAYER_DEPTH = 8;

/** Every object lives under one content-addressed prefix: `obj/<sha256>`. */
export function objectKey(hash: string): string {
  return `obj/${hash}`;
}

// ── stored documents ─────────────────────────────────────────────────────────

const HashSchema = v.pipe(
  v.string(),
  v.regex(/^[0-9a-f]{64}$/, 'Expected a lowercase SHA-256 digest'),
);
const PathSchema = v.pipe(
  v.string(),
  v.check(isCanonicalJournalPath, 'Expected a canonical relative POSIX path'),
);
const SizeSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));

const NanosecondsSchema = v.pipe(v.string(), v.regex(/^(?:0|[1-9]\d*)$/));
const XattrValueSchema = v.pipe(
  v.string(),
  v.regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
);
const PosixMetadataDocSchema = v.strictObject({
  uid: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  gid: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  atimeNs: NanosecondsSchema,
  mtimeNs: NanosecondsSchema,
  ctimeNs: NanosecondsSchema,
  xattrs: v.record(v.string(), XattrValueSchema),
});
type PosixMetadataDoc = v.InferOutput<typeof PosixMetadataDocSchema>;

/** One stored content chunk. `hole: true` marks one all-zero chunk that has
 * no object; repeated holes use {@link HoleExtentDoc} instead. */
const ChunkDocSchema = v.strictObject({
  hash: HashSchema,
  size: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  hole: v.optional(v.literal(true)),
});
export type ChunkDoc = v.InferOutput<typeof ChunkDocSchema>;

/** An arithmetic run of equal-sized all-zero chunks. A huge untouched file
 * therefore stores one extent rather than one entry per apparent chunk. */
const HoleExtentDocSchema = v.strictObject({
  hole: v.literal(true),
  size: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  count: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
});
export type HoleExtentDoc = v.InferOutput<typeof HoleExtentDocSchema>;
export type ChunkPartDoc = ChunkDoc | HoleExtentDoc;
const ChunkPartDocSchema = v.union([ChunkDocSchema, HoleExtentDocSchema]);

/** One changed entry, mirroring `NodeEntry` with content replaced by chunk refs. */
const EntryDocSchema = v.variant('kind', [
  v.strictObject({
    kind: v.literal('file'),
    path: PathSchema,
    mode: v.number(),
    ino: v.number(),
    metadata: v.optional(PosixMetadataDocSchema),
    size: SizeSchema,
    chunks: v.array(ChunkPartDocSchema),
  }),
  v.strictObject({
    kind: v.literal('dir'),
    path: PathSchema,
    mode: v.number(),
    ino: v.number(),
    metadata: v.optional(PosixMetadataDocSchema),
  }),
  v.strictObject({
    kind: v.literal('symlink'),
    path: PathSchema,
    mode: v.number(),
    ino: v.number(),
    metadata: v.optional(PosixMetadataDocSchema),
    target: v.string(),
  }),
]);
export type EntryDoc = v.InferOutput<typeof EntryDocSchema>;

/** One layer: a base holds the whole resolved tree; a delta holds its change. */
export const LayerDocSchema = v.strictObject({
  v: v.literal(1),
  t: v.picklist(['base', 'delta']),
  entries: v.array(EntryDocSchema),
  tombs: v.array(PathSchema),
});

/** The root manifest: ordered layer refs, newest FIRST, last is the base, and
 *  the exact audited cut it captured. The publishing envelope carries the
 *  full CapturedCut; this manifest pins its number. */
const RootDocSchema = v.strictObject({
  v: v.literal(1),
  fmt: v.literal(BOUNDED_LAYERS_FORMAT),
  cut: SizeSchema,
  layers: v.array(ImmutableObjectRefSchema),
});

// ── canonical serialization ──────────────────────────────────────────────────

export type Canon = string | number | boolean | null | readonly Canon[] | CanonRecord;
type CanonRecord = { readonly [k: string]: Canon };

/** A canonical-JSON record: any Canon member the encoder renders as `{…}`.
 *  Primitives expose their boxed constructors; only plain records answer
 *  `Object`, and arrays were excluded above — so this is total over Canon. */
function isCanonRecord(value: Canon): value is CanonRecord {
  return value !== null && !Array.isArray(value) && value.constructor === Object;
}

function canonicalJson(value: Canon): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isCanonRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const utf8 = new TextEncoder();

/** Canonical bytes for any stored document: sorted keys, no whitespace.
 *  Exported because a corrupt-layer fixture must be WOUND the same way the
 *  codec winds real ones, and because the production adapter reuses it. */
export function encodeCanonical(value: Canon): Uint8Array {
  return utf8.encode(canonicalJson(value));
}

// ── chunking ─────────────────────────────────────────────────────────────────

const zeroHashMemo = new Map<number, string>();

/** The digest of `size` zero bytes, memoized: every all-hole chunk of a size
 *  shares it, and none of them stores anything. */
function zeroChunkHash(size: number): string {
  let hash = zeroHashMemo.get(size);
  if (hash === undefined) {
    hash = sha256Hex(new Uint8Array(size));
    zeroHashMemo.set(size, hash);
  }
  return hash;
}
interface Chunking {
  readonly chunks: readonly ChunkPartDoc[];
  readonly size: number;
}

interface ObjectStaging {
  readonly sink: CandidateObjectSink;
  readonly dependencies: StagedCandidateObject[];
  readonly known: Set<string>;
}

function isHoleExtent(part: ChunkPartDoc): part is HoleExtentDoc {
  return 'count' in part;
}

/** Append zero chunks compactly. The final short file chunk remains its own
 * extent because it has a different digest and geometry. */
function appendHoles(parts: ChunkPartDoc[], size: number, count: number): void {
  if (count === 0) return;
  const previous = parts.at(-1);
  if (previous !== undefined && isHoleExtent(previous) && previous.size === size) {
    previous.count += count;
    return;
  }
  parts.push({ hole: true, size, count });
}

/** Append the zero geometry for `[start, end)` chunk indexes without walking
 * each chunk. */
function appendHoleIndexes(parts: ChunkPartDoc[], start: number, end: number, fileSize: number): void {
  if (start >= end) return;
  const total = Math.ceil(fileSize / CHUNK_SIZE);
  const hasTail = fileSize % CHUNK_SIZE !== 0;
  const fullEnd = hasTail ? total - 1 : total;
  const fullCount = Math.max(0, Math.min(end, fullEnd) - start);
  appendHoles(parts, CHUNK_SIZE, fullCount);
  if (hasTail && start <= total - 1 && end > total - 1) {
    appendHoles(parts, fileSize % CHUNK_SIZE, 1);
  }
}

/** Stage one nonzero chunk immediately. The builder retains only its metadata;
 * the sink owns the immutable object source after this await. */
async function appendChunk(
  parts: ChunkPartDoc[],
  bytes: Uint8Array,
  staging: ObjectStaging,
): Promise<void> {
  for (const byte of bytes) {
    if (byte !== 0) {
      const hash = sha256Hex(bytes);
      if (!staging.known.has(hash)) {
        const staged = await staging.sink.stage(objectKey(hash), bytes);
        if (
          staged.ref.key !== objectKey(hash)
          || staged.ref.sha256 !== hash
          || staged.ref.byteLength !== String(bytes.byteLength)
        ) {
          throw new Error(`sink staged ${objectKey(hash)} with a mismatched immutable ref`);
        }
        staging.known.add(hash);
        staging.dependencies.push(staged);
      }
      parts.push({ hash, size: bytes.byteLength });
      return;
    }
  }
  appendHoles(parts, bytes.byteLength, 1);
}

/**
 * Split file content into fixed-size chunks and stage each nonzero chunk
 * immediately. No generation-wide payload map exists: peak builder payload
 * memory is one CHUNK_SIZE buffer plus metadata. Sparse runs paint each
 * touched chunk in original order, preserving last-write-wins overlaps;
 * untouched spans become arithmetic hole extents.
 */
async function chunkContent(
  capture: AuditedCapture,
  entry: NodeEntry,
  content: FileContent,
  staging: ObjectStaging,
): Promise<Chunking> {
  const chunks: ChunkPartDoc[] = [];

  if (content.kind === 'dense') {
    const bytes = content.bytes;
    for (let off = 0; off < bytes.byteLength; off += CHUNK_SIZE) {
      await appendChunk(chunks, bytes.subarray(off, Math.min(off + CHUNK_SIZE, bytes.byteLength)), staging);
    }
    return { chunks, size: bytes.byteLength };
  }

  if (content.kind === 'sealed') {
    let nextIndex = 0;
    let currentIndex = -1;
    let current: Uint8Array | undefined;
    const flush = async (): Promise<void> => {
      if (current === undefined) return;
      await appendChunk(chunks, current, staging);
      nextIndex = currentIndex + 1;
      current = undefined;
    };
    for (const extent of content.extents) {
      let pos = extent.offset;
      const end = extent.offset + extent.length;
      while (pos < end) {
        const index = Math.floor(pos / CHUNK_SIZE);
        const chunkStart = index * CHUNK_SIZE;
        if (index !== currentIndex) {
          await flush();
          appendHoleIndexes(chunks, nextIndex, index, content.size);
          currentIndex = index;
          current = new Uint8Array(Math.min(CHUNK_SIZE, content.size - chunkStart));
        }
        const take = Math.min(chunkStart + CHUNK_SIZE, end) - pos;
        current!.set(await readCaptureRange(capture, entry, pos, take), pos - chunkStart);
        pos += take;
      }
    }
    await flush();
    appendHoleIndexes(chunks, nextIndex, Math.ceil(content.size / CHUNK_SIZE), content.size);
    return { chunks, size: content.size };
  }

  const { size } = content;
  const touched = new Set<number>();
  for (const run of content.runs) {
    const end = run.offset + run.bytes.byteLength;
    if (!Number.isSafeInteger(run.offset) || run.offset < 0 || !Number.isSafeInteger(end) || end > size) {
      throw new Error(`sparse run ${run.offset}..${end} exceeds the file's declared size ${size}`);
    }
    for (let pos = run.offset; pos < end; pos = (Math.floor(pos / CHUNK_SIZE) + 1) * CHUNK_SIZE) {
      touched.add(Math.floor(pos / CHUNK_SIZE));
    }
  }

  let nextIndex = 0;
  for (const index of [...touched].sort((a, b) => a - b)) {
    appendHoleIndexes(chunks, nextIndex, index, size);
    const chunkStart = index * CHUNK_SIZE;
    const buffer = new Uint8Array(Math.min(CHUNK_SIZE, size - chunkStart));
    for (const run of content.runs) {
      const start = Math.max(chunkStart, run.offset);
      const end = Math.min(chunkStart + buffer.byteLength, run.offset + run.bytes.byteLength);
      if (start < end) buffer.set(run.bytes.subarray(start - run.offset, end - run.offset), start - chunkStart);
    }
    await appendChunk(chunks, buffer, staging);
    nextIndex = index + 1;
  }
  appendHoleIndexes(chunks, nextIndex, Math.ceil(size / CHUNK_SIZE), size);
  return { chunks, size };
}

function copyMetadata(metadata: PosixMetadata | undefined): PosixMetadataDoc | undefined {
  if (metadata === undefined) return undefined;
  return v.parse(PosixMetadataDocSchema, { ...metadata, xattrs: { ...metadata.xattrs } });
}

function sameMetadata(a: PosixMetadataDoc | undefined, b: PosixMetadataDoc | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (
    a.uid !== b.uid || a.gid !== b.gid || a.atimeNs !== b.atimeNs
    || a.mtimeNs !== b.mtimeNs || a.ctimeNs !== b.ctimeNs
  ) return false;
  const aNames = Object.keys(a.xattrs);
  const bNames = Object.keys(b.xattrs);
  return aNames.length === bNames.length && aNames.every((name) => a.xattrs[name] === b.xattrs[name]);
}

function entryFromNode(
  path: UpperPath,
  node: { kind: NodeKind; mode: number; ino: number; target?: string },
  chunking: Chunking | undefined,
  metadata: PosixMetadataDoc | undefined,
): EntryDoc {
  const metadataField = metadata === undefined ? {} : { metadata };
  if (node.kind === 'file') {
    if (chunking === undefined) throw new Error(`file ${path} produced no chunks`);
    return {
      kind: 'file', path, mode: node.mode, ino: node.ino, ...metadataField,
      size: chunking.size,
      chunks: [...chunking.chunks],
    };
  }
  if (node.kind === 'symlink') {
    if (node.target === undefined) throw new Error(`symlink ${path} carries no target`);
    return { kind: 'symlink', path, mode: node.mode, ino: node.ino, ...metadataField, target: node.target };
  }
  return { kind: 'dir', path, mode: node.mode, ino: node.ino, ...metadataField };
}

function sameChunks(a: readonly ChunkPartDoc[], b: readonly ChunkPartDoc[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((part, index) => {
    const other = b[index];
    if (other === undefined || isHoleExtent(part) !== isHoleExtent(other)) return false;
    if (isHoleExtent(part) && isHoleExtent(other)) {
      return part.size === other.size && part.count === other.count;
    }
    return !isHoleExtent(part) && !isHoleExtent(other)
      && part.hash === other.hash && part.size === other.size && part.hole === other.hole;
  });
}

function sameEntry(a: EntryDoc | undefined, b: EntryDoc): boolean {
  if (a === undefined) return false;
  if (
    a.kind !== b.kind || a.path !== b.path || a.mode !== b.mode || a.ino !== b.ino
    || !sameMetadata(a.metadata, b.metadata)
  ) return false;
  if (a.kind === 'symlink' && b.kind === 'symlink') return a.target === b.target;
  if (a.kind === 'file' && b.kind === 'file') return a.size === b.size && sameChunks(a.chunks, b.chunks);
  return a.kind === b.kind;
}

function copyEntry(doc: EntryDoc): EntryDoc {
  const metadata = copyMetadata(doc.metadata);
  const metadataField = metadata === undefined ? {} : { metadata };
  if (doc.kind !== 'file') return { ...doc, ...metadataField };
  return { ...doc, ...metadataField, chunks: doc.chunks.map((chunk) => ({ ...chunk })) };
}

// ── build ────────────────────────────────────────────────────────────────────

/** What one checkpoint contributes to the shared publication boundary. */
export interface BuiltLayers {
  /** The publication plan: staged objects, identified expected parent, the
   *  audited CapturedCut, and the derived GC closure. */
  readonly plan: CandidatePublicationPlan;
  /** The freshly built view, ready to pass back as `parent`. */
  readonly view: BoundedLayers;
}

/**
 * Commit an AUDITED capture as the child of `parent` (omit it for the first
 * checkpoint, which builds the base). The cut comes only from the audit —
 * there is no default and no override — and must strictly advance past the
 * parent's: the root commits the EXACT position the capture proved. The plan
 * (the opaque `PublishedParent` token); an unpublished or seed parent plans
 * a first root.
 *
 * Pure: nothing is uploaded. The caller hands `plan` to `publishCandidate`,
 * which is why a crash-before-publish is expressible as "stopped looping".
 */
export async function build(
  capture: AuditedCapture,
  parent?: BoundedLayers,
  sink: CandidateObjectSink = new MemoryCandidateObjectSink(),
): Promise<BuiltLayers> {
  const audited = requireAuditedCapture(capture);
  const cut = audited.cut;
  if (!Number.isSafeInteger(cut) || cut < 0) {
    throw new Error(`an audited capture names a safe non-negative cut, got ${cut}`);
  }
  if (parent !== undefined && parent.parentToken === null) {
    throw new Error('unpublished parent cannot supply reusable bounded-layer objects');
  }
  if (parent !== undefined && cut <= parent.cut) {
    throw new Error(`cut ${cut} does not advance past the parent root's cut ${parent.cut}`);
  }

  const dependencies: StagedCandidateObject[] = [];
  const staging: ObjectStaging = {
    sink,
    dependencies,
    known: new Set(parent?.chunkHashes ?? []),
  };
  const changed = new Map<UpperPath, EntryDoc>();
  const tombstones = new Set<UpperPath>();
  const snapshot = new Map(audited.entries.map((entry) => [entry.path, entry]));

  for (const [path, node] of snapshot) {
    if (!isCanonicalJournalPath(path)) throw new Error(`refusing hostile path: ${JSON.stringify(path)}`);
    const metadata = copyMetadata(node.metadata);
    let chunking: Chunking | undefined;
    if (node.kind === 'file') {
      if (node.content === undefined) throw new Error(`file ${path} carries no content`);
      chunking = await chunkContent(audited, node, node.content, staging);
    } else if (node.content !== undefined) {
      throw new Error(`non-file ${path} carries file content`);
    }
    const doc = entryFromNode(path, node, chunking, metadata);
    if (!sameEntry(parent?.entryAt(path), doc)) changed.set(path, doc);
  }
  if (parent !== undefined) {
    for (const path of parent.entryPaths()) {
      if (!snapshot.has(path)) tombstones.add(path);
    }
  }

  const resolved = parent === undefined ? new Map<UpperPath, EntryDoc>() : parent.merged();
  for (const doc of changed.values()) resolved.set(doc.path, doc);
  for (const path of tombstones) resolved.delete(path);

  const byPath = (a: EntryDoc, b: EntryDoc) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  let layers: readonly ImmutableObjectRef[];
  if (parent === undefined || parent.layers.length >= MAX_LAYER_DEPTH) {
    const bytes = encodeCanonical({ v: 1, t: 'base', entries: [...resolved.values()].sort(byPath), tombs: [] });
    const staged = await sink.stage(objectKey(sha256Hex(bytes)), bytes);
    dependencies.push(staged);
    layers = [staged.ref];
  } else if (changed.size > 0 || tombstones.size > 0) {
    const bytes = encodeCanonical({
      v: 1,
      t: 'delta',
      entries: [...changed.values()].sort(byPath),
      tombs: [...tombstones].sort(),
    });
    const staged = await sink.stage(objectKey(sha256Hex(bytes)), bytes);
    dependencies.push(staged);
    layers = [staged.ref, ...parent.layers];
  } else {
    layers = parent.layers;
  }

  const rootBytes = encodeCanonical({ v: 1, fmt: BOUNDED_LAYERS_FORMAT, cut, layers: [...layers] });
  // Root is staged only after every dependency has sealed in the sink.
  const root = await sink.stage(objectKey(sha256Hex(rootBytes)), rootBytes);

  // Derive the exact closure this child root reaches. Fresh refs are already
  // staged; authenticated parent refs are passed as `reused` so the shared
  // plan stages its closure object without receiving any caller closure.
  const reachableByKey = new Map<string, ImmutableObjectRef>();
  reachableByKey.set(root.ref.key, root.ref);
  for (const ref of layers) reachableByKey.set(ref.key, ref);
  for (const doc of resolved.values()) {
    if (doc.kind !== 'file') continue;
    for (const part of doc.chunks) {
      if (isHoleExtent(part) || part.hole === true) continue;
      reachableByKey.set(objectKey(part.hash), {
        key: objectKey(part.hash), byteLength: String(part.size), sha256: part.hash,
      });
    }
  }
  const freshKeys = new Set([...dependencies.map((object) => object.ref.key), root.ref.key]);
  const reused = [...reachableByKey.values()].filter((ref) => !freshKeys.has(ref.key));
  const plan = await planCandidatePublication({
    format: BOUNDED_LAYERS_FORMAT,
    expectedParentRootId: parent === undefined ? null : publishedParentInfo(parent.parentToken!).envelopeId,
    capture: audited,
    sink,
    dependencies,
    root,
    reused,
  });

  const chunkHashes = new Set<string>();
  for (const doc of resolved.values()) {
    if (doc.kind !== 'file') continue;
    for (const part of doc.chunks) {
      if (!isHoleExtent(part) && part.hole !== true) chunkHashes.add(part.hash);
    }
  }
  const view = new BoundedLayers(
    root.ref.sha256,
    root.ref,
    cut,
    layers,
    resolved,
    chunkHashes,
    undefined,
    undefined,
    null,
  );
  return { plan, view };
}

// ── the reader seam ──────────────────────────────────────────────────────────

/**
 * Realize one granted GET. Layers, roots and content chunks are all
 * addressed objects, so a range read needs no byte-offset arithmetic HERE:
 * it issues exactly one whole-object intent per intersecting chunk. The
 * production adapter validates the intent, fills its own grant identity, and
 * answers with bytes the shared seam then holds to the intent's digest.
 */
export interface ObjectReader {
  readRange(intent: RangeReadIntent): Promise<Uint8Array>;
}

/** The durability operation a read belongs to. Every intent this module
 *  issues carries it; the publisher's ledger correlates the spend. */
export interface ReadIdentity {
  readonly operationId: string;
  readonly attemptId: string;
  readonly boxId: string;
  readonly epoch: string;
  readonly expiresAt: string;
}

function rangeIntent(identity: ReadIdentity, ref: ImmutableObjectRef): RangeReadIntent {
  return v.parse(RangeReadIntentSchema, {
    operationId: identity.operationId,
    attemptId: identity.attemptId,
    boxId: identity.boxId,
    epoch: identity.epoch,
    exactKey: ref.key,
    method: 'GET',
    byteOffset: '0',
    byteLength: ref.byteLength,
    sha256: ref.sha256,
    expiresAt: identity.expiresAt,
  });
}

async function fetchObject(
  reader: ObjectReader,
  identity: ReadIdentity,
  ref: ImmutableObjectRef,
  what: string,
): Promise<Uint8Array> {
  try {
    // The shared seam validates the request shape AND holds the body to the
    // intent's exact digest and length before anything comes back.
    return await readCandidateRange({ intent: rangeIntent(identity, ref) }, reader);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`${what} (${ref.key}) could not be read: ${message}`, { cause });
  }
}

export interface StatView {
  readonly kind: NodeKind;
  readonly mode: number;
  readonly ino: number;
  readonly metadata?: PosixMetadata;
  readonly size?: number;
  readonly target?: string;
}
function validateFileEntry(doc: Extract<EntryDoc, { kind: 'file' }>, where: string): void {
  let logicalBytes = 0;
  let chunkCount = 0;
  for (const part of doc.chunks) {
    const count = isHoleExtent(part) ? part.count : 1;
    const remainingChunks = Math.ceil(doc.size / CHUNK_SIZE) - chunkCount;
    if (count > remainingChunks) {
      throw new Error(`${where}: ${doc.path} extent exceeds the file's declared chunk geometry`);
    }
    const spanStart = chunkCount * CHUNK_SIZE;
    const expectedSize = Math.max(Math.min(CHUNK_SIZE, doc.size - spanStart), 0);
    if (part.size !== expectedSize || (count > 1 && part.size !== CHUNK_SIZE)) {
      throw new Error(`${where}: ${doc.path} chunk ${chunkCount} has invalid ${count}-chunk geometry`);
    }
    if (part.hole === true && !isHoleExtent(part) && part.hash !== zeroChunkHash(part.size)) {
      throw new Error(`${where}: ${doc.path} chunk ${chunkCount} claims all-zero but carries another digest`);
    }
    logicalBytes += part.size * count;
    chunkCount += count;
  }
  const expectedCount = Math.ceil(doc.size / CHUNK_SIZE);
  if (chunkCount !== expectedCount || logicalBytes !== doc.size) {
    throw new Error(
      `${where}: ${doc.path} declares size ${doc.size} but its ${chunkCount} chunk(s) hold ${logicalBytes}`,
    );
  }
}

/**
 * An opened root: resolution, listing and bounded range reads over one base
 * and at most `MAX_LAYER_DEPTH - 1` deltas. Also the `parent` handle `build`
 * chains from. A built-but-unpublished view carries a null head id and no
 * reader; only `open()` produces a serving instance. A `PublishedParent`
 * binds that instance to the committed envelope before reuse.
 */
export class BoundedLayers {
  constructor(
    readonly rootId: string,
    readonly rootRef: ImmutableObjectRef,
    readonly cut: number,
    readonly layers: readonly ImmutableObjectRef[],
    private readonly resolved: ReadonlyMap<UpperPath, EntryDoc>,
    private readonly chunks: ReadonlySet<string>,
    private readonly reader: ObjectReader | undefined,
    private readonly identity: ReadIdentity | undefined,
    private readonly publishedParent: PublishedParent | null,
  ) {}

  /** Stored content hashes only. Hole extents have no object to reuse. */
  get chunkHashes(): ReadonlySet<string> {
    return this.chunks;
  }

  /** The opaque evidence token that authenticated this root as a published
   *  parent. Callers may pass it only through the publication API; it carries
   *  no caller-declared closure. */
  get parentToken(): PublishedParent | null {
    return this.publishedParent;
  }
  /**
   * Bind this opened root to evidence recovered from the actual published
   * envelope. The opaque parent token proves its head, format, root and
   * captured cut; this opened view supplies the format-specific closure.
   */
  withPublishedParent(parent: PublishedParent): BoundedLayers {
    const published = publishedParentInfo(parent);
    const root = published.rootObject;
    if (published.format !== BOUNDED_LAYERS_FORMAT) {
      throw new Error(`published parent format ${published.format} is not bounded layers`);
    }
    if (
      root.key !== this.rootRef.key
      || root.byteLength !== this.rootRef.byteLength
      || root.sha256 !== this.rootRef.sha256
    ) {
      throw new Error('published parent does not authenticate this bounded-layer root');
    }
    if (published.capturedCut.cut !== String(this.cut)) {
      throw new Error('published parent cut does not match this bounded-layer view');
    }
    if (published.head.rootEnvelopeId !== published.envelopeId) {
      throw new Error('published parent head does not select its envelope');
    }
    return new BoundedLayers(
      this.rootId, this.rootRef, this.cut, this.layers,
      this.resolved, this.chunks, this.reader, this.identity, parent,
    );
  }

  /** The resolved entry as a DEFENSIVE COPY: mutating it cannot affect the
   *  resolved metadata, chunk references, or payload. */
  entryAt(path: UpperPath): EntryDoc | undefined {
    const doc = this.resolved.get(path);
    return doc === undefined ? undefined : copyEntry(doc);
  }

  entryPaths(): IterableIterator<UpperPath> {
    return this.resolved.keys();
  }

  /** The whole resolved state as DEFENSIVE COPIES. */
  merged(): Map<UpperPath, EntryDoc> {
    const copy = new Map<UpperPath, EntryDoc>();
    for (const [path, doc] of this.resolved) copy.set(path, copyEntry(doc));
    return copy;
  }

  /**
   * Every object GC must retain for this root to keep serving: the root
   * object, its layers, and each distinct stored (non-hole) chunk. Holes
   * reference nothing; retired generations stay live only through other
   * roots still pinned elsewhere.
   */
  gcClosure(): readonly ImmutableObjectRef[] {
    const refs = new Map<string, ImmutableObjectRef>();
    refs.set(this.rootRef.key, this.rootRef);
    for (const ref of this.layers) refs.set(ref.key, ref);
    for (const doc of this.resolved.values()) {
      if (doc.kind !== 'file') continue;
      for (const part of doc.chunks) {
        if (isHoleExtent(part) || part.hole === true || refs.has(objectKey(part.hash))) continue;
        refs.set(objectKey(part.hash), {
          key: objectKey(part.hash), byteLength: String(part.size), sha256: part.hash,
        });
      }
    }
    return [...refs.values()];
  }
  /** The resolved entry, or null when absent or tombstoned. Hostile paths
   *  refuse rather than reading as a quiet miss. */
  stat(path: UpperPath): StatView | null {
    if (!isCanonicalJournalPath(path)) throw new Error(`refusing hostile path: ${JSON.stringify(path)}`);
    const doc = this.resolved.get(path);
    if (doc === undefined) return null;
    const metadata = copyMetadata(doc.metadata);
    const metadataField = metadata === undefined ? {} : { metadata };
    return doc.kind === 'file'
      ? { kind: 'file', mode: doc.mode, ino: doc.ino, ...metadataField, size: doc.size }
      : doc.kind === 'symlink'
        ? { kind: 'symlink', mode: doc.mode, ino: doc.ino, ...metadataField, target: doc.target }
        : { kind: 'dir', mode: doc.mode, ino: doc.ino, ...metadataField };
  }

  /** Immediate children of a directory, sorted. Refuses a missing or non-dir
   *  path by name rather than answering with a plausible empty list. */
  readdir(dir: UpperPath): readonly string[] {
    if (dir !== '') {
      if (!isCanonicalJournalPath(dir)) throw new Error(`refusing hostile path: ${JSON.stringify(dir)}`);
      const doc = this.resolved.get(dir);
      if (doc === undefined) throw new Error(`no such directory: ${dir}`);
      if (doc.kind !== 'dir') throw new Error(`not a directory: ${dir}`);
    }
    const prefix = dir === '' ? '' : `${dir}/`;
    const names = new Set<string>();
    for (const path of this.resolved.keys()) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      names.add(slash === -1 ? rest : rest.slice(0, slash));
    }
    return [...names].sort();
  }

  /**
   * Logical bytes `[offset, offset + length)` of one file. Each intersecting
   * chunk is fetched through its OWN digest-bearing intent via the shared
   * `readCandidateRange` seam; holes fill as zeros without any fetch.
   * Past-EOF spans truncate like pread.
   */
  async readRange(path: UpperPath, offset: number, length: number): Promise<Uint8Array> {
    if (this.reader === undefined || this.identity === undefined) {
      throw new Error('this view was built, not opened; open() produces a serving instance');
    }
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error(`offset must be a safe non-negative integer, got ${offset}`);
    if (!Number.isSafeInteger(length) || length < 0) throw new Error(`length must be a safe non-negative integer, got ${length}`);
    if (!isCanonicalJournalPath(path)) throw new Error(`refusing hostile path: ${JSON.stringify(path)}`);

    const doc = this.resolved.get(path);
    if (doc === undefined) throw new Error(`no such file: ${path}`);
    if (doc.kind !== 'file') throw new Error(`not a file: ${path} is a ${doc.kind}`);

    const start = Math.min(offset, doc.size);
    const end = start + Math.min(length, doc.size - start);
    const out = new Uint8Array(end - start);
    if (out.byteLength === 0) return out;

    let partStart = 0;
    for (const part of doc.chunks) {
      const count = isHoleExtent(part) ? part.count : 1;
      const partEnd = partStart + part.size * count;
      const from = Math.max(start, partStart);
      const to = Math.min(end, partEnd);
      if (from < to && !isHoleExtent(part) && part.hole !== true) {
        const ref: ImmutableObjectRef = {
          key: objectKey(part.hash), byteLength: String(part.size), sha256: part.hash,
        };
        const bytes = await fetchObject(this.reader, this.identity, ref, `content chunk of ${path}`);
        out.set(bytes.subarray(from - partStart, to - partStart), from - start);
      }
      if (partEnd >= end) break;
      partStart = partEnd;
    }
    return out;
  }
}

// ── open ─────────────────────────────────────────────────────────────────────

/**
 * Open a published root under a read identity. Pass the root BYTES already
 * in hand, or its IDENTIFIED ref — exactly what the publishing envelope's
 * `rootObject` carries, so a ref-opened root is authenticated twice: through
 * its granted intent's declared digest and length, and because content
 * addressing pins the key to the digest. Every layer is verified and
 * geometry-checked before any path resolves.
 */
export async function open(
  root: Uint8Array | ImmutableObjectRef,
  reader: ObjectReader,
  identity: ReadIdentity,
): Promise<BoundedLayers> {
  let rootId: string;
  let rootBytes: Uint8Array;
  if (root instanceof Uint8Array) {
    rootBytes = root;
    rootId = sha256Hex(rootBytes);
  } else {
    const parsed = v.parse(ImmutableObjectRefSchema, root);
    if (parsed.key !== objectKey(parsed.sha256)) {
      throw new Error(`root ref ${parsed.key} is not content-addressed (${objectKey(parsed.sha256)} expected)`);
    }
    rootId = parsed.sha256;
    try {
      rootBytes = await readCandidateRange({ intent: rangeIntent(identity, parsed) }, reader);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`root ${rootId} could not be read: ${message}`, { cause });
    }
  }
  const rootDoc = decodeJson(RootDocSchema, `root ${rootId}`, rootBytes);
  if (rootDoc.layers.length < 1) throw new Error(`root ${rootId} names no layers`);
  if (rootDoc.layers.length > MAX_LAYER_DEPTH) {
    throw new Error(`root ${rootId} names ${rootDoc.layers.length} layers, above the bound of ${MAX_LAYER_DEPTH}`);
  }

  // Layers are ordered newest-first, so merge OLDEST to newest: a newer
  // entry — or tombstone — overwrites what an older layer resolved.
  const resolved = new Map<UpperPath, EntryDoc>();
  const chunks = new Set<string>();
  for (const [index, ref] of [...rootDoc.layers].reverse().entries()) {
    const what = `layer ${rootDoc.layers.length - 1 - index}`;
    let bytes: Uint8Array;
    try {
      bytes = await readCandidateRange({ intent: rangeIntent(identity, ref) }, reader);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`${what} (${ref.key}) could not be read: ${message}`, { cause });
    }
    const layer = decodeJson(LayerDocSchema, ref.key, bytes);
    const expectedTag = index === 0 ? 'base' : 'delta';
    if (layer.t !== expectedTag) {
      throw new Error(`${what} must be the ${expectedTag}; root layer ordering is forged`);
    }
    for (const doc of layer.entries) {
      if (doc.kind === 'file') validateFileEntry(doc, what);
      resolved.set(doc.path, doc);
    }
    for (const path of layer.tombs) resolved.delete(path);
  }
  for (const doc of resolved.values()) {
    if (doc.kind !== 'file') continue;
    for (const part of doc.chunks) {
      if (!isHoleExtent(part) && part.hole !== true) chunks.add(part.hash);
    }
  }

  return new BoundedLayers(
    rootId,
    { key: objectKey(rootId), byteLength: String(rootBytes.byteLength), sha256: rootId },
    rootDoc.cut, rootDoc.layers, resolved, chunks, reader, identity, null,
  );
}
