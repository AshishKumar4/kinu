/**
 * The delta shell emulation, held to a real shell on a real filesystem.
 *
 * `delta-shell.ts` answers the chunked delta's generated shell over a
 * `ContainerDisk`. This suite runs THE SAME fragments — the product's own
 * `deltaProbeCommand`, `deltaBaseStatCommand`, `deltaBlockHashCommand`,
 * `buildDeltaStageOps` and `buildDeltaMaterializeOps` — through `bash` on a
 * temporary directory holding the same two trees, and compares what each side
 * reported and what each side left on disk. An emulation that drifts from
 * what a container does fails here, not in a deployed wake.
 *
 * What a real shell cannot stage unprivileged is not compared: a whiteout is
 * a 0/0 device node (`mknod`), so deletions are the battery's to prove.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';

import {
  DELTA_BLOCK_BYTES,
  DELTA_MANIFEST_NAME,
  DeltaManifestSchema,
  buildDeltaMaterializeOps,
  buildDeltaStageOps,
  deltaBaseStatCommand,
  deltaBlockHashCommand,
  deltaHashCandidates,
  deltaProbeCommand,
  parseDeltaBaseStat,
  parseDeltaBlockHashes,
  parseDeltaProbe,
  planDeltaPublication,
  type DeltaPlan,
  type DeltaProbeEntry,
} from '../src/chunked-delta';
import { deltaCommand, type ShellReply } from './support/delta-shell';
import { ContainerDisk } from './support/strategy-machine';
import {
  compareTrees,
  describeMismatches,
  Seeded,
  type NodeEntry,
  type PosixMetadata,
} from './support/tree-model';
import * as v from 'valibot';

const uid = process.getuid?.() ?? 0;
const gid = process.getgid?.() ?? 0;
const owned: PosixMetadata = { uid, gid, atimeNs: '0', mtimeNs: '0', ctimeNs: '0', xattrs: {} };
const dense = (path: string, bytes: Uint8Array, ino: number, mode = 0o644): NodeEntry =>
  ({ path, kind: 'file', mode, ino, metadata: owned, content: { kind: 'dense', bytes } });
const dir = (path: string, ino: number, mode = 0o755): NodeEntry => ({ path, kind: 'dir', mode, ino, metadata: owned });

/** Two trees: the base a chain was cut from and the upper an editor left.
 *  Every shape the planner names is here: a big file with two changed
 *  blocks and one zeroed block, small files changed and added, a hardlink
 *  pair, a symlink, an empty directory with its own mode, a file over a base
 *  directory, and an excluded subtree at two depths. */
function fixture() {
  const seed = new Seeded(97);
  const big = seed.fill(new Uint8Array(10 * DELTA_BLOCK_BYTES + 1234));
  const edited = big.slice();
  edited.set(seed.fill(new Uint8Array(DELTA_BLOCK_BYTES)), 2 * DELTA_BLOCK_BYTES);
  edited.set(seed.fill(new Uint8Array(DELTA_BLOCK_BYTES)), 7 * DELTA_BLOCK_BYTES);
  edited.fill(0, 4 * DELTA_BLOCK_BYTES, 5 * DELTA_BLOCK_BYTES);
  const grown = seed.fill(new Uint8Array(5 * DELTA_BLOCK_BYTES));
  const linked = seed.fill(new Uint8Array(3000));
  const encoder = new TextEncoder();
  const base: NodeEntry[] = [
    dir('vol', 1),
    dense('vol/big.bin', big, 2),
    dense('vol/small.txt', encoder.encode('small, before\n'), 3),
    dense('vol/only-in-base.txt', encoder.encode('stays in the base\n'), 4),
    dir('was-a-dir', 5),
    dense('was-a-dir/child.txt', encoder.encode('under the directory\n'), 6),
    dense('short.bin', big.subarray(0, 2 * DELTA_BLOCK_BYTES), 7),
  ];
  const upper: NodeEntry[] = [
    dir('vol', 1, 0o755),
    dense('vol/big.bin', edited, 2),
    dense('vol/small.txt', encoder.encode('small, after\n'), 3, 0o600),
    dir('new', 4, 0o750),
    dense('new/a.txt', encoder.encode('added\n'), 5),
    dense('link-one.bin', linked, 6),
    dense('link-two.bin', linked, 6),
    { path: 'point', kind: 'symlink', mode: 0o777, ino: 7, metadata: owned, target: 'vol/small.txt' },
    dense('was-a-dir', encoder.encode('now a file\n'), 8),
    dir('empty', 9, 0o700),
    dense('short.bin', grown, 10),
    dir('node_modules', 11),
    dense('node_modules/pruned.js', encoder.encode('never travels\n'), 12),
    dir('vol/node_modules', 13),
    dense('vol/node_modules/pruned.js', encoder.encode('never travels\n'), 14),
  ];
  return { base, upper };
}

/** Plant entries on a real filesystem under `root`. */
function plantReal(root: string, entries: readonly NodeEntry[]): void {
  const firstName = new Map<number, string>();
  for (const entry of [...entries].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const at = `${root}/${entry.path}`;
    if (entry.kind === 'dir') {
      mkdirSync(at, { recursive: true });
      chmodSync(at, entry.mode);
      continue;
    }
    if (entry.kind === 'symlink') {
      symlinkSync(entry.target!, at);
      continue;
    }
    const first = firstName.get(entry.ino);
    if (first !== undefined) {
      linkSync(first, at);
      continue;
    }
    const content = entry.content!;
    writeFileSync(at, content.kind === 'dense' ? content.bytes : new Uint8Array(0));
    chmodSync(at, entry.mode);
    firstName.set(entry.ino, at);
  }
}

/** A real directory as capture entries: what `lstat` and `readlink` say. */
function readReal(root: string): NodeEntry[] {
  const out: NodeEntry[] = [];
  const walk = (relative: string): void => {
    for (const name of readdirSync(relative === '' ? root : `${root}/${relative}`).sort()) {
      const path = relative === '' ? name : `${relative}/${name}`;
      const at = `${root}/${path}`;
      const stat = lstatSync(at);
      const metadata: PosixMetadata = { uid: stat.uid, gid: stat.gid, atimeNs: '0', mtimeNs: '0', ctimeNs: '0', xattrs: {} };
      const base = { path, mode: stat.mode & 0o7777, ino: stat.ino, metadata };
      if (stat.isDirectory()) {
        out.push({ ...base, kind: 'dir' });
        walk(path);
      } else if (stat.isSymbolicLink()) {
        out.push({ ...base, kind: 'symlink', target: readlinkSync(at) });
      } else {
        out.push({ ...base, kind: 'file', content: { kind: 'dense', bytes: new Uint8Array(readFileSync(at)) } });
      }
    }
  };
  walk('');
  return out;
}

/** The command as the container's shell runs it: `bash -c`, C collation for
 *  the `split` glob, the container's umask for what the shell creates. */
function realShell(command: string): ShellReply {
  const run = spawnSync('bash', ['-c', `umask 022\n${command}`], { env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 64 * 1024 * 1024 });
  return { stdout: run.stdout.toString(), stderr: run.stderr.toString(), exitCode: run.status ?? 1 };
}

/** What `runOpsBatched` sends: the header, `set -e`, the operations. */
function batch(ops: readonly string[]): string {
  return [ops[0]!, 'set -e', ...ops.slice(1)].join('\n');
}

/** Two trees compared, less what the running user decides rather than the
 *  format: the owner of a node the shell CREATES (a chunk, the manifest, the
 *  envelope directories) is the user's, root in a container and whoever runs
 *  this suite here. A node the delta CARRIES keeps the owner it carries. */
function sameTree(expected: readonly NodeEntry[], served: readonly NodeEntry[], carriedUnder: string): string {
  return describeMismatches(compareTrees(expected, served, NOT_COMPARED)
    .filter((row) => row.property !== 'owner' || row.path.startsWith(carriedUnder)));
}

/** A probe record with what a filesystem is free to choose dropped: inode
 *  numbers, and a directory's own size. */
function comparable(entries: readonly DeltaProbeEntry[]): unknown[] {
  return [...entries]
    .sort((a, b) => (a.path < b.path ? -1 : 1))
    .map(({ ino: _ino, ...rest }) => (rest.type === 'd' ? { ...rest, size: 0 } : rest));
}

const NOT_COMPARED = new Set(['times', 'sparse'] as const);
const excludes = ['node_modules'];

const root = mkdtempSync(`${tmpdir()}/devbox-delta-parity-`);
const real = { upper: `${root}/upper`, base: `${root}/base`, stage: `${root}/stage`, pkg: `${root}/stage/pkg`, upper2: `${root}/upper2` };
const disk = new ContainerDisk();
let plan: DeltaPlan;

beforeAll(() => {
  const trees = fixture();
  for (const at of [real.upper, real.base, real.upper2]) mkdirSync(at, { recursive: true });
  plantReal(real.upper, trees.upper);
  plantReal(real.base, trees.base);
  disk.tree(real.upper).plant(trees.upper);
  disk.tree(real.base).plant(trees.base);
  disk.tree(real.upper2);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the delta shell against bash', () => {
  let probe: DeltaProbeEntry[];

  test('the upper probe lists the same entries', () => {
    const command = deltaProbeCommand(real.upper, excludes);
    const fromBash = parseDeltaProbe(realShell(command).stdout);
    const fromDisk = parseDeltaProbe(deltaCommand(command, disk)!.stdout);
    expect(comparable(fromDisk)).toEqual(comparable(fromBash));
    expect(fromBash.map((row) => row.path)).not.toContain('node_modules/pruned.js');
    expect(fromBash.map((row) => row.path)).not.toContain('vol/node_modules/pruned.js');
    expect(fromBash.find((row) => row.path === 'link-two.bin')?.nlink).toBe(2);
    probe = fromBash;
  });

  test('the base stat, the block hashes and the plan agree', () => {
    const carried = probe.filter((entry) => entry.type !== 'd').map((entry) => entry.path);
    const statCommand = deltaBaseStatCommand(carried, real.base);
    const baseFromBash = parseDeltaBaseStat(realShell(statCommand).stdout, carried);
    const baseFromDisk = parseDeltaBaseStat(deltaCommand(statCommand, disk)!.stdout, carried);
    for (const path of carried) {
      const a = baseFromBash.get(path);
      const b = baseFromDisk.get(path);
      expect(b?.kind).toBe(a?.kind);
      if (a?.kind === 'file') expect(b?.size).toBe(a.size);
    }

    const hashFiles = deltaHashCandidates(probe);
    expect(hashFiles).toEqual(['short.bin', 'vol/big.bin']);
    const sizes = new Map(probe.map((entry) => [entry.path, entry.size] as const));
    const files = hashFiles.map((path, index) => ({
      index, upperPath: `${real.upper}/${path}`, basePath: baseFromBash.get(path)?.kind === 'file' ? `${real.base}/${path}` : null,
    }));
    const wanted = new Map(hashFiles.map((path, index) => [index, {
      upperBlocks: Math.ceil((sizes.get(path) ?? 0) / DELTA_BLOCK_BYTES),
      baseBlocks: baseFromBash.get(path)?.kind === 'file' ? Math.ceil(baseFromBash.get(path)!.size / DELTA_BLOCK_BYTES) : null,
    }] as const));
    const hashCommand = deltaBlockHashCommand({ workDir: `${real.stage}/hash`, files });
    const hashedByBash = realShell(hashCommand);
    const hashedByDisk = deltaCommand(hashCommand, disk)!;
    expect(hashedByDisk.stdout).toBe(hashedByBash.stdout);
    expect(hashedByDisk.exitCode).toBe(hashedByBash.exitCode);
    const hashes = parseDeltaBlockHashes(hashedByBash.stdout, wanted);

    const fromBash = planDeltaPublication({ probe, baseFacts: baseFromBash, hashes, hashFiles, whiteouts: new Set() });
    const fromDisk = planDeltaPublication({
      probe: parseDeltaProbe(deltaCommand(deltaProbeCommand(real.upper, excludes), disk)!.stdout),
      baseFacts: baseFromDisk,
      hashes: parseDeltaBlockHashes(hashedByDisk.stdout, wanted),
      hashFiles,
      whiteouts: new Set(),
    });
    expect(fromDisk.manifest).toEqual(fromBash.manifest);
    expect(new Map(fromDisk.chunks)).toEqual(new Map(fromBash.chunks));
    // The plan itself: two changed blocks and one hole in the big file, the
    // grown file whole-overridden past its base, the file over a directory.
    const big = fromBash.manifest.files.find((file) => file.p === 'vol/big.bin');
    expect(big?.kind === 'chunked' ? big.over.map((o) => [o.o / DELTA_BLOCK_BYTES, o.src]) : null).toEqual([[2, 'chunk'], [4, 'hole'], [7, 'chunk']]);
    expect(fromBash.manifest.treplace).toEqual(['was-a-dir']);
    expect(fromBash.manifest.links).toEqual([['link-one.bin', 'link-two.bin']]);
    expect(fromBash.manifest.dirs.map((row) => row.p)).toEqual(['empty', 'new', 'vol']);
    plan = fromBash;
  });

  test('the stage leaves the same package', () => {
    const command = batch(buildDeltaStageOps(plan, { upperDir: real.upper, pkgDir: real.pkg }));
    const byBash = realShell(command);
    const byDisk = deltaCommand(command, disk)!;
    expect(byBash.exitCode).toBe(0);
    expect(byDisk.exitCode).toBe(0);
    const packed = readReal(real.pkg);
    const first = plan.manifest.files[0]!.p;
    const carriedUnder = packed.find((entry) => entry.kind === 'file' && entry.path.endsWith(`/${first}`))!.path.slice(0, -first.length);
    expect(sameTree(packed, disk.snapshot(real.pkg), carriedUnder)).toBe('');
    const manifest = v.parse(DeltaManifestSchema, JSON.parse(readFileSync(`${real.pkg}/${DELTA_MANIFEST_NAME}`, 'utf8')));
    expect(manifest).toEqual(plan.manifest);
  });

  test('the materialize leaves the same upper, and it is the editor\'s', () => {
    const ops = buildDeltaMaterializeOps(plan.manifest, {
      sideDir: real.pkg, upperDir: real.upper2, lowerBase: real.base, mergedDir: real.upper2,
    });
    for (const phase of [ops.pre, ops.post]) {
      const command = batch(phase);
      expect(realShell(command).exitCode).toBe(0);
      expect(deltaCommand(command, disk)!.exitCode).toBe(0);
    }
    const served = readReal(real.upper2);
    expect(sameTree(served, disk.snapshot(real.upper2), '')).toBe('');
    // THE PRODUCT'S OWN PROPERTY, on real bytes: base plus delta is the upper
    // the editor left, for every path the delta carries — the pruned
    // subtrees excepted, which no delta carries by policy.
    const carried = fixture().upper.filter((entry) => !entry.path.split('/').includes('node_modules'));
    expect(sameTree(carried, served, '')).toBe('');
  });
});
