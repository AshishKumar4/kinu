/**
 * The container half of a lazy restore, over a live tree.
 *
 * WHAT THIS STANDS FOR. In a deployed smart container the faults belong to the
 * journal daemon: a `readdir` of a directory nothing has entered, a `read` of a
 * file nothing has touched, and a `write` into one, each blocking in the kernel
 * while the sidecar pages the head in. Here the tree is a {@link LiveTree} and
 * the faults are method calls, which is the same shape with the blocking made
 * explicit — a fault IS an await, and a model that hid that would be modelling
 * a filesystem nobody can build.
 *
 * WHAT IT REFUSES TO DO. It never walks the head to be helpful. `enter` plants
 * the root's children and stops; a directory below is planted when something
 * lists it, and a file's bytes arrive when something reads them. That
 * restraint is the property cell 6.13 measures, so a convenience walk here
 * would erase the thing under test.
 */

import type { LazyRestore, LazyRestorePorts } from '../../src/candidates/lazy-restore';
import type { GcWork, HydrateWork } from '../../src/durability/contracts';
import type { FileGeometry } from '../../src/candidates/residency';
import type { NodeEntry } from '../../src/capture/model';
import { contentSize } from '../../src/capture/model';
import { holesOf, LiveTree } from './tree-model';

/** The data spans of one live content, as the residency states geometry. */
export function geometryOfContent(content: NonNullable<NodeEntry['content']>): FileGeometry {
  const size = contentSize(content);
  const data: { offset: number; length: number }[] = [];
  let cursor = 0;
  for (const [from, to] of holesOf(content)) {
    if (from > cursor) data.push({ offset: cursor, length: from - cursor });
    cursor = to;
  }
  if (size > cursor) data.push({ offset: cursor, length: size - cursor });
  return { size, data };
}

/**
 * One container's view of a lazily restored head.
 *
 * The tree is the container's own — the disk-charged one whose quota an ENOSPC
 * cell fills — so a page-in charges the disk and an eviction refunds it, which
 * is what makes eviction worth anything at all.
 */
export class LazyContainer {
  #restore: LazyRestore | null = null;
  /** Directories whose children have been planted. */
  readonly #listed = new Set<string>();
  /** Paths the container has written: no longer the head's to serve. */
  readonly #owned = new Set<string>();

  constructor(private tree: LiveTree, private readonly now: () => number) {}

  /** The ports the sidecar's lazy restore places bytes through. */
  ports(): LazyRestorePorts {
    return {
      place: (path, offset, bytes) => this.tree.hydrate(path, offset, bytes),
      drop: (path, offset, length) => this.tree.dehydrate(path, offset, length),
      now: this.now,
    };
  }

  /** A new restore over a new head: what an attach hands back. The tree stays
   *  where it is — a replacement clears it, an attach does not — and every
   *  directory faults again, which is how the new restore learns what is
   *  resident; a live file is never recreated by that listing. */
  adopt(restore: LazyRestore | null, tree?: LiveTree): void {
    this.#restore = restore;
    if (tree !== undefined) this.tree = tree;
    this.#listed.clear();
  }

  /** Forget every fault this container has served: a replaced container. */
  reset(tree: LiveTree): void {
    this.tree = tree;
    this.#restore = null;
    this.#listed.clear();
    this.#owned.clear();
  }

  get attached(): boolean {
    return this.#restore !== null;
  }

  /** The root's children, and nothing below them: the whole of an attach. */
  async enter(): Promise<void> {
    await this.#list('');
  }

  /** Make `path` present: every directory on the way to it is faulted, in
   *  order, exactly as a path walk in the kernel faults them. */
  async faultPath(path: string): Promise<void> {
    if (this.#restore === null) return;
    const parts = path.split('/');
    let at = '';
    await this.#list('');
    for (const part of parts.slice(0, -1)) {
      at = at === '' ? part : `${at}/${part}`;
      await this.#list(at);
    }
  }

  /** Read one file's bytes, paging in what is missing first. */
  async read(path: string): Promise<Uint8Array | undefined> {
    await this.faultPath(path);
    const node = this.tree.node(path);
    if (node?.kind !== 'file' || node.content === undefined) return undefined;
    await this.#restore?.hydrateWhole(path);
    const content = this.tree.node(path)?.content;
    if (content === undefined) return undefined;
    if (content.kind === 'dense') return content.bytes;
    if (content.kind === 'sealed') return undefined;
    const out = new Uint8Array(content.size);
    for (const run of content.runs) out.set(run.bytes, run.offset);
    return out;
  }

  /** Page in one window of one file: a `pread` of a placeholder. */
  async readRange(path: string, offset: number, length: number): Promise<void> {
    await this.faultPath(path);
    await this.#restore?.hydrate(path, offset, length);
  }

  /** The inode the container gave `path`: what a restore's `fstat` answers,
   *  the directory on the way to it faulted in as a stat would fault it. */
  async ino(path: string): Promise<number> {
    await this.faultPath(path);
    return this.tree.ino(path);
  }

  /**
   * The whole tree, read: every directory listed and every file paged in.
   *
   * A reader of the whole tree pays for the whole tree, and that is the point
   * of measuring it — the bill lands in HydrateWork, where a bound can see it,
   * instead of in the attach, where it would scale a wake with the tree.
   */
  async readAll(): Promise<void> {
    if (this.#restore === null) return;
    await this.listAll();
    for (const path of this.tree.filePaths()) await this.#restore.hydrateWhole(path);
  }

  /**
   * Every directory, listed — no file's bytes. What `paths()` owes: the
   * names, not the content, so a caller that reads only some of them pays
   * only for those.
   */
  async listAll(): Promise<void> {
    if (this.#restore === null) return;
    await this.enter();
    for (;;) {
      const pending = this.tree.paths().filter((path) => {
        const node = this.tree.node(path);
        return node?.kind === 'dir' && !this.#listed.has(path);
      });
      if (pending.length === 0) break;
      for (const dir of pending) await this.#list(dir);
    }
  }

  /**
   * What a write owes before it lands: the file's own bytes, paged in, and the
   * path taken out of the head's hands.
   *
   * BOTH HALVES MATTER. Without the page-in a fence that stages this file
   * whole would publish the zeros of pages nobody read; without the handover
   * an eviction could drop bytes the workload has written and the head does
   * not hold.
   */
  async beforeWrite(path: string): Promise<void> {
    await this.faultPath(path);
    if (this.#restore === null || this.#owned.has(path)) return;
    if (this.tree.node(path) !== undefined) await this.#restore.hydrateWhole(path);
    this.#restore.forget(path);
    this.#owned.add(path);
  }

  /**
   * Every file THIS BOOT PUT THERE is a cache of the head again: what a
   * publish leaves behind. Every OTHER file is left exactly as it was.
   *
   * THE SKIP IS THE FIX. A path the residency still tracks is a live
   * placeholder or an already-hydrated entry from an earlier wake — its own
   * geometry is already correct, and re-deriving one from THIS tree's bytes
   * would describe an unhydrated placeholder's zeros as its whole content,
   * poisoning every future read of a file nothing in this boot ever touched.
   * Only a path the residency does NOT track — because a write forgot it, or
   * because no lazy restore existed yet when this tree was built — gets
   * registered from what the tree actually holds.
   */
  notePublished(): void {
    const restore = this.#restore;
    if (restore === null) return;
    this.#owned.clear();
    for (const entry of this.tree.snapshot()) {
      if (entry.kind !== 'file' || entry.content === undefined) continue;
      if (restore.holds(entry.path)) continue;
      restore.registerResident(entry.path, geometryOfContent(entry.content));
    }
  }

  /** Drop clean pages. `idleMs: 0` is disk pressure: everything clean goes. */
  evict(idleMs?: number): GcWork {
    if (this.#restore === null) return { deletes: 0, markPages: 0, markBytes: 0 };
    return this.#restore.evict(idleMs === undefined ? {} : { idleMs });
  }

  /** What page-in has cost since this container's current restore opened. */
  work(): HydrateWork {
    return this.#restore?.work() ?? { rangeGets: 0, bytesFetched: 0, bytesRequested: 0 };
  }

  /** Plant one directory's children, hardlinks shared with the names already
   *  planted for the same inode. A name the disk already holds is left as
   *  it is: a listing never recreates a live file, so its inode survives. */
  async #list(dir: string): Promise<void> {
    const restore = this.#restore;
    if (restore === null || this.#listed.has(dir)) return;
    this.#listed.add(dir);
    for (const entry of await restore.list(dir)) {
      if (this.tree.has(entry.path)) continue;
      const linked = entry.kind === 'file' ? restore.linkedPath(entry.ino) : undefined;
      if (linked !== undefined && linked !== entry.path && this.tree.has(linked)) {
        this.tree.link(linked, entry.path);
        continue;
      }
      this.tree.plant([entry]);
    }
  }
}
