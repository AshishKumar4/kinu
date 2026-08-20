#!/usr/bin/env bun
/**
 * The eval-record reader: every `run-record.json` the tiers have accumulated,
 * grouped by family, rendered as the comparison a human actually reads.
 *
 *   bun scripts/eval-report.ts                  # bench-artifacts/ + tests/eval/runs/
 *   bun scripts/eval-report.ts --root <dir>     # a specific artifact root
 *   bun scripts/eval-report.ts --family optimization
 *
 * WHAT THE DATA CAN ANSWER, today:
 *   - Did a change move task outcomes? Same family, same tier, same corpus:
 *     compare the eligible-weighted task_outcome across records (the paired
 *     comparator in `eval-compare.ts` is the significance-bearing version for
 *     behaviour runs; this report is the survey).
 *   - Did swarms help? The optimization family records `swarm_use` (with the
 *     tree shape) and `threshold_attained` per observation, so the 2×2 printed
 *     below accumulates one cell per run — forced-search numbers on the SAME
 *     instrument live in the swarm arm's log.
 *   - Where does the time and money go? Per-observation `ms` and per-run spend
 *     are summed per family, so the arm that dominates the tier is a number.
 *   - Which tools fail? Each observation carries `toolNames`; the transcripts
 *     path in every record holds the stores where each call's args and result
 *     survive.
 *
 * WHAT IT CANNOT ANSWER YET, stated so nobody reads more than is there:
 *   - Significance for the single-observation families: research and
 *     optimization write one observation per run, so their trends accumulate at
 *     one pair per tier run and no exact test is computable until several runs
 *     exist under one commit-comparable arm.
 *   - Swarm attribution: `swarm_use` is the agent's own CHOICE, not an assigned
 *     arm, so the 2×2 is observational — confounded by task difficulty
 *     perception. An assigned-arm comparison needs a paired design like the
 *     behaviour tier's.
 *   - Per-step time: `ms` is per observation; where time goes INSIDE an episode
 *     is in the transcripts, not in this report.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  readRunRecord, TASK_OUTCOME,
  type EvalObservation, type EvalRunRecord,
} from '../packages/test-utils/src/index';

const REPO_ROOT = new URL('..', import.meta.url).pathname;

interface CliOptions {
  readonly roots: readonly string[];
  readonly family: string | null;
}

function parseArgs(argv: readonly string[]): CliOptions | null {
  const roots: string[] = [];
  let family: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root') {
      const value = argv[++i];
      if (value === undefined) return null;
      roots.push(value);
    } else if (arg === '--family') {
      const value = argv[++i];
      if (value === undefined) return null;
      family = value;
    } else {
      return null;
    }
  }
  if (roots.length === 0) {
    roots.push(join(REPO_ROOT, 'bench-artifacts'), join(REPO_ROOT, 'tests/eval/runs'));
  }
  return { roots, family };
}

/** Every record path under a root: `<root>/<run>/run-record.json` for artifact
 *  roots, `<root>/*.json` for the published-records directory. */
function recordPaths(root: string): string[] {
  if (!existsSync(root)) return [];
  const paths: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const candidate = join(root, entry.name, 'run-record.json');
      if (existsSync(candidate)) paths.push(candidate);
    } else if (entry.name.endsWith('.json')) {
      paths.push(join(root, entry.name));
    }
  }
  return paths;
}

type Scored = Extract<EvalObservation, { outcome: 'scored' }>;

function scoredOf(record: EvalRunRecord): Scored[] {
  return record.observations.filter((o): o is Scored => o.outcome === 'scored');
}

/** Eligible-weighted total of one named score row across scored observations. */
function rowTotals(observations: readonly Scored[], name: string) {
  const rows = observations.flatMap((o) => o.scores.filter((s) => s.name === name));
  return {
    eligible: rows.reduce((n, r) => n + r.eligible, 0),
    passed: rows.reduce((n, r) => n + r.passed, 0),
  };
}

function rate(passed: number, eligible: number): string {
  return eligible === 0 ? 'n/a (0 eligible)' : `${String(passed)}/${String(eligible)} = ${(passed / eligible).toFixed(3)}`;
}

function renderRun(record: EvalRunRecord): string {
  const scored = scoredOf(record);
  const outcome = rowTotals(scored, TASK_OUTCOME);
  const ms = scored.reduce((n, o) => n + o.ms, 0);
  const inert = record.observations.filter((o) => o.outcome === 'inert').length;
  const errored = record.observations.filter((o) => o.outcome === 'errored').length;
  return [
    record.createdAt.slice(0, 10),
    record.runId,
    record.modelId,
    `${String(scored.length)}s/${String(inert)}i/${String(errored)}e`,
    `outcome ${rate(outcome.passed, outcome.eligible)}`,
    `${(ms / 1000).toFixed(0)}s`,
    `${String(record.spend.calls)} calls ${String(record.spend.tokensIn)}/${String(record.spend.tokensOut)} tok`,
    record.admissibility.admissible ? 'admissible' : 'INADMISSIBLE',
    record.gitDirty ? `${record.gitSha.slice(0, 9)} DIRTY` : record.gitSha.slice(0, 9),
  ].join('  ');
}

/**
 * The optimization family's accumulating question: swarm use × attainment. A
 * 2×2 over the agent's own choices — observational, never a verdict (see the
 * header). Printed only over the observations that recorded BOTH rows, and a
 * cell of zeros says "no data", never "no effect".
 */
function renderSwarmCross(records: readonly EvalRunRecord[]): string[] {
  const cells = { usedHit: 0, usedMiss: 0, aloneHit: 0, aloneMiss: 0 };
  let measured = 0;
  for (const record of records) {
    for (const observation of scoredOf(record)) {
      const swarm = observation.scores.find((s) => s.name === 'swarm_use');
      const attained = observation.scores.find((s) => s.name === 'threshold_attained');
      if (!swarm || !attained) continue;
      measured += 1;
      if (swarm.passed > 0) {
        if (attained.passed > 0) cells.usedHit += 1; else cells.usedMiss += 1;
      } else if (attained.passed > 0) cells.aloneHit += 1; else cells.aloneMiss += 1;
    }
  }
  if (measured === 0) {
    return ['  swarm × attainment: no observation recorded both rows yet — nothing to correlate'];
  }
  return [
    `  swarm × attainment over ${String(measured)} observation(s) (agent-chosen, observational):`,
    `    with swarm:    ${String(cells.usedHit)} attained / ${String(cells.usedMiss)} missed`,
    `    without swarm: ${String(cells.aloneHit)} attained / ${String(cells.aloneMiss)} missed`,
  ];
}

function main(argv: readonly string[]): number {
  const options = parseArgs(argv);
  if (options === null) {
    console.error('usage: bun scripts/eval-report.ts [--root <dir>]... [--family <id>]');
    return 1;
  }

  const refusals: { readonly path: string; readonly error: string }[] = [];
  const records: EvalRunRecord[] = [];
  for (const root of options.roots) {
    for (const path of recordPaths(root)) {
      try {
        records.push(readRunRecord(path));
      } catch (error) {
        // Reported first, never dropped: a record this reader cannot read is a
        // record the tier believes it published.
        refusals.push({ path, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  for (const refusal of refusals) {
    console.log(`UNREADABLE: ${refusal.path} — ${refusal.error}`);
  }
  if (refusals.length > 0) console.log('');

  const byFamily = new Map<string, EvalRunRecord[]>();
  for (const record of records) {
    // Old records predate `family`, and the two published baselines carry
    // hand-named runIds (`flash-a`), so nothing can be derived: they group as
    // pre-family rather than under a guessed name.
    const family = record.family ?? '(pre-family)';
    if (options.family !== null && family !== options.family) continue;
    const group = byFamily.get(family);
    if (group) group.push(record); else byFamily.set(family, [record]);
  }

  if (byFamily.size === 0) {
    console.log(`no run records${options.family === null ? '' : ` for family "${options.family}"`} under: `
      + options.roots.join(', '));
    console.log('a record is written by every eval-tier arm run — `bun run evals:full` — beside its transcripts');
    return 0;
  }

  for (const [family, group] of [...byFamily.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    group.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    console.log(`── ${family} — ${String(group.length)} run(s) ────────────────────────────`);
    for (const record of group) console.log(`  ${renderRun(record)}`);

    const scored = group.flatMap(scoredOf);
    const outcome = rowTotals(scored, TASK_OUTCOME);
    const ms = scored.reduce((n, o) => n + o.ms, 0);
    const calls = group.reduce((n, r) => n + r.spend.calls, 0);
    const tokens = group.reduce((n, r) => n + r.spend.tokensIn + r.spend.tokensOut, 0);
    console.log(`  family: outcome ${rate(outcome.passed, outcome.eligible)}, `
      + `${(ms / 1000).toFixed(0)}s observed, ${String(calls)} calls, ${String(tokens)} tokens`);
    if (family === 'optimization') for (const line of renderSwarmCross(group)) console.log(line);
    console.log('');
  }

  console.log('what this cannot answer yet: single-observation families accumulate one pair per run '
    + '(no exact test until several runs share one arm); swarm use is agent-chosen, so the 2×2 is '
    + 'observational; per-step time lives in each record\'s transcripts directory.');
  return 0;
}

process.exit(main(process.argv.slice(2)));
