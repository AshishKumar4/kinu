#!/usr/bin/env bun
// The one bridge from somebody else's harness to our one statistics path.
//
// Harbor writes a directory of per-trial `result.json` files; CL-Bench writes
// per-instance rewards. Neither produces a paired effect size, and this repo
// already owns exactly one: packages/core/src/bench/stats.ts, whose pairing unit
// is the TASK and whose interval is a cluster bootstrap. So nothing here
// computes a statistic — it reads retained trials, pairs them, and hands them
// over.
//
//   bun scripts/bench-external.ts compare --a <job-dir> --b <job-dir>
//       Two Harbor job directories as paired arms. Reports the exact paired
//       test, the interval, the design's own resolution, and per-arm token
//       totals so "equal spend" is a checked fact rather than an assertion.
//
//   bun scripts/bench-external.ts gain --stateful <job-dir> --stateless <job-dir>
//       The stateful-minus-stateless primitive, through computeGain.
//
// Both write their analysis into the artifact root, because an analysis of
// retained evidence is itself evidence.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import * as v from 'valibot';
import {
  computeGain, decodeJsonValue, fmtPp, pairedBinaryComparison, parseJsonValue,
} from '../packages/core/src/index.js';
import type { JsonValue, PairedOutcome } from '../packages/core/src/index.js';
import { openRunRetention, resolveArtifactRoot } from './bench-retention.js';
import { parseArgv } from './bench.js';

const REPO_ROOT = join(import.meta.dir, '..');

/** Only the fields a score depends on. Harbor's `result.json` carries far more;
 *  a loose parse here would let a schema change quietly redefine the number. */
const FiniteCount = v.pipe(v.number(), v.finite(), v.minValue(0));

const TrialSchema = v.object({
  task_name: v.pipe(v.string(), v.minLength(1)),
  task_checksum: v.optional(v.string()),
  config: v.object({
    agent: v.object({
      model_name: v.optional(v.nullable(v.string())),
      // Named, not a bag of unknowns: `evolve` is the arm state, and reading it
      // out of an unparsed record is how an arm's own configuration became
      // something a reader had to guess at.
      kwargs: v.optional(v.nullable(v.object({ evolve: v.optional(v.boolean()) }))),
    }),
  }),
  agent_result: v.nullable(v.object({
    n_input_tokens: v.optional(v.nullable(FiniteCount)),
    n_output_tokens: v.optional(v.nullable(FiniteCount)),
    n_cache_tokens: v.optional(v.nullable(FiniteCount)),
    metadata: v.optional(v.nullable(v.object({
      tool_calls: v.optional(v.number()),
      // The adapter's activity channel, not evolution — see the note in
      // bench/harbor/trajectory.py. Counted, never read as proof.
      evolution_events: v.optional(v.array(v.unknown())),
    }))),
  })),
  verifier_result: v.nullable(v.object({
    rewards: v.record(v.string(), v.number()),
  })),
  exception_info: v.optional(v.nullable(v.unknown())),
});

export interface ExternalTrial {
  /** Harbor prefixes the dataset in 2.1 (`terminal-bench/foo`) and not in 2.0,
   *  so the bare task name is the only key that pairs across releases. */
  taskId: string;
  reward: number;
  passed: boolean;
  checksum: string | null;
  model: string | null;
  /** Whether the run's distinctive mechanism was live, read from the arm's own
   *  recorded kwargs rather than assumed. */
  evolve: boolean | null;
  /** How many evolution events the agent actually emitted. An arm that claims
   *  evolve=true and reports zero is a finding, not a detail. */
  evolutionEvents: number | null;
  toolCalls: number | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  errored: boolean;
}

export interface ExternalArm {
  /** Job directory basename — how a run identifies itself in bench-artifacts. */
  id: string;
  dir: string;
  trials: ExternalTrial[];
}

/** Read one Harbor job directory. Every trial subdirectory holding a
 *  `result.json` is a trial; anything else in there is job-level bookkeeping. */
export function readHarborJob(dir: string): ExternalArm {
  const root = resolve(dir);
  if (!existsSync(root)) throw new Error(`no such Harbor job directory: ${root}`);
  const trials: ExternalTrial[] = [];
  for (const entry of readdirSync(root).sort()) {
    const file = join(root, entry, 'result.json');
    if (!existsSync(file)) continue;
    const parsed = v.parse(TrialSchema, parseJsonValue(readFileSync(file, 'utf8')));
    const reward = parsed.verifier_result?.rewards.reward;
    if (reward === undefined) {
      throw new Error(`${file} has no verifier reward — an unscored trial cannot be paired`);
    }
    const meta = parsed.agent_result?.metadata;
    const events = meta?.evolution_events;
    trials.push({
      taskId: parsed.task_name.split('/').pop() ?? parsed.task_name,
      reward,
      passed: reward >= 1,
      checksum: parsed.task_checksum ?? null,
      model: parsed.config.agent.model_name ?? null,
      evolve: parsed.config.agent.kwargs?.evolve ?? null,
      evolutionEvents: events === undefined ? null : events.length,
      toolCalls: meta?.tool_calls ?? null,
      inputTokens: parsed.agent_result?.n_input_tokens ?? 0,
      outputTokens: parsed.agent_result?.n_output_tokens ?? 0,
      cachedTokens: parsed.agent_result?.n_cache_tokens ?? 0,
      errored: parsed.exception_info !== null && parsed.exception_info !== undefined,
    });
  }
  if (trials.length === 0) throw new Error(`${root} holds no trial result.json files`);
  return { id: basename(root), dir: root, trials };
}

export interface ArmSpend {
  trials: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** Uncached input plus output — what the arm actually asked the model to
   *  process. Two arms at "equal spend" must match on this, not on trial count. */
  billableTokens: number;
  models: string[];
  evolveFlags: (boolean | null)[];
  totalEvolutionEvents: number | null;
  errored: number;
}

export function armSpend(arm: ExternalArm): ArmSpend {
  const sum = (pick: (t: ExternalTrial) => number) => arm.trials.reduce((n, t) => n + pick(t), 0);
  const events = arm.trials.map((t) => t.evolutionEvents);
  return {
    trials: arm.trials.length,
    inputTokens: sum((t) => t.inputTokens),
    outputTokens: sum((t) => t.outputTokens),
    cachedTokens: sum((t) => t.cachedTokens),
    billableTokens: sum((t) => Math.max(0, t.inputTokens - t.cachedTokens) + t.outputTokens),
    models: [...new Set(arm.trials.map((t) => t.model ?? 'unknown'))].sort(),
    evolveFlags: [...new Set(arm.trials.map((t) => t.evolve))],
    totalEvolutionEvents: events.every((n) => n === null)
      ? null
      : events.reduce<number>((total, e) => total + (e ?? 0), 0),
    errored: arm.trials.filter((t) => t.errored).length,
  };
}

export interface PairedTask {
  taskId: string;
  a: number;
  b: number;
  /** Harbor's own task checksum, when both arms recorded one. Equal checksums
   *  mean the two arms were scored on the identical task; unequal ones mean the
   *  flip may be the corpus moving rather than the agent. */
  sameChecksum: boolean | null;
}

export function pairArms(a: ExternalArm, b: ExternalArm) {
  const byId = (arm: ExternalArm) => new Map(arm.trials.map((t) => [t.taskId, t]));
  const left = byId(a);
  const right = byId(b);
  const paired: PairedTask[] = [];
  for (const taskId of [...left.keys()].sort()) {
    const l = left.get(taskId)!;
    const r = right.get(taskId);
    if (!r) continue;
    paired.push({
      taskId,
      a: l.reward,
      b: r.reward,
      sameChecksum: l.checksum === null || r.checksum === null ? null : l.checksum === r.checksum,
    });
  }
  return {
    paired,
    onlyA: [...left.keys()].filter((id) => !right.has(id)).sort(),
    onlyB: [...right.keys()].filter((id) => !left.has(id)).sort(),
  };
}

/** Flip accounting with an explicit denominator, because the same three flips
 *  over two different denominators produced two circulating numbers for the same
 *  observation. Both are reported, each named by what it divides by. */
export function flipAccounting(paired: readonly PairedTask[]) {
  const flipped = paired.filter((p) => (p.a >= 1) !== (p.b >= 1));
  const identical = paired.filter((p) => p.sameChecksum === true);
  return {
    flipped: flipped.map((p) => p.taskId),
    overAllShared: {
      flips: flipped.length,
      of: paired.length,
      rate: paired.length === 0 ? 0 : flipped.length / paired.length,
    },
    overSameChecksum: identical.length === 0 ? null : {
      flips: flipped.filter((p) => p.sameChecksum === true).length,
      of: identical.length,
      rate: flipped.filter((p) => p.sameChecksum === true).length / identical.length,
    },
  };
}

function retain(
  command: string,
  arms: readonly ExternalArm[],
  paired: readonly PairedTask[],
  report: JsonValue,
): string {
  const retention = openRunRetention({
    artifactRoot: resolveArtifactRoot({
      flag: undefined, env: { BENCH_ARTIFACTS: process.env.BENCH_ARTIFACTS },
      repoRoot: REPO_ROOT, runRoot: resolve('/nonexistent-run-root'),
    }),
    repoRoot: REPO_ROOT,
    provenance: {
      command: `external-${command}`,
      runId: arms.map((arm) => arm.id).join('-vs-').slice(0, 60),
      family: 'external',
      corpus: arms.map((arm) => arm.dir).join(' | '),
      manifestHash: 'n/a — provenance lives in each trial result.json',
      seed: 0,
      repeats: 1,
      budget: { wallClockMs: 0, maxTokens: 0 },
      variants: arms.map((arm) => arm.id),
      evolving: arms.some((arm) => arm.trials.some((t) => t.evolve === true)),
      model: armSpend(arms[0]!).models.join(','),
      providerHash: null,
      taskIds: paired.map((p) => p.taskId),
    },
  });
  retention.finish(report);
  return retention.dir;
}

function describeSpend(label: string, spend: ArmSpend): string {
  return `${label.padEnd(28)} trials=${String(spend.trials).padStart(3)}  `
    + `billable=${spend.billableTokens.toLocaleString().padStart(12)}  `
    + `in=${spend.inputTokens.toLocaleString().padStart(12)}  `
    + `cached=${spend.cachedTokens.toLocaleString().padStart(12)}  `
    + `out=${spend.outputTokens.toLocaleString().padStart(9)}  `
    + `evolve=${spend.evolveFlags.map((f) => String(f)).join('/')}  `
    + `evolutionEvents=${spend.totalEvolutionEvents ?? 'not recorded'}  `
    + `errors=${spend.errored}  models=${spend.models.join(',')}`;
}

function cmdCompare(args: Map<string, string>): number {
  const dirA = args.get('a');
  const dirB = args.get('b');
  if (!dirA || !dirB) throw new Error('compare needs --a <job-dir> and --b <job-dir>');
  const a = readHarborJob(dirA);
  const b = readHarborJob(dirB);
  const { paired, onlyA, onlyB } = pairArms(a, b);
  if (paired.length === 0) throw new Error('the two arms share no task — nothing to pair');

  const outcomes: PairedOutcome[] = paired.map((p) => ({
    taskId: p.taskId, a: [p.a >= 1], b: [p.b >= 1],
  }));
  const stats = pairedBinaryComparison(outcomes);
  const flips = flipAccounting(paired);
  const spendA = armSpend(a);
  const spendB = armSpend(b);
  const spendRatio = spendA.billableTokens === 0 ? null : spendB.billableTokens / spendA.billableTokens;

  const report = {
    kind: 'external-paired-comparison',
    armA: { id: a.id, dir: a.dir, spend: spendA },
    armB: { id: b.id, dir: b.dir, spend: spendB },
    spendRatio,
    paired,
    unpaired: { onlyA, onlyB },
    flips,
    stats,
  };
  const dir = retain('compare', [a, b], paired, decodeJsonValue({ value: report }));

  console.log(`A = ${a.id}`);
  console.log(`B = ${b.id}`);
  console.log(describeSpend('  A spend', spendA));
  console.log(describeSpend('  B spend', spendB));
  console.log(`  spend ratio B/A on billable tokens: ${spendRatio === null ? 'n/a' : spendRatio.toFixed(3)}`);
  if (onlyA.length || onlyB.length) {
    console.log(`  unpaired: ${onlyA.length} only in A, ${onlyB.length} only in B (excluded from the test)`);
  }
  console.log('');
  for (const p of paired) {
    const mark = (p.a >= 1) === (p.b >= 1) ? '   ' : 'FLIP';
    const same = p.sameChecksum === null ? 'checksum n/a' : p.sameChecksum ? 'same checksum' : 'checksum differs';
    console.log(`  ${mark} ${p.taskId.padEnd(34)} A=${p.a} B=${p.b}  ${same}`);
  }
  console.log('');
  console.log(`flips over all shared tasks:  ${flips.overAllShared.flips}/${flips.overAllShared.of} = ${(flips.overAllShared.rate * 100).toFixed(1)}%`);
  console.log(flips.overSameChecksum === null
    ? 'flips over same-checksum tasks: no task carried the same checksum in both arms'
    : `flips over same-checksum tasks: ${flips.overSameChecksum.flips}/${flips.overSameChecksum.of} = ${(flips.overSameChecksum.rate * 100).toFixed(1)}%`);
  console.log('');
  console.log(`effect (B − A): ${fmtPp(stats.effect)}  CI [${fmtPp(stats.ci.lo)}, ${fmtPp(stats.ci.hi)}]  p=${stats.pValue.toFixed(4)}`);
  console.log(`resolution: mde=${fmtPp(stats.mde)} ratio=${stats.resolutionRatio.toFixed(2)} resolvable=${stats.resolvable}`);
  console.log(`verdict: ${stats.verdict}`);
  console.log(`retained: ${dir}`);
  return 0;
}

function cmdGain(args: Map<string, string>): number {
  const statefulDir = args.get('stateful');
  const statelessDir = args.get('stateless');
  if (!statefulDir || !statelessDir) throw new Error('gain needs --stateful <job-dir> and --stateless <job-dir>');
  const stateful = readHarborJob(statefulDir);
  const stateless = readHarborJob(statelessDir);
  const { paired, onlyA, onlyB } = pairArms(stateless, stateful);
  if (paired.length === 0) throw new Error('the two arms share no task — nothing to pair');

  const stats = computeGain(paired.map((p) => ({ taskId: p.taskId, stateful: p.b, stateless: p.a })));
  const spendStateful = armSpend(stateful);
  const spendStateless = armSpend(stateless);
  const report = {
    kind: 'external-gain',
    stateful: { id: stateful.id, dir: stateful.dir, spend: spendStateful },
    stateless: { id: stateless.id, dir: stateless.dir, spend: spendStateless },
    paired,
    unpaired: { onlyStateless: onlyA, onlyStateful: onlyB },
    stats,
  };
  const dir = retain('gain', [stateless, stateful], paired, decodeJsonValue({ value: report }));

  console.log(describeSpend('  stateful spend', spendStateful));
  console.log(describeSpend('  stateless spend', spendStateless));
  console.log('');
  console.log(`stateful reward:  ${stats.statefulReward.toFixed(4)}`);
  console.log(`stateless reward: ${stats.statelessReward.toFixed(4)}`);
  console.log(`mean_gain:        ${stats.gain.toFixed(4)}  (${fmtPp(stats.gain)})`);
  console.log(`CI:               [${fmtPp(stats.ci.lo)}, ${fmtPp(stats.ci.hi)}]  p=${stats.pValue.toFixed(4)}  n=${stats.tasks}`);
  console.log(`verdict: ${stats.verdict}`);
  console.log(`retained: ${dir}`);
  return 0;
}

const USAGE = `Read retained external-benchmark trials and pair them through this
repo's one statistics path. Computes nothing itself.

Usage:
  bun scripts/bench-external.ts compare --a <harbor-job-dir> --b <harbor-job-dir>
  bun scripts/bench-external.ts gain --stateful <harbor-job-dir> --stateless <harbor-job-dir>

A Harbor job directory is the one holding per-trial subdirectories, each with a
result.json — for example bench-artifacts/tb21-main-374ff97.`;

async function main(): Promise<void> {
  const { command, args } = parseArgv(process.argv.slice(2));
  if (!command || args.has('help') || command === 'help') {
    console.log(USAGE);
    return;
  }
  const code = command === 'compare' ? cmdCompare(args)
    : command === 'gain' ? cmdGain(args)
    : (() => { throw new Error(`unknown command "${command}" (expected compare | gain)`); })();
  process.exit(code);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
}
