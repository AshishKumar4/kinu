#!/usr/bin/env bun
/**
 * The decisive experiment's three workloads, run inside a real devbox.
 *
 * These exist to separate O(p) from O(c): a checkpoint whose cost tracks PENDING
 * CHANGE from one whose cost tracks the CHANGED SET SINCE BASE. Every workload
 * here is chosen because it makes those two quantities diverge, and each runs in
 * SEGMENTS so the driver can checkpoint between them and price each tick.
 *
 *   npm     many small files across a deep tree, then repeated small edits.
 *           p stays tiny after the install; c keeps growing. Run twice, with and
 *           without the excludes policy, because excludes are the one lever that
 *           changes c without changing the work.
 *   git     a seeded tree then 200 commits each touching ~5% of files. Every
 *           commit is a rename storm plus an index rewrite, which is the shape
 *           that collapsed s3fs and the shape a delta rewrite pays for twice.
 *   sqlite  one 64 MiB database rewritten in place. File-granularity CAS must
 *           re-ship the whole file per tick; this measures how much that costs
 *           and is the arm that decides whether extent-level tracking is ever
 *           needed. Recorded, never treated as disqualifying.
 *
 * NO NETWORK. `enableInternet` is false on these containers, so `npm install`
 * and `git clone` cannot run. Both are reproduced by their FILESYSTEM SHAPE —
 * a generated dependency tree and a local seeded repository — which is what the
 * storage layer sees anyway. The report says so rather than implying a package
 * manager ran.
 *
 * Determinism: every size, name and byte pattern derives from `--seed`, and the
 * git identity and dates are pinned, so two runs of one revision produce the
 * same tree and the same commit graph.
 */

import { Database } from 'bun:sqlite';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MiB = 1024 * 1024;

/** Deterministic bytes. Incompressible enough that a store cannot cheat, and
 *  reproducible so two arms move identical payloads. */
function payload(bytes: number, seed: number): Buffer {
  const buf = Buffer.allocUnsafe(bytes);
  let x = (seed ^ 0x9e3779b9) >>> 0;
  for (let i = 0; i < bytes; i++) {
    x = (x + 0x6d2b79f5) >>> 0;
    let t = x;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    buf[i] = (t ^ (t >>> 14)) & 0xff;
  }
  return buf;
}

/** Monotonic milliseconds. A wall clock can step; a tick measurement cannot
 *  survive that. */
const now = (): number => Number(process.hrtime.bigint()) / 1e6;

interface Segment {
  readonly name: string;
  /** Bytes this segment wrote, as the workload understands it. */
  readonly bytesWritten: number;
  /** Files this segment created, modified or deleted. */
  readonly pathsTouched: number;
  readonly wallMs: number;
}

function arg(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1 && index + 1 < process.argv.length) return process.argv[index + 1]!;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing required argument --${name}`);
}

/**
 * A dependency tree of the shape a package manager leaves behind: many packages,
 * each a handful of small files, nested two deep. `--target-mib` sizes it; the
 * default 400 is the research spec's figure.
 *
 * Emitted in segments so the driver checkpoints mid-install as well as after,
 * which is what distinguishes a tick that pays for the whole tree from one that
 * pays for the last slice.
 */
function npmLike(root: string, seed: number, targetMiB: number, segments: number, only: number): Segment[] {
  const modules = join(root, 'node_modules');
  mkdirSync(modules, { recursive: true });
  // A package manager's bytes are dominated by many small files, not few large
  // ones. 12 KiB average across ~12 files per package matches that shape.
  const perFile = 12 * 1024;
  const filesPerPackage = 12;
  const totalFiles = Math.max(segments, Math.floor((targetMiB * MiB) / perFile));
  const packages = Math.max(1, Math.floor(totalFiles / filesPerPackage));
  const perSegment = Math.max(1, Math.floor(packages / segments));

  const out: Segment[] = [];
  for (let segment = 0; segment < segments; segment++) {
    if (segment !== only) continue;
    // Resumable from the index alone: this segment owns packages
    // [segment*perSegment, (segment+1)*perSegment), so a fresh process can do
    // exactly one segment and the driver can checkpoint between them. Ticking
    // five times AFTER the whole workload measured one cold archive and four
    // no-ops, which is the opposite of what the experiment is for.
    let created = segment * perSegment;
    const t0 = now();
    let bytes = 0;
    let paths = 0;
    const upper = Math.min(packages, (segment + 1) * perSegment);
    for (let p = created; p < upper; p++) {
      const pkg = join(modules, `pkg-${String(p).padStart(4, '0')}`);
      mkdirSync(join(pkg, 'dist'), { recursive: true });
      writeFileSync(join(pkg, 'package.json'), payload(512, seed + p));
      bytes += 512;
      paths++;
      for (let f = 0; f < filesPerPackage - 1; f++) {
        writeFileSync(join(pkg, 'dist', `m${f}.js`), payload(perFile, seed + p * 100 + f));
        bytes += perFile;
        paths++;
      }
    }
    out.push({ name: `npm-install-${segment + 1}`, bytesWritten: bytes, pathsTouched: paths, wallMs: now() - t0 });
  }

  // The part that makes p and c diverge: a small edit touching a handful of
  // files, after a large install. A tick that costs the same as the install is
  // O(c); a tick that costs almost nothing is O(p). It is segment index
  // `segments`, so it runs last and on its own.
  if (only !== segments) return out;
  const t0 = now();
  let bytes = 0;
  let paths = 0;
  for (let p = 0; p < Math.min(20, packages); p++) {
    const file = join(modules, `pkg-${String(p).padStart(4, '0')}`, 'dist', 'm0.js');
    writeFileSync(file, payload(perFile, seed + 999_000 + p));
    bytes += perFile;
    paths++;
  }
  out.push({ name: 'npm-small-edit', bytesWritten: bytes, pathsTouched: paths, wallMs: now() - t0 });
  return out;
}

/**
 * A repository, then `commits` commits each touching about `touchPercent` of the
 * files. Real git, so real index rewrites, real rename churn and real object
 * creation — the metadata shape that collapsed the s3fs floor.
 */
function gitLike(root: string, seed: number, files: number, commits: number, touchPercent: number, segments: number, only: number): Segment[] {
  const repo = join(root, 'repo');
  // Segment 0 seeds; later segments resume against the repository it left.
  if (only === 0) {
    rmSync(repo, { recursive: true, force: true });
    mkdirSync(repo, { recursive: true });
  }
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'bench',
    GIT_AUTHOR_EMAIL: 'bench@example.invalid',
    GIT_COMMITTER_NAME: 'bench',
    GIT_COMMITTER_EMAIL: 'bench@example.invalid',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
  const git = (args: readonly string[]): void => {
    execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore', env });
  };

  const out: Segment[] = [];
  if (only === 0) {
    const t0 = now();
    git(['init', '-q', '-b', 'main']);
    let bytes = 0;
    for (let i = 0; i < files; i++) {
      const data = payload(2048, seed + i);
      writeFileSync(join(repo, `src${String(i).padStart(4, '0')}.txt`), data);
      bytes += data.length;
    }
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'seed']);
    out.push({ name: 'git-seed', bytesWritten: bytes, pathsTouched: files, wallMs: now() - t0 });
    return out;
  }

  const perCommit = Math.max(1, Math.round((files * touchPercent) / 100));
  const perSegment = Math.max(1, Math.floor(commits / segments));
  for (let segment = 0; segment < segments; segment++) {
    // Segment index is offset by one because index 0 is the seed.
    if (segment + 1 !== only) continue;
    let done = segment * perSegment;
    const s0 = now();
    let segBytes = 0;
    let segPaths = 0;
    const upper = Math.min(commits, (segment + 1) * perSegment);
    for (let c = done; c < upper; c++) {
      for (let k = 0; k < perCommit; k++) {
        // Deterministic spread so every arm rewrites the same files in the same
        // order; a different spread would be a different experiment.
        const index = (c * perCommit + k * 7 + 13) % files;
        const data = payload(2048, seed + c * 1000 + k);
        writeFileSync(join(repo, `src${String(index).padStart(4, '0')}.txt`), data);
        segBytes += data.length;
        segPaths++;
      }
      git(['add', '-A']);
      git(['commit', '-q', '-m', `c${c}`]);
    }
    out.push({ name: `git-commits-${segment + 1}`, bytesWritten: segBytes, pathsTouched: segPaths, wallMs: now() - s0 });
  }
  return out;
}

/**
 * One database of `sizeMiB`, then in-place page rewrites.
 *
 * Real SQLite through `bun:sqlite`, because the point is genuine in-place page
 * writes rather than a file that happens to be the right size. File-granularity
 * CAS must re-ship the whole file for any tick that follows, and this measures
 * exactly how much that costs.
 */
function sqliteRewrite(root: string, seed: number, sizeMiB: number, segments: number, only: number): Segment[] {
  mkdirSync(root, { recursive: true });
  const dbPath = join(root, 'store.sqlite');
  // Segment 0 fills; later segments rewrite pages in place against the database
  // it left, which is the whole point of this arm.
  if (only === 0) rmSync(dbPath, { force: true });
  const db = new Database(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS blocks (id INTEGER PRIMARY KEY, body BLOB)');

  const out: Segment[] = [];
  const rowBytes = 4096;
  const rows = Math.floor((sizeMiB * MiB) / rowBytes);

  if (only === 0) {
    const t0 = now();
    const insert = db.prepare('INSERT INTO blocks (id, body) VALUES (?, ?)');
    db.exec('BEGIN');
    for (let i = 0; i < rows; i++) insert.run(i, payload(rowBytes, seed + i));
    db.exec('COMMIT');
    out.push({
      name: 'sqlite-fill',
      bytesWritten: rows * rowBytes,
      pathsTouched: 1,
      wallMs: now() - t0,
    });
    db.close();
    return out;
  }

  // In-place rewrites scattered across the file. One path touched, tens of MiB
  // of dirty pages: the case where file granularity and page granularity give
  // wildly different answers.
  const update = db.prepare('UPDATE blocks SET body = ? WHERE id = ?');
  const perSegment = Math.max(1, Math.floor(rows / (segments * 10)));
  for (let segment = 0; segment < segments; segment++) {
    if (segment + 1 !== only) continue;
    const s0 = now();
    db.exec('BEGIN');
    for (let k = 0; k < perSegment; k++) {
      const id = (k * 7919 + segment * 104_729) % rows;
      update.run(payload(rowBytes, seed + 500_000 + segment * 1000 + k), id);
    }
    db.exec('COMMIT');
    out.push({
      name: `sqlite-rewrite-${segment + 1}`,
      bytesWritten: perSegment * rowBytes,
      pathsTouched: 1,
      wallMs: now() - s0,
    });
  }
  db.close();
  return out;
}

async function main(): Promise<number> {
  const root = arg('root');
  const seed = Number.parseInt(arg('seed', '20260824'), 10);
  const workload = arg('workload');
  const segments = Number.parseInt(arg('segments', '4'), 10);
  // WHICH segment. The driver invokes once per segment and checkpoints between,
  // because a tick taken after the whole workload measures a cold archive rather
  // than an incremental cost.
  const only = Number.parseInt(arg('segment', '0'), 10);

  mkdirSync(root, { recursive: true });
  let segs: Segment[];
  switch (workload) {
    case 'npm':
      segs = npmLike(root, seed, Number.parseInt(arg('target-mib', '400'), 10), segments, only);
      break;
    case 'git':
      segs = gitLike(
        root, seed,
        Number.parseInt(arg('files', '2000'), 10),
        Number.parseInt(arg('commits', '200'), 10),
        Number.parseInt(arg('touch-percent', '5'), 10),
        segments, only,
      );
      break;
    case 'sqlite':
      segs = sqliteRewrite(root, seed, Number.parseInt(arg('size-mib', '64'), 10), segments, only);
      break;
    default:
      process.stdout.write(JSON.stringify({ schema: 'r2-bench/decisive@1', error: `unknown workload ${workload}` }));
      return 2;
  }

  let treeBytes = 0;
  try {
    treeBytes = Number(
      execFileSync('sh', ['-c', `du -sb ${root} 2>/dev/null | cut -f1`], { encoding: 'utf8' }).trim(),
    );
  } catch (error) {
    // TOLERATED AND RECORDED: `du` may be absent from the image, and a missing
    // coreutil is not a measurement failure. -1 means unmeasured, which the
    // report renders as such instead of inventing a tree size — and the reason
    // goes to stderr so the stdout JSON contract is untouched.
    process.stderr.write(
      `tree size unmeasured: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    treeBytes = -1;
  }

  process.stdout.write(JSON.stringify({
    schema: 'r2-bench/decisive@1',
    workload,
    root,
    seed,
    segments: segs,
    treeBytes,
  }));
  return 0;
}

if (import.meta.main) process.exit(await main());
