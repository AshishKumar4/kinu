/**
 * THE MEASUREMENT BEHIND THE WAVE'S COST MODEL. One row at a time, alone.
 *
 * A row's declared cost was a number nobody took, and on 2026-09-16 five rows
 * died on a deadline because of it (see scripts/gate-cost.ts). These are the
 * figures that replaced the declaration, and how they are taken:
 *
 *   - peak resident set: the SUM of the session's PROPORTIONAL set (Pss)
 *     pages at one instant. `/usr/bin/time -v`'s "maximum resident set size"
 *     is the largest SINGLE child, which reads four 1 GiB workers as 1 GiB —
 *     the figure that would have hidden the 137 — and summed RSS counts one
 *     shared page once per process that maps it, which reads ~110 Chrome
 *     helpers as 5 GiB of unique memory. Pss splits shared pages across their
 *     holders, so the sum over a tree is the footprint the box actually pays.
 *   - peak runnable tasks: tasks in state R at one instant, thread level. A
 *     task denied a CPU stays runnable, so this is the row's parallel demand
 *     whatever else the box is doing.
 *   - CPU seconds: getrusage(RUSAGE_CHILDREN) through `/usr/bin/time -v`, which
 *     counts children that came and went between two samples, with the
 *     sampler's own running total as the floor — a row killed at its deadline
 *     takes `time` with it and leaves no report.
 *   - achieved parallelism: Δ(utime+stime+cutime+cstime) over a window wide
 *     enough that the 10 ms tick does not read as threads.
 *
 * THE TREE, NOT THE SESSION, since 2026-09-17. `setsid` makes the row a
 * session leader, so a re-parented orphan still answers with the row's session
 * id — but a child that calls `setsid` ITSELF leaves that session, and the two
 * heaviest children a browser row has both do: `live-app-harness.ts` spawns
 * `vite dev` detached so the teardown can signal workerd through the group
 * (d6b075bd8), and puppeteer spawns Chrome detached by default. Measured on
 * this box under both shapes, 2026-09-17: the live-app row reads 203 MiB by
 * session and 5,013/5,115 MiB by pid tree (vite 2.6 GiB, workerd 1.1 GiB,
 * Chrome 1.0 GiB), and the UI self-tests row read 141.97 CPU seconds over a
 * 480 s wall — one thread for a row that drives 21 Chrome frames. So
 * membership is the row's session PLUS every descendant by ppid, whatever
 * session the descendant sits in. This reverses the sampling half of L6 in
 * docs/ARCHITECTURE-DECISIONS.md, which held the sampler and deploy.sh's kill
 * to one blind spot on purpose; killability and cost are different questions,
 * and memory a detached child holds is memory the box does not have.
 *
 * THE ROW RUNS EXACTLY AS THE WAVE RUNS IT: same `timeout --signal=TERM
 * --kill-after=5s` wrapper, same argv-splitting `bash -c`, same per-row
 * deadline. A measurement taken under a different runner measures the runner.
 *
 * This is a TOOL, not a gate: no ladder row runs it, nothing imports it, and it
 * imports the ladder rather than the other way round. That direction is what
 * keeps the machine-walking out of every gate program's graph.
 *
 *   bun scripts/gate-cost-measure.ts [--only=<row>] [--contended]
 *     [--quiet-wait=<s>] [--shared-wait=<s>]
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tolerate } from '@kinu.run/core/obs';
import { KILL_AFTER_SECONDS } from './deadline';
import {
  COST_TABLE, QUIET_LOAD, type RowCost, costRssMb, costThreads, machineName, readCosts, writeCosts,
} from './gate-cost';
import {
  GATE_DEADLINE_SECONDS, SHARED_BROWSER, SHARED_POOL, claims, gatesFor, packageScripts, trackedTestFiles,
} from './ladder';
import { readRepositoryFile } from './sources';

const root = new URL('..', import.meta.url).pathname;

/**
 * The sampling rates, and why there are two.
 *
 * One scan costs 5.4 ms on this box (measured 2026-09-17: 694 processes, one
 * `/proc/<pid>/stat` read each, tasks listed only for the row's own tree),
 * so a fast rate is not free — it is measurement load on the thing measured.
 * But a row that runs in 0.3 s gets ONE sample at the standard rate and the
 * figure then depends on where that sample landed: the preflight row read
 * 1 MiB that way against 89 MiB when it was sampled properly. So the first
 * {@link BURST_SECONDS} of every row are sampled fast, and a long row settles
 * to the standard rate, where the scan is a rounding error.
 */
const SAMPLE_SECONDS = 0.25;

const BURST_SAMPLE_SECONDS = 0.05;

const BURST_SECONDS = 3;

/**
 * The shortest window the ACHIEVED-parallelism figure is computed over.
 *
 * `utime` counts in 10 ms ticks, so Δticks over a 50 ms window is quantised to
 * fifths of a thread per process and a burst sample would read one unlucky tick
 * as several threads. Resident set and runnable tasks are instantaneous and
 * carry no such error, which is why only this figure waits for a window.
 */
const CPU_WINDOW_SECONDS = 0.25;

/** How the figures were taken, stored beside them: a measurement whose method
 *  is not written down cannot be repeated, and a figure nobody can repeat is
 *  the declared number this replaced. */
const COST_METHOD = 'each row alone under `setsid timeout --signal=TERM --kill-after=5s <deadline> '
  + '/usr/bin/time -v bash -c <run>`; the row\'s whole process tree — its session plus every '
  + 'descendant by ppid, so a setsid\'d dev server or browser counts — sampled every '
  + `${String(BURST_SAMPLE_SECONDS)}s for its first ${String(BURST_SECONDS)}s and every `
  + `${String(SAMPLE_SECONDS)}s after — summed proportional set (Pss, /proc/<pid>/smaps_rollup) for `
  + `memory, tasks in state R for parallel demand, Δ(utime+stime+cutime+cstime) over at least `
  + `${String(CPU_WINDOW_SECONDS)}s for parallelism achieved; CPU seconds from getrusage(RUSAGE_CHILDREN)`;

/** One instant of a row's tree: what it has burned, what it holds, and how
 *  many of its tasks want a CPU right now. */
interface Reading {
  readonly cpuTicks: number;
  readonly pssKb: number;
  readonly runnable: number;
  readonly processes: number;
  /** Per-member breakdown, populated only under `--dump-peak`: the memory
   *  report shows exactly which processes the peak was made of. */
  readonly members: readonly { readonly pid: number; readonly pssKb: number; readonly comm: string }[];
}

/** One process as `/proc/<pid>/stat` reports it, before membership is decided.
 *  The fields are read positionally from after the `comm`, which is the one
 *  field that holds spaces and parentheses; `lastIndexOf(') ')` is what makes
 *  that parse safe for a process called `) (`. */
interface ProcessStat {
  readonly ppid: number;
  readonly session: number;
  readonly cpuTicks: number;
  readonly tasks: number;
  readonly state: string;
}


/**
 * Every process in the row's TREE, summed: its own session plus every
 * descendant by ppid — see the header for the two children that leave the
 * session and what they cost.
 *
 * `cutime`/`cstime` are included because a reaped child's ticks move into its
 * parent's, so the sum over the LIVE processes of all four fields is the whole
 * tree's CPU with nothing double counted — a process is either alive and
 * counted by its own fields, or reaped and counted by its parent's.
 *
 * A descendant whose parent died before this sample is reparented to init and
 * drops out of the walk. That is an orphan — a teardown defect the harnesses
 * own — and the session arm still carries every child that never setsid'd.
 */

function readTree(session: number, dumpMembers = false): Reading {
  const stats = new Map<number, ProcessStat>();

  for (const entry of readdirSync('/proc')) {
    const first = entry.charCodeAt(0);

    if (first < 0x30 || first > 0x39) continue;

    // A process can exit between the directory listing and this read; that is
    // the sampler's normal case, not a failure.
    const stat = tolerate(() => readFileSync(`/proc/${entry}/stat`, 'utf8'), 'enoent');

    if (stat === undefined) continue;
    const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ');
    stats.set(Number(entry), {
      ppid: Number(fields[1]),
      session: Number(fields[3]),
      cpuTicks: Number(fields[11]) + Number(fields[12]) + Number(fields[13]) + Number(fields[14]),
      tasks: Number(fields[17]),
      state: fields[0] ?? '',
    });
  }

  // Membership walks UP: a process belongs when it wears the row's session or
  // when its parent belongs, so a chain of setsid calls between the row and a
  // workerd child changes nothing. Memoised, because a browser row is a
  // hundred processes hanging off one chain.
  const belonging = new Map<number, boolean>();

  const belongs = (pid: number): boolean => {
    const known = belonging.get(pid);

    if (known !== undefined) return known;
    const stat = stats.get(pid);

    // Recorded BEFORE the walk continues, so a chain that cannot terminate
    // cannot recur: pid 1, an exited parent and a self-parent all end here.
    belonging.set(pid, false);

    const verdict = stat !== undefined
      && (stat.session === session || (stat.ppid > 1 && stat.ppid !== pid && belongs(stat.ppid)));

    belonging.set(pid, verdict);

    return verdict;
  };

  let cpuTicks = 0;
  let pssKb = 0;
  let runnable = 0;
  let processes = 0;
  const members: { readonly pid: number; readonly pssKb: number; readonly comm: string }[] = [];

  for (const [pid, stat] of stats) {
    if (!belongs(pid)) continue;
    cpuTicks += stat.cpuTicks;
    processes += 1;

    // PROPORTIONAL set, not resident: RSS counts one shared page once per
    // process that maps it — ~110 Chrome helpers over the same mapped binary
    // read as ~110 times the memory — while Pss splits every shared page
    // across its holders, so the sum over the tree is the footprint the box
    // actually pays. Read off the member, not the listing: smaps is priced
    // per map and the box holds ~700 processes, most of them somebody else's.
    // The listing is a snapshot and the process may already be gone — ENOENT
    // or ESRCH (which is what the fs layer reports for a vanished /proc entry),
    // both the expected absence, so the member contributes nothing.
    const rollup = tolerate(() => tolerate(() => readFileSync(`/proc/${String(pid)}/smaps_rollup`, 'utf8'), 'esrch'), 'enoent');
    const pss = Number(/^Pss:\s*(\d+) kB$/mu.exec(rollup ?? '')?.[1] ?? 0);

    pssKb += pss;

    if (dumpMembers) {
      const comm = tolerate(() => tolerate(() => readFileSync(`/proc/${String(pid)}/comm`, 'utf8'), 'esrch'), 'enoent') ?? '?';

      members.push({ pid, pssKb: pss, comm: comm.trim() });
    }

    // THREAD level, not process level: a `bun test` worker is one process
    // running a thread pool, and counting the process would read four busy pool
    // threads as one. Only a process with more than one task pays for the
    // second listing.
    if (stat.tasks === 1) {
      if (stat.state === 'R') runnable += 1;
      continue;
    }

    // Same vanished-process race as the rollup above, one level down: a pool
    // thread that exits between the listing and the read answers ESRCH, and
    // an unhandled one there killed a whole 200 s browser row mid-measurement
    // (2026-09-18). A member that is gone contributes nothing.
    const tasks = tolerate(() => tolerate(() => readdirSync(`/proc/${String(pid)}/task`), 'esrch'), 'enoent') ?? [];

    for (const task of tasks) {
      const taskStat = tolerate(
        () => tolerate(() => readFileSync(`/proc/${String(pid)}/task/${task}/stat`, 'utf8'), 'esrch'),
        'enoent',
      );

      if (taskStat === undefined) continue;

      if (taskStat.slice(taskStat.lastIndexOf(') ') + 2)[0] === 'R') runnable += 1;
    }
  }

  return { cpuTicks, pssKb, runnable, processes, members };
}

/** MiB of memory the kernel says can be handed out without swapping. The runner
 *  derives its own cap from this same field. */
function memAvailableMb(): number {
  const line = readFileSync('/proc/meminfo', 'utf8')
    .split('\n')
    .find((candidate) => candidate.startsWith('MemAvailable:')) ?? '';

  return Math.floor(Number(line.split(/\s+/u)[1]) / 1024);
}

/** `/usr/bin/time -v`'s user+system seconds, from the file it was given. */
function rusageCpuSeconds(report: string): number {
  let seconds = 0;

  for (const line of report.split('\n')) {
    const label = line.trim();

    if (label.startsWith('User time (seconds):') || label.startsWith('System time (seconds):')) {
      seconds += Number(label.slice(label.indexOf(':') + 1));
    }
  }

  return seconds;
}

/** A Kinu suite, dev server or typechecker alive in any checkout. `vitest` and
 *  `vite` reach for the workerd pool and Chrome, which are ONE machine resource
 *  shared by every worktree; `tsc` is `bun run check` and takes the box for
 *  minutes. */
const KINU_WORK = /(?:vitest|vite|tsc|wrangler|workerd)/u;

const KINU_TREE = /(?:Kinu-wt-|\/Proteus\/)/u;

/** Why this box cannot be measured on right now. `shared` separates the two
 *  kinds: another checkout's suite holds a resource this row needs and must be
 *  waited out, while load is only load and can be recorded instead. */
interface Contention {
  readonly reason: string;
  readonly shared: boolean;
}

/**
 * Why this box is not quiet enough to measure on, or undefined when it is.
 *
 * Two conditions, because they answer different questions. The process scan
 * NAMES the Kinu work a lane can be asked to stop, and a second workerd pool
 * beside another worktree's is not a measurement at all — it is two lanes
 * fighting over one resource. The load average counts everything, including
 * work nobody here owns (a Lean build in another tree), and a figure taken
 * under it is still a figure: see {@link QUIET_LOAD}.
 *
 * `own` is this process's own session, which is measuring rather than
 * competing.
 */
function contention(own: number): Contention | undefined {
  for (const entry of readdirSync('/proc')) {
    const first = entry.charCodeAt(0);

    if (first < 0x30 || first > 0x39) continue;
    const stat = tolerate(() => readFileSync(`/proc/${entry}/stat`, 'utf8'), 'enoent');

    if (stat === undefined || Number(stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[3]) === own) continue;
    const command = tolerate(() => readFileSync(`/proc/${entry}/cmdline`, 'utf8'), 'enoent') ?? '';

    if (KINU_WORK.test(command) && KINU_TREE.test(command)) {
      return {
        reason: `pid ${entry} holds a shared resource: ${command.replaceAll('\0', ' ').trim().slice(0, 90)}`,
        shared: true,
      };
    }
  }

  const load = Number(readFileSync('/proc/loadavg', 'utf8').split(' ')[0]);

  if (load < QUIET_LOAD) return undefined;

  return { reason: `1-minute load ${load.toFixed(2)}, over the quiet line of ${String(QUIET_LOAD)}`, shared: false };
}

interface MeasureRequest {
  /** The row's command, exactly as the plan carries it. */
  readonly run: string;
  /** The row's own deadline, seconds: the same hang detector the wave uses. */
  readonly deadline: number;
  /** Where the row's own output goes, so a failed measurement is readable. */
  readonly logPath: string;
  readonly rusagePath: string;
  readonly ticksPerSecond: number;
  /** `--dump-peak`: record which processes the memory peak was made of. */
  readonly dumpMembers: boolean;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Run one row alone under the wave's own wrapper, sampling its tree until it
 * ends. Asynchronous so the sampler is a timer beside a running child rather
 * than a poll that competes with the row for the CPU it is measuring.
 */
async function measureRow(request: MeasureRequest): Promise<RowCost> {
  const loadAtStart = Number(readFileSync('/proc/loadavg', 'utf8').split(' ')[0]);
  const started = performance.now();

  const child = Bun.spawn([
    'setsid',
    'timeout', '--signal=TERM', `--kill-after=${String(KILL_AFTER_SECONDS)}s`, String(request.deadline),
    '/usr/bin/time', '-v', '-o', request.rusagePath,
    'bash', '-c', request.run,
  ], {
    cwd: root,
    stdout: Bun.file(request.logPath),
    stderr: Bun.file(request.logPath),
  });

  let peakPssKb = 0;
  let peakRunnable = 0;
  let peakMembers: Reading['members'] = [];
  let peakCpuThreads = 0;
  let anchorAt = 0;
  let anchorTicks = 0;
  let sampledTicks = 0;
  let samples = 0;
  let sampling = true;

  const loop = (async () => {
    while (sampling) {
      const elapsed = (performance.now() - started) / 1000;
      await Bun.sleep((elapsed < BURST_SECONDS ? BURST_SAMPLE_SECONDS : SAMPLE_SECONDS) * 1000);
      const at = performance.now();
      const reading = readTree(child.pid, request.dumpMembers);

      if (reading.processes === 0) continue;
      samples += 1;

      // The peak SNAPSHOT is kept, not just the peak number: `--dump-peak`
      // answers "what is this row's memory made of", which the total alone
      // cannot.
      if (reading.pssKb > peakPssKb) peakMembers = reading.members;
      peakPssKb = Math.max(peakPssKb, reading.pssKb);
      peakRunnable = Math.max(peakRunnable, reading.runnable);
      sampledTicks = Math.max(sampledTicks, reading.cpuTicks);

      // Against an ANCHOR rather than the previous sample: the window has to be
      // wide enough that the 10 ms tick quantisation does not read as threads,
      // and the sleep above is not the window — a sleep that overran under load
      // would otherwise inflate the figure it produced.
      if (anchorAt === 0) {
        anchorAt = at;
        anchorTicks = reading.cpuTicks;
        continue;
      }

      const span = (at - anchorAt) / 1000;

      if (span < CPU_WINDOW_SECONDS) continue;
      peakCpuThreads = Math.max(peakCpuThreads, (reading.cpuTicks - anchorTicks) / request.ticksPerSecond / span);
      anchorAt = at;
      anchorTicks = reading.cpuTicks;
    }
  })();

  const exit = await child.exited;
  sampling = false;
  await loop;
  const wallSeconds = (performance.now() - started) / 1000;
  // TWO SOURCES FOR ONE FIGURE, and the larger wins. `/usr/bin/time` reports
  // getrusage, which counts children the sampler never saw — but a row killed at
  // its deadline kills `time` with it and the report is empty or absent, and a
  // zero there would admit a row that burned 480 s of CPU as a free one. The
  // sampler's own running total covers exactly that case.
  const report = tolerate(() => readFileSync(request.rusagePath, 'utf8'), 'enoent') ?? '';
  const cpuSeconds = Math.max(rusageCpuSeconds(report), sampledTicks / request.ticksPerSecond);

  if (request.dumpMembers) {
    console.log(`      peak ${String((peakPssKb / 1024).toFixed(0))} MiB across ${String(peakMembers.length)} process(es):`);

    for (const member of [...peakMembers].sort((a, b) => b.pssKb - a.pssKb)) {
      console.log(`        ${String(member.pid).padStart(8)}  ${String((member.pssKb / 1024).toFixed(1)).padStart(8)} MiB  ${member.comm}`);
    }
  }

  return {
    wallSeconds: round(wallSeconds),
    cpuSeconds: round(cpuSeconds),
    peakRssMb: round(peakPssKb / 1024),
    peakRunnable,
    peakCpuThreads: round(peakCpuThreads),
    meanThreads: round(wallSeconds > 0 ? cpuSeconds / wallSeconds : 0),
    samples,
    loadAtStart,
    exit,
  };
}

/** `getconf` rather than a constant: a figure this file divides by is read from
 *  the box it was taken on — `CLK_TCK` for the tick rate the `utime` fields
 *  count in. */
function configured(name: string): number {
  return Number(Bun.spawnSync(['getconf', name], { stdout: 'pipe' }).stdout.toString().trim());
}

if (import.meta.main) {
  const only = process.argv.find((argument) => argument.startsWith('--only='))?.slice('--only='.length);
  const existing = existsSync(COST_TABLE) ? readCosts().rows : {};
  const contendedOnly = process.argv.includes('--contended');

  // The two post-publish rows are excluded: their subject is a DEPLOYED build
  // this tree does not have, and their cost is a network and model wait rather
  // than this box.
  const rows = gatesFor('deploy').filter((gate) => gate.tier !== 'evals'
    && (gate.phase ?? 'source') !== 'post-publish'
    && (only === undefined || gate.run.includes(only) || gate.label.includes(only))
    && (!contendedOnly || (existing[gate.run]?.loadAtStart ?? 0) >= QUIET_LOAD));

  if (rows.length === 0) {
    console.error(`gate-cost-measure: no deploy row matches${only === undefined ? '' : ` --only=${only}`}${contendedOnly ? ' --contended' : ''}`);
    process.exit(2);
  }

  const measured = { ...existing };
  const ticksPerSecond = configured('CLK_TCK');
  const dumpMembers = process.argv.includes('--dump-peak');
  const scratch = mkdtempSync(join(tmpdir(), 'kinu-cost-'));
  const machine = machineName();
  const today = new Date().toISOString().slice(0, 10);
  const own = Number(readFileSync('/proc/self/stat', 'utf8').slice(readFileSync('/proc/self/stat', 'utf8').lastIndexOf(') ') + 2).split(' ')[3]);
  const waitSeconds = Number(process.argv.find((argument) => argument.startsWith('--quiet-wait='))?.slice('--quiet-wait='.length) ?? 30);
  const sharedWaitSeconds = Number(process.argv.find((argument) => argument.startsWith('--shared-wait='))?.slice('--shared-wait='.length) ?? 2_700);
  const contended: string[] = [];
  const skipped: string[] = [];
  const scripts = packageScripts();
  const tracked = trackedTestFiles();
  console.log(`measuring ${String(rows.length)} row(s) alone on ${machine}, MemAvailable ${String(memAvailableMb())} MiB`);

  for (const [index, gate] of rows.entries()) {
    const deadline = gate.deadline?.seconds ?? GATE_DEADLINE_SECONDS;

    // WAIT ON THE CONDITION, NOT A CLOCK, and wait differently for the two
    // conditions.
    //
    // The workerd pool, a dev server and Chrome are ONE machine resource shared
    // by every worktree, so a row that reaches for one waits out another
    // checkout's however long that takes, up to `--shared-wait`, and is NAMED
    // rather than measured beside a second pool. Which rows those are is
    // DERIVED — the command, the package script it resolves to, and the imports
    // of every file it claims — never a list here.
    //
    // For every other row that same suite is only LOAD, and load is only load:
    // the resident-set and runnable-task figures survive it, so after
    // `--quiet-wait` the row is measured anyway and the load it was taken under
    // is recorded with it.
    const script = gate.run.startsWith('bun run ') ? scripts[gate.run.slice('bun run '.length)] ?? '' : '';

    const needsPool = SHARED_POOL.test(`${gate.run} ${script}`)
      || claims(gate.run, tracked).some((file) => SHARED_BROWSER.test(readRepositoryFile(root, file)));

    const startedWaiting = performance.now();
    let blocked = contention(own);
    let announced = '';

    while (blocked !== undefined) {
      if ((performance.now() - startedWaiting) / 1000 > (blocked.shared && needsPool ? sharedWaitSeconds : waitSeconds)) break;

      if (blocked.reason !== announced) {
        console.log(`      waiting — ${blocked.reason}`);
        announced = blocked.reason;
      }

      await Bun.sleep(5_000);
      blocked = contention(own);
    }

    if (blocked?.shared === true && needsPool) {
      skipped.push(`${gate.label} — ${blocked.reason}`);
      console.log(`${String(index + 1).padStart(2)}/${String(rows.length)}  SKIPPED, a shared resource never came free: ${gate.label}`);
      continue;
    }

    const cost = await measureRow({
      run: gate.run,
      deadline,
      logPath: join(scratch, `${String(index)}.log`),
      ticksPerSecond,
      rusagePath: join(scratch, `${String(index)}.rusage`),
      dumpMembers,
    });

    measured[gate.run] = cost;
    // Written after EVERY row, so a sweep stopped halfway keeps what it measured.
    writeCosts({ measuredAt: today, machine, method: COST_METHOD, rows: measured });

    if (cost.loadAtStart >= QUIET_LOAD) contended.push(gate.label);

    console.log(
      `${String(index + 1).padStart(2)}/${String(rows.length)}  ${cost.wallSeconds.toFixed(1).padStart(7)}s wall  `
      + `${cost.cpuSeconds.toFixed(1).padStart(7)}s cpu  ${String(costThreads(cost, gate.seconds)).padStart(3)} thr `
      + `(${String(cost.peakRunnable)} runnable, ${cost.peakCpuThreads.toFixed(1)} achieved)  `
      + `${String(costRssMb(cost)).padStart(6)} MiB  exit ${String(cost.exit)}  load ${cost.loadAtStart.toFixed(1)}  ${gate.label}`
      + (cost.wallSeconds > deadline * 0.8 ? `  ⚠ ${(cost.wallSeconds / deadline * 100).toFixed(0)}% of its ${String(deadline)}s deadline ALONE` : ''),
    );
  }

  console.log(`\ngate-cost-measure: wrote ${String(Object.keys(measured).length)} row(s) to ${COST_TABLE}`);
  console.log(`  logs: ${scratch}`);

  if (contended.length > 0) {
    console.log(
      `  ${String(contended.length)} row(s) measured above the quiet line of ${String(QUIET_LOAD)}: their memory and `
      + 'runnable-task figures stand, their solo wall does not. Re-run with --contended on a quiet box:',
    );

    for (const label of contended) console.log(`    ${label}`);
  }

  if (skipped.length > 0) {
    console.log(`  ${String(skipped.length)} row(s) NOT measured — another checkout held a resource they need:`);

    for (const line of skipped) console.log(`    ${line}`);
  }
}
