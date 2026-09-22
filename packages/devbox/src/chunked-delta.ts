/** One cumulative delta object: whole records under tree/, changed blocks under chunks/,
 *  and authenticated per-file indexes; a missing override reads base, a hole reads zeros. */

import { createHash } from 'node:crypto';
import * as v from 'valibot';
import { buildDeltaIndex, DELTA_BLOCK_BYTES, DELTA_INDEX_PAGE_BYTES, DeltaIndexRefSchema, lookupDeltaIndex, type DeltaIndexRef, type DeltaOverride } from './delta-index';

/** What the attach log says an upper was restored from; the bench reads served facts
 *  against this same vocabulary, so there is no second copy. */
export const CHAIN_SERVED_WORDS = {
  base: 'base',
  held: 'base+delta already in this upper',
  chunked: 'base+delta block-composed',
  layered: 'base+delta layered',
} as const;

export type ChainServedWord = (typeof CHAIN_SERVED_WORDS)[keyof typeof CHAIN_SERVED_WORDS];

export { DELTA_BLOCK_BYTES } from './delta-index';

/** Files below this size travel whole: a block map would cost more than
 *  their bytes. */
const DELTA_WHOLE_FILE_THRESHOLD = 64 * 1024;

/** A file more than half holes travels whole: block-hashing its zeros costs more than it saves,
 *  and a whole sparse file round-trips its exact hole geometry. */
const DELTA_SPARSE_WHOLE_FRACTION = 1 / 2;

/** Shell operations per container command. Bounds the round trips of a
 *  many-file checkpoint without changing what any operation does. */
export const DELTA_OPS_PER_COMMAND = 250;

/** Staged package layout, mirrored at materialize time. A workspace file collides only by
 *  living under `.devbox-delta` AND validating as a manifest. */
export const DELTA_MANIFEST_NAME = '.devbox-delta/manifest.json';

export const DELTA_TREE_DIR = '.devbox-delta/tree';

const DELTA_CHUNK_DIR = '.devbox-delta/chunks';

function shellPath(path: string): string {
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

function ancestorDirs(path: string): string[] {
  const parts = path.split('/');
  const out: string[] = [];

  for (let depth = 1; depth < parts.length; depth += 1) out.push(parts.slice(0, depth).join('/'));

  return out;
}

const Count = v.pipe(v.number(), v.safeInteger(), v.minValue(0));

const RelPath = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(4095),
  v.check((path) => !path.includes('\0') && path.split('/').every(part => part !== '' && part !== '.' && part !== '..' && Buffer.byteLength(part) <= 255),
    'a delta path is relative and stays inside the tree'),
);

const FileSchema = v.variant('kind', [
  v.object({ kind: v.literal('whole'), p: RelPath, s: Count }),
  v.object({
    kind: v.literal('chunked'), p: RelPath, s: Count, mode: Count, uid: Count, gid: Count,
    over: DeltaIndexRefSchema,
  }),
]);

const DirSchema = v.pipe(v.object({ p: v.union([RelPath, v.literal('')]), mode: Count, uid: Count, gid: Count,
  opaque: v.optional(v.boolean()) }), v.check(dir => dir.p !== '' || dir.opaque === true, 'a root directory record must be opaque'));

/** A store object is untrusted input even though this module wrote it. `treplace` paths
 *  crossed the dir/non-dir boundary and must be removed before planting. */
export const DeltaManifestSchema = v.object({
  v: v.literal(2),
  files: v.array(FileSchema),
  dirs: v.array(DirSchema),
  deleted: v.array(RelPath),
  treplace: v.array(RelPath),
  links: v.array(v.pipe(v.array(RelPath), v.minLength(2))),
});

export type DeltaManifest = v.InferOutput<typeof DeltaManifestSchema>;


export interface DeltaProbeEntry {
  readonly path: string;
  /** find's `%y`, with `o` for an opaque directory proved by the native probe. */
  readonly type: string;
  readonly ino: number;
  readonly nlink: number;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly size: number;
  readonly target: string;
}

/** `-prune` uses the same matcher as `archiveSizeCommand` so delta and base exclude alike.
 *  An empty upper prints `0 ` with no payload, distinct from a failed walk. */
export function deltaProbeCommand(upperDir: string, excludes: readonly string[]): string {
  const pruned: string[] = [];

  for (const normalized of excludes) {
    pruned.push(
      `-path ${shellPath(`${upperDir}/${normalized}`)} -prune -o`,
      `-path ${shellPath(`${upperDir}/*/${normalized}`)} -prune -o`,
    );
  }

  const walk = `find ${shellPath(upperDir)} ${pruned.join(' ')} -mindepth 1 `
    + `-printf '%y\\0%i\\0%n\\0%m\\0%U\\0%G\\0%s\\0%T@\\0%C@\\0%l\\0%P\\0' 2>/dev/null `
    + `| devbox-block-lower --probe-opaque ${shellPath(upperDir)} | base64 | tr -d '\\n'`;

  return `# devbox-probe-v1\nout=$(set -o pipefail; ${walk}); rc=$?; printf '%s %s' "$rc" "$out"`;
}

/** An unreadable opacity decision cannot become a legacy-format publication. */
export class DeltaNamespaceProbeFailed extends Error {
  constructor(code: string) {
    super(`opaque-directory namespace could not be observed (probe ${code})`);
    this.name = 'DeltaNamespaceProbeFailed';
  }
}

export function parseDeltaProbe(stdout: string): DeltaProbeEntry[] {
  const space = stdout.indexOf(' ');
  const rc = space === -1 ? stdout.trim() : stdout.slice(0, space);

  if (rc === '78' || rc === '127') throw new DeltaNamespaceProbeFailed(rc);

  if (rc !== '0') throw new Error(`the delta probe failed (${rc}): ${stdout.slice(0, 200)}`);
  const payload = space === -1 ? '' : stdout.slice(space + 1).trim();

  if (payload === '') return [];
  const fields = Buffer.from(payload, 'base64').toString('utf8').split('\0');

  // Every record ends in a separator, so the split leaves one empty tail.
  if (fields.length > 0 && fields[fields.length - 1] === '') fields.pop();
  const STRIDE = 11;

  if (fields.length % STRIDE !== 0) {
    throw new Error(`the delta probe holds ${fields.length} fields, not a multiple of ${STRIDE}`);
  }

  const records: DeltaProbeEntry[] = [];

  for (let at = 0; at < fields.length; at += STRIDE) {
    const field = (offset: number): string => fields[at + offset] ?? '';

    const numbers = {
      ino: Number(field(1)), nlink: Number(field(2)), uid: Number(field(4)), gid: Number(field(5)), size: Number(field(6)),
    };

    if (!Object.values(numbers).every(Number.isSafeInteger)) {
      throw new Error(`the delta probe holds a non-count at record ${records.length}`);
    }

    const mode = field(3);

    if (!/^[0-7]+$/.test(mode)) throw new Error(`the delta probe holds a non-mode at record ${records.length}`);
    const path = field(10);

    if ((path === '' && field(0) !== 'o') || path.startsWith('/') || path.split('/').includes('..')) {
      throw new Error(`the delta probe holds a hostile path at record ${records.length}`);
    }

    records.push({ path, type: field(0), ...numbers, mode: Number.parseInt(mode, 8), target: field(9) });
  }

  return records;
}

/** The sha256 of `length` zero bytes: how a hole block hashes. */
function zeroBlockDigest(length: number): string {
  return createHash('sha256').update(new Uint8Array(length)).digest('hex');
}

/** One `sha256sum` per side over `split` outputs, no per-block processes; `NOSPLIT` makes
 *  the caller carry big files whole. Splits are removed per file to bound the transient. */
export function deltaBlockHashCommand(input: {
  workDir: string;
  files: readonly { index: number; upperPath: string; basePath: string | null }[];
}): string {
  const lines = [
    '# devbox-blockhash-v1',
    `command -v split >/dev/null 2>&1 || { printf 'NOSPLIT\\n'; false; };`,
    `mkdir -p ${shellPath(input.workDir)}`,
  ];

  for (const file of input.files) {
    const u = `${input.workDir}/u${file.index}`;
    lines.push(
      `mkdir -p ${shellPath(u)}`,
      `split -b ${DELTA_BLOCK_BYTES} -a 4 ${shellPath(file.upperPath)} ${shellPath(`${u}/x`)} || false`,
      `printf 'USIDE ${file.index}\\n'`,
      `find ${shellPath(u)} -type f -exec sha256sum {} + || false`,
      `rm -rf ${shellPath(u)}`,
    );

    if (file.basePath !== null) {
      const b = `${input.workDir}/b${file.index}`;
      lines.push(
        `if test -s ${shellPath(file.basePath)}; then mkdir -p ${shellPath(b)}; `
        + `split -b ${DELTA_BLOCK_BYTES} -a 4 ${shellPath(file.basePath)} ${shellPath(`${b}/x`)} || false; `
        + `printf 'BSIDE ${file.index}\\n'; find ${shellPath(b)} -type f -exec sha256sum {} + || false; `
        + `rm -rf ${shellPath(b)}; else printf 'BEMPTY ${file.index}\\n'; fi`,
      );
    }
  }

  return lines.join('\n');
}

/** `base` is null for an absent or empty base side. */
export interface DeltaFileHashes {
  readonly upper: ReadonlyMap<number, string>;
  readonly base: ReadonlyMap<number, string> | null;
}

/** A `split` suffix (`aaaa` and on) back to its block index. */
function parseSplitSuffix(suffix: string): number | null {
  if (!/^[a-z]+$/.test(suffix)) return null;
  let index = 0;

  for (const char of suffix) index = index * 26 + (char.charCodeAt(0) - 97);

  return index;
}

/** Throws when a side is short or a digest malformed: a plan on half a file publishes a torn
 *  delta. `NOSPLIT` is its own message so the caller can fall back. */
export function parseDeltaBlockHashes(
  stdout: string,
  wanted: ReadonlyMap<number, { upperBlocks: number; baseBlocks: number | null }>,
): Map<number, DeltaFileHashes> {
  if (stdout.includes('NOSPLIT')) throw new Error('NOSPLIT');
  const uppers = new Map<number, Map<number, string>>();
  const bases = new Map<number, Map<number, string>>();
  const emptyBase = new Set<number>();
  let side: { into: Map<number, Map<number, string>>; index: number } | null = null;

  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    const tag = /^(USIDE|BSIDE|BEMPTY) (\d+)$/.exec(line);

    if (tag !== null) {
      const index = Number(tag[2]);

      if (tag[1] === 'BEMPTY') {
        emptyBase.add(index);
        side = null;
      } else {
        side = { into: tag[1] === 'USIDE' ? uppers : bases, index };
      }

      continue;
    }

    if (line === '' || line.startsWith('#')) continue;

    if (side === null) throw new Error(`a delta hash line names no side: ${line.slice(0, 80)}`);
    const digest = line.slice(0, 64);

    if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error(`a delta hash line is not a digest: ${line.slice(0, 80)}`);
    const block = parseSplitSuffix(line.slice(line.lastIndexOf('/') + 1).replace(/^x/, ''));

    if (block === null) throw new Error(`a delta hash line names no block: ${line.slice(0, 80)}`);
    let held = side.into.get(side.index);

    if (held === undefined) {
      held = new Map();
      side.into.set(side.index, held);
    }

    held.set(block, digest);
  }

  const out = new Map<number, DeltaFileHashes>();

  for (const [index, counts] of wanted) {
    const upper = uppers.get(index);

    if (upper === undefined || upper.size !== counts.upperBlocks) {
      throw new Error(`upper side of file ${index} holds ${upper?.size ?? 0} blocks, expected ${counts.upperBlocks}`);
    }

    let base: Map<number, string> | null = null;

    if (counts.baseBlocks !== null && !emptyBase.has(index)) {
      const held = bases.get(index);

      if (held === undefined || held.size !== counts.baseBlocks) {
        throw new Error(`base side of file ${index} holds ${held?.size ?? 0} blocks, expected ${counts.baseBlocks}`);
      }

      base = held;
    }

    out.set(index, { upper, base });
  }

  return out;
}

export type DeltaBaseKind = 'file' | 'dir' | 'link' | 'other';

export interface DeltaBaseFact {
  readonly kind: DeltaBaseKind;
  readonly size: number;
}

/** Output is one line per path, in path order, so no name appears in it; the parser relies on position. */
export function deltaBaseStatCommand(paths: readonly string[], lowerBase: string): string {
  const lines = ['# devbox-basestat-v1'];

  for (const path of paths) {
    lines.push(`stat -c '%F %s' ${shellPath(`${lowerBase}/${path}`)} 2>/dev/null || printf 'ABSENT\\n'`);
  }

  return lines.join('\n');
}

const BASE_KIND = new Map<string, DeltaBaseKind>([
  ['regular file', 'file'],
  ['regular empty file', 'file'],
  ['directory', 'dir'],
  ['symbolic link', 'link'],
]);

export function parseDeltaBaseStat(stdout: string, paths: readonly string[]): Map<string, DeltaBaseFact | null> {
  const lines = stdout.split('\n').filter((line) => line !== '' && !line.startsWith('#'));

  if (lines.length !== paths.length) {
    throw new Error(`the delta base stat holds ${lines.length} lines for ${paths.length} paths`);
  }

  const out = new Map<string, DeltaBaseFact | null>();

  for (const [at, path] of paths.entries()) {
    const line = lines[at];

    if (line === 'ABSENT') {
      out.set(path, null);
      continue;
    }

    const lastSpace = line.lastIndexOf(' ');
    const size = Number(line.slice(lastSpace + 1));

    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`the delta base stat holds no size for ${path}`);
    out.set(path, { kind: BASE_KIND.get(line.slice(0, lastSpace)) ?? 'other', size });
  }

  return out;
}

export interface DeltaPlanInput {
  readonly probe: readonly DeltaProbeEntry[];
  /** Carried paths only, null when the base holds nothing there. */
  readonly baseFacts: ReadonlyMap<string, DeltaBaseFact | null>;
  /** By position in `hashFiles`. */
  readonly hashes: ReadonlyMap<number, DeltaFileHashes>;
  /** Probe paths that were block-hashed, in hash order. */
  readonly hashFiles: readonly string[];
  /** Probe paths verified as 0/0 whiteouts. A `c` entry outside this set is a
   *  real device node and travels whole. */
  readonly whiteouts: ReadonlySet<string>;
}

export interface DeltaPlan {
  readonly manifest: DeltaManifest;
  /** Content digests to extract, each with the upper path and block to read. */
  readonly chunks: ReadonlyMap<string, { path: string; block: number; source?: string }>;
  readonly indexes: ReadonlyMap<string, Uint8Array>;
  readonly retainedFiles?: ReadonlyMap<string, string>;
}

/** Which probe paths the driver must block-hash: big regular files with one
 *  link. Everything else travels whole or as metadata. */
export function deltaHashCandidates(probe: readonly DeltaProbeEntry[]): string[] {
  return probe
    .filter((entry) => entry.type === 'f' && entry.nlink === 1 && entry.size >= DELTA_WHOLE_FILE_THRESHOLD)
    .map((entry) => entry.path)
    .sort();
}

/** Pure. Throws when probe facts disagree: a hash count that does not match the probed size
 *  means the file changed mid-checkpoint. */
export function planDeltaPublication(input: DeltaPlanInput): DeltaPlan {
  const files: DeltaManifest['files'] = [];
  const dirs: DeltaManifest['dirs'] = [];
  const deleted: string[] = [];
  const treplace: string[] = [];
  const links: string[][] = [];
  const chunks = new Map<string, { path: string; block: number }>();
  const indexes = new Map<string, Uint8Array>();
  const linkGroups = new Map<number, string[]>();
  const hashIndex = new Map(input.hashFiles.map((path, index) => [path, index]));
  const opaque = new Set(input.probe.filter(entry => entry.type === 'o').map(entry => entry.path));

  for (const entry of input.probe) {
    const basename = entry.path.slice(entry.path.lastIndexOf('/') + 1);

    if (basename.startsWith('.wh.')) {
      if (basename === '.wh..wh..opq') {
        const parent = entry.path.slice(0, Math.max(0, entry.path.lastIndexOf('/')));

        if (!opaque.has(parent)) throw new Error('opaque-directory publication requires an explicit namespace record');
        continue;
      }

      const path = entry.path.slice(0, entry.path.lastIndexOf('/') + 1) + basename.slice(4);
      deleted.push(v.parse(RelPath, path));
      continue;
    }

    if (entry.type === 'd' || entry.type === 'o') {
      const dir: DeltaManifest['dirs'][number] = { p: entry.path, mode: entry.mode, uid: entry.uid, gid: entry.gid };

      if (entry.type === 'o') dir.opaque = true;
      dirs.push(dir);
      continue;
    }

    if (entry.type === 'c' && input.whiteouts.has(entry.path)) {
      deleted.push(entry.path);
      continue;
    }

    if (entry.type === 's') continue;

    if (entry.type !== 'f') {
      files.push({ kind: 'whole', p: entry.path, s: entry.size });
      continue;
    }

    if (entry.nlink > 1) {
      files.push({ kind: 'whole', p: entry.path, s: entry.size });
      const group = linkGroups.get(entry.ino) ?? [];
      group.push(entry.path);
      linkGroups.set(entry.ino, group);
      continue;
    }

    const index = hashIndex.get(entry.path);

    if (entry.size < DELTA_WHOLE_FILE_THRESHOLD || index === undefined) {
      files.push({ kind: 'whole', p: entry.path, s: entry.size });
      continue;
    }

    const hashed = input.hashes.get(index);

    if (hashed === undefined) throw new Error(`no block hashes for big file ${entry.path}`);
    const blockCount = Math.ceil(entry.size / DELTA_BLOCK_BYTES);

    if (hashed.upper.size !== blockCount) {
      throw new Error(`upper of ${entry.path} holds ${hashed.upper.size} blocks, probed size says ${blockCount}`);
    }

    let upperHoles = 0;
    const added: string[] = [];
    const over: DeltaOverride[] = [];

    for (let block = 0; block < blockCount; block += 1) {
      const offset = block * DELTA_BLOCK_BYTES;
      const length = Math.min(DELTA_BLOCK_BYTES, entry.size - offset);
      const upper = hashed.upper.get(block);

      if (upper === undefined) throw new Error(`upper of ${entry.path} is missing block ${block}`);
      const upperZero = upper === zeroBlockDigest(length);

      if (upperZero) upperHoles += 1;
      const base = hashed.base?.get(block);

      if (upper === base) continue;

      if (upperZero) {
        over.push({ o: offset, src: 'hole' });
        continue;
      }

      over.push({ o: offset, src: 'chunk', d: upper });

      if (!chunks.has(upper)) {
        chunks.set(upper, { path: entry.path, block });
        added.push(upper);
      }
    }

    if (upperHoles / blockCount > DELTA_SPARSE_WHOLE_FRACTION) {
      files.push({ kind: 'whole', p: entry.path, s: entry.size });

      for (const digest of added) {
        chunks.delete(digest);
      }

      continue;
    }

    const indexFile = buildDeltaIndex(over, entry.size);
    indexes.set(indexFile.ref.index, indexFile.bytes);
    files.push({ kind: 'chunked', p: entry.path, s: entry.size, mode: entry.mode, uid: entry.uid, gid: entry.gid, over: indexFile.ref });
  }

  for (const group of linkGroups.values()) {
    if (group.length > 1) links.push([...group].sort());
  }

  // A file over a base directory needs the directory removed first: only a whiteout hides its
  // children. A directory over a base file needs nothing: an upper directory shadows it.
  for (const file of files) {
    const fact = input.baseFacts.get(file.p);

    if (fact !== undefined && fact !== null && fact.kind === 'dir') treplace.push(file.p);
  }

  // EVERY upper directory travels with its attributes: an empty directory, or
  // one whose mode alone changed, is a change the base does not hold.
  dirs.sort((a, b) => (a.p < b.p ? -1 : 1));
  files.sort((a, b) => (a.p < b.p ? -1 : 1));
  deleted.sort();
  treplace.sort();
  links.sort((a, b) => (a[0] < b[0] ? -1 : 1));

  return { manifest: { v: 2, files, dirs, deleted, treplace, links }, chunks, indexes };
}

/** Base64 of the manifest JSON: data, never shell syntax. */
function encodeDeltaManifest(manifest: DeltaManifest): string {
  return Buffer.from(JSON.stringify(manifest), 'utf8').toString('base64');
}

/** Publication may enumerate a retained index. The block server never does. */
export function readDeltaIndex(ref: DeltaIndexRef, size: number, bytes: Uint8Array): DeltaOverride[] {
  if (bytes.byteLength !== ref.count * DELTA_INDEX_PAGE_BYTES || createHash('sha256').update(bytes).digest('hex') !== ref.index) {
    throw new Error('corrupt delta index file');
  }

  const out: DeltaOverride[] = [];
  let previous = -1;

  for (let rank = 0; rank < ref.count; rank += 1) {
    const at = Number(Buffer.from(bytes.subarray(rank * DELTA_INDEX_PAGE_BYTES)).readBigUInt64LE());

    if (!Number.isSafeInteger(at) || at % DELTA_BLOCK_BYTES !== 0 || at >= size || at <= previous) throw new Error('invalid delta index offset');
    const entry = lookupDeltaIndex(ref, size, at, (offset, length) => bytes.subarray(offset, offset + length));

    if (entry === null) throw new Error('unreachable delta index entry');
    out.push(entry);
    previous = at;
  }

  if (ref.count === 0) lookupDeltaIndex(ref, size, 0, () => bytes);

  return out;
}

/** The upper replaces names, not the retained delta's unrelated records.
 * This operates on changed metadata only; no merged-tree walk or rebase. */
export function mergeDeltaPublication(plan: DeltaPlan, retained: DeltaManifest,
  indexes: ReadonlyMap<string, Uint8Array>, sideDir: string): DeltaPlan {
  const next = plan.manifest;
  const erased = [...next.deleted, ...next.files.map(file => file.p), ...next.dirs.filter(dir => dir.opaque).map(dir => dir.p)];
  const replaced = new Set([...next.files.map(file => file.p), ...next.dirs.map(dir => dir.p)]);
  const removed = (path: string): boolean => erased.includes('') || replaced.has(path) || ancestorDirs(path).some(parent => erased.includes(parent)) || next.deleted.includes(path);
  const kept = retained.files.filter(file => !removed(file.p));
  const chunks = new Map(plan.chunks);
  const mergedIndexes = new Map(plan.indexes);
  const retainedFiles = new Map<string, string>();
  const retainedDirs = new Map(retained.dirs.map(dir => [dir.p, dir]));

  for (const file of kept) {
    if (file.kind === 'whole') { retainedFiles.set(file.p, `${sideDir}/${DELTA_TREE_DIR}/${file.p}`); continue; }

    const bytes = indexes.get(file.over.index);

    if (bytes === undefined) throw new Error(`missing retained index for ${file.p}`);
    mergedIndexes.set(file.over.index, bytes);

    for (const entry of readDeltaIndex(file.over, file.s, bytes)) {
      if (entry.src === 'chunk' && !chunks.has(entry.d)) {
        chunks.set(entry.d, { path: file.p, block: entry.o / DELTA_BLOCK_BYTES, source: `${sideDir}/${DELTA_CHUNK_DIR}/${entry.d}` });
      }
    }
  }

  const files = [...kept, ...next.files].sort((a, b) => a.p.localeCompare(b.p));
  const paths = new Set(files.map(file => file.p));
  const links = retained.links.map(group => group.filter(path => paths.has(path) && !removed(path))).filter(group => group.length > 1);

  return { manifest: { v: 2, files,
    dirs: [...retained.dirs.filter(dir => !removed(dir.p)), ...next.dirs.map(dir => {
      const previous = retainedDirs.get(dir.p);

      return previous?.opaque === true ? { ...dir, opaque: true } : dir;
    })].sort((a, b) => a.p.localeCompare(b.p)),
    deleted: [...new Set([...retained.deleted.filter(path => !removed(path)), ...next.deleted])].sort(),
    treplace: [...new Set([...retained.treplace.filter(path => paths.has(path)), ...next.treplace])].sort(),
    links: [...links, ...next.links] }, chunks, indexes: mergedIndexes, retainedFiles };
}

export interface DeltaStageLayout {
  readonly upperDir: string;
  readonly pkgDir: string;
}

export function buildDeltaStageOps(plan: DeltaPlan, layout: DeltaStageLayout): string[] {
  const treeDir = `${layout.pkgDir}/${DELTA_TREE_DIR}`;
  const chunkDir = `${layout.pkgDir}/${DELTA_CHUNK_DIR}`;
  const ops = ['# devbox-stage-v1', `mkdir -p ${shellPath(treeDir)} ${shellPath(chunkDir)}`, ...directoryOps(plan.manifest, treeDir)];
  const linkFirst = new Map<string, string>();

  for (const group of plan.manifest.links) for (const rest of group.slice(1)) linkFirst.set(rest, group[0]);

  for (const file of plan.manifest.files) {
    if (file.kind !== 'whole') continue;
    const first = linkFirst.get(file.p);
    ops.push(first !== undefined
      ? `ln ${shellPath(`${treeDir}/${first}`)} ${shellPath(`${treeDir}/${file.p}`)}`
      : `cp -a ${shellPath(plan.retainedFiles?.get(file.p) ?? `${layout.upperDir}/${file.p}`)} ${shellPath(`${treeDir}/${file.p}`)}`);
  }

  // The tree mask hides base names without hiding this checkpoint's whole
  // files from the higher block layer. No lower directory is enumerated.
  for (const dir of plan.manifest.dirs) {
    if (dir.opaque) ops.push(`: > ${shellPath(`${treeDir}/${dir.p === '' ? '' : `${dir.p}/`}.wh..wh..opq`)}`);
  }

  for (const [digest, chunk] of [...plan.chunks].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (chunk.source !== undefined) {
      ops.push(`cp -a ${shellPath(chunk.source)} ${shellPath(`${chunkDir}/${digest}`)}`);
      continue;
    }

    ops.push(`dd if=${shellPath(`${layout.upperDir}/${chunk.path}`)} of=${shellPath(`${chunkDir}/${digest}`)} `
      + `bs=${DELTA_BLOCK_BYTES} skip=${chunk.block} count=1 2>/dev/null`);
  }

  for (const [digest, bytes] of plan.indexes) {
    ops.push(`printf %s ${shellPath(Buffer.from(bytes).toString('base64'))} | base64 -d > ${shellPath(`${layout.pkgDir}/.devbox-delta/${digest}`)}`);
  }

  ops.push(`printf %s ${shellPath(encodeDeltaManifest(plan.manifest))} | base64 -d > ${shellPath(`${layout.pkgDir}/${DELTA_MANIFEST_NAME}`)}`);

  return ops;
}

function directoryOps(manifest: DeltaManifest, root: string): string[] {
  const wanted = new Set<string>();

  for (const file of manifest.files) for (const dir of ancestorDirs(file.p)) wanted.add(dir);

  for (const path of manifest.deleted) for (const dir of ancestorDirs(path)) wanted.add(dir);

  for (const dir of manifest.dirs) wanted.add(dir.p);
  const ops: string[] = [];

  if (wanted.size > 0) ops.push(`mkdir -p ${[...wanted].map((dir) => shellPath(`${root}/${dir}`)).join(' ')}`);

  for (const dir of manifest.dirs) {
    ops.push(`chown ${dir.uid}:${dir.gid} ${shellPath(`${root}/${dir.p}`)}`, `chmod ${dir.mode.toString(8)} ${shellPath(`${root}/${dir.p}`)}`);
  }

  return ops;
}

/** Namespace-only preparation before any overlay is mounted. Replacement
 * inodes come from the newer lower; deletions are whiteouts in the plain upper. */
export function buildDeltaAttachOps(manifest: DeltaManifest, upper: string): string[] {
  return ['# devbox-namespace-v2', ...directoryOps(manifest, upper),
    ...manifest.deleted.map(path => {
      const slash = path.lastIndexOf('/');

      return `: > ${shellPath(`${upper}/${path.slice(0, slash + 1)}.wh.${path.slice(slash + 1)}`)}`;
    })];
}
