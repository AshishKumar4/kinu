/**
 * The merkle-pack wire vocabulary: canonical serialization, digest derivation,
 * object-key layout, and the schemas every decoded byte must pass. Nodes hash
 * under a domain tag so a node digest never collides with a chunk digest of
 * coincidentally equal bytes; the index additionally records each extent's
 * PLAIN SHA-256, because range-read intents authenticate plain bytes.
 */

import { createHash } from 'node:crypto';
import * as v from 'valibot';

import { sha256Hex } from '../../cas/hash';
import type { ImmutableObjectRef } from '../../durability/contracts';
import { CapturedCutSchema, ImmutableObjectRefSchema } from '../../durability/contracts';

import { MerklePackError } from './errors';

export const MERKLE_PACK_FORMAT = 'merkle-pack/v1';

const NODE_HASH_TAG = 'merkle-pack/v1\nnode\n';
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

function hashNode(serialized: Uint8Array): string {
  return createHash('sha256').update(NODE_HASH_TAG).update(serialized).digest('hex');
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

/** Directory entry names decode from untrusted bytes; re-assert canonicality. */
export function assertChildNames(node: { e: ReadonlyArray<{ n: string }> }): void {
  for (const entry of node.e) {
    const name = entry.n;
    if (
      name.includes('/') ||
      name.includes('\0') ||
      name === '.' ||
      name === '..' ||
      name.length === 0 ||
      utf8.encode(name).byteLength > 255
    ) {
      throw new MerklePackError('malformed-node', `directory entry name ${JSON.stringify(name)} is not canonical`);
    }
  }
}
