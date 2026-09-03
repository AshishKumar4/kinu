/**
 * The daemon's delta manifest, and the window policy that makes a seal O(k).
 *
 * WHAT A FENCE HANDS OVER. The v1 fence copied the whole tree into a stage and
 * handed the builder a complete capture, so every seal cost O(n) whatever
 * changed. The v2 fence copies only the bytes around each dirty cluster and
 * describes them here: the dirty files with their staged ranges and stat, the
 * ordered non-write mutations, and the two counters the daemon owns.
 *
 * WHY WINDOWS AND NOT RANGES. A dirty range cannot be chunked on its own: a
 * content-defined boundary depends on the bytes before it, so a pass that
 * started mid-chunk would produce cuts the parent generation never made and
 * every extent after the write would look fresh. The window therefore begins
 * at the parent's chunk boundary BEFORE the first dirty byte, where the
 * rolling hash legitimately restarts, and runs past the boundary AFTER the
 * last dirty byte by four maximum chunks — the slack a re-chunked region needs
 * to fall back into step with the parent's cuts. Once it does, everything
 * beyond that cut is already an extent of the parent: not re-hashed, not
 * re-uploaded, not rewritten.
 *
 * THE BOUNDARIES ARE THE SIDECAR'S, and the daemon holds a copy only so it can
 * stage those windows. They are derived from the parent's own extent list
 * (`fileBoundaries`), handed back after a successful head CAS, and merged by
 * the daemon per file — never re-sent whole, because one 64 MiB file is 16,000
 * boundaries and re-sending every file's list per publish would put an O(n)
 * term back into a path this design just made O(k).
 */

import * as v from 'valibot';

import { SealWorkSchema } from '../../durability/contracts';
import type { SealWork } from '../../durability/contracts';

import type { ChunkParams, StagedRange } from './chunk';
import { MerklePackError } from './errors';

const NonEmptyString = v.pipe(v.string(), v.minLength(1), v.maxLength(4096));
const Count = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const PositiveCount = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const DecimalString = v.pipe(
  v.string(),
  v.regex(/^(?:0|[1-9]\d*)$/, 'Expected a canonical non-negative decimal string'),
);
const Hex64 = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/, 'Expected a lowercase SHA-256 digest'));
const Base64Value = v.pipe(
  v.string(),
  v.regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, 'Expected a base64 xattr value'),
);

/**
 * Every mutation the WAL records other than a write, in the daemon's own
 * spelling. A write is a `W` record and arrives as a dirty range, so it is not
 * in this list; `argument` carries the op-specific auxiliary the WAL holds
 * (the rename destination, the hardlink source, the symlink target, the xattr
 * name) and is empty for the ops that have none.
 */
export const DELTA_METADATA_OPS = [
  'create',
  'mknod',
  'mkdir',
  'symlink',
  'link',
  'rename',
  'unlink',
  'rmdir',
  'truncate',
  'fallocate',
  'chmod',
  'chown',
  'utimens',
  'setxattr',
  'removexattr',
] as const;
export type DeltaMetadataOpName = (typeof DELTA_METADATA_OPS)[number];

export const DeltaRangeSchema = v.strictObject({ offset: Count, length: PositiveCount });

/** Ranges in ascending, non-overlapping file order, inside the file. */
function ascendingDisjoint(
  ranges: readonly { readonly offset: number; readonly length: number }[],
  size: number,
): boolean {
  let cursor = 0;
  for (const range of ranges) {
    if (range.offset < cursor) return false;
    cursor = range.offset + range.length;
  }
  return cursor <= size;
}

/**
 * One node the fence found dirty: what it is, its stat at the cut, the byte
 * ranges writes touched, and the ranges the STAGE holds.
 *
 * The two range lists answer different questions and neither can carry the
 * other's answer. `dirty` is where the writes landed, which is what decides
 * how far a re-chunk must run before it may resync; `ranges` is what the fence
 * copied — each dirty cluster grown to its boundary window, split at holes and
 * at 512 KiB, every piece carrying the digest of exactly those staged bytes,
 * so a read is verified rather than trusted. `whole` marks the O(file) case:
 * no boundary map for this file yet, so the window is the file and `ranges`
 * enumerates every data run it has.
 *
 * A directory or symlink row carries no bytes: `dirty` and `ranges` are empty
 * and the row exists so the tree can be rewritten around it. The delta carries
 * every touched path PLUS its ancestors, which is what makes it a consistent
 * partial tree rather than a list of files.
 */
export const DeltaStagedRangeSchema = v.strictObject({
  offset: Count,
  length: PositiveCount,
  sha256: Hex64,
});
export type DeltaStagedRange = v.InferOutput<typeof DeltaStagedRangeSchema>;

export const DeltaDirtyFileSchema = v.pipe(
  v.strictObject({
    ino: DecimalString,
    path: NonEmptyString,
    kind: v.picklist(['file', 'dir', 'symlink']),
    size: Count,
    mode: Count,
    uid: Count,
    gid: Count,
    atimeNs: DecimalString,
    mtimeNs: DecimalString,
    ctimeNs: DecimalString,
    xattrs: v.record(v.string(), Base64Value),
    target: v.optional(v.string()),
    whole: v.boolean(),
    dirty: v.array(DeltaRangeSchema),
    ranges: v.array(DeltaStagedRangeSchema),
  }),
  v.check((file) => ascendingDisjoint(file.dirty, file.size), 'Expected dirty ranges ascending and inside the file'),
  v.check((file) => ascendingDisjoint(file.ranges, file.size), 'Expected staged ranges ascending and inside the file'),
  v.check(
    (file) => file.kind === 'symlink' ? file.target !== undefined : file.target === undefined,
    'A symlink row carries its target and nothing else does',
  ),
  v.check(
    (file) => file.kind === 'file' || (file.dirty.length === 0 && file.ranges.length === 0),
    'A directory or symlink row carries no bytes',
  ),
);
export type DeltaDirtyFile = v.InferOutput<typeof DeltaDirtyFileSchema>;

export const DeltaMetadataOpSchema = v.strictObject({
  sequence: Count,
  op: v.picklist(DELTA_METADATA_OPS),
  path: NonEmptyString,
  argument: v.string(),
  result: v.pipe(v.number(), v.safeInteger()),
});
export type DeltaMetadataOp = v.InferOutput<typeof DeltaMetadataOpSchema>;

/** The published head a WAL started from: the base a fence authenticates. */
export const DeltaBaseSchema = v.strictObject({
  cut: DecimalString,
  generation: DecimalString,
  root: Hex64,
});
export type DeltaBase = v.InferOutput<typeof DeltaBaseSchema>;

export const DeltaManifestV2Schema = v.pipe(
  v.strictObject({
    version: v.literal(2),
    cut: Count,
    generation: Count,
    stageRoot: NonEmptyString,
    base: v.nullable(DeltaBaseSchema),
    dirtyFiles: v.array(DeltaDirtyFileSchema),
    metadataOps: v.array(DeltaMetadataOpSchema),
    sealWork: SealWorkSchema,
  }),
  v.check(
    (manifest) => new Set(manifest.dirtyFiles.map((file) => file.path)).size === manifest.dirtyFiles.length,
    'A delta manifest cannot name one path twice',
  ),
  v.check(
    (manifest) => manifest.metadataOps.every((op, index) =>
      index === 0 || manifest.metadataOps[index - 1].sequence < op.sequence),
    'Expected metadata ops in strictly ascending WAL sequence',
  ),
);
export type DeltaManifestV2 = v.InferOutput<typeof DeltaManifestV2Schema>;

/** Decode one manifest file. Non-UTF-8 and non-canonical bodies are refused. */
export function parseDeltaManifest(bytes: Uint8Array): DeltaManifestV2 {
  try {
    return v.parse(DeltaManifestV2Schema, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new MerklePackError('invalid-parameter', `delta manifest did not decode: ${detail}`, { cause: error });
  }
}

/**
 * How far past the boundary after a dirty cluster a window reaches, in maximum
 * chunks. A re-chunked region falls back into step with the parent's cuts
 * within one forced maximum chunk plus the rolling window, so four is slack
 * with room to spare; a cluster that still has not resynced by then is the
 * `wholeFiles` case the counters name rather than hide.
 */
export const RESYNC_SLACK_CHUNKS = 4;

/** One extent run as the boundary derivation reads it: `count` chunks of
 *  `length` bytes each, in file order. */
export interface ExtentSpan {
  readonly length: number;
  readonly count: number;
}

/**
 * The chunk boundaries of one file, derived from its extent list: 0, the end
 * of every chunk, and therefore the size last. This is the list the next
 * incremental seal resumes from and the list the daemon needs to stage a
 * window, so it has exactly one derivation.
 */
export function fileBoundaries(extents: readonly ExtentSpan[]): number[] {
  const cuts = [0];
  let offset = 0;
  for (const extent of extents) {
    for (let repeat = 0; repeat < extent.count; repeat += 1) {
      offset += extent.length;
      if (!Number.isSafeInteger(offset)) {
        throw new MerklePackError('malformed-node', 'file extent geometry exceeds the safe integer range');
      }
      cuts.push(offset);
    }
  }
  return cuts;
}

/** The greatest boundary at or below `offset`. */
function boundaryAtOrBefore(cuts: readonly number[], offset: number): number {
  let low = 0;
  let high = cuts.length - 1;
  let found = cuts[0] ?? 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const value = cuts[middle]!;
    if (value <= offset) {
      found = value;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

/** The least boundary at or above `offset`, or the file size past the last. */
function boundaryAtOrAfter(cuts: readonly number[], offset: number, size: number): number {
  let low = 0;
  let high = cuts.length - 1;
  let found = size;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const value = cuts[middle]!;
    if (value >= offset) {
      found = value;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }
  return found;
}

export interface WindowInput {
  readonly size: number;
  /** The dirty ranges the fence recorded, ascending and non-overlapping. */
  readonly ranges: readonly StagedRange[];
  /** The parent's boundaries, or null for a file the parent does not hold. */
  readonly boundaries: readonly number[] | null;
  readonly params: ChunkParams;
  /** The daemon already decided this file is staged and chunked in full. */
  readonly whole: boolean;
}

/**
 * The windows a seal chunks for one file: the whole logical span when the
 * parent does not hold it (or the daemon marked it whole), otherwise one
 * boundary-aligned window per dirty cluster, with overlapping windows merged
 * so no byte is chunked twice.
 */
export function chunkWindows(input: WindowInput): readonly StagedRange[] {
  if (input.size === 0) return [];
  if (input.whole || input.boundaries === null || input.boundaries.length === 0) {
    return [{ offset: 0, length: input.size }];
  }
  const slack = RESYNC_SLACK_CHUNKS * input.params.maxBytes;
  const merged: { offset: number; length: number }[] = [];
  for (const range of input.ranges) {
    if (range.length === 0) continue;
    const from = boundaryAtOrBefore(input.boundaries, Math.min(range.offset, input.size));
    const after = boundaryAtOrAfter(input.boundaries, Math.min(range.offset + range.length, input.size), input.size);
    const to = Math.min(input.size, after + slack);
    if (to <= from) continue;
    const last = merged[merged.length - 1];
    if (last !== undefined && from <= last.offset + last.length) {
      last.length = Math.max(last.offset + last.length, to) - last.offset;
      continue;
    }
    merged.push({ offset: from, length: to - from });
  }
  return merged;
}

/** The bytes the fence copied for one file: what a `bytesStaged` bound is
 *  stated over, and what the sidecar may read without asking for more. */
export function stagedBytes(windows: readonly StagedRange[], ranges: readonly StagedRange[]): number {
  let total = 0;
  for (const window of windows) {
    const end = window.offset + window.length;
    for (const range of ranges) {
      const from = Math.max(window.offset, range.offset);
      const to = Math.min(end, range.offset + range.length);
      if (to > from) total += to - from;
    }
  }
  return total;
}

/**
 * One file's boundaries as the post-CAS hand-back carries them. `size` and
 * `boundaries` fully replace that file's row in the daemon's map.
 */
export interface BoundaryRow {
  readonly ino: string;
  readonly path: string;
  readonly size: number;
  readonly boundaries: readonly number[];
}

/**
 * What a publish hands back to the daemon once — and only once — its head CAS
 * has landed: the boundaries of the files this generation rewrote, and the
 * paths it no longer has. Merge semantics, so the cost is O(k) per publish.
 */
export interface BoundaryHandback {
  readonly cut: string;
  readonly generation: string;
  /** The root ENVELOPE id the CAS just published, never a tree node id. */
  readonly root: string;
  readonly maxChunkBytes: number;
  readonly files: readonly BoundaryRow[];
  readonly removed: readonly string[];
}

/**
 * The seal row a caller reports, from the two halves that measure it: the
 * daemon counts what its fence copied and how many files it staged whole, the
 * build counts what it hashed and rewrote. `wholeFiles` takes the larger of
 * the two, because the sidecar also falls back to a whole-file pass when a
 * window it was given does not resync, and that file is whole in exactly one
 * of the two counts.
 */
export function mergeSealWork(fenced: SealWork, built: Omit<SealWork, 'bytesStaged'>): SealWork {
  return {
    bytesStaged: fenced.bytesStaged,
    bytesChunked: built.bytesChunked,
    chunksHashed: built.chunksHashed,
    nodesRewritten: built.nodesRewritten,
    wholeFiles: Math.max(fenced.wholeFiles, built.wholeFiles),
  };
}
