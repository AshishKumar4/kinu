/**
 * The reader: open a committed root and read it back through digest-bearing
 * range intents. Every fetch — index object, node extent, payload chunk — is
 * issued as a validated RangeReadIntent whose sha256 names the exact expected
 * bytes, and the shared readCandidateRange path holds the transport to that
 * digest before the candidate verifies anything else.
 */

import * as v from 'valibot';

import { sha256Hex } from '../../cas/hash';
import { isCanonicalJournalPath } from '../../cas/types';
import type { CapturedCut, ImmutableObjectRef, RangeReadIntent } from '../../durability/contracts';
import type { PosixMetadata } from '../../capture/model';
import { candidateRangeRequest, readCandidateRange } from '../publication';
import type { PackIndex, PackLocation } from './build';
import { MerklePackError } from './errors';
import {
  IndexSchema,
  NodeSchema,
  RootManifestSchema,
  assertChildNames,
  hashNodeBytes,
  objectRef,
  rootKey,
} from './wire';
import type { MerklePackRoot } from './wire';

/** The transport seam. `readRange` receives a fully validated intent; an
 *  adapter maps it straight onto the signed payload path. */
export interface MerklePackReader {
  readRange(intent: RangeReadIntent): Promise<Uint8Array>;
}

/**
 * Identity stamped onto every range intent this view issues. Required: reads
 * are authenticated operations, not anonymous byte pulls.
 */
export interface RangeIdentity {
  readonly operationId: string;
  readonly attemptId: string;
  readonly boxId: string;
  readonly epoch: string;
  readonly expiresAt: string;
}

export interface StatInfo {
  readonly kind: 'file' | 'dir' | 'symlink';
  readonly mode: number;
  /** Logical size: file bytes, symlink target length, 0 for directories. */
  readonly size: number;
  /** Inode id; hardlinked files share it. */
  readonly ino?: number;
  /** Symlinks only: the verbatim target, never resolved. */
  readonly target?: string;
  /** POSIX ownership, timestamps, and xattrs captured with this node. */
  readonly metadata?: PosixMetadata;
}

export interface MerkleFileExtent {
  readonly kind: 'data' | 'hole';
  readonly offset: number;
  readonly length: number;
}

export interface MerklePackView extends PackIndex {
  readonly rootId: string;
  readonly rootObject: ImmutableObjectRef;
  readonly capturedCut: CapturedCut;
  referencedKeys(): ReadonlySet<string>;
  referencedObjects(): readonly ImmutableObjectRef[];
  stat(path: string): Promise<StatInfo | null>;
  readdir(path: string): Promise<readonly string[]>;
  extents(path: string): Promise<readonly MerkleFileExtent[]>;
  readRange(path: string, offset: number, length: number): Promise<Uint8Array>;
}
const KIND_OF = { f: 'file', d: 'dir', l: 'symlink' } as const;

type Node = v.InferOutput<typeof NodeSchema>;
function copyMetadata(metadata: {
  readonly uid: number;
  readonly gid: number;
  readonly atimeNs: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
  readonly xattrs: Readonly<Record<string, string>>;
} | undefined): PosixMetadata | undefined {
  if (metadata === undefined) return undefined;
  return Object.freeze({
    uid: metadata.uid,
    gid: metadata.gid,
    atimeNs: metadata.atimeNs,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs,
    xattrs: Object.freeze({ ...metadata.xattrs }),
  });
}



/** Fetch one located extent through a validated, digest-bearing intent. */
async function fetchExtent(
  reader: MerklePackReader,
  identity: RangeIdentity,
  loc: { key: string; offset: number; length: number; sha256: string },
): Promise<Uint8Array> {
  const intent = candidateRangeRequest({
    operationId: identity.operationId,
    attemptId: identity.attemptId,
    boxId: identity.boxId,
    epoch: identity.epoch,
    exactKey: loc.key,
    method: 'GET',
    byteOffset: String(loc.offset),
    byteLength: String(loc.length),
    sha256: loc.sha256,
    expiresAt: identity.expiresAt,
  });
  return readCandidateRange(intent, reader);
}

interface ChunkItem {
  readonly loc: PackLocation;
  readonly digest: string;
  readonly fileOff: number;
  readonly first: number;
  readonly count: number;
  readonly length: number;
}

function extentKeyOf(loc: PackLocation): string {
  return `${loc.key}@${loc.offset}+${loc.length}`;
}

function requireFileGeometry(node: Extract<Node, { t: 'f' }>, locations: ReadonlyMap<string, PackLocation>): void {
  let total = 0;
  for (const extent of node.c) {
    const loc = locations.get(extent.d);
    if (loc === undefined) {
      throw new MerklePackError('missing-digest', `no packed location for chunk ${extent.d}`);
    }
    if (loc.length !== extent.l) {
      throw new MerklePackError(
        'malformed-node',
        `chunk ${extent.d} declares ${extent.l} bytes but its packed location has ${loc.length}`,
      );
    }
    const span = extent.l * extent.n;
    if (!Number.isSafeInteger(span) || !Number.isSafeInteger(total + span)) {
      throw new MerklePackError('malformed-node', `file chunk geometry exceeds the safe integer range`);
    }
    total += span;
  }
  if (total !== node.s) {
    throw new MerklePackError(
      'malformed-node',
      `file declares ${node.s} bytes but its chunk extents resolve to ${total}`,
    );
  }
}

/**
 * Open a committed root against a reader. Verifies the manifest against its
 * own id, then fetches and verifies the pack index through a range intent.
 */
export async function openMerklePack(
  root: MerklePackRoot,
  reader: MerklePackReader,
  identity: RangeIdentity,
): Promise<MerklePackView> {
  if (sha256Hex(root.manifestBytes) !== root.rootId) {
    throw new MerklePackError('corrupt-root', `root manifest does not match its id ${root.rootId}`);
  }
  let manifest: v.InferOutput<typeof RootManifestSchema>;
  try {
    manifest = v.parse(RootManifestSchema, JSON.parse(new TextDecoder().decode(root.manifestBytes)));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new MerklePackError('corrupt-root', `root manifest did not decode: ${detail}`, { cause: error });
  }

  // The index arrives as data, so it goes through the same authenticated range
  // path as everything else: full span, expected plain digest from the root.
  const indexBytes = await fetchExtent(reader, identity, {
    key: manifest.index.key,
    offset: 0,
    length: Number(manifest.index.byteLength),
    sha256: manifest.index.sha256,
  });
  let decoded: v.InferOutput<typeof IndexSchema>;
  try {
    decoded = v.parse(IndexSchema, JSON.parse(new TextDecoder().decode(indexBytes)));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new MerklePackError('corrupt-index', `index did not decode: ${detail}`, { cause: error });
  }
  const locations = new Map<string, PackLocation>();
  for (const [digest, plainSha, key, offset, length] of decoded.e) {
    locations.set(digest, { key, offset, length, sha256: plainSha });
  }
  const referencedObjects = (): readonly ImmutableObjectRef[] => {
    const objects = new Map(decoded.p.map((ref) => [ref.key, ref]));
    if (objects.size !== decoded.p.length) {
      throw new MerklePackError('corrupt-index', 'index repeats a pack closure key');
    }
    for (const loc of locations.values()) {
      const pack = objects.get(loc.key);
      const end = loc.offset + loc.length;
      if (pack === undefined || !Number.isSafeInteger(end) || end > Number(pack.byteLength)) {
        throw new MerklePackError('corrupt-index', `index extent is outside its declared pack ${loc.key}`);
      }
    }
    objects.set(rootKey(root.rootId), objectRef(rootKey(root.rootId), root.manifestBytes));
    objects.set(manifest.index.key, {
      key: manifest.index.key,
      byteLength: manifest.index.byteLength,
      sha256: manifest.index.sha256,
    });
    return Object.freeze([...objects.values()]);
  };

  const nodeCache = new Map<string, Node>();
  const fetchNode = async (digest: string): Promise<Node> => {
    const cached = nodeCache.get(digest);
    if (cached !== undefined) return cached;

    const loc = locations.get(digest);
    if (loc === undefined) {
      throw new MerklePackError('missing-digest', `no packed location for node ${digest}`);
    }
    // The shared path already held the transport to the extent's plain sha;
    // the tagged hash re-derives the NODE identity from those same bytes.
    const bytes = await fetchExtent(reader, identity, loc);
    if (hashNodeBytes(bytes) !== digest) {
      throw new MerklePackError('node-digest-mismatch', `node ${digest} failed verification`);
    }
    let node: Node;
    try {
      node = v.parse(NodeSchema, JSON.parse(new TextDecoder().decode(bytes)));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new MerklePackError('malformed-node', `node ${digest} did not decode: ${detail}`, { cause: error });
    }
    if (node.t === 'd') assertChildNames(node);
    if (node.t === 'f') requireFileGeometry(node, locations);
    nodeCache.set(digest, node);
    return node;
  };

  const walk = async (path: string): Promise<Node | null> => {
    let node = await fetchNode(manifest.root);
    if (path === '') return node;
    if (!isCanonicalJournalPath(path)) {
      throw new MerklePackError('hostile-path', `refusing non-canonical path ${JSON.stringify(path)}`);
    }
    for (const name of path.split('/')) {
      if (node.t !== 'd') {
        throw new MerklePackError(
          node.t === 'l' ? 'symlink-traversal' : 'not-a-directory',
          `${name} under ${path} is not a directory`,
        );
      }
      const entry = node.e.find((e) => e.n === name);
      if (entry === undefined) return null;
      const child = await fetchNode(entry.r);
      if (KIND_OF[child.t] !== entry.k) {
        throw new MerklePackError(
          'malformed-node',
          `entry ${entry.n} claims kind ${entry.k}, node says ${KIND_OF[child.t]}`,
        );
      }
      node = child;
    }
    return node;
  };

  return {
    rootId: root.rootId,
    rootObject: objectRef(rootKey(root.rootId), root.manifestBytes),
    capturedCut: manifest.capturedCut,
    locate: (digest) => locations.get(digest),
    referencedKeys(): ReadonlySet<string> {
      const keys = new Set<string>([manifest.index.key, rootKey(root.rootId)]);
      for (const loc of locations.values()) keys.add(loc.key);
      return keys;
    },
    referencedObjects,
    async stat(path: string): Promise<StatInfo | null> {
      const node = await walk(path);
      if (node === null) return null;
      if (node.t === 'f') {
        return {
          kind: 'file',
          mode: node.m,
          size: node.s,
          ino: node.i,
          metadata: copyMetadata(node.metadata),
        };
      }
      if (node.t === 'l') {
        return {
          kind: 'symlink',
          mode: node.m,
          ino: node.i,
          size: new TextEncoder().encode(node.g).byteLength,
          target: node.g,
          metadata: copyMetadata(node.metadata),
        };
      }
      return { kind: 'dir', mode: node.m, ino: node.i, size: 0, metadata: copyMetadata(node.metadata) };
    },
    async readdir(path: string): Promise<readonly string[]> {
      const node = await walk(path);
      if (node === null) throw new MerklePackError('no-entry', `nothing at ${JSON.stringify(path)}`);
      if (node.t !== 'd') throw new MerklePackError('not-a-directory', `${JSON.stringify(path)} is not a directory`);
      return node.e.map((entry) => entry.n);
    },
    async extents(path: string): Promise<readonly MerkleFileExtent[]> {
      const node = await walk(path);
      if (node === null) throw new MerklePackError('no-entry', `nothing at ${JSON.stringify(path)}`);
      if (node.t !== 'f') {
        throw new MerklePackError('not-a-directory', `${JSON.stringify(path)} is not a regular file`);
      }
      requireFileGeometry(node, locations);
      const holes = [...node.h]
        .sort((a, b) => a.o - b.o)
        .map((hole) => ({ kind: 'hole' as const, offset: hole.o, length: hole.l }));
      const extents: MerkleFileExtent[] = [];
      let cursor = 0;
      for (const hole of holes) {
        if (hole.offset < cursor || hole.offset + hole.length > node.s) {
          throw new MerklePackError('malformed-node', `hole geometry for ${path} overlaps or exceeds file bounds`);
        }
        if (hole.offset > cursor) extents.push({ kind: 'data', offset: cursor, length: hole.offset - cursor });
        extents.push(hole);
        cursor = hole.offset + hole.length;
      }
      if (cursor < node.s) extents.push({ kind: 'data', offset: cursor, length: node.s - cursor });
      if (extents.reduce((sum, extent) => sum + extent.length, 0) !== node.s) {
        throw new MerklePackError('malformed-node', `extent geometry for ${path} does not cover its size`);
      }
      return Object.freeze(extents);
    },
    async readRange(path: string, offset: number, length: number): Promise<Uint8Array> {
      if (
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(length) ||
        offset < 0 ||
        length < 0 ||
        !Number.isSafeInteger(offset + length)
      ) {
        throw new MerklePackError('invalid-range', `readRange(${offset}, ${length}) is not a bounded span`);
      }
      const node = await walk(path);
      if (node === null) throw new MerklePackError('no-entry', `nothing at ${JSON.stringify(path)}`);
      if (node.t === 'd') throw new MerklePackError('is-a-directory', `${JSON.stringify(path)} is a directory`);
      if (node.t === 'l') {
        throw new MerklePackError(
          'symlink-refused',
          `${JSON.stringify(path)} is a symlink; readers never follow targets`,
        );
      }

      const end = Math.min(offset + length, node.s);
      if (length === 0 || offset >= node.s) return new Uint8Array(0);
      const out = new Uint8Array(end - offset);

      // One intent per distinct packed extent. A repeated sparse extent is
      // fetched once, then copied only for the requested logical repetitions.
      const items: ChunkItem[] = [];
      const extents = new Map<string, PackLocation>();
      let fileOff = 0;
      for (const extent of node.c) {
        const span = extent.l * extent.n;
        const extentEnd = fileOff + span;
        if (extentEnd > offset && fileOff < end) {
          const first = Math.floor((Math.max(offset, fileOff) - fileOff) / extent.l);
          const last = Math.ceil((Math.min(end, extentEnd) - fileOff) / extent.l);
          const loc = locations.get(extent.d)!;
          items.push({ loc, digest: extent.d, fileOff, first, count: last - first, length: extent.l });
          extents.set(extentKeyOf(loc), loc);
        }
        fileOff = extentEnd;
        if (fileOff >= end) break;
      }

      const buffers = new Map<string, Uint8Array>();
      for (const [key, loc] of extents) {
        buffers.set(key, await fetchExtent(reader, identity, loc));
      }

      for (const item of items) {
        const buffer = buffers.get(extentKeyOf(item.loc))!;
        if (sha256Hex(buffer) !== item.digest) {
          throw new MerklePackError('chunk-digest-mismatch', `chunk ${item.digest} failed verification`);
        }
        for (let occurrence = item.first; occurrence < item.first + item.count; occurrence++) {
          const chunkOff = item.fileOff + occurrence * item.length;
          let src = 0;
          let dst = chunkOff - offset;
          let take = item.length;
          if (dst < 0) {
            src = -dst;
            take -= src;
            dst = 0;
          }
          if (dst + take > out.byteLength) take = out.byteLength - dst;
          if (take > 0) out.set(buffer.subarray(src, src + take), dst);
        }
      }
      return out;
    },
  };
}
