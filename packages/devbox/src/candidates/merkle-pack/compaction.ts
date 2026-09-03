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
 * WHY THE AMPLIFICATION IS BOUNDED. A byte is only moved when the pack around
 * it is more than half dead (`ledger.ts`), so each move must be paid for by at
 * least as many dead bytes in the same pack — which is the standard tiered
 * argument, and `CompactionWork.bytesRewritten` is what makes it measurable
 * rather than assumed.
 */

import type { CompactionWork, ObjectRangeRef } from '../../durability/contracts';

import { MerklePackError } from './errors';
import { PackWriter } from './pack-layout';
import type { BuiltPack, ResolvePack, Slot } from './pack-layout';
import type { MerkleV2View, RecordV2 } from './view-v2';
import { encodeNodeV2, extentPagesV2, hashNodeV2Bytes } from './wire';
import type { DirEntryV2, ExtentPageRefV2, ExtentV2, NodeV2, RecordRefV2 } from './wire';

export interface CompactionInput {
  readonly view: MerkleV2View;
  /** The packs the ledger selected: more than half dead, or small and old. */
  readonly candidates: ReadonlySet<string>;
  readonly maxPackBytes: number;
}

export interface CompactionBuild {
  readonly packs: readonly BuiltPack[];
  readonly rootObject: ObjectRangeRef;
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
 * Rewrite one head so that nothing it reaches lives in a candidate pack.
 * Answers `null` when the head reaches none of them, which is the ordinary
 * case and must not publish an empty generation.
 */
export async function compactMerklePacks(input: CompactionInput): Promise<CompactionBuild | null> {
  const writer = new PackWriter(input.maxPackBytes);
  const relocated = new Map<string, Slot>();
  const rewrittenFiles = new Map<RecordV2, Rewritten>();
  const touched = new Set<string>();
  let bytesRewritten = 0;
  let nodesRewritten = 0;

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
    // The slots are resolved when the record that names them serializes, so
    // the placeholder shape is kept until then.
    return out.map((item) => ('slot' in item ? { ...item.extent, pack: PENDING_PACK, offset: item.slot.offset } : item));
  };

  const walk = async (path: string): Promise<Rewritten | null> => {
    const record = await input.view.record(path);
    if (record === null) throw new MerklePackError('no-entry', `nothing at ${JSON.stringify(path)}`);
    const node = record.node;
    if (node.kind === 'symlink') {
      return { ref: () => record.ref, moved: false };
    }
    if (node.kind === 'page') {
      throw new MerklePackError('malformed-node', `${JSON.stringify(path)} resolves to an extent page`);
    }
    if (node.kind === 'file') {
      const prior = rewrittenFiles.get(record);
      if (prior !== undefined) return prior;
      const extents = await input.view.fileExtents(path);
      const moved = await relocateExtents(extents);
      if (moved === null) return { ref: () => record.ref, moved: false };
      const pages = extentPagesV2(moved);
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
      let id = '';
      const slot = writer.placeRecord((resolve) => {
        const encoded = encodeNodeV2(fileNodeOf(node, moved, pageRefs, resolve, relocated));
        id = hashNodeV2Bytes(encoded);
        return encoded;
      });
      nodesRewritten += 1;
      const result = { ref: reference(slot, id), moved: true };
      rewrittenFiles.set(record, result);
      return result;
    }

    const children: { readonly entry: DirEntryV2; readonly rewritten: Rewritten }[] = [];
    let childMoved = false;
    for (const entry of node.entries) {
      const child = await walk(path === '' ? entry.name : `${path}/${entry.name}`);
      if (child === null) continue;
      if (child.moved) childMoved = true;
      children.push({ entry, rewritten: child });
    }
    if (!childMoved) return { ref: () => record.ref, moved: false };
    let id = '';
    const slot = writer.placeRecord((resolve) => {
      const encoded = encodeNodeV2({
        kind: 'dir',
        mode: node.mode,
        ino: node.ino,
        entries: children.map(({ entry, rewritten }): DirEntryV2 => ({
          name: entry.name,
          kind: entry.kind,
          ref: rewritten.ref(resolve),
        })),
        metadata: node.metadata,
      });
      id = hashNodeV2Bytes(encoded);
      return encoded;
    });
    nodesRewritten += 1;
    return { ref: reference(slot, id), moved: true };
  };

  const root = await walk('');
  if (root === null || !root.moved) return null;
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
    work: { packsRead: touched.size, bytesRewritten, nodesRewritten },
    retired: [...touched].sort(),
  };
}

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
