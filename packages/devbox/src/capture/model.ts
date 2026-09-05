/**
 * The CaptureSound model: one total order of mutations, one exact cut, and the
 * audit that decides whether a capture is a prefix of that order.
 *
 * A capture of a native writable upper is SOUND when there exists exactly one
 * position in a global order of mutations such that the captured state equals
 * the live state at that position. Three failure modes are distinguishable and
 * all three are audited here:
 *
 *   torn     — the capture mixes states from two positions, so it equals NO
 *              prefix at all;
 *   leaked   — the capture contains a mutation applied after its own cut, so
 *              the prefix at the claimed cut does not equal it;
 *   unproven — the capture happens to equal some prefix but its mechanism
 *              cannot say which, so nothing downstream may rely on it.
 *
 * Every mechanism lives beside this model and is judged BY it: the tests replay
 * the log, compare prefixes, and reject anything that matches no cut or claims
 * the wrong one. A plain recursive scan of a live tree is the canonical torn
 * capture, and `naiveLiveScan` exists so the tests can show exactly that
 * failing rather than asserting it rhetorically.
 *
 * The model is deterministic: mtimes derive from sequence numbers, never from
 * the wall clock, so replaying a logged prefix rebuilds byte-and-metadata
 * identical state. That is what makes "equals prefix(cut)" a decidable claim
 * instead of a probabilistic one.
 *
 * Hardlinks are modeled by inode identity: two paths sharing an `ino` share one
 * underlying node, so an in-place rewrite through either path is visible at
 * both. A capture that copies hardlinked paths as independent files therefore
 * disagrees with every prefix whenever the shared inode was written between the
 * two visits — the audit sees it because entry `ino`s disagree with contents.
 */

import * as v from 'valibot';
import { createHash } from 'node:crypto';


import { sha256Hex } from '../cas/hash';
import { isCanonicalJournalPath } from '../cas/types';
import { CapturedCutSchema } from '../durability/contracts';
import type { CapturedCut } from '../durability/contracts';

/** A POSIX path relative to the upper's root, without a leading slash. */
export type UpperPath = string;

// ── content ──────────────────────────────────────────────────────────────────

export interface SparseRun {
  readonly offset: number;
  readonly bytes: Uint8Array;
}

/** One immutable byte range in the generation-local journal stage. */
export interface SealedExtent {
  readonly offset: number;
  readonly length: number;
  readonly sha256: string;
}

/** One byte range writes touched since the parent generation. */
export interface DirtyRange {
  readonly offset: number;
  readonly length: number;
}

/**
 * A sealed file has no payload in the capture manifest. Its extents are stable
 * local handles, so the codecs can stream verified ranges without copying a
 * workspace through the Durable Object or allocating its full size.
 *
 * `dirty` is present when the fence staged WINDOWS around the writes rather
 * than the whole file: the extents then hold those windows and nothing else,
 * a gap between them is the parent's bytes, and a builder re-chunks only what
 * `dirty` names. Absent, the extents enumerate every data run the file has.
 */
export interface SealedContent {
  readonly kind: 'sealed';
  readonly size: number;
  readonly sourceId: string;
  readonly extents: readonly SealedExtent[];
  readonly dirty?: readonly DirtyRange[];
}

export type FileContent =
  | { readonly kind: 'dense'; readonly bytes: Uint8Array }
  | { readonly kind: 'sparse'; readonly size: number; readonly runs: readonly SparseRun[] }
  | SealedContent;

/** Matches the bounded-layer fixed chunk size; a range never rehashes a whole file. */
export const MAX_SEALED_EXTENT_BYTES = 512 * 1024;

/** Logical bytes: sparse holes read back as zeros, like a real read(2). */
export function expandContent(content: FileContent): Uint8Array {
  if (content.kind === 'dense') return content.bytes.slice();
  if (content.kind === 'sealed') throw new Error('sealed capture content must be read through readCaptureRange');
  const out = new Uint8Array(content.size);
  for (const run of content.runs) out.set(run.bytes, run.offset);
  return out;
}

export function contentSize(content: FileContent): number {
  return content.kind === 'dense' ? content.bytes.byteLength : content.size;
}

export function contentExtents(content: FileContent): readonly SealedExtent[] {
  if (content.kind !== 'sealed') return [];
  return content.extents.map((extent) => Object.freeze({ ...extent }));
}

function sameRanges(
  a: readonly { readonly offset: number; readonly length: number }[],
  b: readonly { readonly offset: number; readonly length: number }[],
): boolean {
  return a.length === b.length && a.every((range, index) => {
    const other = b[index];
    return other !== undefined && range.offset === other.offset && range.length === other.length;
  });
}

export function contentEquals(a: FileContent, b: FileContent): boolean {
  if (a.kind === 'sealed' || b.kind === 'sealed') {
    return a.kind === 'sealed' && b.kind === 'sealed'
      && a.size === b.size
      && a.sourceId === b.sourceId
      && a.extents.length === b.extents.length
      && a.extents.every((extent, index) => {
        const other = b.extents[index];
        return other !== undefined && extent.offset === other.offset && extent.length === other.length && extent.sha256 === other.sha256;
      })
      && (a.dirty === undefined) === (b.dirty === undefined)
      && sameRanges(a.dirty ?? [], b.dirty ?? []);
  }
  return contentSize(a) === contentSize(b) && logicalContentSha256(a) === logicalContentSha256(b);
}

// ── nodes and state ──────────────────────────────────────────────────────────

export type NodeKind = 'file' | 'dir' | 'symlink';
/** POSIX metadata that affects restore semantics independently of file bytes. */
export interface PosixMetadata {
  readonly uid: number;
  readonly gid: number;
  readonly atimeNs: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
  /** Canonical base64 values, keyed by xattr name. */
  readonly xattrs: Readonly<Record<string, string>>;
}

const canonicalNanoseconds = /^(?:0|[1-9]\d*)$/;
const canonicalBase64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Reject metadata that cannot be serialized and restored without loss. */
export function requirePosixMetadata(metadata: PosixMetadata | undefined, path: UpperPath): asserts metadata is PosixMetadata {
  if (!metadata) throw new Error(`entry '${path}' carries no POSIX metadata`);
  if (!Number.isSafeInteger(metadata.uid) || metadata.uid < 0 || !Number.isSafeInteger(metadata.gid) || metadata.gid < 0) {
    throw new Error(`entry '${path}' carries invalid POSIX ownership`);
  }
  if (!canonicalNanoseconds.test(metadata.atimeNs) || !canonicalNanoseconds.test(metadata.mtimeNs) || !canonicalNanoseconds.test(metadata.ctimeNs)) {
    throw new Error(`entry '${path}' carries invalid POSIX timestamps`);
  }
  for (const [name, value] of Object.entries(metadata.xattrs)) {
    if (name.length === 0) throw new Error(`entry '${path}' carries an invalid xattr name`);
    if (!canonicalBase64.test(value)) throw new Error(`entry '${path}' carries an invalid xattr value`);
  }
}



export interface NodeEntry {
  readonly path: UpperPath;
  readonly kind: NodeKind;
  readonly mode: number;
  /** Underlying inode id. Two file entries sharing an id are hardlinks. */
  readonly ino: number;
  /** POSIX identity, timestamps and xattrs restored with the node. */
  readonly metadata?: PosixMetadata;
  /** Symlinks only. */
  readonly target?: string;
  /** Files only. */
  readonly content?: FileContent;
}

interface MutableStatSnapshot {
  kind: NodeKind;
  mode: number;
  ino: number;
  size: number;
  mtimeNs: number;
  target?: string;
}

interface ManifestRow {
  path: string;
  kind: NodeKind;
  mode: number;
  ino: number;
  metadata?: PosixMetadata;
  target?: string;
  sha256?: string;
  size?: number;
  sourceId?: string;
  extents?: readonly SealedExtent[];
  dirty?: readonly DirtyRange[];
}

export type StateSnapshot = ReadonlyMap<UpperPath, NodeEntry>;

function entryEquals(a: NodeEntry, b: NodeEntry): boolean {
  if (a.kind !== b.kind || a.mode !== b.mode || a.ino !== b.ino) return false;
  if ((a.target ?? null) !== (b.target ?? null)) return false;
  if (a.kind !== 'file') return true;
  // Both sides must carry content; the model never produces a file without it.
  if (!a.content || !b.content) return a.content === b.content;
  return contentEquals(a.content, b.content);
}

export function stateEquals(a: StateSnapshot, b: StateSnapshot): boolean {
  if (a.size !== b.size) return false;
  for (const [path, entry] of a) {
    const other = b.get(path);
    if (!other || !entryEquals(entry, other)) return false;
  }
  return true;
}

function toEntry(path: UpperPath, node: LiveNode): NodeEntry {
  const base = { path, kind: node.kind, mode: node.mode, ino: node.ino };
  if (node.kind === 'symlink') return { ...base, kind: 'symlink', target: node.target };
  if (node.kind === 'file') return { ...base, kind: 'file', content: node.content };
  return base;
}

// ── mutations ────────────────────────────────────────────────────────────────

export type MutationOp =
  | { readonly op: 'write'; readonly path: UpperPath; readonly content: FileContent; readonly mode?: number }
  /**
   * An in-place rewrite that keeps byte length and restores mtime — the class
   * no metadata observation can see. The model enforces the premise.
   */
  | { readonly op: 'rewrite-in-place'; readonly path: UpperPath; readonly content: FileContent }
  /** A write into an existing mapping: no metadata change whatsoever. */
  | { readonly op: 'mmap-write'; readonly path: UpperPath; readonly offset: number; readonly bytes: Uint8Array }
  | { readonly op: 'unlink'; readonly path: UpperPath }
  | { readonly op: 'rename'; readonly from: UpperPath; readonly to: UpperPath }
  /** Hardlink: the new path shares the existing path's inode. */
  | { readonly op: 'link'; readonly existingPath: UpperPath; readonly newPath: UpperPath }
  | { readonly op: 'symlink'; readonly path: UpperPath; readonly target: string }
  | { readonly op: 'mkdir'; readonly path: UpperPath; readonly mode?: number }
  | { readonly op: 'rmdir'; readonly path: UpperPath }
  /** Container replacement: the whole upper is swapped for a fresh one. */
  | { readonly op: 'replace-generation' };

export interface LogEntry {
  readonly seq: number;
  readonly op: MutationOp;
}

// ── the shared transition function ───────────────────────────────────────────

/**
 * A live node. Files carry content mandatorily and symlinks carry a target, so
 * consumers narrow instead of asserting.
 */
export type LiveNode =
  | { readonly kind: 'file'; mode: number; ino: number; mtimeNs: number; content: FileContent }
  | { readonly kind: 'dir'; mode: number; ino: number; mtimeNs: number }
  | { readonly kind: 'symlink'; mode: number; ino: number; mtimeNs: number; target: string };

interface FsTables {
  nodes: Map<UpperPath, LiveNode>;
  nextIno: number;
  generation: number;
}

function requireNode(tables: FsTables, path: UpperPath): LiveNode {
  const node = tables.nodes.get(path);
  if (!node) throw new Error(`no such path: ${path}`);
  return node;
}

/**
 * Apply one operation to tables. THE transition function: the live log and the
 * prefix replay both go through it, so their semantics cannot drift apart.
 * Mtimes are stamped from the writing seq at creation only — rewrites that
 * preserve time, and mmap stores that touch no metadata, leave it alone.
 */
function applyOp(tables: FsTables, op: MutationOp, seq: number): void {
  switch (op.op) {
    case 'write': {
      tables.nodes.set(op.path, {
        kind: 'file',
        mode: op.mode ?? 0o644,
        ino: tables.nextIno++,
        mtimeNs: seq,
        content: op.content,
      });
      return;
    }
    case 'rewrite-in-place': {
      const node = requireNode(tables, op.path);
      if (node.kind !== 'file') throw new Error(`not a file: ${op.path}`);
      if (contentSize(node.content) !== contentSize(op.content)) {
        throw new Error('rewrite-in-place requires the same logical size');
      }
      // Same inode object: every hardlink observes the in-place rewrite.
      // Same length, restored time: metadata observers learn nothing.
      node.content = op.content;
      return;
    }
    case 'mmap-write': {
      const node = requireNode(tables, op.path);
      if (node.kind !== 'file') throw new Error(`not a file: ${op.path}`);
      const current = expandContent(node.content);
      if (op.offset < 0 || op.offset + op.bytes.byteLength > current.byteLength) {
        throw new Error('mmap write out of bounds');
      }
      current.set(op.bytes, op.offset);
      // The shared inode changed; neither size nor mtime does.
      node.content = { kind: 'dense', bytes: current };
      return;
    }
    case 'unlink':
    case 'rmdir':
      tables.nodes.delete(op.path);
      return;
    case 'rename': {
      const node = requireNode(tables, op.from);
      tables.nodes.delete(op.from);
      tables.nodes.set(op.to, node);
      return;
    }
    case 'link': {
      const node = requireNode(tables, op.existingPath);
      if (node.kind !== 'file') throw new Error(`hardlinks are files only: ${op.existingPath}`);
      tables.nodes.set(op.newPath, node); // same object: shared inode semantics
      return;
    }
    case 'symlink':
      tables.nodes.set(op.path, {
        kind: 'symlink',
        mode: 0o777,
        ino: tables.nextIno++,
        mtimeNs: seq,
        target: op.target,
      });
      return;
    case 'mkdir':
      tables.nodes.set(op.path, {
        kind: 'dir',
        mode: op.mode ?? 0o755,
        ino: tables.nextIno++,
        mtimeNs: seq,
      });
      return;
    case 'replace-generation':
      tables.nodes.clear();
      tables.generation += 1;
      return;
  }
}

// ── stat surface (what a metadata observer can see) ──────────────────────────

export interface StatSnapshot {
  readonly kind: NodeKind;
  readonly mode: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeNs: number;
  readonly target?: string;
}

// ── the log: substrate for every mechanism and test ─────────────────────────

/**
 * One cooperative scheduling step, standing in for a real I/O await. A
 * microtask is enough: every interleaving point in the mechanisms goes through
 * this, so concurrent writers and readers round-robin deterministically
 * without binding anything to the wall clock.
 */
export async function tick(): Promise<void> {
  await Promise.resolve();
}

/**
 * The total order. Writers enter through `perform`, which parks them while the
 * log is frozen — the in-model equivalent of SIGSTOP or a freezer cgroup: a
 * stopped writer issues nothing. `bypassFrozenGate` exists ONLY to model a
 * freeze that leaks; no mechanism may call it.
 */
export class MutationLog {
  private readonly tables: FsTables = { nodes: new Map(), nextIno: 1, generation: 0 };
  private readonly applied: LogEntry[] = [];
  private frozen = false;
  private parkResolvers: Array<() => void> = [];
  private inflight = 0;
  private idleResolvers: Array<() => void> = [];

  get entries(): readonly LogEntry[] { return this.applied; }
  get generation(): number { return this.tables.generation; }
  /** Seq of the most recent applied mutation, or -1 on an untouched upper. */
  get lastSeq(): number { return this.applied.length - 1; }

  isFrozen(): boolean { return this.frozen; }
  inflightCount(): number { return this.inflight; }

  private notifyIdle(): void {
    if (this.inflight !== 0) return;
    const waiters = this.idleResolvers;
    this.idleResolvers = [];
    for (const resolve of waiters) resolve();
  }

  /**
   * A writer step. The frozen check and in-flight registration happen before
   * the first await, so a freeze sees every writer on exactly one side of its
   * barrier: parked before it or drained after it, never in a TOCTOU gap.
   */
  async perform(op: MutationOp): Promise<number> {
    while (this.frozen) {
      const pending = Promise.withResolvers<void>();
      this.parkResolvers.push(pending.resolve);
      await pending.promise;
    }
    this.inflight++;
    try {
      await tick();
      const seq = this.applied.length;
      const entry: LogEntry = { seq, op };
      this.applied.push(entry); // durable journal intent precedes the mutation
      try {
        applyOp(this.tables, op, seq);
      } catch (error) {
        this.applied.pop(); // invalid op had no effect and must leave no phantom seq
        throw error;
      }
      return seq;
    } finally {
      this.inflight--;
      this.notifyIdle();
    }
  }

  /**
   * Applies WITHOUT passing the freeze gate. Test-only, and named as such: a
   * call here is how a leaked freeze manifests inside the model.
   */
  bypassFrozenGate(op: MutationOp): number {
    const seq = this.applied.length;
    const entry: LogEntry = { seq, op };
    this.applied.push(entry);
    try {
      applyOp(this.tables, op, seq);
    } catch (error) {
      this.applied.pop();
      throw error;
    }
    return seq;
  }

  /** Stops every future `perform` at the gate. Running ops finish naturally. */
  freezeWriters(): void { this.frozen = true; }

  /** Resumes parked writers. */
  thawWriters(): void {
    this.frozen = false;
    const parked = this.parkResolvers.splice(0, this.parkResolvers.length);
    for (const resolve of parked) resolve();
  }

  /** Resolves once no operation is mid-flight. Parked writers stay parked. */
  async whenDrained(): Promise<void> {
    while (this.inflight !== 0) {
      const pending = Promise.withResolvers<void>();
      this.idleResolvers.push(pending.resolve);
      await pending.promise;
    }
  }

  // ── read surface ──

  statOf(path: UpperPath): StatSnapshot | null {
    const node = this.tables.nodes.get(path);
    if (!node) return null;
    const stat: MutableStatSnapshot = {
      kind: node.kind,
      mode: node.mode,
      ino: node.ino,
      size: node.kind === 'file' ? contentSize(node.content) : 0,
      mtimeNs: node.mtimeNs,
    };
    if (node.kind === 'symlink') stat.target = node.target;
    return stat;
  }

  /** All present paths, sorted — the deterministic walk order. */
  paths(): readonly UpperPath[] {
    return [...this.tables.nodes.keys()].sort();
  }

  readFile(path: UpperPath): Uint8Array {
    const node = requireNode(this.tables, path);
    if (node.kind !== 'file') throw new Error(`not a file: ${path}`);
    return expandContent(node.content);
  }

  /** Content as stored, for stagers that preserve sparseness. */
  readContent(path: UpperPath): FileContent {
    const node = requireNode(this.tables, path);
    if (node.kind !== 'file') throw new Error(`not a file: ${path}`);
    return node.content;
  }

  entryOf(path: UpperPath): NodeEntry | null {
    const node = this.tables.nodes.get(path);
    if (!node) return null;
    return toEntry(path, node);
  }
}

// ── prefix replay and the audit ──────────────────────────────────────────────

/** Rebuild the live state after mutations 0..cut have been applied. */
export function prefixState(entries: readonly LogEntry[], cut: number): StateSnapshot {
  if (cut < -1 || cut >= entries.length) throw new Error(`cut ${cut} outside log of ${entries.length}`);
  const tables: FsTables = { nodes: new Map(), nextIno: 1, generation: 0 };
  for (let i = 0; i <= cut; i++) {
    const entry = entries[i];
    if (!entry) throw new Error(`missing log entry at ${i}`);
    applyOp(tables, entry.op, entry.seq);
  }
  const state = new Map<UpperPath, NodeEntry>();
  for (const [path, node] of tables.nodes) state.set(path, toEntry(path, node));
  return state;
}

/**
 * A capture produced by any mechanism. A `cut` of -1 means "the mechanism
 * cannot name its cut" — the honest output of anything that scanned without a
 * barrier or a journal position.
 */
export interface Capture {
  readonly mechanism: 'stable-scan' | 'freeze-drain' | 'mutation-journal';
  /** Claimed cut: state == prefix(cut). -1 = unclaimed. */
  readonly cut: number;
  readonly generation: number;
  readonly entries: readonly NodeEntry[];
}

export interface CaptureAudit {
  /** Does the capture equal prefix(capture.cut)? False when cut is unclaimed. */
  readonly claimedCutMatches: boolean;
  /** Every DISTINCT cut whose prefix equals this capture. Empty means torn. */
  readonly matchingCuts: readonly number[];
  /**
   * True when exactly one cut matches — the only way an UNCLAIMED capture may
   * be anchored to a cut after the fact. A mechanism that names its cut does
   * not need this and must satisfy `claimedCutMatches` instead.
   */
  readonly uniquelyAnchored: boolean;
}

function captureAsState(capture: Capture): StateSnapshot {
  return new Map<UpperPath, NodeEntry>(capture.entries.map((e) => [e.path, e]));
}

function prefixGeneration(entries: readonly LogEntry[], cut: number): number {
  let generation = 0;
  for (let i = 0; i <= cut; i++) {
    if (entries[i]?.op.op === 'replace-generation') generation++;
  }
  return generation;
}

/** A capture cannot claim one inode while giving its hardlinks different bytes. */
function hasConsistentInodes(entries: readonly NodeEntry[]): boolean {
  const firstByIno = new Map<number, NodeEntry>();
  for (const entry of entries) {
    const first = firstByIno.get(entry.ino);
    if (!first) {
      firstByIno.set(entry.ino, entry);
      continue;
    }
    if (!entryEquals(first, entry)) return false;
  }
  return true;
}

/**
 * Decide whether a capture is a prefix of the log, and of which cuts. This is
 * the judge every mechanism answers to; nothing else in this module gets to
 * declare a capture sound. Distinct cuts with identical state each count: two
 * anchors mean the mechanism's claim is ambiguous, not satisfied twice.
 */
export function auditCapture(entries: readonly LogEntry[], capture: Capture): CaptureAudit {
  const target = captureAsState(capture);
  const matching: number[] = [];
  if (hasConsistentInodes(capture.entries)) {
    for (let cut = -1; cut < entries.length; cut++) {
      if (capture.generation >= 0 && capture.generation !== prefixGeneration(entries, cut)) continue;
      if (stateEquals(prefixState(entries, cut), target)) matching.push(cut);
    }
  }
  return {
    claimedCutMatches: capture.cut >= 0 && matching.includes(capture.cut),
    matchingCuts: matching,
    uniquelyAnchored: matching.length === 1,
  };
}

// ── publication: the shared durability contract ──────────────────────────────

export interface CapturedCutIdentity {
  readonly captureId: string;
  readonly epoch: string;
  readonly baseRevision: string;
  readonly stableStageHandle: string;
}

interface LogicalSegment {
  readonly start: number;
  readonly end: number;
  readonly parts: readonly Uint8Array[];
}

interface SparseSpan {
  readonly start: number;
  readonly end: number;
  readonly order: number;
  readonly bytes: Uint8Array;
}

function requireSparseGeometry(content: Extract<FileContent, { readonly kind: 'sparse' }>): void {
  if (!Number.isSafeInteger(content.size) || content.size < 0) {
    throw new Error('sparse content has an invalid logical size');
  }
  for (const run of content.runs) {
    const end = run.offset + run.bytes.byteLength;
    if (!Number.isSafeInteger(run.offset) || run.offset < 0 || !Number.isSafeInteger(end) || end > content.size) {
      throw new Error('sparse content run lies outside its logical size');
    }
  }
}

function appendNonZero(
  segments: LogicalSegment[],
  start: number,
  bytes: Uint8Array,
): void {
  let runStart = -1;
  for (let i = 0; i <= bytes.byteLength; i++) {
    if (i < bytes.byteLength && bytes[i] !== 0) {
      if (runStart === -1) runStart = i;
      continue;
    }
    if (runStart === -1) continue;
    const part = bytes.subarray(runStart, i);
    const absoluteStart = start + runStart;
    const previous = segments.at(-1);
    if (previous && previous.end === absoluteStart) {
      segments[segments.length - 1] = {
        start: previous.start,
        end: absoluteStart + part.byteLength,
        parts: [...previous.parts, part],
      };
    } else {
      segments.push({ start: absoluteStart, end: absoluteStart + part.byteLength, parts: [part] });
    }
    runStart = -1;
  }
}

function logicalSegments(content: FileContent): readonly LogicalSegment[] {
  if (content.kind === 'dense') {
    const segments: LogicalSegment[] = [];
    appendNonZero(segments, 0, content.bytes);
    return segments;
  }
  if (content.kind === 'sealed') return [];
  requireSparseGeometry(content);
  const spans: SparseSpan[] = content.runs.map((run, order) => ({
    start: run.offset,
    end: run.offset + run.bytes.byteLength,
    order,
    bytes: run.bytes,
  }));
  const boundaries = [...new Set([0, content.size, ...spans.flatMap((span) => [span.start, span.end])])].sort(
    (a, b) => a - b,
  );
  const starts = [...spans].sort((a, b) => a.start - b.start || a.order - b.order);
  const heap: SparseSpan[] = [];
  const push = (span: SparseSpan): void => {
    heap.push(span);
    for (let child = heap.length - 1; child > 0; ) {
      const parent = Math.floor((child - 1) / 2);
      if (heap[parent]!.order >= heap[child]!.order) return;
      [heap[parent], heap[child]] = [heap[child]!, heap[parent]!];
      child = parent;
    }
  };
  const pop = (): void => {
    const last = heap.pop();
    if (!last || heap.length === 0) return;
    heap[0] = last;
    for (let parent = 0; ;) {
      const left = parent * 2 + 1;
      const right = left + 1;
      let largest = parent;
      if (left < heap.length && heap[left]!.order > heap[largest]!.order) largest = left;
      if (right < heap.length && heap[right]!.order > heap[largest]!.order) largest = right;
      if (largest === parent) return;
      [heap[parent], heap[largest]] = [heap[largest]!, heap[parent]!];
      parent = largest;
    }
  };
  const segments: LogicalSegment[] = [];
  let nextStart = 0;
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i]!;
    const end = boundaries[i + 1]!;
    while (nextStart < starts.length && starts[nextStart]!.start <= start) push(starts[nextStart++]!);
    while (heap[0] && heap[0]!.end <= start) pop();
    const latest = heap[0];
    if (latest) appendNonZero(segments, start, latest.bytes.subarray(start - latest.start, end - latest.start));
  }
  return segments;
}

/**
 * Hash the logical byte sequence without materializing sparse holes. The
 * canonical encoding records only maximal non-zero intervals, so dense and
 * sparse inputs with equal `expandContent()` bytes hash identically.
 */
function logicalContentSha256(content: FileContent): string {
  const hash = createHash('sha256');
  hash.update(`logical-content/v1\n${contentSize(content)}\n`);
  if (content.kind === 'sealed') {
    for (const extent of content.extents) hash.update(`${extent.offset}:${extent.length}:${extent.sha256}\n`);
    if (content.dirty !== undefined) {
      hash.update('dirty\n');
      for (const range of content.dirty) hash.update(`${range.offset}:${range.length}\n`);
    }
    return hash.digest('hex');
  }
  for (const segment of logicalSegments(content)) {
    hash.update(`${segment.start}:${segment.end}\n`);
    for (const part of segment.parts) hash.update(part);
    hash.update('\n');
  }
  return hash.digest('hex');
}

/**
 * Canonical manifest bytes: entries sorted by path, encoded as stable JSON.
 * File digests describe logical bytes without allocating sparse holes.
 */
export function canonicalManifestBytes(capture: Capture): Uint8Array {
  const rows = [...capture.entries]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((e) => {
      const row: ManifestRow = {
        path: e.path,
        kind: e.kind,
        mode: e.mode,
        ino: e.ino,
      };
      if (e.metadata !== undefined) {
        row.metadata = {
          ...e.metadata,
          xattrs: Object.fromEntries(Object.entries(e.metadata.xattrs).sort(([a], [b]) => a.localeCompare(b))),
        };
      }
      if (e.target !== undefined) row.target = e.target;
      if (e.content !== undefined) {
        row.sha256 = logicalContentSha256(e.content);
        row.size = contentSize(e.content);
        if (e.content.kind === 'sealed') {
          row.sourceId = e.content.sourceId;
          row.extents = e.content.extents;
          if (e.content.dirty !== undefined) row.dirty = e.content.dirty;
        }
      }
      return row;
    });
  return new TextEncoder().encode(`${JSON.stringify({ generation: capture.generation, entries: rows })}\n`);
}

export function manifestSha256(capture: Capture): string {
  return sha256Hex(canonicalManifestBytes(capture));
}

/**
 * The one value a capture mechanism may hand a publisher. It carries the full
 * CapturedCut identity bound to the manifest digest, plus the snapshot input
 * as defensively-copied, frozen entries: mutating the mechanism's staging
 * buffers after this point cannot change what gets published.
 */
class CaptureFactoryAuthority {}

const captureFactoryAuthority = new CaptureFactoryAuthority();
const captureFactoryAuthorities = new WeakSet<object>([captureFactoryAuthority]);
const auditedCaptures = new WeakSet<AuditedCapture>();

export interface SealedContentReader {
  read(sourceId: string, offset: number, length: number): Promise<Uint8Array>;
}

/**
 * One structural mutation the WAL recorded since the parent's cut: an op that
 * changes which inode a name resolves to. A `rename` moves `from`, and
 * everything under it, to `to`; a `link` gives the inode at `from` the second
 * name `to`; a `create` (create, mkdir, mknod, symlink) puts a new inode at
 * `path`; a `remove` (unlink, rmdir) takes a name away. Writes, truncates and
 * attribute changes touch bytes and stat, never names, and are not here.
 */
export type StructuralOp =
  | { readonly op: 'rename'; readonly from: UpperPath; readonly to: UpperPath }
  | { readonly op: 'link'; readonly from: UpperPath; readonly to: UpperPath }
  | { readonly op: 'create'; readonly path: UpperPath }
  | { readonly op: 'remove'; readonly path: UpperPath };

/** Whether `name` is `prefix` or lies beneath it. */
function under(name: UpperPath, prefix: UpperPath): boolean {
  return name === prefix || name.startsWith(`${prefix}/`);
}

/** The one value a capture mechanism may hand a publisher. */
export class AuditedCapture {
  readonly #cut: number;
  readonly #capturedCut: CapturedCut;
  readonly #generation: number;
  readonly #entries: readonly NodeEntry[];
  readonly #sealedReader: SealedContentReader | undefined;
  /** A v2 delta fence: merge against the parent rather than replace. */
  readonly #partial: boolean;
  /** The structural ops a v2 delta capture says the WAL recorded since the
   *  parent's cut, in sequence order. */
  readonly #structural: readonly StructuralOp[];
  /** The inode each issued path carries, so a range read can tell an entry of
   *  this capture from a lookalike without walking the entries. */
  readonly #inoByPath: ReadonlyMap<UpperPath, number>;

  private constructor(
    cut: number,
    capturedCut: CapturedCut,
    generation: number,
    entries: readonly NodeEntry[],
    sealedReader: SealedContentReader | undefined,
    partial: boolean,
    structural: readonly StructuralOp[],
  ) {
    this.#cut = cut;
    this.#capturedCut = capturedCut;
    this.#generation = generation;
    this.#entries = entries;
    this.#sealedReader = sealedReader;
    this.#partial = partial;
    this.#structural = structural.map((op) => ({ ...op }));
    this.#inoByPath = new Map(entries.map((entry) => [entry.path, entry.ino]));
    auditedCaptures.add(this);
    Object.freeze(this);
  }

  /** Whether `entry` is one this capture issued: its path, with its inode. */
  issued(entry: NodeEntry): boolean {
    return this.#inoByPath.get(entry.path) === entry.ino;
  }

  /** True when this capture carries only the touched paths and must be merged
   *  against its published parent by a builder that supports the merge. */
  get partial(): boolean {
    return this.#partial;
  }

  /** The structural ops this capture carries, in WAL order. Empty for a
   *  whole-tree capture, which has no parent to relate names to. */
  get structural(): readonly StructuralOp[] {
    return this.#structural.map((op) => ({ ...op }));
  }

  /** The names this capture's ops took away: every unlinked or rmdir'd path
   *  and every rename's old name, canonical and sorted. A name the ops took
   *  away and gave back is still here; the builder's named rule keeps it. */
  get removed(): readonly string[] {
    const removed = new Set<UpperPath>();
    for (const op of this.#structural) {
      if (op.op === 'remove') removed.add(op.path);
      if (op.op === 'rename') removed.add(op.from);
    }
    return [...removed].sort();
  }

  /**
   * Where the inode now at `path` was when the parent was cut, or null when
   * this generation created it. The ops are walked newest first: a rename
   * onto or over the name moves it back, a link takes it to its source, and
   * a create or remove of the name means nothing older stands behind it.
   */
  originOf(path: UpperPath): UpperPath | null {
    let name = path;
    for (let at = this.#structural.length - 1; at >= 0; at -= 1) {
      const op = this.#structural[at]!;
      if (op.op === 'rename') {
        if (under(name, op.to)) name = `${op.from}${name.slice(op.to.length)}`;
      } else if (op.op === 'link') {
        if (name === op.to) name = op.from;
      } else if (under(name, op.path)) {
        return null;
      }
    }
    return name;
  }

  /**
   * Where the inode the parent held at `path` is now, or null when the ops
   * removed it or renamed another inode over it. The ops are walked oldest
   * first, so a rename of an ancestor carries the name along.
   */
  destinationOf(path: UpperPath): UpperPath | null {
    let name = path;
    for (const op of this.#structural) {
      if (op.op === 'rename') {
        if (under(name, op.from)) name = `${op.to}${name.slice(op.from.length)}`;
        else if (under(name, op.to)) return null;
      } else if (op.op === 'remove' && under(name, op.path)) {
        return null;
      }
    }
    return name;
  }

  get cut(): number {
    return this.#cut;
  }

  get capturedCut(): CapturedCut {
    return Object.freeze({ ...this.#capturedCut });
  }

  get generation(): number {
    return this.#generation;
  }

  get entries(): readonly NodeEntry[] {
    return snapshotEntries(this.#entries);
  }

  static issue(
    authority: CaptureFactoryAuthority,
    cut: number,
    capturedCut: CapturedCut,
    generation: number,
    entries: readonly NodeEntry[],
    sealedReader?: SealedContentReader,
    partial = false,
    structural: readonly StructuralOp[] = [],
  ): AuditedCapture {
    if (!captureFactoryAuthorities.has(authority)) throw new Error('AuditedCapture issuance is factory-only');
    return new AuditedCapture(cut, capturedCut, generation, entries, sealedReader, partial, structural);
  }

  readSealed(sourceId: string, offset: number, length: number): Promise<Uint8Array> {
    if (!this.#sealedReader) throw new Error('capture has no sealed content reader');
    return this.#sealedReader.read(sourceId, offset, length);
  }
}

/** Reject lookalikes and recheck the immutable cut-to-manifest binding. */
export function requireAuditedCapture(value: AuditedCapture): AuditedCapture {
  if (!auditedCaptures.has(value)) throw new Error('candidate input is not an AuditedCapture issued by the capture factory');
  if (value.capturedCut.cut !== String(value.cut)) throw new Error('AuditedCapture cut is not bound to its captured cut');
  const manifest = manifestSha256({
    mechanism: 'mutation-journal',
    cut: value.cut,
    generation: value.generation,
    entries: value.entries,
  });
  if (manifest !== value.capturedCut.manifestSha256) {
    throw new Error('AuditedCapture manifest is not bound to its captured cut');
  }
  return value;
}

/**
 * Streams an immutable capture range without materializing the full file.
 *
 * The capture is recognized by identity and the entry by the index the
 * capture built at issue, never by re-walking or re-hashing the entries: a
 * builder reads one range per chunk, so a per-read walk made a whole-tree
 * seal of n sealed files cost n squared (2026-09-05: the bounded-layers
 * battery's 100,000-file cell did not finish inside a 1600 s run).
 */
export async function readCaptureRange(
  capture: AuditedCapture,
  entry: NodeEntry,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  if (!auditedCaptures.has(capture)) throw new Error('candidate input is not an AuditedCapture issued by the capture factory');
  if (entry.kind !== 'file' || !entry.content) throw new Error('capture range requires a file entry');
  if (!capture.issued(entry)) throw new Error('capture range entry was not issued with this capture');
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > contentSize(entry.content)) {
    throw new Error('capture range is outside file bounds');
  }
  if (entry.content.kind === 'dense') return entry.content.bytes.slice(offset, offset + length);
  const bytes = new Uint8Array(length);
  if (entry.content.kind === 'sparse') {
    for (const run of entry.content.runs) {
      const start = Math.max(offset, run.offset);
      const end = Math.min(offset + length, run.offset + run.bytes.byteLength);
      if (start < end) bytes.set(run.bytes.subarray(start - run.offset, end - run.offset), start - offset);
    }
    return bytes;
  }
  const extents = entry.content.extents;
  let low = 0;
  let high = extents.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const extent = extents[middle]!;
    if (extent.offset + extent.length <= offset) low = middle + 1;
    else high = middle;
  }
  for (let index = low; index < extents.length; index++) {
    const extent = extents[index]!;
    if (extent.offset >= offset + length) break;
    const start = Math.max(offset, extent.offset);
    const end = Math.min(offset + length, extent.offset + extent.length);
    if (start >= end) continue;
    const whole = await capture.readSealed(entry.content.sourceId, extent.offset, extent.length);
    if (whole.byteLength !== extent.length || sha256Hex(whole) !== extent.sha256) {
      throw new Error(`sealed extent ${entry.content.sourceId}:${extent.offset} failed integrity verification`);
    }
    bytes.set(whole.subarray(start - extent.offset, end - extent.offset), start - offset);
  }
  return bytes;
}

/**
 * The FUSE daemon proves a cut with an append-only WAL, a durable fence record,
 * and the digest of the materialized manifest.  It cannot be replayed through
 * `MutationLog`: that model deliberately represents only its reduced mutation
 * alphabet.  Keep the exceptional bridge narrow and recheck every value that
 * crosses it before issuing the same sealed capture publishers consume.
 */
export interface VerifiedJournalCut {
  readonly cut: number;
  readonly generation: number;
  readonly entries: readonly NodeEntry[];
  readonly identity: CapturedCutIdentity;
  readonly manifestSha256: string;
  readonly sealedReader?: SealedContentReader;
  /**
   * A v2 delta fence: only the touched paths (plus their ancestors) appear in
   * `entries`, and `structural` holds the ops the WAL recorded since the
   * parent's cut, in sequence order, so the merge knows what was removed and
   * where a renamed inode came from. The capture is an OVERLAY a builder
   * merges against its published parent — never a whole-tree replacement, so
   * a builder that cannot merge must refuse it rather than silently drop the
   * unnamed majority of the tree.
   */
  readonly partial?: boolean;
  readonly structural?: readonly StructuralOp[];
}

/** Issues a sealed capture only after a local journal has verified its fence. */
export function issueVerifiedJournalCapture(proof: VerifiedJournalCut): AuditedCapture {
  if (!Number.isSafeInteger(proof.cut) || proof.cut < 0) throw new Error('journal fence has an invalid cut');
  if (!Number.isSafeInteger(proof.generation) || proof.generation < 0) {
    throw new Error('journal fence has an invalid generation');
  }
  for (const entry of proof.entries) requirePosixMetadata(entry.metadata, entry.path);
  // A WHOLE-TREE capture must BE a tree; a PARTIAL one (the v2 delta fence)
  // must still be internally canonical — every named path's ancestors present
  // as directories — but is not the whole tree, and the manifest digest that
  // binds the cut covers exactly the named subset.
  if (proof.partial === true) {
    requirePartialCaptureTree(proof.entries);
  } else {
    requireCompleteCaptureTree(proof.entries);
  }
  if (proof.entries.some((entry) => entry.content?.kind === 'sealed') && !proof.sealedReader) {
    throw new Error('sealed journal capture has no range reader');
  }
  const snapshot = snapshotEntries(proof.entries);
  const manifest = manifestSha256({
    mechanism: 'mutation-journal',
    cut: proof.cut,
    generation: proof.generation,
    entries: snapshot,
  });
  if (manifest !== proof.manifestSha256) throw new Error('journal fence manifest digest mismatch');
  const capturedCut = Object.freeze(
    v.parse(CapturedCutSchema, {
      captureId: proof.identity.captureId,
      epoch: proof.identity.epoch,
      baseRevision: proof.identity.baseRevision,
      cut: String(proof.cut),
      stableStageHandle: proof.identity.stableStageHandle,
      manifestSha256: manifest,
    }),
  );
  const structural = proof.partial === true ? proof.structural ?? [] : [];
  for (const op of structural) {
    const paths = op.op === 'rename' || op.op === 'link' ? [op.from, op.to] : [op.path];
    for (const path of paths) {
      if (!isCanonicalJournalPath(path)) {
        throw new Error(`journal fence names a non-canonical ${op.op} path '${path}'`);
      }
    }
  }
  return AuditedCapture.issue(
    captureFactoryAuthority, proof.cut, capturedCut, proof.generation, snapshot, proof.sealedReader,
    proof.partial === true, structural,
  );
}

/**
 * WHAT A GENERATION REMOVES, relative to the parent it is published against.
 *
 * THE ONE RULE, IN ONE PLACE: absence means removal only for a WHOLE-TREE
 * capture. Such a capture states the entire filesystem, so a parent path it
 * does not name is a path that is gone. A PARTIAL capture — the v2 delta fence
 * — states only what it touched, so absence there means "the parent still owns
 * this" and removals are named explicitly by the WAL's own unlink, rmdir and
 * rename records.
 *
 * Getting this backwards deletes an untouched tree, and both directions were
 * observed before this had a name: v1 buildMerklePack dropped every path a
 * partial capture did not name, and bounded-layers tombstoned them. Both
 * codecs now ask this function instead of reasoning about it locally.
 *
 * `parentPaths` is lazy because the answer needs it only for a whole-tree
 * capture: a partial capture's removals are its own, and a codec whose parent
 * cannot enumerate paths cheaply (a Merkle view walks lazily) must not be made
 * to try.
 */
export function removalsAgainstParent(
  capture: AuditedCapture,
  parentPaths: () => Iterable<UpperPath>,
): ReadonlySet<UpperPath> {
  if (capture.partial) return new Set(capture.removed);
  const present = new Set(capture.entries.map((entry) => entry.path));
  const removed = new Set<UpperPath>();
  for (const path of parentPaths()) {
    if (!present.has(path)) removed.add(path);
  }
  return removed;
}

/** Sealed extents ascend inside the file at the stage's split; dirty ranges
 *  ascend inside the file too. Both rules hold for a whole-tree capture and
 *  a partial one alike. */
function requireSealedContent(content: SealedContent, path: UpperPath): void {
  if (!Number.isSafeInteger(content.size) || content.size < 0 || content.sourceId.length === 0) {
    throw new Error(`sealed content for '${path}' is invalid`);
  }
  let end = 0;
  for (const extent of content.extents) {
    if (!Number.isSafeInteger(extent.offset) || !Number.isSafeInteger(extent.length)
      || extent.offset < end || extent.length <= 0 || extent.length > MAX_SEALED_EXTENT_BYTES
      || extent.offset + extent.length > content.size || !/^[a-f0-9]{64}$/.test(extent.sha256)) {
      throw new Error(`sealed extent for '${path}' is invalid`);
    }
    end = extent.offset + extent.length;
  }
  let dirtyEnd = 0;
  for (const range of content.dirty ?? []) {
    if (!Number.isSafeInteger(range.offset) || !Number.isSafeInteger(range.length)
      || range.offset < dirtyEnd || range.length <= 0 || range.offset + range.length > content.size) {
      throw new Error(`dirty range for '${path}' is invalid`);
    }
    dirtyEnd = range.offset + range.length;
  }
}

/** The relaxed tree rule a v2 delta capture must satisfy: canonical paths, no
 *  duplicates, real identity on every entry, and every NAMED path's ancestors
 *  present as directories. Paths the capture does not name are the parent's
 *  business, not this capture's. */
function requirePartialCaptureTree(entries: readonly NodeEntry[]): void {
  const byPath = new Map<UpperPath, NodeEntry>();
  for (const entry of entries) {
    const path = entry.path;
    if (path === '' || path.startsWith('/') || path.endsWith('/')) {
      throw new Error(`non-canonical capture path '${path}'`);
    }
    for (const segment of path.split('/')) {
      if (segment === '' || segment === '.' || segment === '..') {
        throw new Error(`non-canonical capture path '${path}'`);
      }
    }
    if (byPath.has(path)) throw new Error(`duplicate capture path '${path}'`);
    if (!Number.isSafeInteger(entry.mode) || entry.mode < 0) {
      throw new Error(`entry '${path}' carries no real mode`);
    }
    if (!Number.isSafeInteger(entry.ino) || entry.ino <= 0) {
      throw new Error(`entry '${path}' carries no real inode identity`);
    }
    if (entry.kind === 'file' && !entry.content) {
      throw new Error(`file entry '${path}' carries no content`);
    }
    if (entry.kind === 'symlink' && entry.target === undefined) {
      throw new Error(`symlink entry '${path}' carries no target`);
    }
    if (entry.content?.kind === 'sealed') requireSealedContent(entry.content, path);
    byPath.set(path, entry);
  }
  for (const [path] of byPath) {
    let ancestor = parentOf(path);
    while (ancestor !== '') {
      const parent = byPath.get(ancestor);
      if (parent === undefined) {
        throw new Error(`incomplete partial capture: ancestor '${ancestor}' of '${path}' is absent`);
      }
      if (parent.kind !== 'dir') {
        throw new Error(`ancestor '${ancestor}' of '${path}' is a ${parent.kind}, not a directory`);
      }
      ancestor = parentOf(ancestor);
    }
  }
}


function snapshotMetadata(metadata: PosixMetadata | undefined): PosixMetadata | undefined {
  if (!metadata) return undefined;
  return Object.freeze({
    uid: metadata.uid,
    gid: metadata.gid,
    atimeNs: metadata.atimeNs,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs,
    xattrs: Object.freeze({ ...metadata.xattrs }),
  });
}

function snapshotEntry(entry: NodeEntry): NodeEntry {
  const metadata = snapshotMetadata(entry.metadata);
  const base = metadata ? { ...entry, metadata } : { ...entry };
  if (entry.kind !== 'file' || !entry.content) return Object.freeze(base);
  let content: FileContent;
  if (entry.content.kind === 'dense') {
    content = Object.freeze({ kind: 'dense' as const, bytes: entry.content.bytes.slice() });
  } else if (entry.content.kind === 'sealed') {
    const sealed: SealedContent = {
      kind: 'sealed',
      size: entry.content.size,
      sourceId: entry.content.sourceId,
      extents: Object.freeze(entry.content.extents.map((extent) => Object.freeze({ ...extent }))),
    };
    content = entry.content.dirty === undefined
      ? Object.freeze(sealed)
      : Object.freeze({ ...sealed, dirty: Object.freeze(entry.content.dirty.map((range) => Object.freeze({ ...range }))) });
  } else {
    content = Object.freeze({
      kind: 'sparse' as const,
      size: entry.content.size,
      runs: Object.freeze(
        entry.content.runs.map((run) => Object.freeze({ offset: run.offset, bytes: run.bytes.slice() })),
      ),
    });
  }
  return Object.freeze({ ...base, content });
}

function snapshotEntries(entries: readonly NodeEntry[]): readonly NodeEntry[] {
  return Object.freeze(entries.map(snapshotEntry));
}

/**
 * The complete-tree rule every publishable capture must satisfy, shared by
 * both codecs through toCapturedCut. A capture's entry set must BE a tree:
 * canonical relative paths, no duplicates, every non-root ancestor present as
 * a directory (a symlink or file may never parent), and entries carrying only
 * the metadata their kind defines. Missing ancestors are REJECTED, never
 * synthesized with invented metadata.
 */
export function requireCompleteCaptureTree(entries: readonly NodeEntry[]): void {
  const byPath = new Map<UpperPath, NodeEntry>();
  for (const entry of entries) {
    const path = entry.path;
    if (path === '' || path.startsWith('/') || path.endsWith('/')) {
      throw new Error(`non-canonical capture path '${path}'`);
    }
    for (const segment of path.split('/')) {
      if (segment === '' || segment === '.' || segment === '..') {
        throw new Error(`non-canonical capture path '${path}'`);
      }
    }
    if (byPath.has(path)) throw new Error(`duplicate capture path '${path}'`);
    if (!Number.isSafeInteger(entry.mode) || entry.mode < 0) {
      throw new Error(`entry '${path}' carries no real mode`);
    }
    if (!Number.isSafeInteger(entry.ino) || entry.ino <= 0) {
      throw new Error(`entry '${path}' carries no real inode identity`);
    }
    if (entry.metadata !== undefined) requirePosixMetadata(entry.metadata, path);
    if (entry.kind === 'file' && !entry.content) {
      throw new Error(`file entry '${path}' carries no content`);
    }
    if (entry.kind === 'symlink' && entry.target === undefined) {
      throw new Error(`symlink entry '${path}' carries no target`);
    }
    if (entry.kind !== 'file' && entry.content !== undefined) {
      throw new Error(`${entry.kind} entry '${path}' carries invented content metadata`);
    }
    if (entry.kind !== 'symlink' && entry.target !== undefined) {
      throw new Error(`${entry.kind} entry '${path}' carries an invented symlink target`);
    }
    if (entry.content?.kind === 'sealed') requireSealedContent(entry.content, path);
    byPath.set(path, entry);
  }
  for (const [path] of byPath) {
    let ancestor = parentOf(path);
    while (ancestor !== '') {
      const parent = byPath.get(ancestor);
      if (!parent) {
        throw new Error(`incomplete capture: ancestor '${ancestor}' of '${path}' is absent`);
      }
      if (parent.kind !== 'dir') {
        throw new Error(`ancestor '${ancestor}' of '${path}' is a ${parent.kind}, not a directory`);
      }
      ancestor = parentOf(ancestor);
    }
  }
}

function parentOf(path: UpperPath): UpperPath {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
}

/**
 * Materialize an audited capture for publication. Requires LOG evidence — the
 * entries are replayed, not trusted — and rejects every unsound shape:
 *
 *   torn       the capture equals no prefix of the log at all;
 *   unclaimed  the mechanism names no cut (-1), so nothing downstream can rely
 *              on it even when one prefix happens to match; a bare scan never
 *              ships. A uniquely-anchored scan must CLAIM its anchor first;
 *   ambiguous  more than one prefix matches, so no single cut identifies it;
 *   leaked     the claimed cut is not among the prefixes the audit proves.
 */
export function toCapturedCut(
  entries: readonly LogEntry[],
  capture: Capture,
  identity: CapturedCutIdentity,
): AuditedCapture {
  if (capture.entries.some((entry) => entry.metadata !== undefined)) {
    throw new Error(`log-audited capture (${capture.mechanism}) carries unmodeled POSIX metadata`);
  }
  requireCompleteCaptureTree(capture.entries);
  const audit = auditCapture(entries, capture);
  if (audit.matchingCuts.length === 0) {
    throw new Error(`torn capture (${capture.mechanism}): its entries equal no prefix of the log`);
  }
  if (capture.cut < 0) {
    const hint = audit.uniquelyAnchored ? '; claim the unique anchor first' : '';
    throw new Error(`unclaimed capture (${capture.mechanism}): only an audit-proven claimed cut publishes${hint}`);
  }
  if (audit.matchingCuts.length > 1) {
    throw new Error(`ambiguous capture (${capture.mechanism}): cuts ${audit.matchingCuts.join(', ')} all match`);
  }
  if (!audit.claimedCutMatches) {
    throw new Error(
      `leaked capture (${capture.mechanism}): claimed cut ${capture.cut} is not proven (proven: ${audit.matchingCuts[0]})`,
    );
  }
  const snapshot = snapshotEntries(capture.entries);
  const capturedCut = Object.freeze(
    v.parse(CapturedCutSchema, {
      captureId: identity.captureId,
      epoch: identity.epoch,
      baseRevision: identity.baseRevision,
      cut: String(capture.cut),
      stableStageHandle: identity.stableStageHandle,
      manifestSha256: manifestSha256({
        mechanism: capture.mechanism,
        cut: capture.cut,
        generation: capture.generation,
        entries: snapshot,
      }),
    }),
  );
  return AuditedCapture.issue(captureFactoryAuthority, capture.cut, capturedCut, capture.generation, snapshot);
}
