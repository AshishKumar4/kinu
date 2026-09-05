/**
 * Candidate storage codec: bounded-layer snapshots, on the shared
 * publication boundary.
 *
 * One immutable base plus newest-first DELTA layers, capped at eight total.
 * A generation's root IS its newest layer: one object carries the cut, the
 * entries this generation changed, its tombstones, and the refs of the older
 * layers, oldest last. A base carries the whole resolved tree and names no
 * older layer. Resolving a path merges the layers oldest to newest, so a
 * newer entry or tombstone wins. The FIRST checkpoint — and the ninth, which
 * would exceed the bound — streams the resolved entries into ONE base root.
 * Nothing tracks per-path retirement — the merged map IS the state, and
 * superseded objects simply stop being referenced (GC-only; published
 * objects are immutable and never rewritten or deleted here).
 *
 * Input is an AUDITED capture (`AuditedCapture`): the audit-proven cut and
 * its full CapturedCut identity ride along, so the codec never invents a cut
 * and never trusts an unaudited scan. Output is a
 * `CandidatePublicationPlan`: staged immutable objects, the identified
 * expected parent (the head envelope id this publication supersedes), and
 * the closure the plan verifies — ready for `publishCandidate`. A crash
 * anywhere before the head CAS leaves the old root fully serving.
 *
 * Content is content-addressed in chunks of at most `CHUNK_SIZE` (shared
 * with the CAS journal), cut on the CHUNK_SIZE grid so an unchanged aligned
 * block keeps its digest across generations. A file the fence staged as
 * WINDOWS around its writes is re-chunked only on the `DIRTY_CELL_BYTES`
 * cells the writes touched; every other byte keeps its parent's object,
 * addressed as a RANGE of it, so the bytes a generation puts scale with what
 * it wrote and not with the file. Every all-zero span is one hole extent,
 * exact to the byte: holes cost no stored bytes and a restore puts them back
 * where they were. Sparse runs retain their order, including
 * last-write-wins overlaps.
 *
 * Every byte this module reads crosses a validated, digest-bearing
 * `RangeReadIntent` through the shared `readCandidateRange` seam: a wrong
 * body never reaches a caller. Opened roots re-verify each layer document's
 * internal geometry — declared size equals the chunk span, no stored chunk
 * exceeds CHUNK_SIZE, a range lies inside its object — before any path
 * resolves.
 */

import * as v from 'valibot';

import { CHUNK_SIZE, sha256Hex } from '../cas/hash';
import { decodeJson, isCanonicalJournalPath } from '../cas/types';
import {
  readCaptureRange,
  removalsAgainstParent,
  requireAuditedCapture,
} from '../capture/model';
import type {
  AuditedCapture,
  DirtyRange,
  FileContent,
  NodeEntry,
  NodeKind,
  PosixMetadata,
  SealedContent,
  UpperPath,
} from '../capture/model';
import { ImmutableObjectRefSchema, RangeReadIntentSchema } from '../durability/contracts';
import type { HydrateWork, ImmutableObjectRef, RangeReadIntent, SealWork } from '../durability/contracts';
import type { FileExtent } from './lazy-restore';
import { paintedSegments } from './merkle-pack/chunk';
import type { LogicalLayout } from './merkle-pack/chunk';
import type { BoundaryHandback, BoundaryRow } from './merkle-pack/delta';
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

/** Maximum layers a root may name, itself included. The checkpoint that would
 *  exceed this compacts instead. Eight consulted layers bound one resolution. */
export const MAX_LAYER_DEPTH = 8;

/**
 * The grid a window-staged file is re-chunked on: one object per cell the
 * writes touched. A 4 KiB page write puts one 16 KiB object; the 512 KiB
 * cell around it keeps its parent's object by range. The daemon receives it
 * as `maxChunkBytes` with every boundary hand-back, so the window a fence
 * stages ends four cells past the last dirty byte.
 */
const DIRTY_CELL_BYTES = 16 * 1024;

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
const PositiveSizeSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(1));

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

/**
 * One stored content part: `size` logical bytes behind one object of at most
 * CHUNK_SIZE bytes. A WHOLE part is the object itself. A RANGE part carries
 * `offset` and the object's `length`: its bytes start `offset` into an object
 * an earlier generation wrote, which is how a dirty-cell re-chunk keeps the
 * untouched bytes of a cell without putting them again.
 */
const ChunkDocSchema = v.pipe(
  v.strictObject({
    hash: HashSchema,
    size: PositiveSizeSchema,
    offset: v.optional(SizeSchema),
    length: v.optional(PositiveSizeSchema),
  }),
  v.check(
    (part) => (part.offset === undefined) === (part.length === undefined),
    'A range part carries both its offset and its object length',
  ),
  v.check(
    (part) => part.offset === undefined || part.length === undefined || part.offset + part.size <= part.length,
    'A range part lies inside its object',
  ),
);
export type ChunkDoc = v.InferOutput<typeof ChunkDocSchema>;

/** One all-zero span, exact to the byte, with no object behind it. A huge
 * untouched file therefore stores one extent, whatever its size. */
const HoleExtentDocSchema = v.strictObject({
  hole: v.literal(true),
  size: PositiveSizeSchema,
});
export type HoleExtentDoc = v.InferOutput<typeof HoleExtentDocSchema>;
export type ChunkPartDoc = ChunkDoc | HoleExtentDoc;
const ChunkPartDocSchema = v.union([ChunkDocSchema, HoleExtentDocSchema]);

/**
 * One changed entry, mirroring `NodeEntry` with content replaced by chunk
 * refs. `ino` is the number the filesystem gave the inode when the capture at
 * `inoCut` observed it; the pair is the inode's identity here. Inode numbers
 * die with the filesystem and a wake gives every restored file a new one, so
 * a raw match across cuts means nothing, and a match inside one cut is a
 * hardlink. A rewrite through one name moves every name of the inode to the
 * rewriting cut, so the pair stays exact across generations.
 */
const EntryDocSchema = v.variant('kind', [
  v.strictObject({
    kind: v.literal('file'),
    path: PathSchema,
    mode: v.number(),
    ino: v.number(),
    inoCut: SizeSchema,
    metadata: v.optional(PosixMetadataDocSchema),
    size: SizeSchema,
    chunks: v.array(ChunkPartDocSchema),
  }),
  v.strictObject({
    kind: v.literal('dir'),
    path: PathSchema,
    mode: v.number(),
    ino: v.number(),
    inoCut: SizeSchema,
    metadata: v.optional(PosixMetadataDocSchema),
  }),
  v.strictObject({
    kind: v.literal('symlink'),
    path: PathSchema,
    mode: v.number(),
    ino: v.number(),
    inoCut: SizeSchema,
    metadata: v.optional(PosixMetadataDocSchema),
    target: v.string(),
  }),
]);
export type EntryDoc = v.InferOutput<typeof EntryDocSchema>;

/**
 * One layer, which is one generation's root: the exact audited cut it
 * captured (the publishing envelope carries the full CapturedCut; this pins
 * its number), what it changed, and the older layers beneath it, newest
 * first, the base last. A base holds the whole resolved tree and names no
 * older layer; a delta names at least its base.
 */
export const LayerDocSchema = v.pipe(
  v.strictObject({
    v: v.literal(1),
    fmt: v.literal(BOUNDED_LAYERS_FORMAT),
    cut: SizeSchema,
    t: v.picklist(['base', 'delta']),
    entries: v.array(EntryDocSchema),
    tombs: v.array(PathSchema),
    layers: v.array(ImmutableObjectRefSchema),
  }),
  v.check(
    (layer) => (layer.t === 'base') === (layer.layers.length === 0),
    'A base names no older layer; a delta names its base',
  ),
);
export type LayerDoc = v.InferOutput<typeof LayerDocSchema>;

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

/** A layer doc as the canonical encoder takes it: parsed by its own schema,
 *  so an optional member left `undefined` is absent rather than encoded. */
function layerCanon(doc: LayerDoc): Canon {
  return JSON.parse(JSON.stringify(v.parse(LayerDocSchema, doc)));
}

// ── chunking ─────────────────────────────────────────────────────────────────

interface Chunking {
  readonly chunks: readonly ChunkPartDoc[];
  readonly size: number;
}

/** What one build counted, in the contract's own row. */
interface BuildTally {
  bytesChunked: number;
  chunksHashed: number;
  wholeFiles: number;
}

interface ObjectStaging {
  readonly sink: CandidateObjectSink;
  readonly dependencies: StagedCandidateObject[];
  readonly known: Set<string>;
  readonly tally: BuildTally;
}

export function isHoleExtent(part: ChunkPartDoc): part is HoleExtentDoc {
  return 'hole' in part;
}

/** The immutable object one stored part reads from. */
function partObject(part: ChunkDoc): ImmutableObjectRef {
  return { key: objectKey(part.hash), byteLength: String(part.length ?? part.size), sha256: part.hash };
}

/** Append `size` zero bytes, merged into the hole before them if there is one. */
function appendHole(parts: ChunkPartDoc[], size: number): void {
  if (size === 0) return;
  const previous = parts.at(-1);
  if (previous !== undefined && isHoleExtent(previous)) previous.size += size;
  else parts.push({ hole: true, size });
}

/** Stage one nonzero chunk immediately. The builder retains only its metadata;
 * the sink owns the immutable object source after this await. */
async function appendChunk(
  parts: ChunkPartDoc[],
  bytes: Uint8Array,
  staging: ObjectStaging,
): Promise<void> {
  staging.tally.bytesChunked += bytes.byteLength;
  for (const byte of bytes) {
    if (byte !== 0) {
      const hash = sha256Hex(bytes);
      staging.tally.chunksHashed += 1;
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
  appendHole(parts, bytes.byteLength);
}

/** A sealed file's layout from the extents the daemon's SEEK_HOLE walk left:
 *  the gaps are its holes. Data segments carry no view; the capture reads them. */
function sealedLayout(content: SealedContent): LogicalLayout {
  const segments: LogicalLayout['segments'] = [];
  let at = 0;
  for (const extent of content.extents) {
    if (extent.offset > at) segments.push({ zeros: true, start: at, end: extent.offset });
    segments.push({ zeros: false, start: extent.offset, end: extent.offset + extent.length });
    at = extent.offset + extent.length;
  }
  if (at < content.size) segments.push({ zeros: true, start: at, end: content.size });
  return { segments, size: content.size };
}

/**
 * Split file content into chunks and stage each nonzero chunk immediately.
 * No generation-wide payload map exists: peak builder payload memory is one
 * CHUNK_SIZE buffer plus metadata. Data spans are cut on the CHUNK_SIZE grid;
 * every hole becomes one extent of its exact length, so the geometry a
 * restore reproduces is the geometry that was captured. Sealed content is
 * read through the capture; in-memory content through its painted layout,
 * which already resolved last-write-wins overlaps.
 */
async function chunkContent(
  capture: AuditedCapture,
  entry: NodeEntry,
  content: FileContent,
  staging: ObjectStaging,
): Promise<Chunking> {
  const chunks: ChunkPartDoc[] = [];
  const layout = content.kind === 'sealed' ? sealedLayout(content) : paintedSegments(content);
  const bytesAt = async (offset: number, length: number): Promise<Uint8Array> => {
    if (content.kind === 'sealed') return await readCaptureRange(capture, entry, offset, length);
    const out = new Uint8Array(length);
    for (const segment of layout.segments) {
      const start = Math.max(offset, segment.start);
      const end = Math.min(offset + length, segment.end);
      if (!segment.zeros && start < end) {
        out.set(segment.view!.subarray(start - segment.start, end - segment.start), start - offset);
      }
    }
    return out;
  };
  let at = 0;
  const chunkData = async (end: number): Promise<void> => {
    while (at < end) {
      const take = Math.min(end, (Math.floor(at / CHUNK_SIZE) + 1) * CHUNK_SIZE) - at;
      await appendChunk(chunks, await bytesAt(at, take), staging);
      at += take;
    }
  };
  for (const segment of layout.segments) {
    if (!segment.zeros) continue;
    await chunkData(segment.start);
    appendHole(chunks, segment.end - segment.start);
    at = segment.end;
  }
  await chunkData(layout.size);
  staging.tally.wholeFiles += 1;
  return { chunks, size: layout.size };
}

/** The logical bytes `[from, to)` of a parent's part list, each part cut to
 *  the span: a stored part becomes a range of its object, a hole a shorter
 *  hole. Bytes past the parent's end read as a hole, which is what a size
 *  grown by truncate holds. */
function cutParts(parent: readonly ChunkPartDoc[], from: number, to: number): ChunkPartDoc[] {
  const out: ChunkPartDoc[] = [];
  let at = 0;
  for (const part of parent) {
    const start = Math.max(from, at);
    const end = Math.min(to, at + part.size);
    if (start < end) {
      if (isHoleExtent(part)) {
        appendHole(out, end - start);
      } else {
        out.push({
          hash: part.hash,
          size: end - start,
          offset: (part.offset ?? 0) + (start - at),
          length: part.length ?? part.size,
        });
      }
    }
    at += part.size;
    if (at >= to) break;
  }
  if (at < to) appendHole(out, to - Math.max(at, from));
  return out;
}

/** Join what the overlay left in pieces: neighbouring holes into one, and
 *  neighbouring ranges of one object that meet end to start back into one
 *  range — or the whole object, when the range is all of it. */
function normalizeParts(parts: readonly ChunkPartDoc[]): ChunkPartDoc[] {
  const out: ChunkPartDoc[] = [];
  for (const part of parts) {
    const previous = out.at(-1);
    if (isHoleExtent(part)) {
      appendHole(out, part.size);
      continue;
    }
    const offset = part.offset ?? 0;
    const length = part.length ?? part.size;
    if (
      previous !== undefined && !isHoleExtent(previous) && previous.hash === part.hash
      && (previous.length ?? previous.size) === length
      && (previous.offset ?? 0) + previous.size === offset
    ) {
      previous.offset = previous.offset ?? 0;
      previous.length = length;
      previous.size += part.size;
    } else {
      out.push({ ...part });
    }
    const joined = out.at(-1)!;
    if (!isHoleExtent(joined) && joined.offset === 0 && joined.size === joined.length) {
      out[out.length - 1] = { hash: joined.hash, size: joined.size };
    }
  }
  return out;
}

/** The cells writes touched, as merged windows on the dirty grid, clamped to
 *  the file. */
function dirtyWindows(dirty: readonly DirtyRange[], size: number): { readonly from: number; readonly to: number }[] {
  const windows: { from: number; to: number }[] = [];
  for (const range of dirty) {
    if (range.length === 0 || range.offset >= size) continue;
    const from = Math.floor(range.offset / DIRTY_CELL_BYTES) * DIRTY_CELL_BYTES;
    const to = Math.min(size, Math.ceil(Math.min(size, range.offset + range.length) / DIRTY_CELL_BYTES) * DIRTY_CELL_BYTES);
    const last = windows.at(-1);
    if (last !== undefined && from <= last.to) last.to = Math.max(last.to, to);
    else windows.push({ from, to });
  }
  return windows;
}

/**
 * Re-chunk a window-staged file over its parent's parts: the cells the
 * writes touched are read from the stage and chunked on the CHUNK_SIZE grid
 * inside each window; every other byte keeps the parent's object as a range
 * of it. A size the writes did not reach is a hole, which is what a
 * truncate-extend holds; a shorter size cuts the parent's parts.
 */
async function overlayContent(
  capture: AuditedCapture,
  entry: NodeEntry,
  content: SealedContent,
  dirty: readonly DirtyRange[],
  parent: readonly ChunkPartDoc[],
  staging: ObjectStaging,
): Promise<Chunking> {
  const parts: ChunkPartDoc[] = [];
  let at = 0;
  for (const window of dirtyWindows(dirty, content.size)) {
    parts.push(...cutParts(parent, at, window.from));
    let cursor = window.from;
    while (cursor < window.to) {
      const take = Math.min(window.to, (Math.floor(cursor / CHUNK_SIZE) + 1) * CHUNK_SIZE) - cursor;
      await appendChunk(parts, await readCaptureRange(capture, entry, cursor, take), staging);
      cursor += take;
    }
    at = window.to;
  }
  parts.push(...cutParts(parent, at, content.size));
  return { chunks: normalizeParts(parts), size: content.size };
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

/** The doc one captured row becomes. The row's inode number is scoped to
 *  this capture's cut: it is the number the filesystem held at the cut. */
function entryFromNode(
  path: UpperPath,
  node: { kind: NodeKind; mode: number; ino: number; target?: string },
  inoCut: number,
  chunking: Chunking | undefined,
  metadata: PosixMetadataDoc | undefined,
): EntryDoc {
  const metadataField = metadata === undefined ? {} : { metadata };
  if (node.kind === 'file') {
    if (chunking === undefined) throw new Error(`file ${path} produced no chunks`);
    return {
      kind: 'file', path, mode: node.mode, ino: node.ino, inoCut, ...metadataField,
      size: chunking.size,
      chunks: [...chunking.chunks],
    };
  }
  if (node.kind === 'symlink') {
    if (node.target === undefined) throw new Error(`symlink ${path} carries no target`);
    return { kind: 'symlink', path, mode: node.mode, ino: node.ino, inoCut, ...metadataField, target: node.target };
  }
  return { kind: 'dir', path, mode: node.mode, ino: node.ino, inoCut, ...metadataField };
}

function sameChunks(a: readonly ChunkPartDoc[], b: readonly ChunkPartDoc[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((part, index) => {
    const other = b[index];
    if (other === undefined || part.size !== other.size) return false;
    if (isHoleExtent(part)) return isHoleExtent(other);
    return !isHoleExtent(other) && part.hash === other.hash
      && (part.offset ?? 0) === (other.offset ?? 0) && (part.length ?? part.size) === (other.length ?? other.size);
  });
}

/** Whether a captured doc restates the parent's entry: same name, same inode
 *  number, same stat, same bytes. The cut the number was observed at is not
 *  compared: a row that restates its parent keeps the parent's identity. */
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

/**
 * What a root hands the daemon about the files it serves, in the shape of
 * the post-CAS `boundaries` request minus the head identity the caller adds
 * once the CAS has named it: the cell grid as `maxChunkBytes`, one row per
 * file wider than a cell, and the paths that are gone.
 */
export type PublishedBoundaries = Pick<BoundaryHandback, 'maxChunkBytes' | 'files' | 'removed'>;

/** What one checkpoint contributes to the shared publication boundary. */
export interface BuiltLayers {
  /** The publication plan: staged objects, identified expected parent, the
   *  audited CapturedCut, and the closure the plan verifies. */
  readonly plan: CandidatePublicationPlan;
  /** The freshly built view, ready to pass back as `parent`. */
  readonly view: BoundedLayers;
  /** What the build counted: bytes and chunks the chunker consumed, entries
   *  this generation's layer serializes, files chunked whole. Staged bytes
   *  are the fence's, so the row leaves them at zero. */
  readonly stats: SealWork;
  /** The boundary rows a publish hands the daemon once its head has landed:
   *  every file this generation rewrote, and every path it removed, so the
   *  next fence stages windows instead of whole files. */
  readonly handback: PublishedBoundaries;
}

/**
 * The boundary rows for `docs`: one per file wider than a dirty cell, with
 * every cell start below its size. A file that fits in one cell is staged
 * whole by a fence with or without a row, and its row would cost the daemon
 * a merge per publish for nothing.
 */
function boundaryRowsOf(docs: Iterable<EntryDoc>): BoundaryRow[] {
  const files: BoundaryRow[] = [];
  for (const doc of docs) {
    if (doc.kind !== 'file' || doc.size <= DIRTY_CELL_BYTES) continue;
    const boundaries: number[] = [];
    for (let at = 0; at < doc.size; at += DIRTY_CELL_BYTES) boundaries.push(at);
    files.push({ ino: String(doc.ino), path: doc.path, size: doc.size, boundaries });
  }
  return files;
}

/** The inode identity of one doc: the number, scoped to the cut that saw it. */
function inodeKey(doc: EntryDoc): string {
  return `${doc.inoCut}:${doc.ino}`;
}

/**
 * Chunk one captured file: whole when the fence staged it whole, an overlay
 * on the parent's parts when the fence staged windows around its writes. A
 * window-staged row with no published bytes behind it is one this generation
 * created and never wrote (an empty create, a truncate, a fallocate), so the
 * bytes the fence did not stage are zeros; dirty cells with no parent to
 * overlay have no source for the rest of the file and refuse. A directory or
 * symlink chunks nothing and may carry no content.
 */
async function chunkEntry(
  audited: AuditedCapture,
  node: NodeEntry,
  parentDoc: EntryDoc | undefined,
  staging: ObjectStaging,
): Promise<Chunking | undefined> {
  if (node.kind !== 'file') {
    if (node.content !== undefined) throw new Error(`non-file ${node.path} carries file content`);
    return undefined;
  }
  const content = node.content;
  if (content === undefined) throw new Error(`file ${node.path} carries no content`);
  if (content.kind !== 'sealed' || content.dirty === undefined) {
    return await chunkContent(audited, node, content, staging);
  }
  if (parentDoc?.kind === 'file') {
    return await overlayContent(audited, node, content, content.dirty, parentDoc.chunks, staging);
  }
  if (content.dirty.length === 0) return await overlayContent(audited, node, content, [], [], staging);
  throw new Error(`file ${node.path} was staged as windows but no published parent entry holds its other bytes`);
}

/** What one build accumulates against the parent's resolved tree. */
interface Merge {
  /** The entries this generation's layer carries, by their path at the cut. */
  readonly changed: Map<UpperPath, EntryDoc>;
  /** The parent paths this generation's layer tombstones. */
  readonly tombstones: Set<UpperPath>;
  /** The doc a captured row replaced a parent entry with, by the inode
   *  identity the parent held: every other name of that inode takes it. */
  readonly groups: Map<string, EntryDoc>;
}

/**
 * Carry the parent's unnamed entries through this generation's renames: an
 * entry under a renamed directory moves with it, at its old identity, and its
 * old name is tombstoned. A row of the capture at the destination wins over
 * the carried entry, because the row is what the fence saw at the cut.
 */
function relocate(audited: AuditedCapture, parent: BoundedLayers, named: ReadonlySet<UpperPath>, merge: Merge): void {
  if (!audited.structural.some((op) => op.op === 'rename')) return;
  for (const path of parent.entryPaths()) {
    if (named.has(path)) continue;
    const destination = audited.destinationOf(path);
    if (destination === path) continue;
    merge.tombstones.add(path);
    if (destination === null || named.has(destination)) continue;
    const doc = parent.entryAt(path);
    if (doc !== undefined) merge.changed.set(destination, { ...doc, path: destination });
  }
}

/**
 * Every captured row's doc, into the merge. A row is chunked against the
 * parent entry its inode had when the parent was cut (the same name, or the
 * name a rename or link took it from); a row that restates that entry is not
 * a change. A file or symlink row that replaced a parent entry is remembered
 * by the inode identity the parent held, for the other names of that inode.
 */
async function mergeRows(
  audited: AuditedCapture,
  parent: BoundedLayers | undefined,
  staging: ObjectStaging,
  merge: Merge,
): Promise<void> {
  for (const node of audited.entries) {
    if (!isCanonicalJournalPath(node.path)) throw new Error(`refusing hostile path: ${JSON.stringify(node.path)}`);
    const origin = audited.originOf(node.path);
    const parentDoc = origin === null ? undefined : parent?.entryAt(origin);
    const chunking = await chunkEntry(audited, node, parentDoc, staging);
    const doc = entryFromNode(node.path, node, audited.cut, chunking, copyMetadata(node.metadata));
    if (sameEntry(parentDoc, doc)) continue;
    merge.changed.set(node.path, doc);
    if (parentDoc !== undefined && parentDoc.kind !== 'dir' && parentDoc.kind === doc.kind) {
      merge.groups.set(inodeKey(parentDoc), doc);
    }
  }
}

/**
 * Give every other name of a rewritten inode the doc its row produced. A
 * hardlink group is one inode: a write, a chmod or a rename through one name
 * changed them all, and the fence reports the names it touched, not the
 * group. The group is the parent's, by the identity the parent held; a name
 * the capture named for itself has its own row.
 */
function propagate(merge: Merge, resolved: Map<UpperPath, EntryDoc>, named: ReadonlySet<UpperPath>): void {
  if (merge.groups.size === 0) return;
  for (const [path, doc] of resolved) {
    if (named.has(path)) continue;
    const rewritten = merge.groups.get(inodeKey(doc));
    if (rewritten === undefined) continue;
    const sibling = copyEntry({ ...rewritten, path });
    resolved.set(path, sibling);
    merge.changed.set(path, sibling);
  }
}

const byPath = (a: EntryDoc, b: EntryDoc): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/**
 * This generation's own layer. The first root and the one that would exceed
 * the depth bound stream the resolved tree into a base; a generation that
 * changed or removed something is a delta over the parent's layers; one that
 * changed nothing restates the parent's own layer under the new cut, so the
 * chain does not grow for an empty generation. Above a base the restatement
 * is an empty delta naming it.
 */
function ownLayer(
  parent: BoundedLayers | undefined,
  cut: number,
  changed: ReadonlyMap<UpperPath, EntryDoc>,
  tombstones: ReadonlySet<UpperPath>,
  resolved: ReadonlyMap<UpperPath, EntryDoc>,
): LayerDoc {
  if (parent === undefined || parent.depth >= MAX_LAYER_DEPTH) {
    return {
      v: 1, fmt: BOUNDED_LAYERS_FORMAT, cut, t: 'base',
      entries: [...resolved.values()].sort(byPath), tombs: [], layers: [],
    };
  }
  if (changed.size > 0 || tombstones.size > 0) {
    return {
      v: 1, fmt: BOUNDED_LAYERS_FORMAT, cut, t: 'delta',
      entries: [...changed.values()].sort(byPath),
      tombs: [...tombstones].sort(),
      layers: [parent.rootRef, ...parent.layers],
    };
  }
  return parent.own.t === 'delta'
    ? { ...parent.own, cut, entries: parent.own.entries.map(copyEntry), tombs: [...parent.own.tombs], layers: [...parent.layers] }
    : { v: 1, fmt: BOUNDED_LAYERS_FORMAT, cut, t: 'delta', entries: [], tombs: [], layers: [parent.rootRef] };
}

/** Every stored (non-hole) chunk hash the resolved tree references. */
function chunkHashesOf(resolved: ReadonlyMap<UpperPath, EntryDoc>): Set<string> {
  const hashes = new Set<string>();
  for (const doc of resolved.values()) {
    if (doc.kind !== 'file') continue;
    for (const part of doc.chunks) {
      if (!isHoleExtent(part)) hashes.add(part.hash);
    }
  }
  return hashes;
}

/**
 * Commit an AUDITED capture as the child of `parent` (omit it for the first
 * checkpoint, which builds the base). The cut comes only from the audit —
 * there is no default and no override — and must strictly advance past the
 * parent's: the root commits the EXACT position the capture proved. The plan
 * (the opaque `PublishedParent` token); an unpublished or seed parent plans
 * a first root.
 *
 * A partial capture merges against the parent: a file the fence staged as
 * windows is overlaid on the entry its inode had when the parent was cut —
 * the same name, or the name a rename or link took it from — and only its
 * dirty cells are chunked; the parent's other entries follow this
 * generation's renames; every other name of a rewritten inode takes its
 * new doc.
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
    tally: { bytesChunked: 0, chunksHashed: 0, wholeFiles: 0 },
  };
  const named = new Set(audited.entries.map((entry) => entry.path));
  const merge: Merge = { changed: new Map(), tombstones: new Set(), groups: new Map() };
  if (parent !== undefined) relocate(audited, parent, named, merge);
  await mergeRows(audited, parent, staging, merge);
  // WHAT THIS GENERATION REMOVES is `removalsAgainstParent`'s question, not
  // this builder's: absence is removal for a whole-tree capture and NOT for a
  // partial one, and that rule now has one owner. Whatever it answers becomes
  // this generation's tombstones, so the delta layer carries them and every
  // reader's oldest-to-newest merge deletes exactly what was removed. A path
  // the capture names exists at the cut, so a removal that also names it (an
  // unlink and a create of one name in one generation) is not a tombstone,
  // and neither is a name a relocation lands on: a reader applies a layer's
  // tombstones after its entries, so one path may not be both.
  for (const path of removalsAgainstParent(audited, () => parent?.entryPaths() ?? [])) {
    if (!named.has(path)) merge.tombstones.add(path);
  }
  for (const path of merge.changed.keys()) merge.tombstones.delete(path);
  const { changed, tombstones } = merge;

  const resolved = parent === undefined ? new Map<UpperPath, EntryDoc>() : parent.merged();
  for (const path of tombstones) resolved.delete(path);
  for (const doc of changed.values()) resolved.set(doc.path, doc);
  propagate(merge, resolved, named);

  const own = ownLayer(parent, cut, changed, tombstones, resolved);
  const rootBytes = encodeCanonical(layerCanon(own));
  // Root is staged only after every dependency has sealed in the sink.
  const root = await sink.stage(objectKey(sha256Hex(rootBytes)), rootBytes);

  // THE CLOSURE THIS PUBLICATION PROVES: its root, every layer the root
  // names, and the chunks it wrote. A chunk an older generation wrote was
  // proved when that generation published, is named by a layer this root
  // still names, and nothing deletes it; listing it again per generation is
  // what made the closure O(tree).
  const plan = await planCandidatePublication({
    format: BOUNDED_LAYERS_FORMAT,
    expectedParentRootId: parent === undefined ? null : publishedParentInfo(parent.parentToken!).envelopeId,
    capture: audited,
    sink,
    dependencies,
    root,
    reused: own.layers,
  });
  const view = new BoundedLayers(
    root.ref.sha256,
    root.ref,
    cut,
    own,
    resolved,
    chunkHashesOf(resolved),
    undefined,
    undefined,
    null,
  );
  return {
    plan,
    view,
    stats: {
      bytesStaged: 0,
      bytesChunked: staging.tally.bytesChunked,
      chunksHashed: staging.tally.chunksHashed,
      nodesRewritten: own.entries.length,
      wholeFiles: staging.tally.wholeFiles,
    },
    handback: {
      maxChunkBytes: DIRTY_CELL_BYTES,
      files: boundaryRowsOf(changed.values()),
      removed: [...tombstones].sort(),
    },
  };
}

// ── the reader seam ──────────────────────────────────────────────────────────

/**
 * Realize one granted GET. Layers, roots and content chunks are all
 * immutable objects with declared byte lengths; fetch exactly what an
 * `ImmutableObjectRef` names. Callers construct fully-typed
 * `RangeReadIntent`s, and the shared `readCandidateRange` seam holds the
 * returned bytes to the intent's declared digest.
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

/**
 * One resolved entry as a restore reads it. `ino` is an id of this view:
 * equal for every name of one inode, distinct otherwise, unrelated to the
 * number a filesystem gave the file. A restore hardlinks the names that
 * share it and never reads a stored inode number.
 */
export interface StatView {
  readonly kind: NodeKind;
  readonly mode: number;
  readonly ino: number;
  readonly metadata?: PosixMetadata;
  readonly size?: number;
  readonly target?: string;
}
/** A stored object above CHUNK_SIZE would make one bounded range read fetch
 *  an object of any size the layer chose to declare; a span that disagrees
 *  with the declared size would read short or past the end; a range outside
 *  its object would read bytes that are not there. All three refuse here. */
function validateFileEntry(doc: Extract<EntryDoc, { kind: 'file' }>, where: string): void {
  let logicalBytes = 0;
  for (const part of doc.chunks) {
    if (!isHoleExtent(part)) {
      const length = part.length ?? part.size;
      if (length > CHUNK_SIZE) {
        throw new Error(`${where}: ${doc.path} chunk ${part.hash} is ${length} bytes, above the ${CHUNK_SIZE}-byte bound`);
      }
      if ((part.offset ?? 0) + part.size > length) {
        throw new Error(`${where}: ${doc.path} range of ${part.hash} reaches past its ${length}-byte object`);
      }
    }
    logicalBytes += part.size;
  }
  if (logicalBytes !== doc.size) {
    throw new Error(
      `${where}: ${doc.path} declares size ${doc.size} but its ${doc.chunks.length} chunk(s) hold ${logicalBytes}`,
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
    /** This generation's own layer: the root document as published. */
    readonly own: LayerDoc,
    private readonly resolved: ReadonlyMap<UpperPath, EntryDoc>,
    private readonly chunks: ReadonlySet<string>,
    private readonly reader: ObjectReader | undefined,
    private readonly identity: ReadIdentity | undefined,
    private readonly publishedParent: PublishedParent | null,
  ) {}

  /** The older layers this root names, newest first, the base last. */
  get layers(): readonly ImmutableObjectRef[] {
    return this.own.layers;
  }

  /** How many layers a resolution consults: this root plus the older ones. */
  get depth(): number {
    return 1 + this.own.layers.length;
  }

  /**
   * What page-in has cost this serving instance, in the contract's own row.
   *
   * Counted here rather than at the transport because only this class knows
   * which bytes the caller ASKED for: a 4 KiB read of a chunked file fetches
   * the chunk, and the difference between the two is the amplification a
   * hydrate bound is stated in. A view rebound to a published parent starts
   * at zero — it exists to build against, not to serve reads from.
   */
  #hydrate = { rangeGets: 0, bytesFetched: 0, bytesRequested: 0 };

  work(): HydrateWork {
    return { ...this.#hydrate };
  }

  /** The view-local inode ids, one per inode identity, in first-stat order. */
  readonly #inodeIds = new Map<string, number>();

  #inodeId(doc: EntryDoc): number {
    const key = inodeKey(doc);
    let id = this.#inodeIds.get(key);
    if (id === undefined) {
      id = this.#inodeIds.size + 1;
      this.#inodeIds.set(key, id);
    }
    return id;
  }

  /**
   * The data and hole geometry of one file, as its chunk list states it: what
   * a lazy restore registers a placeholder by, with no read of any chunk.
   */
  extents(path: UpperPath): readonly FileExtent[] {
    const doc = this.resolved.get(path);
    if (doc === undefined) throw new Error(`no such file: ${path}`);
    if (doc.kind !== 'file') throw new Error(`not a file: ${path} is a ${doc.kind}`);
    const extents: FileExtent[] = [];
    let offset = 0;
    for (const part of doc.chunks) {
      if (part.size > 0) {
        const kind = isHoleExtent(part) ? 'hole' as const : 'data' as const;
        const last = extents[extents.length - 1];
        if (last !== undefined && last.kind === kind) {
          extents[extents.length - 1] = { kind, offset: last.offset, length: last.length + part.size };
        } else {
          extents.push({ kind, offset, length: part.size });
        }
      }
      offset += part.size;
    }
    return extents;
  }

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
      this.rootId, this.rootRef, this.cut, this.own,
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
    for (const ref of this.own.layers) refs.set(ref.key, ref);
    for (const doc of this.resolved.values()) {
      if (doc.kind !== 'file') continue;
      for (const part of doc.chunks) {
        if (isHoleExtent(part) || refs.has(objectKey(part.hash))) continue;
        refs.set(objectKey(part.hash), partObject(part));
      }
    }
    return [...refs.values()];
  }

  /**
   * What a restored container's daemon is told about every file this root
   * serves, so the first fence after a wake stages windows rather than whole
   * files. Nothing is removed: a restore replaces the map, it does not
   * subtract from one.
   */
  boundaryRows(): PublishedBoundaries {
    return { maxChunkBytes: DIRTY_CELL_BYTES, files: boundaryRowsOf(this.resolved.values()), removed: [] };
  }
  /** The resolved entry, or null when absent or tombstoned. Hostile paths
   *  refuse rather than reading as a quiet miss. */
  stat(path: UpperPath): StatView | null {
    if (!isCanonicalJournalPath(path)) throw new Error(`refusing hostile path: ${JSON.stringify(path)}`);
    const doc = this.resolved.get(path);
    if (doc === undefined) return null;
    const metadata = copyMetadata(doc.metadata);
    const metadataField = metadata === undefined ? {} : { metadata };
    const ino = this.#inodeId(doc);
    return doc.kind === 'file'
      ? { kind: 'file', mode: doc.mode, ino, ...metadataField, size: doc.size }
      : doc.kind === 'symlink'
        ? { kind: 'symlink', mode: doc.mode, ino, ...metadataField, target: doc.target }
        : { kind: 'dir', mode: doc.mode, ino, ...metadataField };
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
   * part fetches its OWN object through a digest-bearing intent via the
   * shared `readCandidateRange` seam and takes its range of it; holes fill as
   * zeros without any fetch. The last two objects fetched are kept for the
   * parts that follow, because a dirty-cell overlay leaves the two remaining
   * ranges of one object around the cell it rewrote. Past-EOF spans truncate
   * like pread.
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
    this.#hydrate.bytesRequested += out.byteLength;

    const held: { readonly hash: string; readonly bytes: Uint8Array }[] = [];
    let partStart = 0;
    for (const part of doc.chunks) {
      const partEnd = partStart + part.size;
      const from = Math.max(start, partStart);
      const to = Math.min(end, partEnd);
      if (from < to && !isHoleExtent(part)) {
        let object = held.find((entry) => entry.hash === part.hash);
        if (object === undefined) {
          const ref = partObject(part);
          this.#hydrate.rangeGets += 1;
          this.#hydrate.bytesFetched += Number(ref.byteLength);
          object = { hash: part.hash, bytes: await fetchObject(this.reader, this.identity, ref, `content chunk of ${path}`) };
          if (held.length === 2) held.shift();
          held.push(object);
        }
        const within = (part.offset ?? 0) + (from - partStart);
        out.set(object.bytes.subarray(within, within + (to - from)), from - start);
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
  const rootDoc = decodeJson(LayerDocSchema, `root ${rootId}`, rootBytes);
  if (rootDoc.layers.length + 1 > MAX_LAYER_DEPTH) {
    throw new Error(`root ${rootId} names ${rootDoc.layers.length + 1} layers, above the bound of ${MAX_LAYER_DEPTH}`);
  }

  // Layers are ordered newest-first, so merge OLDEST to newest: a newer
  // entry — or tombstone — overwrites what an older layer resolved. The root
  // is the newest and merges last.
  const resolved = new Map<UpperPath, EntryDoc>();
  const chunks = new Set<string>();
  const merge = (layer: LayerDoc, what: string): void => {
    for (const doc of layer.entries) {
      if (doc.kind === 'file') validateFileEntry(doc, what);
      resolved.set(doc.path, doc);
    }
    for (const path of layer.tombs) resolved.delete(path);
  };
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
    merge(layer, what);
  }
  merge(rootDoc, `root ${rootId}`);
  for (const doc of resolved.values()) {
    if (doc.kind !== 'file') continue;
    for (const part of doc.chunks) {
      if (!isHoleExtent(part)) chunks.add(part.hash);
    }
  }

  return new BoundedLayers(
    rootId,
    { key: objectKey(rootId), byteLength: String(rootBytes.byteLength), sha256: rootId },
    rootDoc.cut, rootDoc, resolved, chunks, reader, identity, null,
  );
}
