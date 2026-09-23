/** Live trees for the conformance battery: seeded generation and property-by-property compare.
 *  Sparse files stay as runs (never expanded), so a 1 GiB cell runs in a few MiB. */

import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { Seeded } from '../../bench/seeded';

export { Seeded } from '../../bench/seeded';

export type NodeKind = 'file' | 'dir' | 'symlink';

/** One resident byte range of a sparse file. Runs may overlap and arrive
 *  unsorted; {@link paintedSegments} resolves them last-writer-wins. */
export interface SparseRun {
  readonly offset: number;
  readonly bytes: Uint8Array;
}

export type FileContent =
  | { readonly kind: 'dense'; readonly bytes: Uint8Array }
  | { readonly kind: 'sparse'; readonly size: number; readonly runs: readonly SparseRun[] };

/** The logical length, holes included. */
export function contentSize(content: FileContent): number {
  return content.kind === 'dense' ? content.bytes.byteLength : content.size;
}

export interface PosixMetadata {
  readonly uid: number;
  readonly gid: number;
  readonly atimeNs: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
  /** Canonical base64 values, keyed by xattr name. */
  readonly xattrs: Readonly<Record<string, string>>;
}

/** One node of a served tree. Two file entries sharing `ino` are hardlinks. */
export interface NodeEntry {
  readonly path: string;
  readonly kind: NodeKind;
  readonly mode: number;
  readonly ino: number;
  readonly metadata?: PosixMetadata;
  /** Symlinks only. */
  readonly target?: string;
  /** Files only. */
  readonly content?: FileContent;
}

/** One row of {@link canonicalTreeBytes}: a node reduced to the fields two
 *  trees are compared by. */
interface ManifestRow {
  path: string;
  kind: NodeKind;
  mode: number;
  ino: number;
  metadata: PosixMetadata;
  target?: string;
  sha256?: string;
  size?: number;
}

/** One span of a file's logical bytes: a hole, or the bytes that fill it.
 *  `start` is the absolute offset in the logical file. */
type Segment =
  | { readonly zeros: true; readonly start: number; readonly end: number }
  | { readonly zeros: false; readonly start: number; readonly end: number; readonly view: Uint8Array };

interface LogicalLayout {
  readonly segments: Segment[];
  readonly size: number;
}

interface Claim {
  readonly start: number;
  readonly end: number;
  readonly view: Uint8Array;
}

function subtract(pieces: Array<[number, number]>, start: number, end: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];

  for (const [from, to] of pieces) {
    if (to <= start || from >= end) {
      out.push([from, to]);
      continue;
    }

    if (from < start) out.push([from, start]);

    if (end < to) out.push([end, to]);
  }

  return out;
}

/** Runs apply last-writer-wins in array order, matching `out.set(run.bytes, run.offset)`,
 *  even when overlapping or unsorted; gaps become explicit zero segments to keep holes O(runs). */
export function paintedSegments(content: FileContent): LogicalLayout {
  if (content.kind === 'dense') {
    return {
      segments: [{ zeros: false, start: 0, end: content.bytes.byteLength, view: content.bytes }],
      size: content.bytes.byteLength,
    };
  }

  // Paint from the last run backwards so earlier runs only fill unclaimed
  // ranges; whatever a later run covered already stays later-run-owned.
  const claims: Claim[] = [];

  for (let i = content.runs.length - 1; i >= 0; i--) {
    const run = content.runs[i];
    const start = Math.min(Math.max(run.offset, 0), content.size);
    const end = Math.min(run.offset + run.bytes.byteLength, content.size);

    if (end <= start) continue;
    let pieces: Array<[number, number]> = [[start, end]];

    for (const claim of claims) pieces = subtract(pieces, claim.start, claim.end);

    for (const [from, to] of pieces) {
      claims.push({ start: from, end: to, view: run.bytes.subarray(from - run.offset, to - run.offset) });
    }
  }

  claims.sort((a, b) => a.start - b.start);

  const segments: Segment[] = [];
  let cursor = 0;

  for (const claim of claims) {
    if (claim.start > cursor) segments.push({ zeros: true, start: cursor, end: claim.start });
    segments.push({ zeros: false, start: claim.start, end: claim.end, view: claim.view });
    cursor = claim.end;
  }

  if (cursor < content.size) segments.push({ zeros: true, start: cursor, end: content.size });

  return { segments, size: content.size };
}

/** Metadata values are never zero, so a restore that zeroes a field cannot pass by
 *  matching a zero fixture. */
export function metadataOf(seed: Seeded, xattrs: Record<string, string> = {}): PosixMetadata {
  return {
    uid: 1000 + seed.below(1000),
    gid: 1000 + seed.below(1000),
    atimeNs: String(1_700_000_000_000_000_000 + seed.below(1_000_000_000)),
    mtimeNs: String(1_700_000_000_000_000_000 + seed.below(1_000_000_000)),
    ctimeNs: String(1_700_000_000_000_000_000 + seed.below(1_000_000_000)),
    xattrs,
  };
}

export function fileEntry(path: string, bytes: Uint8Array, ino: number, metadata: PosixMetadata): NodeEntry {
  return { path, kind: 'file', mode: 0o644, ino, metadata, content: { kind: 'dense', bytes } };
}

export function dirEntry(path: string, ino: number, metadata: PosixMetadata, mode = 0o755): NodeEntry {
  return { path, kind: 'dir', mode, ino, metadata };
}

export function symlinkEntry(path: string, target: string, ino: number, metadata: PosixMetadata): NodeEntry {
  return { path, kind: 'symlink', mode: 0o777, ino, metadata, target };
}

/** Canonical base64 of a text xattr value, the encoding the capture model requires. */
export function xattrValue(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/** Converts a path-to-text record into a complete tree: every ancestor is a directory row,
 *  every file is dense, inodes are distinct. */
export function textTree(rows: Record<string, string>, seed = new Seeded(7)): NodeEntry[] {
  const entries = new Map<string, NodeEntry>();
  let ino = 1;
  const encoder = new TextEncoder();

  for (const [path, text] of Object.entries(rows).sort(([a], [b]) => (a < b ? -1 : 1))) {
    for (const ancestor of ancestorsOf(path)) {
      if (!entries.has(ancestor)) entries.set(ancestor, dirEntry(ancestor, ino++, metadataOf(seed)));
    }

    entries.set(path, fileEntry(path, encoder.encode(text), ino++, metadataOf(seed)));
  }

  return sortedByPath([...entries.values()]);
}

export interface GeneratedTreeSpec {
  readonly seed: number;
  readonly files: number;
  readonly bytesPerFile: number;
  /** Files per directory before a new sibling directory is opened. */
  readonly fanout?: number;
}

export function generatedTree(spec: GeneratedTreeSpec): NodeEntry[] {
  const seed = new Seeded(spec.seed);
  const fanout = spec.fanout ?? 64;
  const entries: NodeEntry[] = [];
  let ino = 1;
  const dirs = new Set<string>();

  const ensureDir = (path: string): void => {
    if (dirs.has(path)) return;

    for (const ancestor of ancestorsOf(`${path}/x`)) {
      if (dirs.has(ancestor)) continue;
      dirs.add(ancestor);
      entries.push(dirEntry(ancestor, ino++, metadataOf(seed)));
    }
  };

  for (let index = 0; index < spec.files; index += 1) {
    const bucket = Math.floor(index / fanout);
    const dir = `d${String(Math.floor(bucket / fanout)).padStart(3, '0')}/d${String(bucket % fanout).padStart(3, '0')}`;
    ensureDir(dir);
    const bytes = seed.fill(new Uint8Array(spec.bytesPerFile));
    entries.push(fileEntry(`${dir}/f${String(index).padStart(6, '0')}.bin`, bytes, ino++, metadataOf(seed)));
  }

  return sortedByPath(entries);
}

/** The full-fidelity fixture: every property the byte-for-byte cell compares,
 *  present at least once, with values a lossy restore would change. */
export function fidelityTree(seedValue = 11): NodeEntry[] {
  const seed = new Seeded(seedValue);
  const encoder = new TextEncoder();
  const shared = seed.fill(new Uint8Array(3000));
  const sparseRun = seed.fill(new Uint8Array(4096));

  const entries: NodeEntry[] = [
    dirEntry('src', 1, metadataOf(seed, { 'user.origin': xattrValue('generated') })),
    dirEntry('src/deep', 2, metadataOf(seed), 0o700),
    { ...fileEntry('src/main.txt', encoder.encode('export const one = 1;\n'), 3, metadataOf(seed)), mode: 0o600 },
    { ...fileEntry('src/deep/script.sh', encoder.encode('#!/bin/sh\necho hi\n'), 4, metadataOf(seed, {
      'user.mime': xattrValue('text/x-shellscript'),
      'security.selinux': xattrValue('unconfined_u:object_r:user_home_t:s0'),
    })), mode: 0o755 },
    // One inode, two names: a restore that copies them apart changes the partition, not bytes.
    fileEntry('src/shared.bin', shared, 5, metadataOf(seed)),
    fileEntry('src/deep/alias.bin', shared, 5, metadataOf(seed)),
    symlinkEntry('src/link', 'deep/script.sh', 6, metadataOf(seed)),
    symlinkEntry('src/dangling', '../nowhere/at/all', 7, metadataOf(seed)),
    // A HOLE ON BOTH SIDES OF ONE RUN: the geometry a dense restore erases.
    {
      path: 'src/sparse.img',
      kind: 'file',
      mode: 0o644,
      ino: 8,
      metadata: metadataOf(seed),
      content: { kind: 'sparse', size: 1 << 20, runs: [{ offset: 512 * 1024, bytes: sparseRun }] },
    },
    fileEntry('src/empty.txt', new Uint8Array(0), 9, metadataOf(seed)),
  ];

  // The two hardlink names must carry ONE metadata row, as one inode does.
  const linkMetadata = entries[4].metadata;
  entries[5] = { ...entries[5], metadata: linkMetadata };

  return sortedByPath(entries);
}

export function gigabyteTree(seedValue = 13, denseBytes = 64 * 1024 * 1024): NodeEntry[] {
  const seed = new Seeded(seedValue);
  const dataRun = seed.fill(new Uint8Array(1024 * 1024));
  const dense = seed.fill(new Uint8Array(denseBytes));

  return sortedByPath([
    dirEntry('vol', 1, metadataOf(seed)),
    {
      path: 'vol/disk.img',
      kind: 'file',
      mode: 0o644,
      ino: 2,
      metadata: metadataOf(seed),
      content: { kind: 'sparse', size: 1024 * 1024 * 1024, runs: [{ offset: 700 * 1024 * 1024, bytes: dataRun }] },
    },
    fileEntry('vol/dense.bin', dense, 3, metadataOf(seed)),
  ]);
}

export function sortedByPath(entries: readonly NodeEntry[]): NodeEntry[] {
  return [...entries].sort((a, b) => (a.path < b.path ? -1 : Number(a.path > b.path)));
}

/** The directories `mkdir -p` makes for `path`, shallowest first, found by walking `dirname` up
 *  rather than by splitting, so the model never shares the product's derivation. */
export function ancestorsOf(path: string): string[] {
  const out: string[] = [];

  for (let dir = posix.dirname(path); dir !== '.' && dir !== '/'; dir = posix.dirname(dir)) out.unshift(dir);

  return out;
}

const ZEROS = new Uint8Array(1024 * 1024);

export function logicalDigest(content: FileContent): string {
  const hash = createHash('sha256');

  for (const segment of paintedSegments(content).segments) {
    if (!segment.zeros) {
      hash.update(segment.view);
      continue;
    }

    for (let left = segment.end - segment.start; left > 0; left -= ZEROS.byteLength) {
      hash.update(ZEROS.subarray(0, Math.min(left, ZEROS.byteLength)));
    }
  }

  return hash.digest('hex');
}

export function holesOf(content: FileContent): readonly [number, number][] {
  return paintedSegments(content).segments
    .filter((segment) => segment.zeros)
    .map((segment) => [segment.start, segment.end]);
}

/** Bytes a tree really holds: dense bytes plus sparse run bytes, holes free. */
export function heldBytes(entries: readonly NodeEntry[]): number {
  let total = 0;
  const seen = new Set<number>();

  for (const entry of entries) {
    if (entry.kind !== 'file' || entry.content === undefined || seen.has(entry.ino)) continue;
    seen.add(entry.ino);
    total += runBytes(entry.content);
  }

  return total;
}

export function runBytes(content: FileContent): number {
  if (content.kind === 'dense') return content.bytes.byteLength;

  return content.runs.reduce((sum, run) => sum + run.bytes.byteLength, 0);
}

function runBytesOfRuns(runs: readonly SparseRun[]): number {
  let total = 0;

  for (const run of runs) total += run.bytes.byteLength;

  return total;
}

/** Merges overlaps so a re-read range is held once: disk charge sums run lengths,
 *  so a duplicate run would charge bytes the file does not have. */
function mergeRuns(runs: readonly SparseRun[]): SparseRun[] {
  const painted: { offset: number; bytes: Uint8Array }[] = [];

  for (const run of [...runs].sort((a, b) => a.offset - b.offset)) {
    if (run.bytes.byteLength === 0) continue;
    const last = painted[painted.length - 1];
    const end = run.offset + run.bytes.byteLength;

    if (last === undefined || run.offset > last.offset + last.bytes.byteLength) {
      painted.push({ offset: run.offset, bytes: run.bytes.slice() });
      continue;
    }

    const lastEnd = last.offset + last.bytes.byteLength;

    if (end <= lastEnd) {
      last.bytes.set(run.bytes, run.offset - last.offset);
      continue;
    }

    const grown = new Uint8Array(end - last.offset);
    grown.set(last.bytes);
    grown.set(run.bytes, run.offset - last.offset);
    painted[painted.length - 1] = { offset: last.offset, bytes: grown };
  }

  return painted;
}

/** One inode, shared by every hardlinked path. Mutable: a write lands here. */
export interface LiveInode {
  readonly kind: 'file' | 'dir' | 'symlink';
  mode: number;
  metadata: PosixMetadata;
  target?: string;
  content?: FileContent;
}

/** Two paths may share ONE inode (a hardlink); every byte landed is charged, every release refunded.
 *  A refused `charge` (ENOSPC) leaves the tree exactly as it was. */
export class LiveTree {
  readonly #paths = new Map<string, LiveInode>();
  readonly #inos = new Map<LiveInode, number>();
  #nextIno = 1;

  constructor(
    private readonly charge: (delta: number) => void = () => undefined,
  ) {}

  get size(): number {
    return this.#paths.size;
  }

  paths(): string[] {
    return [...this.#paths.keys()].sort();
  }

  filePaths(): string[] {
    return [...this.#paths].filter(([, inode]) => inode.kind === 'file').map(([path]) => path).sort();
  }

  node(path: string): LiveInode | undefined {
    return this.#paths.get(path);
  }

  has(path: string): boolean {
    return this.#paths.has(path);
  }

  bytesHeld(): number {
    let total = 0;

    for (const inode of new Set(this.#paths.values())) {
      if (inode.content !== undefined) total += runBytes(inode.content);
    }

    return total;
  }

  /** Entries sharing an `ino` share one inode (hardlinks); existing paths are replaced.
   *  A missing ancestor becomes a directory; every byte is charged before it lands. */
  plant(entries: readonly NodeEntry[]): void {
    const byIno = new Map<number, LiveInode>();

    for (const entry of sortedByPath(entries)) {
      const slash = entry.path.lastIndexOf('/');

      if (slash > 0) this.mkdirp(entry.path.slice(0, slash));
      const existing = byIno.get(entry.ino);

      if (existing !== undefined) {
        this.#place(entry.path, existing);
        continue;
      }

      const inode: LiveInode = {
        kind: entry.kind,
        mode: entry.mode,
        metadata: cloneMetadata(entry.metadata ?? DEFAULT_METADATA),
      };

      if (entry.kind === 'symlink') inode.target = entry.target;

      if (entry.kind === 'file') {
        const content = cloneContent(entry.content ?? { kind: 'dense', bytes: new Uint8Array(0) });
        this.charge(runBytes(content));
        inode.content = content;
      }

      byIno.set(entry.ino, inode);
      this.#place(entry.path, inode);
    }
  }

  mkdirp(path: string): void {
    for (const step of [...ancestorsOf(path), path]) {
      if (!this.#paths.has(step)) {
        this.#place(step, { kind: 'dir', mode: 0o755, metadata: cloneMetadata(DEFAULT_METADATA) });
      }
    }
  }

  /** A write advances mtime one tick, as the kernel would, so a metadata-only change detector
   *  sees it; `plant` alone sets times verbatim. */
  writeFile(path: string, bytes: Uint8Array, metadata?: PosixMetadata, mode = 0o644): void {
    const slash = path.lastIndexOf('/');

    if (slash > 0) this.mkdirp(path.slice(0, slash));
    const held = this.#paths.get(path);

    if (held !== undefined && held.kind === 'file' && held.content !== undefined) {
      // An in-place rewrite of a hardlinked file is seen by every name.
      this.charge(bytes.byteLength - runBytes(held.content));
      held.content = { kind: 'dense', bytes: bytes.slice() };
      held.metadata = metadata === undefined ? touched(held.metadata) : cloneMetadata(metadata);
      held.mode = mode;

      return;
    }

    this.charge(bytes.byteLength);
    this.#place(path, {
      kind: 'file',
      mode,
      metadata: cloneMetadata(metadata ?? DEFAULT_METADATA),
      content: { kind: 'dense', bytes: bytes.slice() },
    });
  }

  /** `pwrite(2)` semantics: sparse geometry outside the written window is preserved;
   *  a sparse file gains one run. Past-EOF writes extend the file. */
  pwrite(path: string, offset: number, bytes: Uint8Array): void {
    const inode = this.#paths.get(path);

    if (inode === undefined || inode.kind !== 'file' || inode.content === undefined) {
      throw new Error(`pwrite: no file at ${path}`);
    }

    const content = inode.content;

    if (content.kind === 'dense') {
      const end = offset + bytes.byteLength;

      if (end > content.bytes.byteLength) {
        this.charge(end - content.bytes.byteLength);
        const grown = new Uint8Array(end);
        grown.set(content.bytes);
        grown.set(bytes, offset);
        inode.content = { kind: 'dense', bytes: grown };
      } else {
        content.bytes.set(bytes, offset);
      }
    } else {
      this.charge(bytes.byteLength);
      inode.content = {
        kind: 'sparse',
        size: Math.max(content.size, offset + bytes.byteLength),
        runs: [...content.runs, { offset, bytes: bytes.slice() }],
      };
    }

    inode.metadata = touched(inode.metadata);
  }

  /** Extending leaves a hole, not written zeros, as the kernel's `truncate(2)` does. */
  truncate(path: string, size: number): void {
    const inode = this.#paths.get(path);

    if (inode === undefined || inode.kind !== 'file' || inode.content === undefined) {
      throw new Error(`truncate: no file at ${path}`);
    }

    const content = inode.content;
    const held = contentSize(content);

    if (size === held) return;

    if (content.kind === 'dense' && size < held) {
      this.charge(size - held);
      inode.content = { kind: 'dense', bytes: content.bytes.slice(0, size) };
    } else {
      const runs = content.kind === 'dense' ? [{ offset: 0, bytes: content.bytes }] : content.runs;
      const kept: SparseRun[] = [];

      for (const run of runs) {
        if (run.offset >= size) continue;
        kept.push(run.offset + run.bytes.byteLength <= size ? run : { offset: run.offset, bytes: run.bytes.subarray(0, size - run.offset) });
      }

      this.charge(runBytesOfRuns(kept) - runBytes(content));
      inode.content = { kind: 'sparse', size, runs: kept };
    }

    inode.metadata = touched(inode.metadata);
  }

  /** Page-in for a lazy restore, not a write: mtime and metadata stay untouched so a
   *  metadata comparison after a lazy wake sees exactly what a publish wrote. */
  hydrate(path: string, offset: number, bytes: Uint8Array): void {
    const inode = this.#paths.get(path);

    if (inode === undefined || inode.kind !== 'file' || inode.content === undefined) {
      throw new Error(`hydrate: no file at ${path}`);
    }

    const content = inode.content;

    if (content.kind === 'dense') {
      if (offset + bytes.byteLength > content.bytes.byteLength) {
        throw new Error(`hydrate: ${path} is ${content.bytes.byteLength} bytes, page ends at ${offset + bytes.byteLength}`);
      }

      content.bytes.set(bytes, offset);

      return;
    }

    const merged = mergeRuns([...content.runs, { offset, bytes: bytes.slice() }]);
    this.charge(runBytesOfRuns(merged) - runBytes(content));
    inode.content = { kind: 'sparse', size: content.size, runs: merged };
  }

  /** The file keeps its length and reads as zeros in the range until paged back in,
   *  which models an evicted page. */
  dehydrate(path: string, offset: number, length: number): void {
    const inode = this.#paths.get(path);

    if (inode === undefined || inode.kind !== 'file' || inode.content === undefined) {
      throw new Error(`dehydrate: no file at ${path}`);
    }

    const content = inode.content;
    const size = contentSize(content);

    const runs = content.kind === 'dense'
      ? [{ offset: 0, bytes: content.bytes }]
      : [...content.runs];

    const kept: SparseRun[] = [];
    const end = offset + length;

    for (const run of runs) {
      const runEnd = run.offset + run.bytes.byteLength;

      if (runEnd <= offset || run.offset >= end) {
        kept.push(run);
        continue;
      }

      if (run.offset < offset) kept.push({ offset: run.offset, bytes: run.bytes.subarray(0, offset - run.offset) });

      if (runEnd > end) kept.push({ offset: end, bytes: run.bytes.subarray(end - run.offset) });
    }

    this.charge(runBytesOfRuns(kept) - runBytes(content));
    inode.content = { kind: 'sparse', size, runs: kept };
  }

  /** A restore does this when the head gives two paths the same inode id and it meets them
   *  separately. */
  link(existing: string, path: string): void {
    const inode = this.#paths.get(existing);

    if (inode === undefined) throw new Error(`link: no node at ${existing}`);
    this.#place(path, inode);
  }

  /** `rename(2)`: `from` and everything beneath it takes the name `to`, the
   *  inodes unchanged, so a write before the rename still names them. */
  rename(from: string, to: string): void {
    const moved = [...this.#paths].filter(([path]) => path === from || path.startsWith(`${from}/`));

    if (moved.length === 0) throw new Error(`rename: no node at ${from}`);

    for (const [path] of moved) this.#paths.delete(path);

    for (const [path, inode] of moved) this.#place(`${to}${path.slice(from.length)}`, inode);
  }

  /** The inode number of the node at `path`, as the daemon indexes it: given
   *  once per inode when first asked for, and never given twice. */
  ino(path: string): number {
    const inode = this.#paths.get(path);

    if (inode === undefined) throw new Error(`ino: no node at ${path}`);

    return this.#inoOf(inode);
  }

  remove(path: string): void {
    const inode = this.#paths.get(path);

    if (inode === undefined) return;
    this.#paths.delete(path);

    if (inode.kind === 'dir') {
      for (const child of this.#paths.keys()) {
        if (child.startsWith(`${path}/`)) this.remove(child);
      }
    }

    this.#release(inode);
  }

  clear(): void {
    for (const inode of new Set(this.#paths.values())) {
      if (inode.content !== undefined) this.charge(-runBytes(inode.content));
    }

    this.#paths.clear();
    this.#inos.clear();
  }

  /** Inode ids share exactly where live inodes share (hard links).
   *  Content is shared by reference: a snapshot is read, never written. */
  snapshot(): NodeEntry[] {
    const out: NodeEntry[] = [];

    for (const [path, inode] of [...this.#paths].sort(([a], [b]) => (a < b ? -1 : Number(a > b)))) {
      const base = { path, mode: inode.mode, ino: this.#inoOf(inode), metadata: cloneMetadata(inode.metadata) };

      if (inode.kind === 'symlink') out.push({ ...base, kind: 'symlink', target: inode.target });
      else if (inode.kind === 'file') out.push({ ...base, kind: 'file', content: inode.content });
      else out.push({ ...base, kind: 'dir' });
    }

    return out;
  }

  #place(path: string, inode: LiveInode): void {
    const previous = this.#paths.get(path);
    this.#paths.set(path, inode);

    if (previous !== undefined && previous !== inode) this.#release(previous);
  }

  /** Refund an inode's bytes once no path names it. */
  #release(inode: LiveInode): void {
    for (const held of this.#paths.values()) if (held === inode) return;

    if (inode.content !== undefined) this.charge(-runBytes(inode.content));
    this.#inos.delete(inode);
  }

  #inoOf(inode: LiveInode): number {
    let ino = this.#inos.get(inode);

    if (ino === undefined) {
      ino = this.#nextIno++;
      this.#inos.set(inode, ino);
    }

    return ino;
  }
}

const DEFAULT_METADATA: PosixMetadata = {
  uid: 1000, gid: 1000, atimeNs: '1', mtimeNs: '2', ctimeNs: '3', xattrs: {},
};

export function cloneMetadata(metadata: PosixMetadata): PosixMetadata {
  return { ...metadata, xattrs: { ...metadata.xattrs } };
}

/** The model has no clock: a write advances mtime and ctime one nanosecond past the old mtime. */
function touched(metadata: PosixMetadata): PosixMetadata {
  const next = String(BigInt(metadata.mtimeNs) + 1n);

  return { ...metadata, mtimeNs: next, ctimeNs: next, xattrs: { ...metadata.xattrs } };
}

export function cloneContent(content: FileContent): FileContent {
  if (content.kind === 'dense') return { kind: 'dense', bytes: content.bytes.slice() };

  return { kind: 'sparse', size: content.size, runs: content.runs.map((run) => ({ offset: run.offset, bytes: run.bytes.slice() })) };
}

/** Properties a restore can lose. `paths` is the name/kind set; the rest are per-entry facts.
 *  An arm declares the ones its format does not carry; the cell compares every other one. */
export const TREE_PROPERTIES = [
  'paths', 'bytes', 'mode', 'owner', 'times', 'xattrs', 'symlink', 'hardlink', 'sparse',
] as const;

export type TreeProperty = (typeof TREE_PROPERTIES)[number];

export interface TreeMismatch {
  readonly property: TreeProperty;
  readonly path: string;
  readonly detail: string;
}

/** Inode NUMBERS are never compared, since no restore keeps them; only their PARTITION is:
 *  which paths share one. */
export function compareTrees(
  expected: readonly NodeEntry[],
  served: readonly NodeEntry[],
  refused: ReadonlySet<TreeProperty> = new Set(),
): TreeMismatch[] {
  const mismatches: TreeMismatch[] = [];
  const want = new Map(expected.map((entry) => [entry.path, entry]));
  const have = new Map(served.map((entry) => [entry.path, entry]));

  const check = (property: TreeProperty, path: string, detail: string | null): void => {
    if (detail !== null && !refused.has(property)) mismatches.push({ property, path, detail });
  };

  for (const [path, a] of [...want].sort(([x], [y]) => (x < y ? -1 : Number(x > y)))) {
    const b = have.get(path);

    if (b === undefined) {
      check('paths', path, 'absent after restore');
      continue;
    }

    if (a.kind !== b.kind) {
      check('paths', path, `kind ${a.kind} became ${b.kind}`);
      continue;
    }

    check('mode', path, a.mode === b.mode ? null : `mode ${a.mode.toString(8)} became ${b.mode.toString(8)}`);
    const am = a.metadata;
    const bm = b.metadata;

    if (am !== undefined) {
      if (bm === undefined) {
        check('owner', path, 'metadata absent after restore');
      } else {
        check('owner', path, am.uid === bm.uid && am.gid === bm.gid ? null : `owner ${am.uid}:${am.gid} became ${bm.uid}:${bm.gid}`);
        check('times', path, am.mtimeNs === bm.mtimeNs && am.atimeNs === bm.atimeNs && am.ctimeNs === bm.ctimeNs
          ? null
          : `times ${am.atimeNs}/${am.mtimeNs}/${am.ctimeNs} became ${bm.atimeNs}/${bm.mtimeNs}/${bm.ctimeNs}`);
        check('xattrs', path, sameXattrs(am.xattrs, bm.xattrs) ? null : `xattrs ${JSON.stringify(am.xattrs)} became ${JSON.stringify(bm.xattrs)}`);
      }
    }

    if (a.kind === 'symlink') {
      check('symlink', path, a.target === b.target ? null : `target ${a.target} became ${b.target}`);
    }

    if (a.kind === 'file' && a.content !== undefined) {
      if (b.content === undefined) {
        check('bytes', path, 'no content after restore');
      } else {
        const sizeA = contentSize(a.content);
        const sizeB = contentSize(b.content);
        check('bytes', path, sizeA === sizeB && logicalDigest(a.content) === logicalDigest(b.content)
          ? null
          : `logical bytes differ (size ${sizeA} vs ${sizeB})`);
        const holesA = JSON.stringify(holesOf(a.content));
        const holesB = JSON.stringify(holesOf(b.content));
        check('sparse', path, holesA === holesB ? null : `holes ${holesA} became ${holesB}`);
      }
    }
  }

  for (const path of [...have.keys()].sort()) {
    if (!want.has(path)) check('paths', path, 'present after restore, never written');
  }

  const groups = (entries: readonly NodeEntry[]): string => {
    const byIno = new Map<number, string[]>();

    for (const entry of entries) {
      if (entry.kind !== 'file') continue;
      const members = byIno.get(entry.ino) ?? [];
      members.push(entry.path);
      byIno.set(entry.ino, members);
    }

    return [...byIno.values()]
      .filter((members) => members.length > 1)
      .map((members) => members.sort().join('='))
      .sort()
      .join(' ');
  };

  const wantGroups = groups(expected);
  const haveGroups = groups(served);
  check('hardlink', '*', wantGroups === haveGroups ? null : `link groups [${wantGroups}] became [${haveGroups}]`);

  return mismatches;
}

/** Canonical bytes make dense and sparse-but-byte-equal files identical, so sparse geometry
 *  stays a separate check in {@link compareTrees}. */
export function canonicalTreeBytes(
  entries: readonly NodeEntry[],
  refused: ReadonlySet<TreeProperty> = new Set(),
): Uint8Array {
  const normalizedIno = new Map<number, number>();
  let nextIno = 1;

  const rows = sortedByPath(entries).map((entry) => {
    let ino: number;

    if (refused.has('hardlink')) ino = nextIno++;
    else {
      const seen = normalizedIno.get(entry.ino);

      if (seen === undefined) {
        ino = nextIno++;
        normalizedIno.set(entry.ino, ino);
      } else ino = seen;
    }

    const source = entry.metadata ?? DEFAULT_METADATA;

    const row: ManifestRow = {
      path: entry.path,
      kind: entry.kind,
      mode: refused.has('mode') ? 0 : entry.mode,
      ino,
      metadata: {
        uid: refused.has('owner') ? 0 : source.uid,
        gid: refused.has('owner') ? 0 : source.gid,
        atimeNs: refused.has('times') ? '0' : source.atimeNs,
        mtimeNs: refused.has('times') ? '0' : source.mtimeNs,
        ctimeNs: refused.has('times') ? '0' : source.ctimeNs,
        xattrs: refused.has('xattrs')
          ? {}
          : Object.fromEntries(Object.entries(source.xattrs).sort(([a], [b]) => a.localeCompare(b))),
      },
    };

    if (entry.kind === 'symlink') row.target = refused.has('symlink') ? '' : entry.target;

    if (entry.content !== undefined) {
      row.sha256 = logicalDigest(entry.content);
      row.size = contentSize(entry.content);
    }

    return row;
  });

  return new TextEncoder().encode(`${JSON.stringify({ entries: rows })}\n`);
}

function sameXattrs(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const names = Object.keys(a);

  return names.length === Object.keys(b).length && names.every((name) => a[name] === b[name]);
}

export function describeMismatches(mismatches: readonly TreeMismatch[]): string {
  return mismatches.map((row) => `${row.property}@${row.path}: ${row.detail}`).join('; ');
}
