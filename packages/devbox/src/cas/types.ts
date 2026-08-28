/**
 * Content-addressed overlay layout.
 *
 * Remote keys, and the write order that makes a crash safe:
 *
 *   blobs/<hh>/<sha256>   chunk bytes; content-addressed, so a re-PUT is a no-op
 *   journal/<12-seq>.json ONE BATCH of changed-path entries, keyed by the
 *                         batch's last seq; bytes never inline
 *   tree/<path>           materialized files: this prefix is the read-only lower
 *   meta/manifest.jsonl   POSIX metadata for the tree, kept out of the mount
 *   cursor.json           the seq through which the tree has been folded
 *
 * A BATCH, not an entry, is the unit of every one of those objects. A tick over
 * an npm-shaped tree touches thousands of paths, and one journal object per
 * path would make the journal cost proportional to the changed-path COUNT
 * rather than to the bytes that changed — which is the efficiency this layout
 * exists to deliver.
 *
 * Every blob in a batch is durable before that batch's ONE journal object. A
 * journal object is durable before the fold that consumes it. The fold finishes
 * before the cursor advances, and the cursor advances before the folded objects
 * are reaped. The cursor only ever moves past WHOLE batches, so a half-folded
 * batch cannot be represented. Each step is idempotent, so a crash repeats at
 * most one batch and no reader ever sees an entry whose bytes are absent.
 */
import * as v from 'valibot';

export const CAS_FORMAT_VERSION = 2;

export type Sha256Hex = string;
export type FileDataPart = {
  kind: 'data';
  hash: Sha256Hex;
  size: number;
};
export type FileHolePart = {
  kind: 'hole';
  size: number;
};
export type FilePart = FileDataPart | FileHolePart;

export type FileEntry = {
  kind: 'file';
  seq: number;
  path: string;
  mode: number;
  mtimeMs: number;
  size: number;
  hash: Sha256Hex;
  parts: readonly FilePart[];
};

export type DirEntry = {
  kind: 'dir';
  seq: number;
  path: string;
  mode: number;
  mtimeMs: number;
  /** The directory replaced a lower one, so lower children must not show through. */
    opaque: boolean;
};

export type SymlinkEntry = {
  kind: 'symlink';
  seq: number;
  path: string;
  target: string;
  mode: number;
    mtimeMs: number;
};

export type HardlinkEntry = {
  kind: 'hardlink';
  seq: number;
  path: string;
  target: string;
  mode: number;
  mtimeMs: number;
};

/** A tombstone. Survives replay as an upper-layer whiteout and a fold as a delete. */
export type DeleteEntry = {
  kind: 'delete';
  seq: number;
    path: string;
};

export type JournalEntry = FileEntry | DirEntry | SymlinkEntry | HardlinkEntry | DeleteEntry;
export type PresentEntry = FileEntry | DirEntry | SymlinkEntry | HardlinkEntry;

/**
 * Distributive on purpose: a bare `Omit` over a union collapses to the keys its
 * members share, which would erase `target`, `mode` and `hash`.
 */
export type Unstamped<T> = T extends unknown ? Omit<T, 'seq'> : never;
export type NewJournalEntry = Unstamped<JournalEntry>;

// ── the stored rows, as schemas ─────────────────────────────────────────────
//
// A journal object, the manifest and the cursor are all read back from the
// store, so each has a schema and every reader goes through decodeJson. The
// hash fields are length-checked: a truncated string must not name a blob.

const SeqSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const HashSchema = v.pipe(
  v.string(),
  v.regex(/^[0-9a-f]{64}$/, 'Expected a lowercase SHA-256 digest'),
);

// Same POSIX limits as NAME_MAX_BYTES and PATH_MAX_BYTES in
// packages/cli/src/attachments.ts. Devbox stays independent of the CLI.
const MAX_JOURNAL_PATH_BYTES = 4_095;
const MAX_JOURNAL_PATH_COMPONENT_BYTES = 255;
const journalPathEncoder = new TextEncoder();

/** A journal path is a canonical relative POSIX path, never a host path. */
export function isCanonicalJournalPath(path: string): boolean {
  if (path.length === 0 || path.startsWith('/') || path.includes('\0')) return false;
  if (journalPathEncoder.encode(path).byteLength > MAX_JOURNAL_PATH_BYTES) return false;
  for (const component of path.split('/')) {
    if (component.length === 0 || component === '.' || component === '..') return false;
    if (journalPathEncoder.encode(component).byteLength > MAX_JOURNAL_PATH_COMPONENT_BYTES) return false;
  }
  return true;
}

const PathSchema = v.pipe(
  v.string(),
  v.check(isCanonicalJournalPath, 'Expected a canonical relative journal path'),
);
const PartSizeSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const DataPartSchema = v.object({
  kind: v.literal('data'),
  hash: HashSchema,
  size: PartSizeSchema,
});
const HolePartSchema = v.object({
  kind: v.literal('hole'),
  size: PartSizeSchema,
});
const FilePartSchema = v.union([DataPartSchema, HolePartSchema]);

export const FileEntrySchema = v.object({
  kind: v.literal('file'),
  seq: SeqSchema,
  path: PathSchema,
  mode: v.number(),
  mtimeMs: v.number(),
  /** A FILE's size. Zero is ordinary: an empty file is a real file. */
  size: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  hash: HashSchema,
  parts: v.array(FilePartSchema),
});
export const DirEntrySchema = v.object({
  kind: v.literal('dir'),
  seq: SeqSchema,
  path: PathSchema,
  mode: v.number(),
  mtimeMs: v.number(),
  opaque: v.boolean(),
});
export const SymlinkEntrySchema = v.object({
  kind: v.literal('symlink'),
  seq: SeqSchema,
  path: PathSchema,
  target: v.string(),
  mode: v.number(),
  mtimeMs: v.number(),
});
export const HardlinkEntrySchema = v.object({
  kind: v.literal('hardlink'),
  seq: SeqSchema,
  path: PathSchema,
  target: PathSchema,
  mode: v.number(),
  mtimeMs: v.number(),
});
export const DeleteEntrySchema = v.object({
  kind: v.literal('delete'),
  seq: SeqSchema,
  path: PathSchema,
});
export const PresentEntrySchema = v.union([
  FileEntrySchema, DirEntrySchema, SymlinkEntrySchema, HardlinkEntrySchema,
]);
export const JournalEntrySchema = v.union([
  FileEntrySchema, DirEntrySchema, SymlinkEntrySchema, HardlinkEntrySchema, DeleteEntrySchema,
]);
export const ManifestSchema = v.strictObject({
  version: v.literal(CAS_FORMAT_VERSION),
  entries: v.array(PresentEntrySchema),
});
export const JournalBatchSchema = v.strictObject({
  version: v.literal(CAS_FORMAT_VERSION),
  entries: v.array(JournalEntrySchema),
});

/** The cursor. `foldedSeq` is REQUIRED: `advanceCursor` has always written it,
 *  so a cursor object without it was not written by this code. */
export const CursorSchema = v.strictObject({
  version: v.literal(CAS_FORMAT_VERSION),
  foldedSeq: SeqSchema,
});
export interface StoreCounters {
  putCalls: number;
  getCalls: number;
  headCalls: number;
  deleteCalls: number;
  listCalls: number;
  bytesPut: number;
  bytesGot: number;
}

export function emptyCounters(): StoreCounters {
  return {
    putCalls: 0,
    getCalls: 0,
    headCalls: 0,
    deleteCalls: 0,
    listCalls: 0,
    bytesPut: 0,
    bytesGot: 0,
  };
}

export function counterDelta(before: StoreCounters, after: StoreCounters): StoreCounters {
  return {
    putCalls: after.putCalls - before.putCalls,
    getCalls: after.getCalls - before.getCalls,
    headCalls: after.headCalls - before.headCalls,
    deleteCalls: after.deleteCalls - before.deleteCalls,
    listCalls: after.listCalls - before.listCalls,
    bytesPut: after.bytesPut - before.bytesPut,
    bytesGot: after.bytesGot - before.bytesGot,
  };
}

export interface CasPutMeta {
  /** Decimal `st_mode` (file-type bits OR permission bits). s3fs reads this
   *  as `x-amz-meta-mode` when the same object is later mounted as the lower. */
  readonly mode: number;
  readonly mtimeMs?: number;
  /** When true the body is a symlink target, not file bytes. */
  readonly symlink?: boolean;
}

/**
 * The object-store seam the CAS helpers talk to. Relative keys, never a box
 * prefix: the adapter prepends `boxes/<id>/`. A PUT is complete or absent.
 */
export interface CasStore {
  readonly counters: StoreCounters;
  put(key: string, bytes: Uint8Array, meta?: CasPutMeta): Promise<void>;
  putStream(
    key: string,
    stream: ReadableStream<Uint8Array>,
    size: number,
    meta?: CasPutMeta,
  ): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  head(key: string): Promise<{ size: number } | null>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

export const KEY_CURSOR = 'cursor.json';
export const PREFIX_BLOBS = 'blobs/';
export const PREFIX_JOURNAL = 'journal/';
export const PREFIX_TREE = 'tree/';
export const KEY_MANIFEST = 'meta/manifest.jsonl';


export function blobKey(hash: Sha256Hex): string {
  return `${PREFIX_BLOBS}${hash.slice(0, 2)}/${hash}`;
}

/** Fixed width keeps lexicographic order equal to numeric order for `list`. */
export function journalKey(seq: number): string {
  return `${PREFIX_JOURNAL}${String(seq).padStart(12, '0')}.json`;
}

export function seqFromJournalKey(key: string): number | null {
  if (!key.startsWith(PREFIX_JOURNAL) || !key.endsWith('.json')) return null;
  const seq = Number(key.slice(PREFIX_JOURNAL.length, -'.json'.length));
  return Number.isSafeInteger(seq) && seq >= 0 ? seq : null;
}

export function treeKey(path: string): string {
  return `${PREFIX_TREE}${path}`;
}

/**
 * Serialize a value for the store, newline-terminated.
 *
 * The other half of {@link decodeJson}, and it lives beside it so the round
 * trip is one thing a reader can check in one place. The trailing newline
 * makes an object readable with a line-oriented tool without changing what
 * `JSON.parse` sees.
 */
/**
 * Anything `JSON.stringify` can serialize without surprise. Local rather than
 * imported because the package's independence rule forbids reaching into the
 * product's core, and the shape is four lines.
 *
 * A member may be `undefined` because an optional field is how these rows
 * spell "absent" and `JSON.stringify` drops it; the top level may not, because
 * `JSON.stringify(undefined)` is not JSON at all.
 */
type JsonValue = string | number | boolean | null | undefined
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JsonSerializable = readonly JsonValue[] | { readonly [key: string]: JsonValue };

export function encodeJson(value: JsonSerializable): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value)}\n`);
}

/**
 * Parse stored bytes as JSON, refusing anything else.
 *
 * A journal object, a manifest and the cursor are all durable rows: they were
 * written by some release of this code, and a reader that trusts their shape
 * is one truncated write away from flowing garbage onward. A bare `JSON.parse
 * as T` is exactly that trust. Callers hand this a valibot schema, so a
 * valid-JSON-wrong-shape row refuses HERE, naming the key it came from,
 * instead of surfacing later as an entry whose fields are undefined.
 *
 * The throw is deliberate. Loud at the boundary beats silent downstream.
 */
export function decodeJson<T>(
  schema: v.GenericSchema<unknown, T>,
  key: string,
  bytes: Uint8Array,
): T {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch (cause) {
    throw new Error(`${key} is not valid JSON`, { cause });
  }
  const parsed = v.safeParse(schema, raw);
  if (!parsed.success) {
    const first = parsed.issues[0];
    const where = first === undefined ? '' : ` at ${first.path?.map(p => String(p.key)).join('.') ?? 'root'}`;
    throw new Error(`${key} does not match its schema${where}: ${first?.message ?? 'refused'}`);
  }
  return parsed.output;
}
