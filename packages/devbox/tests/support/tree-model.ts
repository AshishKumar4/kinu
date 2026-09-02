/**
 * Trees for the conformance battery: generated, held live, and compared.
 *
 * WHY A SECOND TREE MODEL BESIDE `capture/model.ts`. The capture model is a
 * LOG — `MutationLog` exists to prove that a capture equals one prefix of a
 * mutation sequence — and what an arm serves is not a log but a state: a set
 * of paths, each with bytes, a mode, an owner, times, xattrs, a symlink target
 * or an inode shared with another path. The battery needs to WRITE such a
 * state into an arm's workspace, read the state the arm serves after a wake,
 * and say WHICH PROPERTY differs. So this module holds a live tree as the
 * capture model's own `NodeEntry` rows (the shipped shape every codec consumes,
 * never a third vocabulary), generates trees from a seed so a 1e5-file tree is
 * a number rather than a fixture file, and compares two trees property by
 * property so a restore that split a hardlink, filled a hole or dropped an
 * xattr is named by that word.
 *
 * SPARSE FILES ARE NEVER EXPANDED HERE. A 1 GiB file with 1 MiB of data is
 * held as its runs, digested over its runs, and compared over its runs; the
 * zeros between them are arithmetic. That is what lets the 1 GiB cell run
 * in-process in a few MiB.
 */

import { createHash } from 'node:crypto';

import { paintedSegments } from '../../src/candidates/merkle-pack/chunk';
import {
  canonicalManifestBytes,
  contentSize,
  type Capture,
  type FileContent,
  type NodeEntry,
  type PosixMetadata,
} from '../../src/capture/model';

/** A seeded generator: the same seed gives the same tree on every run. */
export class Seeded {
  #state: number;

  constructor(seed: number) {
    this.#state = (seed >>> 0) || 0x9e3779b9;
  }

  /** One 32-bit draw (xorshift32). */
  next(): number {
    let x = this.#state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.#state = x >>> 0;
    return this.#state;
  }

  /** An integer in `[0, bound)`. */
  below(bound: number): number {
    return this.next() % bound;
  }

  /** Fill `bytes` with pseudo-random content, four bytes per draw. */
  fill(bytes: Uint8Array): Uint8Array {
    const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >>> 2);
    for (let at = 0; at < words.length; at += 1) words[at] = this.next();
    for (let at = words.length << 2; at < bytes.byteLength; at += 1) bytes[at] = this.next() & 0xff;
    return bytes;
  }
}

// ── entries ─────────────────────────────────────────────────────────────────

/** The metadata every generated entry carries: real values, never zeros, so a
 *  restore that zeroes a field cannot pass by matching a zero fixture. */
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

/** A dense file entry. */
export function fileEntry(
  path: string,
  bytes: Uint8Array,
  ino: number,
  metadata: PosixMetadata,
  mode = 0o644,
): NodeEntry {
  return { path, kind: 'file', mode, ino, metadata, content: { kind: 'dense', bytes } };
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

/** A path-to-text record as a complete tree of entries: every ancestor is a
 *  directory row, every file is dense, inodes are distinct. Text fixtures stay
 *  text; this is how they enter a full-fidelity workspace. */
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
  /** Bytes per file; every file gets exactly this many pseudo-random bytes. */
  readonly bytesPerFile: number;
  /** Files per directory before a new sibling directory is opened. */
  readonly fanout?: number;
}

/**
 * A generated tree: `files` dense files of `bytesPerFile` bytes under a
 * balanced directory layout, names and bytes from `seed`. Two calls with the
 * same spec produce byte-identical trees.
 */
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

/**
 * The full-fidelity fixture: every property the byte-for-byte cell compares,
 * present at least once, with values a lossy restore would change.
 */
export function fidelityTree(seedValue = 11): NodeEntry[] {
  const seed = new Seeded(seedValue);
  const encoder = new TextEncoder();
  const shared = seed.fill(new Uint8Array(3000));
  const sparseRun = seed.fill(new Uint8Array(4096));
  const entries: NodeEntry[] = [
    dirEntry('src', 1, metadataOf(seed, { 'user.origin': xattrValue('generated') })),
    dirEntry('src/deep', 2, metadataOf(seed), 0o700),
    fileEntry('src/main.txt', encoder.encode('export const one = 1;\n'), 3, metadataOf(seed), 0o600),
    fileEntry('src/deep/script.sh', encoder.encode('#!/bin/sh\necho hi\n'), 4, metadataOf(seed, {
      'user.mime': xattrValue('text/x-shellscript'),
      'security.selinux': xattrValue('unconfined_u:object_r:user_home_t:s0'),
    }), 0o755),
    // ONE INODE, TWO NAMES: a restore that copies them apart changes the
    // partition, not the bytes.
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
  const linkMetadata = entries[4]!.metadata;
  entries[5] = { ...entries[5]!, metadata: linkMetadata };
  return sortedByPath(entries);
}

/** One 1 GiB sparse file with 1 MiB of data and one 64 MiB dense file. */
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
  return [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function ancestorsOf(path: string): string[] {
  const parts = path.split('/');
  const out: string[] = [];
  for (let depth = 1; depth < parts.length; depth += 1) out.push(parts.slice(0, depth).join('/'));
  return out;
}

/** Logical bytes of a file entry, for text comparison; small files only. */
export function textOf(entry: NodeEntry): string | undefined {
  if (entry.kind !== 'file' || entry.content === undefined) return undefined;
  return new TextDecoder().decode(expandSmall(entry.content));
}

function expandSmall(content: FileContent): Uint8Array {
  if (content.kind === 'dense') return content.bytes;
  if (content.kind === 'sealed') throw new Error('sealed content is not held by this tree model');
  if (content.size > 64 * 1024 * 1024) throw new Error(`refusing to expand ${content.size} sparse bytes`);
  const out = new Uint8Array(content.size);
  for (const run of content.runs) out.set(run.bytes.subarray(0, Math.max(0, content.size - run.offset)), run.offset);
  return out;
}

// ── digests over logical bytes, holes arithmetic ────────────────────────────

const ZEROS = new Uint8Array(1024 * 1024);

/** sha256 of the logical bytes, hashing holes from one shared zero buffer. */
export function logicalDigest(content: FileContent): string {
  const hash = createHash('sha256');
  for (const segment of paintedSegments(content).segments) {
    if (!segment.zeros) {
      hash.update(segment.view!);
      continue;
    }
    for (let left = segment.end - segment.start; left > 0; left -= ZEROS.byteLength) {
      hash.update(ZEROS.subarray(0, Math.min(left, ZEROS.byteLength)));
    }
  }
  return hash.digest('hex');
}

/** The hole geometry: `[start, end)` of every all-zero segment, in order. */
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
  if (content.kind === 'sealed') return 0;
  return content.runs.reduce((sum, run) => sum + run.bytes.byteLength, 0);
}

// ── the live tree ───────────────────────────────────────────────────────────

/** One inode, shared by every hardlinked path. Mutable: a write lands here. */
export interface LiveInode {
  readonly kind: 'file' | 'dir' | 'symlink';
  mode: number;
  metadata: PosixMetadata;
  target?: string;
  content?: FileContent;
}

/**
 * A live filesystem tree at full fidelity, as a container holds one.
 *
 * Paths map to inodes; two paths may map to ONE inode, which is a hardlink.
 * `charge` is the disk budget hook: every byte that lands is charged and every
 * byte released is refunded, and a charge that refuses (ENOSPC) leaves the
 * tree exactly as it was — the effect never happens without the room for it.
 */
export class LiveTree {
  readonly #paths = new Map<string, LiveInode>();
  readonly #inos = new Map<LiveInode, number>();
  #nextIno = 1;

  constructor(
    /** Charge `delta` bytes against the disk; throws to refuse. */
    private readonly charge: (delta: number) => void = () => undefined,
  ) {}

  get size(): number {
    return this.#paths.size;
  }

  paths(): string[] {
    return [...this.#paths.keys()].sort();
  }

  /** File paths only, sorted: the listing the text workspace exposes. */
  filePaths(): string[] {
    return this.paths().filter((path) => this.#paths.get(path)!.kind === 'file');
  }

  node(path: string): LiveInode | undefined {
    return this.#paths.get(path);
  }

  has(path: string): boolean {
    return this.#paths.has(path);
  }

  /** Bytes charged to the disk for this tree's content. */
  bytesHeld(): number {
    let total = 0;
    for (const inode of new Set(this.#paths.values())) {
      if (inode.content !== undefined) total += runBytes(inode.content);
    }
    return total;
  }

  /**
   * Plant a complete tree: directories, files, symlinks, hardlinks (entries
   * sharing an `ino` share one inode), sparse content as runs. Existing paths
   * are replaced. Charges every byte before it lands.
   */
  plant(entries: readonly NodeEntry[]): void {
    const byIno = new Map<number, LiveInode>();
    for (const entry of sortedByPath(entries)) {
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

  /** Write dense bytes at `path`, creating ancestors as directories. A write
   *  advances mtime by one tick, as the kernel would, so a metadata-only
   *  change detector sees it; `plant` alone sets times verbatim. */
  writeFile(path: string, bytes: Uint8Array, metadata?: PosixMetadata, mode = 0o644): void {
    for (const ancestor of ancestorsOf(path)) {
      if (!this.#paths.has(ancestor)) {
        this.#place(ancestor, { kind: 'dir', mode: 0o755, metadata: cloneMetadata(DEFAULT_METADATA) });
      }
    }
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

  /**
   * `pwrite(2)`: overwrite `bytes` at `offset` without changing the length or
   * the sparse geometry outside the written window. A dense file stays dense;
   * a sparse file gains one run. Past-EOF writes extend the file.
   */
  pwrite(path: string, offset: number, bytes: Uint8Array): void {
    const inode = this.#paths.get(path);
    if (inode === undefined || inode.kind !== 'file' || inode.content === undefined) {
      throw new Error(`pwrite: no file at ${path}`);
    }
    const content = inode.content;
    if (content.kind === 'sealed') throw new Error('pwrite: sealed content is not live');
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

  /** The tree as capture-model entries, with inode ids that share exactly
   *  where the live inodes share. Content is shared by reference: a snapshot
   *  is read, never written. */
  snapshot(): NodeEntry[] {
    const out: NodeEntry[] = [];
    for (const path of this.paths()) {
      const inode = this.#paths.get(path)!;
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

/** The metadata after a write: mtime and ctime one tick later. There is no
 *  clock in this model, so a tick is one nanosecond past the old value. */
function touched(metadata: PosixMetadata): PosixMetadata {
  const next = String(BigInt(metadata.mtimeNs) + 1n);
  return { ...metadata, mtimeNs: next, ctimeNs: next, xattrs: { ...metadata.xattrs } };
}

export function cloneContent(content: FileContent): FileContent {
  if (content.kind === 'dense') return { kind: 'dense', bytes: content.bytes.slice() };
  if (content.kind === 'sealed') return { ...content, extents: content.extents.map((extent) => ({ ...extent })) };
  return { kind: 'sparse', size: content.size, runs: content.runs.map((run) => ({ offset: run.offset, bytes: run.bytes.slice() })) };
}

// ── comparison ──────────────────────────────────────────────────────────────

/**
 * The properties a restore can lose, each named. `paths` is the set of names
 * and their kinds; the rest are per-entry facts. An arm declares the ones its
 * format does not carry; the cell compares every other one.
 */
export const TREE_PROPERTIES = [
  'paths', 'bytes', 'mode', 'owner', 'times', 'xattrs', 'symlink', 'hardlink', 'sparse',
] as const;
export type TreeProperty = (typeof TREE_PROPERTIES)[number];

export interface TreeMismatch {
  readonly property: TreeProperty;
  readonly path: string;
  readonly detail: string;
}

/**
 * Every property of `expected` that `served` does not reproduce, except the
 * ones in `refused`. Inode NUMBERS are never compared — no restore keeps
 * them — only their PARTITION: which paths share one.
 */
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
  for (const path of [...want.keys()].sort()) {
    const a = want.get(path)!;
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
  // The hardlink partition: the set of path-groups sharing an inode.
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

/**
 * Canonical manifest bytes for one served tree, with inode numbers normalized
 * to the hardlink partition and declared-refused fields neutralized. The
 * capture encoder is the product's own; {@link compareTrees} remains the
 * separate sparse-geometry check because canonical logical bytes deliberately
 * make a dense file and a sparse-but-byte-equal file the same.
 */
export function canonicalTreeBytes(
  entries: readonly NodeEntry[],
  refused: ReadonlySet<TreeProperty> = new Set(),
): Uint8Array {
  const normalizedIno = new Map<number, number>();
  let nextIno = 1;
  const normalized = sortedByPath(entries).map((entry): NodeEntry => {
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
    const metadata: PosixMetadata = {
      uid: refused.has('owner') ? 0 : source.uid,
      gid: refused.has('owner') ? 0 : source.gid,
      atimeNs: refused.has('times') ? '0' : source.atimeNs,
      mtimeNs: refused.has('times') ? '0' : source.mtimeNs,
      ctimeNs: refused.has('times') ? '0' : source.ctimeNs,
      xattrs: refused.has('xattrs') ? {} : { ...source.xattrs },
    };
    const row: NodeEntry = { ...entry, mode: refused.has('mode') ? 0 : entry.mode, ino, metadata };
    if (entry.kind === 'symlink' && refused.has('symlink')) return { ...row, target: '' };
    return row;
  });
  const capture: Capture = {
    mechanism: 'mutation-journal',
    cut: 1,
    generation: 1,
    entries: normalized,
  };
  return canonicalManifestBytes(capture);
}
function sameXattrs(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const names = Object.keys(a);
  return names.length === Object.keys(b).length && names.every((name) => a[name] === b[name]);
}

/** One line per mismatch, for an assertion message. */
export function describeMismatches(mismatches: readonly TreeMismatch[]): string {
  return mismatches.map((row) => `${row.property}@${row.path}: ${row.detail}`).join('; ');
}
