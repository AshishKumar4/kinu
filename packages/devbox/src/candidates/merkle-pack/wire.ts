/**
 * The merkle-pack wire vocabulary: canonical serialization, digest derivation,
 * object-key layout, and the schemas every decoded byte must pass. Nodes hash
 * under a domain tag so a node digest never collides with a chunk digest of
 * coincidentally equal bytes; the v1 index additionally records each extent's
 * PLAIN SHA-256, because range-read intents authenticate plain bytes.
 *
 * Two node formats live here. v1 names chunks and children by digest alone and
 * leans on one index object per generation to locate them. v2 carries every
 * location in the record that references it, so a reader needs no index and a
 * seal rewrites only the records whose bytes changed; see the v2 section.
 */

import { createHash } from 'node:crypto';
import * as v from 'valibot';

import { sha256Hex } from '../../cas/hash';
import type { ImmutableObjectRef } from '../../durability/contracts';
import { CapturedCutSchema, ImmutableObjectRefSchema } from '../../durability/contracts';

import { MerklePackError } from './errors';

export const MERKLE_PACK_FORMAT = 'merkle-pack/v1';

const NODE_HASH_TAG = 'merkle-pack/v1\nnode\n';
const NODE_V2_HASH_TAG = 'merkle-pack/v2\nnode\n';
const utf8 = new TextEncoder();

const MAX_SYMLINK_TARGET_BYTES = 4096;

// ── canonical serialization ───────────────────────────────────────────────────

/**
 * Directory and symlink nodes carry their inode id: distinct inodes stay
 * distinct nodes even when mode and payload coincide, so hardlink identity
 * survives a round trip exactly as the capture model stated it. Serialized
 * through plain JSON.stringify with fixed literal key order and pre-sorted
 * children arrays, so identical subtrees hash identically.
 */
export type DirEntryJson = { n: string; k: 'file' | 'dir' | 'symlink'; r: string };
/**
 * One file extent represents `n` adjacent logical chunks, each `l` bytes and
 * named by the digest of its exact bytes. Repetition keeps sparse holes
 * proportional to their runs rather than their apparent size.
 */
export type FileExtentJson = { d: string; l: number; n: number };
export type HoleExtentJson = { o: number; l: number };
export type PosixMetadataJson = {
  uid: number;
  gid: number;
  atimeNs: string;
  mtimeNs: string;
  ctimeNs: string;
  xattrs: Record<string, string>;
};
export type NodeJson =
  | { t: 'f'; m: number; i: number; s: number; c: FileExtentJson[]; h: HoleExtentJson[]; metadata?: PosixMetadataJson }
  | { t: 'd'; m: number; i: number; e: DirEntryJson[]; metadata?: PosixMetadataJson }
  | { t: 'l'; m: number; i: number; g: string; metadata?: PosixMetadataJson };

function hashTagged(tag: string, serialized: Uint8Array): string {
  return createHash('sha256').update(tag).update(serialized).digest('hex');
}

function hashNode(serialized: Uint8Array): string {
  return hashTagged(NODE_HASH_TAG, serialized);
}

export { hashNode as hashNodeBytes };

export function serializeNode(json: NodeJson): Uint8Array {
  return utf8.encode(JSON.stringify(json));
}

/** The committed root of one generation: its id and exact manifest bytes. */
export interface MerklePackRoot {
  readonly rootId: string;
  readonly manifestBytes: Uint8Array;
}

export function packKey(id: string): string {
  return `v1/merkle-pack/pack/${id}`;
}
export function indexKey(id: string): string {
  return `v1/merkle-pack/index/${id}`;
}
export function rootKey(id: string): string {
  return `v1/merkle-pack/root/${id}`;
}

/** A v2 pack: the same content address, under its own format prefix. */
export function packKeyV2(id: string): string {
  return `v2/merkle-pack/pack/${id}`;
}

export function objectRef(key: string, bytes: Uint8Array): ImmutableObjectRef {
  return { key, byteLength: String(bytes.byteLength), sha256: sha256Hex(bytes) };
}

// ── wire schemas ──────────────────────────────────────────────────────────────

const Hex64 = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/, 'Expected a lowercase SHA-256 digest'));
const Count = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const ModeSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(0o7777));
const Nanoseconds = v.pipe(v.string(), v.regex(/^(?:0|[1-9]\d*)$/));
const XattrValue = v.pipe(v.string(), v.regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/));
const PosixMetadataSchema = v.strictObject({
  uid: Count,
  gid: Count,
  atimeNs: Nanoseconds,
  mtimeNs: Nanoseconds,
  ctimeNs: Nanoseconds,
  xattrs: v.record(v.string(), XattrValue),
});

export const IndexSchema = v.strictObject({
  v: v.literal(1),
  /** Full immutable refs make a recovered root's closure derivable. */
  p: v.array(ImmutableObjectRefSchema),
  e: v.array(
    v.tuple([
      Hex64,
      Hex64,
      v.pipe(v.string(), v.minLength(1), v.maxLength(1024)),
      Count,
      v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
    ]),
  ),
});

export const RootManifestSchema = v.strictObject({
  format: v.literal(MERKLE_PACK_FORMAT),
  v: v.literal(1),
  root: Hex64,
  index: v.strictObject({
    key: v.pipe(v.string(), v.minLength(1), v.maxLength(1024)),
    byteLength: v.pipe(
      v.string(),
      v.regex(/^(?:0|[1-9]\d*)$/, 'Expected a canonical non-negative decimal string'),
    ),
    sha256: Hex64,
  }),
  capturedCut: CapturedCutSchema,
});
const FileExtentSchema = v.strictObject({
  d: Hex64,
  l: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  n: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
});
const HoleExtentSchema = v.strictObject({
  o: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  l: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
});

export const NodeSchema = v.variant('t', [
  v.strictObject({
    t: v.literal('f'),
    m: ModeSchema,
    i: Count,
    s: Count,
    c: v.array(FileExtentSchema),
    h: v.array(HoleExtentSchema),
    metadata: v.optional(PosixMetadataSchema),
  }),
  v.strictObject({
    t: v.literal('d'),
    m: ModeSchema,
    i: Count,
    e: v.array(
      v.strictObject({
        n: v.pipe(v.string(), v.minLength(1)),
        k: v.picklist(['file', 'dir', 'symlink']),
        r: Hex64,
      }),
    ),
    metadata: v.optional(PosixMetadataSchema),
  }),
  v.strictObject({
    t: v.literal('l'),
    m: ModeSchema,
    i: Count,
    g: v.pipe(v.string(), v.maxLength(MAX_SYMLINK_TARGET_BYTES)),
    metadata: v.optional(PosixMetadataSchema),
  }),
]);

/** A directory entry name that can round-trip through a POSIX directory. */
function canonicalChildName(name: string): boolean {
  return (
    !name.includes('/') &&
    !name.includes('\0') &&
    name !== '.' &&
    name !== '..' &&
    name.length !== 0 &&
    utf8.encode(name).byteLength <= 255
  );
}

/** Directory entry names decode from untrusted bytes; re-assert canonicality. */
export function assertChildNames(node: { e: ReadonlyArray<{ n: string }> }): void {
  for (const entry of node.e) {
    if (!canonicalChildName(entry.n)) {
      throw new MerklePackError('malformed-node', `directory entry name ${JSON.stringify(entry.n)} is not canonical`);
    }
  }
}

// ── node v2: locations in records, no index ───────────────────────────────────
//
// A v2 record names where every byte it references lives. A file extent
// carries the pack and offset of its chunk; a directory entry carries its
// child record's pack, offset, length and plain digest; a file above
// EXTENTS_PER_PAGE extents carries page records instead of an inline list. A
// reader therefore opens a tree with one range read for the root and O(depth)
// reads for any path, and a seal rewrites only the records whose bytes changed:
// the touched file's node and pages and its ancestors. Packs stay
// content-addressed, so a record cannot name the pack it is being written into;
// SELF_PACK stands for it and the reader substitutes the key it read from. A
// builder fixes referenced offsets first: chunks in file order, then extent
// pages and nodes with every parent after its children. That order removes a
// pack-key cycle and keeps file-adjacent chunks contiguous for coalesced reads.
//
// Canonical by construction. encodeNodeV2 derives each record's pack table in
// first-use order, sorts directory entries and xattr names by code unit,
// refuses every other non-canonical input through the same schema
// decodeNodeV2 applies, and serializes the validated record in schema key
// order. Two permutations of one record are one byte sequence, which is what
// lets an unchanged record keep its digest and its location across seals.

export const MERKLE_PACK_V2_FORMAT = 'merkle-pack/v2';

/**
 * A file inlines up to this many extents. Above it, its extents live in pages.
 */
export const EXTENTS_PER_PAGE = 1024;

/**
 * How much of a FILE one extent page covers.
 *
 * PAGES ARE ANCHORED TO FILE OFFSETS, NOT TO EXTENT INDEXES, and that is the
 * whole point of the constant. An index-aligned split (page k holds extents
 * 1024k…1024k+1023) is a pure function of the extent list too, but a 4 KiB
 * write that changes the chunk count by even one extent shifts every later
 * page — so a 64 KiB write inside a 64 MiB file rewrote ten pages of extents,
 * about 1.1 MB, and the write path was O(file / page) instead of O(k).
 * Measured on this tree, 2026-09-02, before this rule replaced that one.
 *
 * Anchored to offsets, a page ends at the first extent boundary at or after
 * the next multiple of this span, so an unchanged region of a file produces
 * byte-identical pages whatever happened elsewhere in it, and a local write
 * rewrites the one page it landed in. Every rule a reader needs is still
 * checkable from the page refs alone: the offsets chain, and every page but
 * the last covers at least one span.
 */
export const EXTENT_PAGE_SPAN_BYTES = 2 * 1024 * 1024;

/** The pack-table entry for the pack a record lives in. */
export const SELF_PACK = '.';

export function hashNodeV2Bytes(serialized: Uint8Array): string {
  return hashTagged(NODE_V2_HASH_TAG, serialized);
}

/** One run of `count` adjacent logical chunks, each `length` bytes and equal
 * to the bytes at `offset` in `pack`, whose plain digest is `digest`. */
export interface ExtentV2 {
  readonly digest: string;
  readonly length: number;
  readonly count: number;
  readonly pack: string;
  readonly offset: number;
}

/** A record inside a pack: its v2 node id, the plain digest of its bytes, and
 * where those bytes are. */
export interface RecordRefV2 {
  readonly id: string;
  readonly sha256: string;
  readonly pack: string;
  readonly offset: number;
  readonly length: number;
}

/** One page of a large file's extents, with how many extents and logical bytes
 * it spans, so a reader finds the page for an offset without fetching the
 * pages before it. */
export interface ExtentPageRefV2 extends RecordRefV2 {
  /** Logical file offset covered by this page. */
  readonly fileOffset: number;
  readonly extents: number;
  readonly bytes: number;
}

export interface DirEntryV2 {
  readonly name: string;
  readonly kind: 'file' | 'dir' | 'symlink';
  readonly ref: RecordRefV2;
}

export type FileExtentsV2 =
  | { readonly kind: 'inline'; readonly extents: readonly ExtentV2[] }
  | { readonly kind: 'paged'; readonly pages: readonly ExtentPageRefV2[] };

/** A v2 record with every reference resolved to a pack key or SELF_PACK. */
export type NodeV2 =
  | {
      readonly kind: 'file';
      readonly mode: number;
      readonly ino: number;
      readonly size: number;
      readonly extents: FileExtentsV2;
      readonly holes: readonly HoleExtentJson[];
      readonly metadata?: PosixMetadataJson;
    }
  | {
      readonly kind: 'dir';
      readonly mode: number;
      readonly ino: number;
      readonly entries: readonly DirEntryV2[];
      readonly metadata?: PosixMetadataJson;
    }
  | {
      readonly kind: 'symlink';
      readonly mode: number;
      readonly ino: number;
      readonly target: string;
      readonly metadata?: PosixMetadataJson;
    }
  | { readonly kind: 'page'; readonly extents: readonly ExtentV2[] };

const Positive = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const PackTableSchema = v.array(
  v.union([
    v.literal(SELF_PACK),
    v.pipe(v.string(), v.regex(/^v[12]\/merkle-pack\/pack\/[0-9a-f]{64}$/, 'Expected a content-addressed pack key')),
  ]),
);
const WireExtentSchema = v.strictObject({ d: Hex64, l: Positive, n: Positive, p: Count, o: Count });
const WireRecordRefEntries = { r: Hex64, s: Hex64, p: Count, o: Count, l: Positive };
const WirePageRefSchema = v.strictObject({
  r: Hex64,
  s: Hex64,
  a: Count,
  p: Count,
  o: Count,
  l: Positive,
  e: v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(EXTENTS_PER_PAGE)),
  b: Positive,
});
const WireDirEntrySchema = v.strictObject({
  n: v.pipe(v.string(), v.minLength(1)),
  k: v.picklist(['file', 'dir', 'symlink']),
  ...WireRecordRefEntries,
});

const WireNodeV2Schema = v.variant('t', [
  v.strictObject({
    v: v.literal(2),
    t: v.literal('f'),
    m: ModeSchema,
    i: Count,
    s: Count,
    P: PackTableSchema,
    c: v.optional(v.array(WireExtentSchema)),
    x: v.optional(v.array(WirePageRefSchema)),
    h: v.array(HoleExtentSchema),
    metadata: v.optional(PosixMetadataSchema),
  }),
  v.strictObject({
    v: v.literal(2),
    t: v.literal('d'),
    m: ModeSchema,
    i: Count,
    P: PackTableSchema,
    e: v.array(WireDirEntrySchema),
    metadata: v.optional(PosixMetadataSchema),
  }),
  v.strictObject({
    v: v.literal(2),
    t: v.literal('l'),
    m: ModeSchema,
    i: Count,
    g: v.pipe(v.string(), v.maxLength(MAX_SYMLINK_TARGET_BYTES)),
    metadata: v.optional(PosixMetadataSchema),
  }),
  v.strictObject({
    v: v.literal(2),
    t: v.literal('x'),
    P: PackTableSchema,
    c: v.array(WireExtentSchema),
  }),
]);
type WireNodeV2 = v.InferOutput<typeof WireNodeV2Schema>;

/** Sum of `length × count` over extents, or null past the safe range. */
function extentSpan(extents: ReadonlyArray<{ l: number; n: number }>): number | null {
  let total = 0;
  for (const extent of extents) {
    const span = extent.l * extent.n;
    if (!Number.isSafeInteger(span) || !Number.isSafeInteger(total + span)) return null;
    total += span;
  }
  return total;
}

/** The pack index of every reference a record makes, in serialization order. */
function packIndexes(node: Exclude<WireNodeV2, { t: 'l' }>): readonly number[] {
  switch (node.t) {
    case 'f':
      return node.c !== undefined ? node.c.map((extent) => extent.p) : (node.x ?? []).map((page) => page.p);
    case 'd':
      return node.e.map((entry) => entry.p);
    default:
      return node.c.map((extent) => extent.p);
  }
}

function packTableProblem(node: Exclude<WireNodeV2, { t: 'l' }>): string | null {
  if (new Set(node.P).size !== node.P.length) return 'the pack table repeats a pack';
  let seen = 0;
  for (const index of packIndexes(node)) {
    if (index >= node.P.length) return `pack index ${index} is outside a table of ${node.P.length}`;
    if (index > seen) return `pack index ${index} is used before ${seen}; the table is not in first-use order`;
    if (index === seen) seen += 1;
  }
  return seen === node.P.length ? null : `the pack table names ${node.P.length - seen} pack(s) nothing references`;
}

function fileProblem(node: Extract<WireNodeV2, { t: 'f' }>): string | null {
  if ((node.c === undefined) === (node.x === undefined)) {
    return 'a file names inline extents or extent pages, exactly one of the two';
  }
  if (node.c !== undefined) {
    if (node.c.length > EXTENTS_PER_PAGE) {
      return `${node.c.length} inline extents exceed ${EXTENTS_PER_PAGE}; above that a file names extent pages`;
    }
    const span = extentSpan(node.c);
    if (span === null) return 'file chunk geometry exceeds the safe integer range';
    if (span !== node.s) return `file declares ${node.s} bytes but its extents resolve to ${span}`;
  } else if (node.x !== undefined) {
    if (node.x.length < 2) return 'extent pages replace an inline list only above one page of extents';
    for (const [i, page] of node.x.slice(0, -1).entries()) {
      // EVERY PAGE BUT THE LAST HOLDS A SPAN BOUNDARY, or is full: those are
      // the two reasons a page can end, and both are visible from the ref.
      const spans = Math.floor((page.a + page.b) / EXTENT_PAGE_SPAN_BYTES) > Math.floor(page.a / EXTENT_PAGE_SPAN_BYTES);
      if (!spans && page.e !== EXTENTS_PER_PAGE) {
        return `extent page ${i} covers ${page.b} bytes from ${page.a} and holds ${page.e} extents; a page ends at a ${EXTENT_PAGE_SPAN_BYTES}-byte boundary or at ${EXTENTS_PER_PAGE} extents`;
      }
    }
    let total = 0;
    for (const page of node.x) {
      if (page.a !== total) return `extent page begins at ${page.a}; its canonical file offset is ${total}`;
      if (!Number.isSafeInteger(total + page.b)) return 'file page geometry exceeds the safe integer range';
      total += page.b;
    }
    if (total !== node.s) return `file declares ${node.s} bytes but its pages span ${total}`;
  }
  let cursor = 0;
  for (const hole of node.h) {
    if (hole.o < cursor || hole.o + hole.l > node.s) return 'hole geometry overlaps, runs backwards, or exceeds the file';
    cursor = hole.o + hole.l;
  }
  return null;
}

function dirProblem(node: Extract<WireNodeV2, { t: 'd' }>): string | null {
  let previous: string | null = null;
  for (const entry of node.e) {
    if (!canonicalChildName(entry.n)) return `directory entry name ${JSON.stringify(entry.n)} is not canonical`;
    if (previous === entry.n) return `directory entry ${JSON.stringify(entry.n)} repeats`;
    if (previous !== null && previous > entry.n) return `directory entries are not sorted at ${JSON.stringify(entry.n)}`;
    previous = entry.n;
  }
  return null;
}

function nonCanonical(node: WireNodeV2): string | null {
  if (node.t !== 'x') {
    const names = node.metadata === undefined ? [] : Object.keys(node.metadata.xattrs);
    for (let i = 1; i < names.length; i += 1) {
      if (names[i - 1] >= names[i]) return 'xattr names are not sorted';
    }
  }
  if (node.t === 'l') return null;
  let own: string | null;
  switch (node.t) {
    case 'f':
      own = fileProblem(node);
      break;
    case 'd':
      own = dirProblem(node);
      break;
    default:
      own =
        node.c.length === 0 || node.c.length > EXTENTS_PER_PAGE
          ? `an extent page holds 1 to ${EXTENTS_PER_PAGE} extents, not ${node.c.length}`
          : null;
  }
  return own ?? packTableProblem(node);
}

/** Every decoded v2 record passes this: the wire form, plus the canonical
 * rules the JSON grammar cannot state. */
export const NodeV2Schema = v.pipe(
  WireNodeV2Schema,
  v.rawCheck(({ dataset, addIssue }) => {
    if (!dataset.typed) return;
    const problem = nonCanonical(dataset.value);
    if (problem !== null) addIssue({ message: problem });
  }),
);

/**
 * Canonical split of a file's extents into pages: empty when the file inlines
 * them, otherwise a page per `EXTENT_PAGE_SPAN_BYTES` the file crosses, ending
 * after the extent that crosses it, or at `EXTENTS_PER_PAGE` extents.
 */
export function extentPagesV2(extents: readonly ExtentV2[]): readonly (readonly ExtentV2[])[] {
  if (extents.length <= EXTENTS_PER_PAGE) return [];
  const pages: (readonly ExtentV2[])[] = [];
  let page: ExtentV2[] = [];
  let offset = 0;
  for (const extent of extents) {
    const from = offset;
    offset += extent.length * extent.count;
    page.push(extent);
    // THE BREAK IS LOCAL: after the extent that carries the file across a span
    // boundary, decided by that extent's own offsets and nothing else. So the
    // pages of an unchanged region are the same pages whatever happened
    // elsewhere in the file, and a write rewrites the page it landed in.
    const crossed =
      Math.floor(offset / EXTENT_PAGE_SPAN_BYTES) > Math.floor(from / EXTENT_PAGE_SPAN_BYTES);
    if (crossed || page.length === EXTENTS_PER_PAGE) {
      pages.push(page);
      page = [];
    }
  }
  if (page.length > 0) pages.push(page);
  return pages;
}

/** Assigns pack indexes in first-use order; the table is what the record carries. */
class PackTable {
  readonly keys: string[] = [];
  readonly #index = new Map<string, number>();

  indexOf(pack: string): number {
    const known = this.#index.get(pack);
    if (known !== undefined) return known;
    const index = this.keys.length;
    this.keys.push(pack);
    this.#index.set(pack, index);
    return index;
  }
}

function wireExtents(table: PackTable, extents: readonly ExtentV2[]): v.InferInput<typeof WireExtentSchema>[] {
  return extents.map((extent) => ({
    d: extent.digest,
    l: extent.length,
    n: extent.count,
    p: table.indexOf(extent.pack),
    o: extent.offset,
  }));
}

function wireMetadata(metadata: PosixMetadataJson | undefined): PosixMetadataJson | undefined {
  if (metadata === undefined) return undefined;
  const xattrs: Record<string, string> = {};
  for (const name of Object.keys(metadata.xattrs).sort()) xattrs[name] = metadata.xattrs[name];
  return {
    uid: metadata.uid,
    gid: metadata.gid,
    atimeNs: metadata.atimeNs,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs,
    xattrs,
  };
}

function wireNodeV2(node: NodeV2): v.InferInput<typeof WireNodeV2Schema> {
  const table = new PackTable();
  switch (node.kind) {
    case 'file': {
      const inline = node.extents.kind === 'inline' ? wireExtents(table, node.extents.extents) : undefined;
      const pages =
        node.extents.kind === 'paged'
          ? node.extents.pages.map((page) => ({
              r: page.id,
              s: page.sha256,
              a: page.fileOffset,
              p: table.indexOf(page.pack),
              o: page.offset,
              l: page.length,
              e: page.extents,
              b: page.bytes,
            }))
          : undefined;
      return {
        v: 2,
        t: 'f',
        m: node.mode,
        i: node.ino,
        s: node.size,
        P: table.keys,
        c: inline,
        x: pages,
        h: [...node.holes],
        metadata: wireMetadata(node.metadata),
      };
    }
    case 'dir': {
      const entries = [...node.entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return {
        v: 2,
        t: 'd',
        m: node.mode,
        i: node.ino,
        P: table.keys,
        e: entries.map((entry) => ({
          n: entry.name,
          k: entry.kind,
          r: entry.ref.id,
          s: entry.ref.sha256,
          p: table.indexOf(entry.ref.pack),
          o: entry.ref.offset,
          l: entry.ref.length,
        })),
        metadata: wireMetadata(node.metadata),
      };
    }
    case 'symlink':
      return { v: 2, t: 'l', m: node.mode, i: node.ino, g: node.target, metadata: wireMetadata(node.metadata) };
    default:
      return { v: 2, t: 'x', P: table.keys, c: wireExtents(table, node.extents) };
  }
}

/**
 * Canonical bytes of one v2 record. The pack table is derived, directory
 * entries and xattr names are sorted, and everything else the record claims
 * (geometry, pagination, names) is validated before a byte is written, so a
 * builder cannot produce two spellings of one record.
 */
export function encodeNodeV2(node: NodeV2): Uint8Array {
  const wire = wireNodeV2(node);
  const parsed = v.safeParse(NodeV2Schema, wire);
  if (!parsed.success) {
    throw new MerklePackError('invalid-parameter', `node v2 is not canonical: ${parsed.issues[0].message}`);
  }
  return utf8.encode(JSON.stringify(parsed.output));
}

function resolveExtents(table: readonly string[], extents: ReadonlyArray<v.InferOutput<typeof WireExtentSchema>>): ExtentV2[] {
  return extents.map((extent) => ({
    digest: extent.d,
    length: extent.l,
    count: extent.n,
    pack: table[extent.p],
    offset: extent.o,
  }));
}

/**
 * The resolved record behind canonical v2 bytes. Bytes the encoder would not
 * have written for the same record are refused, so a digest names exactly one
 * spelling. SELF_PACK is preserved: the reader that knows which pack it read
 * from substitutes the key.
 */
export function decodeNodeV2(bytes: Uint8Array): NodeV2 {
  const text = new TextDecoder().decode(bytes);
  let wire: WireNodeV2;
  try {
    wire = v.parse(NodeV2Schema, JSON.parse(text));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new MerklePackError('malformed-node', `node v2 did not decode: ${detail}`, { cause: error });
  }
  if (JSON.stringify(wire) !== text) {
    throw new MerklePackError('malformed-node', 'node v2 bytes are not the canonical spelling of the record they decode to');
  }
  switch (wire.t) {
    case 'f': {
      const extents: FileExtentsV2 =
        wire.c !== undefined
          ? { kind: 'inline', extents: resolveExtents(wire.P, wire.c) }
          : {
              kind: 'paged',
              pages: (wire.x ?? []).map((page) => ({
                id: page.r,
                sha256: page.s,
                fileOffset: page.a,
                pack: wire.P[page.p],
                offset: page.o,
                length: page.l,
                extents: page.e,
                bytes: page.b,
              })),
            };
      return wire.metadata === undefined
        ? { kind: 'file', mode: wire.m, ino: wire.i, size: wire.s, extents, holes: wire.h }
        : { kind: 'file', mode: wire.m, ino: wire.i, size: wire.s, extents, holes: wire.h, metadata: wire.metadata };
    }
    case 'd': {
      const entries = wire.e.map((entry) => ({
        name: entry.n,
        kind: entry.k,
        ref: { id: entry.r, sha256: entry.s, pack: wire.P[entry.p], offset: entry.o, length: entry.l },
      }));
      return wire.metadata === undefined
        ? { kind: 'dir', mode: wire.m, ino: wire.i, entries }
        : { kind: 'dir', mode: wire.m, ino: wire.i, entries, metadata: wire.metadata };
    }
    case 'l':
      return wire.metadata === undefined
        ? { kind: 'symlink', mode: wire.m, ino: wire.i, target: wire.g }
        : { kind: 'symlink', mode: wire.m, ino: wire.i, target: wire.g, metadata: wire.metadata };
    default:
      return { kind: 'page', extents: resolveExtents(wire.P, wire.c) };
  }
}
