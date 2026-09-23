/** Test machine: durable object store outliving containers, a disk a replacement blanks, and
 *  real `DevboxStorage`; `ContainerDied` is thrown by ports at seams named from the key layout. */

import { createHash } from 'node:crypto';

import * as v from 'valibot';

import { deltaCommand, type ShellReply as DeltaShellReply } from './delta-shell';
import { sessionShellRefusal } from './session-shell';
import {
  LiveTree,
  ancestorsOf,
  contentSize,
  paintedSegments,
  runBytes,
  sortedByPath,
  type LiveInode,
  type NodeEntry,
  type PosixMetadata,
  type TreeProperty,
} from './tree-model';
import { DELTA_MANIFEST_NAME, DeltaManifestSchema } from '../../src/chunked-delta';
import {
  baseObjectKey,
  ChainRecordAdvanced,
  chainStoreRoot,
  deltaObjectKey,
  snapshotChainStorage,
  type ChainState,
  type SnapshotChainPorts,
} from '../../src/snapshot-chain';
import {
  DEVBOX_RUNTIME_DIR,
  DEVBOX_WORKDIR,
  type DevboxStorage,
  type DevboxStrategyName,
} from '../../src/storage';

/** Derived through the strategy's exported helper, never spelled here, so there is no
 *  second copy of the layout to drift from. */
const STORE_ROOT = chainStoreRoot('boxes/conformance-box');

/** Must equal `lowerDeltaRoot` in `src/snapshot-chain.ts`, where `deltaLayerServed` looks;
 *  a layer mounted elsewhere is not seen as served and the next commit archives an empty upper. */
const CHAIN_DELTA_LAYER_ROOT = '/var/tmp/devbox/lower-delta';

const deltaLayerMountPoint = (chainId: string): string => `${CHAIN_DELTA_LAYER_ROOT}/${chainId}`;

/** The spot container was replaced mid-commit; not a failure the strategy can classify.
 *  Every later step of the abandoned operation fails too: its disk is gone (`ContainerDisk.dead`). */
export class ContainerDied extends Error {
  constructor(readonly seam: string) {
    super(`the container was replaced at ${seam}`);
    this.name = 'ContainerDied';
  }
}

/** What the SDK raises for any call against a stopped container. */
export class ContainerStopped extends Error {
  constructor(what: string) {
    super(`the container is not running, so ${what} cannot run`);
    this.name = 'ContainerStopped';
  }
}

/** The isolate was reset where it stood. The container, its disk and its
 *  mounts are untouched; only the code in flight is gone. */
export class IsolateReset extends Error {
  constructor(readonly seam: string) {
    super(`the isolate was reset at ${seam}`);
    this.name = 'IsolateReset';
  }
}

/** Bounds how often one operation may cross a durable sub-step, so a runaway retry loop
 *  fails by name at the excess visit instead of as a test timeout. */
export class SeamBudgetExceeded extends Error {
  constructor(readonly seam: string, readonly visits: number) {
    super(`one operation reached ${seam} ${visits} times, which is more than it may`);
    this.name = 'SeamBudgetExceeded';
  }
}

/** `reached` keeps an injection honest: an unreached seam passes a crash test by never
 *  crashing, so the battery asserts the armed seam was visited. */
export class DeathWatch {
  #armed: string | null = null;
  readonly reached: string[] = [];
  readonly #budgets = new Map<string, number>();
  #exhausted: SeamBudgetExceeded | null = null;

  arm(seam: string): void {
    this.#armed = seam;
  }

  get armed(): string | null {
    return this.#armed;
  }

  /** Refuse the run once `seam` has been reached more than `visits` times. */
  limit(seam: string, visits: number): void {
    this.#budgets.set(seam, visits);
  }

  visits(seam: string): number {
    return this.reached.filter(step => step === seam).length;
  }

  at(seam: string): void {
    this.#record(seam);

    if (this.#armed !== seam) return;
    this.#armed = null;
    throw new ContainerDied(seam);
  }

  /** Models a Durable Object reset after a durable write reached the container: the call
   *  never returns, the object comes back, and the container keeps its state (P1). */
  reset(seam: string): void {
    this.#record(seam);

    if (this.#armed !== seam) return;
    this.#armed = null;
    throw new IsolateReset(seam);
  }

  clear(): void {
    this.#armed = null;
    this.reached.length = 0;
    this.#budgets.clear();
    this.#exhausted = null;
  }

  /** Latched: a publication loop retries a failed completion mark, so a one-shot throw would spin.
   *  Once spent, every later sub-step refuses with the same named error, not a test timeout. */
  #record(seam: string): void {
    if (this.#exhausted !== null) throw this.#exhausted;
    this.reached.push(seam);
    const budget = this.#budgets.get(seam);

    if (budget === undefined) return;
    const visits = this.visits(seam);

    if (visits <= budget) return;
    this.#exhausted = new SeamBudgetExceeded(seam, visits);
    throw this.#exhausted;
  }
}

interface StoredObject {
  readonly bytes: Uint8Array;
  /** R2 mints one per upload and reports it from `head` forever after; a same-length
   *  replacement cannot copy it. */
  readonly version: string;
  /** Models R2 `customMetadata`, the `x-amz-meta-*` headers where s3fs keeps a file's mode,
   *  owner and times. */
  readonly meta: Readonly<Record<string, string>>;
}

interface StoreInventory {
  objects: number;
  bytes: number;
}

export interface RemoteOp {
  readonly op: 'get' | 'put' | 'head' | 'list' | 'delete';
  readonly key: string;
  /** Bytes that crossed the wire: the body of a get or put; 0 otherwise. */
  readonly bytes: number;
}

export class DurableStore {
  readonly objects = new Map<string, StoredObject>();
  /** Every mutation, in order. A crash-ordering assertion needs the order, not
   *  the end state. */
  readonly writes: string[] = [];
  /** Every remote op, reads included, in order; `RestoreWork`/`PublishWork` rows are windows here.
   *  Counting in the store, not in each arm, keeps one arm's row comparable with another's. */
  readonly ops: RemoteOp[] = [];
  #uploads = 0;

  put(key: string, bytes: Uint8Array, meta: Readonly<Record<string, string>> = {}): string {
    this.#uploads += 1;
    const version = `v${this.#uploads}`;
    this.objects.set(key, { bytes: bytes.slice(), version, meta: { ...meta } });
    this.writes.push(`put:${key}`);
    this.ops.push({ op: 'put', key, bytes: bytes.byteLength });

    return version;
  }

  get(key: string): Uint8Array | null {
    const held = this.objects.get(key);
    this.ops.push({ op: 'get', key, bytes: held?.bytes.byteLength ?? 0 });

    return held?.bytes ?? null;
  }

  meta(key: string): Readonly<Record<string, string>> | null {
    return this.objects.get(key)?.meta ?? null;
  }

  head(key: string): { size: number; digest: string; version: string } | null {
    this.ops.push({ op: 'head', key, bytes: 0 });
    const held = this.objects.get(key);

    if (held === undefined) return null;

    return {
      size: held.bytes.byteLength,
      digest: createHash('sha256').update(held.bytes).digest('hex'),
      version: held.version,
    };
  }

  delete(key: string): void {
    this.ops.push({ op: 'delete', key, bytes: 0 });

    if (this.objects.delete(key)) this.writes.push(`delete:${key}`);
  }

  list(prefix: string): string[] {
    this.ops.push({ op: 'list', key: prefix, bytes: 0 });

    return this.#keysUnder(prefix);
  }

  deletePrefix(prefix: string): number {
    const keys = this.list(prefix);

    for (const key of keys) this.delete(key);

    return keys.length;
  }

  inventory(prefix: string): StoreInventory {
    let objects = 0;
    let bytes = 0;

    for (const [key, object] of this.objects) {
      if (!key.startsWith(prefix)) continue;
      objects += 1;
      bytes += object.bytes.byteLength;
    }

    return { objects, bytes };
  }

  /** Keeps the upload version: bit rot and lifecycle truncation are not new uploads, so a
   *  check comparing only upload versions must not pass by accident. */
  corrupt(key: string, how: 'truncate' | 'flip'): void {
    const held = this.objects.get(key);

    if (held === undefined) throw new Error(`nothing to corrupt at ${key}`);
    const bytes = held.bytes.slice();

    if (how === 'flip') {
      if (bytes.byteLength === 0) throw new Error(`cannot flip a byte of empty ${key}`);
      bytes[Math.floor(bytes.byteLength / 2)] ^= 0xff;
      this.objects.set(key, { bytes, version: held.version, meta: held.meta });

      return;
    }

    this.objects.set(key, {
      bytes: bytes.subarray(0, Math.max(1, bytes.byteLength - 17)),
      version: held.version,
      meta: held.meta,
    });
  }

  /** Records no remote op: bookkeeping reads (`inventory`, a control-plane listing) are not
   *  the work a wake or a publish pays for. */
  #keysUnder(prefix: string): string[] {
    return [...this.objects.keys()].filter(key => key.startsWith(prefix)).sort();
  }
}

interface MountRow {
  readonly source: string;
  readonly fstype: string;
  readonly options: string;
}

interface OverlayRow {
  readonly lowers: readonly string[];
  readonly upper: string;
}

/** Models a squashfs image: parsed bytes refuse on corruption like squashfuse does, and entries
 *  carry only what squashfs stores (one mtime), so fidelity cannot exceed the deployed chain. */
const ArchiveMetadataSchema = v.strictObject({
  uid: v.number(),
  gid: v.number(),
  mtimeNs: v.string(),
  xattrs: v.record(v.string(), v.string()),
});

const ArchiveEntrySchema = v.strictObject({
  path: v.string(),
  kind: v.picklist(['file', 'dir', 'symlink']),
  mode: v.number(),
  ino: v.number(),
  metadata: ArchiveMetadataSchema,
  target: v.optional(v.string()),
  size: v.optional(v.number()),
  /** Data runs only: `[offset, base64 bytes]`. Holes are what is between them. */
  runs: v.optional(v.array(v.tuple([v.number(), v.string()]))),
});

const ArchiveSchema = v.strictObject({
  archive: v.literal(2),
  entries: v.array(ArchiveEntrySchema),
});

export class DiskFull extends Error {
  constructor(readonly path: string, readonly needed: number, readonly free: number) {
    super(`ENOSPC: ${path} needs ${needed} bytes and the disk has ${free} free`);
    this.name = 'DiskFull';
  }
}

/** One container's disk: plain files and full-fidelity trees share one quota; an over-quota
 *  write throws `DiskFull` before any effect lands. `dead` fails every call after replacement. */
export class ContainerDisk {
  readonly files = new Map<string, Uint8Array>();
  readonly dirs = new Set<string>([DEVBOX_WORKDIR, DEVBOX_RUNTIME_DIR]);
  readonly mounts = new Map<string, MountRow>();
  readonly overlays = new Map<string, OverlayRow>();
  readonly trees = new Map<string, LiveTree>();
  readonly execCalls: string[] = [];
  readonly processFaults: Array<{ match: RegExp; exitCode: number; stderr: string }> = [];
  readonly processFaultsReached: string[] = [];
  /** Plain files a mount serves on demand: present, readable, never charged. */
  readonly mountServed = new Set<string>();
  readonly whiteouts = new Map<string, Set<string>>();
  /** Every `mount` call this disk ever took, replacements included. */
  mountCalls = 0;
  /** The subset that mounted squashfs layers: restore replay units. */
  layerMountCalls = 0;
  /** Bytes this disk may hold, or null for a disk that never fills. */
  quotaBytes: number | null = null;
  usedBytes = 0;
  dead = false;
  stopped = false;

  #alive(what: string): void {
    if (this.dead) throw new ContainerDied(`a dead container was asked to ${what}`);

    if (this.stopped) throw new ContainerStopped(what);
  }

  /** Models P1: termination drops local bytes; call history, faults and lifecycle flags stay.
   *  The disk object survives so held references observe the loss rather than a swap. */
  discardLocalState(): void {
    this.files.clear();
    this.dirs.clear();
    this.dirs.add(DEVBOX_WORKDIR);
    this.dirs.add(DEVBOX_RUNTIME_DIR);
    this.mounts.clear();
    this.overlays.clear();
    this.trees.clear();
    this.mountServed.clear();
    this.whiteouts.clear();
    this.usedBytes = 0;
  }

  charge(delta: number, path = '(tree)'): void {
    // tmpfs lives in memory and layer mounts read through the store, so neither costs disk quota;
    // decided here so no writer needs to know which paths are disk.
    if (path.startsWith('/dev/shm/') || path === '/dev/shm') return;

    if (path.startsWith('/var/tmp/devbox/lower-base') || path.startsWith(`${CHAIN_DELTA_LAYER_ROOT}/`) || path.startsWith('/var/tmp/devbox/lower-empty') || path === '/var/tmp/devbox/block-lower') return;

    if (delta > 0 && this.quotaBytes !== null && this.usedBytes + delta > this.quotaBytes) {
      throw new DiskFull(path, delta, Math.max(0, this.quotaBytes - this.usedBytes));
    }

    this.usedBytes += delta;
  }

  tree(dir: string): LiveTree {
    let held = this.trees.get(dir);

    if (held === undefined) {
      held = new LiveTree((delta) => this.charge(delta, dir));
      this.trees.set(dir, held);
      this.mkdirp(dir);
    }

    return held;
  }

  mkdirp(path: string): void {
    this.#alive(`mkdir ${path}`);

    for (const step of ancestors(path)) this.dirs.add(step);
  }

  rmrf(path: string): void {
    this.#alive(`rm -rf ${path}`);
    const owner = this.#overlayOwner(path);

    if (owner !== undefined) {
      // Through the merged view: the upper's subtree goes, and a name a lower
      // still holds is masked, subtree included.
      this.tree(owner.overlay.upper).remove(owner.relative);
      this.#mask(owner);

      return;
    }

    for (const [key, bytes] of this.files) {
      if (key === path || key.startsWith(`${path}/`)) {
        this.files.delete(key);

        if (!this.mountServed.has(key)) this.charge(-bytes.byteLength, key);
        this.mountServed.delete(key);
      }
    }

    for (const key of this.dirs) {
      if (key === path || key.startsWith(`${path}/`)) this.dirs.delete(key);
    }

    for (const [dir, tree] of this.trees) {
      if (dir === path || dir.startsWith(`${path}/`)) {
        tree.clear();
        this.trees.delete(dir);
      }
    }
  }

  exists(path: string): boolean {
    this.#alive(`stat ${path}`);

    if (this.dirs.has(path) || this.files.has(path)) return true;

    return this.#treeAt(path) !== undefined;
  }

  writeFile(path: string, bytes: Uint8Array): void {
    this.#alive(`write ${path}`);
    const owner = this.#overlayOwner(path);

    if (owner !== undefined) {
      this.tree(owner.overlay.upper).writeFile(owner.relative, bytes);
      this.whiteouts.get(owner.point)?.delete(owner.relative);

      return;
    }

    const held = this.files.get(path);
    const heldCharge = held === undefined || this.mountServed.has(path) ? 0 : held.byteLength;
    this.charge(bytes.byteLength - heldCharge, path);
    this.mountServed.delete(path);
    this.mkdirp(parentOf(path));
    this.files.set(path, bytes.slice());
  }

  /** An s3fs mount fetches on demand, so a mount-served file occupies no local disk:
   *  never charged to the quota, never refunded on unmount. */
  serveFromMount(path: string, bytes: Uint8Array): void {
    this.#alive(`serve ${path}`);
    const held = this.files.get(path);

    if (held !== undefined && !this.mountServed.has(path)) this.charge(-held.byteLength);
    this.mountServed.add(path);
    this.mkdirp(parentOf(path));
    this.files.set(path, bytes);
  }

  readFile(path: string): Uint8Array | undefined {
    this.#alive(`read ${path}`);
    const direct = this.files.get(path);

    if (direct !== undefined) return direct;
    const located = this.#treeAt(path);

    if (located === undefined || located.node.kind !== 'file' || located.node.content === undefined) return undefined;
    const content = located.node.content;

    if (content.kind === 'dense') return content.bytes;
    const out = new Uint8Array(content.size);

    for (const run of content.runs) out.set(run.bytes.subarray(0, Math.max(0, content.size - run.offset)), run.offset);

    return out;
  }

  removeFile(path: string): void {
    this.#alive(`unlink ${path}`);
    const owner = this.#overlayOwner(path);

    if (owner !== undefined) {
      this.tree(owner.overlay.upper).remove(owner.relative);
      this.#mask(owner);

      return;
    }

    const held = this.files.get(path);

    if (held !== undefined && !this.mountServed.has(path)) this.charge(-held.byteLength);
    this.mountServed.delete(path);
    this.files.delete(path);
  }

  /** The node at `path` as a reader sees it: through the merged view of an
   *  overlay, or the tree whose directory holds it. */
  node(path: string): LiveInode | undefined {
    this.#alive(`stat ${path}`);

    return this.#treeAt(path)?.node;
  }

  /** A write through an overlay lands in its upper and unmasks the name, as a real create does;
   *  else the deepest tree directory above holds it. Unserved paths are plain files. */
  writable(path: string): { readonly tree: LiveTree; readonly relative: string } | undefined {
    this.#alive(`write ${path}`);
    const owner = this.#overlayOwner(path);

    if (owner !== undefined) {
      this.whiteouts.get(owner.point)?.delete(owner.relative);

      return { tree: this.tree(owner.overlay.upper), relative: owner.relative };
    }

    const holder = this.#treeAbove(path);

    return holder === undefined ? undefined : { tree: holder.tree, relative: path.slice(holder.dir.length + 1) };
  }

  entries(dir: string): string[] {
    this.#alive(`list ${dir}`);

    return this.snapshot(dir).filter((entry) => entry.kind === 'file').map((entry) => entry.path);
  }

  snapshot(dir: string): NodeEntry[] {
    this.#alive(`walk ${dir}`);
    const overlay = this.overlays.get(dir);

    if (overlay !== undefined) {
      const merged = new Map<string, NodeEntry>();
      const masked = this.whiteouts.get(dir) ?? new Set<string>();
      let inoBase = 0;

      // Lowers merge oldest first so a newer layer's row wins; inode ids are offset per layer.
      // Whiteouts mask lowers only, before the upper merges, so the upper's names are never hidden.
      for (const layer of [...overlay.lowers].reverse()) {
        inoBase = this.#mergeLayer(merged, layer, inoBase);
      }

      for (const path of merged.keys()) {
        if (isMasked(masked, path)) merged.delete(path);
      }

      this.#mergeLayer(merged, overlay.upper, inoBase);

      return sortedByPath([...merged.values()]);
    }

    const tree = this.trees.get(dir);

    if (tree !== undefined) return tree.snapshot();
    const above = this.#treeAbove(dir);

    if (above !== undefined) {
      const prefix = `${dir.slice(above.dir.length + 1)}/`;

      return above.tree.snapshot()
        .filter((entry) => entry.path.startsWith(prefix))
        .map((entry) => ({ ...entry, path: entry.path.slice(prefix.length) }));
    }

    const rows: NodeEntry[] = [];
    let ino = 1;

    for (const [key, bytes] of [...this.files].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (!key.startsWith(`${dir}/`)) continue;
      rows.push({
        path: key.slice(dir.length + 1),
        kind: 'file',
        mode: 0o644,
        ino: ino++,
        metadata: { uid: 0, gid: 0, atimeNs: '0', mtimeNs: '0', ctimeNs: '0', xattrs: {} },
        content: { kind: 'dense', bytes },
      });
    }

    return rows;
  }

  copyTree(from: string, to: string): void {
    this.#alive(`cp -a ${from} ${to}`);
    this.tree(to).plant(this.snapshot(from));
  }

  /** Stands in for mksquashfs: a lost byte must fail the parse, as a truncated squashfs won't mount.
   *  Sparse files are stored as data runs only; mksquashfs does not store a hole either. */
  pack(dir: string): Uint8Array {
    const entries = this.snapshot(dir).map((entry): v.InferOutput<typeof ArchiveEntrySchema> => {
      const { metadata } = entry;

      if (metadata === undefined) throw new Error(`pack: ${entry.path} carries no metadata to archive`);

      const row: v.InferOutput<typeof ArchiveEntrySchema> = {
        path: entry.path,
        kind: entry.kind,
        mode: entry.mode,
        ino: entry.ino,
        metadata: { uid: metadata.uid, gid: metadata.gid, mtimeNs: metadata.mtimeNs, xattrs: { ...metadata.xattrs } },
      };

      if (entry.kind === 'symlink') row.target = entry.target;

      if (entry.kind === 'file' && entry.content !== undefined) {
        row.size = contentSize(entry.content);
        row.runs = paintedSegments(entry.content).segments
          .filter((segment) => !segment.zeros)
          .map((segment) => [segment.start, bytesToBase64(segment.view)]);
      }

      return row;
    });

    return new TextEncoder().encode(JSON.stringify({ archive: 2, entries }));
  }

  unpack(bytes: Uint8Array, dir: string): void {
    // Stored bytes are untrusted even though this module wrote them: a truncated archive
    // must fail to parse exactly as a truncated squashfs fails to mount.
    let archive: v.InferOutput<typeof ArchiveSchema>;

    try {
      archive = v.parse(ArchiveSchema, JSON.parse(decoder.decode(bytes)));
    } catch (error) {
      throw new Error('the archive superblock is not readable', { cause: error });
    }

    const entries = archive.entries.map((row): NodeEntry => {
      // squashfuse reports the one stored time for all three.
      const metadata: PosixMetadata = {
        uid: row.metadata.uid,
        gid: row.metadata.gid,
        atimeNs: row.metadata.mtimeNs,
        mtimeNs: row.metadata.mtimeNs,
        ctimeNs: row.metadata.mtimeNs,
        xattrs: row.metadata.xattrs,
      };

      const base = { path: row.path, kind: row.kind, mode: row.mode, ino: row.ino, metadata };

      if (row.kind === 'symlink') return { ...base, target: row.target };

      if (row.kind !== 'file') return base;
      const runs = (row.runs ?? []).map(([offset, body]) => ({ offset, bytes: Uint8Array.from(Buffer.from(body, 'base64')) }));
      const size = row.size ?? 0;
      const dense = runs.length === 1 && runs[0].offset === 0 && runs[0].bytes.byteLength === size;

      return {
        ...base,
        content: dense ? { kind: 'dense', bytes: runs[0].bytes } : { kind: 'sparse', size, runs },
      };
    });

    const tree = this.tree(dir);
    tree.clear();
    tree.plant(entries);
  }

  procMounts(): string {
    this.#alive('read /proc/mounts');

    return [...this.mounts].map(
      ([point, row]) => `${row.source} ${point} ${row.fstype} ${row.options} 0 0`,
    ).join('\n');
  }

  mount(point: string, row: MountRow): void {
    this.#alive(`mount ${point}`);
    this.mountCalls += 1;

    if (row.fstype.includes('squashfuse')) this.layerMountCalls += 1;
    this.mkdirp(point);
    this.mounts.set(point, row);
  }

  unmount(point: string): void {
    this.#alive(`unmount ${point}`);
    this.mounts.delete(point);
    this.overlays.delete(point);
    this.whiteouts.delete(point);
  }

  mountOverlay(point: string, overlay: OverlayRow): void {
    this.mount(point, {
      source: 'fuse-overlayfs',
      fstype: 'fuse.fuse-overlayfs',
      options: 'rw,nosuid',
    });
    this.overlays.set(point, overlay);
    const whiteouts = this.whiteouts.get(overlay.upper);

    if (whiteouts !== undefined) this.whiteouts.set(point, new Set(whiteouts));
    this.tree(overlay.upper);
  }

  #mergeLayer(merged: Map<string, NodeEntry>, layer: string, inoBase: number): number {
    let highest = 0;
    const rows = this.snapshot(layer);

    for (const entry of rows) {
      if (entry.path.split('/').at(-1) !== '.wh..wh..opq') continue;
      const parent = entry.path.slice(0, Math.max(0, entry.path.lastIndexOf('/')));

      for (const path of merged.keys()) if (parent === '' || path.startsWith(`${parent}/`)) merged.delete(path);
    }

    for (const entry of rows) {
      if (entry.path.split('/').at(-1) === '.wh..wh..opq') continue;
      highest = Math.max(highest, entry.ino);

      if (entry.kind !== 'dir' && merged.get(entry.path)?.kind === 'dir') {
        for (const path of merged.keys()) if (path.startsWith(`${entry.path}/`)) merged.delete(path);
      }

      merged.set(entry.path, { ...entry, ino: entry.ino + inoBase });
    }

    return inoBase + highest;
  }

  /** Mask a merged name the upper no longer holds, when a lower still does:
   *  fuse-overlayfs mints a whiteout only over something. */
  #mask(owner: { point: string; overlay: OverlayRow; relative: string }): void {
    const below = owner.overlay.lowers.some((layer) => {
      const tree = this.trees.get(layer);

      return tree !== undefined && tree.paths().some((path) => path === owner.relative || path.startsWith(`${owner.relative}/`));
    });

    if (!below) return;
    let masked = this.whiteouts.get(owner.point);

    if (masked === undefined) {
      masked = new Set();
      this.whiteouts.set(owner.point, masked);
    }

    masked.add(owner.relative);
  }

  /** Deepest match wins so a layer mounted inside another tree's directory answers for its names. */
  #treeAbove(path: string): { dir: string; tree: LiveTree } | undefined {
    let deepest: { dir: string; tree: LiveTree } | undefined;

    for (const [dir, tree] of this.trees) {
      if (path.startsWith(`${dir}/`) && (deepest === undefined || dir.length > deepest.dir.length)) deepest = { dir, tree };
    }

    return deepest;
  }

  #treeAt(path: string): { node: LiveInode } | undefined {
    const owner = this.#overlayOwner(path);

    if (owner !== undefined) {
      if (owner.relative.split('/').at(-1) === '.wh..wh..opq') return undefined;
      const upper = this.trees.get(owner.overlay.upper)?.node(owner.relative);

      if (upper !== undefined) return { node: upper };
      const masked = this.whiteouts.get(owner.point);

      if (masked !== undefined && isMasked(masked, owner.relative)) return undefined;

      for (const layer of owner.overlay.lowers) {
        const node = this.node(`${layer}/${owner.relative}`);

        if (node !== undefined) return { node };
        const parents = ['', ...ancestors(owner.relative).slice(0, -1).map(parent => parent.slice(1))];

        if (parents.some(parent => this.node(`${layer}/${parent === '' ? '' : `${parent}/`}.wh..wh..opq`) !== undefined)) return undefined;
      }

      return undefined;
    }

    const above = this.#treeAbove(path);

    if (above === undefined) return undefined;
    const node = above.tree.node(path.slice(above.dir.length + 1));

    return node === undefined ? undefined : { node };
  }

  #overlayOwner(path: string): { point: string; overlay: OverlayRow; relative: string } | undefined {
    for (const [point, overlay] of this.overlays) {
      if (path.startsWith(`${point}/`)) {
        return { point, overlay, relative: path.slice(point.length + 1) };
      }
    }

    return undefined;
  }
}

function ancestors(path: string): string[] {
  const parts = path.split('/').filter(part => part !== '');
  const steps: string[] = [];
  let at = '';

  for (const part of parts) {
    at = `${at}/${part}`;
    steps.push(at);
  }

  return steps;
}

function isMasked(masked: ReadonlySet<string>, path: string): boolean {
  if (masked.has(path)) return true;

  for (const ancestor of ancestors(path)) {
    if (masked.has(ancestor.slice(1))) return true;
  }

  return false;
}

function parentOf(path: string): string {
  const at = path.lastIndexOf('/');

  return at <= 0 ? '/' : path.slice(0, at);
}

function bytesToBase64(bytes: Uint8Array): string {
  let text = '';

  for (const byte of bytes) text += String.fromCharCode(byte);

  return btoa(text);
}

const encoder = new TextEncoder();

const decoder = new TextDecoder();

/** Async by contract: an eager arm answers from memory, a lazy one pages in on first touch,
 *  so a read can fault and cells for lazy and eager arms share the same code. */
export interface Workspace {
  write(path: string, text: string): Promise<void>;
  read(path: string): Promise<string | undefined>;
  remove(path: string): Promise<void>;
  /** Sorted file paths for text fixtures; lists structure only, reading no file's bytes,
   *  so pairing it with `read` per path pays for exactly the files a caller names. */
  paths(): Promise<readonly string[]>;
  /** Plants at full fidelity: entries sharing an `ino` share one inode, sparse content as runs.
   *  Existing paths are replaced. */
  plant(entries: readonly NodeEntry[]): Promise<void>;
  /** The served tree at the arm's fidelity, every byte resident; inode ids share where served
   *  inodes share. A lazy arm pages in everything to answer this. */
  snapshot(): Promise<readonly NodeEntry[]>;
  /** A lazy arm pages the target in first: bytes outside the write stay the head's, and a
   *  fence that staged a placeholder's zeros would publish them as content. */
  pwrite(path: string, offset: number, bytes: Uint8Array): Promise<void>;
}

export interface DeclaredObject {
  readonly key: string;
  readonly byteLength: number;
  /** What the object is called in a refusal: the key, or the digest a
   *  content-addressed store names it by. */
  readonly names: readonly string[];
}

export interface ControlPlacement {
  /** Object keys that carry control metadata: envelopes, cursors, heads. */
  readonly objectKeys: readonly string[];
  /** Control the Durable Object holds outside the store entirely. */
  readonly rows: readonly string[];
  readonly head: string | null;
}

// Every work row is derived from what the machine observes (op log, mount count, builder
// stats, fenced bytes), never from an arm's self-report, so no counter flatters its arm.

export interface SealWork {
  /** Bytes the fence copied into the stage: the whole tree. */
  readonly bytesStaged: number;
  readonly bytesChunked: number;
  readonly chunksHashed: number;
  /** Tree nodes serialized and hashed. */
  readonly nodesRewritten: number;
  /** Files staged whole rather than by dirty cluster. */
  readonly wholeFiles: number;
}

export interface PublishWork {
  readonly objectsPut: number;
  readonly bytesPut: number;
  readonly casAttempts: number;
}

export interface RestoreWork {
  /** Equals `totalRemoteOps` while the store answers synchronously and restores await each op;
   *  kept separate so a concurrent restore reports the difference. */
  readonly serialRemoteOps: number;
  readonly totalRemoteOps: number;
  /** Bytes read from keys outside every payload prefix the arm names. */
  readonly metadataBytes: number;
  /** Bytes read from keys under a payload prefix. */
  readonly payloadBytes: number;
  /** Entries the restore materialized on the container. */
  readonly cpuSteps: number;
  readonly mounts: number;
  /** Delta layers served over a base. */
  readonly replayUnits: number;
}

export interface WorkRows {
  readonly seal: SealWork;
  readonly publish: PublishWork;
  readonly restore: RestoreWork;
}

export interface Refusal {
  readonly reason: string;
}

/** A held finalize: `entered` settles when the commit reaches the gate. */
export interface HeldFinalize {
  readonly entered: Promise<void>;
  readonly release: () => void;
}

/** A second container on the same box: the same durable store and rows, its
 *  own disk, its own daemon, its own strategy instance. */
export interface ArmBoot {
  storage(): DevboxStorage;
  readonly workspace: Workspace;
  readonly failures: readonly string[];
  /** Holds the next commit at the DO-side finalize: staged and uploaded, draft not yet published.
   *  `entered` settles once held; `release` resumes that held commit. */
  holdFinalize(): HeldFinalize;
  /** A blank disk, the same durable store, and the same durable rows. */
  replaceContainer(): void;
}

/** Cases take keys, prefixes and mount paths from the strategy's own layout API via the arm;
 *  a test carrying its own copy of the layout cannot see a placement bug. */
export interface ConformanceArm extends ArmBoot {
  readonly name: DevboxStrategyName;
  readonly durable: DurableStore;
  readonly deaths: DeathWatch;
  /** The container stops where it stands: no teardown, no replacement. */
  stopContainer(): void;
  /** A new strategy instance over the SAME container: disk, daemon and mounts intact (P1).
   *  The opposite of a replacement; this is what a real isolate reset does (D6). */
  resetIsolate(): void;
  /** A second live container on this box, beside the current one. */
  secondBoot(): ArmBoot;
  disk(): ContainerDisk;
  /** The commit sub-steps this strategy exposes, in the order it performs
   *  them. Derived from its own key layout, never invented here. */
  readonly commitSeams: readonly string[];
  /** The sub-step where one commit promotes its work, exactly once per call; naming it lets a
   *  battery catch a retry loop that publishes forever as a defect, not a timeout. */
  readonly publishSeam: string;
  /** The attach sub-steps an isolate reset can land after, in order. Each
   *  is a port whose effect is on the container when the reset lands. */
  readonly attachSeams: readonly string[];
  dieAt(seam: string): void;
  /** Prefixes the container owns through its mount. */
  payloadPrefixes(): readonly string[];
  controlPlane(): Promise<ControlPlacement>;
  declaredPayload(): Promise<readonly DeclaredObject[]>;
  /** Every committed head the ledger names; the invariant is exactly one. */
  committedHeads(): Promise<readonly string[]>;
  /** The counted-work rows for the last checkpoint and the last attach. */
  work(): WorkRows;
  /** Evicts clean local bytes (the disk-pressure escape); returns the clean bytes it found.
   *  An arm without this hook can only refuse when full. */
  evictCleanBytes?(): number;
  readonly refusedProperties: Readonly<Partial<Record<TreeProperty, Refusal>>>;
  readonly refusedCells: Readonly<Record<string, Refusal>>;
}

interface OpWindow {
  readonly from: number;
}

function publishWorkSince(durable: DurableStore, window: OpWindow, casAttempts: number): PublishWork {
  let objectsPut = 0;
  let bytesPut = 0;

  for (const op of durable.ops.slice(window.from)) {
    if (op.op !== 'put') continue;
    objectsPut += 1;
    bytesPut += op.bytes;
  }

  return { objectsPut, bytesPut, casAttempts };
}

function restoreWorkSince(
  durable: DurableStore,
  window: OpWindow,
  payloadPrefixes: readonly string[],
  local: { readonly mounts: number; readonly cpuSteps: number; readonly replayUnits: number },
): RestoreWork {
  let total = 0;
  let metadataBytes = 0;
  let payloadBytes = 0;

  for (const op of durable.ops.slice(window.from)) {
    if (op.op === 'put' || op.op === 'delete') continue;
    total += 1;

    if (payloadPrefixes.some((prefix) => op.key.startsWith(prefix))) payloadBytes += op.bytes;
    else metadataBytes += op.bytes;
  }

  return {
    serialRemoteOps: total,
    totalRemoteOps: total,
    metadataBytes,
    payloadBytes,
    cpuSteps: local.cpuSteps,
    mounts: local.mounts,
    replayUnits: local.replayUnits,
  };
}


function withOptionalMembers(raw: DevboxStorage, metered: Pick<DevboxStorage, 'attach' | 'checkpoint' | 'discard'>): DevboxStorage {
  const storage: DevboxStorage = { ...metered };
  const detach = raw.detach;

  if (detach !== undefined) storage.detach = async () => await detach.call(raw);

  return storage;
}

const NO_SEAL: SealWork = { bytesStaged: 0, bytesChunked: 0, chunksHashed: 0, nodesRewritten: 0, wholeFiles: 0 };

const NO_PUBLISH: PublishWork = { objectsPut: 0, bytesPut: 0, casAttempts: 0 };

const NO_RESTORE: RestoreWork = {
  serialRemoteOps: 0, totalRemoteOps: 0, metadataBytes: 0, payloadBytes: 0, cpuSteps: 0, mounts: 0, replayUnits: 0,
};


/** `chunksHashed` counts `chunkBytes` windows over data, holes excluded (fixed-size chunker).
 *  `nodesRewritten` excludes the manifest's envelope dirs, which every publication writes. */
function wholeTreeSeal(entries: readonly NodeEntry[], chunkBytes: number): SealWork {
  let bytesStaged = 0;
  let chunksHashed = 0;
  let wholeFiles = 0;
  const seen = new Set<number>();

  for (const entry of entries) {
    if (entry.kind !== 'file' || entry.content === undefined || seen.has(entry.ino)) continue;
    seen.add(entry.ino);
    wholeFiles += 1;
    bytesStaged += runBytes(entry.content);

    for (const segment of paintedSegments(entry.content).segments) {
      if (!segment.zeros) chunksHashed += Math.ceil((segment.end - segment.start) / chunkBytes);
    }
  }

  let envelope = 0;

  if (entries.some((entry) => entry.path === DELTA_MANIFEST_NAME)) {
    const home = DELTA_MANIFEST_NAME.slice(0, DELTA_MANIFEST_NAME.lastIndexOf('/'));
    envelope = entries.filter((entry) => entry.kind === 'dir'
      && (entry.path === home || home.startsWith(`${entry.path}/`) || parentOf(entry.path) === home)).length;
  }

  return { bytesStaged, bytesChunked: bytesStaged, chunksHashed, nodesRewritten: entries.length - envelope, wholeFiles };
}

export const HARNESS_OWNED_CELLS = {
  '6.19': { reason: 'owned by the devbox-harness suites: stop then wake on the same instance needs the Devbox class and the platform stand-in' },
} satisfies Readonly<Record<string, Refusal>>;

/** One deterministic pause at a port. A cell holds, waits until the operation
 *  reaches it, drives the competing boot, then releases the old operation. */
class OneShotGate {
  #waiting: Promise<void> | null = null;
  #release: (() => void) | null = null;
  #entered: (() => void) | null = null;

  hold(): HeldFinalize {
    if (this.#waiting !== null) throw new Error('a finalize gate is already held');
    this.#waiting = new Promise<void>((resolve) => { this.#release = resolve; });
    const entered = new Promise<void>((resolve) => { this.#entered = resolve; });

    return {
      release: () => {
        const release = this.#release;

        if (release === null) return;
        this.#release = null;
        this.#waiting = null;
        release();
      },
      entered,
    };
  }

  async cross(): Promise<void> {
    const waiting = this.#waiting;

    if (waiting === null) return;
    const entered = this.#entered;
    this.#entered = null;
    entered?.();
    await waiting;
  }
}


/** An arm explicitly refused one named cell. The matrix accepts this only
 *  when the arm's declaration names the SAME cell with the SAME reason. */
export class ArmRefused extends Error {
  constructor(readonly cell: string, readonly reason: string) {
    super(`${cell} refused: ${reason}`);
    this.name = 'ArmRefused';
  }
}

/** Each arm handles one command the strategy really issues and acts on real bytes, so
 *  "the exact bytes came back" asserts the chain rather than a stub. */
type ShellReply = DeltaShellReply;

const shellOk = (stdout = ''): ShellReply => ({ stdout, stderr: '', exitCode: 0 });

const shellFail = (stderr: string): ShellReply => ({ stdout: '', stderr, exitCode: 1 });

/** Answers pack, publish and space gate as the real commands do: `<exit> <bytes>` on stdout,
 *  their own words on stderr. Undefined for any other command. */
function checkpointCommand(
  command: string,
  disk: ContainerDisk,
  publish: (archivePath: string, mountedPath: string) => number | undefined,
  publishEgress: (archivePath: string, objectUrl: string) => { landed: number } | { refused: string } | undefined,
): ShellReply | undefined {
  const squash = /mksquashfs '(?<source>[^']+)' '(?<archive>[^']+)'/.exec(command)?.groups;

  if (squash !== undefined) {
    const archive = disk.pack(squash.source);

    try {
      disk.writeFile(squash.archive, archive);
    } catch (error) {
      // Full disk: mksquashfs reports a non-zero rc on stdout and its own words on stderr,
      // as the real command does.
      if (!(error instanceof DiskFull)) throw error;

      return { stdout: '1 0', stderr: `FATAL ERROR: Failed to write to output filesystem: ${error.message}`, exitCode: 0 };
    }

    return shellOk(`0 ${archive.byteLength}`);
  }

  // The container copies its staged archive onto the store mount; `conv=fsync` makes the exit code
  // the upload's success, and the same command creates the generation directory for s3fs.
  const published = /dd if='(?<archive>[^']+)' of='(?<mounted>[^']+)' bs=4M conv=fsync;/
    .exec(command)?.groups;

  if (published !== undefined) {
    const landed = publish(published.archive, published.mounted);

    // Mirrors the real command: `<exit> <bytes>` on stdout either way; dd's failure is a
    // non-zero code there, not a thrown shell error.
    if (landed === undefined) {
      return {
        stdout: '1 0',
        stderr: `dd: can't open '${published.archive}': No such file or directory`,
        exitCode: 0,
      };
    }

    return shellOk(`0 ${landed}`);
  }

  // Answers the egress PUT (D15) the way the publisher's wrapper reports it:
  // `<rc> <bytes> <etag>` on stdout, the store's words on stderr.
  const egress = /bun '(?<script>[^']*devbox-publish\.mjs)' '(?<archive>[^']+)' '(?<url>[^']+)' \d+/
    .exec(command)?.groups;

  if (egress !== undefined) {
    const landed = publishEgress(egress.archive, egress.url);

    if (landed !== undefined && 'refused' in landed) {
      return { stdout: '1 ', stderr: landed.refused, exitCode: 0 };
    }

    if (landed === undefined) {
      return {
        stdout: '2 ',
        stderr: `no archive at ${egress.archive}`,
        exitCode: 0,
      };
    }

    return shellOk(`0 ${landed.landed} "etag-${landed.landed}"`);
  }

  if (command.includes('df -Pk')) {
    // The disk-space reply is honest: need is the source directory's data bytes, free is what
    // the quota leaves; without a quota the disk never fills and the gate never refuses.
    const source = /find '(?<source>[^']+)'/.exec(command)?.groups?.source;

    const need = source === undefined ? 1 : Math.max(1, disk.snapshot(source).reduce(
      (sum, entry) => sum + (entry.content === undefined ? 0 : runBytes(entry.content)), 0,
    ));

    const free = disk.quotaBytes === null ? Number.MAX_SAFE_INTEGER : Math.max(0, disk.quotaBytes - disk.usedBytes);

    return shellOk(`${need} ${free}`);
  }

  return undefined;
}

/** The upper's metadata walk: content is never read, so holes cost nothing and a large sparse
 *  file is one row. */
function upperWalkDigest(disk: ContainerDisk): string {
  const rows = disk.snapshot(`${DEVBOX_RUNTIME_DIR}/upper`).map((entry) => [
    entry.ino, entry.kind, entry.mode, entry.content === undefined ? 0 : contentSize(entry.content),
    entry.metadata?.mtimeNs ?? '0', entry.metadata?.ctimeNs ?? '0', entry.target ?? '', entry.path,
  ].join('\0'));

  return createHash('sha256').update(rows.length === 0 ? 'empty' : rows.sort().join('\0')).digest('hex');
}

function mountCommand(command: string, disk: ContainerDisk, deaths: DeathWatch): ShellReply | undefined {
  const unquote = (value: string): string => value.replace(/^'|'$/g, '');

  if (command === 'cat /proc/mounts') return shellOk(disk.procMounts());

  if (command.includes('awk -v r=')) {
    const root = unquote(/awk -v r='(?<root>[^']+)'/.exec(command)?.groups?.root ?? '');

    for (const point of [...disk.mounts.keys()].filter((path) => path.startsWith(root))) {
      disk.unmount(point);
    }

    return shellOk();
  }

  const released = /\/usr\/bin\/fusermount3 -u(?:z)? '(?<path>[^']+)'/.exec(command)?.groups?.path;

  if (released !== undefined) {
    disk.unmount(unquote(released));

    return shellOk();
  }

  const layer = /squashfuse '(?<archive>[^']+)' '(?<point>[^']+)'/.exec(command)?.groups;

  if (layer !== undefined) {
    const bytes = disk.readFile(layer.archive);

    if (bytes === undefined) return shellFail(`bad mount point: ${layer.archive} is absent`);

    try {
      disk.unpack(bytes, layer.point);
    } catch (error) {
      return shellFail(`squashfuse: ${error instanceof Error ? error.message : String(error)}`);
    }

    disk.mount(layer.point, { source: layer.archive, fstype: 'fuse.squashfuse', options: 'ro' });
    // Isolate reset fires after the mount lands: the layer stays mounted on the container disk (P1).
    deaths.reset('attach:after-layer-mount');

    return shellOk();
  }

  const overlay = /fuse-overlayfs -o lowerdir=(?<lowers>.+?),upperdir=(?<upper>[^,]+),workdir=[^ ]+ (?<dir>'[^']+')$/
    .exec(command)?.groups;

  if (overlay !== undefined) {
    disk.mountOverlay(unquote(overlay.dir), {
      lowers: overlay.lowers.split(':').map(unquote),
      upper: unquote(overlay.upper),
    });
    deaths.reset('attach:after-overlay');

    return shellOk();
  }

  return undefined;
}

function processFaultReply(disk: ContainerDisk, command: string): ShellReply | undefined {
  const fault = disk.dead || disk.stopped ? undefined : disk.processFaults.find((entry) => entry.match.test(command));

  if (fault === undefined) return undefined;

  disk.processFaultsReached.push(command);

  return { stdout: '', stderr: fault.stderr, exitCode: fault.exitCode };
}

function chainExec(
  disk: ContainerDisk,
  deaths: DeathWatch,
  /** Publish a staged archive through the s3fs mount and answer what landed,
   *  or undefined when the source is not there for `dd` to read. */
  publish: (archivePath: string, mountedPath: string) => number | undefined,
  /** Publishes a staged archive via the mount's egress host; answers the byte count, the
   *  refusal's stderr words, or undefined when the archive is absent. */
  publishEgress: (archivePath: string, objectUrl: string) => { landed: number } | { refused: string } | undefined,
) {
  const unquote = (value: string): string => value.replace(/^'|'$/g, '');

  return async (command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
    disk.execCalls.push(command);
    // The session shell first: a command it would refuse never reaches a
    // strategy's answer, on a deployment or here. See `session-shell.ts`.
    const refused = sessionShellRefusal(command);

    if (refused !== undefined) throw refused;
    const fault = processFaultReply(disk, command);

    if (fault !== undefined) return fault;

    const ok = shellOk;

    if (command.startsWith('# devbox-tick-probe-v1\n')) return ok(`${disk.procMounts()}\0${upperWalkDigest(disk)}`);
    const delta = deltaCommand(command, disk);

    if (delta !== undefined) return delta;

    const exists = /^test -e '(?<path>[^']+)'/.exec(command)?.groups?.path;

    if (exists !== undefined) return ok(disk.exists(exists) ? 'yes' : 'no');

    // Bounded visibility probe: the listed subtree is read off the command, not a copied
    // constant, so a strategy that moves its mount is served from the path it really asks for.
    if (command.includes('printf ready')) {
      const awaited = /test -e '(?<path>[^']+)'/.exec(command)?.groups?.path ?? '';

      if (disk.readFile(awaited) !== undefined) return ok('ready');
      const listed = /ls -1A '(?<path>[^']+)'/.exec(command)?.groups?.path ?? '';

      return ok(`missing ${disk.entries(listed).join(' ')}`);
    }

    const mounted = mountCommand(command, disk, deaths);

    if (mounted !== undefined) return mounted;

    const seed = /^cp -a '(?<lower>[^']+)\/\.' '(?<upper>[^']+)\//.exec(command)?.groups;

    if (seed !== undefined) {
      disk.copyTree(seed.lower, seed.upper);

      return ok();
    }

    const checkpoint = checkpointCommand(command, disk, publish, publishEgress);

    if (checkpoint !== undefined) return checkpoint;

    if (command.includes('sha256sum') && command.includes('sort -z')) return ok(upperWalkDigest(disk));

    const statted = /^stat -c %s '(?<path>[^']+)'/.exec(command)?.groups?.path;

    if (statted !== undefined) {
      const bytes = disk.readFile(statted);

      return ok(bytes === undefined ? '' : String(bytes.byteLength));
    }

    // Reset paths are re-created as trees: an upper is filled before its overlay mounts,
    // and a layer mounts inside a root reset the same way.
    const reset = /^rm -rf (?<paths>.+?) && mkdir -p /.exec(command)?.groups?.paths;

    if (reset !== undefined) {
      for (const path of reset.split(' ').map(unquote)) {
        disk.rmrf(path);
        disk.tree(path);
      }

      return ok();
    }

    const removed = /^rm -rf '(?<path>[^']+)'$/.exec(command)?.groups?.path;

    if (removed !== undefined) {
      // Staging is dropped only after the commit is durable; a death here must not un-commit it.
      if (removed === `${DEVBOX_RUNTIME_DIR}/stage`) deaths.at('before-cleanup');
      disk.rmrf(removed);

      return ok();
    }

    if (command.startsWith('mkdir -p')) {
      for (const path of command.slice('mkdir -p'.length).trim().split(' ').map(unquote)) {
        disk.mkdirp(path);
      }

      return ok();
    }

    return ok();
  };
}

function snapshotChainArm(): ConformanceArm {
  const durable = new DurableStore();
  const deaths = new DeathWatch();
  /** The Durable Object's own row. Shared by every boot and isolate. */
  let row: ChainState | null = null;

  const generations = (): readonly string[] => row === null ? [] : [
    row.base.id,
    ...(row.fallback === undefined ? [] : [row.fallback.base.id]),
    ...(row.orphans ?? []),
  ];

  const payloadPrefixes = (): readonly string[] => generations().map(id => `${STORE_ROOT}/${id}/`);

  /** One container boot. Every field below dies with it except the shared row
   *  and durable object store captured from the function above. */
  class ChainBoot implements ArmBoot {
    disk = new ContainerDisk();
    readonly failures: string[] = [];
    readonly workspace: Workspace;
    #storage: DevboxStorage;
    #seedStamp: string | undefined;
    #publishing: { readonly at: string; readonly prefix: string } | undefined;
    #finalizeGate = new OneShotGate();
    #rows: WorkRows = { seal: NO_SEAL, publish: NO_PUBLISH, restore: NO_RESTORE };
    /** What the last checkpoint's archiver packed, read off the product's mksquashfs command.
     *  The seal row counts what that source held, never the merged workspace beside it. */
    #packed: readonly NodeEntry[] | undefined;

    constructor() {
      this.workspace = {
        write: async (path, text) => {
          if (!this.disk.overlays.has(DEVBOX_WORKDIR)) {
            throw new Error('the chain workspace is not attached, so a write has nowhere to land');
          }

          this.disk.writeFile(`${DEVBOX_WORKDIR}/${path}`, encoder.encode(text));
        },
        read: async (path) => {
          const bytes = this.disk.readFile(`${DEVBOX_WORKDIR}/${path}`);

          return bytes === undefined ? undefined : decoder.decode(bytes);
        },
        remove: async (path) => this.disk.removeFile(`${DEVBOX_WORKDIR}/${path}`),
        paths: async () => this.disk.entries(DEVBOX_WORKDIR),
        plant: async (entries) => {
          const overlay = this.disk.overlays.get(DEVBOX_WORKDIR);

          if (overlay === undefined) throw new Error('the chain workspace is not attached');
          this.disk.tree(overlay.upper).plant(entries);
        },
        snapshot: async () => this.disk.snapshot(DEVBOX_WORKDIR),
        pwrite: async (path, offset, bytes) => {
          const overlay = this.disk.overlays.get(DEVBOX_WORKDIR);

          if (overlay === undefined) throw new Error('the chain workspace is not attached');
          const upper = this.disk.tree(overlay.upper);

          if (!upper.has(path)) {
            // fuse-overlayfs copy-up copies the WHOLE lower file before one page changes;
            // a quota can refuse this copy before the write lands.
            const merged = this.disk.snapshot(DEVBOX_WORKDIR);
            const names = new Set([...ancestorsOf(path), path]);
            upper.plant(merged.filter((entry) => names.has(entry.path)));
          }

          upper.pwrite(path, offset, bytes);
        },
      };
      this.#storage = this.#build();
    }

    storage(): DevboxStorage {
      return this.#storage;
    }

    holdFinalize(): HeldFinalize {
      return this.#finalizeGate.hold();
    }

    resetIsolate(): void {
      // New adapter, same container: mounts, upper and boot-local stamp stay.
      this.#storage = this.#build();
    }

    /** Models P1: a stop loses disk bytes, mounts, boot-local stamp and staged commit; the durable
     *  store, DO row, recorded calls and faults survive. Replacement clears the same set (D6). */
    #loseContainerLocalState(): void {
      this.disk.discardLocalState();
      this.#seedStamp = undefined;
      this.#publishing = undefined;
      this.#packed = undefined;
    }

    replaceContainer(): void {
      this.#loseContainerLocalState();
      this.disk.dead = true;
      this.disk = new ContainerDisk();
      // The old boot's held commit keeps the old gate; the replacement gets its own.
      this.#finalizeGate = new OneShotGate();
      this.#storage = this.#build();
    }

    stop(): void {
      this.#loseContainerLocalState();
      this.disk.stopped = true;
    }

    work(): WorkRows {
      return this.#rows;
    }

    /** Call only on a clean upper: a dirty upper holds bytes no layer names and clearing loses them.
     *  A chunked file is base plus overrides held nowhere whole, so it stays in the upper. */
    evictCleanBytes(): number {
      if (row?.delta === undefined) return 0;
      const overlay = this.disk.overlays.get(DEVBOX_WORKDIR);

      if (overlay === undefined) return 0;
      const upper = this.disk.tree(overlay.upper);
      const held = upper.bytesHeld();

      if (held === 0) return 0;
      const chainId = row.base.id;
      const deltaKey = deltaObjectKey(STORE_ROOT, row.delta.id ?? chainId);
      const bytes = durable.get(deltaKey);

      if (bytes === null) return 0;
      const mountPoint = deltaLayerMountPoint(chainId);
      this.disk.unpack(bytes, mountPoint);
      this.disk.mount(mountPoint, { source: deltaKey, fstype: 'fuse.squashfuse', options: 'ro' });
      const manifestBytes = this.disk.readFile(`${mountPoint}/${DELTA_MANIFEST_NAME}`);
      const manifest = manifestBytes === undefined ? null : v.safeParse(DeltaManifestSchema, JSON.parse(decoder.decode(manifestBytes)));

      if (manifest === null || !manifest.success) {
        this.disk.mountOverlay(DEVBOX_WORKDIR, { lowers: [mountPoint, ...overlay.lowers], upper: overlay.upper });
        upper.clear();

        return held;
      }

      // The sidecar's whole-file directory is observed, not restated: it is the directory
      // under which the first whole file's path is found.
      const whole = manifest.output.files.filter((file) => file.kind === 'whole');
      const rows = this.disk.snapshot(mountPoint);
      const first = whole[0] === undefined ? undefined : rows.find((served) => served.kind === 'file' && served.path.endsWith(`/${whole[0].p}`));

      if (whole[0] === undefined || first === undefined) return 0;
      const sideRelative = first.path.slice(0, first.path.length - whole[0].p.length - 1);
      const sideTree = `${mountPoint}/${sideRelative}`;
      this.disk.tree(sideTree).plant(rows
        .filter((entry) => entry.path.startsWith(`${sideRelative}/`))
        .map((entry) => ({ ...entry, path: entry.path.slice(sideRelative.length + 1) })));
      this.disk.mountOverlay(DEVBOX_WORKDIR, { lowers: [sideTree, ...overlay.lowers], upper: overlay.upper });

      for (const file of whole) upper.remove(file.p);

      return held - upper.bytesHeld();
    }

    #meter(raw: DevboxStorage): DevboxStorage {
      return withOptionalMembers(raw, {
        attach: async () => {
          const window = { from: durable.ops.length };
          const mounts = this.disk.mountCalls;
          const layers = this.disk.layerMountCalls;
          const outcome = await raw.attach();
          this.#rows = {
            ...this.#rows,
            restore: restoreWorkSince(durable, window, payloadPrefixes(), {
              mounts: this.disk.mountCalls - mounts,
              cpuSteps: (await this.workspace.snapshot()).length,
              replayUnits: this.disk.layerMountCalls - layers,
            }),
          };

          return outcome;
        },
        checkpoint: async (kind) => {
          const window = { from: durable.ops.length };
          const workspaceBefore = await this.workspace.snapshot();
          this.#packed = undefined;
          const outcome = await raw.checkpoint(kind);

          // Seal what the archiver packed (upper, staged sidecar, or merged view), not the workspace;
          // `#packed` is the snapshot taken as the recorded mksquashfs command ran.
          const seal = outcome.kind === 'committed'
            ? wholeTreeSeal(this.#packed ?? workspaceBefore, 128 * 1024)
            : NO_SEAL;

          this.#rows = {
            ...this.#rows,
            seal,
            publish: publishWorkSince(durable, window, outcome.kind === 'committed' ? 1 : 0),
          };

          return outcome;
        },
        discard: async () => await raw.discard(),
      });
    }

    #build(): DevboxStorage {
      /** The store as the isolate may touch it: metadata only. A payload body
       *  crossing this port is a hard failure. */
      const isolate = {
        head: (key: string) => durable.head(key),
        delete: (key: string) => durable.delete(key),
        get: (key: string): never => {
          throw new Error(`payload must not be read through the isolate: ${key}`);
        },
        put: (key: string): never => {
          throw new Error(`payload must not be written through the isolate: ${key}`);
        },
      };

      /** The store as the mount reaches it: whole objects, container-side. */
      const mounted = {
        get: (key: string) => durable.get(key),
        put: (key: string, bytes: Uint8Array) => durable.put(key, bytes),
      };

      /** Models the s3fs shape: three durable puts per publication (`mkdir` marker, `create`'s
       *  empty object, then the flushed payload), the floor that makes the egress path necessary. */
      const publish = (archivePath: string, mountedPath: string): number | undefined => {
        deaths.at('before-payload');
        const mount = this.#publishing;

        if (mount === undefined || !mountedPath.startsWith(`${mount.at}/`)) {
          throw new Error(`nothing writable is mounted for ${mountedPath}`);
        }

        const key = `${mount.prefix}${mountedPath.slice(mount.at.length + 1)}`;
        const parent = key.slice(0, key.lastIndexOf('/') + 1);
        const bytes = this.disk.readFile(archivePath);

        // s3fs's own order: the marker PUT lands on `mkdir -p`, before `dd`
        // can fail to open the archive.
        durable.put(parent, new Uint8Array(0));

        if (bytes === undefined) return undefined;
        mounted.put(key, new Uint8Array(0));
        this.disk.serveFromMount(mountedPath, bytes);
        mounted.put(key, bytes);
        deaths.at('after-payload');

        return bytes.byteLength;
      };

      /** One PUT through the mount's egress host (D15); the mount's registration routes the URL,
       *  so an unmounted box refuses exactly as the handler's 403 would. */
      const publishEgress = (archivePath: string, objectUrl: string): { landed: number } | { refused: string } | undefined => {
        deaths.at('before-payload');
        const mount = this.#publishing;

        if (mount === undefined) {
          return { refused: 'Access to R2 bucket is not permitted. Call mountBucket() with this bucket before accessing it.' };
        }

        const relative = /^https?:\/\/[^/]+\/[^/]+\/(?<key>.+)$/.exec(objectUrl)?.groups?.key;

        if (relative === undefined || relative.includes('..')) {
          return { refused: `PUT answered 403 for ${objectUrl}` };
        }

        const bytes = this.disk.readFile(archivePath);

        if (bytes === undefined) return undefined;
        // The egress handler prepends the mount's prefix, so the object lands at `${prefix}${key}`.
        this.disk.serveFromMount(`${mount.at}/${relative}`, bytes);
        mounted.put(`${mount.prefix}${relative}`, bytes);
        deaths.at('after-payload');

        return { landed: bytes.byteLength };
      };

      const chain = chainExec(this.disk, deaths, publish, publishEgress);


      const exec: typeof chain = async (command) => {
        const packed = /mksquashfs '(?<source>[^']+)' '(?<archive>[^']+)'/.exec(command)?.groups?.source;

        if (packed !== undefined) this.#packed = this.disk.snapshot(packed);

        return await chain(command);
      };

      const ports: SnapshotChainPorts = {
        containerRunning: () => !this.disk.dead && !this.disk.stopped,
        allowExtraction: () => false,
        archiveExcludes: () => [],
        stamp: () => {},
        readState: async () => row,
        writeState: async (next, expectedRev) => {
          // The pointer is the commit. The hold is before it: the old boot has
          // staged bytes and its late finalize arrives after the new boot.
          await this.#finalizeGate.cross();
          deaths.at('before-pointer');
          // The Durable Object's read-compare-put, as one step: nothing runs
          // between the comparison and the write.
          const stored = row?.rev ?? null;

          if (stored !== expectedRev) throw new ChainRecordAdvanced(expectedRev, stored);
          row = next;

          if (next.lastFailure !== undefined) this.failures.push(next.lastFailure.reason);
          deaths.at('after-pointer');
        },
        clearState: async () => { row = null; },
        checkpointIntervalMs: () => 0,
        checkChanges: async () => ({ status: 'changed', version: `v${durable.writes.length}` }),
        readSeedStamp: async () => this.disk.dead ? undefined : this.#seedStamp,
        writeSeedStamp: async (stamp) => { this.#seedStamp = stamp; },
        exec,
        storeRoot: () => STORE_ROOT,
        storeObjectUrl: (key) => {
          if (!key.startsWith(`${STORE_ROOT}/`)) {
            throw new Error(`storeObjectUrl: ${key} is outside this box's store prefix ${STORE_ROOT}`);
          }

          return `http://r2.internal/BACKUP_BUCKET/${key.slice(STORE_ROOT.length + 1)}`;
        },
        mountStore: async (at) => {
          if (this.disk.dead) throw new ContainerDied('mountStore on a dead container');
          this.disk.mount(at, { source: `r2:${STORE_ROOT}`, fstype: 'fuse.s3fs', options: 'rw' });

          for (const key of durable.list(`${STORE_ROOT}/`)) {
            const bytes = mounted.get(key);

            if (bytes === null) throw new Error(`mountStore: the store listed ${key} and then could not read it`);
            this.disk.serveFromMount(`${at}/${key.slice(STORE_ROOT.length + 1)}`, bytes);
          }

          this.#publishing = { at, prefix: `${STORE_ROOT}/` };
          deaths.reset('attach:after-store-mount');
        },
        unmountStore: async (at) => {
          if (this.#publishing?.at === at) this.#publishing = undefined;

          if (this.disk.dead || this.disk.stopped) return;

          for (const path of this.disk.entries(at)) this.disk.removeFile(`${at}/${path}`);
          this.disk.unmount(at);
        },
        objectFacts: async (key) => {
          const held = isolate.head(key);

          if (held === null) return undefined;

          return { bytes: held.size, digest: held.digest, objectVersion: held.version };
        },
        deleteObjects: async (keys) => {
          deaths.at('before-cleanup');

          for (const key of keys) isolate.delete(key);
        },
        countEntries: async (dir) => this.disk.snapshot(dir).length,
        restoreExtract: async () => ({ success: false }),
        createExtractSnapshot: async () => {
          throw new Error('the conformance battery runs the chain, never extraction');
        },
        now: () => Date.now(),
        log: () => undefined,
      };

      return this.#meter(snapshotChainStorage(ports));
    }
  }

  let current = new ChainBoot();

  return {
    name: 'snapshot-chain',
    storage: () => current.storage(),
    get workspace() { return current.workspace; },
    get failures() { return current.failures; },
    durable,
    deaths,
    holdFinalize: () => current.holdFinalize(),
    replaceContainer: () => current.replaceContainer(),
    stopContainer: () => current.stop(),
    resetIsolate: () => current.resetIsolate(),
    secondBoot: () => new ChainBoot(),
    disk: () => current.disk,
    commitSeams: ['before-payload', 'after-payload', 'before-pointer', 'before-cleanup'],
    publishSeam: 'before-pointer',
    attachSeams: ['attach:after-store-mount', 'attach:after-layer-mount', 'attach:after-overlay'],
    dieAt: (seam) => deaths.arm(seam),
    payloadPrefixes,
    controlPlane: async () => ({
      objectKeys: [],
      rows: ['chain-state'],
      head: row === null ? null : `${row.base.id}#${row.rev}`,
    }),
    declaredPayload: async () => {
      if (row === null) return [];

      const declared: DeclaredObject[] = [{
        key: baseObjectKey(STORE_ROOT, row.base.id),
        byteLength: row.base.bytes,
        names: [baseObjectKey(STORE_ROOT, row.base.id), 'base'],
      }];

      if (row.delta !== undefined) {
        declared.push({
          key: deltaObjectKey(STORE_ROOT, row.delta.id ?? row.base.id),
          byteLength: row.delta.bytes,
          names: [deltaObjectKey(STORE_ROOT, row.delta.id ?? row.base.id), 'delta'],
        });
      }

      return declared;
    },
    committedHeads: async () => row === null ? [] : [`${row.base.id}#${row.rev}`],
    work: () => current.work(),
    evictCleanBytes: () => current.evictCleanBytes(),
    refusedProperties: {
      times: { reason: 'squashfs stores mtime only; atime and ctime are not durable fields' },
    },
    refusedCells: {
      ...HARNESS_OWNED_CELLS,
      '6.14': { reason: 'a snapshot-chain wake makes 4 remote ops against the O(1) bound of 3: the base integrity head, the head that adopts an unreferenced delta, the store mount\'s list and the base layer\'s get (a base+delta wake makes 5; measured 2026-09-10 in the conformance harness)' },
    },
  };
}


/** Keyed by `DevboxStrategyName` so a new strategy without a conformance arm fails to compile. */
export const CONFORMANCE_ARMS = {
  'snapshot-chain': snapshotChainArm,
} satisfies Record<DevboxStrategyName, () => ConformanceArm>;
