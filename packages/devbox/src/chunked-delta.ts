/**
 * Chunked deltas: a small edit published as a small publication.
 *
 * The legacy snapshot-chain delta is a squashfs of the whole upper directory.
 * overlayfs copies the WHOLE changed inode into the upper on the first write,
 * so a 64 KiB overwrite in a 64 MiB file archives and uploads ~89 MB (measured
 * 89,478,664 B in one PUT through the local harness, conformance cell 6.22).
 * A chunked delta instead publishes, in ONE squashfs object under the same
 * delta key:
 *
 *   .devbox-delta/manifest.json  changed paths, per-file block overrides, deletions
 *   .devbox-delta/tree/<path>    small, new and metadata-only files, whole
 *   .devbox-delta/chunks/<sha>   changed 16 KiB blocks by content digest
 *
 * A big changed file travels as its UNCHANGED blocks by reference (copied from
 * the base layer at materialize time) plus an override list for the blocks
 * that differ: changed blocks as chunk blobs, zero blocks as explicit
 * zero-writes. Nothing is content-addressed ACROSS generations — the delta is
 * self-contained — so there is no parent to lose and no pack a generation
 * must not retire.
 *
 * THE HARD INVARIANT. No read path fetches an index whose size grows with the
 * number of files in the tree. The manifest lists only CHANGED paths, each
 * chunked file carries only its OWN overrides, and a wake reads the manifest
 * plus exactly the chunks of the files it materializes. There is no tree-wide
 * index to read on open, which is the property whose absence retired
 * merkle-pack (a whole-tree index, read entirely on open, cost 563 B/file
 * flat: 3,349,804 B fetched to serve a 4 KiB read at 5,000 files). Cell 6.24
 * refuses that shape mechanically: the same one-file change must publish and
 * serve the same bytes at 1,000 and 5,000 files.
 *
 * WHAT TRANSFERS FROM archive/merkle-pack-cold (d9ea44c82), AND WHAT DOES NOT.
 * The repaired v2 did the C3 case in 160,253 B in three objects.
 *
 *   - The per-file extent map transfers as the override list: where v2's file
 *     node carries chunk extents plus hole extents, a manifest entry carries
 *     only the blocks that differ from the base. Same information, narrower.
 *   - Sparse-hole preservation transfers as elision: v2 stores zero chunks
 *     once by digest; here an all-zero block is never stored and materializes
 *     as zeros. Geometry is block-granular, which is what mksquashfs itself
 *     serves today (it sparse-detects zero blocks).
 *   - The whole-file fallback transfers as `whole`: small, new and link-shared
 *     files travel whole. There are no parent chunks to reuse — the delta
 *     names nothing outside itself — so the lost-boundary-map regression has
 *     no surface to recur on.
 *   - The attach fix transfers as construction: v2 prohibited a generation
 *     from retiring a pack it adds; a chunked delta references no pack but its
 *     own, staged and published by the same checkpoint.
 *   - Content-defined chunking does NOT transfer. CDC needs a byte-loop engine
 *     the container does not offer in the proven tool vocabulary (sh, find,
 *     stat, dd, split, sha256sum, cp). Fixed 16 KiB blocks reach the C3 bound
 *     through this vocabulary: a 64 KiB overwrite touches at most five blocks.
 *     Insertions that shift every later block fall back to the whole file.
 *
 * OBJECT COUNT. One delta object per publication is the floor snapshot-chain
 * already holds, and this design keeps it. Regime 1 (docs/BENCH.md:418-420)
 * killed overlay-cas on exactly this axis — two mount publications per changed
 * file at ~1 s serialized each — so bytes are never bought with objects here.
 *
 * Every decision about what travels lives in {@link planDeltaPublication}, in
 * TypeScript, where a unit test pins it; the container only moves the bytes
 * the plan names, one straight-line operation per line.
 */

import { createHash } from 'node:crypto';
import * as v from 'valibot';

/** Bytes per delta block. Matches the 16 KiB nominal chunk the conformance
 *  cells budget against. */
export const DELTA_BLOCK_BYTES = 16 * 1024;

/** Files below this size travel whole: a block map would cost more than
 *  their bytes. */
const DELTA_WHOLE_FILE_THRESHOLD = 64 * 1024;

/** A file more than half holes travels whole: hashing and copying a gigabyte
 *  of zeros to publish one data run is the whole-inode cost in a different
 *  hat, and a whole sparse file round-trips its exact hole geometry. */
const DELTA_SPARSE_WHOLE_FRACTION = 1 / 2;

/** Shell operations per container command. Bounds the round trips of a
 *  many-file checkpoint without changing what any operation does. */
export const DELTA_OPS_PER_COMMAND = 250;

/** Layout of the staged package, mirrored at materialize time. Every byte of
 *  a sidecar lives under `.devbox-delta`, so a workspace file collides only by
 *  naming that directory AND validating as a manifest. */
export const DELTA_MANIFEST_NAME = '.devbox-delta/manifest.json';

const DELTA_TREE_DIR = '.devbox-delta/tree';

const DELTA_CHUNK_DIR = '.devbox-delta/chunks';

function shellPath(path: string): string {
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

/** Every ancestor directory of a tree-relative path, shallowest first. */
function ancestorDirs(path: string): string[] {
  const parts = path.split('/');
  const out: string[] = [];

  for (let depth = 1; depth < parts.length; depth += 1) out.push(parts.slice(0, depth).join('/'));

  return out;
}

const Count = v.pipe(v.number(), v.safeInteger(), v.minValue(0));

const Hex64 = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/));

const RelPath = v.pipe(
  v.string(),
  v.minLength(1),
  v.check((path) => !path.startsWith('/') && !path.split('/').includes('..'),
    'a delta path is relative and stays inside the tree'),
);

const OverrideSchema = v.variant('src', [
  v.object({ src: v.literal('chunk'), o: Count, d: Hex64 }),
  v.object({ src: v.literal('hole'), o: Count }),
]);

const FileSchema = v.variant('kind', [
  v.object({ kind: v.literal('whole'), p: RelPath, s: Count }),
  v.object({
    kind: v.literal('chunked'), p: RelPath, s: Count, mode: Count, uid: Count, gid: Count,
    over: v.array(OverrideSchema),
  }),
]);

const DirSchema = v.object({ p: RelPath, mode: Count, uid: Count, gid: Count });

/** The manifest, as the stage writes it and the wake reads it back. A store
 *  object is untrusted input even though this module wrote it. `dirs` carries
 *  ancestor directories with attributes; `treplace` carries paths whose kind
 *  crossed the dir/non-dir boundary and must be removed before planting. */
export const DeltaManifestSchema = v.object({
  v: v.literal(1),
  files: v.array(FileSchema),
  dirs: v.array(DirSchema),
  deleted: v.array(RelPath),
  treplace: v.array(RelPath),
  links: v.array(v.pipe(v.array(RelPath), v.minLength(2))),
});

export type DeltaManifest = v.InferOutput<typeof DeltaManifestSchema>;

export type DeltaManifestFile = DeltaManifest['files'][number];

/** One upper entry as the probe reports it: eleven null-separated fields. */
export interface DeltaProbeEntry {
  readonly path: string;
  /** find's `%y`: `f` file, `d` dir, `l` symlink, `c` char device. */
  readonly type: string;
  readonly ino: number;
  readonly nlink: number;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly size: number;
  readonly target: string;
}

/**
 * List the upper as one base64 line, `0 <payload>`: eleven null-separated
 * fields per record, so any byte but null may appear in a path. `-prune` is
 * the same matcher `archiveSizeCommand` walks, so delta and base exclude the
 * same regenerable trees. An empty upper reports `0 ` with no payload, which
 * is observably different from a failed walk.
 */
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
    + '| base64 | tr -d \'\\n\'';

  return `# devbox-probe-v1\nout=$(${walk}); rc=$?; printf '%s %s' "$rc" "$out"`;
}

/** Parse what {@link deltaProbeCommand} printed, or throw naming the refusal. */
export function parseDeltaProbe(stdout: string): DeltaProbeEntry[] {
  const space = stdout.indexOf(' ');
  const rc = space === -1 ? stdout.trim() : stdout.slice(0, space);

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

    if (path === '' || path.startsWith('/') || path.split('/').includes('..')) {
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

/**
 * Hash every 16 KiB block of the listed files, both sides, through `split`
 * and one `sha256sum` per side: no per-block processes. `USIDE <index>` and
 * `BSIDE <index>` introduce raw `sha256sum` lines; `BEMPTY <index>` marks an
 * absent or empty base; `NOSPLIT` reports a host without `split` (the caller
 * then carries big files whole). `split -a 4` is POSIX, so suffixes are
 * fixed-width and parse back to block indices; split outputs are removed per
 * file so the transient never exceeds two files' splits.
 */
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
      `sha256sum ${shellPath(`${u}/`)}* 2>/dev/null || false`,
      `rm -rf ${shellPath(u)}`,
    );

    if (file.basePath !== null) {
      const b = `${input.workDir}/b${file.index}`;
      lines.push(
        `if test -s ${shellPath(file.basePath)}; then mkdir -p ${shellPath(b)}; `
        + `split -b ${DELTA_BLOCK_BYTES} -a 4 ${shellPath(file.basePath)} ${shellPath(`${b}/x`)} || false; `
        + `printf 'BSIDE ${file.index}\\n'; sha256sum ${shellPath(`${b}/`)}* 2>/dev/null || false; `
        + `rm -rf ${shellPath(b)}; else printf 'BEMPTY ${file.index}\\n'; fi`,
      );
    }
  }

  return lines.join('\n');
}

/** What the hash run reported for one file. `base` is null for an absent or
 *  empty base side. */
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

/** Parse what {@link deltaBlockHashCommand} printed. Throws when a side is
 *  short or a digest malformed: a plan built on half a file publishes a torn
 *  delta. Throws `NOSPLIT` as its own message so the caller can fall back. */
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

/** Base kinds in the planner's vocabulary; `stat -c %F` words map here once. */
export type DeltaBaseKind = 'file' | 'dir' | 'link' | 'other';

export interface DeltaBaseFact {
  readonly kind: DeltaBaseKind;
  readonly size: number;
}

/** Stat the base side of every carried path: one ordered line per path, so
 *  no name appears in the output. `ABSENT` marks a path the base lacks. */
export function deltaBaseStatCommand(paths: readonly string[], lowerBase: string): string {
  const lines = ['# devbox-basestat-v1'];

  for (const path of paths) {
    lines.push(`stat -c '%F %s' ${shellPath(`${lowerBase}/${path}`)} 2>/dev/null || printf 'ABSENT\\n'`);
  }

  return lines.join('\n');
}

/** Parse what {@link deltaBaseStatCommand} printed, in path order. */
export function parseDeltaBaseStat(stdout: string, paths: readonly string[]): Map<string, DeltaBaseFact | null> {
  const lines = stdout.split('\n').filter((line) => line !== '' && !line.startsWith('#'));

  if (lines.length !== paths.length) {
    throw new Error(`the delta base stat holds ${lines.length} lines for ${paths.length} paths`);
  }

  const out = new Map<string, DeltaBaseFact | null>();
  paths.forEach((path, at) => {
    const line = lines[at]!;

    if (line === 'ABSENT') {
      out.set(path, null);

      return;
    }

    const lastSpace = line.lastIndexOf(' ');
    const size = Number(line.slice(lastSpace + 1));

    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`the delta base stat holds no size for ${path}`);
    const words = line.slice(0, lastSpace);

    const kind: DeltaBaseKind = words === 'regular file' || words === 'regular empty file'
      ? 'file'
      : words === 'directory' ? 'dir' : words === 'symbolic link' ? 'link' : 'other';

    out.set(path, { kind, size });
  });

  return out;
}

/** The planner's complete input. */
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

/** The plan: a manifest plus the chunk extractions that fill it. */
export interface DeltaPlan {
  readonly manifest: DeltaManifest;
  /** Content digests to extract, each with the upper path and block to read. */
  readonly chunks: ReadonlyMap<string, { path: string; block: number }>;
}

/** Which probe paths the driver must block-hash: big regular files with one
 *  link. Everything else travels whole or as metadata. */
export function deltaHashCandidates(probe: readonly DeltaProbeEntry[]): string[] {
  return probe
    .filter((entry) => entry.type === 'f' && entry.nlink === 1 && entry.size >= DELTA_WHOLE_FILE_THRESHOLD)
    .map((entry) => entry.path)
    .sort();
}

/**
 * Turn probe facts into a publication plan. PURE. Throws when the facts
 * disagree: a hash count that does not match the probed size is a file that
 * changed mid-checkpoint.
 */
export function planDeltaPublication(input: DeltaPlanInput): DeltaPlan {
  const files: DeltaManifest['files'] = [];
  const dirs: DeltaManifest['dirs'] = [];
  const deleted: string[] = [];
  const treplace: string[] = [];
  const links: string[][] = [];
  const chunks = new Map<string, { path: string; block: number }>();
  const linkGroups = new Map<number, string[]>();
  const hashIndex = new Map(input.hashFiles.map((path, index) => [path, index]));

  for (const entry of input.probe) {
    if (entry.type === 'd') {
      dirs.push({ p: entry.path, mode: entry.mode, uid: entry.uid, gid: entry.gid });
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
    const over: Extract<DeltaManifestFile, { kind: 'chunked' }>['over'] = [];

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
        const shared = files.some((file) => file.kind === 'chunked'
          && file.over.some((o) => o.src === 'chunk' && o.d === digest));

        if (!shared) chunks.delete(digest);
      }

      continue;
    }

    files.push({ kind: 'chunked', p: entry.path, s: entry.size, mode: entry.mode, uid: entry.uid, gid: entry.gid, over });
  }

  for (const group of linkGroups.values()) {
    if (group.length > 1) links.push([...group].sort());
  }

  // A file over a base DIRECTORY: the directory is removed through the merged
  // view before the file is planted, because only a whiteout hides its
  // children. A directory over a base file needs nothing: an upper directory
  // shadows a lower non-directory.
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
  links.sort((a, b) => (a[0]! < b[0]! ? -1 : 1));

  return { manifest: { v: 1, files, dirs, deleted, treplace, links }, chunks };
}

/** Base64 of the manifest JSON: data, never shell syntax. */
function encodeDeltaManifest(manifest: DeltaManifest): string {
  return Buffer.from(JSON.stringify(manifest), 'utf8').toString('base64');
}

/** Where the stage lives. */
export interface DeltaStageLayout {
  readonly upperDir: string;
  /** The package root the archiver packs. */
  readonly pkgDir: string;
}

/**
 * Stage a plan as container operations, one per line. `cp -a` carries whole
 * files with their metadata; `dd` extracts kept blocks out of the upper; the
 * manifest arrives as data.
 */
export function buildDeltaStageOps(plan: DeltaPlan, layout: DeltaStageLayout): string[] {
  const treeDir = `${layout.pkgDir}/${DELTA_TREE_DIR}`;
  const chunkDir = `${layout.pkgDir}/${DELTA_CHUNK_DIR}`;
  const ops = ['# devbox-stage-v1', `mkdir -p ${shellPath(treeDir)} ${shellPath(chunkDir)}`, ...directoryOps(plan.manifest, treeDir)];
  const linkFirst = new Map<string, string>();

  for (const group of plan.manifest.links) for (const rest of group.slice(1)) linkFirst.set(rest, group[0]!);

  for (const file of plan.manifest.files) {
    if (file.kind !== 'whole') continue;
    const first = linkFirst.get(file.p);
    ops.push(first !== undefined
      ? `ln ${shellPath(`${treeDir}/${first}`)} ${shellPath(`${treeDir}/${file.p}`)}`
      : `cp -a ${shellPath(`${layout.upperDir}/${file.p}`)} ${shellPath(`${treeDir}/${file.p}`)}`);
  }

  for (const [digest, chunk] of [...plan.chunks].sort(([a], [b]) => (a < b ? -1 : 1))) {
    ops.push(`dd if=${shellPath(`${layout.upperDir}/${chunk.path}`)} of=${shellPath(`${chunkDir}/${digest}`)} `
      + `bs=${DELTA_BLOCK_BYTES} skip=${chunk.block} count=1 2>/dev/null`);
  }

  ops.push(`printf %s ${shellPath(encodeDeltaManifest(plan.manifest))} | base64 -d > ${shellPath(`${layout.pkgDir}/${DELTA_MANIFEST_NAME}`)}`);

  return ops;
}

/** Where a materialize runs. */
export interface DeltaMaterializeLayout {
  readonly sideDir: string;
  readonly upperDir: string;
  readonly lowerBase: string;
  readonly mergedDir: string;
}

/** The two materialize phases: `pre` fills the upper before the overlay
 *  lands; `post` deletes through the merged view after it does. */
export interface DeltaMaterializeOps {
  readonly pre: readonly string[];
  readonly post: readonly string[];
}

/** The directories a manifest carries, created under `root` with their
 *  attributes, plus every ancestor a carried file needs. */
function directoryOps(manifest: DeltaManifest, root: string): string[] {
  const wanted = new Set<string>();

  for (const file of manifest.files) for (const dir of ancestorDirs(file.p)) wanted.add(dir);

  for (const dir of manifest.dirs) wanted.add(dir.p);
  const ops: string[] = [];

  if (wanted.size > 0) ops.push(`mkdir -p ${[...wanted].sort().map((dir) => shellPath(`${root}/${dir}`)).join(' ')}`);

  for (const dir of manifest.dirs) {
    ops.push(`chown ${dir.uid}:${dir.gid} ${shellPath(`${root}/${dir.p}`)}`, `chmod ${dir.mode.toString(8)} ${shellPath(`${root}/${dir.p}`)}`);
  }

  return ops;
}

/**
 * Serve a manifest back as container operations. A chunked file is the base
 * copied whole plus its overrides written over it — never a block for an
 * unchanged one — so a wake reads exactly the manifest, the carried files and
 * the kept chunks: O(changed), never O(tree). Deletions and dir/non-dir
 * replacements go through the merged view because only the overlay can mint
 * a whiteout.
 */
export function buildDeltaMaterializeOps(manifest: DeltaManifest, layout: DeltaMaterializeLayout): DeltaMaterializeOps {
  const pre = ['# devbox-materialize-v1', ...directoryOps(manifest, layout.upperDir)];
  const post = ['# devbox-materialize-v1-post'];
  const sideTree = `${layout.sideDir}/${DELTA_TREE_DIR}`;
  const sideChunks = `${layout.sideDir}/${DELTA_CHUNK_DIR}`;
  const replaced = new Set(manifest.treplace);
  const linkFirst = new Map<string, string>();

  for (const group of manifest.links) for (const rest of group.slice(1)) linkFirst.set(rest, group[0]!);

  const plant = (file: DeltaManifestFile, root: string): string[] => {
    const dest = `${root}/${file.p}`;
    const first = linkFirst.get(file.p);

    if (first !== undefined) return [`ln ${shellPath(`${root}/${first}`)} ${shellPath(dest)}`];

    if (file.kind === 'whole') return [`cp -a ${shellPath(`${sideTree}/${file.p}`)} ${shellPath(dest)}`];
    const ops = [`cp ${shellPath(`${layout.lowerBase}/${file.p}`)} ${shellPath(dest)} 2>/dev/null || : > ${shellPath(dest)}`];

    for (const override of file.over) {
      const source = override.src === 'chunk' ? shellPath(`${sideChunks}/${override.d}`) : '/dev/zero';
      ops.push(`dd if=${source} of=${shellPath(dest)} bs=${DELTA_BLOCK_BYTES} seek=${override.o / DELTA_BLOCK_BYTES} count=1 conv=notrunc 2>/dev/null`);
    }

    ops.push(
      `truncate -s ${file.s} ${shellPath(dest)}`,
      `chown ${file.uid}:${file.gid} ${shellPath(dest)}`,
      `chmod ${file.mode.toString(8)} ${shellPath(dest)}`,
    );

    return ops;
  };

  for (const file of manifest.files) {
    if (!replaced.has(file.p)) pre.push(...plant(file, layout.upperDir));
  }

  for (const path of manifest.treplace) {
    post.push(`rm -rf ${shellPath(`${layout.mergedDir}/${path}`)}`);
    const file = manifest.files.find((row) => row.p === path);

    if (file !== undefined) post.push(...plant(file, layout.mergedDir));
  }

  for (const path of manifest.deleted) post.push(`rm -rf ${shellPath(`${layout.mergedDir}/${path}`)}`);

  return { pre, post };
}
