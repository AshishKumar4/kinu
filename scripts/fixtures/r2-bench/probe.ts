#!/usr/bin/env bun
/**
 * The in-container half of the R2 workspace benchmark. Everything timed is
 * timed HERE, inside the container, with a monotonic clock — never across the
 * Worker RPC boundary, because a Durable Object round trip is tens of
 * milliseconds and would swamp a 4 KiB read.
 *
 * The driver (`scripts/bench-r2-workspace.ts`) writes this file into the
 * container, runs it once per phase per repetition, and reads the single JSON
 * object it prints on stdout. Diagnostics go to stderr so stdout stays
 * machine-readable.
 *
 * Determinism is a property of this file, not of the caller: sizes, file names,
 * byte patterns and random offsets all derive from `--seed`, so two runs of the
 * same revision perform the same operations in the same order against the same
 * bytes. Without that, comparing two layouts compares two workloads.
 *
 * Every phase is independently fallible. A layout where symlinks do not exist
 * must still report its read throughput, so a phase records
 * `{status:'failed', error}` and the run continues. A harness that aborts on
 * the first ENOTSUP cannot measure the filesystem that made it fail, which is
 * exactly the filesystem under test.
 */

import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync,
  writeSync, chmodSync, linkSync, utimesSync, readdirSync, appendFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { randomOffsets, summarize, throughputMiBs, type Summary } from './stats';

const MiB = 1024 * 1024;
const KiB = 1024;

/** Sequential sizes the acceptance criterion names. */
const SEQ_SIZES_MIB = [1, 10, 100] as const;
/** Small-file counts the acceptance criterion names. */
const SMALL_COUNTS = [1_000, 10_000] as const;
/** Random-IO block size, and the file the blocks are drawn from. */
const RANDOM_BLOCK = 4 * KiB;
const RANDOM_FILE_MIB = 32;
const RANDOM_OPS = 512;
/** Bytes per small file. Small enough that the cost is per-object, not per-byte. */
const SMALL_FILE_BYTES = 256;

/**
 * How long any one measured LOOP may run before it stops early and reports how
 * far it got.
 *
 * MEASURED, NOT ASSUMED: 10,000 files × four operations on the untuned R2 mount
 * is hours, not minutes — the calibration run put a single small operation in
 * the hundreds of milliseconds. Without a budget the phase hits the exec
 * timeout, the arm reports nothing at all, and the comparison the benchmark
 * exists to make is lost for the arm that needed it most.
 *
 * The budget is a bound on n, NOT on what is reported. Per-operation latency is
 * comparable across arms at different n, which is exactly why the report leads
 * with p50 and p95 rather than with totals; and every truncated loop emits a
 * verdict naming the count it reached, so a partial sample can never be read as
 * a complete one. `--budget-ms 0` disables it for an operator with time to burn.
 */
const DEFAULT_LOOP_BUDGET_MS = 30_000;

/** Set from `--budget-ms`. 0 disables the bound entirely. */
let loopBudgetMs = DEFAULT_LOOP_BUDGET_MS;

/**
 * `--budget-ms` bounds a PHASE, and each of that phase's timed groups gets an
 * equal, non-transferable share of it.
 *
 * Per-loop was a suggestion rather than a bound. `phaseNpmLike` calls `timedLoop`
 * once per package, so `--budget-ms 1` opened forty deadlines and nearly the whole
 * install pass ran inside a one-millisecond budget. The ceiling that actually
 * kills a run is the platform's per-exec limit, which no budget raises, and it
 * applies to the phase.
 *
 * One shared deadline was worse. The first loop spends the budget and the rest of
 * the phase reports nothing, so `phaseSmallSized` would fund creates out of stat,
 * read and delete — the operation an object store is least bad at, paid for by
 * the three that separate the arms, since stat and readdir are a LIST plus a HEAD
 * per entry. A bound that reliably starves the decisive metrics is choosing which
 * question the benchmark answers.
 *
 * So the split is equal, and a group that finishes early keeps its remainder:
 * donating it back reintroduces that same first-come starvation. The divisor is a
 * structural fact each phase states about itself, not a tuning constant, and
 * total phase time still lands inside `--budget-ms`.
 *
 * Both readings were measured on 2026-08-24, on one developer machine, at
 * `--budget-ms 1`: per-loop passed 476 of 480 npmlike writes and 552 small1k
 * operations across four deadlines; one shared deadline passed 145 creates and
 * zero stat, read or delete. Exact counts track the host and vary between runs
 * on the same host. The structure above does not.
 */
let loopShareMs = Number.POSITIVE_INFINITY;
let groupDeadline = Number.POSITIVE_INFINITY;

/** Declared by a phase: how many timed groups it contains. A single timed
 *  operation is not a group, so `small-readdir` and the random flush are not in
 *  any divisor. */
function openPhaseBudget(groups: number): void {
  loopShareMs = loopBudgetMs === 0 || groups <= 0
    ? Number.POSITIVE_INFINITY
    : loopBudgetMs / groups;
  groupDeadline = Number.POSITIVE_INFINITY;
}

/** Start the next group's share. Every `timedLoop` until the following call
 *  shares this one deadline, which is what makes 40 per-package calls one group. */
function openTimedGroup(): void {
  groupDeadline = loopShareMs === Number.POSITIVE_INFINITY
    ? Number.POSITIVE_INFINITY
    : now() + loopShareMs;
}

/** The share a phase's groups ran under, for the payload. Absent when the phase
 *  has no timed group and nothing was bounded. */
function phaseShareMs(): number | undefined {
  return loopShareMs === Number.POSITIVE_INFINITY ? undefined : loopShareMs;
}

const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);

/**
 * Run `body` over `items`, timing each call, stopping early once the current
 * group's share is spent. Returns the latencies AND how many items were
 * attempted, so a caller can report the real n rather than the intended one.
 */
function timedLoop<T>(items: readonly T[], body: (item: T) => void) {
  const latencies: number[] = [];
  for (const item of items) {
    const t0 = now();
    body(item);
    latencies.push(now() - t0);
    if (now() > groupDeadline) break;
  }
  return { latencies, done: latencies.length };
}

/** Every phase this file can run. `--phase` is checked against it by name, so an
 *  unknown phase is refused before any work starts rather than asserted into the
 *  union and dispatched to nothing. */
const PHASE_NAMES = [
  'seq', 'seq1', 'seq10', 'seq100',
  'rand', 'small', 'small1k', 'small10k',
  'posix', 'archive', 'npmlike', 'gitlike',
  'seed-durability', 'verify-durability',
] as const;

type PhaseName = (typeof PHASE_NAMES)[number];

function isPhaseName(raw: string): raw is PhaseName {
  return PHASE_NAMES.some((name) => name === raw);
}

interface Metric {
  readonly name: string;
  /** Per-operation latencies in ms, when the phase measures many operations. */
  readonly summary: Summary;
  /** Total wall time for the whole metric in ms. */
  readonly wallMs: number;
  /** Bytes moved, when meaningful. */
  readonly bytes?: number;
  /** MiB/s derived from bytes and wallMs. */
  readonly throughputMiBs?: number;
  /** Operations the metric performed, for op-cost arithmetic. */
  readonly ops?: number;
}

interface Verdict {
  readonly name: string;
  readonly holds: boolean;
  /** What was observed. Present whether or not the invariant held. */
  readonly detail: string;
}

interface PhaseResult {
  readonly phase: PhaseName;
  readonly status: 'ok' | 'failed';
  readonly wallMs: number;
  readonly cpuUserMs: number;
  readonly cpuSystemMs: number;
  /** The equal share each of this phase's timed groups ran under. Absent when
   *  the phase has no timed group, so nothing here was bounded. Divide
   *  `loopBudgetMs` by it to recover the group count. */
  readonly loopBudgetShareMs?: number;
  readonly metrics: readonly Metric[];
  readonly verdicts: readonly Verdict[];
  readonly error?: string;
}

/**
 * What a phase hands back. Its two fields are the two the emitted `PhaseResult`
 * carries verbatim, so a phase that drifts from the consumer contract in
 * `./report.ts` fails to compile here instead of failing to parse at the driver.
 */
interface PhaseOutcome {
  readonly metrics: readonly Metric[];
  readonly verdicts: readonly Verdict[];
}

/** Environment provenance. Each field holds one command's own output, or that
 *  command's own refusal text when it is absent. */
interface EnvironmentFacts {
  readonly uname: string;
  readonly nproc: string;
  readonly memTotal: string;
  readonly bun: string;
  readonly git: string;
  readonly tar: string;
  readonly mounts: string;
  readonly df: string;
  readonly s3fsVersion: string;
}

/**
 * The one object this file prints on stdout. It mirrors `ProbeRun` in
 * `./report.ts`, which cannot be imported here: that module resolves valibot out
 * of node_modules, and this file is uploaded as source into a container that has
 * none. `loopBudgetMs` is declared on both sides because every summary below is a
 * sample the budget bounded, and `loopBudgetScope` says what it scoped.
 */
interface ProbePayload {
  readonly schema: string;
  readonly root: string;
  readonly seed: number;
  readonly loopBudgetMs: number;
  readonly loopBudgetScope: 'phase';
  readonly phases: readonly PhaseResult[];
  readonly facts?: EnvironmentFacts;
}

/** Clock ticks per second, for /proc child-CPU accounting. */
function clockTicks(): number {
  try {
    return Number.parseInt(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim(), 10) || 100;
  } catch (error) {
    process.stderr.write(`[probe] getconf CLK_TCK unavailable (${String(error)}); assuming 100 ticks/s\n`);
    return 100;
  }
}
const CLK_TCK = clockTicks();

/**
 * CPU consumed by this process AND by every child it has already reaped.
 * `process.cpuUsage()` covers only self, and three of the phases below are
 * dominated by `tar` and `git`, so self-only accounting would report those
 * phases as free.
 */
function cpuSnapshot() {
  const self = process.cpuUsage();
  let childUser = 0;
  let childSystem = 0;
  try {
    const stat = readFileSync('/proc/self/stat', 'utf8');
    // The comm field may contain spaces and parentheses, so fields are counted
    // from the last ')' rather than from the start of the line.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    // After comm and state, utime/stime/cutime/cstime are fields 12..15 here.
    childUser = (Number(fields[11] ?? 0) / CLK_TCK) * 1000;
    childSystem = (Number(fields[12] ?? 0) / CLK_TCK) * 1000;
  } catch (error) {
    process.stderr.write(`[probe] /proc/self/stat unreadable (${String(error)}); CPU excludes reaped children\n`);
  }
  return {
    userMs: self.user / 1000 + childUser,
    systemMs: self.system / 1000 + childSystem,
  };
}

const now = (): number => Number(process.hrtime.bigint() / 1000n) / 1000;

/** A deterministic, incompressible-enough payload. A block of zeroes would let
 *  any layer in the stack cheat, and R2 does not compress, so the point is
 *  reproducibility rather than entropy. */
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

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/**
 * Write a file and make it durable, timing the two separately. On a FUSE mount
 * `close()` is where the object upload happens, so a write timed without its
 * flush reports the memcpy and not the storage.
 */
function writeAndSync(path: string, data: Buffer) {
  const fd = openSync(path, 'w');
  try {
    const w0 = now();
    let written = 0;
    while (written < data.length) written += writeSync(fd, data, written, data.length - written);
    const w1 = now();
    // s3fs implements fsync as a flush of the whole object; on native disk it is
    // a barrier. Both are the cost of "the bytes are now safe", which is the
    // only write number a workspace cares about.
    let syncRefusal = '';
    try {
      fsyncSync(fd);
    } catch (error) {
      syncRefusal = String(error);
    }
    const w2 = now();
    // Recorded outside the w1..w2 window: a pipe write costs more than the
    // refusal it reports, so logging inside it would BE the measurement. The
    // close below still flushes and the posix phase carries the verdict.
    if (syncRefusal !== '') process.stderr.write(`[probe] fsync refused for ${path} (${syncRefusal})\n`);
    return { writeMs: w1 - w0, syncMs: w2 - w1 };
  } finally {
    closeSync(fd);
  }
}

function readWhole(path: string) {
  const t0 = now();
  const buf = readFileSync(path);
  return { ms: now() - t0, bytes: buf.length };
}

// ── phases ──────────────────────────────────────────────────────────────────

function phaseSeqSized(
  root: string,
  seed: number,
  sizes: readonly number[],
): PhaseOutcome {
  const dir = join(root, 'seq');
  ensureDir(dir);
  const metrics: Metric[] = [];
  const verdicts: Verdict[] = [];
  for (const mib of sizes) {
    const bytes = mib * MiB;
    const path = join(dir, `seq-${mib}m.bin`);
    const data = payload(bytes, seed + mib);
    const w = writeAndSync(path, data);
    metrics.push({
      name: `write-${mib}MiB`,
      summary: summarize([w.writeMs + w.syncMs]),
      wallMs: w.writeMs + w.syncMs,
      bytes,
      throughputMiBs: throughputMiBs(bytes, w.writeMs + w.syncMs),
      ops: 1,
    });
    metrics.push({
      name: `fsync-${mib}MiB`,
      summary: summarize([w.syncMs]),
      wallMs: w.syncMs,
      ops: 1,
    });
    const r = readWhole(path);
    metrics.push({
      name: `read-${mib}MiB`,
      summary: summarize([r.ms]),
      wallMs: r.ms,
      bytes: r.bytes,
      throughputMiBs: throughputMiBs(r.bytes, r.ms),
      ops: 1,
    });
    // Re-read immediately. On a cached mount this is the cache; on an uncached
    // one it is a second GET. The gap between the two IS the cache measurement,
    // and it is the number the tuned arm exists to produce.
    const r2 = readWhole(path);
    metrics.push({
      name: `reread-${mib}MiB`,
      summary: summarize([r2.ms]),
      wallMs: r2.ms,
      bytes: r2.bytes,
      throughputMiBs: throughputMiBs(r2.bytes, r2.ms),
      ops: 1,
    });
    verdicts.push({
      name: `content-roundtrip-${mib}MiB`,
      holds: r.bytes === bytes,
      detail: `wrote ${bytes} read ${r.bytes}`,
    });
  }
  return { metrics, verdicts };
}

function phaseRand(root: string, seed: number): PhaseOutcome {
  const dir = join(root, 'rand');
  ensureDir(dir);
  const path = join(dir, 'rand.bin');
  const bytes = RANDOM_FILE_MIB * MiB;
  writeAndSync(path, payload(bytes, seed));

  const offsets = randomOffsets(bytes, RANDOM_BLOCK, RANDOM_OPS, seed);
  const block = Buffer.allocUnsafe(RANDOM_BLOCK);

  // Two timed groups: the read loop and the write loop. The flush is a single
  // timed operation, not a loop, so it is not in the divisor.
  openPhaseBudget(2);

  const readLatencies: number[] = [];
  const rfd = openSync(path, 'r');
  openTimedGroup();
  try {
    const bounded = timedLoop(offsets, (offset) => { readSync(rfd, block, 0, RANDOM_BLOCK, offset); });
    readLatencies.push(...bounded.latencies);
  } finally {
    closeSync(rfd);
  }

  const writeLatencies: number[] = [];
  let flushMs = 0;
  let flushRefusal = '';
  const wfd = openSync(path, 'r+');
  const stamp = payload(RANDOM_BLOCK, seed + 1);
  openTimedGroup();
  try {
    const bounded = timedLoop(offsets, (offset) => { writeSync(wfd, stamp, 0, RANDOM_BLOCK, offset); });
    writeLatencies.push(...bounded.latencies);
    // On s3fs an in-place partial write forces a read-modify-write of the WHOLE
    // object at flush time. Left in the write distribution that single sample is
    // the max and drags p95, so the p95 of a 4 KiB random write would report a
    // whole-object rewrite. It gets its own metric, as `fsync-<n>MiB` does for
    // the sequential phase.
    const f0 = now();
    try {
      fsyncSync(wfd);
    } catch (error) {
      flushRefusal = String(error);
    }
    flushMs = now() - f0;
  } finally {
    closeSync(wfd);
  }
  if (flushRefusal !== '') process.stderr.write(`[probe] fsync refused after random writes (${flushRefusal})\n`);

  const readSummary = summarize(readLatencies);
  const writeSummary = summarize(writeLatencies);
  return {
    metrics: [
      {
        name: `random-read-${RANDOM_BLOCK / KiB}KiB`,
        summary: readSummary,
        wallMs: sum(readLatencies),
        bytes: RANDOM_BLOCK * readLatencies.length,
        ops: readLatencies.length,
      },
      {
        name: `random-write-${RANDOM_BLOCK / KiB}KiB`,
        summary: writeSummary,
        wallMs: sum(writeLatencies),
        bytes: RANDOM_BLOCK * writeLatencies.length,
        ops: writeLatencies.length,
      },
      {
        name: 'random-write-flush',
        summary: summarize([flushMs]),
        wallMs: flushMs,
        ops: 1,
      },
    ],
    verdicts: [{
      name: 'random-io-completed',
      holds: readLatencies.length === RANDOM_OPS && writeLatencies.length === RANDOM_OPS,
      detail: `${readLatencies.length}/${RANDOM_OPS} reads and ${writeLatencies.length}/${RANDOM_OPS}`
        + ` writes at ${RANDOM_BLOCK}B over ${RANDOM_FILE_MIB}MiB`,
    }],
  };
}

function phaseSmallSized(
  root: string,
  seed: number,
  counts: readonly number[],
): PhaseOutcome {
  const metrics: Metric[] = [];
  const verdicts: Verdict[] = [];
  // Four timed groups per file count — create, stat, read, delete. The single
  // readdir is one timed operation, not a loop, so it is not in the divisor.
  // `counts.length` is in it because `--phase small` runs the four twice, and
  // the budget bounds the PHASE.
  openPhaseBudget(4 * counts.length);
  for (const count of counts) {
    const dir = join(root, `small-${count}`);
    ensureDir(dir);
    const data = payload(SMALL_FILE_BYTES, seed + count);
    const names: string[] = [];
    for (let i = 0; i < count; i++) names.push(join(dir, `f${String(i).padStart(6, '0')}.txt`));

    openTimedGroup();
    const create = timedLoop(names, (name) => { writeFileSync(name, data); });
    // Every later operation runs over exactly the files that were created, so a
    // truncated create does not make the read loop measure ENOENT.
    const created = names.slice(0, create.done);
    openTimedGroup();
    const stat = timedLoop(created, (name) => { statSync(name); });
    openTimedGroup();
    const read = timedLoop(created, (name) => { readFileSync(name); });

    // One listing of the whole directory. On an object store a readdir is a
    // LIST plus a HEAD per entry, so it scales differently from the per-file
    // stat above and is worth its own number.
    const l0 = now();
    const listed = readdirSync(dir).length;
    const listMs = now() - l0;

    openTimedGroup();
    const remove = timedLoop(created, (name) => { rmSync(name); });

    const suffix = count >= 1000 ? `${count / 1000}k` : String(count);
    metrics.push(
      { name: `small-create-${suffix}`, summary: summarize(create.latencies), wallMs: sum(create.latencies), ops: create.done, bytes: SMALL_FILE_BYTES * create.done },
      { name: `small-stat-${suffix}`, summary: summarize(stat.latencies), wallMs: sum(stat.latencies), ops: stat.done },
      { name: `small-read-${suffix}`, summary: summarize(read.latencies), wallMs: sum(read.latencies), ops: read.done, bytes: SMALL_FILE_BYTES * read.done },
      { name: `small-readdir-${suffix}`, summary: summarize([listMs]), wallMs: listMs, ops: 1 },
      { name: `small-delete-${suffix}`, summary: summarize(remove.latencies), wallMs: sum(remove.latencies), ops: remove.done },
    );
    verdicts.push({
      name: `small-sample-complete-${suffix}`,
      holds: create.done === count && remove.done === create.done,
      detail: `created ${create.done}/${count}, stat ${stat.done}, read ${read.done}, deleted ${remove.done}`
        + `, readdir saw ${listed}`,
    });
  }
  return { metrics, verdicts };
}

/**
 * POSIX semantics, measured rather than assumed. Each check is a verdict, and a
 * FALSE verdict is a result: the difference between this array on the native
 * control and on an R2 mount is the definitive statement of what an object
 * store cannot do, which no amount of throughput can compensate for.
 */
function phasePosix(root: string, seed: number): PhaseOutcome {
  const dir = join(root, 'posix');
  ensureDir(dir);
  const verdicts: Verdict[] = [];
  const metrics: Metric[] = [];
  const data = payload(1024, seed);

  const check = (name: string, body: () => string): void => {
    try {
      verdicts.push({ name, holds: true, detail: body() });
    } catch (error) {
      verdicts.push({ name, holds: false, detail: error instanceof Error ? error.message : String(error) });
    }
  };

  check('rename-file', () => {
    const from = join(dir, 'rename-a');
    const to = join(dir, 'rename-b');
    writeFileSync(from, data);
    const t0 = now();
    renameSync(from, to);
    const ms = now() - t0;
    if (existsSync(from)) throw new Error('source still present after rename');
    if (readFileSync(to).length !== data.length) throw new Error('content changed across rename');
    metrics.push({ name: 'rename-file', summary: summarize([ms]), wallMs: ms, ops: 1, bytes: data.length });
    return `moved in ${ms.toFixed(2)}ms, source gone, content intact`;
  });

  // A rename measured only at 1 KiB would read as nearly free and would support
  // the wrong conclusion. On an object store a rename is a server-side COPY, so
  // its cost tracks the file's size. Measuring 4 MiB beside the 1 KiB case above
  // makes the size dependence visible instead of inferred — a sibling
  // implementation measured 2.97x for a 1024x size increase against s3fs, and a
  // single small sample would have hidden exactly that.
  check('rename-file-4MiB', () => {
    const bytes = 4 * MiB;
    const from = join(dir, 'rename-big-a');
    const to = join(dir, 'rename-big-b');
    writeAndSync(from, payload(bytes, seed + 4));
    const t0 = now();
    renameSync(from, to);
    const ms = now() - t0;
    if (existsSync(from)) throw new Error('source still present after rename');
    if (statSync(to).size !== bytes) throw new Error(`destination size is ${statSync(to).size}`);
    metrics.push({ name: 'rename-file-4MiB', summary: summarize([ms]), wallMs: ms, ops: 1, bytes });
    return `moved 4MiB in ${ms.toFixed(2)}ms`;
  });

  check('rename-over-existing', () => {
    const from = join(dir, 'ovr-a');
    const to = join(dir, 'ovr-b');
    writeFileSync(from, Buffer.from('new'));
    writeFileSync(to, Buffer.from('old'));
    renameSync(from, to);
    const got = readFileSync(to, 'utf8');
    if (got !== 'new') throw new Error(`destination holds ${JSON.stringify(got)}`);
    return 'atomic replace observed';
  });

  check('rename-directory', () => {
    const from = join(dir, 'dirA');
    const to = join(dir, 'dirB');
    ensureDir(join(from, 'nested'));
    writeFileSync(join(from, 'nested', 'f'), data);
    const t0 = now();
    renameSync(from, to);
    const ms = now() - t0;
    if (!existsSync(join(to, 'nested', 'f'))) throw new Error('nested file lost');
    metrics.push({ name: 'rename-directory', summary: summarize([ms]), wallMs: ms, ops: 1 });
    return `subtree moved in ${ms.toFixed(2)}ms`;
  });

  check('fsync-file', () => {
    const path = join(dir, 'fsync-target');
    const fd = openSync(path, 'w');
    try {
      writeSync(fd, data, 0, data.length);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return 'fsync accepted';
  });

  check('fsync-directory', () => {
    // The durability barrier a database or a git index relies on. Object stores
    // routinely refuse it, and code that assumes it silently loses ordering.
    const fd = openSync(dir, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return 'directory fsync accepted';
  });

  check('symlink-roundtrip', () => {
    const target = join(dir, 'sym-target');
    const link = join(dir, 'sym-link');
    writeFileSync(target, data);
    symlinkSync('sym-target', link);
    const seen = readlinkSync(link);
    if (seen !== 'sym-target') throw new Error(`readlink returned ${JSON.stringify(seen)}`);
    if (!lstatSync(link).isSymbolicLink()) throw new Error('lstat does not report a symlink');
    if (readFileSync(link).length !== data.length) throw new Error('following the link failed');
    return 'created, readlink and follow both correct';
  });

  check('hardlink', () => {
    const target = join(dir, 'hard-target');
    const link = join(dir, 'hard-link');
    writeFileSync(target, data);
    linkSync(target, link);
    if (statSync(link).nlink < 2) throw new Error(`nlink is ${statSync(link).nlink}`);
    return 'nlink >= 2';
  });

  check('permissions-preserved', () => {
    const path = join(dir, 'perm-target');
    writeFileSync(path, data);
    chmodSync(path, 0o640);
    const mode = statSync(path).mode & 0o777;
    if (mode !== 0o640) throw new Error(`mode reads back as ${mode.toString(8)}`);
    return 'chmod 640 read back exactly';
  });

  check('executable-bit', () => {
    const path = join(dir, 'exec-target');
    writeFileSync(path, Buffer.from('#!/bin/sh\nexit 0\n'));
    chmodSync(path, 0o755);
    const mode = statSync(path).mode & 0o777;
    if (mode !== 0o755) throw new Error(`mode reads back as ${mode.toString(8)}`);
    execFileSync(path, [], { stdio: 'ignore' });
    return 'mode 755 preserved and the file executed';
  });

  check('mtime-preserved', () => {
    const path = join(dir, 'mtime-target');
    writeFileSync(path, data);
    const when = new Date(1_700_000_000_000);
    utimesSync(path, when, when);
    const got = statSync(path).mtime.getTime();
    if (Math.abs(got - when.getTime()) > 1000) throw new Error(`mtime is ${got}, wanted ${when.getTime()}`);
    return 'explicit mtime survived within 1s';
  });

  check('empty-directory-persists', () => {
    const path = join(dir, 'empty-dir');
    ensureDir(path);
    if (!statSync(path).isDirectory()) throw new Error('not a directory after mkdir');
    if (readdirSync(dir).indexOf('empty-dir') === -1) throw new Error('absent from parent listing');
    return 'present and listed';
  });

  check('append', () => {
    const path = join(dir, 'append-target');
    writeFileSync(path, Buffer.from('a'));
    appendFileSync(path, Buffer.from('b'));
    const got = readFileSync(path, 'utf8');
    if (got !== 'ab') throw new Error(`file holds ${JSON.stringify(got)}`);
    return 'append produced "ab"';
  });

  check('truncate-then-grow', () => {
    const path = join(dir, 'trunc-target');
    writeFileSync(path, payload(4096, seed));
    const fd = openSync(path, 'r+');
    try {
      writeSync(fd, Buffer.from('x'), 0, 1, 8191);
    } finally {
      closeSync(fd);
    }
    if (statSync(path).size !== 8192) throw new Error(`size is ${statSync(path).size}`);
    return 'sparse extension to 8192 bytes';
  });

  check('case-sensitivity', () => {
    writeFileSync(join(dir, 'CaseFile'), Buffer.from('upper'));
    writeFileSync(join(dir, 'casefile'), Buffer.from('lower'));
    const upper = readFileSync(join(dir, 'CaseFile'), 'utf8');
    if (upper !== 'upper') throw new Error('names collapsed: distinct cases share bytes');
    return 'two names, two files';
  });

  check('delete-visibility', () => {
    const path = join(dir, 'delete-target');
    writeFileSync(path, data);
    rmSync(path);
    if (existsSync(path)) throw new Error('still visible after unlink');
    return 'unlink immediately visible';
  });

  return { metrics, verdicts };
}

function phaseArchive(root: string, seed: number): PhaseOutcome {
  const stage = join(root, 'archive');
  const src = join(stage, 'src');
  const out = join(stage, 'out');
  ensureDir(src);
  ensureDir(out);
  // A deterministic tree: 300 files across 10 directories. Built on the LOCAL
  // disk regardless of layout, so the measurement is extraction into the layout
  // rather than a mix of creating and extracting.
  const build = join('/tmp', `bench-archive-src-${seed}`);
  rmSync(build, { recursive: true, force: true });
  for (let d = 0; d < 10; d++) {
    const sub = join(build, `d${d}`);
    mkdirSync(sub, { recursive: true });
    for (let f = 0; f < 30; f++) writeFileSync(join(sub, `f${f}.txt`), payload(2048, seed + d * 100 + f));
  }
  const tarball = join('/tmp', `bench-archive-${seed}.tar.gz`);
  rmSync(tarball, { force: true });
  execFileSync('tar', ['-czf', tarball, '-C', build, '.'], { stdio: 'ignore' });

  const t0 = now();
  execFileSync('tar', ['-xzf', tarball, '-C', out], { stdio: 'ignore' });
  const extractMs = now() - t0;

  // Bytes that LANDED, not the archive that was read. The tarball is the input,
  // and on this high-entropy payload gzip makes it LARGER than its contents, so
  // charging it overstated what the layout stored. Measured 2026-08-24 at
  // `--seed 1`: 620615 compressed against 614400 landed, which is deterministic
  // for a given seed. Summed in the walk that already counts the files.
  let extracted = 0;
  let landedBytes = 0;
  for (let d = 0; d < 10; d++) {
    const dir = join(out, `d${d}`);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      extracted += 1;
      landedBytes += statSync(join(dir, name)).size;
    }
  }
  rmSync(build, { recursive: true, force: true });
  rmSync(tarball, { force: true });

  return {
    metrics: [{
      name: 'archive-extract-300-files',
      summary: summarize([extractMs]),
      wallMs: extractMs,
      bytes: landedBytes,
      ops: extracted,
    }],
    verdicts: [{
      name: 'archive-extract-complete',
      holds: extracted === 300,
      detail: `${extracted}/300 files present after extraction`,
    }],
  };
}

/**
 * The shape of a dependency install, without the network: write many small
 * files across a deep tree, then walk it the way a module resolver does —
 * stat-ing paths that mostly do not exist. The negative-lookup half is the
 * reason `enable_noobj_cache` is in the option set, so the workload has to
 * contain it or the option is untested.
 */
function phaseNpmLike(root: string, seed: number): PhaseOutcome {
  const modules = join(root, 'npmlike', 'node_modules');
  ensureDir(modules);
  const packages = 40;
  const filesPer = 12;

  // Two timed groups: the whole install write pass, and the resolution walk.
  // The forty per-package calls below are ONE group, so they share one share.
  openPhaseBudget(2);

  const writeLatencies: number[] = [];
  const mkdirLatencies: number[] = [];
  openTimedGroup();
  for (let p = 0; p < packages; p++) {
    const pkg = join(modules, `pkg-${p}`);
    // One call, two levels: on an object store each level is its own PUT, so
    // `ops` counts calls issued rather than directories materialised, because
    // the sample count and the op count have to describe the same thing.
    const m0 = now();
    mkdirSync(join(pkg, 'dist'), { recursive: true });
    mkdirLatencies.push(now() - m0);
    const files = [
      join(pkg, 'package.json'),
      ...Array.from({ length: filesPer - 1 }, (_, i) => join(pkg, 'dist', `m${i}.js`)),
    ];
    const bounded = timedLoop(files, (file) => { writeFileSync(file, payload(1024, seed + p * 100)); });
    writeLatencies.push(...bounded.latencies);
  }

  // Resolution walk: for each package, probe the five paths Node tries before
  // it finds the entry point. Four of the five are misses. Built as one list so
  // the walk is a timed group like any other and cannot outrun the phase budget.
  const candidates: string[] = [];
  for (let p = 0; p < packages; p++) {
    const pkg = join(modules, `pkg-${p}`);
    for (const candidate of ['index.js', 'index.mjs', 'index.json', 'dist/m0.js', 'package.json']) {
      candidates.push(join(pkg, candidate));
    }
  }
  let hits = 0;
  openTimedGroup();
  const probe = timedLoop(candidates, (candidate) => { if (existsSync(candidate)) hits += 1; });

  return {
    metrics: [
      {
        name: 'npmlike-install-mkdir',
        summary: summarize(mkdirLatencies),
        wallMs: sum(mkdirLatencies),
        ops: mkdirLatencies.length,
      },
      {
        name: 'npmlike-install-write',
        summary: summarize(writeLatencies),
        wallMs: sum(writeLatencies),
        ops: writeLatencies.length,
        bytes: 1024 * writeLatencies.length,
      },
      {
        name: 'npmlike-resolve-probe',
        summary: summarize(probe.latencies),
        wallMs: sum(probe.latencies),
        ops: probe.done,
      },
    ],
    verdicts: [{
      name: 'npmlike-resolution-shape',
      holds: probe.done === candidates.length && hits === packages * 2,
      detail: `${hits} hits of ${probe.done}/${candidates.length} probes`
        + ` (expected ${packages * 2}: dist/m0.js and package.json)`,
    }],
  };
}

/**
 * Git on the layout. This is the workload most likely to expose a semantic gap
 * rather than a slow one: git relies on rename atomicity for its lock files,
 * on directory fsync for index durability, and on the executable bit surviving
 * a checkout.
 */
function phaseGitLike(root: string, seed: number): PhaseOutcome {
  const repo = join(root, 'gitlike');
  rmSync(repo, { recursive: true, force: true });
  ensureDir(repo);
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
  const git = (args: string[]): number => {
    const t0 = now();
    execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore', env });
    return now() - t0;
  };

  const metrics: Metric[] = [];
  const verdicts: Verdict[] = [];

  const initMs = git(['init', '-q', '-b', 'main']);
  metrics.push({ name: 'git-init', summary: summarize([initMs]), wallMs: initMs, ops: 1 });

  for (let i = 0; i < 120; i++) {
    writeFileSync(join(repo, `src${i}.txt`), payload(512, seed + i));
  }
  const addMs = git(['add', '-A']);
  metrics.push({ name: 'git-add-120', summary: summarize([addMs]), wallMs: addMs, ops: 120 });

  const commitMs = git(['commit', '-q', '-m', 'bench']);
  metrics.push({ name: 'git-commit', summary: summarize([commitMs]), wallMs: commitMs, ops: 1 });

  const statusMs = git(['status', '--porcelain']);
  metrics.push({ name: 'git-status-clean', summary: summarize([statusMs]), wallMs: statusMs, ops: 1 });

  writeFileSync(join(repo, 'src0.txt'), payload(512, seed + 9999));
  const dirtyMs = git(['status', '--porcelain']);
  metrics.push({ name: 'git-status-dirty', summary: summarize([dirtyMs]), wallMs: dirtyMs, ops: 1 });

  const logMs = git(['log', '--oneline']);
  metrics.push({ name: 'git-log', summary: summarize([logMs]), wallMs: logMs, ops: 1 });

  verdicts.push({
    name: 'git-repository-usable',
    holds: existsSync(join(repo, '.git', 'HEAD')),
    detail: 'init, add, commit, status and log all completed',
  });
  return { metrics, verdicts };
}

/** The manifest a restart must not lose: 24 fixed names at fixed sizes. Only the
 *  LAYOUT lives here — the seed belongs to the callers, which write
 *  `payload(entry.bytes, seed + entry.bytes)` and recompute exactly that on the
 *  verify side, so the check compares bytes rather than mere existence. */
const DURABILITY_FILES = 24;

function durabilityManifest(root: string) {
  const dir = join(root, 'durability');
  const entries = Array.from({ length: DURABILITY_FILES }, (_, i) => ({
    name: `d${String(i).padStart(3, '0')}.bin`,
    bytes: 1024 + i * 37,
  }));
  return { path: dir, entries };
}

function phaseSeedDurability(root: string, seed: number): PhaseOutcome {
  const { path, entries } = durabilityManifest(root);
  ensureDir(path);
  const latencies: number[] = [];
  for (const entry of entries) {
    const t0 = now();
    writeAndSync(join(path, entry.name), payload(entry.bytes, seed + entry.bytes));
    latencies.push(now() - t0);
  }
  return {
    metrics: [{
      name: 'durability-seed',
      summary: summarize(latencies),
      wallMs: sum(latencies),
      ops: latencies.length,
    }],
    verdicts: [{ name: 'durability-seeded', holds: true, detail: `${entries.length} files written and fsynced` }],
  };
}

function phaseVerifyDurability(root: string, seed: number): PhaseOutcome {
  const { path, entries } = durabilityManifest(root);
  let intact = 0;
  let missing = 0;
  let corrupt = 0;
  const latencies: number[] = [];
  for (const entry of entries) {
    const t0 = now();
    const file = join(path, entry.name);
    if (existsSync(file)) {
      const got = readFileSync(file);
      if (got.length !== entry.bytes || !got.equals(payload(entry.bytes, seed + entry.bytes))) corrupt++;
      else intact++;
    } else {
      missing++;
    }
    latencies.push(now() - t0);
  }
  return {
    metrics: [{
      name: 'durability-verify',
      summary: summarize(latencies),
      wallMs: sum(latencies),
      ops: latencies.length,
    }],
    verdicts: [{
      name: 'durability-survived-restart',
      holds: intact === entries.length,
      detail: `${intact} intact, ${missing} missing, ${corrupt} corrupt of ${entries.length}`,
    }],
  };
}

// ── driver ──────────────────────────────────────────────────────────────────

/** One runner per phase name, so a name added to `PHASE_NAMES` without an entry
 *  here is a compile error. */
type PhaseRunner = (root: string, seed: number) => PhaseOutcome;

const PHASES = {
  seq: (root, seed) => phaseSeqSized(root, seed, SEQ_SIZES_MIB),
  seq1: (root, seed) => phaseSeqSized(root, seed, [1]),
  seq10: (root, seed) => phaseSeqSized(root, seed, [10]),
  seq100: (root, seed) => phaseSeqSized(root, seed, [100]),
  small1k: (root, seed) => phaseSmallSized(root, seed, [1_000]),
  small10k: (root, seed) => phaseSmallSized(root, seed, [10_000]),
  rand: phaseRand,
  small: (root, seed) => phaseSmallSized(root, seed, SMALL_COUNTS),
  posix: phasePosix,
  archive: phaseArchive,
  npmlike: phaseNpmLike,
  gitlike: phaseGitLike,
  'seed-durability': phaseSeedDurability,
  'verify-durability': phaseVerifyDurability,
} satisfies Record<PhaseName, PhaseRunner>;

function arg(name: string, fallback?: string): string {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index !== -1 && index + 1 < process.argv.length) return process.argv[index + 1]!;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing required argument ${flag}`);
}

function environmentFacts(): EnvironmentFacts {
  const read = (command: string, args: string[]): string => {
    try {
      return execFileSync(command, args, { encoding: 'utf8' }).trim();
    } catch (error) {
      return `unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
  return {
    uname: read('uname', ['-a']),
    nproc: read('nproc', []),
    memTotal: read('sh', ['-c', "grep MemTotal /proc/meminfo || echo unknown"]),
    bun: read('bun', ['--version']),
    git: read('git', ['--version']),
    tar: read('tar', ['--version']).split('\n')[0] ?? '',
    mounts: read('sh', ['-c', 'cat /proc/mounts']),
    df: read('sh', ['-c', 'df -PT']),
    s3fsVersion: read('sh', ['-c', 's3fs --version 2>&1 | head -1 || echo absent']),
  };
}

function main(): number {
  const root = arg('root');
  const seed = Number.parseInt(arg('seed', '20260824'), 10);
  const requested = arg('phase', 'all');
  const wantFacts = process.argv.includes('--facts');
  loopBudgetMs = Number.parseInt(arg('budget-ms', String(DEFAULT_LOOP_BUDGET_MS)), 10);

  const names: PhaseName[] = [];
  if (requested === 'all') {
    names.push('posix', 'seq1', 'seq10', 'seq100', 'rand', 'archive', 'npmlike', 'gitlike', 'small1k', 'small10k');
  } else {
    for (const raw of requested.split(',')) {
      const name = raw.trim();
      if (!isPhaseName(name)) {
        process.stdout.write(JSON.stringify({ schema: 'r2-bench/probe@1', error: `unknown phase ${name}` }));
        return 2;
      }
      names.push(name);
    }
  }

  ensureDir(root);
  const results: PhaseResult[] = [];
  for (const name of names) {
    const cpu0 = cpuSnapshot();
    // Reset to unbounded so a multi-phase run cannot inherit the previous
    // phase's share; a phase with timed groups declares its own divisor.
    openPhaseBudget(0);
    const t0 = now();
    try {
      const { metrics, verdicts } = PHASES[name](root, seed);
      const cpu1 = cpuSnapshot();
      results.push({
        phase: name,
        status: 'ok',
        wallMs: now() - t0,
        cpuUserMs: cpu1.userMs - cpu0.userMs,
        cpuSystemMs: cpu1.systemMs - cpu0.systemMs,
        loopBudgetShareMs: phaseShareMs(),
        metrics,
        verdicts,
      });
    } catch (error) {
      const cpu1 = cpuSnapshot();
      results.push({
        phase: name,
        status: 'failed',
        wallMs: now() - t0,
        cpuUserMs: cpu1.userMs - cpu0.userMs,
        cpuSystemMs: cpu1.systemMs - cpu0.systemMs,
        metrics: [],
        verdicts: [],
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
    }
  }

  const run: ProbePayload = {
    schema: 'r2-bench/probe@1',
    root,
    seed,
    loopBudgetMs,
    loopBudgetScope: 'phase',
    phases: results,
    facts: wantFacts ? environmentFacts() : undefined,
  };
  const payloadJson = JSON.stringify(run);
  // `--out` exists for the groups that cannot be driven by a blocking exec: the
  // probe runs as a detached process, writes its result here, and the driver
  // polls for the sentinel rather than holding a request open past the
  // platform's per-exec ceiling. The sentinel is written AFTER the payload, so a
  // sentinel that exists always names a complete file.
  const outPath = process.argv.includes('--out') ? arg('out') : '';
  if (outPath === '') {
    process.stdout.write(payloadJson);
  } else {
    writeFileSync(outPath, payloadJson);
    writeFileSync(`${outPath}.done`, String(results.every((r) => r.status === 'ok') ? 0 : 1));
  }
  return results.every((r) => r.status === 'ok') ? 0 : 1;
}

if (import.meta.main) process.exit(main());
