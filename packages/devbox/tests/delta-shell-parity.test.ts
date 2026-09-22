/** Runs the product's delta shell fragments through real `bash` and compares against `delta-shell.ts`.
 *  Whiteouts (0/0 `mknod` device nodes) cannot be staged unprivileged, so deletions are not compared. */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';

import {
  DELTA_BLOCK_BYTES,
  DELTA_MANIFEST_NAME,
  DeltaManifestSchema,
  buildDeltaAttachOps,
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
import { requireSessionShellAccepts } from './support/session-shell';
import { readDeltaIndex } from '../src/chunked-delta';
import { ContainerDisk } from './support/strategy-machine';
import {
  compareTrees,
  describeMismatches,
  Seeded,
  type NodeEntry,
  type PosixMetadata,
} from './support/tree-model';
import * as v from 'valibot';
import { buildBlockImage, copyBlockProbe, removeBlockImage } from './support/block-image';

const uid = process.getuid?.() ?? 0;

const gid = process.getgid?.() ?? 0;

const owned: PosixMetadata = { uid, gid, atimeNs: '0', mtimeNs: '0', ctimeNs: '0', xattrs: {} };

const dense = (path: string, bytes: Uint8Array, ino: number, mode = 0o644): NodeEntry =>
  ({ path, kind: 'file', mode, ino, metadata: owned, content: { kind: 'dense', bytes } });

const dir = (path: string, ino: number, mode = 0o755): NodeEntry => ({ path, kind: 'dir', mode, ino, metadata: owned });

/** Covers every shape the planner names: changed and zeroed blocks, small files, hardlinks,
 *  a symlink, a moded empty dir, a file over a base dir, and an excluded subtree at two depths. */
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
    dir('opaque', 15),
    dense('opaque/.wh..wh..opq', new Uint8Array(0), 16),
    dense('opaque/new', encoder.encode('visible'), 17),
  ];

  return { base, upper };
}

/** Hashes come from the real bytes, never via `parseDeltaBlockHashes` (the code under test).
 *  A base path that names no file answers null, as the wire does. */
function expectedBlockHashes(
  files: readonly { index: number; upperPath: string; basePath: string | null }[],
): Map<number, { upper: ReadonlyMap<number, string>; base: ReadonlyMap<number, string> | null }> {
  const blocks = (path: string): Map<number, string> => {
    const bytes = readFileSync(path);
    const out = new Map<number, string>();

    for (let block = 0; block * DELTA_BLOCK_BYTES < bytes.length; block++) {
      out.set(block, createHash('sha256').update(bytes.subarray(block * DELTA_BLOCK_BYTES, (block + 1) * DELTA_BLOCK_BYTES)).digest('hex'));
    }

    return out;
  };

  return new Map(files.map((file) => [file.index, {
    upper: blocks(file.upperPath),
    base: file.basePath === null ? null : blocks(file.basePath),
  }] as const));
}

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
      const { target } = entry;

      if (target === undefined) throw new Error(`${entry.path} is a symlink with no target`);

      symlinkSync(target, at);
      continue;
    }

    const first = firstName.get(entry.ino);

    if (first !== undefined) {
      linkSync(first, at);
      continue;
    }

    const { content } = entry;

    if (content === undefined) throw new Error(`${entry.path} is a file with no content`);

    writeFileSync(at, content.kind === 'dense' ? content.bytes : new Uint8Array(0));
    chmodSync(at, entry.mode);
    firstName.set(entry.ino, at);
  }
}

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
  const run = spawnSync('bash', ['-c', `umask 022\n${command}`], { env: { PATH: `${root}/bin:${process.env.PATH ?? ''}`, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LC_ALL: 'C' }, maxBuffer: 64 * 1024 * 1024 });

  return { stdout: run.stdout.toString(), stderr: run.stderr.toString(), exitCode: run.status ?? 1 };
}

/** Mirrors `runOpsBatched`: operations run under a subshell-scoped `set -e` (D18);
 *  the session-shell model refuses the unscoped form. */
function batch(ops: readonly string[]): string {
  requireSessionShellAccepts([ops[0], '(', 'set -e', ...ops.slice(1), ')'].join('\n'));

  return [ops[0], '(', 'set -e', ...ops.slice(1), ')'].join('\n');
}

/** Owner is compared only for nodes the delta carries; nodes the shell creates (chunks, manifest,
 *  envelope dirs, opacity markers) belong to the running user, root in a container. */
function sameTree(expected: readonly NodeEntry[], served: readonly NodeEntry[], carriedUnder: string): string {
  return describeMismatches(compareTrees(expected, served, NOT_COMPARED)
    .filter((row) => row.property !== 'owner' || (row.path.startsWith(carriedUnder) && !row.path.endsWith('/.wh..wh..opq'))));
}

/** A probe record with what a filesystem is free to choose dropped: inode
 *  numbers, and a directory's own size. */
function comparable(entries: readonly DeltaProbeEntry[]): unknown[] {
  return [...entries]
    .sort((a, b) => (a.path < b.path ? -1 : 1))
    .map(({ ino: _ino, ...rest }) => (rest.type === 'd' || rest.type === 'o' ? { ...rest, size: 0 } : rest));
}

const NOT_COMPARED = new Set(['times', 'sparse'] as const);

const excludes = ['node_modules'];

const root = mkdtempSync(`${tmpdir()}/devbox-delta-parity-`);

const image = `kinu-block-probe:${process.pid}`;

let built = false;

afterAll(() => {
  rmSync(root, { recursive: true, force: true });

  if (built) removeBlockImage(image);
});

const real = { upper: `${root}/upper`, base: `${root}/base`, stage: `${root}/stage`, pkg: `${root}/stage/pkg`, upper2: `${root}/upper2` };

const disk = new ContainerDisk();

/** The same command as the emulation runs it. An unrecognised command is the
 *  drift this suite exists to catch, so it is a failure rather than a skip. */
function diskShell(command: string): ShellReply {
  const reply = deltaCommand(command, disk);

  if (reply === undefined) throw new Error(`the delta shell has no arm for: ${command.split('\n')[0]}`);

  return reply;
}

let plan: DeltaPlan;

beforeAll(() => {
  buildBlockImage(image);
  built = true;
  mkdirSync(`${root}/bin`);
  copyBlockProbe(image, `${root}/bin/devbox-block-lower`);
  const trees = fixture();

  for (const at of [real.upper, real.base, real.upper2]) mkdirSync(at, { recursive: true });
  plantReal(real.upper, trees.upper);
  plantReal(real.base, trees.base);
  disk.tree(real.upper).plant(trees.upper);
  disk.tree(real.base).plant(trees.base);
  disk.tree(real.upper2);
});

describe('the delta shell against bash', () => {
  let probe: DeltaProbeEntry[];

  test('the upper probe lists the same entries', () => {
    const command = deltaProbeCommand(real.upper, excludes);
    const fromBash = parseDeltaProbe(realShell(command).stdout);
    const fromDisk = parseDeltaProbe(diskShell(command).stdout);
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
    const baseFromDisk = parseDeltaBaseStat(diskShell(statCommand).stdout, carried);

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

    const wanted = new Map(hashFiles.map((path, index) => {
      const inBase = baseFromBash.get(path);

      return [index, {
        upperBlocks: Math.ceil((sizes.get(path) ?? 0) / DELTA_BLOCK_BYTES),
        baseBlocks: inBase?.kind === 'file' ? Math.ceil(inBase.size / DELTA_BLOCK_BYTES) : null,
      }] as const;
    }));

    const hashCommand = deltaBlockHashCommand({ workDir: `${real.stage}/hash`, files });
    const hashedByBash = realShell(hashCommand);
    const hashedByDisk = diskShell(hashCommand);
    // The expected hashes come from the fixture's real bytes, not a second parse, so parser
    // or shell drift fails the test.
    const expected = expectedBlockHashes(files);
    expect(parseDeltaBlockHashes(hashedByBash.stdout, wanted)).toEqual(expected);
    expect(parseDeltaBlockHashes(hashedByDisk.stdout, wanted)).toEqual(expected);
    expect(hashedByDisk.exitCode).toBe(hashedByBash.exitCode);
    const hashes = parseDeltaBlockHashes(hashedByBash.stdout, wanted);

    const fromBash = planDeltaPublication({ probe, baseFacts: baseFromBash, hashes, hashFiles, whiteouts: new Set() });

    const fromDisk = planDeltaPublication({
      probe: parseDeltaProbe(diskShell(deltaProbeCommand(real.upper, excludes)).stdout),
      baseFacts: baseFromDisk,
      hashes: parseDeltaBlockHashes(hashedByDisk.stdout, wanted),
      hashFiles,
      whiteouts: new Set(),
    });

    expect(fromDisk.manifest).toEqual(fromBash.manifest);
    expect(new Map(fromDisk.chunks)).toEqual(new Map(fromBash.chunks));
    const big = fromBash.manifest.files.find((file) => file.p === 'vol/big.bin');
    const index = big?.kind === 'chunked' ? fromBash.indexes.get(big.over.index) : undefined;
    expect(big?.kind === 'chunked' && index !== undefined ? readDeltaIndex(big.over, big.s, index).map((o) => [o.o / DELTA_BLOCK_BYTES, o.src]) : null).toEqual([[2, 'chunk'], [4, 'hole'], [7, 'chunk']]);
    expect(fromBash.manifest.treplace).toEqual(['was-a-dir']);
    expect(fromBash.manifest.links).toEqual([['link-one.bin', 'link-two.bin']]);
    expect(fromBash.manifest.dirs.map((row) => row.p)).toEqual(['empty', 'new', 'opaque', 'vol']);
    expect(fromBash.manifest.dirs.find(row => row.p === 'opaque')?.opaque).toBe(true);
    plan = fromBash;
  });

  test('the stage leaves the same package', () => {
    const command = batch(buildDeltaStageOps(plan, { upperDir: real.upper, pkgDir: real.pkg }));
    const byBash = realShell(command);
    const byDisk = diskShell(command);
    expect(byBash.exitCode).toBe(0);
    expect(byDisk.exitCode).toBe(0);
    const packed = readReal(real.pkg);
    const first = plan.manifest.files[0].p;
    const carrier = packed.find((entry) => entry.kind === 'file' && entry.path.endsWith(`/${first}`));

    if (carrier === undefined) throw new Error(`the staged package carries no file ending in /${first}`);

    const carriedUnder = carrier.path.slice(0, -first.length);
    const marker = `${real.pkg}/${carriedUnder}opaque/.wh..wh..opq`;
    expect(lstatSync(marker).uid).toBe(uid);
    expect(lstatSync(marker).gid).toBe(gid);
    expect(disk.node(marker)?.metadata).toMatchObject({ uid: 0, gid: 0 });
    expect(sameTree(packed, disk.snapshot(real.pkg), carriedUnder)).toBe('');
    const manifest = v.parse(DeltaManifestSchema, JSON.parse(readFileSync(`${real.pkg}/${DELTA_MANIFEST_NAME}`, 'utf8')));
    expect(manifest).toEqual(plan.manifest);
  });

  test('attach prepares exact directory metadata without copying a file into the upper', () => {
    const command = batch(buildDeltaAttachOps(plan.manifest, real.upper2));
    expect(realShell(command).exitCode).toBe(0);
    expect(diskShell(command).exitCode).toBe(0);

    const served = readReal(real.upper2);
    expect(sameTree(served, disk.snapshot(real.upper2), '')).toBe('');
    // Base plus delta must reproduce the editor's upper for every carried path; pruned
    // subtrees are excluded because no delta carries them by policy.
    const carried = fixture().upper.filter((entry) => entry.kind === 'dir' && !entry.path.split('/').includes('node_modules'));
    expect(sameTree(carried, served, '')).toBe('');
    expect(served.every(entry => entry.kind === 'dir')).toBe(true);
    expect(command).not.toMatch(/\b(cp|dd|truncate|rm)\b/);
  });
});
