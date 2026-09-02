/**
 * One machine, five strategies.
 *
 * WHY THIS EXISTS. Every per-strategy suite builds its own stand-in for the one
 * thing its strategy needs, and none of them can be pointed at another
 * strategy: `snapshot-chain.test.ts` models the store as key-to-SIZE, so no
 * byte ever travels; `r2fs.test.ts` models the mount as a boolean; the
 * `MemoryStore` in `overlay-cas.test.ts` is a real `CasStore` but lives inside a
 * 1200-line suite that would run on import; `candidate-runner.test.ts` answers
 * every runner invocation with canned JSON, so its arms never build or read a
 * payload. Four fakes, four vocabularies, and not one of them can ask the
 * question the deployed benchmarks answered by accident: does THIS strategy
 * hand back the bytes it was given, across a container replacement, at every
 * point a container can die?
 *
 * So this module is a MACHINE rather than a fifth fake of a store: a durable
 * object store that outlives container generations, one container disk that a
 * replacement blanks, and the five real `DevboxStorage` adapters wired to both
 * through their own production ports. Nothing here decides anything a strategy
 * decides. Where a strategy's byte work happens container-side — the snapshot
 * chain's archiver, the overlay-cas runner, the candidate runner — this module
 * runs the SHIPPED code in-process (`stageBlobs`, `foldJournalIntoTree`,
 * `fileChunkStream`, `build`, `buildMerklePack`, `open`, `openMerklePack`,
 * `stageCandidatePayload`, `finalizeCandidateOperation`) against in-memory
 * bytes, and only simulates what genuinely cannot run here: mksquashfs,
 * fuse-overlayfs and s3fs.
 *
 * THE FAULT SEAM IS THE PORTS, and it was already there. Every strategy takes
 * its whole world as an injected port set, so a container death at a commit
 * sub-step is a port that throws at that instant — inside the shipped code,
 * between the two durable effects the sub-step separates. Nothing is
 * monkey-patched and no production file grew a test hook: {@link ContainerDied}
 * is raised by this module's adapters at seams NAMED FROM EACH STRATEGY'S OWN
 * KEY LAYOUT, so a seam cannot drift from the thing it interrupts.
 */

import * as v from 'valibot';

import {
  ControlReset,
  MemoryControlStore,
} from './candidate-control';
import { sessionShellRefusal } from './session-shell';
import {
  LiveTree,
  ancestorsOf,
  runBytes,
  sortedByPath,
  type LiveInode,
  type TreeProperty,
} from './tree-model';
import {
  appendJournalBatch,
  blobKey,
  coalesce,
  digestBytes,
  emptyCounters,
  fileChunkStream,
  foldJournalIntoTree,
  KEY_CURSOR,
  KEY_MANIFEST,
  listJournalAfter,
  PREFIX_BLOBS,
  PREFIX_JOURNAL,
  PREFIX_TREE,
  readFoldedSeq,
  readManifest,
  stageBlobs,
  stampEntries,
  sweepOrphanBlobs,
  treeKey,
  type CasPutMeta,
  type CasStore,
  type NewJournalEntry,
  type StoreCounters,
} from '../../src/cas';
import { sha256Hex } from '../../src/cas/hash';
import {
  build as buildBoundedLayers,
  isHoleExtent,
  open as openBoundedLayers,
} from '../../src/candidates/bounded-layers';
import {
  candidateStorePaths,
  candidateContainerStorage,
  CANDIDATE_JOURNAL_ROOT,
  CANDIDATE_STORE_MOUNT,
  type CandidateContainerFormat,
  type CandidateContainerPorts,
  type CandidateRunnerProcess,
} from '../../src/candidates/container';
import {
  beginCandidateOperation,
  candidateRunControl,
  finalizeCandidateOperation,
  redriveCandidateOperation,
  settleCandidateNoChange,
  type CandidateControlStore,
  type CandidateEnvelopeStore,
} from '../../src/candidates/control';
import {
  buildMerklePack,
  openMerklePack,
  parentFromPublishedParent,
} from '../../src/candidates/merkle-pack';
import {
  MemoryCandidateObjectSink,
  envelopeBytes,
  parseEnvelopeBytes,
  recoverPublishedParent,
  stageCandidatePayload,
  type CandidatePayloadStore,
} from '../../src/candidates/publication';
import {
  contentSize,
  issueVerifiedJournalCapture,
  manifestSha256,
  type AuditedCapture,
  type Capture,
  type FileContent,
  type NodeEntry,
  type PosixMetadata,
} from '../../src/capture/model';
import { paintedSegments } from '../../src/candidates/merkle-pack/chunk';
import type {
  CandidateControlStateV1,
  CandidateRunControlV1,
  DurabilityAwaitPoint,
  ImmutableObjectRef,
  ObjectReceipt,
  PayloadGrant,
  RangeReadIntent,
  UploadIntent,
} from '../../src/durability/contracts';
import {
  CAS_STORE_MOUNT,
  CAS_TREE_MOUNT,
  overlayCasStorage,
  type OverlayCasOperation,
  type OverlayCasPorts,
  type OverlayCasState,
} from '../../src/overlay-cas';
import { R2FS_CACHE_DIR, r2fsStorage, type R2fsPorts } from '../../src/r2fs';
import {
  baseObjectKey,
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

/**
 * One operation crossed the same durable sub-step more times than it may.
 *
 * THE BOUNDED-WORK FENCE, and it exists because an unbounded retry loop is not
 * a hang to be waited out: `candidateContainerStorage`'s checkpoint loop
 * compared an operation kind against a checkpoint kind and therefore published
 * a fresh generation forever on every quiesce. A budget turns that into a
 * NAMED failure at the second publication instead of a test timeout, so the
 * suite reports the defect rather than the symptom.
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
   * Reached one durable CONTROL write. Throws the shipped reset the candidate
   * control plane is designed around — {@link ControlReset} extends
   * `PublicationInterrupted`, which is how the publication code is told the
   * operation was interrupted rather than refused.
   */
  reset(seam: string): void {
    this.#record(seam);
    if (this.#armed !== seam) return;
    this.#armed = null;
    throw new ControlReset(seam);
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
      digest: sha256Hex(held.bytes),
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
        if (!this.mountServed.has(key)) this.charge(-bytes.byteLength);
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
    if (content.kind === 'sealed') return undefined;
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

/** What a caller does to the work directory, whatever serves it. */
export interface Workspace {
  write(path: string, text: string): void;
  read(path: string): string | undefined;
  remove(path: string): void;
  /** File paths only, sorted: the listing a text fixture compares against. */
  paths(): readonly string[];
  /**
   * Plant a complete tree at full fidelity: directories, files, symlinks,
   * hardlinks (entries that share an `ino` share one inode), sparse content
   * as runs, and every metadata field. Existing paths are replaced.
   */
  plant(entries: readonly NodeEntry[]): void;
  /** The tree the workspace serves, as capture entries, at the fidelity the
   *  arm serves it. Inode ids share exactly where the served inodes share. */
  snapshot(): readonly NodeEntry[];
  /** `pwrite(2)`: overwrite bytes in place at an offset. The sqlite pattern. */
  pwrite(path: string, offset: number, bytes: Uint8Array): void;
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

/**
 * Which `DURABILITY_AWAIT_POINTS` an arm reaches, in register order. Mirrors
 * the contracts lane's `AwaitPointDeclaration` (`{ format, uses }`); an arm
 * outside the durability contract declares `uses: []` and says why.
 */
export interface AwaitPointUse {
  readonly uses: readonly DurabilityAwaitPoint[];
  /** Why the arm reaches none, for an arm that predates the contract. */
  readonly none?: string;
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
  /** Arm one reset/death at the named durability await point. */
  faultAt(point: DurabilityAwaitPoint): void;
  /** How many times this arm reached the await point. */
  awaitVisits(point: DurabilityAwaitPoint): number;
  /** Prefixes the container owns through its mount. */
  payloadPrefixes(): readonly string[];
  controlPlane(): Promise<ControlPlacement>;
  declaredPayload(): Promise<readonly DeclaredObject[]>;
  /**
   * Does the read path hold a declared payload object to its declared identity?
   *
   * FALSE IS A REAL ANSWER, not a gap. r2fs IS the filesystem: it declares no
   * size and no digest anywhere, so there is nothing for it to refuse against,
   * and a battery that pretended otherwise would be asserting a property the
   * strategy never claimed. What is asked of a pass-through arm instead is that
   * it never REPORTS bytes the store does not hold.
   */
  readonly refusesCorruptPayload: boolean;
  /** Every committed head the ledger names. Exactly one is the invariant. */
  committedHeads(): Promise<readonly string[]>;
  /** The counted-work rows for the last checkpoint and the last attach. */
  work(): WorkRows;
  /** Which durability await points this arm reaches. */
  readonly awaitPoints: AwaitPointUse;
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
  const repair = raw.repairAttached;
  if (repair !== undefined) storage.repairAttached = async () => await repair.call(raw);
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

/**
 * The declaration every arm outside the durability contract makes: it reaches
 * no await point because its ports predate the register. Its own commit seams
 * are its fault map, and cell 6.4 walks them.
 */
const NO_AWAIT_POINTS: AwaitPointUse = {
  uses: [],
  none: 'the strategy predates the durability contract; its commit seams are its fault map',
};

/** One namespace keeps await-point faults distinct from legacy commit seams. */
function awaitPointSeam(point: DurabilityAwaitPoint): string {
  return `await:${point}`;
}

/** The one cell this machine cannot host for any arm: it lives on the
 *  devbox-harness with the real class. Named so the matrix says where. */
export const HARNESS_OWNED_CELLS = {
  '6.19': { reason: 'owned by candidate-attach.test.ts: stop then wake on the same instance needs the Devbox class and the platform stand-in' },
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
    // `strategy-conformance.test.ts` or `candidate-attach.test.ts` reaches it,
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
      return ok(rows.length === 0 ? sha256Hex(encoder.encode('empty')) : sha256Hex(encoder.encode(rows.sort().join('\0'))));
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

    constructor() {
      this.workspace = {
        write: (path, text) => {
          if (!this.disk.overlays.has(DEVBOX_WORKDIR)) {
            throw new Error('the chain workspace is not attached, so a write has nowhere to land');
          }
          this.disk.writeFile(`${DEVBOX_WORKDIR}/${path}`, encoder.encode(text));
        },
        read: (path) => {
          const bytes = this.disk.readFile(`${DEVBOX_WORKDIR}/${path}`);
          return bytes === undefined ? undefined : decoder.decode(bytes);
        },
        remove: (path) => this.disk.removeFile(`${DEVBOX_WORKDIR}/${path}`),
        paths: () => this.disk.entries(DEVBOX_WORKDIR),
        plant: (entries) => {
          const overlay = this.disk.overlays.get(DEVBOX_WORKDIR);
          if (overlay === undefined) throw new Error('the chain workspace is not attached');
          this.disk.tree(overlay.upper).plant(entries);
        },
        snapshot: () => this.disk.snapshot(DEVBOX_WORKDIR),
        pwrite: (path, offset, bytes) => {
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
              cpuSteps: this.workspace.snapshot().length,
              replayUnits: this.disk.layerMountCalls - layers,
            }),
          };
          return outcome;
        },
        checkpoint: async (kind) => {
          const window = { from: durable.ops.length };
          const snapshot = this.workspace.snapshot();
          const outcome = await raw.checkpoint(kind);
          this.#rows = {
            ...this.#rows,
            seal: wholeTreeSeal(snapshot, 128 * 1024),
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
      const exec = chainExec(this.disk, deaths, publish);
      const ports: SnapshotChainPorts = {
        containerRunning: () => !this.disk.dead && !this.disk.stopped,
        allowExtraction: () => false,
        archiveExcludes: () => [],
        readState: async () => row,
        writeState: async (next) => {
          // The pointer is the commit. The hold is before it: the old boot has
          // staged bytes and its late finalize arrives after the new boot.
          await this.#finalizeGate.cross();
          deaths.at('before-pointer');
          row = next;
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
    faultAt: (point) => deaths.arm(awaitPointSeam(point)),
    awaitVisits: (point) => deaths.visits(awaitPointSeam(point)),
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
    refusesCorruptPayload: true,
    committedHeads: async () => row === null ? [] : [`${row.base.id}#${row.rev}`],
    work: () => current.work(),
    awaitPoints: NO_AWAIT_POINTS,
    refusedProperties: {
      times: { reason: 'squashfs stores mtime only; atime and ctime are not durable fields' },
    },
    refusedCells: HARNESS_OWNED_CELLS,
  };
}
// ── r2fs ────────────────────────────────────────────────────────────────────

function r2fsArm(): ConformanceArm {
  const durable = new DurableStore();
  const deaths = new DeathWatch();
  const prefix = 'boxes/box-conformance';
  const prefixWithSlash = `${prefix}/`;
  const largeSparseRefusal = 's3fs stores an object body; it has no sparse-hole wire format and a 1 GiB hole would become 1 GiB';

  const objectMeta = (entry: NodeEntry) => ({
    'kinu-kind': entry.kind,
    'kinu-mode': String(entry.mode),
    'kinu-uid': String(entry.metadata?.uid ?? 0),
    'kinu-gid': String(entry.metadata?.gid ?? 0),
    'kinu-atime-ns': entry.metadata?.atimeNs ?? '0',
    'kinu-mtime-ns': entry.metadata?.mtimeNs ?? '0',
    'kinu-ctime-ns': entry.metadata?.ctimeNs ?? '0',
    'kinu-xattrs': JSON.stringify(entry.metadata?.xattrs ?? {}),
  });

  const denseBody = (entry: NodeEntry): Uint8Array => {
    if (entry.kind === 'symlink') return encoder.encode(entry.target ?? '');
    if (entry.kind !== 'file' || entry.content === undefined) return new Uint8Array(0);
    if (entry.content.kind === 'dense') return entry.content.bytes;
    if (entry.content.kind === 'sealed') throw new Error('r2fs cannot stage a sealed capture handle');
    if (entry.content.size > 128 * 1024 * 1024) throw new ArmRefused('6.14', largeSparseRefusal);
    const bytes = new Uint8Array(entry.content.size);
    for (const run of entry.content.runs) bytes.set(
      run.bytes.subarray(0, Math.max(0, entry.content.size - run.offset)), run.offset,
    );
    return bytes;
  };

  class R2Boot implements ArmBoot {
    disk = new ContainerDisk();
    readonly failures: string[] = [];
    readonly workspace: Workspace;
    #dirty = this.disk.tree(`${DEVBOX_RUNTIME_DIR}/r2fs-dirty`);
    readonly #tombstones = new Set<string>();
    #finalizeGate = new OneShotGate();
    #storage: DevboxStorage;
    #rows: WorkRows = { seal: NO_SEAL, publish: NO_PUBLISH, restore: NO_RESTORE };
    #publishFrom = durable.ops.length;

    constructor() {
      this.workspace = {
        write: (path, text) => {
          this.#dirty.writeFile(path, encoder.encode(text));
          this.#tombstones.delete(path);
        },
        read: (path) => {
          const local = this.#dirty.node(path);
          if (local?.kind === 'file' && local.content?.kind === 'dense') return decoder.decode(local.content.bytes);
          if (this.#tombstones.has(path)) return undefined;
          const bytes = durable.get(`${prefixWithSlash}${path}`);
          const meta = durable.meta(`${prefixWithSlash}${path}`);
          return bytes === null || meta?.['kinu-kind'] !== 'file' ? undefined : decoder.decode(bytes);
        },
        remove: (path) => {
          this.#dirty.remove(path);
          this.#tombstones.add(path);
        },
        paths: () => {
          const files = new Set<string>();
          for (const [key, held] of durable.objects) {
            if (key.startsWith(prefixWithSlash) && held.meta['kinu-kind'] === 'file') {
              files.add(key.slice(prefixWithSlash.length));
            }
          }
          for (const path of this.#dirty.filePaths()) files.add(path);
          for (const path of this.#tombstones) files.delete(path);
          return [...files].sort();
        },
        plant: (entries) => {
          this.#dirty.plant(entries);
          for (const entry of entries) this.#tombstones.delete(entry.path);
        },
        snapshot: () => this.#snapshot(),
        pwrite: (path, offset, bytes) => {
          if (!this.#dirty.has(path)) {
            const durableEntries = this.#durableEntries();
            const entry = durableEntries.find((row) => row.path === path);
            if (entry === undefined) throw new Error(`pwrite: no file at ${path}`);
            const names = new Set([...ancestorsOf(path), path]);
            this.#dirty.plant(durableEntries.filter((row) => names.has(row.path)));
          }
          this.#dirty.pwrite(path, offset, bytes);
          this.#tombstones.delete(path);
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
      this.#storage = this.#build();
    }

    replaceContainer(): void {
      this.disk.dead = true;
      this.disk = new ContainerDisk();
      this.#dirty = this.disk.tree(`${DEVBOX_RUNTIME_DIR}/r2fs-dirty`);
      this.#tombstones.clear();
      this.#finalizeGate = new OneShotGate();
      this.#storage = this.#build();
    }

    stop(): void {
      this.disk.stopped = true;
    }

    work(): WorkRows {
      return this.#rows;
    }

    #durableEntries(): NodeEntry[] {
      const entries: NodeEntry[] = [];
      let ino = 1;
      for (const [key, held] of [...durable.objects].sort(([a], [b]) => (a < b ? -1 : 1))) {
        if (!key.startsWith(prefixWithSlash)) continue;
        const kind = held.meta['kinu-kind'];
        if (kind !== 'file' && kind !== 'dir' && kind !== 'symlink') continue;
        const path = key.slice(prefixWithSlash.length);
        const metadata: PosixMetadata = {
          uid: Number(held.meta['kinu-uid'] ?? 0),
          gid: Number(held.meta['kinu-gid'] ?? 0),
          atimeNs: held.meta['kinu-atime-ns'] ?? '0',
          mtimeNs: held.meta['kinu-mtime-ns'] ?? '0',
          ctimeNs: held.meta['kinu-ctime-ns'] ?? '0',
          xattrs: JSON.parse(held.meta['kinu-xattrs'] ?? '{}'),
        };
        const base = { path, mode: Number(held.meta['kinu-mode'] ?? 0), ino: ino++, metadata };
        if (kind === 'symlink') entries.push({ ...base, kind: 'symlink', target: decoder.decode(held.bytes) });
        else if (kind === 'file') entries.push({ ...base, kind: 'file', content: { kind: 'dense', bytes: held.bytes } });
        else entries.push({ ...base, kind: 'dir' });
      }
      return entries;
    }

    #snapshot(): NodeEntry[] {
      const durableEntries = this.#durableEntries();
      const merged = new Map(durableEntries.map((entry) => [entry.path, entry]));
      const inoBase = durableEntries.length + 1;
      for (const entry of this.#dirty.snapshot()) merged.set(entry.path, { ...entry, ino: entry.ino + inoBase });
      for (const path of this.#tombstones) merged.delete(path);
      return sortedByPath([...merged.values()]);
    }

    #flush(): void {
      for (const path of this.#tombstones) durable.delete(`${prefixWithSlash}${path}`);
      for (const entry of this.#dirty.snapshot()) {
        durable.put(`${prefixWithSlash}${entry.path}`, denseBody(entry), objectMeta(entry));
      }
      this.#dirty.clear();
      this.#tombstones.clear();
    }

    #meter(raw: DevboxStorage): DevboxStorage {
      return withOptionalMembers(raw, {
        attach: async () => {
          const window = { from: durable.ops.length };
          const mounts = this.disk.mountCalls;
          const outcome = await raw.attach();
          this.#rows = {
            ...this.#rows,
            restore: restoreWorkSince(durable, window, [prefixWithSlash], {
              mounts: this.disk.mountCalls - mounts, cpuSteps: 0, replayUnits: 0,
            }),
          };
          this.#publishFrom = durable.ops.length;
          return outcome;
        },
        checkpoint: async (kind) => {
          const changed = this.#dirty.snapshot();
          const outcome = await raw.checkpoint(kind);
          let stagedBytes = 0;
          let files = 0;
          for (const entry of changed) {
            if (entry.kind !== 'file' || entry.content === undefined) continue;
            stagedBytes += runBytes(entry.content);
            files += 1;
          }
          this.#rows = {
            ...this.#rows,
            seal: {
              bytesStaged: stagedBytes, bytesChunked: 0, chunksHashed: 0,
              nodesRewritten: changed.length, wholeFiles: files,
            },
            publish: publishWorkSince(durable, { from: this.#publishFrom }, 0),
          };
          this.#publishFrom = durable.ops.length;
          return outcome;
        },
        discard: async () => await raw.discard(),
      });
    }

    #build(): DevboxStorage {
      const ports: R2fsPorts = {
        containerRunning: () => !this.disk.dead && !this.disk.stopped,
        readMounts: async () => this.disk.procMounts(),
        exec: async (command) => {
          const refused = sessionShellRefusal(command);
          if (refused !== undefined) throw refused;
          if (command.startsWith('mkdir -p')) {
            for (const path of command.slice('mkdir -p'.length).trim().split(' ')) {
              this.disk.mkdirp(path.replace(/^'|'$/g, ''));
            }
            return { stdout: '', stderr: '', exitCode: 0 };
          }
          if (command.startsWith('sync')) {
            await this.#finalizeGate.cross();
            deaths.at('before-sync');
            this.#flush();
            deaths.at('after-sync');
            return { stdout: '0', stderr: '', exitCode: 0 };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        },
        pathExists: async (path) => this.disk.exists(path),
        mount: async () => {
          if (this.disk.dead) throw new ContainerDied('mount on a dead container');
          this.disk.mkdirp(R2FS_CACHE_DIR);
          this.disk.mount(DEVBOX_WORKDIR, { source: `s3fs:${prefix}`, fstype: 'fuse.s3fs', options: 'rw' });
          deaths.reset('attach:after-mount');
        },
        unmount: async () => { this.disk.unmount(DEVBOX_WORKDIR); },
        parkSession: async () => DEVBOX_RUNTIME_DIR,
        lazyUnmount: async () => {
          this.disk.unmount(DEVBOX_WORKDIR);
          return true;
        },
        inventory: async () => durable.inventory(prefixWithSlash),
        clearPrefix: async () => durable.deletePrefix(prefixWithSlash),
        quarantineMountpoint: async () => 0,
        log: () => undefined,
      };
      return this.#meter(r2fsStorage(ports));
    }
  }

  let current = new R2Boot();
  return {
    name: 'r2fs',
    storage: () => current.storage(),
    get workspace() { return current.workspace; },
    get failures() { return current.failures; },
    durable,
    deaths,
    holdFinalize: () => current.holdFinalize(),
    replaceContainer: () => current.replaceContainer(),
    stopContainer: () => current.stop(),
    resetIsolate: () => current.resetIsolate(),
    secondBoot: () => new R2Boot(),
    disk: () => current.disk,
    commitSeams: ['before-sync', 'after-sync'],
    publishSeam: 'after-sync',
    attachSeams: ['attach:after-mount'],
    dieAt: (seam) => deaths.arm(seam),
    faultAt: (point) => deaths.arm(awaitPointSeam(point)),
    awaitVisits: (point) => deaths.visits(awaitPointSeam(point)),
    payloadPrefixes: () => [prefixWithSlash],
    controlPlane: async () => ({
      objectKeys: [],
      rows: [],
      head: durable.inventory(prefixWithSlash).objects === 0 ? null : prefixWithSlash,
    }),
    declaredPayload: async () => [],
    refusesCorruptPayload: false,
    committedHeads: async () => durable.inventory(prefixWithSlash).objects === 0 ? [] : [prefixWithSlash],
    work: () => current.work(),
    awaitPoints: NO_AWAIT_POINTS,
    refusedProperties: {
      hardlink: { reason: 's3fs stores one object per path and does not preserve inode sharing' },
      sparse: { reason: 'the object body carries logical bytes and no hole geometry' },
    },
    refusedCells: {
      ...HARNESS_OWNED_CELLS,
      '6.14': { reason: largeSparseRefusal },
    },
  };
}
// ── overlay-cas ─────────────────────────────────────────────────────────────

/** The CAS seam, over the durable store, at the box's own prefix. */
class DurableCasStore implements CasStore {
  readonly counters: StoreCounters = emptyCounters();

  constructor(
    private readonly durable: DurableStore,
    private readonly prefix: string,
    private readonly deaths: DeathWatch,
  ) {}

  async put(key: string, bytes: Uint8Array, meta?: CasPutMeta): Promise<void> {
    this.counters.putCalls += 1;
    this.counters.bytesPut += bytes.byteLength;
    this.durable.put(`${this.prefix}${key}`, bytes, meta === undefined ? {} : {
      mode: String(meta.mode),
      mtimeMs: String(meta.mtimeMs ?? 0),
      symlink: String(meta.symlink === true),
    });
    // THE SEAMS ARE THE KEY LAYOUT. Each prefix is one durable sub-step of a
    // fold, so a death named after a prefix lands between two of them and
    // cannot drift from what it interrupts.
    this.deaths.at(`after-${seamOfCasKey(key)}`);
  }

  async putStream(
    key: string,
    stream: ReadableStream<Uint8Array>,
    size: number,
    meta?: CasPutMeta,
  ): Promise<void> {
    const bytes = await drain(stream);
    if (bytes.byteLength !== size) {
      throw new Error(`${key} streamed ${bytes.byteLength} bytes, declared ${size}`);
    }
    await this.put(key, bytes, meta);
  }

  async get(key: string): Promise<Uint8Array | null> {
    this.counters.getCalls += 1;
    const bytes = this.durable.get(`${this.prefix}${key}`);
    if (bytes !== null) this.counters.bytesGot += bytes.byteLength;
    return bytes;
  }

  async head(key: string): Promise<{ size: number } | null> {
    this.counters.headCalls += 1;
    const held = this.durable.head(`${this.prefix}${key}`);
    return held === null ? null : { size: held.size };
  }

  async delete(key: string): Promise<void> {
    this.counters.deleteCalls += 1;
    this.durable.delete(`${this.prefix}${key}`);
  }

  async list(prefix: string): Promise<string[]> {
    this.counters.listCalls += 1;
    return this.durable.list(`${this.prefix}${prefix}`).map(key => key.slice(this.prefix.length));
  }
}

function seamOfCasKey(key: string): string {
  if (key.startsWith(PREFIX_BLOBS)) return 'blob';
  if (key.startsWith(PREFIX_JOURNAL)) return 'journal';
  if (key.startsWith(PREFIX_TREE)) return 'tree';
  if (key === KEY_MANIFEST) return 'manifest';
  if (key === KEY_CURSOR) return 'cursor';
  return 'scan';
}

function overlayCasArm(): ConformanceArm {
  const durable = new DurableStore();
  const deaths = new DeathWatch();
  const prefix = 'boxes/box-conformance';
  const lateRaceRefusal = 'overlay-cas has no control head CAS; concurrent containers share and may merge one prefix';
  const fidelityRefusal = 'overlay-cas tree objects carry mode and mtime only; they do not preserve uid/gid, xattrs, hardlink inode sharing or holes';
  const largeSparseRefusal = 'overlay-cas scans a file as dense 512 KiB chunks; it has no sparse-hole scan protocol';
  let row: OverlayCasState | null = null;
  let rows: WorkRows = { seal: NO_SEAL, publish: NO_PUBLISH, restore: NO_RESTORE };
  const failures: string[] = [];
  let finalizeGate = new OneShotGate();
  let container = freshContainer();
  let storage = build();

  /** The upper, and the whiteouts a delete leaves in it. Both die with the
   *  container: only `/workspace` is supplied by the image. */
  function freshContainer() {
    const disk = new ContainerDisk();
    return {
      disk,
      upper: new Map<string, Uint8Array>(),
      tree: disk.tree(`${DEVBOX_RUNTIME_DIR}/overlay-upper`),
      whiteouts: new Set<string>(),
      overlay: false,
      storeMounted: false,
    };
  }

  const store = (): DurableCasStore => new DurableCasStore(durable, `${prefix}/`, deaths);

  /**
   * The container-side runner, as the shipped CAS helpers.
   *
   * `runOverlayRunner` itself needs a real openat2 root and a real mount, which
   * is the one thing that cannot run in-process — so this performs its exact
   * sequence with its exact functions: scan, stage blobs, commit the journal
   * batch, and on a fold `foldJournalIntoTree` then `sweepOrphanBlobs`. Nothing
   * about crash ORDER is decided here, because none of those steps is
   * reimplemented.
   */
  async function invokeRunner(operation: OverlayCasOperation) {
    const cas = store();
    const openedBytesPut = cas.counters.bytesPut;
    const moved = (): number => cas.counters.bytesPut - openedBytesPut;
    if (operation === 'restore') {
      // O(pending change): replay every RAW entry after the folded cursor,
      // through the shipped verifying stream. `replayPending` deliberately
      // returns the flattened journal rather than its coalesced view: until a
      // fold removes a batch, each data part that batch names is a blob GET the
      // real runner makes, including superseded versions of one path. Counting
      // the coalesced paths here made the conformance arm promise a cheaper
      // restore than the runner performs.
      const folded = await readFoldedSeq(cas);
      const pending = await listJournalAfter(cas, folded);
      for (const entry of pending) {
        if (entry.kind === 'delete') {
          container.upper.delete(entry.path);
          container.tree.remove(entry.path);
          container.whiteouts.add(entry.path);
          continue;
        }
        // The current runner restores every non-file kind too. This machine
        // keeps the byte workload here and declares the richer fidelity cell
        // refused below; text durability still crosses the shipped stream.
        if (entry.kind !== 'file') continue;
        const bytes = await drain(fileChunkStream(cas, entry));
        container.upper.set(entry.path, bytes);
        container.tree.writeFile(entry.path, bytes);
        container.whiteouts.delete(entry.path);
      }
      deaths.reset('attach:after-restore');
      return receipt('restore', {
        entries: pending.length,
        movedBytes: moved(),
        foldedSeq: folded,
      });
    }

    const manifest = await readManifest(cas);
    const foldedSeq = await readFoldedSeq(cas);
    const journalled = coalesce(await listJournalAfter(cas, foldedSeq));
    const known = new Map<string, string>();
    for (const [path, entry] of manifest) if (entry.kind === 'file') known.set(path, entry.hash);
    for (const entry of journalled) {
      if (entry.kind === 'file') known.set(entry.path, entry.hash);
      if (entry.kind === 'delete') known.delete(entry.path);
    }
    const fresh: NewJournalEntry[] = [];
    for (const [path, bytes] of [...container.upper].sort(([a], [b]) => a < b ? -1 : 1)) {
      const digest = digestBytes(bytes);
      if (known.get(path) === digest.hash) continue;
      fresh.push({
        kind: 'file',
        path,
        mode: 0o644,
        mtimeMs: 0,
        size: digest.size,
        hash: digest.hash,
        parts: digest.parts,
      });
    }
    for (const path of [...container.whiteouts].sort()) {
      if (known.has(path)) fresh.push({ kind: 'delete', path });
    }
    const nextSeq = (journalled.at(-1)?.seq ?? foldedSeq) + 1;
    const staged = await stageBlobs({
      store: cas,
      entries: stampEntries(fresh, nextSeq),
      readChunk: async (entry, index, size) => {
        const held = container.upper.get(entry.path);
        if (held === undefined) return null;
        const start = index * 512 * 1024;
        const view = held.subarray(start, start + size);
        return view.byteLength === size ? view : null;
      },
      commitBatch: async batch => await appendJournalBatch(cas, batch),
    });
    if (operation === 'checkpoint') {
      return receipt('checkpoint', {
        entries: staged.staged.length,
        movedBytes: moved(),
        foldedSeq,
      });
    }
    const folded = await foldJournalIntoTree(cas);
    const swept = await sweepOrphanBlobs(cas);
    return receipt('fold', {
      entries: staged.staged.length,
      movedBytes: moved(),
      foldedEntries: folded.foldedEntries,
      sweptBlobs: swept.deleted,
      foldedSeq: folded.cursorAfter,
    });
  }

  function meter(raw: DevboxStorage): DevboxStorage {
    return withOptionalMembers(raw, {
      attach: async () => {
        const window = { from: durable.ops.length };
        const mounts = container.disk.mountCalls;
        const outcome = await raw.attach();
        rows = {
          ...rows,
          restore: restoreWorkSince(durable, window, [`${prefix}/${PREFIX_BLOBS}`, `${prefix}/${PREFIX_TREE}`], {
            mounts: container.disk.mountCalls - mounts, cpuSteps: container.tree.size, replayUnits: container.tree.size,
          }),
        };
        return outcome;
      },
      checkpoint: async (kind) => {
        const window = { from: durable.ops.length };
        const snapshot = workspace.snapshot();
        const outcome = await raw.checkpoint(kind);
        rows = {
          ...rows,
          seal: wholeTreeSeal(snapshot, 512 * 1024),
          publish: publishWorkSince(durable, window, 0),
        };
        return outcome;
      },
      discard: async () => await raw.discard(),
    });
  }

  function build(): DevboxStorage {
    const ports: OverlayCasPorts = {
      containerRunning: () => !container.disk.dead && !container.disk.stopped,
      mountStore: async () => {
        if (container.disk.dead) throw new ContainerDied('mountStore on a dead container');
        if (container.disk.stopped) throw new ContainerStopped('mountStore');
        container.disk.mount(CAS_STORE_MOUNT, {
          source: `s3fs:${prefix}`,
          fstype: 'fuse.s3fs',
          options: 'rw',
        });
        container.disk.mkdirp(CAS_TREE_MOUNT);
        container.storeMounted = true;
        deaths.reset('attach:after-store-mount');
      },
      unmountStore: async () => {
        if (container.disk.dead || container.disk.stopped) return;
        container.disk.unmount(CAS_STORE_MOUNT);
        container.storeMounted = false;
      },
      mountOverlay: async () => {
        if (container.disk.dead) throw new ContainerDied('mountOverlay on a dead container');
        container.overlay = true;
        deaths.reset('attach:after-overlay');
      },
      unmountOverlay: async () => {
        container.overlay = false;
      },
      overlayMounted: async () => container.overlay && !container.disk.dead && !container.disk.stopped,
      invokeRunner: async (operation) => {
        try {
          const printed = await invokeRunner(operation);
          return { stdout: `${JSON.stringify(printed)}\n`, stderr: '', exitCode: 0 };
        } catch (error) {
          if (error instanceof ContainerDied || error instanceof ControlReset || error instanceof ArmRefused) throw error;
          // A runner that failed prints its diagnosis and exits non-zero, which
          // is the only evidence the Durable Object gets.
          return {
            stdout: '',
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: 1,
          };
        }
      },
      inventory: async () => durable.inventory(`${prefix}/`),
      clearPrefix: async () => durable.deletePrefix(`${prefix}/`),
      // Same as the r2fs arm: this machine's workspace refuses a write with no
      // overlay mounted, so no residue can exist here. `overlay-cas.test.ts`
      // owns the case where a replaced container left bytes in the bare work
      // directory.
      salvageWorkdirResidue: async () => 0,
      readState: async () => row,
      writeState: async (next) => {
        await finalizeGate.cross();
        row = next;
        if (next.lastFailure !== undefined) failures.push(next.lastFailure.reason);
      },
      clearState: async () => {
        row = null;
      },
      checkpointIntervalMs: () => 0,
      now: () => Date.now(),
      log: () => undefined,
    };
    return meter(overlayCasStorage(ports));
  }

  /** The overlay: the upper over the folded tree, which is what the mount
   *  serves. A read that misses the upper reads the tree object, exactly as
   *  s3fs would — no verification, because the mount does none. */
  const workspace: Workspace = {
    write: (path, text) => {
      if (!container.overlay) throw new Error('the overlay-cas workspace is not attached');
      const bytes = encoder.encode(text);
      container.tree.writeFile(path, bytes);
      container.upper.set(path, bytes);
      container.whiteouts.delete(path);
    },
    read: (path) => {
      const held = container.upper.get(path);
      if (held !== undefined) return decoder.decode(held);
      if (container.whiteouts.has(path) || !container.overlay) return undefined;
      const lower = durable.get(`${prefix}/${treeKey(path)}`);
      return lower === null ? undefined : decoder.decode(lower);
    },
    remove: (path) => {
      container.upper.delete(path);
      container.tree.remove(path);
      container.whiteouts.add(path);
    },
    paths: () => {
      const found = new Set<string>(container.upper.keys());
      if (container.overlay) {
        for (const key of durable.list(`${prefix}/${PREFIX_TREE}`)) {
          found.add(key.slice(`${prefix}/${PREFIX_TREE}`.length));
        }
      }
      for (const path of container.whiteouts) found.delete(path);
      return [...found].sort();
    },
    plant: (entries) => {
      for (const entry of entries) {
        if (entry.content?.kind === 'sparse' && entry.content.size > 128 * 1024 * 1024) {
          throw new ArmRefused('6.14', largeSparseRefusal);
        }
      }
      container.tree.plant(entries);
      for (const entry of entries) {
        if (entry.kind !== 'file' || entry.content === undefined) continue;
        let bytes: Uint8Array;
        if (entry.content.kind === 'dense') bytes = entry.content.bytes;
        else if (entry.content.kind === 'sealed') throw new Error('overlay-cas cannot scan a sealed capture handle');
        else {
          bytes = new Uint8Array(entry.content.size);
          for (const run of entry.content.runs) bytes.set(run.bytes, run.offset);
        }
        container.upper.set(entry.path, bytes);
      }
    },
    snapshot: () => {
      const merged = new Map<string, NodeEntry>();
      let ino = 1;
      const treePrefix = `${prefix}/${PREFIX_TREE}`;
      for (const [key, held] of durable.objects) {
        if (!key.startsWith(treePrefix)) continue;
        const path = key.slice(treePrefix.length);
        const mtimeNs = String(BigInt(held.meta.mtimeMs ?? '0') * 1_000_000n);
        const mode = Number(held.meta.mode ?? 0) & 0o7777;
        const metadata = { uid: 0, gid: 0, atimeNs: mtimeNs, mtimeNs, ctimeNs: mtimeNs, xattrs: {} };
        merged.set(path, held.meta.symlink === 'true'
          ? { path, kind: 'symlink', mode, ino: ino++, metadata, target: decoder.decode(held.bytes) }
          : { path, kind: 'file', mode, ino: ino++, metadata, content: { kind: 'dense', bytes: held.bytes } });
      }
      const base = ino;
      for (const entry of container.tree.snapshot()) merged.set(entry.path, { ...entry, ino: entry.ino + base });
      for (const path of container.whiteouts) merged.delete(path);
      return sortedByPath([...merged.values()]);
    },
    pwrite: (path, offset, bytes) => {
      if (!container.tree.has(path)) {
        const lower = durable.get(`${prefix}/${treeKey(path)}`);
        if (lower === null) throw new Error(`pwrite: no file at ${path}`);
        container.tree.writeFile(path, lower);
      }
      container.tree.pwrite(path, offset, bytes);
      const content = container.tree.node(path)?.content;
      if (content?.kind !== 'dense') throw new Error('overlay-cas pwrite produced non-dense content');
      container.upper.set(path, content.bytes);
      container.whiteouts.delete(path);
    },
  };

  return {
    name: 'overlay-cas',
    storage: () => storage,
    workspace,
    failures,
    durable,
    deaths,
    holdFinalize: () => finalizeGate.hold(),
    replaceContainer: () => {
      container.disk.dead = true;
      container = freshContainer();
      finalizeGate = new OneShotGate();
      storage = build();
    },
    stopContainer: () => { container.disk.stopped = true; },
    resetIsolate: () => { storage = build(); },
    secondBoot: () => { throw new ArmRefused('6.17', lateRaceRefusal); },
    disk: () => container.disk,
    // One per durable sub-step of a fold, named from the CAS key layout.
    commitSeams: ['after-blob', 'after-journal', 'after-tree', 'after-manifest', 'after-cursor'],
    publishSeam: 'after-cursor',
    attachSeams: ['attach:after-store-mount', 'attach:after-restore', 'attach:after-overlay'],
    dieAt: (seam) => deaths.arm(seam),
    faultAt: (point) => deaths.arm(awaitPointSeam(point)),
    awaitVisits: (point) => deaths.visits(awaitPointSeam(point)),
    payloadPrefixes: () => [`${prefix}/${PREFIX_BLOBS}`, `${prefix}/${PREFIX_TREE}`],
    controlPlane: async () => {
      const keys = [
        ...durable.list(`${prefix}/${KEY_CURSOR}`),
        ...durable.list(`${prefix}/${KEY_MANIFEST}`),
        ...durable.list(`${prefix}/${PREFIX_JOURNAL}`),
      ];
      const cursor = durable.get(`${prefix}/${KEY_CURSOR}`);
      return {
        objectKeys: keys,
        rows: row === null ? [] : ['overlay-cas-state'],
        head: cursor === null ? null : `cursor:${decoder.decode(cursor).trim()}`,
      };
    },
    declaredPayload: async () => {
      // The manifest declares a size and a content hash per path, and the
      // pending journal declares the same for a path not yet folded. Both name
      // blobs, which is what a refusal has to name.
      const cas = store();
      const declared: DeclaredObject[] = [];
      const pending = coalesce(await listJournalAfter(cas, await readFoldedSeq(cas)));
      for (const entry of pending) {
        if (entry.kind !== 'file') continue;
        for (const part of entry.parts) {
          if (part.kind !== 'data') continue;
          declared.push({
            key: `${prefix}/${blobKey(part.hash)}`,
            byteLength: part.size,
            names: [part.hash, entry.path],
          });
        }
      }
      return declared;
    },
    refusesCorruptPayload: true,
    committedHeads: async () => {
      const cursor = durable.get(`${prefix}/${KEY_CURSOR}`);
      return cursor === null ? [] : [`cursor:${decoder.decode(cursor).trim()}`];
    },
    work: () => rows,
    awaitPoints: NO_AWAIT_POINTS,
    refusedProperties: {
      owner: { reason: fidelityRefusal },
      times: { reason: fidelityRefusal },
      xattrs: { reason: fidelityRefusal },
      hardlink: { reason: fidelityRefusal },
      sparse: { reason: fidelityRefusal },
    },
    refusedCells: {
      ...HARNESS_OWNED_CELLS,
      '6.10': { reason: lateRaceRefusal },
      '6.11': { reason: fidelityRefusal },
      '6.14': { reason: largeSparseRefusal },
      '6.17': { reason: lateRaceRefusal },
    },
  };
}

function receipt(
  operation: OverlayCasOperation,
  counts: {
    entries?: number;
    movedBytes?: number;
    foldedEntries?: number;
    sweptBlobs?: number;
    foldedSeq?: number;
  },
) {
  return {
    operation,
    entries: counts.entries ?? 0,
    movedBytes: counts.movedBytes ?? 0,
    foldedEntries: counts.foldedEntries ?? 0,
    sweptBlobs: counts.sweptBlobs ?? 0,
    foldedSeq: counts.foldedSeq ?? 0,
  };
}

// ── the candidate arms ──────────────────────────────────────────────────────

/**
 * The payload store the RUNNER uses, over the mounted store subtree.
 *
 * Keys land under the payload prefix, which is what the container owns through
 * its mount — the exact placement the envelope defect got wrong for control
 * metadata.
 */
class MountedPayloadStore implements CandidatePayloadStore {
  constructor(
    private readonly durable: DurableStore,
    private readonly payloadPrefix: string,
    private readonly deaths: DeathWatch,
    private readonly rootKey: () => string | null,
  ) {}

  async issuePayloadGrant(intent: UploadIntent): Promise<PayloadGrant> {
    this.deaths.at(awaitPointSeam('issue-payload-grant'));
    return {
      operationId: intent.operationId,
      attemptId: intent.attemptId,
      expiresAt: intent.expiresAt,
      opaque: intent.exactKey,
    };
  }

  async uploadObject(grant: PayloadGrant, body: ReadableStream<Uint8Array>): Promise<ObjectReceipt> {
    const bytes = await drain(body);
    const sha256 = sha256Hex(bytes);
    this.durable.put(`${this.payloadPrefix}/${grant.opaque}`, bytes);
    this.deaths.at('after-payload');
    if (grant.opaque === this.rootKey()) this.deaths.at(awaitPointSeam('upload-root'));
    return {
      operationId: grant.operationId,
      attemptId: grant.attemptId,
      key: grant.opaque,
      byteLength: String(bytes.byteLength),
      sha256,
      etag: `mount-${sha256.slice(0, 16)}`,
      verified: true,
    };
  }

  async readRange(intent: RangeReadIntent): Promise<Uint8Array> {
    const bytes = this.durable.get(`${this.payloadPrefix}/${intent.exactKey}`);
    if (bytes === null) throw new Error(`missing candidate object: ${intent.exactKey}`);
    const offset = Number(intent.byteOffset);
    return bytes.slice(offset, offset + Number(intent.byteLength));
  }
}

function candidateArm(format: CandidateContainerFormat): ConformanceArm {
  const durable = new DurableStore();
  const deaths = new DeathWatch();
  const boxId = 'box-conformance';
  const paths = candidateStorePaths(`boxes/${boxId}`, format);
  const control = new MemoryControlStore();
  let casAttempts = 0;
  let bootSequence = 0;

  const awaitPoints: AwaitPointUse = {
    // Register order, not execution order: this is the same ordering rule as
    // AwaitPointDeclarationSchema in the contracts lane.
    uses: [
      'issue-payload-grant',
      'verify-upload',
      'upload-root',
      'publish-head',
      'complete-mark',
      'mount-root',
      'cleanup-resource',
    ],
  };

  /** The envelope store is under the control prefix, outside the payload mount. */
  const envelopes: CandidateEnvelopeStore = {
    write: async (envelope, rootEnvelopeId) => {
      const key = `${paths.envelopePrefix}/${rootEnvelopeId}.json`;
      const existing = durable.get(key);
      if (existing !== null) {
        parseEnvelopeBytes(existing, rootEnvelopeId);
        return;
      }
      durable.put(key, envelopeBytes(envelope));
      deaths.at('after-envelope');
      const committed = durable.get(key);
      if (committed === null) throw new Error(`candidate envelope write did not verify: ${rootEnvelopeId}`);
      parseEnvelopeBytes(committed, rootEnvelopeId);
    },
    read: async (rootEnvelopeId) => {
      const bytes = durable.get(`${paths.envelopePrefix}/${rootEnvelopeId}.json`);
      if (bytes === null) throw new Error(`candidate envelope is absent: ${rootEnvelopeId}`);
      return parseEnvelopeBytes(bytes, rootEnvelopeId);
    },
  };

  /** The shared head CAS and completion mark, with both the legacy commit seams
   *  and the contract's await points at their durable effects. */
  const controlStore: CandidateControlStore = {
    read: async () => await control.read(),
    update: async (apply) => {
      let phase: string | undefined;
      const result = await control.update((current) => {
        const update = apply(current);
        phase = update.next?.operation?.phase;
        return update;
      });
      if (phase !== undefined) deaths.reset(`after-${phase}`);
      if (phase === 'completion-pending') {
        casAttempts += 1;
        deaths.reset(awaitPointSeam('publish-head'));
      }
      if (phase === 'published') deaths.reset(awaitPointSeam('complete-mark'));
      return result;
    },
    clear: async () => await control.clear(),
  };

  /** The metadata check the production adapter makes from store facts alone. */
  const verifyObject = async (ref: ImmutableObjectRef): Promise<void> => {
    const key = `${paths.payloadPrefix}/${ref.key}`;
    const held = durable.head(key);
    if (held === null) throw new Error(`candidate object is absent: ${ref.key}`);
    if (
      String(held.size) !== ref.byteLength
      || held.digest !== ref.sha256
      || held.version.length === 0
    ) {
      throw new Error(`candidate object metadata does not match immutable ref: ${ref.key}`);
    }
    deaths.reset(awaitPointSeam('verify-upload'));
  };

  const fallbackMetadata: PosixMetadata = {
    uid: 0,
    gid: 0,
    atimeNs: '0',
    mtimeNs: '0',
    ctimeNs: '0',
    xattrs: {},
  };

  class CandidateBoot implements ArmBoot {
    disk = new ContainerDisk();
    tree = this.disk.tree(CANDIDATE_JOURNAL_ROOT);
    readonly workspace: Workspace;
    readonly failures: string[] = [];
    journal = false;
    storeMounted = false;
    bootId = `boot-${++bootSequence}`;
    /** The runner slots on this container's disk: control snapshots the box
     *  wrote and the replies the runner left, by path. */
    readonly files = new Map<string, string>();
    readonly processes = new Map<string, CandidateRunnerProcess>();
    readonly processActions = new Map<string, string>();
    readonly actionStarts = { restore: 0, checkpoint: 0, seed: 0 };
    daemonStarts = 0;
    /** The journal daemon's own WAL model: one line per admitted write, plus
     *  the lines a full disk made it cancel before their effect. */
    readonly wal: string[] = [];
    readonly cancelledWal: string[] = [];
    #storage: DevboxStorage;
    #rootUploadKey: string | null = null;
    #finalizeGate = new OneShotGate();
    #rows: WorkRows = { seal: NO_SEAL, publish: NO_PUBLISH, restore: NO_RESTORE };
    #restoreWindow: { from: number; mounts: number } | null = null;

    constructor() {
      this.workspace = {
        write: (path, text) => {
          if (!this.journal) throw new Error('the candidate workspace has no journal daemon');
          this.#journaled(`W ${path} ${encoder.encode(text).byteLength}`, () => this.tree.writeFile(path, encoder.encode(text)));
        },
        read: (path) => {
          const entry = this.tree.node(path);
          if (entry?.kind !== 'file' || entry.content?.kind !== 'dense') return undefined;
          return decoder.decode(entry.content.bytes);
        },
        remove: (path) => this.tree.remove(path),
        paths: () => this.tree.filePaths(),
        plant: (entries) => this.tree.plant(entries),
        snapshot: () => this.tree.snapshot(),
        pwrite: (path, offset, bytes) => this.#journaled(`W ${path} ${offset}+${bytes.byteLength}`, () => this.tree.pwrite(path, offset, bytes)),
      };
      this.#storage = this.#build();
    }
    /** INTENT BEFORE EFFECT, the journal daemon's own rule. The record lands
     *  first; an effect the disk refuses moves its record to the cancelled
     *  list and rethrows, so there is never an effect without a record. */
    #journaled(line: string, effect: () => void): void {
      this.wal.push(line);
      try {
        effect();
      } catch (error) {
        this.wal.pop();
        this.cancelledWal.push(line);
        throw error;
      }
    }

    /** Journal and eviction facts, exposed to the ENOSPC and reset cells. */
    journalFacts(): JournalFacts {
      return { records: this.wal, failedWrites: this.cancelledWal };
    }

    evictCleanBytes(): number {
      // Today's candidate keeps every clean byte resident: nothing evicts, and
      // a full disk stays full. That fact is what cell 6.18 records as red.
      return 0;
    }

    storage(): DevboxStorage {
      return this.#storage;
    }

    holdFinalize(): HeldFinalize {
      return this.#finalizeGate.hold();
    }

    resetIsolate(): void {
      this.#storage = this.#build();
    }

    replaceContainer(): void {
      this.disk.dead = true;
      this.disk = new ContainerDisk();
      this.tree = this.disk.tree(CANDIDATE_JOURNAL_ROOT);
      this.journal = false;
      this.storeMounted = false;
      this.bootId = `boot-${++bootSequence}`;
      this.files.clear();
      this.processes.clear();
      this.processActions.clear();
      this.#restoreWindow = null;
      this.#finalizeGate = new OneShotGate();
      this.#storage = this.#build();
    }

    stop(): void {
      this.disk.stopped = true;
    }

    work(): WorkRows {
      return this.#rows;
    }

    lifecycleCounts(): LifecycleCounts {
      return { daemonStarts: this.daemonStarts, restoreStarts: this.actionStarts.restore };
    }

    #payload(): MountedPayloadStore {
      return new MountedPayloadStore(durable, paths.payloadPrefix, deaths, () => this.#rootUploadKey);
    }

    #capture(input: { operationId: string; epoch: string; baseRevision: string }): AuditedCapture {
      const entries = this.tree.snapshot();
      const cut = Number(input.baseRevision) + 1;
      const captured: Capture = {
        mechanism: 'mutation-journal',
        cut,
        generation: Number(input.epoch),
        entries,
      };
      return issueVerifiedJournalCapture({
        cut,
        generation: Number(input.epoch),
        entries,
        identity: {
          captureId: input.operationId,
          epoch: input.epoch,
          baseRevision: input.baseRevision,
          stableStageHandle: `stage-${input.operationId}`,
        },
        manifestSha256: manifestSha256(captured),
      });
    }

    #identityOf(run: CandidateRunControlV1) {
      const operation = run.operation;
      if (operation?.phase !== 'transferring') {
        throw new Error('candidate checkpoint requires a transferring operation');
      }
      return {
        operationId: operation.operationId,
        attemptId: operation.attemptId,
        boxId,
        epoch: operation.epoch,
        bootId: operation.bootId,
        kind: operation.kind,
        expiresAt: '99999999999999',
        baseRevision: operation.baseRevision,
      };
    }

    async #recoverParent(
      head: NonNullable<CandidateRunControlV1['head']>,
      store: MountedPayloadStore,
      identity: { operationId: string; attemptId: string; boxId: string; epoch: string; expiresAt: string },
    ) {
      const rootBytes = await store.readRange({
        ...identity,
        exactKey: head.envelope.rootObject.key,
        method: 'GET',
        byteOffset: '0',
        byteLength: head.envelope.rootObject.byteLength,
        sha256: head.envelope.rootObject.sha256,
      });
      return recoverPublishedParent({
        head: head.pointer,
        currentHead: head.pointer,
        envelope: head.envelope,
        envelopeBytes: envelopeBytes(head.envelope),
        rootBytes,
        expected: {
          format: head.envelope.format,
          capturedCut: head.envelope.cut,
          lastOperationId: head.pointer.lastOperationId,
        },
      });
    }

    async #runCheckpoint(run: CandidateRunControlV1): Promise<string> {
      const identity = this.#identityOf(run);
      const store = this.#payload();
      const sink = new MemoryCandidateObjectSink();
      const head = run.head;
      const audited = this.#capture(identity);
      let plan;
      if (format === 'bounded-layers') {
        const parent = head === null
          ? undefined
          : (await openBoundedLayers(head.envelope.rootObject, store, identity))
            .withPublishedParent(await this.#recoverParent(head, store, identity));
        const built = await buildBoundedLayers(audited, parent, sink);
        plan = built.plan;
        this.#rows = { ...this.#rows, seal: wholeTreeSeal(audited.entries, 512 * 1024) };
      } else {
        let parent = null;
        if (head !== null) {
          const manifestBytes = await store.readRange({
            ...identity,
            exactKey: head.envelope.rootObject.key,
            method: 'GET',
            byteOffset: '0',
            byteLength: head.envelope.rootObject.byteLength,
            sha256: head.envelope.rootObject.sha256,
          });
          parent = parentFromPublishedParent(
            await openMerklePack({ rootId: sha256Hex(manifestBytes), manifestBytes }, store, identity),
            await this.#recoverParent(head, store, identity),
          );
        }
        const built = await buildMerklePack(audited, { sink, parent });
        plan = built.plan;
        const staged = wholeTreeSeal(audited.entries, 4096);
        this.#rows = {
          ...this.#rows,
          seal: {
            ...staged,
            chunksHashed: built.stats.distinctChunks,
            nodesRewritten: built.stats.nodes,
          },
        };
      }
      this.#rootUploadKey = plan.root.ref.key;
      const draft = await stageCandidatePayload(plan, identity, store);
      return JSON.stringify({
        ok: true,
        movedBytes: [...draft.dependencyReceipts, draft.rootReceipt, draft.closureReceipt]
          .reduce((bytes, receipt) => bytes + Number(receipt.byteLength), 0),
        heldBytes: draft.closure.reduce((bytes, ref) => bytes + Number(ref.byteLength), 0),
        draft,
      });
    }

    async #boundedEntries(run: CandidateRunControlV1): Promise<NodeEntry[]> {
      const head = run.head!;
      const identity = {
        operationId: `restore-${head.pointer.lastOperationId}`,
        attemptId: '1',
        boxId,
        epoch: head.envelope.epoch,
        expiresAt: '99999999999999',
      };
      const view = await openBoundedLayers(head.envelope.rootObject, this.#payload(), identity);
      const entries: NodeEntry[] = [];
      const contentByIno = new Map<number, FileContent>();
      for (const path of [...view.entryPaths()].sort()) {
        const stat = view.stat(path);
        if (stat === null) continue;
        const metadata = stat.metadata ?? fallbackMetadata;
        if (stat.kind === 'dir') {
          entries.push({ path, kind: 'dir', mode: stat.mode, ino: stat.ino, metadata });
          continue;
        }
        if (stat.kind === 'symlink') {
          entries.push({ path, kind: 'symlink', mode: stat.mode, ino: stat.ino, metadata, target: stat.target });
          continue;
        }
        let content = contentByIno.get(stat.ino);
        if (content === undefined) {
          const doc = view.entryAt(path);
          if (doc?.kind !== 'file') throw new Error(`bounded layer has no file row for ${path}`);
          const hasHole = doc.chunks.some(isHoleExtent);
          if (!hasHole) {
            content = { kind: 'dense', bytes: await view.readRange(path, 0, doc.size) };
          } else {
            let offset = 0;
            const runs: Array<{ offset: number; bytes: Uint8Array }> = [];
            for (const part of doc.chunks) {
              if (!isHoleExtent(part)) runs.push({ offset, bytes: await view.readRange(path, offset, part.size) });
              offset += part.size;
            }
            content = { kind: 'sparse', size: doc.size, runs };
          }
          contentByIno.set(stat.ino, content);
        }
        entries.push({ path, kind: 'file', mode: stat.mode, ino: stat.ino, metadata, content });
      }
      return entries;
    }

    async #merkleEntries(run: CandidateRunControlV1): Promise<NodeEntry[]> {
      const head = run.head!;
      const identity = {
        operationId: `restore-${head.pointer.lastOperationId}`,
        attemptId: '1',
        boxId,
        epoch: head.envelope.epoch,
        expiresAt: '99999999999999',
      };
      const store = this.#payload();
      const manifestBytes = await store.readRange({
        ...identity,
        exactKey: head.envelope.rootObject.key,
        method: 'GET',
        byteOffset: '0',
        byteLength: head.envelope.rootObject.byteLength,
        sha256: head.envelope.rootObject.sha256,
      });
      const view = await openMerklePack(
        { rootId: sha256Hex(manifestBytes), manifestBytes },
        store,
        identity,
      );
      const entries: NodeEntry[] = [];
      const contentByIno = new Map<number, FileContent>();
      const walk = async (at: string): Promise<void> => {
        for (const child of await view.readdir(at)) {
          const path = at === '' ? child : `${at}/${child}`;
          const stat = await view.stat(path);
          if (stat === null) continue;
          const ino = stat.ino ?? entries.length + 1;
          const metadata = stat.metadata ?? fallbackMetadata;
          if (stat.kind === 'dir') {
            entries.push({ path, kind: 'dir', mode: stat.mode, ino, metadata });
            await walk(path);
            continue;
          }
          if (stat.kind === 'symlink') {
            entries.push({ path, kind: 'symlink', mode: stat.mode, ino, metadata, target: stat.target });
            continue;
          }
          let content = contentByIno.get(ino);
          if (content === undefined) {
            const extents = await view.extents(path);
            const hasHole = extents.some((extent) => extent.kind === 'hole');
            if (!hasHole) {
              content = { kind: 'dense', bytes: await view.readRange(path, 0, stat.size) };
            } else {
              const runs: Array<{ offset: number; bytes: Uint8Array }> = [];
              for (const extent of extents) {
                if (extent.kind === 'data') {
                  runs.push({ offset: extent.offset, bytes: await view.readRange(path, extent.offset, extent.length) });
                }
              }
              content = { kind: 'sparse', size: stat.size, runs };
            }
            contentByIno.set(ino, content);
          }
          entries.push({ path, kind: 'file', mode: stat.mode, ino, metadata, content });
        }
      };
      await walk('');
      return entries;
    }

    async #runRestore(run: CandidateRunControlV1): Promise<string> {
      const head = run.head;
      if (head === null) return JSON.stringify({ ok: true, rootId: null });
      const entries = format === 'bounded-layers'
        ? await this.#boundedEntries(run)
        : await this.#merkleEntries(run);
      this.tree.clear();
      this.tree.plant(entries);
      return JSON.stringify({ ok: true, rootId: head.pointer.rootEnvelopeId });
    }

    #meter(raw: DevboxStorage): DevboxStorage {
      return withOptionalMembers(raw, {
        attach: async () => {
          if (this.#restoreWindow === null) {
            this.#restoreWindow = { from: durable.ops.length, mounts: this.disk.mountCalls };
          }
          const outcome = await raw.attach();
          const opened = this.#restoreWindow;
          this.#restoreWindow = null;
          this.#rows = {
            ...this.#rows,
            restore: restoreWorkSince(durable, { from: opened.from }, [`${paths.payloadPrefix}/`], {
              mounts: this.disk.mountCalls - opened.mounts,
              cpuSteps: this.tree.size,
              replayUnits: 0,
            }),
          };
          return outcome;
        },
        checkpoint: async (kind) => {
          const window = { from: durable.ops.length };
          const casBefore = casAttempts;
          const outcome = await raw.checkpoint(kind);
          this.#rows = {
            ...this.#rows,
            publish: publishWorkSince(durable, window, casAttempts - casBefore),
          };
          return outcome;
        },
        discard: async () => await raw.discard(),
      });
    }

    #build(): DevboxStorage {
      const ports: CandidateContainerPorts = {
        format,
        runnerPath: '/opt/kinu/candidate-runner.bundle.mjs',
        mountStore: async () => {
          if (this.disk.dead) throw new ContainerDied('mountStore on a dead container');
          if (this.disk.stopped) throw new ContainerStopped('mountStore');
          this.disk.mount(CANDIDATE_STORE_MOUNT, {
            source: `s3fs:${paths.payloadPrefix}`,
            fstype: 'fuse.s3fs',
            options: 'rw',
          });
          this.storeMounted = true;
          deaths.at(awaitPointSeam('mount-root'));
        },
        unmountStore: async () => {
          if (this.disk.dead || this.disk.stopped) return;
          this.disk.unmount(CANDIDATE_STORE_MOUNT);
          this.storeMounted = false;
          deaths.at(awaitPointSeam('cleanup-resource'));
        },
        clearStore: async () => {
          durable.deletePrefix(`${paths.payloadPrefix}/`);
          durable.deletePrefix(`${paths.envelopePrefix}/`);
        },
        attachmentHealth: async () => ({
          storeMounted: this.storeMounted,
          storeAccessible: this.storeMounted,
          journalProcess: this.journal,
          journalSocket: this.journal,
          journalMounted: this.journal,
        }),
        begin: async (kind) => await beginCandidateOperation({
          kind: kind === 'tick' ? 'tick' : 'barrier',
          bootId: this.bootId,
          store: controlStore,
          envelopes,
          verifyObject,
        }),
        finalize: async (draft) => {
          await this.#finalizeGate.cross();
          return await finalizeCandidateOperation({
            draft,
            boxId,
            store: controlStore,
            envelopes,
            verifyObject,
          });
        },
        restoreState: async () => await candidateRunControl(controlStore, envelopes, verifyObject),
        settleNoChange: async (run) => {
          const active = run.operation;
          if (active?.phase !== 'transferring') {
            throw new Error('candidate no-change reply has no transferring operation to settle');
          }
          return await settleCandidateNoChange({ active, store: controlStore });
        },
        bootId: async () => this.bootId,
        redrive: async (run) => {
          const active = run.operation;
          if (active?.phase !== 'transferring') {
            throw new Error('candidate runner failure has no transferring operation to redrive');
          }
          return await redriveCandidateOperation({ active, store: controlStore, envelopes });
        },
        clearControl: async () => await controlStore.clear(),
        clearRunnerAttempt: async (resultPath) => {
          this.files.delete(resultPath);
          for (const [id, process] of this.processes) {
            if (process.id.includes('checkpoint')) {
              this.processes.delete(id);
              this.processActions.delete(id);
            }
          }
          deaths.at(awaitPointSeam('cleanup-resource'));
        },
        clearRunnerResults: async () => { this.files.clear(); },
        startJournal: async () => {
          if (this.disk.dead) throw new ContainerDied('startJournal on a dead container');
          if (this.disk.stopped) throw new ContainerStopped('startJournal');
          this.journal = true;
          this.daemonStarts += 1;
        },
        stopJournal: async () => {
          if (this.disk.dead) throw new ContainerDied('stopJournal on a dead container');
          if (this.disk.stopped) throw new ContainerStopped('stopJournal');
          this.journal = false;
        },
        getRunnerProcess: async (processId) => this.processes.get(processId) ?? null,
        waitForRunnerExit: async (processId) => {
          if (this.processActions.get(processId) === 'restore') deaths.reset('attach:after-restore-process');
          return { exitCode: 0 };
        },
        activeCheckpoint: async () => null,
        writeRunnerControl: async (path, content) => {
          if (this.disk.dead) throw new ContainerDied('writeRunnerControl on a dead container');
          if (this.disk.stopped) throw new ContainerStopped('writeRunnerControl');
          this.files.set(path, content);
        },
        startRunnerProcess: async (command, processId) => {
          if (this.disk.dead) throw new ContainerDied('startRunnerProcess on a dead container');
          if (this.disk.stopped) throw new ContainerStopped('startRunnerProcess');
          if (command.length >= MAX_ARG_STRLEN) {
            throw new Error(`E2BIG: argument list too long (${command.length} bytes)`);
          }
          const argv = tokenize(command);
          const action = valueOf(argv, '--action');
          const resultPath = valueOf(argv, '--result');
          const controlPath = valueOf(argv, '--control');
          const control = this.files.get(controlPath);
          if (control === undefined) throw new Error(`no candidate runner control at ${controlPath}`);
          const run: CandidateRunControlV1 = JSON.parse(control);
          if (action === 'restore') this.actionStarts.restore += 1;
          else if (action === 'checkpoint') this.actionStarts.checkpoint += 1;
          else this.actionStarts.seed += 1;
          this.processActions.set(processId, action);
          let printed = '';
          const process: CandidateRunnerProcess = {
            id: processId,
            getLogs: async () => ({ stdout: printed, stderr: '' }),
          };
          this.processes.set(processId, process);
          printed = action === 'checkpoint'
            ? await this.#runCheckpoint(run)
            : action === 'restore'
              ? await this.#runRestore(run)
              : JSON.stringify({ ok: true });
          this.files.set(resultPath, printed);
          return process;
        },
        readRunnerResult: async (path) => {
          const held = this.files.get(path);
          if (held === undefined) throw new Error(`no candidate runner result at ${path}`);
          return held;
        },
        boxId: () => boxId,
        recordFailure: async (reason) => { this.failures.push(reason); },
      };
      return this.#meter(candidateContainerStorage(ports));
    }
  }

  let current = new CandidateBoot();
  return {
    name: format,
    storage: () => current.storage(),
    get workspace() { return current.workspace; },
    get failures() { return current.failures; },
    durable,
    deaths,
    holdFinalize: () => current.holdFinalize(),
    replaceContainer: () => current.replaceContainer(),
    stopContainer: () => current.stop(),
    resetIsolate: () => current.resetIsolate(),
    secondBoot: () => new CandidateBoot(),
    disk: () => current.disk,
    commitSeams: [
      'after-transferring',
      'after-payload',
      'after-envelope',
      'after-sealed',
      'after-completion-pending',
      'after-published',
    ],
    publishSeam: 'after-published',
    attachSeams: ['attach:after-restore-process'],
    dieAt: (seam) => deaths.arm(seam),
    faultAt: (point) => deaths.arm(awaitPointSeam(point)),
    awaitVisits: (point) => deaths.visits(awaitPointSeam(point)),
    payloadPrefixes: () => [`${paths.payloadPrefix}/`, `${paths.mountPrefix.slice(1)}/`],
    controlPlane: async () => {
      const record: CandidateControlStateV1 = await control.read();
      return {
        objectKeys: durable.list(`${paths.envelopePrefix}/`),
        rows: ['candidate-control'],
        head: record.head?.rootEnvelopeId ?? null,
      };
    },
    declaredPayload: async () => {
      const record: CandidateControlStateV1 = await control.read();
      if (record.head === null) return [];
      const envelope = await envelopes.read(record.head.rootEnvelopeId);
      return envelope.closure.map((ref): DeclaredObject => ({
        key: `${paths.payloadPrefix}/${ref.key}`,
        byteLength: Number(ref.byteLength),
        names: [ref.key, ref.sha256],
      }));
    },
    refusesCorruptPayload: true,
    committedHeads: async () => {
      const record: CandidateControlStateV1 = await control.read();
      return record.head === null ? [] : [record.head.rootEnvelopeId];
    },
    work: () => current.work(),
    awaitPoints,
    lifecycleCounts: () => current.lifecycleCounts(),
    journalFacts: () => current.journalFacts(),
    evictCleanBytes: () => current.evictCleanBytes(),
    refusedProperties: {},
    refusedCells: HARNESS_OWNED_CELLS,
  };
}
/**
 * Linux caps ONE argv string at 128 KiB (`MAX_ARG_STRLEN`), and the SDK hands
 * a command to the container's shell as one string. Measured 2026-09-02 on
 * this box: `posix_spawn` accepts a 131,071-byte argument and refuses
 * 131,072 with E2BIG. The control snapshot of a 700-file bounded-layers head
 * is 161,936 bytes as base64, which is why it travels as a file.
 */
const MAX_ARG_STRLEN = 131_072;

function tokenize(command: string): readonly string[] {
  return [...command.matchAll(/'((?:[^']|'\\'')*)'/g)].map(
    match => match[1]!.replaceAll("'\\''", "'"),
  );
}

function valueOf(argv: readonly string[], flag: string): string {
  const at = argv.indexOf(flag);
  if (at === -1 || argv[at + 1] === undefined) {
    throw new Error(`the candidate runner command carries no ${flag}`);
  }
  return argv[at + 1]!;
}

// ── shared plumbing ────────────────────────────────────────────────────────

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done === true || value === undefined) break;
    parts.push(value);
    size += value.byteLength;
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.byteLength;
  }
  return bytes;
}

/**
 * Every strategy, as one contract.
 *
 * KEYED BY `DevboxStrategyName` ON PURPOSE: a sixth strategy added to that
 * union makes this record incomplete, and an incomplete record does not
 * compile. A strategy nobody conforms is therefore not a strategy anybody can
 * add — which is the only version of this list that stays true.
 */
export const CONFORMANCE_ARMS = {
  'snapshot-chain': snapshotChainArm,
  r2fs: r2fsArm,
  'overlay-cas': overlayCasArm,
  'bounded-layers': () => candidateArm('bounded-layers'),
  'merkle-pack': () => candidateArm('merkle-pack'),
} satisfies Record<DevboxStrategyName, () => ConformanceArm>;
