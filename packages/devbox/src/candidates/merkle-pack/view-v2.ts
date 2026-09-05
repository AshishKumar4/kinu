/**
 * Reading a merkle-pack/v2 head: no index, no closure, one record at a time.
 *
 * WHAT REPLACED THE INDEX. A v1 generation published one global object listing
 * every reachable chunk, so opening a head cost that object (O(n) bytes, and a
 * 4 MiB cap that capped the tree with it) before a single byte could be read.
 * A v2 record carries the pack, offset and length of everything it points at,
 * so a walk from the root resolves each step from the record it just read: an
 * attach is the envelope plus the root record, and a miss is one range read of
 * the pack region that holds what was missed.
 *
 * WHAT AUTHENTICATES A READ. Every single-record fetch goes through the shared
 * digest-bearing intent path, so the transport is held to the plain digest the
 * parent record named before anything decodes. A coalesced run — several
 * file-adjacent chunks that are offset-contiguous inside one pack, fetched as
 * one range — is authenticated the same way but per record: each chunk's bytes
 * are held to that chunk's own digest, and bytes outside the chunks a caller
 * asked for are never used.
 */

import { sha256Hex } from '../../cas/hash';
import { isCanonicalJournalPath } from '../../cas/types';
import type { HydrateWork, ObjectRangeRef } from '../../durability/contracts';
import { candidateRangeRequest, readCandidateRange } from '../publication';

import { MerklePackError } from './errors';
import { coalescePackRuns } from './read';
import type { MerkleFileExtent, MerklePackReader, PackRun, RangeIdentity, StatInfo } from './read';
import { fileBoundaries } from './delta';
import { SELF_PACK, decodeNodeV2, hashNodeV2Bytes } from './wire';
import type { ExtentV2, NodeV2, RecordRefV2 } from './wire';

/** One pack whose whole body a caller already knows the length and digest of —
 *  the ledger's row for it. A view opened with these may fetch a pack once,
 *  whole, and slice every record and chunk out of the one fetch. */
export interface KnownPack {
  readonly byteLength: number;
  readonly sha256: string;
}

export interface OpenMerkleV2Options {
  /**
   * THE LEDGER'S PACKS. A walk that will read most of a tree — a materialize —
   * would otherwise pay one range read per record and per chunk, which is one
   * remote operation per file. Named here, a pack is fetched once, whole, held
   * to the digest the ledger states, and sliced for everything inside it; an
   * anonymous pack keeps the one-range-at-a-time behavior a lazy miss wants.
   */
  readonly wholePacks?: ReadonlyMap<string, KnownPack>;
}

export type FileNodeV2 = Extract<NodeV2, { readonly kind: 'file' }>;

/** One resolved record: where its bytes are, and what they decode to. */
export interface RecordV2 {
  readonly ref: RecordRefV2;
  readonly node: NodeV2;
}

export interface MerkleV2View {
  readonly rootRef: RecordRefV2;
  /** The record a path names, or null when the tree does not hold it. */
  record(path: string): Promise<RecordV2 | null>;
  stat(path: string): Promise<StatInfo | null>;
  readdir(path: string): Promise<readonly string[]>;
  /** The data/hole geometry a restore writes, in file order. */
  extents(path: string): Promise<readonly MerkleFileExtent[]>;
  /** The packed extent list of one file, extent pages resolved. */
  fileExtents(path: string): Promise<readonly ExtentV2[]>;
  /** The chunk boundaries the next incremental seal resumes from. */
  boundaries(path: string): Promise<readonly number[]>;
  readRange(path: string, offset: number, length: number): Promise<Uint8Array>;
  /** One chunk's exact bytes, held to its own digest: what compaction moves. */
  chunkBytes(extent: ExtentV2): Promise<Uint8Array>;
  /** What reading this view has cost so far, in the contract's own row. */
  work(): HydrateWork;
}

/** Resolve `SELF_PACK` against the pack the record itself was read from. */
function inPack(pack: string, home: string): string {
  return pack === SELF_PACK ? home : pack;
}

function resolveExtent(extent: ExtentV2, home: string): ExtentV2 {
  return extent.pack === SELF_PACK ? { ...extent, pack: home } : extent;
}

function resolveRecord(node: NodeV2, home: string): NodeV2 {
  switch (node.kind) {
    case 'file':
      return node.extents.kind === 'inline'
        ? { ...node, extents: { kind: 'inline', extents: node.extents.extents.map((extent) => resolveExtent(extent, home)) } }
        : {
            ...node,
            extents: {
              kind: 'paged',
              pages: node.extents.pages.map((page) => ({ ...page, pack: inPack(page.pack, home) })),
            },
          };
    case 'dir':
      return {
        ...node,
        entries: node.entries.map((entry) => ({
          ...entry,
          ref: { ...entry.ref, pack: inPack(entry.ref.pack, home) },
        })),
      };
    case 'page':
      return { kind: 'page', extents: node.extents.map((extent) => resolveExtent(extent, home)) };
    default:
      return node;
  }
}


/** The runs a file's extents coalesce into: the shared rule, over v2's
 *  extents, which name their pack as `pack`. */
function coalesce(extents: readonly ExtentV2[]): PackRun[] {
  return coalescePackRuns(extents.map((extent) => ({ key: extent.pack, offset: extent.offset, length: extent.length })));
}

/**
 * A cached fetch that failed is evicted and its failure rethrown: the promise
 * cache holds successes, and a dropped transport is not a fact. The handler
 * never inspects the failure, so it takes the thrown value whole.
 */
function evict<K>(cache: Map<K, Promise<unknown>>, key: K): (failure: Error) => never {
  return (failure) => {
    cache.delete(key);
    throw failure;
  };
}

/**
 * Open a v2 head at the root record the envelope names. Nothing else is read:
 * an attach is this call, and every later miss is a record fetch from here.
 */
export async function openMerkleV2(
  root: ObjectRangeRef,
  reader: MerklePackReader,
  identity: RangeIdentity,
  options: OpenMerkleV2Options = {},
): Promise<MerkleV2View> {
  let rangeGets = 0;
  let bytesFetched = 0;
  let bytesRequested = 0;
  const wholePacks = options.wholePacks;
  const packBodies = new Map<string, Promise<Uint8Array>>();

  /**
   * One pack, fetched whole and sliced for everything inside it. The digest the
   * ledger states for it holds every record and chunk a slice serves, so the
   * range checks below still verify what they hand out.
   */
  const wholePack = (key: string): Promise<Uint8Array> | null => {
    const known = wholePacks?.get(key);
    if (known === undefined) return null;
    const held = packBodies.get(key);
    if (held !== undefined) return held;
    const loading = (async () => {
      rangeGets += 1;
      bytesFetched += known.byteLength;
      const bytes = await reader.readRange({
        operationId: identity.operationId,
        attemptId: identity.attemptId,
        boxId: identity.boxId,
        epoch: identity.epoch,
        exactKey: key,
        method: 'GET',
        byteOffset: '0',
        byteLength: String(known.byteLength),
        sha256: known.sha256,
        expiresAt: identity.expiresAt,
      });
      if (sha256Hex(bytes) !== known.sha256) {
        throw new MerklePackError(
          'chunk-digest-mismatch',
          `whole-pack read of ${key} failed verification against the ledger`,
        );
      }
      return bytes;
    })().catch(evict(packBodies, key));
    packBodies.set(key, loading);
    return loading;
  };

  const fetchRange = async (
    location: { key: string; offset: number; length: number; sha256: string },
  ): Promise<Uint8Array> => {
    const whole = wholePack(location.key);
    if (whole !== null) {
      const packBytes = await whole;
      const slice = packBytes.subarray(location.offset, location.offset + location.length);
      if (sha256Hex(slice) !== location.sha256) {
        throw new MerklePackError(
          'chunk-digest-mismatch',
          `range ${location.offset}+${location.length} of ${location.key} failed verification`,
        );
      }
      return slice;
    }
    const intent = candidateRangeRequest({
      operationId: identity.operationId,
      attemptId: identity.attemptId,
      boxId: identity.boxId,
      epoch: identity.epoch,
      exactKey: location.key,
      method: 'GET',
      byteOffset: String(location.offset),
      byteLength: String(location.length),
      sha256: location.sha256,
      expiresAt: identity.expiresAt,
    });
    rangeGets += 1;
    bytesFetched += location.length;
    bytesRequested += location.length;
    return await readCandidateRange(intent, reader);
  };
  /** A coalesced run through the transport, held to length, or sliced whole
   *  from a pack this view already holds. */
  const fetchRun = async (run: PackRun): Promise<Uint8Array> => {
    const whole = wholePack(run.key);
    if (whole !== null) {
      const packBytes = await whole;
      const slice = packBytes.subarray(run.offset, run.offset + run.length);
      bytesRequested += run.length;
      return slice;
    }
    rangeGets += 1;
    bytesFetched += run.length;
    bytesRequested += run.length;
    const bytes = await reader.readRun(run);
    if (bytes.byteLength !== run.length) {
      throw new MerklePackError(
        'invalid-range',
        `run read of ${run.key} returned ${bytes.byteLength} bytes, expected ${run.length}`,
      );
    }
    return bytes;
  };


  const records = new Map<string, Promise<RecordV2>>();
  /**
   * A kernel inode number belongs to one restored filesystem. Fresh and reused
   * records can carry the same number, while hardlinked names share one record.
   */
  const materializedInodes = new Map<RecordV2, number>();
  let nextMaterializedInode = 1;
  const materializedInodeOf = (record: RecordV2): number => {
    const held = materializedInodes.get(record);
    if (held !== undefined) return held;
    const assigned = nextMaterializedInode;
    nextMaterializedInode += 1;
    materializedInodes.set(record, assigned);
    return assigned;
  };
  const loadRecord = async (ref: RecordRefV2): Promise<RecordV2> => {
    const bytes = await fetchRange({ key: ref.pack, offset: ref.offset, length: ref.length, sha256: ref.sha256 });
    if (hashNodeV2Bytes(bytes) !== ref.id) {
      throw new MerklePackError('node-digest-mismatch', `v2 record ${ref.id} failed verification`);
    }
    return { ref, node: resolveRecord(decodeNodeV2(bytes), ref.pack) };
  };
  const record = (ref: RecordRefV2): Promise<RecordV2> => {
    const key = `${ref.pack}@${ref.offset}+${ref.length}`;
    const held = records.get(key);
    if (held !== undefined) return held;
    // The PROMISE is cached, so a parallel walk that asks twice fetches once;
    // a failure is evicted, because a dropped transport is not a fact.
    const loading = loadRecord(ref).catch(evict(records, key));
    records.set(key, loading);
    return loading;
  };

  const rootRef: RecordRefV2 = {
    id: '',
    sha256: root.sha256,
    pack: root.key,
    offset: Number(root.byteOffset),
    length: Number(root.byteLength),
  };
  const rootBytes = await fetchRange({
    key: rootRef.pack,
    offset: rootRef.offset,
    length: rootRef.length,
    sha256: rootRef.sha256,
  });
  const rootId = hashNodeV2Bytes(rootBytes);
  const rootRecord: RecordV2 = { ref: { ...rootRef, id: rootId }, node: resolveRecord(decodeNodeV2(rootBytes), rootRef.pack) };
  if (rootRecord.node.kind !== 'dir') {
    throw new MerklePackError('corrupt-root', 'a v2 head root record is not a directory');
  }
  records.set(`${rootRef.pack}@${rootRef.offset}+${rootRef.length}`, Promise.resolve(rootRecord));

  const walk = async (path: string): Promise<RecordV2 | null> => {
    if (path === '') return rootRecord;
    if (!isCanonicalJournalPath(path)) {
      throw new MerklePackError('hostile-path', `refusing non-canonical path ${JSON.stringify(path)}`);
    }
    let held: RecordV2 = rootRecord;
    for (const name of path.split('/')) {
      if (held.node.kind !== 'dir') {
        throw new MerklePackError(
          held.node.kind === 'symlink' ? 'symlink-traversal' : 'not-a-directory',
          `${name} under ${path} is not a directory`,
        );
      }
      const entry = held.node.entries.find((child) => child.name === name);
      if (entry === undefined) return null;
      const child = await record(entry.ref);
      if (child.node.kind !== entry.kind) {
        throw new MerklePackError(
          'malformed-node',
          `entry ${entry.name} claims kind ${entry.kind}, its record is a ${child.node.kind}`,
        );
      }
      held = child;
    }
    return held;
  };

  const fileAt = async (path: string): Promise<FileNodeV2> => {
    const held = await walk(path);
    if (held === null) throw new MerklePackError('no-entry', `nothing at ${JSON.stringify(path)}`);
    if (held.node.kind === 'dir') throw new MerklePackError('is-a-directory', `${JSON.stringify(path)} is a directory`);
    if (held.node.kind !== 'file') {
      throw new MerklePackError('symlink-refused', `${JSON.stringify(path)} is not a regular file`);
    }
    return held.node;
  };

  const flatExtents = async (node: FileNodeV2): Promise<readonly ExtentV2[]> => {
    if (node.extents.kind === 'inline') return node.extents.extents;
    const pages: ExtentV2[] = [];
    for (const page of node.extents.pages) {
      const loaded = await record(page);
      if (loaded.node.kind !== 'page') {
        throw new MerklePackError('malformed-node', `extent page ${page.id} is a ${loaded.node.kind}`);
      }
      if (loaded.node.extents.length !== page.extents) {
        throw new MerklePackError(
          'malformed-node',
          `extent page ${page.id} holds ${loaded.node.extents.length} extents, its ref declares ${page.extents}`,
        );
      }
      pages.push(...loaded.node.extents);
    }
    return pages;
  };

  const geometry = (node: FileNodeV2): readonly MerkleFileExtent[] => {
    const out: MerkleFileExtent[] = [];
    let cursor = 0;
    for (const hole of [...node.holes].sort((a, b) => a.o - b.o)) {
      if (hole.o < cursor || hole.o + hole.l > node.size) {
        throw new MerklePackError('malformed-node', 'v2 hole geometry overlaps or exceeds the file');
      }
      if (hole.o > cursor) out.push({ kind: 'data', offset: cursor, length: hole.o - cursor });
      out.push({ kind: 'hole', offset: hole.o, length: hole.l });
      cursor = hole.o + hole.l;
    }
    if (cursor < node.size) out.push({ kind: 'data', offset: cursor, length: node.size - cursor });
    return Object.freeze(out);
  };

  return {
    rootRef: rootRecord.ref,
    record: walk,
    async stat(path: string): Promise<StatInfo | null> {
      const held = await walk(path);
      if (held === null) return null;
      const node = held.node;
      if (node.kind === 'file') {
        return { kind: 'file', mode: node.mode, size: node.size, ino: materializedInodeOf(held), metadata: node.metadata };
      }
      if (node.kind === 'symlink') {
        return {
          kind: 'symlink',
          mode: node.mode,
          ino: materializedInodeOf(held),
          size: new TextEncoder().encode(node.target).byteLength,
          target: node.target,
          metadata: node.metadata,
        };
      }
      if (node.kind === 'dir') {
        return { kind: 'dir', mode: node.mode, ino: materializedInodeOf(held), size: 0, metadata: node.metadata };
      }
      throw new MerklePackError('malformed-node', `${JSON.stringify(path)} resolves to an extent page`);
    },
    async readdir(path: string): Promise<readonly string[]> {
      const held = await walk(path);
      if (held === null) throw new MerklePackError('no-entry', `nothing at ${JSON.stringify(path)}`);
      if (held.node.kind !== 'dir') {
        throw new MerklePackError('not-a-directory', `${JSON.stringify(path)} is not a directory`);
      }
      return held.node.entries.map((entry) => entry.name);
    },
    async extents(path: string): Promise<readonly MerkleFileExtent[]> {
      return geometry(await fileAt(path));
    },
    async fileExtents(path: string): Promise<readonly ExtentV2[]> {
      return await flatExtents(await fileAt(path));
    },
    async boundaries(path: string): Promise<readonly number[]> {
      return fileBoundaries(await flatExtents(await fileAt(path)));
    },
    async readRange(path: string, offset: number, length: number): Promise<Uint8Array> {
      if (
        !Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
        || offset < 0 || length < 0 || !Number.isSafeInteger(offset + length)
      ) {
        throw new MerklePackError('invalid-range', `readRange(${offset}, ${length}) is not a bounded span`);
      }
      const node = await fileAt(path);
      const end = Math.min(offset + length, node.size);
      if (length === 0 || offset >= node.size) return new Uint8Array(0);
      bytesRequested += end - offset;
      const out = new Uint8Array(end - offset);
      const extents = await flatExtents(node);

      // Which chunk occurrences the window touches, and where each lands. A
      // repeated extent (a hole run) is fetched once and copied per occurrence.
      const wanted: { extent: ExtentV2; first: number; last: number; at: number }[] = [];
      let fileOffset = 0;
      for (const extent of extents) {
        const span = extent.length * extent.count;
        if (fileOffset + span > offset && fileOffset < end) {
          const first = Math.floor((Math.max(offset, fileOffset) - fileOffset) / extent.length);
          const last = Math.ceil((Math.min(end, fileOffset + span) - fileOffset) / extent.length);
          wanted.push({ extent, first, last, at: fileOffset });
        }
        fileOffset += span;
        if (fileOffset >= end) break;
      }

      const chunks = new Map<string, Uint8Array>();
      if (wanted.length > 1) {
        for (const run of coalesce(wanted.map((item) => item.extent))) {
          const bytes = await fetchRun(run);
          for (const item of wanted) {
            const extent = item.extent;
            if (extent.pack !== run.key) continue;
            if (extent.offset < run.offset || extent.offset + extent.length > run.offset + run.length) continue;
            const slice = bytes.subarray(extent.offset - run.offset, extent.offset - run.offset + extent.length);
            if (sha256Hex(slice) !== extent.digest) {
              throw new MerklePackError('chunk-digest-mismatch', `chunk ${extent.digest} failed verification`);
            }
            chunks.set(extent.digest, slice);
          }
        }
      } else {
        for (const item of wanted) {
          if (chunks.has(item.extent.digest)) continue;
          chunks.set(item.extent.digest, await fetchRange({
            key: item.extent.pack,
            offset: item.extent.offset,
            length: item.extent.length,
            sha256: item.extent.digest,
          }));
        }
      }

      for (const item of wanted) {
        const bytes = chunks.get(item.extent.digest);
        if (bytes === undefined) {
          throw new MerklePackError('missing-digest', `chunk ${item.extent.digest} was not fetched`);
        }
        for (let occurrence = item.first; occurrence < item.last; occurrence += 1) {
          const chunkOffset = item.at + occurrence * item.extent.length;
          let from = 0;
          if (chunkOffset < offset) from = offset - chunkOffset;
          const until = Math.min(extentSpanOf(item.extent, chunkOffset), end - chunkOffset);
          const span = until - from;
          if (span <= 0) continue;
          out.set(bytes.subarray(from, from + span), chunkOffset - offset);
        }
      }
      return out;
    },
    async chunkBytes(extent: ExtentV2): Promise<Uint8Array> {
      return await fetchRange({ key: extent.pack, offset: extent.offset, length: extent.length, sha256: extent.digest });
    },
    work(): HydrateWork {
      return { rangeGets, bytesFetched, bytesRequested };
    },
  };
}


/** The absolute offset one occurrence of an extent ends at. */
function extentSpanOf(extent: ExtentV2, start: number): number {
  return Math.min(start + extent.length, Number.MAX_SAFE_INTEGER);
}