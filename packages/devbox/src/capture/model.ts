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

import { sha256Hex } from '../cas/hash';
import { CapturedCutSchema } from '../durability/contracts';
import type { CapturedCut } from '../durability/contracts';

/** A POSIX path relative to the upper's root, without a leading slash. */
export type UpperPath = string;

// ── content ──────────────────────────────────────────────────────────────────

export interface SparseRun {
  readonly offset: number;
  readonly bytes: Uint8Array;
}

/**
 * File content either as stored bytes or as sparse extents. Sparse is part of
 * the model because a stager that materializes holes changes allocation but
 * must never change logical bytes; the audit compares logical bytes only.
 */
export type FileContent =
  | { readonly kind: 'dense'; readonly bytes: Uint8Array }
  | { readonly kind: 'sparse'; readonly size: number; readonly runs: readonly SparseRun[] };

/** Logical bytes: sparse holes read back as zeros, like a real read(2). */
export function expandContent(content: FileContent): Uint8Array {
  // Never expose an inode's backing bytes. A mmap write must produce a NEW
  // content version; otherwise it rewrites already-captured entries by alias.
  if (content.kind === 'dense') return content.bytes.slice();
  const out = new Uint8Array(content.size);
  for (const run of content.runs) out.set(run.bytes, run.offset);
  return out;
}

export function contentSize(content: FileContent): number {
  return content.kind === 'dense' ? content.bytes.byteLength : content.size;
}

export function contentEquals(a: FileContent, b: FileContent): boolean {
  const ea = expandContent(a);
  const eb = expandContent(b);
  if (ea.byteLength !== eb.byteLength) return false;
  for (let i = 0; i < ea.byteLength; i++) if (ea[i] !== eb[i]) return false;
  return true;
}

// ── nodes and state ──────────────────────────────────────────────────────────

export type NodeKind = 'file' | 'dir' | 'symlink';

export interface NodeEntry {
  readonly path: UpperPath;
  readonly kind: NodeKind;
  readonly mode: number;
  /** Underlying inode id. Two file entries sharing an id are hardlinks. */
  readonly ino: number;
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
  target?: string;
  sha256?: string;
  size?: number;
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

/**
 * Canonical manifest bytes: entries sorted by path, content expanded, encoded
 * as stable JSON. Two captures of one state hash equally regardless of which
 * mechanism staged them.
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
      if (e.target !== undefined) row.target = e.target;
      if (e.content !== undefined) {
        row.sha256 = sha256Hex(expandContent(e.content));
        row.size = contentSize(e.content);
      }
      return row;
    });
  return new TextEncoder().encode(`${JSON.stringify({ generation: capture.generation, entries: rows })}\n`);
}

export function manifestSha256(capture: Capture): string {
  return sha256Hex(canonicalManifestBytes(capture));
}

/**
 * Materialize a capture as the durability contracts' CapturedCut. Requires the
 * mechanism to NAME its cut: an unclaimed capture (-1) is unpublishable by
 * construction, which is the formal reason a bare scan never ships.
 */
export function toCapturedCut(capture: Capture, identity: CapturedCutIdentity): CapturedCut {
  if (capture.cut < 0) throw new Error('a capture without a claimed cut is not publishable');
  return v.parse(CapturedCutSchema, {
    captureId: identity.captureId,
    epoch: identity.epoch,
    baseRevision: identity.baseRevision,
    cut: String(capture.cut),
    stableStageHandle: identity.stableStageHandle,
    manifestSha256: manifestSha256(capture),
  });
}
