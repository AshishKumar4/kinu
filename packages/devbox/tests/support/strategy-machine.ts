/**
 * One machine, one strategy, every point a container can die.
 *
 * WHY THIS EXISTS. `snapshot-chain.test.ts` models the store as key-to-SIZE, so
 * no byte ever travels through it, and a fake like that cannot ask the question
 * the deployed benchmarks answered by accident: does the strategy hand back the
 * bytes it was given, across a container replacement, at every point a
 * container can die?
 *
 * So this module is a MACHINE rather than a second fake of a store: a durable
 * object store that outlives container generations, one container disk that a
 * replacement blanks, and the real `DevboxStorage` adapter wired to both
 * through its own production ports. Nothing here decides anything the strategy
 * decides. Where its byte work happens container-side — the archiver — this
 * module runs against in-memory bytes and simulates only what genuinely cannot
 * run here: mksquashfs and fuse-overlayfs.
 *
 * THE FAULT SEAM IS THE PORTS, and it was already there. The strategy takes its
 * whole world as an injected port set, so a container death at a commit
 * sub-step is a port that throws at that instant — inside the shipped code,
 * between the two durable effects the sub-step separates. Nothing is
 * monkey-patched and no production file grew a test hook: {@link ContainerDied}
 * is raised by this module's adapters at seams NAMED FROM THE STRATEGY'S OWN
 * KEY LAYOUT, so a seam cannot drift from the thing it interrupts.
 */

import { createHash } from 'node:crypto';

import * as v from 'valibot';

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

/** The box this machine stands for, and the chain root its keys live under.
 *  DERIVED through the strategy's own exported helper, never spelled here, so
 *  there is no second copy of the layout to drift from. */
const STORE_ROOT = chainStoreRoot('boxes/conformance-box');

/** Where the chain mounts one generation's delta layer, restated from
 *  `lowerDeltaRoot` in `src/snapshot-chain.ts`: the strategy keeps that path
 *  to itself, and this machine has to serve an evicted delta where the
 *  strategy's own `deltaLayerServed` looks for it. Drift is loud: a layer
 *  mounted anywhere else is not seen as served, the next commit archives an
 *  empty upper, and the chain cells read the tree back short. */
const CHAIN_DELTA_LAYER_ROOT = '/var/tmp/devbox/lower-delta';
const deltaLayerMountPoint = (chainId: string): string => `${CHAIN_DELTA_LAYER_ROOT}/${chainId}`;

// ── deaths ──────────────────────────────────────────────────────────────────

/**
 * The container went away at a named commit sub-step.
 *
 * NOT a failure the strategy can classify and stamp: it is the spot container
 * being replaced mid-operation, which is the third of the four defect classes
 * the deployed benchmarks found. Everything the abandoned operation would have
 * done next also fails, because the disk it was writing to no longer exists —
 * see {@link ContainerDisk.dead}.
 */
export class ContainerDied extends Error {
  constructor(readonly seam: string) {
    super(`the container was replaced at ${seam}`);
    this.name = 'ContainerDied';
  }
}

/** The container is stopped. What the SDK raises for any call against one. */
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

/**
 * One operation crossed the same durable sub-step more times than it may.
 *
 * THE BOUNDED-WORK FENCE, and it exists because an unbounded retry loop is not
 * a hang to be waited out: a checkpoint loop that compared an operation kind
 * against a checkpoint kind published a fresh generation FOREVER on every
 * quiesce. A budget turns that into a NAMED failure at the second publication
 * instead of a test timeout, so the suite reports the defect rather than the
 * symptom.
 */
export class SeamBudgetExceeded extends Error {
  constructor(readonly seam: string, readonly visits: number) {
    super(`one operation reached ${seam} ${visits} times, which is more than it may`);
    this.name = 'SeamBudgetExceeded';
  }
}

/**
 * One armed death, and the seams a run actually reached.
 *
 * `reached` is what keeps an injection honest: a seam nothing reaches would
 * make a crash test pass by never crashing, so the battery asserts the seam it
 * armed was visited.
 */
export class DeathWatch {
  #armed: string | null = null;
  readonly reached: string[] = [];
  /** How many times one seam may be reached before the run is refused. */
  readonly #budgets = new Map<string, number>();
  /** The spent budget, once one is spent. Latched: see {@link DeathWatch.at}. */
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

  /** How many times `seam` has been reached. */
  visits(seam: string): number {
    return this.reached.filter(step => step === seam).length;
  }

  /** Reached one seam. Throws when this is the armed one, exactly once. */
  at(seam: string): void {
    this.#record(seam);
    if (this.#armed !== seam) return;
    this.#armed = null;
    throw new ContainerDied(seam);
  }

  /**
   * Reached one durable write whose effect is already on the container: the
   * ISOLATE goes here, not the container. {@link IsolateReset} is what a
   * Durable Object reset looks like to code in flight — the call never
   * returns, the object comes back, and the container is where it was.
   */
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

  /**
   * LATCHED, and it has to be. A publication loop is allowed to treat one
   * failed completion mark as retryable — that is the design — so a budget
   * that threw once and then let the run continue would be swallowed and the
   * loop would spin anyway. Once a budget is spent, every later sub-step
   * refuses with the same error, so the next operation cannot begin and the
   * caller gets a NAMED refusal instead of a test timeout.
   */
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

// ── the durable store ───────────────────────────────────────────────────────

interface StoredObject {
  readonly bytes: Uint8Array;
  /** The store's own name for the upload that wrote this object. R2 mints one
   *  per upload and reports it from `head` forever after, which is the identity
   *  a same-length replacement cannot copy. */
  readonly version: string;
  /** User metadata stored beside the body, as R2's `customMetadata` and the
   *  `x-amz-meta-*` headers s3fs keeps a file's mode, owner and times in. */
  readonly meta: Readonly<Record<string, string>>;
}

/**
 * The object store, as the one thing that outlives a container.
 *
 * Modelled at the level every strategy actually uses: whole objects under a
 * key, a per-upload version, and a listing by prefix. `corrupt` is the
 * fault-injection this level owns — bit rot and truncation are store events,
 * not strategy events.
 */
/** What one prefix of the durable store holds: the count and the bytes. */
interface StoreInventory {
  objects: number;
  bytes: number;
}

/** One remote operation against the store, as the work rows count them. */
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
  /**
   * EVERY remote operation, reads included, in order. The counted-work rows
   * (`RestoreWork`, `PublishWork`) are windows over this log: a wake's remote
   * ops are the entries between the attach's start and its return, whatever
   * port the arm reached them through. Counting here rather than in each arm
   * is what makes one arm's row comparable with another's.
   */
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

  /** The metadata stored beside `key`, or null for an absent object. */
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
    for (const key of this.#keysUnder(prefix)) {
      objects += 1;
      bytes += this.objects.get(key)!.bytes.byteLength;
    }
    return { objects, bytes };
  }

  /**
   * Damage one stored object WITHOUT re-uploading it.
   *
   * The version is retained on purpose: bit rot and a lifecycle-truncated
   * object are not new uploads, so a check that only compares upload versions
   * must not be able to pass by accident.
   */
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

  /** Keys under `prefix`, sorted, WITHOUT recording a remote op: the arms'
   *  own bookkeeping reads (`inventory`, a control-plane listing) are not
   *  the work a wake or a publish pays for. */
  #keysUnder(prefix: string): string[] {
    return [...this.objects.keys()].filter(key => key.startsWith(prefix)).sort();
  }
}

// ── the container disk ──────────────────────────────────────────────────────

interface MountRow {
  readonly source: string;
  readonly fstype: string;
  readonly options: string;
}

interface OverlayRow {
  readonly lowers: readonly string[];
  readonly upper: string;
}

/**
 * One archive, as a schema.
 *
 * The stand-in for a squashfs superblock: bytes that came back out of the
 * store are parsed rather than trusted, so a truncated or flipped archive
 * REFUSES here exactly as squashfuse refuses a damaged image — which is what
 * makes a corrupt layer a refusal instead of a silently short tree.
 *
 * WHAT A LAYER CARRIES is what squashfs carries: mode, uid, gid, ONE time
 * (squashfs stores mtime and nothing else), xattrs, symlink targets, hardlinks
 * (one inode, several names) and sparse geometry (holes are not stored). An
 * archive that carried more than the real format would let the chain pass a
 * fidelity cell the deployed chain cannot pass.
 */
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

/** The disk refused a write for want of room: `ENOSPC`, as `write(2)` says it. */
export class DiskFull extends Error {
  constructor(readonly path: string, readonly needed: number, readonly free: number) {
    super(`ENOSPC: ${path} needs ${needed} bytes and the disk has ${free} free`);
    this.name = 'DiskFull';
  }
}

/**
 * One container's disk, and the mounts on it.
 *
 * Two kinds of thing live here. PLAIN FILES (`files`) are bytes at a path:
 * archives, stages, runner replies. TREES (`trees`) are full-fidelity
 * filesystem trees at a directory — the layers squashfuse serves, an
 * overlay's upper, the journal daemon's backing root — held as
 * {@link LiveTree}s so a hardlink, a hole or an xattr survives the way it
 * would on a real disk. Both are charged to one QUOTA: a write past it is
 * refused with {@link DiskFull} before any effect lands, which is the
 * `intent-before-effect` rule the ENOSPC cell asserts.
 *
 * `dead` is what a replacement leaves behind: the strategy's in-flight
 * operation keeps holding this object, and every call on it fails the way a
 * call against a container that no longer exists fails.
 */
export class ContainerDisk {
  readonly files = new Map<string, Uint8Array>();
  readonly dirs = new Set<string>([DEVBOX_WORKDIR, DEVBOX_RUNTIME_DIR]);
  readonly mounts = new Map<string, MountRow>();
  readonly overlays = new Map<string, OverlayRow>();
  readonly trees = new Map<string, LiveTree>();
  /** Plain files a mount serves on demand: present, readable, never charged. */
  readonly mountServed = new Set<string>();
  /** Paths an overlay's upper has deleted from a lower: the whiteouts. */
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

  /** Charge `delta` bytes against the quota; refuse, effect-free, past it. */
  charge(delta: number, path = '(tree)'): void {
    // tmpfs lives in memory rather than on the container disk, and layer
    // mounts read through the store rather than occupying local disk, so
    // neither costs disk quota. Asked here rather than at each call site, so
    // no writer needs to know which paths are disk and which are not.
    if (path.startsWith('/dev/shm/') || path === '/dev/shm') return;
    if (path.startsWith('/var/tmp/devbox/lower-base') || path.startsWith(`${CHAIN_DELTA_LAYER_ROOT}/`) || path.startsWith('/var/tmp/devbox/lower-empty')) return;
    if (delta > 0 && this.quotaBytes !== null && this.usedBytes + delta > this.quotaBytes) {
      throw new DiskFull(path, delta, Math.max(0, this.quotaBytes - this.usedBytes));
    }
    this.usedBytes += delta;
  }

  /** The tree at `dir`, created empty on first use and charged to this disk. */
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

  /**
   * A store object as an s3fs mount shows it: a file the container can read
   * that occupies NO local disk, because the mount fetches on demand. Never
   * charged to the quota, and never refunded on unmount.
   */
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
      // A name a lower still holds is hidden by a whiteout, as fuse-overlayfs
      // hides it: the upper cannot unlink a lower's file, only mask it.
      let masked = this.whiteouts.get(owner.point);
      if (masked === undefined) {
        masked = new Set();
        this.whiteouts.set(owner.point, masked);
      }
      masked.add(owner.relative);
      return;
    }
    const held = this.files.get(path);
    if (held !== undefined && !this.mountServed.has(path)) this.charge(-held.byteLength);
    this.mountServed.delete(path);
    this.files.delete(path);
  }

  /** Every file under `dir`, as paths relative to it, through any overlay. */
  entries(dir: string): string[] {
    this.#alive(`list ${dir}`);
    return this.snapshot(dir).filter((entry) => entry.kind === 'file').map((entry) => entry.path);
  }

  /**
   * The tree served at `dir`, as capture entries: an overlay mount point
   * answers the merged view (upper wins, whiteouts hide), a tree directory
   * answers its own tree, anything else answers the plain files below it.
   */
  snapshot(dir: string): NodeEntry[] {
    this.#alive(`walk ${dir}`);
    const overlay = this.overlays.get(dir);
    if (overlay !== undefined) {
      const merged = new Map<string, NodeEntry>();
      const masked = this.whiteouts.get(dir) ?? new Set<string>();
      let inoBase = 0;
      // Lowers first, oldest last in the list, so a newer layer's row replaces
      // an older one's; the upper replaces every lower. Inode ids are made
      // disjoint across layers by offset, and stay shared within a layer.
      for (const layer of [...overlay.lowers].reverse().concat(overlay.upper)) {
        const tree = this.trees.get(layer);
        if (tree === undefined) continue;
        let highest = 0;
        for (const entry of tree.snapshot()) {
          highest = Math.max(highest, entry.ino);
          merged.set(entry.path, { ...entry, ino: entry.ino + inoBase });
        }
        inoBase += highest;
      }
      for (const path of masked) merged.delete(path);
      return sortedByPath([...merged.values()]);
    }
    const tree = this.trees.get(dir);
    if (tree !== undefined) return tree.snapshot();
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

  /** `cp -a from/. to/`: the tree at `from` planted into the tree at `to`. */
  copyTree(from: string, to: string): void {
    this.#alive(`cp -a ${from} ${to}`);
    this.tree(to).plant(this.snapshot(from));
  }

  /**
   * Serialize a directory into one archive object.
   *
   * The stand-in for mksquashfs, and deliberately a format that FAILS TO PARSE
   * when a byte of it is lost: a truncated squashfs does not mount either, and
   * a fake whose archive tolerated damage would let a corrupt layer be served.
   * Sparse files are written as their data runs: mksquashfs does not store a
   * hole, and neither does this.
   */
  pack(dir: string): Uint8Array {
    const entries = this.snapshot(dir).map((entry): v.InferOutput<typeof ArchiveEntrySchema> => {
      const metadata = entry.metadata!;
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
          .map((segment) => [segment.start, bytesToBase64(segment.view!)]);
      }
      return row;
    });
    return new TextEncoder().encode(JSON.stringify({ archive: 2, entries }));
  }

  unpack(bytes: Uint8Array, dir: string): void {
    // These bytes came out of the store, so they are untrusted input even
    // though this module wrote them: a truncated archive must fail to parse
    // exactly as a truncated squashfs fails to mount.
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
      const runs = (row.runs ?? []).map(([offset, body]) => ({ offset, bytes: base64ToBytes(body) }));
      const size = row.size ?? 0;
      const dense = runs.length === 1 && runs[0]!.offset === 0 && runs[0]!.bytes.byteLength === size;
      return {
        ...base,
        content: dense ? { kind: 'dense', bytes: runs[0]!.bytes } : { kind: 'sparse', size, runs },
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
    this.tree(overlay.upper);
  }

  /** The node a path names through an overlay or a tree directory. */
  #treeAt(path: string): { node: LiveInode } | undefined {
    const owner = this.#overlayOwner(path);
    if (owner !== undefined) {
      if (this.whiteouts.get(owner.point)?.has(owner.relative)) return undefined;
      for (const layer of [owner.overlay.upper, ...owner.overlay.lowers]) {
        const node = this.trees.get(layer)?.node(owner.relative);
        if (node !== undefined) return { node };
      }
      return undefined;
    }
    for (const [dir, tree] of this.trees) {
      if (!path.startsWith(`${dir}/`)) continue;
      const node = tree.node(path.slice(dir.length + 1));
      if (node !== undefined) return { node };
    }
    return undefined;
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

function parentOf(path: string): string {
  const at = path.lastIndexOf('/');
  return at <= 0 ? '/' : path.slice(0, at);
}

function bytesToBase64(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

function base64ToBytes(encoded: string): Uint8Array {
  const text = atob(encoded);
  const bytes = new Uint8Array(text.length);
  for (let at = 0; at < text.length; at += 1) bytes[at] = text.charCodeAt(at);
  return bytes;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ── the uniform arm ─────────────────────────────────────────────────────────

/**
 * What a caller does to the work directory, whatever serves it.
 *
 * ASYNC BY CONTRACT, not by every arm's implementation: a strategy that keeps
 * everything resident answers from memory, wrapped in an already-resolved
 * promise, and a lazy one pages in on first touch. The signature carries the
 * one true fact about a real workspace — that a read can fault — so a battery
 * cell exercising a lazy arm and one exercising an eager arm write the same
 * line of code.
 */
export interface Workspace {
  write(path: string, text: string): Promise<void>;
  read(path: string): Promise<string | undefined>;
  remove(path: string): Promise<void>;
  /** File paths only, sorted: the listing a text fixture compares against.
   *  Lists structure only — every directory, no file's bytes — so pairing it
   *  with `read` per path pays for exactly the files a caller names. */
  paths(): Promise<readonly string[]>;
  /**
   * Plant a complete tree at full fidelity: directories, files, symlinks,
   * hardlinks (entries that share an `ino` share one inode), sparse content
   * as runs, and every metadata field. Existing paths are replaced.
   */
  plant(entries: readonly NodeEntry[]): Promise<void>;
  /** The tree the workspace serves, as capture entries, at the fidelity the
   *  arm serves it, every byte resident. Inode ids share exactly where the
   *  served inodes share. A lazy arm pages in everything to answer this. */
  snapshot(): Promise<readonly NodeEntry[]>;
  /** `pwrite(2)`: overwrite bytes in place at an offset. The sqlite pattern.
   *  A lazy arm pages the target in first: the bytes outside the write are
   *  still the head's, and a fence that staged a placeholder's zeros would
   *  publish them as content. */
  pwrite(path: string, offset: number, bytes: Uint8Array): Promise<void>;
}

/** One object a strategy's own record DECLARES a size and identity for. */
export interface DeclaredObject {
  readonly key: string;
  readonly byteLength: number;
  /** What the object is called in a refusal: the key, or the digest a
   *  content-addressed store names it by. */
  readonly names: readonly string[];
}

/** Where a strategy keeps metadata, and what the container owns. */
export interface ControlPlacement {
  /** Object keys that carry control metadata: envelopes, cursors, heads. */
  readonly objectKeys: readonly string[];
  /** Control the Durable Object holds outside the store entirely. */
  readonly rows: readonly string[];
  /** The head this control plane currently names, or null. */
  readonly head: string | null;
}

// ── counted work ────────────────────────────────────────────────────────────
//
// The rows below carry the field names the durability contract declares for
// them (`SealWork`, `PublishWork`, `RestoreWork` in `src/durability/contracts.ts`;
// the first two land with the contracts lane, `RestoreWork` is shipped). The
// machine derives every row from things it can OBSERVE — the durable store's
// op log, the disk's mount count, the shipped builders' own statistics, the
// bytes the fence handed over — never from a number an arm reports about
// itself, so a counter cannot flatter the arm that emits it.

/** What one seal (fence plus build) cost. */
export interface SealWork {
  /** Bytes the fence copied into the stage: the whole tree today. */
  readonly bytesStaged: number;
  /** Bytes the chunker consumed. */
  readonly bytesChunked: number;
  /** Chunk digests computed. */
  readonly chunksHashed: number;
  /** Tree nodes serialized and hashed. */
  readonly nodesRewritten: number;
  /** Files staged whole rather than by dirty cluster. */
  readonly wholeFiles: number;
}

/** What one publish cost against the store and the control plane. */
export interface PublishWork {
  readonly objectsPut: number;
  readonly bytesPut: number;
  /** Head compare-and-swap transactions attempted. */
  readonly casAttempts: number;
}

/** What one wake cost. The shipped `RestoreWork` row, field for field. */
export interface RestoreWork {
  /** Remote ops on the critical path. The store here answers synchronously
   *  and every shipped restore awaits one op before issuing the next, so this
   *  equals `totalRemoteOps`; it stays a separate field so a concurrent
   *  restore reports the difference. */
  readonly serialRemoteOps: number;
  readonly totalRemoteOps: number;
  /** Bytes read from keys outside every payload prefix the arm names. */
  readonly metadataBytes: number;
  /** Bytes read from keys under a payload prefix. */
  readonly payloadBytes: number;
  /** Entries the restore materialized on the container. */
  readonly cpuSteps: number;
  readonly mounts: number;
  /** Journal entries or layers replayed over a base. */
  readonly replayUnits: number;
}

export interface WorkRows {
  /** The last checkpoint's seal. */
  readonly seal: SealWork;
  /** The last checkpoint's publish. */
  readonly publish: PublishWork;
  /** The last attach's restore. */
  readonly restore: RestoreWork;
}

/** A cell, or a tree property, the arm refuses by name and says why. */
export interface Refusal {
  readonly reason: string;
}

/** A held finalize: `entered` settles when the commit reaches the gate. */
export interface HeldFinalize {
  readonly entered: Promise<void>;
  readonly release: () => void;
}

/** Container-side starts that survive a Durable Object isolate reset. */
export interface LifecycleCounts {
  readonly daemonStarts: number;
  readonly restoreStarts: number;
}

/** The write-ahead journal a container still holds: one record per admitted
 *  write, and the records a refused effect cancelled. */
export interface JournalFacts {
  readonly records: readonly string[];
  readonly failedWrites: readonly string[];
}

/** A second container on the same box: the same durable store and rows, its
 *  own disk, its own daemon, its own strategy instance. */
export interface ArmBoot {
  storage(): DevboxStorage;
  readonly workspace: Workspace;
  /** Every failure the strategy recorded durably through its port. */
  readonly failures: readonly string[];
  /**
   * Hold the boot's next commit at the DO-side finalize: the runner has
   * staged (uploaded) and the draft is about to reach the control plane.
   * `entered` settles when it is held; `release` resumes the old commit.
   */
  holdFinalize(): HeldFinalize;
  /** A blank disk, the same durable store, and the same durable rows. */
  replaceContainer(): void;
}

/**
 * One strategy, driven through exactly the operations the contract names.
 *
 * Everything a case needs is here and nothing is strategy-specific: a case that
 * reads a key, a prefix or a mount path takes it from the arm, which takes it
 * from the strategy's OWN layout API. That is the whole point — the envelope
 * defect was a placement bug, and a test carrying its own copy of the layout
 * cannot see one.
 */
export interface ConformanceArm extends ArmBoot {
  readonly name: DevboxStrategyName;
  readonly durable: DurableStore;
  readonly deaths: DeathWatch;
  /** The container stops where it stands: no teardown, no replacement. */
  stopContainer(): void;
  /**
   * The isolate goes and comes back: a NEW strategy instance over the SAME
   * container, disk intact, daemon and mounts where they were. The opposite
   * of a replacement, and what a Durable Object reset really is.
   */
  resetIsolate(): void;
  /** A second live container on this box, beside the current one. */
  secondBoot(): ArmBoot;
  /** The current container's disk: quota, usage, mounts. */
  disk(): ContainerDisk;
  /** The commit sub-steps this strategy exposes, in the order it performs
   *  them. Derived from its own key layout, never invented here. */
  readonly commitSeams: readonly string[];
  /**
   * The sub-step at which ONE commit promotes its work, exactly once.
   *
   * A commit is bounded work: one payload publication per call. Naming the step
   * that marks it is what lets a battery say "and no more than one", which is
   * how a retry loop that publishes forever is caught as a defect instead of as
   * a timeout.
   */
  readonly publishSeam: string;
  /** The attach sub-steps an isolate reset can land after, in order. Each
   *  is a port whose effect is on the container when the reset lands. */
  readonly attachSeams: readonly string[];
  dieAt(seam: string): void;
  /** Prefixes the container owns through its mount. */
  payloadPrefixes(): readonly string[];
  controlPlane(): Promise<ControlPlacement>;
  declaredPayload(): Promise<readonly DeclaredObject[]>;
  /** Every committed head the ledger names. Exactly one is the invariant. */
  committedHeads(): Promise<readonly string[]>;
  /** The counted-work rows for the last checkpoint and the last attach. */
  work(): WorkRows;
  /** Container-side starts that survive a Durable Object isolate reset. */
  lifecycleCounts?(): LifecycleCounts;
  /** Evict clean local bytes, as the design's disk-pressure escape requires.
   *  Returns how many clean bytes it found to free. An arm without an
   *  eviction hook reports that fact: it can only refuse when full. */
  evictCleanBytes?(): number;
  /** The write-ahead journal records a container still holds, in order: one
   *  line per workload effect, 'W <path>' for a write that landed. Empty for
   *  arms whose write path keeps no journal. */
  journalFacts?(): JournalFacts;
  /** Tree properties the arm's format does not carry, by name. */
  readonly refusedProperties: Readonly<Partial<Record<TreeProperty, Refusal>>>;
  /** Cells the arm refuses outright, by cell id. */
  readonly refusedCells: Readonly<Record<string, Refusal>>;
}

// ── work accounting shared by every arm ─────────────────────────────────────

/** A window over the durable op log, opened at one moment and read later. */
interface OpWindow {
  readonly from: number;
}

/** The publish row for the ops since `window` opened. */
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

/** The restore row for the ops since `window` opened. */
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


/** The optional members of a storage, carried over a metered wrapper in
 *  statements: an absent `detach` stays absent, a present one is delegated. */
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


/**
 * The seal row for a whole-tree fence: what every shipped arm does today. The
 * fence hands the builder every file, so staged bytes, chunked bytes and
 * rewritten nodes are all the tree's. `chunksHashed` is the count of
 * `chunkBytes`-sized windows over the data (holes excluded), which is what a
 * fixed-size chunker hashes; a content-defined chunker's own count replaces it
 * where the builder reports one.
 */
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
  return { bytesStaged, bytesChunked: bytesStaged, chunksHashed, nodesRewritten: entries.length, wholeFiles };
}

/** The one cell this machine cannot host for any arm: it lives on the
 *  devbox-harness with the real class. Named so the matrix says where. */
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
// ── snapshot-chain ──────────────────────────────────────────────────────────

/**
 * The archiver, the overlay and the layer mounts, as commands.
 *
 * The strategy owns its shell, so this is where the battery meets it: each arm
 * recognises exactly one command the strategy really issues and does what the
 * container would do WITH REAL BYTES — mksquashfs writes an archive of the
 * directory it was pointed at, squashfuse unpacks one, `cp -a` copies a tree,
 * and `dd` publishes a staged archive into the store through the writable
 * mount. That is what makes "the exact bytes came back" an assertion about the
 * chain rather than about a stub.
 */
type ShellReply = { stdout: string; stderr: string; exitCode: number };
const shellOk = (stdout = ''): ShellReply => ({ stdout, stderr: '', exitCode: 0 });
const shellFail = (stderr: string): ShellReply => ({ stdout: '', stderr, exitCode: 1 });

/**
 * The chain checkpoint's own three commands — pack, publish, space gate —
 * answered as the real commands answer them: `<exit> <bytes>` on stdout,
 * their own words on stderr. Undefined when the command is none of the three.
 */
function checkpointCommand(
  command: string,
  disk: ContainerDisk,
  publish: (archivePath: string, mountedPath: string) => number | undefined,
): ShellReply | undefined {
  const squash = /mksquashfs '(?<source>[^']+)' '(?<archive>[^']+)'/.exec(command)?.groups;
  if (squash !== undefined) {
    const archive = disk.pack(squash.source!);
    try {
      disk.writeFile(squash.archive!, archive);
    } catch (error) {
      // mksquashfs on a full disk: a non-zero rc on stdout, its own words on
      // stderr, exactly as the real command reports it.
      if (!(error instanceof DiskFull)) throw error;
      return { stdout: '1 0', stderr: `FATAL ERROR: Failed to write to output filesystem: ${error.message}`, exitCode: 0 };
    }
    // `<exit> <bytes>`, the one command that builds and measures.
    return shellOk(`0 ${archive.byteLength}`);
  }

  // THE PUBLICATION, and the whole reason this arm has no payload port. The
  // container reads its own staged archive and writes it onto the store
  // mount; `conv=fsync` is the flush, so the upload's success is this
  // command's exit code. Nothing is handed to the isolate.
  // The copy, whatever precedes it: the publication creates the generation's
  // directory on the mount in the same command, because s3fs shows no parent
  // for a key nothing lives under yet.
  const published = /dd if='(?<archive>[^']+)' of='(?<mounted>[^']+)' bs=4M conv=fsync;/
    .exec(command)?.groups;
  if (published !== undefined) {
    const landed = publish(published.archive!, published.mounted!);
    // `<exit> <bytes>` on stdout either way, exactly as the real command
    // reports it: dd's own failure is a non-zero code there, not a thrown
    // shell error.
    if (landed === undefined) {
      return {
        stdout: '1 0',
        stderr: `dd: can't open '${published.archive!}': No such file or directory`,
        exitCode: 0,
      };
    }
    return shellOk(`0 ${landed}`);
  }

  if (command.includes('df -Pk')) {
    // `<need> <free>`, both honest: the archive of the source directory
    // needs about its data bytes, and the disk has what its quota leaves.
    // Without a quota the disk never fills and the gate never refuses.
    const source = /find '(?<source>[^']+)'/.exec(command)?.groups?.source;
    const need = source === undefined ? 1 : Math.max(1, disk.snapshot(source).reduce(
      (sum, entry) => sum + (entry.content === undefined ? 0 : runBytes(entry.content)), 0,
    ));
    const free = disk.quotaBytes === null ? Number.MAX_SAFE_INTEGER : Math.max(0, disk.quotaBytes - disk.usedBytes);
    return shellOk(`${need} ${free}`);
  }
  return undefined;
}

function chainExec(
  disk: ContainerDisk,
  deaths: DeathWatch,
  /** Publish a staged archive through the mount and answer what landed, or
   *  undefined when the source is not there for `dd` to read. */
  publish: (archivePath: string, mountedPath: string) => number | undefined,
) {
  const unquote = (value: string): string => value.replace(/^'|'$/g, '');
  return async (command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
    // The session shell first: a command it would refuse never reaches a
    // strategy's answer, on a deployment or here. See `session-shell.ts`.
    const refused = sessionShellRefusal(command);
    if (refused !== undefined) throw refused;
    const fail = shellFail;
    const ok = shellOk;
    if (command === 'cat /proc/mounts') return ok(disk.procMounts());

    const exists = /^test -e '(?<path>[^']+)'/.exec(command)?.groups?.path;
    if (exists !== undefined) return ok(disk.exists(exists) ? 'yes' : 'no');

    // The BOUNDED visibility probe: one command that asks the store mount for a
    // layer and, when it never appears, reports what the subtree holds.
    //
    // WHICH SUBTREE IS OBSERVED, NOT RESTATED. This arm used to carry the
    // strategy's private mount point — `const CHAIN_STORE_MOUNT = '/backups'`
    // — so the fake and the strategy agreed by construction, and a strategy
    // that moved its mount would have been served from the old path forever.
    // The probe command itself lists the subtree it is waiting on, so the path
    // is read off the command the container really received.
    //
    // AND THE MISSING BRANCH IS NOT COVERED HERE, which the deleted comment
    // claimed for itself and could not deliver:
    // measured 2026-09-02 by throwing inside it, no case in
    // `strategy-conformance.test.ts` reaches it,
    // because every layer this battery mounts materialises. The refusal that
    // report becomes is asserted in `snapshot-chain.test.ts` — "a store subtree
    // that never exposes the base refuses by count, naming what it holds" —
    // against that suite's own container, and that is where its red direction
    // is proven.
    if (command.includes('printf ready')) {
      const awaited = /test -e '(?<path>[^']+)'/.exec(command)?.groups?.path ?? '';
      if (disk.readFile(awaited) !== undefined) return ok('ready');
      const listed = /ls -1A '(?<path>[^']+)'/.exec(command)?.groups?.path ?? '';
      return ok(`missing ${disk.entries(listed).join(' ')}`);
    }
    // Releasing every delta layer this container serves, whichever generation
    // mounted it.
    if (command.includes('awk -v r=')) {
      const root = unquote(/awk -v r='(?<root>[^']+)'/.exec(command)?.groups?.root ?? '');
      for (const point of [...disk.mounts.keys()].filter((path) => path.startsWith(root))) {
        disk.unmount(point);
      }
      return ok();
    }
    // The BOUNDED release: the loop is the strategy's, the unmount is this
    // container's, and the path is still the one the command names.
    const released = /\/usr\/bin\/fusermount3 -u(?:z)? '(?<path>[^']+)'/.exec(command)?.groups?.path;
    if (released !== undefined) {
      disk.unmount(unquote(released));
      return ok();
    }

    const layer = /squashfuse '(?<archive>[^']+)' '(?<point>[^']+)'/.exec(command)?.groups;
    if (layer !== undefined) {
      const bytes = disk.readFile(layer.archive!);
      if (bytes === undefined) return fail(`bad mount point: ${layer.archive!} is absent`);
      try {
        disk.unpack(bytes, layer.point!);
      } catch (error) {
        return fail(`squashfuse: ${error instanceof Error ? error.message : String(error)}`);
      }
      disk.mount(layer.point!, { source: layer.archive!, fstype: 'fuse.squashfuse', options: 'ro' });
      // The layer is mounted on the container when the isolate may go.
      deaths.reset('attach:after-layer-mount');
      return ok();
    }

    const overlay = /fuse-overlayfs -o lowerdir=(?<lowers>.+?),upperdir=(?<upper>[^,]+),workdir=[^ ]+ (?<dir>'[^']+')$/
      .exec(command)?.groups;
    if (overlay !== undefined) {
      disk.mountOverlay(unquote(overlay.dir!), {
        lowers: overlay.lowers!.split(':').map(unquote),
        upper: unquote(overlay.upper!),
      });
      deaths.reset('attach:after-overlay');
      return ok();
    }

    const seed = /^cp -a '(?<lower>[^']+)\/\.' '(?<upper>[^']+)\//.exec(command)?.groups;
    if (seed !== undefined) {
      disk.copyTree(seed.lower!, seed.upper!);
      return ok();
    }

    const checkpoint = checkpointCommand(command, disk, publish);
    if (checkpoint !== undefined) return checkpoint;

    if (command.includes('sha256sum') && command.includes('sort -z')) {
      // The walk the real command makes: inode, type, mode, size, mtime,
      // ctime, link target, path — metadata only, never content, so a hole is
      // never read and a 1 GiB sparse file costs one row.
      const upper = `${DEVBOX_RUNTIME_DIR}/upper`;
      const rows = disk.snapshot(upper).map((entry) => [
        entry.ino, entry.kind, entry.mode, entry.content === undefined ? 0 : contentSize(entry.content),
        entry.metadata?.mtimeNs ?? '0', entry.metadata?.ctimeNs ?? '0', entry.target ?? '', entry.path,
      ].join('\0'));
      const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
      return ok(digest(rows.length === 0 ? 'empty' : rows.sort().join('\0')));
    }

    const statted = /^stat -c %s '(?<path>[^']+)'/.exec(command)?.groups?.path;
    if (statted !== undefined) {
      const bytes = disk.readFile(statted);
      return ok(bytes === undefined ? '' : String(bytes.byteLength));
    }

    const reset = /^rm -rf (?<paths>.+?) && mkdir -p /.exec(command)?.groups?.paths;
    if (reset !== undefined) {
      for (const path of reset.split(' ').map(unquote)) {
        disk.rmrf(path);
        disk.mkdirp(path);
      }
      return ok();
    }

    const removed = /^rm -rf '(?<path>[^']+)'$/.exec(command)?.groups?.path;
    if (removed !== undefined) {
      // The staging directory is dropped after a commit is durable: the last
      // sub-step, and the one a death must not be able to un-commit.
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
  const wholeInodeRefusal = 'snapshot-chain archives the whole changed inode: a 4 KiB pwrite into a 64 MiB file copies 64 MiB into the upper, the 64 KiB in-place write chunked 67108864 bytes and put 89478808 bytes, 64 dirty pages put 89478658 bytes against the 4194304 bound, and the wake probes the base and the delta layers as 4 remote ops against the O(1) bound of 3 (measured 2026-09-05)';

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
    /** The source directory the last checkpoint's archiver actually packed, read
     *  off the mksquashfs command the product issued. The seal row counts what
     *  that source held, never the merged workspace beside it. */
    #packSource: string | undefined;

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
            // fuse-overlayfs copy-up: the WHOLE lower file is copied before one
            // page is changed. This is the reason the sqlite cell rejects the
            // chain, and a quota can refuse this copy before the write lands.
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

    replaceContainer(): void {
      this.disk.dead = true;
      this.disk = new ContainerDisk();
      this.#seedStamp = undefined;
      this.#publishing = undefined;
      // The old boot's held commit keeps the old gate; the replacement gets its own.
      this.#finalizeGate = new OneShotGate();
      this.#storage = this.#build();
    }

    stop(): void {
      this.disk.stopped = true;
    }

    work(): WorkRows {
      return this.#rows;
    }

    /** Drop clean upper bytes the last checkpoint published, serving them from
     *  the delta layer instead. The upper after a delta commit IS the delta
     *  just published, so replacing it with its own layer frees disk while the
     *  merged view stays exact. Called only when the upper is clean (a
     *  checkpoint then no writes, as 6.18 drives it); a dirty upper holds
     *  bytes no layer names, and clearing it would lose them. */
    evictCleanBytes(): number {
      if (row?.delta === undefined) return 0;
      const overlay = this.disk.overlays.get(DEVBOX_WORKDIR);
      if (overlay === undefined) return 0;
      const upper = this.disk.tree(overlay.upper);
      const freed = upper.bytesHeld();
      if (freed === 0) return 0;
      const chainId = row.base.id;
      const deltaKey = deltaObjectKey(STORE_ROOT, chainId);
      const bytes = durable.get(deltaKey);
      if (bytes === null) return 0;
      const mountPoint = deltaLayerMountPoint(chainId);
      this.disk.unpack(bytes, mountPoint);
      this.disk.mount(mountPoint, { source: deltaKey, fstype: 'fuse.squashfuse', options: 'ro' });
      this.disk.mountOverlay(DEVBOX_WORKDIR, { lowers: [mountPoint, ...overlay.lowers], upper: overlay.upper });
      upper.clear();
      return freed;
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
          const upperDir = `${DEVBOX_RUNTIME_DIR}/upper`;
          const workspaceBefore = await this.workspace.snapshot();
          const upperBefore = !this.disk.dead && !this.disk.stopped
            ? this.disk.snapshot(upperDir)
            : undefined;
          this.#packSource = undefined;
          const outcome = await raw.checkpoint(kind);
          let seal = NO_SEAL;
          if (outcome.kind === 'committed') {
            // WHAT THE ARCHIVER PACKED, not the workspace beside it. The product
            // stages the upper for a delta and the merged view for a fresh base;
            // the mksquashfs source recorded above says which one this commit
            // took, and the snapshot from before the commit is what it saw.
            if (this.#packSource === upperDir && upperBefore !== undefined) {
              seal = wholeTreeSeal(upperBefore, 128 * 1024);
            } else {
              seal = wholeTreeSeal(workspaceBefore, 128 * 1024);
            }
          }
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
      /** One archive, moved by the container into the store. */
      const publish = (archivePath: string, mountedPath: string): number | undefined => {
        deaths.at('before-payload');
        const mount = this.#publishing;
        if (mount === undefined || !mountedPath.startsWith(`${mount.at}/`)) {
          throw new Error(`nothing writable is mounted for ${mountedPath}`);
        }
        const bytes = this.disk.readFile(archivePath);
        if (bytes === undefined) return undefined;
        this.disk.serveFromMount(mountedPath, bytes);
        mounted.put(`${mount.prefix}${mountedPath.slice(mount.at.length + 1)}`, bytes);
        deaths.at('after-payload');
        return bytes.byteLength;
      };
      const chain = chainExec(this.disk, deaths, publish);
      const exec: typeof chain = async (command) => {
        const packed = /mksquashfs '(?<source>[^']+)' '(?<archive>[^']+)'/.exec(command)?.groups?.source;
        if (packed !== undefined) this.#packSource = packed;
        return await chain(command);
      };
      const ports: SnapshotChainPorts = {
        containerRunning: () => !this.disk.dead && !this.disk.stopped,
        allowExtraction: () => false,
        archiveExcludes: () => [],
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
        mountStore: async (at) => {
          if (this.disk.dead) throw new ContainerDied('mountStore on a dead container');
          this.disk.mount(at, { source: `r2:${STORE_ROOT}`, fstype: 'fuse.s3fs', options: 'rw' });
          for (const key of durable.list(`${STORE_ROOT}/`)) {
            const relative = key.slice(STORE_ROOT.length + 1);
            this.disk.serveFromMount(`${at}/${relative}`, mounted.get(key)!);
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
          key: deltaObjectKey(STORE_ROOT, row.base.id),
          byteLength: row.delta.bytes,
          names: [deltaObjectKey(STORE_ROOT, row.base.id), 'delta'],
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
      // A property of the format, measured 2026-09-05: the overlay copies the
      // whole inode into the upper on the first write, and the delta archives
      // the whole upper. A sub-file delta is a different format.
      '6.14': { reason: wholeInodeRefusal },
      '6.15': { reason: wholeInodeRefusal },
    },
  };
}
// ── shared plumbing ────────────────────────────────────────────────────────


/**
 * The shipped strategy, as one contract.
 *
 * KEYED BY `DevboxStrategyName` ON PURPOSE: a second strategy added to that
 * union makes this record incomplete, and an incomplete record does not
 * compile. A strategy nobody conforms is therefore not a strategy anybody can
 * add — which is the only version of this list that stays true.
 */
export const CONFORMANCE_ARMS = {
  'snapshot-chain': snapshotChainArm,
} satisfies Record<DevboxStrategyName, () => ConformanceArm>;
