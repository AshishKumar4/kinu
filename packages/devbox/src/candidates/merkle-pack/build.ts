/**
 * The builder: an AuditedCapture becomes a CandidatePublicationPlan whose
 * dependencies are immutable packs plus the pack index, and whose root object
 * is the canonical root manifest.
 *
 * Determinism: paths sort before anything reads them, hardlink groups collapse
 * to one inode node headed by the lexicographically-first member path (so
 * representation differences inside a group cannot leak into chunking), chunk
 * boundaries depend only on bytes, records lay out in traversal order, and
 * every serialization is canonical. Two permutations of one state produce
 * byte-identical output.
 */

import * as v from 'valibot';

import { sha256Hex } from '../../cas/hash';
import { isCanonicalJournalPath } from '../../cas/types';
import { contentEquals, contentSize, requireAuditedCapture } from '../../capture/model';
import type { AuditedCapture, NodeEntry, PosixMetadata } from '../../capture/model';
import type { ImmutableObjectRef } from '../../durability/contracts';
import { planCandidatePublication, publishedParentInfo } from '../publication';
import type { CandidateObjectSink, CandidatePublicationPlan, PublishedParent, StagedCandidateObject } from '../publication';

import type { MerklePackView } from './read';
import type { ChunkParams, EmittedChunk } from './chunk';
import { DEFAULT_CHUNK_PARAMS, chunkCaptureContent, paintedSegments, validateChunkParams } from './chunk';
import { MerklePackError } from './errors';
import type { DirEntryJson, FileExtentJson, HoleExtentJson, MerklePackRoot, NodeJson, PosixMetadataJson } from './wire';
import { NodeSchema } from './wire';
import {
  MERKLE_PACK_FORMAT,
  hashNodeBytes,
  indexKey,
  packKey,
  rootKey,
  serializeNode,
} from './wire';

const MAX_SYMLINK_TARGET_BYTES = 4096;
const utf8 = new TextEncoder();

// ── options ───────────────────────────────────────────────────────────────────

export interface PublishedMerkleParent {
  readonly view: MerklePackView;
  readonly headRootId: string;
  readonly reachable: readonly ImmutableObjectRef[];
}

const publishedParents = new WeakSet<PublishedMerkleParent>();

function refsMatch(a: ImmutableObjectRef, b: ImmutableObjectRef): boolean {
  return a.key === b.key && a.byteLength === b.byteLength && a.sha256 === b.sha256;
}

function cutsMatch(a: AuditedCapture['capturedCut'], b: AuditedCapture['capturedCut']): boolean {
  return (
    a.captureId === b.captureId &&
    a.epoch === b.epoch &&
    a.baseRevision === b.baseRevision &&
    a.cut === b.cut &&
    a.stableStageHandle === b.stableStageHandle &&
    a.manifestSha256 === b.manifestSha256
  );
}
/**
 * Admit reuse only from the published envelope that names this opened root.
 * A relabeled view cannot carry a current CAS parent forward.
 */
export function parentFromPublishedParent(
  view: MerklePackView,
  published: PublishedParent,
): PublishedMerkleParent {
  const parentInfo = publishedParentInfo(published);
  if (
    parentInfo.format !== MERKLE_PACK_FORMAT ||
    parentInfo.head.rootEnvelopeId !== parentInfo.envelopeId ||
    !refsMatch(parentInfo.rootObject, view.rootObject) ||
    !cutsMatch(parentInfo.capturedCut, view.capturedCut)
  ) {
    throw new MerklePackError('invalid-parameter', 'published parent does not authenticate this opened Merkle root');
  }
  const parent: PublishedMerkleParent = {
    view,
    headRootId: parentInfo.envelopeId,
    reachable: view.referencedObjects(),
  };
  publishedParents.add(parent);
  return Object.freeze(parent);
}

export interface BuildOptions {
  readonly sink: CandidateObjectSink;
  /** A child needs verified bytes, published head identity, and closure. */
  readonly parent?: PublishedMerkleParent | null;
  readonly chunkParams?: ChunkParams;
  /** Refused prepublish if any staged record would exceed it: no silent
   *  oversize objects, no paging metadata after the fact. */
  readonly maxPackBytes?: number;
}


// ── shared layout types ───────────────────────────────────────────────────────

/**
 * Where a digest's bytes live inside one immutable pack object. `sha256` is
 * the PLAIN digest of exactly the located extent — the value a range-read
 * intent authenticates.
 */
export interface PackLocation {
  readonly key: string;
  readonly offset: number;
  readonly length: number;
  readonly sha256: string;
}

/** The lookup a build needs from the previous generation's OPENED view. */
export interface PackLocator {
  locate(digest: string): PackLocation | undefined;
}

export type PackIndex = PackLocator;

/** Refused prepublish bound: no record larger than this may enter a pack. */
export const DEFAULT_MAX_PACK_BYTES = 4 * 1024 * 1024;

export interface BuildStats {
  readonly logicalBytes: number;
  /** Chunk occurrences across file inodes, counting repeats within a group. */
  readonly chunkInstances: number;
  readonly chunkInstancesReused: number;
  readonly distinctChunks: number;
  readonly distinctChunksReused: number;
  readonly fileInodes: number;
  readonly nodes: number;
  readonly nodesReused: number;
}

export interface MerklePackBuild {
  /** Ready for staged payload transfer and DO-owned finalization. */
  readonly plan: CandidatePublicationPlan;
  readonly root: MerklePackRoot;
  /** Immutable source handles for this generation only. Production transfers
   *  them directly; tests may read them with readStagedCandidateObjectForTest. */
  readonly staged: readonly StagedCandidateObject[];
  /** Bytes staged directly by this codec before plan closure metadata. */
  readonly movedBytes: number;
  readonly stats: BuildStats;
  /** The freshly committed index; hand an opened view back as `parent`. */
  readonly index: PackIndex;
}

// ── the tree ──────────────────────────────────────────────────────────────────

type TreeFile = {
  kind: 'file';
  mode: number;
  ino: number;
  metadata?: PosixMetadata;
  source: NodeEntry;
  size: number;
  extents: FileExtentJson[];
  holes: HoleExtentJson[];
};
type TreeSymlink = { kind: 'symlink'; mode: number; ino: number; metadata?: PosixMetadata; target: string };
type TreeDir = { kind: 'dir'; mode: number; ino: number; metadata?: PosixMetadata; children: Map<string, TreeNode> };

/**
 * A subtree carried from the parent UNCHANGED by a partial capture: the parent
 * node's own digest and bytes, so the child references it by the same name it
 * already had. Untouched content is merged by IDENTITY — the whole point of
 * the O(k) fence — rather than re-read, re-chunked, or re-uploaded.
 */
type TreeParentRef = {
  kind: 'parent-ref';
  /** The carried node's own kind, as the directory entry must state it. */
  nodeKind: 'file' | 'dir' | 'symlink';
  digest: string;
  bytes: Uint8Array;
  /**
   * For a carried FILE: every chunk its extent list names, so the child's
   * index declares locations for bytes it never re-read. The parent's own
   * index answers each location; the digests come from the parent node's
   * serialized form, which the merge already holds.
   */
  chunkRefs?: ReadonlyArray<readonly [digest: string, length: number]>;
};
type TreeNode = TreeFile | TreeSymlink | TreeDir | TreeParentRef;

function metadataMatches(a: PosixMetadata | undefined, b: PosixMetadata | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (
    a.uid !== b.uid ||
    a.gid !== b.gid ||
    a.atimeNs !== b.atimeNs ||
    a.mtimeNs !== b.mtimeNs ||
    a.ctimeNs !== b.ctimeNs
  ) {
    return false;
  }
  const names = Object.keys(a.xattrs);
  return names.length === Object.keys(b.xattrs).length && names.every((name) => a.xattrs[name] === b.xattrs[name]);
}

function canonicalMetadata(metadata: PosixMetadata | undefined): PosixMetadataJson | undefined {
  if (metadata === undefined) return undefined;
  return {
    uid: metadata.uid,
    gid: metadata.gid,
    atimeNs: metadata.atimeNs,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs,
    xattrs: Object.fromEntries(Object.entries(metadata.xattrs).sort(([a], [b]) => a.localeCompare(b))),
  };
}

/**
 * Plant the parent's untouched paths into the capture's tree as parent-refs.
 *
 * The parent view's own sealed nodes ARE the merge unit: `locate(digest)`
 * answers where each node's bytes already live, so a parent-ref costs one
 * in-memory lookup and nothing else. Directories the capture rewrote keep
 * their captured children and GAIN the parent's children the capture did not
 * touch — the overlay semantics the delta manifest states.
 */
/** The chunk digests a carried file node's extent list names, with each
 *  extent's length. The node is already in hand (its bytes are the merge's
 *  own read); the wire's own NodeSchema parses it, so a carried node that
 *  does not parse is refused here rather than partially trusted. */
function fileChunkRefs(bytes: Uint8Array): ReadonlyArray<readonly [string, number]> {
  let node: NodeJson;
  try {
    node = v.parse(NodeSchema, JSON.parse(new TextDecoder().decode(bytes)));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new MerklePackError('malformed-node', `a carried file node did not decode: ${detail}`, { cause: error });
  }
  if (node.t !== 'f') {
    throw new MerklePackError('malformed-node', `a carried node at a file path is a ${node.t}`);
  }
  const refs: Array<readonly [string, number]> = [];
  for (const extent of node.c) refs.push([extent.d, extent.l * extent.n]);
  return refs;
}

async function mergeParentTree(
  view: MerklePackView,
  root: TreeDir,
  snapshot: ReadonlyMap<string, NodeEntry>,
  removed: ReadonlySet<string>,
): Promise<void> {
  // One recursive walk of the parent's tree. `into` is the CHILD's directory
  // node being filled — the captured root for depth 0, a captured directory for
  // a path the capture rewrote, or a merged-directory overlay for a subtree
  // the capture did not touch at all.
  const merge = async (at: string, into: TreeDir): Promise<void> => {
    for (const name of await view.readdir(at)) {
      const path = at === '' ? name : `${at}/${name}`;
      const captured = snapshot.get(path);
      if (captured !== undefined) {
        // The capture named this path. A captured DIRECTORY absorbs the
        // parent's untouched children beneath it; anything else the capture
        // states outright, and it wins.
        const child = into.children.get(name);
        if (child !== undefined && child.kind === 'dir') await merge(path, child);
        continue;
      }
      if (removed.has(path)) continue;
      const stat = await view.stat(path);
      if (stat === null) continue;
      if (stat.kind === 'dir') {
        // An untouched directory from the parent. A directory node's content
        // is its child LIST, so it can only carry by identity when nothing
        // beneath it changed either — the walk below decides that, by leaving
        // the overlay empty (then the parent's node is referenced whole) or
        // filling it (then the directory is re-sealed with its merged set).
        const digest = await nodeDigestOf(view, path);
        const overlay: TreeDir = {
          kind: 'dir', mode: stat.mode, ino: stat.ino ?? 0,
          metadata: stat.metadata, children: new Map(),
        };
        into.children.set(name, overlay);
        await merge(path, overlay);
        if (overlay.children.size === 0) {
          const ref: TreeParentRef = { kind: 'parent-ref', nodeKind: 'dir', digest, bytes: await nodeBytesOf(view, digest) };
          into.children.set(name, ref);
        }
        continue;
      }
      // An untouched file or symlink: carried by identity, whole. A file also
      // names its chunks — the digest list the child's index must declare —
      // which the merge reads out of the parent node's own serialized form.
      const digest = await nodeDigestOf(view, path);
      const bytes = await nodeBytesOf(view, digest);
      const child: TreeParentRef = {
        kind: 'parent-ref', nodeKind: stat.kind === 'file' ? 'file' : 'symlink',
        digest, bytes,
        chunkRefs: stat.kind === 'file' ? fileChunkRefs(bytes) : undefined,
      };
      into.children.set(name, child);
    }
  };
  await merge('', root);
}

/** The sealed digest of the parent's node at `path`. */
async function nodeDigestOf(view: MerklePackView, path: string): Promise<string> {
  const digest = await view.nodeDigest(path);
  if (digest === null) throw new MerklePackError('no-entry', `the parent holds no node at ${JSON.stringify(path)}`);
  return digest;
}

/** The parent node's serialized bytes at their sealed digest. */
async function nodeBytesOf(view: MerklePackView, digest: string): Promise<Uint8Array> {
  const bytes = await view.nodeBytes(digest);
  if (bytes === null) {
    throw new MerklePackError('missing-digest', `the parent index names no location for node ${digest}`);
  }
  return bytes;
}

/**
 * Build one candidate generation from an audited capture.
 */
export async function buildMerklePack(auditedInput: AuditedCapture, options: BuildOptions): Promise<MerklePackBuild> {
  const audited = requireAuditedCapture(auditedInput);
  const params = options.chunkParams ?? DEFAULT_CHUNK_PARAMS;
  if (options.parent !== undefined && options.parent !== null && !publishedParents.has(options.parent)) {
    throw new MerklePackError('invalid-parameter', 'Merkle parent was not issued from a published candidate');
  }
  const maxPackBytes = options.maxPackBytes ?? DEFAULT_MAX_PACK_BYTES;
  validateChunkParams(params);
  if (!Number.isSafeInteger(maxPackBytes) || maxPackBytes < 1024) {
    throw new MerklePackError('invalid-parameter', `maxPackBytes must be >= 1024, got ${maxPackBytes}`);
  }
  if (
    options.parent !== undefined &&
    options.parent !== null &&
    BigInt(audited.capturedCut.cut) <= BigInt(options.parent.view.capturedCut.cut)
  ) {
    throw new MerklePackError(
      'invalid-parameter',
      `captured cut ${audited.capturedCut.cut} must advance parent cut ${options.parent.view.capturedCut.cut}`,
    );
  }

  const snapshot = new Map(audited.entries.map((entry) => [entry.path, entry]));
  const paths = [...snapshot.keys()].sort();
  for (const path of paths) {
    if (!isCanonicalJournalPath(path)) {
      throw new MerklePackError('hostile-path', `refusing non-canonical path ${JSON.stringify(path)}`);
    }
  }

  // Hardlink groups: one inode gets one truth. Disagreement inside a group is
  // a corrupt snapshot, not something to silently split into copies.
  const inodeGroups = new Map<number, NodeEntry[]>();
  for (const entry of snapshot.values()) {
    const members = inodeGroups.get(entry.ino);
    if (members === undefined) {
      inodeGroups.set(entry.ino, [entry]);
      continue;
    }
    const headPath = members[0].path;
    if (members[0].kind !== entry.kind || entry.kind !== 'file') {
      throw new MerklePackError('ino-reuse', `inode ${entry.ino} shared across kinds (${headPath}, ${entry.path})`);
    }
    // Both arms are files here; NodeEntry carries content optionally for the
    // other kinds, so the non-null assertions record that invariant.
    if (
      entry.mode !== members[0].mode ||
      !metadataMatches(entry.metadata, members[0].metadata) ||
      !contentEquals(entry.content!, members[0].content!)
    ) {
      throw new MerklePackError(
        'inconsistent-hardlink',
        `hardlinks of inode ${entry.ino} disagree (${entry.path} vs ${headPath})`,
      );
    }
    members.push(entry);
  }

  // AuditedCapture is already a complete tree. Do not invent missing ancestor
  // metadata locally; a fabricated/invalid value is refused defensively.
  const root: TreeDir = { kind: 'dir', mode: 0o755, ino: 0, children: new Map() };
  const plantedInodes = new Map<number, TreeFile>();
  for (const path of paths) {
    const parts = path.split('/');
    let parent = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const existing = parent.children.get(parts[i]);
      if (existing === undefined) {
        throw new MerklePackError(
          'hostile-path',
          `incomplete audited capture: ancestor ${parts.slice(0, i + 1).join('/')} is absent`,
        );
      }
      if (existing.kind !== 'dir') {
        throw new MerklePackError('hostile-path', `${path} traverses non-directory ${parts.slice(0, i + 1).join('/')}`);
      }
      parent = existing;
    }
    const name = parts[parts.length - 1];
    if (parent.children.has(name)) {
      throw new MerklePackError('hostile-path', `path conflict at ${path}: already present as another kind`);
    }
    // SAFETY: `path` iterates snapshot.keys(), so the entry exists by
    // construction; the checks above proved no kind conflict.
    const entry = snapshot.get(path)!;
    if (entry.kind === 'file') {
      let treeNode = plantedInodes.get(entry.ino);
      if (treeNode === undefined) {
        treeNode = {
          kind: 'file',
          mode: entry.mode,
          ino: entry.ino,
          metadata: entry.metadata,
          source: entry,
          holes: [],
          size: contentSize(entry.content!),
          extents: [],
        };
        plantedInodes.set(entry.ino, treeNode);
      }
      parent.children.set(name, treeNode);
    } else if (entry.kind === 'symlink') {
      const target = entry.target!;
      if (target.includes('\0') || utf8.encode(target).byteLength > MAX_SYMLINK_TARGET_BYTES) {
        throw new MerklePackError('hostile-path', `symlink target out of bounds at ${path}`);
      }
      parent.children.set(name, {
        kind: 'symlink',
        mode: entry.mode,
        ino: entry.ino,
        metadata: entry.metadata,
        target,
      });
    } else {
      parent.children.set(name, {
        kind: 'dir',
        mode: entry.mode,
        ino: entry.ino,
        metadata: entry.metadata,
        children: new Map(),
      });
    }
  }
  // ── THE PARTIAL-CAPTURE MERGE ───────────────────────────────────────────
  //
  // A v2 delta fence hands over only the touched paths, so the tree above is
  // an OVERLAY, not a replacement. Every path the parent still holds that the
  // capture does not name is carried into the child by identity: the parent's
  // sealed node digest, referenced unchanged. The merge is O(parent paths) in
  // METADATA ONLY — one index lookup per parent node already open in `view`,
  // no content read, no re-chunk, no re-upload — and the parent's own view is
  // the source, so nothing is re-derived.
  //
  // A partial capture WITHOUT a parent is refused: it would publish a tree
  // silently missing everything the fence did not name.
  if (audited.partial === true) {
    if (options.parent === undefined || options.parent === null) {
      throw new MerklePackError(
        'invalid-parameter',
        'a partial capture needs the published parent it is a delta against',
      );
    }
    const removedSet = new Set(audited.removed);
    await mergeParentTree(options.parent.view, root, snapshot, removedSet);
  }

  const holeExtents = (content: NodeEntry['content']): HoleExtentJson[] => {
    if (content === undefined || content.kind === 'dense') return [];
    if (content.kind === 'sealed') {
      const holes: HoleExtentJson[] = [];
      let cursor = 0;
      for (const extent of content.extents) {
        if (extent.offset > cursor) holes.push({ o: cursor, l: extent.offset - cursor });
        cursor = extent.offset + extent.length;
      }
      if (cursor < content.size) holes.push({ o: cursor, l: content.size - cursor });
      return holes;
    }
    return paintedSegments(content).segments.filter((segment) => segment.zeros).map((segment) => ({
      o: segment.start,
      l: segment.end - segment.start,
    }));
  };

  // holding one dense and one sparse-but-equal content chunks identically no
  // matter which order the snapshot listed them in.
  const zeroCache = new Map<number, EmittedChunk>();
  const chunkBytes = new Map<string, Uint8Array>();
  // Hardlinked names reference ONE tree node object, so the planted set is the
  // distinct-inode set.
  const chunkFiles: TreeFile[] = [...plantedInodes.values()];
  for (const treeNode of chunkFiles) {
    const head = inodeGroups.get(treeNode.ino)?.reduce((min, entry) => (entry.path < min.path ? entry : min))
      ?? treeNode.source;
    const extents: FileExtentJson[] = [];
    const size = await chunkCaptureContent(audited, head, params, zeroCache, (_offset, chunk, count) => {
      const length = chunk.bytes.byteLength;
      const last = extents[extents.length - 1];
      if (last !== undefined && last.d === chunk.digest && last.l === length) {
        last.n += count;
      } else {
        extents.push({ d: chunk.digest, l: length, n: count });
      }
      if (!chunkBytes.has(chunk.digest)) chunkBytes.set(chunk.digest, chunk.bytes);
    });
    treeNode.extents = extents;
    treeNode.holes = holeExtents(head.content);
    treeNode.size = size;
  }

  // ── node records, post-order, memoized by subtree object identity ──
  const nodeRecords = new Map<string, Uint8Array>();
  let distinctNodes = 0;
  const nodeId = new Map<TreeNode, string>();
  const sealTree = (node: TreeNode): string => {
    const memo = nodeId.get(node);
    if (memo !== undefined) return memo;
    // AN UNTOUCHED SUBTREE FROM THE PARENT: its node is already sealed in the
    // parent's packs under this digest, so the child references it by the same
    // identity and the bytes reach `needed` from the parent-ref itself — never
    // re-serialized, never re-chunked, never re-uploaded.
    if (node.kind === 'parent-ref') {
      nodeRecords.set(node.digest, node.bytes);
      nodeId.set(node, node.digest);
      return node.digest;
    }
    let json: NodeJson;
    if (node.kind === 'file') {
      json = {
        t: 'f',
        m: node.mode,
        i: node.ino,
        s: node.size,
        c: node.extents,
        h: node.holes,
        metadata: canonicalMetadata(node.metadata),
      };
    } else if (node.kind === 'symlink') {
      json = { t: 'l', m: node.mode, i: node.ino, g: node.target, metadata: canonicalMetadata(node.metadata) };
    } else {
      const entries: DirEntryJson[] = [...node.children.keys()].sort().map((n) => {
        const child = node.children.get(n)!;
        return {
          n,
          k: child.kind === 'parent-ref' ? child.nodeKind : child.kind,
          r: sealTree(child),
        };
      });
      json = { t: 'd', m: node.mode, i: node.ino, e: entries, metadata: canonicalMetadata(node.metadata) };
    }
    const serialized = serializeNode(json);
    const digest = hashNodeBytes(serialized);
    nodeId.set(node, digest);
    if (!nodeRecords.has(digest)) {
      nodeRecords.set(digest, serialized);
      distinctNodes++;
    }
    return digest;
  };
  const rootNodeId = sealTree(root);

  // ── resolve reuse against the authenticated parent, then pack the rest ──
  const needed = new Map<string, { kind: 'chunk' | 'node'; bytes: Uint8Array }>();
  for (const [digest, bytes] of chunkBytes) needed.set(digest, { kind: 'chunk', bytes });
  for (const [digest, bytes] of nodeRecords) needed.set(digest, { kind: 'node', bytes });

  let instancesTotal = 0;
  let instancesReused = 0;
  for (const fileNode of chunkFiles) {
    for (const extent of fileNode.extents) {
      instancesTotal += extent.n;
      if (options.parent?.view.locate(extent.d) !== undefined) instancesReused += extent.n;
    }
  }

  // Pack layout order: nodes by digest, then chunks in canonical file-traversal
  // rank (plantedInodes follows sorted paths, so this is permutation-invariant).
  // File-adjacent chunks land offset-contiguous in a pack, which is what lets a
  // reader coalesce a whole run into one range fetch.
  const chunkRank = new Map<string, number>();
  for (const fileNode of chunkFiles) {
    for (const extent of fileNode.extents) {
      if (!chunkRank.has(extent.d)) chunkRank.set(extent.d, chunkRank.size);
    }
  }
  const located = new Map<string, PackLocation>();
  const fresh: Array<{ order: string; digest: string; plainSha: string; bytes: Uint8Array }> = [];
  let distinctChunksReused = 0;
  let nodesReused = 0;
  // CHUNKS A CARRIED FILE NAMES are part of the child's index even though no
  // build step read them: the extent list in the carried node's own serialized
  // form is the authority, and the parent's index answers each location. A
  // chunk missing from BOTH is a corrupt parent, refused here rather than
  // published as an index gap.
  const carriedChunkRefs = new Map<string, number>();
  const collectCarried = (node: TreeNode): void => {
    if (node.kind === 'parent-ref') {
      for (const [digest, length] of node.chunkRefs ?? []) carriedChunkRefs.set(digest, length);
      return;
    }
    if (node.kind !== 'dir') return;
    for (const child of node.children.values()) collectCarried(child);
  };
  collectCarried(root);

  for (const [digest, length] of carriedChunkRefs) {
    if (located.has(digest)) continue;
    const parentLoc = options.parent?.view.locate(digest);
    if (parentLoc === undefined) {
      throw new MerklePackError(
        'invalid-parameter',
        `the parent index names no location for carried chunk ${digest}`,
      );
    }
    if (parentLoc.length !== length) {
      throw new MerklePackError(
        'invalid-parameter',
        `carried chunk ${digest} is ${length} bytes; the parent locates ${parentLoc.length}`,
      );
    }
    located.set(digest, parentLoc);
    distinctChunksReused++;
  }

  for (const [digest, record] of needed) {
    const plainSha = sha256Hex(record.bytes);
    const parentLoc = options.parent?.view.locate(digest);
    if (parentLoc !== undefined) {
      if (parentLoc.length !== record.bytes.byteLength) {
        throw new MerklePackError(
          'invalid-parameter',
          `published parent location for ${digest} has length ${parentLoc.length}, expected ${record.bytes.byteLength}`,
        );
      }
      located.set(digest, parentLoc);
      if (record.kind === 'chunk') distinctChunksReused++;
      else nodesReused++;
      continue;
    }
    fresh.push({
      order:
        record.kind === 'node'
          ? `0\u0000${digest}`
          : `1\u0000${String(chunkRank.get(digest)).padStart(12, '0')}`,
      digest,
      plainSha,
      bytes: record.bytes,
    });
  }

  const dependencies: StagedCandidateObject[] = [];
  const staged: StagedCandidateObject[] = [];

  const addPack = async (
    bytes: Uint8Array,
    members: Array<[string, string, number, number]>,
  ): Promise<void> => {
    const id = sha256Hex(bytes);
    const key = packKey(id);
    const object = await options.sink.stage(key, bytes);
    dependencies.push(object);
    staged.push(object);
    for (const [digest, plainSha, offset, length] of members) {
      located.set(digest, { key: object.ref.key, offset, length, sha256: plainSha });
    }
  };

  // Layout order above is a pure function of the snapshot, so identical inputs
  // always fill packs identically.
  fresh.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
  let packParts: Uint8Array[] = [];
  let packMembers: Array<[string, string, number, number]> = [];
  let packLength = 0;
  const flushPack = async (): Promise<void> => {
    if (packParts.length === 0) return;
    const bytes = new Uint8Array(packLength);
    let offset = 0;
    for (const part of packParts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    await addPack(bytes, packMembers);
    packParts = [];
    packMembers = [];
    packLength = 0;
  };
  for (const record of fresh) {
    if (record.bytes.byteLength > maxPackBytes) {
      throw new MerklePackError(
        'invalid-parameter',
        `record ${record.digest} is ${record.bytes.byteLength} bytes, above maxPackBytes ${maxPackBytes}; raise the bound or lower the chunk ceiling`,
      );
    }
    if (packLength > 0 && packLength + record.bytes.byteLength > maxPackBytes) await flushPack();
    packMembers.push([record.digest, record.plainSha, packLength, record.bytes.byteLength]);
    packParts.push(record.bytes);
    packLength += record.bytes.byteLength;
  }
  await flushPack();

  // One canonical index object per generation, entries sorted by digest:
  // [logical digest, extent plain sha, pack key, offset, length].
  const indexTuples: Array<[string, string, string, number, number]> = [...located.entries()]
    .map(([digest, loc]): [string, string, string, number, number] => [
      digest,
      loc.sha256,
      loc.key,
      loc.offset,
      loc.length,
    ])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  // THE INDEX DECLARES EVERY PACK ITS OWN EXTENTS NAME, and not one pack less.
  //
  // `e` above carries a location for every reachable chunk and node, and an
  // incremental generation's locations point INTO ITS PARENT'S packs. Listing
  // only `dependencies` — the packs THIS generation staged — left the reader
  // with extents it could not bound, so `referencedObjects()` refused the index
  // with "index extent is outside its declared pack" the moment anything asked
  // it for its closure. Nothing asks on a restore, and a second generation asks
  // its parent rather than itself, which is why two commits always worked and
  // every commit after them failed: the third build is the first reader of an
  // incremental index. The same omission also made that index unusable as a
  // parent, because `reachable` is built from this very list.
  //
  // Insertion order, deliberately not sorted: the fresh packs keep the order
  // they were filled in and the reused refs follow in the order the extent
  // table names them, both of which are pure functions of the snapshot. A
  // generation with nothing reused therefore encodes byte for byte as before.
  const parentRefs = new Map(options.parent?.reachable.map((ref) => [ref.key, ref]));
  const packRefs = new Map(dependencies.map((object) => [object.ref.key, object.ref]));
  for (const loc of located.values()) {
    if (packRefs.has(loc.key)) continue;
    const ref = parentRefs.get(loc.key);
    if (ref === undefined) {
      throw new MerklePackError('invalid-parameter', `published parent closure omits reused object ${loc.key}`);
    }
    packRefs.set(ref.key, ref);
  }
  const indexBytes = utf8.encode(JSON.stringify({
    v: 1,
    p: [...packRefs.values()],
    e: indexTuples,
  }));
  if (indexBytes.byteLength > maxPackBytes) {
    throw new MerklePackError(
      'invalid-parameter',
      `index is ${indexBytes.byteLength} bytes, above maxPackBytes ${maxPackBytes}`,
    );
  }
  const indexId = sha256Hex(indexBytes);
  const indexObject = await options.sink.stage(indexKey(indexId), indexBytes);
  dependencies.push(indexObject);
  staged.push(indexObject);

  // Root manifest: independent facts only — pointers and the audited cut
  // identity, nothing the index or DAG could state on their behalf.
  const rootJson = {
    format: MERKLE_PACK_FORMAT,
    v: 1,
    root: rootNodeId,
    index: indexObject.ref,
    capturedCut: audited.capturedCut,
  };
  const rootManifestBytes = utf8.encode(JSON.stringify(rootJson));
  if (rootManifestBytes.byteLength > maxPackBytes) {
    throw new MerklePackError(
      'invalid-parameter',
      `root manifest is ${rootManifestBytes.byteLength} bytes, above maxPackBytes ${maxPackBytes}`,
    );
  }
  const rootId = sha256Hex(rootManifestBytes);
  const rootObject = await options.sink.stage(rootKey(rootId), rootManifestBytes);
  staged.push(rootObject);

  // The publication's reused closure is the same set the index just declared,
  // minus everything this generation staged. One computation, one place: the
  // two lists disagreeing is exactly the defect above.
  const reusedRefs = new Map<string, ImmutableObjectRef>();
  const stagedKeys = new Set(dependencies.map((object) => object.ref.key));
  for (const [key, ref] of packRefs) {
    if (stagedKeys.has(key)) continue;
    reusedRefs.set(key, ref);
  }
  const plan = await planCandidatePublication({
    format: MERKLE_PACK_FORMAT,
    expectedParentRootId: options.parent?.headRootId ?? null,
    capture: audited,
    sink: options.sink,
    dependencies,
    root: rootObject,
    reused: [...reusedRefs.values()],
  });

  return {
    plan,
    root: { rootId, manifestBytes: rootManifestBytes },
    staged,
    movedBytes: staged.reduce((sum, object) => sum + Number(object.ref.byteLength), 0),
    stats: {
      logicalBytes: chunkFiles.reduce((sum, f) => sum + f.size, 0),
      chunkInstances: instancesTotal,
      chunkInstancesReused: instancesReused,
      distinctChunks: chunkBytes.size,
      distinctChunksReused,
      fileInodes: chunkFiles.length,
      nodes: distinctNodes,
      nodesReused,
    },
    index: {
      locate: (digest) => located.get(digest),
    },
  };
}
