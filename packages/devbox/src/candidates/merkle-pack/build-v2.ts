/**
 * The incremental builder: a delta manifest plus an authenticated parent
 * become one generation of packs, in O(k + p·d).
 *
 * WHAT THE v1 BUILDER DID PER COMMIT, and none of it is here: it re-chunked
 * every inode, re-serialized every node, wrote one global index listing every
 * reachable chunk (O(n) bytes, capped at 4 MiB, so the index capped the tree),
 * and declared a closure the publisher then verified object by object. The
 * cost of a commit was the size of the tree.
 *
 * WHAT THIS DOES INSTEAD. For each dirty file it re-chunks only the windows
 * around its dirty clusters, stops the moment a cut lands on a boundary of the
 * parent generation, and keeps the parent's extents on both sides. It rewrites
 * that file's node, the extent pages the splice actually touched, and the
 * ancestors of the paths that changed. Everything else stays where it already
 * is and is named by (pack, offset, length) from the records that were
 * rewritten, so no index is needed and none is written.
 *
 * THE PACK LAYOUT IS THE READ PATTERN. Records are laid out fresh chunks in
 * file order, then extent pages, then file nodes, then symlinks, then
 * directories postorder with the root LAST. Every reference therefore points
 * at a record that is already placed, which is what lets `SELF_PACK` name the
 * pack a record is being written into before that pack has a key — and it
 * leaves file-adjacent chunks offset-contiguous, so one page-in can fetch a
 * run of them in a single range read.
 */

import { sha256Hex } from '../../cas/hash';
import { isCanonicalJournalPath } from '../../cas/types';
import type { ObjectRangeRef, SealWork } from '../../durability/contracts';
import { publishedParentV2Info } from '../publication';
import type { PublishedParent } from '../publication';

import { DEFAULT_CHUNK_PARAMS, chunkStagedRegion, validateChunkParams } from './chunk';
import type { ChunkParams, EmittedChunk, StagedRange } from './chunk';
import { chunkWindows, fileBoundaries } from './delta';
import type { BoundaryRow, DeltaDirtyFile, DeltaManifestV2, DeltaStagedRange } from './delta';
import { MerklePackError } from './errors';
import { PackWriter } from './pack-layout';
import type { BuiltPack, ResolvePack, Slot } from './pack-layout';
import type { FileNodeV2, MerkleV2View } from './view-v2';
import { MERKLE_PACK_V2_FORMAT, encodeNodeV2, extentPagesV2, hashNodeV2Bytes } from './wire';
import type {
  DirEntryV2,
  ExtentPageRefV2,
  ExtentV2,
  HoleExtentJson,
  NodeV2,
  PosixMetadataJson,
  RecordRefV2,
} from './wire';

/**
 * One pack is one PUT, and the cap is what keeps it that way. R2 accepts a
 * single PUT far above this; 32 MiB is the locality and retry choice the
 * deployed measurement selected (1.2–1.4 s per 32 MiB PUT, 2026-09-02,
 * `bench/measure-first/MEASUREMENTS.md` § (d)).
 */
export const DEFAULT_MAX_PACK_BYTES_V2 = 32 * 1024 * 1024;

/** The fence's copy of the dirty windows, read by path. */
export interface DeltaStage {
  read(path: string, offset: number, length: number): Promise<Uint8Array>;
}

/** The previous generation, authenticated against the published head. */
export interface PublishedMerkleParentV2 {
  readonly view: MerkleV2View;
  readonly headRootId: string;
  readonly generation: string;
}

const publishedParents = new WeakSet<PublishedMerkleParentV2>();

/**
 * Admit reuse only from the envelope that names this opened root, exactly as
 * v1 does: a relabeled view cannot carry a current parent forward.
 */
export function parentFromPublishedV2(view: MerkleV2View, published: PublishedParent): PublishedMerkleParentV2 {
  const info = publishedParentV2Info(published);
  if (info.format !== MERKLE_PACK_V2_FORMAT) {
    throw new MerklePackError('invalid-parameter', `published parent is ${info.format}, not ${MERKLE_PACK_V2_FORMAT}`);
  }
  if (info.head.rootEnvelopeId !== info.envelopeId) {
    throw new MerklePackError('invalid-parameter', 'published parent head does not bind its envelope');
  }
  if (
    info.rootObject.key !== view.rootRef.pack
    || Number(info.rootObject.byteOffset) !== view.rootRef.offset
    || Number(info.rootObject.byteLength) !== view.rootRef.length
    || info.rootObject.sha256 !== view.rootRef.sha256
  ) {
    throw new MerklePackError('invalid-parameter', 'published parent does not authenticate this opened v2 root');
  }
  const parent: PublishedMerkleParentV2 = { view, headRootId: info.envelopeId, generation: info.generation };
  publishedParents.add(parent);
  return Object.freeze(parent);
}

export interface DeltaBuildOptions {
  readonly stage: DeltaStage;
  readonly parent?: PublishedMerkleParentV2 | null;
  readonly chunkParams?: ChunkParams;
  readonly maxPackBytes?: number;
}
export interface MerkleDeltaBuild {
  readonly packs: readonly BuiltPack[];
  /** The root record, as a range inside one of the packs above. */
  readonly rootObject: ObjectRangeRef;
  /** What the build measured. The fence owns `bytesStaged`. */
  readonly seal: Omit<SealWork, 'bytesStaged'>;
  /** The boundaries of the files this generation rewrote, for the daemon. */
  readonly boundaries: readonly BoundaryRow[];
  /** Paths this generation no longer holds, for the daemon's map. */
  readonly removed: readonly string[];
  /**
   * Bytes this generation stopped reaching, by the pack that holds them.
   *
   * Incremental and therefore pessimistic: a chunk that died here but is still
   * reached through another file counts as dead until the audit mark re-derives
   * the ledger's live counts. That is the direction that only ever DELAYS a
   * compaction, never one that deletes something a head still reaches.
   */
  readonly deadBytes: ReadonlyMap<string, number>;
}

// ── the planned tree ─────────────────────────────────────────────────────────

type NodeKindV2 = 'file' | 'dir' | 'symlink';

type PlannedChild =
  | { readonly kind: 'reuse'; readonly nodeKind: NodeKindV2; readonly ref: RecordRefV2 }
  | { readonly kind: 'fresh'; readonly node: PlannedNode };

interface PlannedStat {
  readonly mode: number;
  readonly ino: number;
  readonly metadata: PosixMetadataJson;
}

type PlannedPage =
  | { readonly kind: 'reuse'; readonly ref: ExtentPageRefV2 }
  | {
      readonly kind: 'fresh';
      readonly extents: readonly ExtentV2[];
      readonly fileOffset: number;
      readonly bytes: number;
    };

interface PlannedFile {
  readonly kind: 'file';
  readonly stat: PlannedStat;
  readonly size: number;
  readonly holes: readonly HoleExtentJson[];
  readonly inline: readonly ExtentV2[] | null;
  readonly pages: readonly PlannedPage[] | null;
}

interface PlannedDir {
  readonly kind: 'dir';
  stat: PlannedStat;
  readonly children: Map<string, PlannedChild>;
}

interface PlannedSymlink {
  readonly kind: 'symlink';
  readonly stat: PlannedStat;
  readonly target: string;
}

type PlannedNode = PlannedFile | PlannedDir | PlannedSymlink;

const DEFAULT_DIR_MODE = 0o755;
const EMPTY_METADATA: PosixMetadataJson = {
  uid: 0,
  gid: 0,
  atimeNs: '0',
  mtimeNs: '0',
  ctimeNs: '0',
  xattrs: {},
};

/** A fresh chunk's extent carries this pack until placement resolves it. */
const UNPLACED_PACK = '\u0000fresh';

function statOf(file: DeltaDirtyFile): PlannedStat {
  const ino = Number(file.ino);
  if (!Number.isSafeInteger(ino) || ino <= 0) {
    throw new MerklePackError('invalid-parameter', `dirty file ${file.path} carries no real inode identity`);
  }
  const xattrs: Record<string, string> = {};
  for (const name of Object.keys(file.xattrs).sort()) xattrs[name] = file.xattrs[name]!;
  return {
    mode: file.mode,
    ino,
    metadata: {
      uid: file.uid,
      gid: file.gid,
      atimeNs: file.atimeNs,
      mtimeNs: file.mtimeNs,
      ctimeNs: file.ctimeNs,
      xattrs,
    },
  };
}

function statsAgree(a: PlannedStat, b: PlannedStat): boolean {
  const left = a.metadata;
  const right = b.metadata;
  const names = Object.keys(left.xattrs);
  return (
    a.mode === b.mode
    && a.ino === b.ino
    && left.uid === right.uid
    && left.gid === right.gid
    && left.atimeNs === right.atimeNs
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && names.length === Object.keys(right.xattrs).length
    && names.every((name) => left.xattrs[name] === right.xattrs[name])
  );
}

function parentPathOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
}

function nameOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? path : path.slice(cut + 1);
}

/** Adjacent runs of one chunk collapse, so an extent list has one spelling. */
function normalizeExtents(extents: readonly ExtentV2[]): ExtentV2[] {
  const out: ExtentV2[] = [];
  for (const extent of extents) {
    const last = out[out.length - 1];
    if (
      last !== undefined
      && last.digest === extent.digest
      && last.length === extent.length
      && last.pack === extent.pack
      && last.offset === extent.offset
    ) {
      out[out.length - 1] = { ...last, count: last.count + extent.count };
      continue;
    }
    out.push(extent);
  }
  return out;
}

function extentsSpan(extents: readonly ExtentV2[]): number {
  let total = 0;
  for (const extent of extents) total += extent.length * extent.count;
  return total;
}

function extentsCount(extents: readonly ExtentV2[]): number {
  let total = 0;
  for (const extent of extents) total += extent.count;
  return total;
}

/**
 * The runs covering `[from, to)` of an extent list. Both endpoints must fall
 * on a chunk boundary — every caller derives them from the parent's own
 * boundary list, so an off-boundary slice is a defect, not an input.
 */
function sliceExtents(extents: readonly ExtentV2[], from: number, to: number): ExtentV2[] {
  const out: ExtentV2[] = [];
  let offset = 0;
  for (const extent of extents) {
    const span = extent.length * extent.count;
    const start = offset;
    const end = offset + span;
    offset = end;
    if (end <= from || start >= to) continue;
    const front = Math.max(0, from - start);
    const back = Math.max(0, end - to);
    if (front % extent.length !== 0 || back % extent.length !== 0) {
      throw new MerklePackError(
        'invalid-parameter',
        `extent slice [${from}, ${to}) does not fall on a chunk boundary of ${extent.digest}`,
      );
    }
    const count = extent.count - front / extent.length - back / extent.length;
    if (count > 0) out.push({ ...extent, count });
  }
  return out;
}

/** The holes of a file after one window was rewritten: the parent's holes
 *  outside the window, plus the zero runs the fresh pass found inside it. */
function spliceHoles(
  holes: readonly HoleExtentJson[],
  window: StagedRange,
  fresh: readonly HoleExtentJson[],
  size: number,
): HoleExtentJson[] {
  const end = window.offset + window.length;
  const out: HoleExtentJson[] = [];
  for (const hole of holes) {
    const holeEnd = hole.o + hole.l;
    if (holeEnd <= window.offset || hole.o >= end) {
      out.push(hole);
      continue;
    }
    if (hole.o < window.offset) out.push({ o: hole.o, l: window.offset - hole.o });
    if (holeEnd > end) out.push({ o: end, l: holeEnd - end });
  }
  out.push(...fresh);
  const clamped = out
    .filter((hole) => hole.l > 0 && hole.o < size)
    .map((hole) => ({ o: hole.o, l: Math.min(hole.l, size - hole.o) }))
    .sort((a, b) => a.o - b.o);
  // Adjacent runs join, so one hole geometry has one spelling.
  const merged: HoleExtentJson[] = [];
  for (const hole of clamped) {
    const last = merged[merged.length - 1];
    if (last !== undefined && last.o + last.l === hole.o) {
      merged[merged.length - 1] = { o: last.o, l: last.l + hole.l };
      continue;
    }
    merged.push(hole);
  }
  return merged;
}

// ── chunking one dirty file ──────────────────────────────────────────────────

interface FreshChunk {
  readonly digest: string;
  readonly bytes: Uint8Array;
}

interface ChunkedFile {
  readonly path: string;
  readonly node: PlannedFile;
  readonly extents: readonly ExtentV2[];
  readonly boundaries: readonly number[];
}

interface ChunkFileInput {
  readonly file: DeltaDirtyFile;
  readonly stat: PlannedStat;
  readonly parentNode: FileNodeV2 | null;
  readonly parentExtents: readonly ExtentV2[] | null;
  readonly params: ChunkParams;
  readonly stage: DeltaStage;
  readonly zeroCache: Map<number, EmittedChunk>;
  readonly freshChunks: Map<string, FreshChunk>;
  readonly countDead: (extents: readonly ExtentV2[]) => void;
  readonly onRead: (bytes: number) => void;
  readonly onHash: () => void;
  readonly onWhole: () => void;
}

/**
 * Reads the stage, and never a byte it cannot verify.
 *
 * The fence splits each staged window at holes and at 512 KiB and carries the
 * digest of every piece, so a piece is read whole, held to that digest, and
 * then served in chunker-sized slices. One piece is resident at a time, which
 * is what keeps a whole-file pass over a 64 MiB file bounded by the split
 * rather than by the file.
 */
class StagedReader {
  #held: { readonly range: DeltaStagedRange; readonly bytes: Uint8Array } | null = null;

  constructor(
    private readonly file: DeltaDirtyFile,
    private readonly stage: DeltaStage,
    private readonly onRead: (bytes: number) => void,
  ) {}

  async read(offset: number, length: number): Promise<Uint8Array> {
    const range = this.file.ranges.find(
      (candidate) => candidate.offset <= offset && offset + length <= candidate.offset + candidate.length,
    );
    if (range === undefined) {
      throw new MerklePackError(
        'invalid-range',
        `${this.file.path} has no staged range covering ${offset}+${length}`,
      );
    }
    if (this.#held?.range !== range) {
      const bytes = await this.stage.read(this.file.path, range.offset, range.length);
      if (bytes.byteLength !== range.length) {
        throw new MerklePackError(
          'invalid-range',
          `stage read of ${this.file.path} at ${range.offset}+${range.length} returned ${bytes.byteLength} bytes`,
        );
      }
      if (sha256Hex(bytes) !== range.sha256) {
        throw new MerklePackError(
          'chunk-digest-mismatch',
          `staged range ${this.file.path}@${range.offset}+${range.length} failed verification`,
        );
      }
      this.#held = { range, bytes };
    }
    this.onRead(length);
    const from = offset - range.offset;
    return this.#held.bytes.subarray(from, from + length);
  }
}

interface WindowPass {
  readonly extents: readonly ExtentV2[];
  readonly holes: readonly HoleExtentJson[];
  readonly endedAt: number;
}

/**
 * Re-chunk one dirty file's windows and splice the result into the parent's
 * extent list.
 *
 * The pass resumes at the boundary before each dirty cluster and STOPS at the
 * first cut that lands on a boundary of the parent, because from there on the
 * parent's extents already describe the bytes. A file the parent does not hold
 * — or one the fence staged whole, or one whose windows leave its size
 * changed — is chunked in full and counted in `wholeFiles`, the only O(file)
 * path this builder has.
 */
async function chunkDirtyFile(input: ChunkFileInput): Promise<ChunkedFile> {
  const { file, params } = input;
  const parentExtents = input.parentExtents;
  const parentBoundaries = parentExtents === null ? null : fileBoundaries(parentExtents);
  const cuts = parentBoundaries === null ? null : new Set(parentBoundaries);
  const staged = new StagedReader(file, input.stage, input.onRead);
  const chunkWindow = async (window: StagedRange, resyncFrom: number | null): Promise<WindowPass> => {
    const extents: ExtentV2[] = [];
    const holes: HoleExtentJson[] = [];
    let endedAt = window.offset + window.length;
    const reached = await chunkStagedRegion(
      {
        from: window.offset,
        to: window.offset + window.length,
        // The stage tells the sidecar what it holds — each piece with the
        // digest of exactly those bytes — so nothing here derives the present
        // set and nothing reads a byte it cannot verify.
        runs: file.ranges,
        read: async (offset, length) => await staged.read(offset, length),
      },
      params,
      input.zeroCache,
      (offset, chunk, count) => {
        input.onHash();
        if (!input.freshChunks.has(chunk.digest)) {
          input.freshChunks.set(chunk.digest, { digest: chunk.digest, bytes: chunk.bytes });
        }
        extents.push({
          digest: chunk.digest,
          length: chunk.bytes.byteLength,
          count,
          pack: UNPLACED_PACK,
          offset: 0,
        });
        const span = chunk.bytes.byteLength * count;
        // A zero chunk comes from the shared cache, so hole geometry is
        // identity rather than another scan of the bytes.
        if (input.zeroCache.get(chunk.bytes.byteLength) === chunk) {
          const last = holes[holes.length - 1];
          if (last !== undefined && last.o + last.l === offset) last.l += span;
          else holes.push({ o: offset, l: span });
        }
        const end = offset + span;
        if (cuts !== null && resyncFrom !== null && end >= resyncFrom && cuts.has(end)) {
          endedAt = end;
          return 'stop';
        }
        return undefined;
      },
    );
    return { extents, holes, endedAt: Math.min(endedAt, reached) };
  };

  const wholeFile = async (dead: readonly ExtentV2[] | null): Promise<ChunkedFile> => {
    const pass = await chunkWindow({ offset: 0, length: file.size }, null);
    const extents = normalizeExtents(pass.extents);
    if (extentsSpan(extents) !== file.size) {
      throw new MerklePackError(
        'malformed-node',
        `${file.path} chunked to ${extentsSpan(extents)} bytes and its stat says ${file.size}`,
      );
    }
    if (dead !== null) input.countDead(dead);
    const pages = pagesFor(extents, null, []);
    return {
      path: file.path,
      node: {
        kind: 'file',
        stat: input.stat,
        size: file.size,
        holes: spliceHoles([], { offset: 0, length: file.size }, pass.holes, file.size),
        inline: pages === null ? extents : null,
        pages,
      },
      extents,
      boundaries: fileBoundaries(extents),
    };
  };

  if (parentExtents === null || file.whole) {
    if (parentExtents !== null) input.onWhole();
    return await wholeFile(parentExtents);
  }

  const windows = chunkWindows({
    size: file.size,
    ranges: file.dirty,
    boundaries: parentBoundaries,
    params,
    whole: false,
  });
  let extents = [...parentExtents];
  let holes = [...(input.parentNode?.holes ?? [])];
  // The byte ranges this seal re-chunked. Every page they touch is rewritten
  // and every page they do not is the parent's own record, reused by
  // reference; a splice preserves its span, so these stay in file coordinates
  // however many of them there are.
  const changed: StagedRange[] = [];
  // LAST WINDOW FIRST, so an earlier splice cannot move a later window's
  // offsets out from under it.
  for (const window of [...windows].reverse()) {
    const lastDirty = lastDirtyByteIn(file.dirty, window);
    const pass = await chunkWindow(window, lastDirty ?? window.offset + window.length);
    const from = window.offset;
    const to = pass.endedAt;
    const replaced = sliceExtents(extents, from, to);
    const fresh = reuseKnown(pass.extents, replaced);
    input.countDead(replaced.filter((extent) => !fresh.some((kept) => kept.digest === extent.digest)));
    const head = sliceExtents(extents, 0, from);
    const tail = sliceExtents(extents, to, extentsSpan(extents));
    extents = normalizeExtents([...head, ...fresh, ...tail]);
    holes = spliceHoles(holes, { offset: from, length: to - from }, pass.holes, file.size);
    changed.push({ offset: from, length: to - from });
  }
  if (extentsSpan(extents) !== file.size) {
    // A size change the windows do not cover — a truncate past them — is the
    // other O(file) case, and it says so in the counter rather than guessing.
    input.onWhole();
    return await wholeFile(parentExtents);
  }
  const pages = pagesFor(extents, input.parentNode, changed);
  return {
    path: file.path,
    node: {
      kind: 'file',
      stat: input.stat,
      size: file.size,
      holes,
      inline: pages === null ? extents : null,
      pages,
    },
    extents,
    boundaries: fileBoundaries(extents),
  };
}

/** The last dirty byte inside one window, or null when it holds none. */
function lastDirtyByteIn(ranges: readonly StagedRange[], window: StagedRange): number | null {
  const end = window.offset + window.length;
  let last: number | null = null;
  for (const range of ranges) {
    const from = Math.max(range.offset, window.offset);
    const to = Math.min(range.offset + range.length, end);
    if (to > from) last = last === null ? to : Math.max(last, to);
  }
  return last;
}

/**
 * Fresh extents whose bytes the parent already holds keep the parent's
 * location. That is what makes the unchanged prefix of a window free: it is
 * re-hashed (the CDC has to walk it to find its cuts) but never re-uploaded.
 */
function reuseKnown(fresh: readonly ExtentV2[], replaced: readonly ExtentV2[]): ExtentV2[] {
  const known = new Map<string, ExtentV2>();
  for (const extent of replaced) {
    if (extent.pack !== UNPLACED_PACK) known.set(extent.digest, extent);
  }
  return fresh.map((extent) => {
    const held = known.get(extent.digest);
    if (held === undefined || held.length !== extent.length) return extent;
    return { ...extent, pack: held.pack, offset: held.offset };
  });
}

/**
 * How a file's extents are carried: inline up to one page, otherwise pages.
 *
 * A page this seal did not touch IS the parent's page — same file offset, same
 * bytes, same extents — so it is reused by reference. Pages are anchored to
 * file offsets rather than to extent indexes precisely so this holds: a 64 KiB
 * write inside a 64 MiB file rewrites one page, not all of them.
 */
function pagesFor(
  extents: readonly ExtentV2[],
  parentNode: FileNodeV2 | null,
  changed: readonly StagedRange[],
): readonly PlannedPage[] | null {
  const split = extentPagesV2(extents);
  if (split.length === 0) return null;
  const parentPages = new Map(
    (parentNode?.extents.kind === 'paged' ? parentNode.extents.pages : []).map((page) => [page.fileOffset, page]),
  );
  const pages: PlannedPage[] = [];
  let fileOffset = 0;
  for (const page of split) {
    const bytes = page.reduce((sum, extent) => sum + extent.length * extent.count, 0);
    const end = fileOffset + bytes;
    const touched = changed.some((range) => range.offset < end && fileOffset < range.offset + range.length);
    const held = touched ? undefined : parentPages.get(fileOffset);
    if (held !== undefined && held.bytes === bytes) pages.push({ kind: 'reuse', ref: held });
    else pages.push({ kind: 'fresh', extents: page, fileOffset, bytes });
    fileOffset = end;
  }
  return pages;
}

// ── the build ────────────────────────────────────────────────────────────────

export async function buildMerkleDelta(
  delta: DeltaManifestV2,
  options: DeltaBuildOptions,
): Promise<MerkleDeltaBuild> {
  const params = options.chunkParams ?? DEFAULT_CHUNK_PARAMS;
  validateChunkParams(params);
  const cap = options.maxPackBytes ?? DEFAULT_MAX_PACK_BYTES_V2;
  if (!Number.isSafeInteger(cap) || cap < 1024) {
    throw new MerklePackError('invalid-parameter', `maxPackBytes must be >= 1024, got ${cap}`);
  }
  const parent = options.parent ?? null;
  if (parent !== null && !publishedParents.has(parent)) {
    throw new MerklePackError('invalid-parameter', 'v2 parent was not issued from a published candidate');
  }
  if (parent === null) {
    if (delta.base !== null) {
      throw new MerklePackError('invalid-parameter', 'a delta with a base needs the parent generation it names');
    }
  } else if (delta.base === null || delta.base.root !== parent.headRootId) {
    throw new MerklePackError(
      'invalid-parameter',
      `delta base ${delta.base?.root ?? 'none'} is not the published parent ${parent.headRootId}`,
    );
  }
  for (const file of delta.dirtyFiles) {
    if (!isCanonicalJournalPath(file.path)) {
      throw new MerklePackError('hostile-path', `refusing non-canonical path ${JSON.stringify(file.path)}`);
    }
  }

  const view = parent?.view ?? null;
  const dirs = new Map<string, PlannedDir>();
  const removed: string[] = [];
  const origins = new Map<string, string>();
  const freshChunks = new Map<string, FreshChunk>();
  const deadBytes = new Map<string, number>();
  const zeroCache = new Map<number, EmittedChunk>();
  let bytesChunked = 0;
  let chunksHashed = 0;
  let wholeFiles = 0;

  const countDead = (extents: readonly ExtentV2[]): void => {
    for (const extent of extents) {
      if (extent.pack === UNPLACED_PACK) continue;
      deadBytes.set(extent.pack, (deadBytes.get(extent.pack) ?? 0) + extent.length * extent.count);
    }
  };
  const countDeadRecord = (ref: { readonly pack: string; readonly length: number }): void => {
    deadBytes.set(ref.pack, (deadBytes.get(ref.pack) ?? 0) + ref.length);
  };

  /**
   * Materialize one directory into the plan: the parent's children become
   * reuse refs, so rewriting this directory keeps every subtree it did not
   * touch exactly where that subtree already is.
   */
  const materializeDir = async (path: string): Promise<PlannedDir> => {
    const held = dirs.get(path);
    if (held !== undefined) return held;
    const origin = origins.get(path) ?? path;
    const record = view === null ? null : await view.record(origin);
    const children = new Map<string, PlannedChild>();
    let stat: PlannedStat = { mode: DEFAULT_DIR_MODE, ino: 0, metadata: EMPTY_METADATA };
    if (record !== null) {
      if (record.node.kind !== 'dir') {
        throw new MerklePackError('not-a-directory', `${JSON.stringify(origin)} is not a directory in the parent`);
      }
      stat = { mode: record.node.mode, ino: record.node.ino, metadata: record.node.metadata ?? EMPTY_METADATA };
      for (const entry of record.node.entries) {
        children.set(entry.name, { kind: 'reuse', nodeKind: entry.kind, ref: entry.ref });
      }
      countDeadRecord(record.ref);
    }
    const planned: PlannedDir = { kind: 'dir', stat, children };
    dirs.set(path, planned);
    if (path !== '') {
      const above = await materializeDir(parentPathOf(path));
      above.children.set(nameOf(path), { kind: 'fresh', node: planned });
    }
    return planned;
  };

  await materializeDir('');
  const setChild = async (path: string, child: PlannedChild): Promise<void> => {
    (await materializeDir(parentPathOf(path))).children.set(nameOf(path), child);
  };

  // ── structural replay, in WAL order ───────────────────────────────────────
  for (const op of delta.metadataOps) {
    if (op.result < 0) continue;
    if (!isCanonicalJournalPath(op.path)) {
      throw new MerklePackError('hostile-path', `refusing non-canonical op path ${JSON.stringify(op.path)}`);
    }
    // RENAME, HARDLINK AND REMOVAL ARE THE ONLY STRUCTURAL OPS LEFT. A
    // create, a mkdir, a symlink, a chmod, a chown, a utimens, a truncate and
    // both xattr ops each end in a row that states the result, so replaying
    // them here would replay what the row already says.
    if (op.op === 'link') {
      const source = await materializeDir(parentPathOf(op.argument));
      const shared = source.children.get(nameOf(op.argument));
      if (shared === undefined) {
        throw new MerklePackError('no-entry', `hardlink source ${JSON.stringify(op.argument)} is absent`);
      }
      await setChild(op.path, shared);
      continue;
    }
    if (op.op === 'rename') {
      const from = await materializeDir(parentPathOf(op.path));
      const moved = from.children.get(nameOf(op.path));
      if (moved === undefined) {
        throw new MerklePackError('no-entry', `rename source ${JSON.stringify(op.path)} is absent`);
      }
      from.children.delete(nameOf(op.path));
      await setChild(op.argument, moved);
      origins.set(op.argument, origins.get(op.path) ?? op.path);
      removed.push(op.path);
      continue;
    }
    if (op.op === 'unlink' || op.op === 'rmdir') {
      const above = await materializeDir(parentPathOf(op.path));
      const dropped = above.children.get(nameOf(op.path));
      above.children.delete(nameOf(op.path));
      if (dropped?.kind === 'reuse') countDeadRecord(dropped.ref);
      dirs.delete(op.path);
      removed.push(op.path);
      continue;
    }
  }

  // ── the rows, in path order: what each touched node now IS ───────────────
  //
  // ANCESTORS COME FIRST because paths sort that way, so a directory's own row
  // has set its stat before anything under it is planted into it.
  const chunked: ChunkedFile[] = [];
  const boundaries: BoundaryRow[] = [];
  const sharedByIno = new Map<string, PlannedChild>();
  for (const file of [...delta.dirtyFiles].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const stat = statOf(file);
    if (file.kind === 'dir') {
      (await materializeDir(file.path)).stat = stat;
      continue;
    }
    if (file.kind === 'symlink') {
      await setChild(file.path, { kind: 'fresh', node: { kind: 'symlink', stat, target: file.target ?? '' } });
      continue;
    }
    const shared = sharedByIno.get(file.ino);
    if (shared !== undefined) {
      // A second name for one inode is one record; disagreement inside a
      // hardlink group is a corrupt fence rather than two files.
      if (shared.kind === 'fresh' && shared.node.kind === 'file' && !statsAgree(shared.node.stat, stat)) {
        throw new MerklePackError('inconsistent-hardlink', `hardlinks of inode ${file.ino} disagree at ${file.path}`);
      }
      await setChild(file.path, shared);
      continue;
    }
    const origin = origins.get(file.path) ?? file.path;
    let parentNode: FileNodeV2 | null = null;
    let parentExtents: readonly ExtentV2[] | null = null;
    if (view !== null) {
      const record = await view.record(origin);
      if (record !== null && record.node.kind === 'file') {
        parentNode = record.node;
        parentExtents = await view.fileExtents(origin);
        countDeadRecord(record.ref);
      }
    }
    const planned = await chunkDirtyFile({
      file,
      stat,
      parentNode,
      parentExtents,
      params,
      stage: options.stage,
      zeroCache,
      freshChunks,
      countDead,
      onRead: (bytes) => { bytesChunked += bytes; },
      onHash: () => { chunksHashed += 1; },
      onWhole: () => { wholeFiles += 1; },
    });
    chunked.push(planned);
    boundaries.push({ ino: file.ino, path: file.path, size: planned.node.size, boundaries: planned.boundaries });
    const child: PlannedChild = { kind: 'fresh', node: planned.node };
    sharedByIno.set(file.ino, child);
    await setChild(file.path, child);
  }

  // ── layout: chunks, pages, file nodes, symlinks, dirs postorder, root ────
  const writer = new PackWriter(cap);
  const chunkSlots = new Map<string, Slot>();
  const recordSlots = new Map<PlannedNode | PlannedPage, { slot: Slot; id: string }>();
  let nodesRewritten = 0;

  const placeChunks = (extents: readonly ExtentV2[]): void => {
    for (const extent of extents) {
      if (extent.pack !== UNPLACED_PACK || chunkSlots.has(extent.digest)) continue;
      const chunk = freshChunks.get(extent.digest);
      if (chunk === undefined) {
        throw new MerklePackError('missing-digest', `fresh chunk ${extent.digest} has no bytes`);
      }
      chunkSlots.set(extent.digest, writer.place(chunk.bytes));
    }
  };
  for (const planned of chunked) placeChunks(planned.extents);

  const resolveExtents = (extents: readonly ExtentV2[], resolve: ResolvePack): ExtentV2[] =>
    extents.map((extent) => {
      if (extent.pack !== UNPLACED_PACK) return extent;
      const slot = chunkSlots.get(extent.digest);
      if (slot === undefined) throw new MerklePackError('missing-digest', `chunk ${extent.digest} was not placed`);
      return { ...extent, pack: resolve(slot), offset: slot.offset };
    });

  const placeRecord = (key: PlannedNode | PlannedPage, node: (resolve: ResolvePack) => NodeV2): void => {
    let id = '';
    const slot = writer.placeRecord((resolve) => {
      const bytes = encodeNodeV2(node(resolve));
      id = hashNodeV2Bytes(bytes);
      return bytes;
    });
    nodesRewritten += 1;
    recordSlots.set(key, { slot, id });
  };
  const refOf = (key: PlannedNode | PlannedPage, resolve: ResolvePack): RecordRefV2 => {
    const held = recordSlots.get(key);
    if (held === undefined) throw new MerklePackError('missing-digest', 'a planned record was not placed');
    return {
      id: held.id,
      sha256: held.slot.sha256,
      pack: resolve(held.slot),
      offset: held.slot.offset,
      length: held.slot.length,
    };
  };

  for (const planned of chunked) {
    for (const page of planned.node.pages ?? []) {
      if (page.kind !== 'fresh') continue;
      placeRecord(page, (resolve) => ({ kind: 'page', extents: resolveExtents(page.extents, resolve) }));
    }
  }
  for (const planned of chunked) {
    placeRecord(planned.node, (resolve) => fileNodeOf(planned.node, resolve, resolveExtents, refOf));
  }

  const root = dirs.get('')!;
  const symlinks: PlannedSymlink[] = [];
  const collectSymlinks = (dir: PlannedDir): void => {
    for (const child of dir.children.values()) {
      if (child.kind !== 'fresh') continue;
      if (child.node.kind === 'symlink') symlinks.push(child.node);
      else if (child.node.kind === 'dir') collectSymlinks(child.node);
    }
  };
  collectSymlinks(root);
  for (const link of symlinks) {
    placeRecord(link, () => ({
      kind: 'symlink',
      mode: link.stat.mode,
      ino: link.stat.ino,
      target: link.target,
      metadata: link.stat.metadata,
    }));
  }

  const placeDir = (dir: PlannedDir): void => {
    for (const child of dir.children.values()) {
      if (child.kind === 'fresh' && child.node.kind === 'dir') placeDir(child.node);
    }
    placeRecord(dir, (resolve) => ({
      kind: 'dir',
      mode: dir.stat.mode,
      ino: dir.stat.ino,
      entries: [...dir.children.entries()].map(([name, child]): DirEntryV2 => ({
        name,
        kind: child.kind === 'reuse' ? child.nodeKind : child.node.kind,
        ref: child.kind === 'reuse' ? child.ref : refOf(child.node, resolve),
      })),
      metadata: dir.stat.metadata,
    }));
  };
  placeDir(root);
  writer.finish();

  const rootRecord = recordSlots.get(root);
  if (rootRecord === undefined) throw new MerklePackError('corrupt-root', 'the root record was not placed');
  return {
    packs: writer.packs,
    rootObject: {
      key: writer.keyOf(rootRecord.slot),
      byteOffset: String(rootRecord.slot.offset),
      byteLength: String(rootRecord.slot.length),
      sha256: rootRecord.slot.sha256,
    },
    seal: { bytesChunked, chunksHashed, nodesRewritten, wholeFiles },
    boundaries,
    removed,
    deadBytes,
  };
}

function fileNodeOf(
  node: PlannedFile,
  resolve: ResolvePack,
  resolveExtents: (extents: readonly ExtentV2[], resolve: ResolvePack) => ExtentV2[],
  refOf: (key: PlannedNode | PlannedPage, resolve: ResolvePack) => RecordRefV2,
): NodeV2 {
  if (node.pages === null) {
    if (node.inline === null) throw new MerklePackError('malformed-node', 'a planned file carries no extents');
    return {
      kind: 'file',
      mode: node.stat.mode,
      ino: node.stat.ino,
      size: node.size,
      extents: { kind: 'inline', extents: resolveExtents(node.inline, resolve) },
      holes: [...node.holes],
      metadata: node.stat.metadata,
    };
  }
  const pages: ExtentPageRefV2[] = node.pages.map((page) => {
    if (page.kind === 'reuse') return page.ref;
    const ref = refOf(page, resolve);
    return {
      ...ref,
      fileOffset: page.fileOffset,
      extents: extentsCount(page.extents),
      bytes: page.bytes,
    };
  });
  return {
    kind: 'file',
    mode: node.stat.mode,
    ino: node.stat.ino,
    size: node.size,
    extents: { kind: 'paged', pages },
    holes: [...node.holes],
    metadata: node.stat.metadata,
  };
}
