/**
 * Compaction: the same tree, in fewer packs.
 *
 * WHY IT EXISTS. A two-second seal cadence writes small packs, and every
 * overwrite leaves dead bytes inside packs that are otherwise live. Left
 * alone, the store grows with the WRITE history rather than with the tree, and
 * every restore pays for the difference. Compaction moves the live chunks out
 * of the packs that are more than half waste and retires those packs.
 *
 * WHY IT IS A PUBLISH LIKE ANY OTHER. The tree content does not change — the
 * same chunks, the same digests, the same file geometry — only where the bytes
 * live. So a compaction generation is an ordinary generation whose delta is
 * "these files moved": relocated chunks in file order, then the extent pages,
 * file nodes and ancestors that had to name the new locations, then the root.
 * It goes out through the same envelope, the same ledger and the same head CAS
 * as a seal, and its `retired` list is what GC deletes after grace.
 *
 * Selection uses estimated liveness and age. The graph walk establishes
 * retirement safety by relocating data and metadata references. The returned
 * work counts relocated payload bytes and rewritten nodes; it does not prove
 * a general amortized bound.
 */

import type { CompactionWork, NamespaceRef, ObjectRangeRef } from '../../durability/contracts';

import { MerklePackError } from './errors';
import { PackWriter } from './pack-layout';
import { buildDirTree, knownDirPages } from './dir-tree';
import type { BuiltPack, ResolvePack, Slot } from './pack-layout';
import type { MerkleV2View, RecordV2 } from './view-v2';
import { encodeNodeV2, extentPagesV2, hashNodeV2Bytes } from './wire';
import type { DirEntryV2, ExtentPageRefV2, ExtentV2, NodeV2, RecordRefV2 } from './wire';
import type { NamespacePageMap } from './namespace-map';

export interface CompactionInput {
  readonly view: MerkleV2View;
  /** Packs selected for relocation from the retained inventory. */
  readonly candidates: ReadonlySet<string>;
  readonly maxPackBytes: number;
  /** The parent's namespace, whose pages may share candidate packs. */
  readonly namespace: { readonly map: NamespacePageMap; readonly byteLength: number } | null;
}

export interface CompactionBuild {
  readonly packs: readonly BuiltPack[];
  readonly rootObject: ObjectRangeRef;
  readonly namespace: NamespaceRef | null;
  readonly work: CompactionWork;
  /** The candidate packs this build really emptied, sorted. */
  readonly retired: readonly string[];
}

/** What one walked record turned into: a reference, and whether it moved. */
interface Rewritten {
  readonly ref: (resolve: ResolvePack) => RecordRefV2;
  readonly moved: boolean;
}

function reference(slot: Slot, id: string): (resolve: ResolvePack) => RecordRefV2 {
  return (resolve) => ({
    id,
    sha256: slot.sha256,
    pack: resolve(slot),
    offset: slot.offset,
    length: slot.length,
  });
}

/**
 * Rewrite every data and metadata reference into candidate packs. A full walk
 * also proves which candidates are already unreachable. An empty candidate
 * set requires no work.
 */
export async function compactMerklePacks(input: CompactionInput): Promise<CompactionBuild | null> {
  if (input.candidates.size === 0) return null;
  const writer = new PackWriter(input.maxPackBytes);
  const relocated = new Map<string, Slot>();
  const rewrittenFiles = new Map<RecordV2, Rewritten>();
  const touched = new Set<string>();
  let bytesRewritten = 0;
  let nodesRewritten = 0;

  const placeNode = (node: (resolve: ResolvePack) => NodeV2): Rewritten => {
    let id = '';
    const slot = writer.placeRecord((resolve) => {
      const bytes = encodeNodeV2(node(resolve));
      id = hashNodeV2Bytes(bytes);
      return bytes;
    });
    nodesRewritten += 1;
    return { ref: reference(slot, id), moved: true };
  };

  const relocateExtents = async (extents: readonly ExtentV2[]): Promise<readonly ExtentV2[] | null> => {
    if (!extents.some((extent) => input.candidates.has(extent.pack))) return null;
    const out: (ExtentV2 | { readonly slot: Slot; readonly extent: ExtentV2 })[] = [];
    for (const extent of extents) {
      if (!input.candidates.has(extent.pack)) {
        out.push(extent);
        continue;
      }
      touched.add(extent.pack);
      let slot = relocated.get(extent.digest);
      if (slot === undefined) {
        const bytes = await input.view.chunkBytes(extent);
        slot = writer.place(bytes);
        relocated.set(extent.digest, slot);
        bytesRewritten += bytes.byteLength;
      }
      out.push({ slot, extent });
    }
    return out.map((item) => ('slot' in item ? { ...item.extent, pack: PENDING_PACK, offset: item.slot.offset } : item));
  };

  const walk = async (path: string): Promise<Rewritten> => {
    const record = await input.view.record(path);
    if (record === null) throw new MerklePackError('no-entry', 'nothing at ' + JSON.stringify(path));
    const node = record.node;
    const moveRecord = input.candidates.has(record.ref.pack);
    if (moveRecord) touched.add(record.ref.pack);
    if (node.kind === 'symlink') {
      return moveRecord ? placeNode(() => node) : { ref: () => record.ref, moved: false };
    }
    if (node.kind === 'page' || node.kind === 'dirpage') {
      throw new MerklePackError('malformed-node', JSON.stringify(path) + ' resolves to a page record');
    }
    if (node.kind === 'file') {
      const prior = rewrittenFiles.get(record);
      if (prior !== undefined) return prior;
      const extents = await input.view.fileExtents(path);
      const moved = await relocateExtents(extents);
      let movePages = false;
      if (node.extents.kind === 'paged') {
        for (const page of node.extents.pages) {
          if (!input.candidates.has(page.pack)) continue;
          touched.add(page.pack);
          movePages = true;
        }
      }
      if (moved === null && !moveRecord && !movePages) {
        const unchanged = { ref: () => record.ref, moved: false };
        rewrittenFiles.set(record, unchanged);
        return unchanged;
      }
      const extentsToWrite = moved ?? extents;
      const pages = extentPagesV2(extentsToWrite);
      const pageRefs: { slot: Slot; id: string; page: readonly ExtentV2[]; fileOffset: number; bytes: number }[] = [];
      let fileOffset = 0;
      for (const page of pages) {
        const bytes = page.reduce((sum, extent) => sum + extent.length * extent.count, 0);
        let id = '';
        const slot = writer.placeRecord((resolve) => {
          const encoded = encodeNodeV2({ kind: 'page', extents: resolvePending(page, resolve, relocated) });
          id = hashNodeV2Bytes(encoded);
          return encoded;
        });
        nodesRewritten += 1;
        pageRefs.push({ slot, id, page, fileOffset, bytes });
        fileOffset += bytes;
      }
      const result = placeNode((resolve) => fileNodeOf(node, extentsToWrite, pageRefs, resolve, relocated));
      rewrittenFiles.set(record, result);
      return result;
    }

    const entries = await input.view.dirEntries(path);
    const children: { readonly entry: DirEntryV2; readonly rewritten: Rewritten }[] = [];
    let childMoved = false;
    for (const entry of entries) {
      const child = await walk(path === '' ? entry.name : path + '/' + entry.name);
      if (child.moved) childMoved = true;
      children.push({ entry, rewritten: child });
    }
    const pages = await knownDirPages(node.entries, (level) => input.view.dirPages(level));
    const movePages = pages.some((page) => input.candidates.has(page.ref.pack));
    for (const page of pages) if (input.candidates.has(page.ref.pack)) touched.add(page.ref.pack);
    // Publication requires a receipt for the pack carrying the root. Emit
    // that root even when only unreachable inventory was selected.
    if (path !== '' && !childMoved && !moveRecord && !movePages) return { ref: () => record.ref, moved: false };
    const rewrittenByName = new Map(children.map(({ entry, rewritten }) => [entry.name, rewritten]));
    const tree = buildDirTree(
      writer,
      children.map(({ entry, rewritten }) => ({
        name: entry.name,
        kind: entry.kind,
        ref: rewritten.moved ? { ...entry.ref, pack: MOVING_CHILD } : entry.ref,
      })),
      pages.filter((page) => !input.candidates.has(page.ref.pack)),
      (slice, resolve) => slice.map((entry) => {
        const rewritten = rewrittenByName.get(entry.name);
        if (rewritten === undefined) throw new MerklePackError('malformed-node', `unknown child ${entry.name}`);
        return { name: entry.name, kind: entry.kind, ref: rewritten.ref(resolve) };
      }),
      (entry) => rewrittenByName.get(entry.name)?.moved !== true,
    );
    return placeNode((resolve) => ({
      kind: 'dir', mode: node.mode, ino: node.ino,
      entries: tree.entries(resolve),
      metadata: node.metadata,
    }));
  };

  const root = await walk('');
  const namespace = input.namespace === null
    ? null
    : await input.namespace.map.relocate(writer, input.candidates, input.namespace.byteLength);
  writer.finish();
  const rootRef = root.ref((slot) => writer.keyOf(slot));
  return {
    packs: writer.packs,
    rootObject: {
      key: rootRef.pack,
      byteOffset: String(rootRef.offset),
      byteLength: String(rootRef.length),
      sha256: rootRef.sha256,
    },
    namespace: namespace === null ? null : { root: namespace.root((slot) => writer.keyOf(slot)), byteLength: String(namespace.byteLength) },
    work: { packsRead: touched.size, bytesRewritten, nodesRewritten },
    retired: [...input.candidates].sort(),
  };
}

/** A child whose record moved in this compaction, before its slot resolves. */
const MOVING_CHILD = '\u0000moving';

/** A relocated extent carries this pack until the naming record serializes. */
const PENDING_PACK = '\u0000moved';

function resolvePending(
  extents: readonly ExtentV2[],
  resolve: ResolvePack,
  relocated: ReadonlyMap<string, Slot>,
): ExtentV2[] {
  return extents.map((extent) => {
    if (extent.pack !== PENDING_PACK) return extent;
    const slot = relocated.get(extent.digest);
    if (slot === undefined) throw new MerklePackError('missing-digest', `chunk ${extent.digest} was not relocated`);
    return { ...extent, pack: resolve(slot), offset: slot.offset };
  });
}

function fileNodeOf(
  node: Extract<NodeV2, { readonly kind: 'file' }>,
  extents: readonly ExtentV2[],
  pages: readonly { slot: Slot; id: string; page: readonly ExtentV2[]; fileOffset: number; bytes: number }[],
  resolve: ResolvePack,
  relocated: ReadonlyMap<string, Slot>,
): NodeV2 {
  if (pages.length === 0) {
    return {
      kind: 'file',
      mode: node.mode,
      ino: node.ino,
      size: node.size,
      extents: { kind: 'inline', extents: resolvePending(extents, resolve, relocated) },
      holes: [...node.holes],
      metadata: node.metadata,
    };
  }
  const refs: ExtentPageRefV2[] = pages.map((page) => ({
    ...reference(page.slot, page.id)(resolve),
    fileOffset: page.fileOffset,
    extents: page.page.reduce((count, extent) => count + extent.count, 0),
    bytes: page.bytes,
  }));
  return {
    kind: 'file',
    mode: node.mode,
    ino: node.ino,
    size: node.size,
    extents: { kind: 'paged', pages: refs },
    holes: [...node.holes],
    metadata: node.metadata,
  };
}
