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
  open as openBoundedLayers,
} from '../../src/candidates/bounded-layers';
import {
  candidateStorePaths,
  candidateContainerStorage,
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
  issueVerifiedJournalCapture,
  manifestSha256,
  type AuditedCapture,
  type Capture,
  type NodeEntry,
} from '../../src/capture/model';
import type {
  CandidateControlStateV1,
  CandidateRunControlV1,
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
  CHAIN_STORE_MOUNT,
  baseObjectKey,
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

export class DurableStore {
  readonly objects = new Map<string, StoredObject>();
  /** Every mutation, in order. A crash-ordering assertion needs the order, not
   *  the end state. */
  readonly writes: string[] = [];
  #uploads = 0;

  put(key: string, bytes: Uint8Array): string {
    this.#uploads += 1;
    const version = `v${this.#uploads}`;
    this.objects.set(key, { bytes: bytes.slice(), version });
    this.writes.push(`put:${key}`);
    return version;
  }

  get(key: string): Uint8Array | null {
    return this.objects.get(key)?.bytes ?? null;
  }

  head(key: string): { size: number; digest: string; version: string } | null {
    const held = this.objects.get(key);
    if (held === undefined) return null;
    return {
      size: held.bytes.byteLength,
      digest: sha256Hex(held.bytes),
      version: held.version,
    };
  }

  delete(key: string): void {
    if (this.objects.delete(key)) this.writes.push(`delete:${key}`);
  }

  list(prefix: string): string[] {
    return [...this.objects.keys()].filter(key => key.startsWith(prefix)).sort();
  }

  deletePrefix(prefix: string): number {
    const keys = this.list(prefix);
    for (const key of keys) this.delete(key);
    return keys.length;
  }

  inventory(prefix: string): StoreInventory {
    let objects = 0;
    let bytes = 0;
    for (const key of this.list(prefix)) {
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
      this.objects.set(key, { bytes, version: held.version });
      return;
    }
    this.objects.set(key, {
      bytes: bytes.subarray(0, Math.max(1, bytes.byteLength - 17)),
      version: held.version,
    });
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
 */
const ArchiveSchema = v.strictObject({
  archive: v.literal(1),
  rows: v.array(v.strictObject({ path: v.string(), body: v.string() })),
});

/**
 * One container's disk, and the mounts on it.
 *
 * Paths are absolute and files are bytes; a directory exists when something
 * says it does. `dead` is what a replacement leaves behind: the strategy's
 * in-flight operation keeps holding this object, and every call on it fails the
 * way a call against a container that no longer exists fails.
 */
export class ContainerDisk {
  readonly files = new Map<string, Uint8Array>();
  readonly dirs = new Set<string>([DEVBOX_WORKDIR, DEVBOX_RUNTIME_DIR]);
  readonly mounts = new Map<string, MountRow>();
  readonly overlays = new Map<string, OverlayRow>();
  dead = false;
  stopped = false;

  #alive(what: string): void {
    if (this.dead) throw new ContainerDied(`a dead container was asked to ${what}`);
    if (this.stopped) throw new ContainerStopped(what);
  }

  mkdirp(path: string): void {
    this.#alive(`mkdir ${path}`);
    for (const step of ancestors(path)) this.dirs.add(step);
  }

  rmrf(path: string): void {
    this.#alive(`rm -rf ${path}`);
    for (const key of this.files.keys()) {
      if (key === path || key.startsWith(`${path}/`)) this.files.delete(key);
    }
    for (const key of this.dirs) {
      if (key === path || key.startsWith(`${path}/`)) this.dirs.delete(key);
    }
  }

  exists(path: string): boolean {
    this.#alive(`stat ${path}`);
    if (this.dirs.has(path) || this.files.has(path)) return true;
    return this.#overlayOwner(path) !== undefined;
  }

  writeFile(path: string, bytes: Uint8Array): void {
    this.#alive(`write ${path}`);
    const target = this.#redirect(path);
    this.mkdirp(parentOf(target));
    this.files.set(target, bytes.slice());
  }

  readFile(path: string): Uint8Array | undefined {
    this.#alive(`read ${path}`);
    const direct = this.files.get(path);
    if (direct !== undefined) return direct;
    const resolved = this.#resolveThroughOverlay(path);
    return resolved === undefined ? undefined : this.files.get(resolved);
  }

  removeFile(path: string): void {
    this.#alive(`unlink ${path}`);
    this.files.delete(this.#redirect(path));
  }

  /** Every file under `dir`, as paths relative to it, through any overlay. */
  entries(dir: string): string[] {
    this.#alive(`list ${dir}`);
    const overlay = this.overlays.get(dir);
    const found = new Set<string>();
    if (overlay !== undefined) {
      for (const layer of [overlay.upper, ...overlay.lowers]) {
        for (const key of this.files.keys()) {
          if (key.startsWith(`${layer}/`)) found.add(key.slice(layer.length + 1));
        }
      }
    }
    for (const key of this.files.keys()) {
      if (key.startsWith(`${dir}/`)) found.add(key.slice(dir.length + 1));
    }
    return [...found].sort();
  }

  copyTree(from: string, to: string): void {
    this.#alive(`cp -a ${from} ${to}`);
    this.mkdirp(to);
    for (const relative of this.entries(from)) {
      const bytes = this.readFile(`${from}/${relative}`);
      if (bytes === undefined) continue;
      this.writeFile(`${to}/${relative}`, bytes);
    }
  }

  /**
   * Serialize a directory into one archive object.
   *
   * The stand-in for mksquashfs, and deliberately a format that FAILS TO PARSE
   * when a byte of it is lost: a truncated squashfs does not mount either, and
   * a fake whose archive tolerated damage would let a corrupt layer be served.
   */
  pack(dir: string): Uint8Array {
    const rows = this.entries(dir).map(relative => ({
      path: relative,
      body: bytesToBase64(this.readFile(`${dir}/${relative}`) ?? new Uint8Array(0)),
    }));
    return new TextEncoder().encode(JSON.stringify({ archive: 1, rows }));
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
    this.mkdirp(dir);
    for (const row of archive.rows) {
      this.writeFile(`${dir}/${row.path}`, base64ToBytes(row.body));
    }
  }

  procMounts(): string {
    this.#alive('read /proc/mounts');
    return [...this.mounts].map(
      ([point, row]) => `${row.source} ${point} ${row.fstype} ${row.options} 0 0`,
    ).join('\n');
  }

  mount(point: string, row: MountRow): void {
    this.#alive(`mount ${point}`);
    this.mkdirp(point);
    this.mounts.set(point, row);
  }

  unmount(point: string): void {
    this.#alive(`unmount ${point}`);
    this.mounts.delete(point);
    this.overlays.delete(point);
  }

  mountOverlay(point: string, overlay: OverlayRow): void {
    this.mount(point, {
      source: 'fuse-overlayfs',
      fstype: 'fuse.fuse-overlayfs',
      options: 'rw,nosuid',
    });
    this.overlays.set(point, overlay);
  }

  /** Where a write to `path` really lands: an overlay write goes to its upper. */
  #redirect(path: string): string {
    const owner = this.#overlayOwner(path);
    if (owner === undefined) return path;
    return `${owner.overlay.upper}/${owner.relative}`;
  }

  #resolveThroughOverlay(path: string): string | undefined {
    const owner = this.#overlayOwner(path);
    if (owner === undefined) return undefined;
    for (const layer of [owner.overlay.upper, ...owner.overlay.lowers]) {
      const candidate = `${layer}/${owner.relative}`;
      if (this.files.has(candidate)) return candidate;
    }
    return undefined;
  }

  #overlayOwner(path: string): { overlay: OverlayRow; relative: string } | undefined {
    for (const [point, overlay] of this.overlays) {
      if (path.startsWith(`${point}/`)) {
        return { overlay, relative: path.slice(point.length + 1) };
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
  paths(): readonly string[];
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

/**
 * One strategy, driven through exactly the operations the contract names.
 *
 * Everything a case needs is here and nothing is strategy-specific: a case that
 * reads a key, a prefix or a mount path takes it from the arm, which takes it
 * from the strategy's OWN layout API. That is the whole point — the envelope
 * defect was a placement bug, and a test carrying its own copy of the layout
 * cannot see one.
 */
export interface ConformanceArm {
  readonly name: DevboxStrategyName;
  /** The strategy under test. Replaced with the container, like the real
   *  restoration owner: an isolate rarely survives a replacement. */
  storage(): DevboxStorage;
  readonly workspace: Workspace;
  readonly durable: DurableStore;
  readonly deaths: DeathWatch;
  /** A blank disk, the same durable store, and the same durable rows. */
  replaceContainer(): void;
  /** The container stops where it stands: no teardown, no replacement. */
  stopContainer(): void;
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
  dieAt(seam: string): void;
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
}

// ── snapshot-chain ──────────────────────────────────────────────────────────

/**
 * The archiver, the overlay and the layer mounts, as commands.
 *
 * The strategy owns its shell, so this is where the battery meets it: each arm
 * recognises exactly one command the strategy really issues and does what the
 * container would do WITH REAL BYTES — mksquashfs writes an archive of the
 * directory it was pointed at, squashfuse unpacks one, and `cp -a` copies a
 * tree. That is what makes "the exact bytes came back" an assertion about the
 * chain rather than about a stub.
 */
function chainExec(disk: ContainerDisk, deaths: DeathWatch) {
  const unquote = (value: string): string => value.replace(/^'|'$/g, '');
  return async (command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
    const fail = (stderr: string) => ({ stdout: '', stderr, exitCode: 1 });
    const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });
    if (command === 'cat /proc/mounts') return ok(disk.procMounts());

    const exists = /^test -e '(?<path>[^']+)'/.exec(command)?.groups?.path;
    if (exists !== undefined) return ok(disk.exists(exists) ? 'yes' : 'no');

    if (command.startsWith('/usr/bin/fusermount3 -u')) {
      const point = unquote(/-u '(?<path>[^']+)'/.exec(command)?.groups?.path ?? '');
      disk.unmount(point);
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
      return ok();
    }

    const overlay = /fuse-overlayfs -o lowerdir=(?<lowers>.+?),upperdir=(?<upper>[^,]+),workdir=[^ ]+ (?<dir>'[^']+')$/
      .exec(command)?.groups;
    if (overlay !== undefined) {
      disk.mountOverlay(unquote(overlay.dir!), {
        lowers: overlay.lowers!.split(':').map(unquote),
        upper: unquote(overlay.upper!),
      });
      return ok();
    }

    const seed = /^cp -a '(?<lower>[^']+)\/\.' '(?<upper>[^']+)\//.exec(command)?.groups;
    if (seed !== undefined) {
      disk.copyTree(seed.lower!, seed.upper!);
      return ok();
    }

    const squash = /mksquashfs '(?<source>[^']+)' '(?<archive>[^']+)'/.exec(command)?.groups;
    if (squash !== undefined) {
      const archive = disk.pack(squash.source!);
      disk.writeFile(squash.archive!, archive);
      // `<exit> <bytes>`, the one command that builds and measures.
      return ok(`0 ${archive.byteLength}`);
    }

    if (command.includes('df -Pk')) {
      // `<need> <free>`: room for anything, so the staging gate is never the
      // reason a case fails.
      return ok(`1 ${Number.MAX_SAFE_INTEGER}`);
    }

    if (command.includes('sha256sum') && command.includes('sort -z')) {
      const upper = `${DEVBOX_RUNTIME_DIR}/upper`;
      const rows = disk.entries(upper).map(
        relative => `${relative}:${sha256Hex(disk.readFile(`${upper}/${relative}`) ?? new Uint8Array(0))}`,
      );
      return ok(rows.length === 0 ? sha256Hex(encoder.encode('empty')) : sha256Hex(encoder.encode(rows.join('\n'))));
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
  /** The Durable Object's own row. It survives every container replacement,
   *  which is exactly why the chain's control plane is not in the store. */
  let row: ChainState | null = null;
  let disk = new ContainerDisk();
  /** The seed stamp lives beside the upper on the container's own disk, so a
   *  replacement takes it with the upper it describes. */
  let seedStamp: string | undefined;
  let storage = build();

  function build(): DevboxStorage {
    const exec = chainExec(disk, deaths);
    const ports: SnapshotChainPorts = {
      containerRunning: () => !disk.dead && !disk.stopped,
      allowExtraction: () => false,
      archiveExcludes: () => [],
      readState: async () => row,
      writeState: async (next) => {
        // THE POINTER IS THE COMMIT. A death before this leaves a complete
        // archive nothing names; a death after leaves a committed record whose
        // cleanup never ran.
        deaths.at('before-pointer');
        row = next;
        deaths.at('after-pointer');
      },
      clearState: async () => {
        row = null;
      },
      checkpointIntervalMs: () => 0,
      checkChanges: async () => ({ status: 'changed', version: `v${durable.writes.length}` }),
      readSeedStamp: async () => disk.dead ? undefined : seedStamp,
      writeSeedStamp: async (stamp) => {
        seedStamp = stamp;
      },
      exec,
      mountStore: async (chainId) => {
        if (disk.dead) throw new ContainerDied('mountStore on a dead container');
        // The SDK mounts the chain's own subtree read-only. Every object under
        // it appears as a file named by the last segment of its key.
        disk.mount(CHAIN_STORE_MOUNT, {
          source: `r2:backups/${chainId}`,
          fstype: 'fuse.s3fs',
          options: 'ro',
        });
        for (const key of durable.list(`backups/${chainId}/`)) {
          disk.writeFile(`${CHAIN_STORE_MOUNT}/${key.split('/').pop()!}`, durable.get(key)!);
        }
      },
      unmountStore: async () => {
        if (disk.dead || disk.stopped) return;
        for (const path of disk.entries(CHAIN_STORE_MOUNT)) {
          disk.removeFile(`${CHAIN_STORE_MOUNT}/${path}`);
        }
        disk.unmount(CHAIN_STORE_MOUNT);
      },
      readFileStream: async (path) => {
        const bytes = disk.readFile(path);
        if (bytes === undefined) throw new Error(`${path} is absent`);
        return {
          stream: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
          size: bytes.byteLength,
        };
      },
      putObject: async (key, stream, size) => {
        deaths.at('before-payload');
        const bytes = await drain(stream);
        if (bytes.byteLength !== size) throw new Error(`staged ${size}, landed ${bytes.byteLength}`);
        const version = durable.put(key, bytes);
        deaths.at('after-payload');
        return { bytes: bytes.byteLength, digest: sha256Hex(bytes), objectVersion: version };
      },
      objectFacts: async (key) => {
        const held = durable.head(key);
        if (held === null) return undefined;
        return { bytes: held.size, digest: held.digest, objectVersion: held.version };
      },
      deleteObjects: async (keys) => {
        deaths.at('before-cleanup');
        for (const key of keys) durable.delete(key);
      },
      countEntries: async (dir) => disk.entries(dir).length,
      restoreExtract: async () => ({ success: false }),
      createExtractSnapshot: async () => {
        throw new Error('the conformance battery runs the chain, never extraction');
      },
      now: () => Date.now(),
      log: () => undefined,
    };
    return snapshotChainStorage(ports);
  }

  const workspace: Workspace = {
    write: (path, text) => {
      if (!disk.overlays.has(DEVBOX_WORKDIR)) {
        throw new Error('the chain workspace is not attached, so a write has nowhere to land');
      }
      disk.writeFile(`${DEVBOX_WORKDIR}/${path}`, encoder.encode(text));
    },
    read: (path) => {
      const bytes = disk.readFile(`${DEVBOX_WORKDIR}/${path}`);
      return bytes === undefined ? undefined : decoder.decode(bytes);
    },
    remove: (path) => disk.removeFile(`${DEVBOX_WORKDIR}/${path}`),
    paths: () => disk.entries(DEVBOX_WORKDIR),
  };

  const generations = (): readonly string[] => row === null ? [] : [
    row.base.id,
    ...(row.fallback === undefined ? [] : [row.fallback.base.id]),
    ...(row.orphans ?? []),
  ];

  return {
    name: 'snapshot-chain',
    storage: () => storage,
    workspace,
    durable,
    deaths,
    replaceContainer: () => {
      disk.dead = true;
      disk = new ContainerDisk();
      // The stamp described an upper on the disk that just died. A blank disk
      // holds neither, which is what makes a replacement seed in full.
      seedStamp = undefined;
      storage = build();
    },
    stopContainer: () => {
      disk.stopped = true;
    },
    // Four windows, and every one of them is a real code point the chain
    // crosses: nothing staged, the archive landed under a key nothing names
    // yet, the record about to be replaced, and the record committed with its
    // cleanup outstanding. A death AFTER `writeState` returns is deliberately
    // absent: that write is the Durable Object's own storage, not a container
    // call, so the next thing a dead container refuses is the cleanup.
    commitSeams: ['before-payload', 'after-payload', 'before-pointer', 'before-cleanup'],
    publishSeam: 'before-pointer',
    dieAt: (seam) => deaths.arm(seam),
    payloadPrefixes: () => generations().map(id => `backups/${id}/`),
    controlPlane: async () => ({
      // The chain keeps NO control metadata in the store: `meta.json` exists
      // only for the extraction path, and the record that names a generation is
      // a Durable Object row. That is why a mount replacement cannot eat it.
      objectKeys: [],
      rows: ['chain-state'],
      head: row === null ? null : `${row.base.id}#${row.rev}`,
    }),
    declaredPayload: async () => {
      if (row === null) return [];
      const declared: DeclaredObject[] = [{
        key: baseObjectKey(row.base.id),
        byteLength: row.base.bytes,
        names: [baseObjectKey(row.base.id), 'base'],
      }];
      if (row.delta !== undefined) {
        declared.push({
          key: deltaObjectKey(row.base.id),
          byteLength: row.delta.bytes,
          names: [deltaObjectKey(row.base.id), 'delta'],
        });
      }
      return declared;
    },
    refusesCorruptPayload: true,
    committedHeads: async () => row === null ? [] : [`${row.base.id}#${row.rev}`],
  };
}

// ── r2fs ────────────────────────────────────────────────────────────────────

function r2fsArm(): ConformanceArm {
  const durable = new DurableStore();
  const deaths = new DeathWatch();
  const prefix = 'boxes/box-conformance';
  let disk = new ContainerDisk();
  let storage = build();

  function build(): DevboxStorage {
    const ports: R2fsPorts = {
      containerRunning: () => !disk.dead && !disk.stopped,
      readMounts: async () => disk.procMounts(),
      exec: async (command) => {
        if (command.startsWith('mkdir -p')) {
          for (const path of command.slice('mkdir -p'.length).trim().split(' ')) {
            disk.mkdirp(path.replace(/^'|'$/g, ''));
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command.startsWith('sync')) {
          // THE ONLY TWO SUB-STEPS THIS STRATEGY HAS. s3fs uploads a file when
          // its last handle closes, so a closed file is already durable and a
          // commit has no payload step of its own to interrupt: what a death
          // here interrupts is the flush that makes the kernel's dirty pages
          // reach s3fs at all.
          deaths.at('before-sync');
          const flushed = { stdout: '0', stderr: '', exitCode: 0 };
          deaths.at('after-sync');
          return flushed;
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      pathExists: async (path) => disk.exists(path),
      mount: async () => {
        if (disk.dead) throw new ContainerDied('mount on a dead container');
        disk.mkdirp(R2FS_CACHE_DIR);
        disk.mount(DEVBOX_WORKDIR, {
          source: `s3fs:${prefix}`,
          fstype: 'fuse.s3fs',
          options: 'rw',
        });
      },
      unmount: async () => {
        disk.unmount(DEVBOX_WORKDIR);
      },
      inventory: async () => durable.inventory(`${prefix}/`),
      clearPrefix: async () => durable.deletePrefix(`${prefix}/`),
      // NOTHING IN THIS MACHINE WRITES TO A BARE MOUNTPOINT: `workspace.write`
      // refuses when nothing is mounted, so the sweep has nothing to move and
      // says so. The dirty-mountpoint case lives in `r2fs.test.ts`, whose mount
      // refuses a non-empty mountpoint the way s3fs does.
      quarantineMountpoint: async () => 0,
      log: () => undefined,
    };
    return r2fsStorage(ports);
  }

  const mounted = (): boolean => disk.mounts.get(DEVBOX_WORKDIR)?.fstype.includes('s3fs') === true;

  const workspace: Workspace = {
    write: (path, text) => {
      if (!mounted()) throw new Error('the r2fs workspace is not mounted');
      // A closed file IS an object. That is the whole strategy.
      durable.put(`${prefix}/${path}`, encoder.encode(text));
    },
    read: (path) => {
      if (!mounted()) return undefined;
      const bytes = durable.get(`${prefix}/${path}`);
      return bytes === null ? undefined : decoder.decode(bytes);
    },
    remove: (path) => {
      durable.delete(`${prefix}/${path}`);
    },
    paths: () => mounted()
      ? durable.list(`${prefix}/`).map(key => key.slice(prefix.length + 1))
      : [],
  };

  return {
    name: 'r2fs',
    storage: () => storage,
    workspace,
    durable,
    deaths,
    replaceContainer: () => {
      disk.dead = true;
      disk = new ContainerDisk();
      storage = build();
    },
    stopContainer: () => {
      disk.stopped = true;
    },
    commitSeams: ['before-sync', 'after-sync'],
    publishSeam: 'after-sync',
    dieAt: (seam) => deaths.arm(seam),
    payloadPrefixes: () => [`${prefix}/`],
    controlPlane: async () => ({
      // NONE, and that is the strategy: the object store IS the filesystem, so
      // there is no head, no cursor and no envelope to misplace.
      objectKeys: [],
      rows: [],
      head: durable.inventory(`${prefix}/`).objects === 0 ? null : `${prefix}/`,
    }),
    declaredPayload: async () => [],
    refusesCorruptPayload: false,
    committedHeads: async () => durable.inventory(`${prefix}/`).objects === 0 ? [] : [`${prefix}/`],
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

  async put(key: string, bytes: Uint8Array, _meta?: CasPutMeta): Promise<void> {
    this.counters.putCalls += 1;
    this.counters.bytesPut += bytes.byteLength;
    this.durable.put(`${this.prefix}${key}`, bytes);
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
  let row: OverlayCasState | null = null;
  let container = freshContainer();
  let storage = build();

  /** The upper, and the whiteouts a delete leaves in it. Both die with the
   *  container: only `/workspace` is supplied by the image. */
  function freshContainer() {
    return {
      disk: new ContainerDisk(),
      upper: new Map<string, Uint8Array>(),
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
          container.whiteouts.add(entry.path);
          continue;
        }
        if (entry.kind !== 'file') continue;
        container.upper.set(entry.path, await drain(fileChunkStream(cas, entry)));
        container.whiteouts.delete(entry.path);
      }
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
      },
      unmountStore: async () => {
        if (container.disk.dead || container.disk.stopped) return;
        container.disk.unmount(CAS_STORE_MOUNT);
        container.storeMounted = false;
      },
      mountOverlay: async () => {
        if (container.disk.dead) throw new ContainerDied('mountOverlay on a dead container');
        container.overlay = true;
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
          if (error instanceof ContainerDied) throw error;
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
        row = next;
      },
      clearState: async () => {
        row = null;
      },
      checkpointIntervalMs: () => 0,
      now: () => Date.now(),
      log: () => undefined,
    };
    return overlayCasStorage(ports);
  }

  /** The overlay: the upper over the folded tree, which is what the mount
   *  serves. A read that misses the upper reads the tree object, exactly as
   *  s3fs would — no verification, because the mount does none. */
  const workspace: Workspace = {
    write: (path, text) => {
      if (!container.overlay) throw new Error('the overlay-cas workspace is not attached');
      container.upper.set(path, encoder.encode(text));
      container.whiteouts.delete(path);
    },
    read: (path) => {
      const held = container.upper.get(path);
      if (held !== undefined) return decoder.decode(held);
      if (container.whiteouts.has(path)) return undefined;
      if (!container.overlay) return undefined;
      const lower = durable.get(`${prefix}/${treeKey(path)}`);
      return lower === null ? undefined : decoder.decode(lower);
    },
    remove: (path) => {
      container.upper.delete(path);
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
  };

  return {
    name: 'overlay-cas',
    storage: () => storage,
    workspace,
    durable,
    deaths,
    replaceContainer: () => {
      container.disk.dead = true;
      container = freshContainer();
      storage = build();
    },
    stopContainer: () => {
      container.disk.stopped = true;
    },
    // One per durable sub-step of a fold, named from the CAS key layout.
    commitSeams: ['after-blob', 'after-journal', 'after-tree', 'after-manifest', 'after-cursor'],
    publishSeam: 'after-cursor',
    dieAt: (seam) => deaths.arm(seam),
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
  ) {}

  async issuePayloadGrant(intent: UploadIntent): Promise<PayloadGrant> {
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
  /** The Durable Object's own control record. It survives replacements, which
   *  is the whole reason the head is not payload. */
  const control = new MemoryControlStore();
  let container = freshContainer();
  let storage = build();

  function freshContainer() {
    return {
      disk: new ContainerDisk(),
      files: new Map<string, Uint8Array>(),
      journal: false,
      storeMounted: false,
      bootId: `boot-${crypto.randomUUID()}`,
      results: new Map<string, string>(),
      processes: new Map<string, CandidateRunnerProcess>(),
    };
  }

  const payload = (): MountedPayloadStore =>
    new MountedPayloadStore(durable, paths.payloadPrefix, deaths);

  /**
   * The envelope store, where the production adapter puts it: under the box's
   * CONTROL prefix, never under the payload prefix the container's mount owns.
   *
   * Deliberately store-backed rather than the in-memory envelope map the
   * publication suites use — the whole first defect class is a PLACEMENT bug,
   * and a map keyed by digest has no placement to get wrong.
   */
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

  /** The head CAS and the completion mark, with a death at each durable phase
   *  the shipped control plane writes. */
  const controlStore: CandidateControlStore = {
    read: async () => await control.read(),
    update: async (apply) => {
      let phase: string | undefined;
      const result = await control.update((current) => {
        const update = apply(current);
        phase = update.next?.operation?.phase;
        return update;
      });
      // AFTER the record is durable: the head CAS and the completion mark are
      // separate durable writes, so the interesting window is between them.
      if (phase !== undefined) deaths.reset(`after-${phase}`);
      return result;
    },
    clear: async () => await control.clear(),
  };

  /** The metadata check the production adapter makes from store metadata
   *  alone: absent, wrong length, wrong digest, or no upload version. */
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
  };

  const identityOf = (run: CandidateRunControlV1) => {
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
  };

  /**
   * The workspace, as an audited capture.
   *
   * Through `issueVerifiedJournalCapture`, which is the shipped factory a
   * journal-daemon capture goes through: nothing here hand-stamps a cut onto an
   * unaudited object, and the manifest digest is the shipped one.
   */
  function capture(input: { operationId: string; epoch: string; baseRevision: string }): AuditedCapture {
    let ino = 100;
    const entries: NodeEntry[] = [...container.files]
      .sort(([a], [b]) => a < b ? -1 : 1)
      .map(([path, bytes]) => ({
        path,
        kind: 'file' as const,
        mode: 0o644,
        ino: ino++,
        content: { kind: 'dense' as const, bytes },
        metadata: { uid: 1000, gid: 1000, atimeNs: '1', mtimeNs: '2', ctimeNs: '3', xattrs: {} },
      }));
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

  async function recoverParent(
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

  /** The container-side runner: build and stage through the shipped codecs. */
  async function runCheckpoint(run: CandidateRunControlV1): Promise<string> {
    const identity = identityOf(run);
    const store = payload();
    const sink = new MemoryCandidateObjectSink();
    const head = run.head;
    const audited = capture(identity);
    let plan;
    if (format === 'bounded-layers') {
      const parent = head === null
        ? undefined
        : (await openBoundedLayers(head.envelope.rootObject, store, identity))
          .withPublishedParent(await recoverParent(head, store, identity));
      plan = (await buildBoundedLayers(audited, parent, sink)).plan;
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
          await recoverParent(head, store, identity),
        );
      }
      plan = (await buildMerklePack(audited, { sink, parent })).plan;
    }
    const draft = await stageCandidatePayload(plan, identity, store);
    return JSON.stringify({
      ok: true,
      movedBytes: [...draft.dependencyReceipts, draft.rootReceipt, draft.closureReceipt]
        .reduce((bytes, receipt) => bytes + Number(receipt.byteLength), 0),
      heldBytes: draft.closure.reduce((bytes, ref) => bytes + Number(ref.byteLength), 0),
      draft,
    });
  }

  /** The container-side restore: read the published head back through the
   *  shipped verifying read path, and materialize it. */
  async function runRestore(run: CandidateRunControlV1): Promise<string> {
    const head = run.head;
    if (head === null) return JSON.stringify({ ok: true, rootId: null });
    const store = payload();
    const identity = {
      operationId: `restore-${head.pointer.lastOperationId}`,
      attemptId: '1',
      boxId,
      epoch: head.envelope.epoch,
      expiresAt: '99999999999999',
    };
    container.files.clear();
    if (format === 'bounded-layers') {
      const view = await openBoundedLayers(head.envelope.rootObject, store, identity);
      for (const path of view.entryPaths()) {
        const entry = view.stat(path);
        if (entry === null || entry === undefined) continue;
        if (entry.kind !== 'file' || entry.size === undefined) continue;
        container.files.set(path, await view.readRange(path, 0, entry.size));
      }
    } else {
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
      const walk = async (at: string): Promise<void> => {
        for (const child of await view.readdir(at)) {
          const path = at === '' ? child : `${at}/${child}`;
          const entry = await view.stat(path);
          if (entry === null) continue;
          if (entry.kind === 'dir') {
            await walk(path);
            continue;
          }
          if (entry.kind !== 'file' || entry.size === undefined) continue;
          container.files.set(path, await view.readRange(path, 0, entry.size));
        }
      };
      await walk('');
    }
    return JSON.stringify({ ok: true, rootId: head.pointer.rootEnvelopeId });
  }

  function build(): DevboxStorage {
    const ports: CandidateContainerPorts = {
      format,
      runnerPath: '/opt/kinu/candidate-runner.bundle.mjs',
      mountStore: async () => {
        if (container.disk.dead) throw new ContainerDied('mountStore on a dead container');
        if (container.disk.stopped) throw new ContainerStopped('mountStore');
        container.disk.mount(CANDIDATE_STORE_MOUNT, {
          source: `s3fs:${paths.payloadPrefix}`,
          fstype: 'fuse.s3fs',
          options: 'rw',
        });
        container.storeMounted = true;
      },
      unmountStore: async () => {
        if (container.disk.dead || container.disk.stopped) return;
        container.disk.unmount(CANDIDATE_STORE_MOUNT);
        container.storeMounted = false;
      },
      clearStore: async () => {
        durable.deletePrefix(`${paths.payloadPrefix}/`);
        durable.deletePrefix(`${paths.envelopePrefix}/`);
      },
      attachmentHealth: async () => ({
        storeMounted: container.storeMounted,
        storeAccessible: container.storeMounted,
        journalProcess: container.journal,
        journalSocket: container.journal,
        journalMounted: container.journal,
      }),
      begin: async (kind) => await beginCandidateOperation({
        kind: kind === 'tick' ? 'tick' : 'barrier',
        bootId: container.bootId,
        store: controlStore,
        envelopes,
        verifyObject,
      }),
      finalize: async (draft) => await finalizeCandidateOperation({
        draft,
        boxId,
        store: controlStore,
        envelopes,
        verifyObject,
      }),
      restoreState: async () => await candidateRunControl(controlStore, envelopes, verifyObject),
      settleNoChange: async (run) => {
        const active = run.operation;
        if (active?.phase !== 'transferring') {
          throw new Error('candidate no-change reply has no transferring operation to settle');
        }
        return await settleCandidateNoChange({ active, store: controlStore });
      },
      bootId: async () => container.bootId,
      redrive: async (run) => {
        const active = run.operation;
        if (active?.phase !== 'transferring') {
          throw new Error('candidate runner failure has no transferring operation to redrive');
        }
        return await redriveCandidateOperation({ active, store: controlStore, envelopes });
      },
      clearControl: async () => await controlStore.clear(),
      clearRunnerAttempt: async (resultPath) => {
        container.results.delete(resultPath);
        for (const [id, process] of container.processes) {
          if (process.id.includes('checkpoint')) container.processes.delete(id);
        }
      },
      clearRunnerResults: async () => {
        container.results.clear();
      },
      startJournal: async () => {
        if (container.disk.dead) throw new ContainerDied('startJournal on a dead container');
        if (container.disk.stopped) throw new ContainerStopped('startJournal');
        container.journal = true;
      },
      stopJournal: async () => {
        if (container.disk.dead) throw new ContainerDied('stopJournal on a dead container');
        if (container.disk.stopped) throw new ContainerStopped('stopJournal');
        container.journal = false;
      },
      getRunnerProcess: async (processId) => container.processes.get(processId) ?? null,
      waitForRunnerExit: async () => ({ exitCode: 0 }),
      activeCheckpoint: async () => null,
      startRunnerProcess: async (command, processId) => {
        if (container.disk.dead) throw new ContainerDied('startRunnerProcess on a dead container');
        if (container.disk.stopped) throw new ContainerStopped('startRunnerProcess');
        const argv = tokenize(command);
        const action = valueOf(argv, '--action');
        const resultPath = valueOf(argv, '--result');
        const run: CandidateRunControlV1 = JSON.parse(atob(valueOf(argv, '--control-state')));
        const printed = action === 'checkpoint'
          ? await runCheckpoint(run)
          : action === 'restore'
            ? await runRestore(run)
            : JSON.stringify({ ok: true });
        container.results.set(resultPath, printed);
        const process: CandidateRunnerProcess = {
          id: processId,
          getLogs: async () => ({ stdout: printed, stderr: '' }),
        };
        return process;
      },
      readRunnerResult: async (path) => {
        const held = container.results.get(path);
        if (held === undefined) throw new Error(`no candidate runner result at ${path}`);
        return held;
      },
      boxId: () => boxId,
      recordFailure: async () => undefined,
    };
    return candidateContainerStorage(ports);
  }

  const workspace: Workspace = {
    write: (path, text) => {
      if (!container.journal) throw new Error('the candidate workspace has no journal daemon');
      container.files.set(path, encoder.encode(text));
    },
    read: (path) => {
      const held = container.files.get(path);
      return held === undefined ? undefined : decoder.decode(held);
    },
    remove: (path) => {
      container.files.delete(path);
    },
    paths: () => [...container.files.keys()].sort(),
  };

  return {
    name: format,
    storage: () => storage,
    workspace,
    durable,
    deaths,
    replaceContainer: () => {
      container.disk.dead = true;
      container = freshContainer();
      storage = build();
    },
    stopContainer: () => {
      container.disk.stopped = true;
    },
    // The five windows the shipped publication really crosses: the payload
    // objects land under the container's own mount prefix; the envelope becomes
    // immutable under the CONTROL prefix; the sealed record is persisted; the
    // head CAS commits it (the pointer swap); and the completion mark closes
    // the operation. `after-transferring` is the begun-but-nothing-staged
    // window, which is the one a re-drive has to survive.
    commitSeams: [
      'after-transferring',
      'after-payload',
      'after-envelope',
      'after-sealed',
      'after-completion-pending',
      'after-published',
    ],
    publishSeam: 'after-published',
    dieAt: (seam) => deaths.arm(seam),
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
  };
}

/** One command as the strategy really quoted it. */
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
