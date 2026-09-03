/**
 * The lazy restore: a published head as a filesystem that arrives on demand.
 *
 * WHAT AN ATTACH OWES, AND WHAT IT DOES NOT. An attach owes the container a
 * root it can enter and a mount it can read through. It does not owe it the
 * tree: a wake that walks every node pays one remote operation per node, which
 * is the term cell 6.13 measured at 200,006 operations for 1e5 files
 * (2026-09-02, bounded-layers) and at one whole-pack read per ledger pack
 * (merkle-pack). So this module hands out ONE DIRECTORY'S CHILDREN at a time,
 * as placeholders — length, hole geometry and POSIX metadata, no bytes — and
 * the bytes follow on first touch through {@link Residency}.
 *
 * ONE SEAM, BOTH CODECS. `stat`/`readdir`/`extents`/`readRange` is the shape
 * both the merkle-pack views and the bounded-layer reader already serve, so a
 * lazy restore is written once against the metadata surface rather than twice
 * against two layouts.
 *
 * A PLACEHOLDER IS A SPARSE FILE WITH NO RUNS. That is not a trick of
 * representation: a file whose bytes are not here reads as zeros over its full
 * length, which is exactly what a hole is, and the geometry says which of
 * those zeros are the head's holes and which are pages still to come.
 */

import type { NodeEntry, PosixMetadata } from '../capture/model';
import type { GcWork, HydrateWork } from '../durability/contracts';

import {
  Residency,
  type DataSpan,
  type EvictionRequest,
  type FileGeometry,
  type Hydration,
} from './residency';

/** One contiguous stretch of a file: bytes the head stores, or a hole. The
 *  shape both codecs' extent lists already have. */
export interface FileExtent {
  readonly kind: 'data' | 'hole';
  readonly offset: number;
  readonly length: number;
}

/** What a restore has to know about one node before it can create it. The
 *  shape `StatInfo` has, stated here so the seam names no codec. */
export interface HeadStat {
  readonly kind: 'file' | 'dir' | 'symlink';
  readonly mode: number;
  readonly size: number;
  readonly ino?: number;
  readonly target?: string;
  readonly metadata?: PosixMetadata;
}

/**
 * The metadata surface of a published head. Every member reads records, never
 * payload — except `readRange`, which is the page-in itself.
 */
export interface HeadFilesystem {
  stat(path: string): Promise<HeadStat | null>;
  readdir(path: string): Promise<readonly string[]>;
  extents(path: string): Promise<readonly FileExtent[]>;
  readRange(path: string, offset: number, length: number): Promise<Uint8Array>;
}

/** Where paged-in bytes land, and when they are released. */
export interface LazyRestorePorts {
  place(path: string, offset: number, bytes: Uint8Array): void;
  drop(path: string, offset: number, length: number): void;
  now(): number;
  readonly pageBytes?: number | undefined;
  readonly idleMs?: number | undefined;
}

/** The metadata a head that carries none still has to restore something by. */
const RESTORED_METADATA: PosixMetadata = {
  uid: 0, gid: 0, atimeNs: '0', mtimeNs: '0', ctimeNs: '0', xattrs: {},
};

/** The data spans of a file, from the head's own extent list. */
function geometryOf(size: number, extents: readonly FileExtent[]): FileGeometry {
  const data: DataSpan[] = [];
  for (const extent of extents) {
    if (extent.kind !== 'data' || extent.length === 0) continue;
    const last = data[data.length - 1];
    if (last !== undefined && last.offset + last.length === extent.offset) {
      data[data.length - 1] = { offset: last.offset, length: last.length + extent.length };
      continue;
    }
    data.push({ offset: extent.offset, length: extent.length });
  }
  return { size, data };
}

/**
 * One published head, restored lazily over one container.
 *
 * The container drives it: `list` on a directory fault, `hydrate` on a read
 * fault, `evict` under disk pressure, `forget` when a write makes a path the
 * container's own. Every remote operation any of them costs is reported in the
 * contract's own rows — {@link HydrateWork} for page-in, {@link GcWork} for
 * the sweep.
 */
export class LazyRestore {
  readonly #head: HeadFilesystem;
  readonly #residency: Residency;
  /** Placeholders handed out already, by the inode the head gave them. Two
   *  names on one inode are a hardlink, and the container must share it. */
  readonly #inodePaths = new Map<number, string>();

  constructor(head: HeadFilesystem, ports: LazyRestorePorts) {
    this.#head = head;
    this.#residency = new Residency({
      read: async (path, offset, length) => await head.readRange(path, offset, length),
      place: ports.place,
      drop: ports.drop,
      now: ports.now,
      pageBytes: ports.pageBytes,
      idleMs: ports.idleMs,
    });
  }

  /**
   * The children of one directory, as the entries a container plants: real
   * mode, owner, times, xattrs, symlink targets and hole geometry, and no
   * payload at all. One record read per child, and nothing below them.
   */
  async list(dir: string): Promise<readonly NodeEntry[]> {
    const entries: NodeEntry[] = [];
    for (const name of await this.#head.readdir(dir)) {
      const path = dir === '' ? name : `${dir}/${name}`;
      const entry = await this.placeholder(path);
      if (entry !== null) entries.push(entry);
    }
    return entries;
  }

  /**
   * One node as a placeholder entry, or null when the head does not hold it.
   * A file is registered with the residency here: this is the moment the box
   * learns the path exists, and the first read is what pays for its bytes.
   */
  async placeholder(path: string): Promise<NodeEntry | null> {
    const stat = await this.#head.stat(path);
    if (stat === null) return null;
    const metadata = stat.metadata ?? RESTORED_METADATA;
    const ino = stat.ino ?? 0;
    if (stat.kind === 'dir') return { path, kind: 'dir', mode: stat.mode, ino, metadata };
    if (stat.kind === 'symlink') {
      return { path, kind: 'symlink', mode: stat.mode, ino, metadata, target: stat.target ?? '' };
    }
    this.#residency.register(path, geometryOf(stat.size, await this.#head.extents(path)));
    this.#inodePaths.set(ino, this.#inodePaths.get(ino) ?? path);
    return {
      path,
      kind: 'file',
      mode: stat.mode,
      ino,
      metadata,
      content: { kind: 'sparse', size: stat.size, runs: [] },
    };
  }

  /** The path the container should hardlink `ino` to, when it has one already. */
  linkedPath(ino: number): string | undefined {
    return this.#inodePaths.get(ino);
  }

  /** Page in `[offset, offset + length)`, paying for the windows it misses. */
  async hydrate(path: string, offset: number, length: number): Promise<void> {
    await this.#residency.hydrate(path, offset, length);
  }

  /**
   * Page in every data byte of one file.
   *
   * WHAT A WRITE OWES BEFORE IT LANDS. A container that overwrites part of a
   * file it holds only part of would leave the rest reading as zeros, and the
   * next fence — which stages a file it has no boundary map for WHOLE — would
   * publish those zeros as content. So a write pages the file in first, and
   * then the path is the container's.
   */
  async hydrateWhole(path: string): Promise<void> {
    await this.#residency.hydrateWhole(path);
  }

  /** The path is the container's now: a write happened, and no sweep may
   *  reach bytes the head does not hold. */
  forget(path: string): void {
    this.#residency.forget(path);
  }

  /** Does this path still page in through this restore — a live placeholder
   *  or an already-registered resident file — or has the container's own
   *  write path taken it over (or has nothing ever named it)? A caller that
   *  wants to mark a path resident checks this first: re-registering one the
   *  residency ALREADY tracks would overwrite its real geometry with
   *  whatever the caller's local bytes currently look like, which for an
   *  unhydrated placeholder is zeros. */
  holds(path: string): boolean {
    return this.#residency.holds(path);
  }

  /** One file of the tree is clean and whole again: what a publish leaves. */
  registerResident(path: string, geometry: FileGeometry): void {
    this.#residency.registerResident(path, geometry);
  }

  /** Drop clean pages nothing has touched inside the window. */
  evict(request: EvictionRequest = {}): GcWork {
    return this.#residency.evict(request);
  }

  /** Resident data bytes: what an eviction could free right now. */
  get residentBytes(): number {
    return this.#residency.residentBytes;
  }

  hydration(): Hydration {
    return this.#residency.hydration();
  }

  work(): HydrateWork {
    return this.#residency.work();
  }

  gcWork(): GcWork {
    return this.#residency.gcWork();
  }
}
