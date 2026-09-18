/**
 * WHAT A DEPLOY ROW COSTS THE BOX: the table, and the two figures the wave
 * admits against.
 *
 * The source wave used to be admitted against a DECLARED thread figure with no
 * memory dimension at all, and on 2026-09-16 five of its own rows died on their
 * per-row deadline across two consecutive deploys while other lanes loaded the
 * machine: dead code (124), the gate self-tests (137 — a SIGKILL, not a hang),
 * both workerd rows (124) and the UI self-tests (124). Every one of them passes
 * alone. Measured 2026-09-17, the two rows that carried the wave's memory were
 * declared as one thread and nothing else: `gate:dead-code` peaks at 17.0 GiB
 * and the gate self-tests row at 24.7 GiB. Raising a deadline would have hidden
 * that; the deadline is the hang detector and stays where it is.
 *
 * The figures are SAMPLED by `scripts/gate-cost-measure.ts`, one row at a time.
 * This module is the table they land in and the arithmetic the runner schedules
 * by — no process ever walks the machine from here, because everything reachable
 * from a ladder row is a gate program and a gate program reads the tree through
 * `scripts/sources.ts` alone (`gate:set-equality`).
 *
 * Nothing edits the table by hand. `deployPlan()` reads it and refuses to print
 * a plan while a concurrently scheduled row has no measurement, so a new heavy
 * row cannot reach the wave carrying an invented cost.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform as osPlatform } from 'node:os';
import * as v from 'valibot';

const root = new URL('..', import.meta.url).pathname;

export const COST_TABLE = `${root}scripts/gate-cost.json`;

/**
 * The 1-minute load average under which this box counts as quiet enough to
 * measure a row's achieved parallelism and its solo wall.
 *
 * Above it a row cannot get the threads it asks for, so both read low. Neither
 * figure decides admission for that reason: `costThreads` divides work by the
 * SMALLER of two walls and caps the result by tasks observed runnable, and both
 * of those survive a busy box. The line is what marks a row's reported solo
 * wall as repeatable or not.
 */
export const QUIET_LOAD = 2;

const RowCostSchema = v.object({
  /** Wall clock alone, seconds. Reported against the row's deadline rather than
   *  used for admission: a wall is not a measure of load. */
  wallSeconds: v.number(),
  /** User+system seconds over the whole process tree: work done, not time
   *  taken, so a busy box does not change it. */
  cpuSeconds: v.number(),
  /** The tree's summed resident pages at their highest sampled instant, MiB.
   *  A SUM, because `/usr/bin/time -v`'s maximum resident set is the largest
   *  single child and reads four 1 GiB workers as one. */
  peakRssMb: v.number(),
  /** Tasks in state R at their highest sampled instant — the row's parallel
   *  demand. Runnable-but-waiting counts, so this figure survives contention. */
  peakRunnable: v.number(),
  /** The highest sampled window's ACHIEVED parallelism: CPU seconds burned per
   *  second of wall. Trustworthy only from a quiet box — see {@link QUIET_LOAD}. */
  peakCpuThreads: v.number(),
  /** Mean parallelism over the run, `cpuSeconds / wallSeconds`. */
  meanThreads: v.number(),
  samples: v.number(),
  /** The 1-minute load average when the row started, so a reader can tell a
   *  repeatable figure from one taken beside another lane's suite. */
  loadAtStart: v.number(),
  /** The row's exit status. Recorded because a row that failed early was not
   *  measured at its full cost, and that has to be visible rather than folded
   *  into a number. */
  exit: v.number(),
});

const CostTableSchema = v.object({
  measuredAt: v.string(),
  machine: v.string(),
  method: v.string(),
  rows: v.record(v.string(), RowCostSchema),
});

export type RowCost = v.InferOutput<typeof RowCostSchema>;

export type CostTable = v.InferOutput<typeof CostTableSchema>;

export function readCosts(path = COST_TABLE): CostTable {
  return v.parse(CostTableSchema, JSON.parse(readFileSync(path, 'utf8')));
}

export function writeCosts(table: CostTable, path = COST_TABLE): number {
  writeFileSync(path, `${JSON.stringify(table, null, 2)}\n`);

  return Object.keys(table.rows).length;
}

/**
 * The threads a row occupies, as the wave admits it: CPU work over elapsed
 * time, capped by the tasks the row ever had runnable at once.
 *
 * SUSTAINED, not the pool width. `bun run lint` measured 25 runnable tasks at
 * its peak and 106.0 CPU seconds over a 21.4 s wall — five threads of work,
 * not twenty-five. Charging the pool width would run that row alone on a
 * 24-thread box and serialise the wave for nothing; charging the work admits
 * four more rows beside it.
 *
 * THE SMALLER WALL, because both walls can be wrong in the same dangerous
 * direction. A wall inflated by contention and a declared wall that has gone
 * stale-high (`bun run layergate` declares 25 s and ran in 0.6 s) both divide
 * the work DOWN and admit the row too cheaply, which is the error that brings
 * the deadline kills back. The smaller wall errs the other way, and the cap
 * below bounds how far.
 *
 * CAPPED BY `peakRunnable`, because a row cannot use more threads than it ever
 * had tasks wanting one — that is what keeps a stale-low wall from charging a
 * row for work it cannot do in parallel.
 */
export function costThreads(cost: RowCost, declaredSeconds: number): number {
  const wall = Math.min(cost.wallSeconds, declaredSeconds);
  const sustained = wall > 0 ? Math.ceil(cost.cpuSeconds / wall) : 1;

  return Math.max(1, Math.min(sustained, Math.max(1, cost.peakRunnable)));
}

/** The resident set a row holds at peak, MiB, as the wave admits it. */
export function costRssMb(cost: RowCost): number {
  return Math.max(1, Math.ceil(cost.peakRssMb));
}

/** This box, in the form the ladder's other measured figures name it. */
export function machineName(): string {
  return `${osPlatform()} ${arch()}, ${cpus()[0]?.model ?? 'unknown cpu'} (${String(cpus().length)} threads)`;
}
