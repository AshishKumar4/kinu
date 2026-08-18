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
  addUsage, computeGain, decodeJsonValue, fmtPp, pairedBinaryComparison, parseJsonValue,
  usageReported,
} from '../packages/core/src/index';
import type { JsonValue, PairedOutcome, Usage } from '../packages/core/src/index';
import { openRunRetention, resolveArtifactRoot } from './bench-retention';
import { parseArgv } from './bench';

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
      // Named, because "did the mechanism act" is the question an arm's own
      // configuration cannot answer. This is the FILTERED subset — only names in
      // EVOLUTION_EVENTS (bench/clbench/proteus/events.py) reach it, split from
      // the whole activity channel at bench/harbor/trajectory.py:203-210. The
      // unsplit field is what recorded 7 "evolution events" on an evolve=false
      // trial in 2026-08-10's 2.1 job; every one of them was `bg_job_started`.
      evolution_events: v.optional(v.array(v.unknown())),
      activity_events: v.optional(v.array(v.unknown())),
      // How many turns reached a verdict, from the turn_outcomes ledger. `null`
      // is a probe that left nothing readable and is NOT three zeros: an arm
      // that graded nothing and a measurement that never ran are different
      // findings, and only one of them is about the arm.
      turn_grading: v.optional(v.nullable(v.object({
        user_graded: FiniteCount,
        execution_graded: FiniteCount,
        abandoned: FiniteCount,
      }))),
      turns_completed: v.optional(v.number()),
    }))),
  })),
  verifier_result: v.nullable(v.object({
    rewards: v.record(v.string(), v.number()),
  })),
  exception_info: v.optional(v.nullable(v.unknown())),
});

/** Harbor's three token counts keyed by our own field names. The counterpart of
 *  core's `reportedByProvider`: every count a foreign harness omitted stays
 *  omitted, because "this trial recorded no tokens" and "this trial cost nothing"
 *  are the two claims an arm's spend must never confuse. */
function harborUsage(result: v.InferOutput<typeof TrialSchema>['agent_result']): Usage {
  const out: { -readonly [K in keyof Usage]: number } = {};
  const input = result?.n_input_tokens ?? undefined;
  const output = result?.n_output_tokens ?? undefined;
  const cacheRead = result?.n_cache_tokens ?? undefined;
  if (input !== undefined) out.input = input;
  if (output !== undefined) out.output = output;
  if (cacheRead !== undefined) out.cacheRead = cacheRead;
  return out;
}

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
  /** How many EVOLUTION events the agent emitted, the filtered subset. An arm
   *  that claims evolve=true and reports zero is a finding, not a detail. */
  evolutionEvents: number | null;
  /** Everything on the activity channel, which is a busy-ness count and not
   *  evidence about evolution. Reported so nobody has to reach for the one
   *  above when they wanted this one. */
  activityEvents: number | null;
  /** Turns the ENVIRONMENT graded, from the turn_outcomes ledger. `null` is a
   *  probe that left nothing readable, never a zero. */
  executionGradedTurns: number | null;
  /** Turns that completed at all — the denominator the count above needs. */
  turnsCompleted: number | null;
  toolCalls: number | null;
  /** What Harbor's own `agent_result` reported, in this repo's one usage shape.
   *  All three counts are `optional(nullable(...))` upstream and both spellings
   *  mean the adapter recorded nothing, so a trial that was never metered carries
   *  an empty usage rather than three zeros. */
  usage: Usage;
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
      activityEvents: meta?.activity_events === undefined ? null : meta.activity_events.length,
      executionGradedTurns: meta?.turn_grading?.execution_graded ?? null,
      turnsCompleted: meta?.turns_completed ?? null,
      toolCalls: meta?.tool_calls ?? null,
      usage: harborUsage(parsed.agent_result),
      errored: parsed.exception_info !== null && parsed.exception_info !== undefined,
    });
  }
  if (trials.length === 0) throw new Error(`${root} holds no trial result.json files`);
  return { id: basename(root), dir: root, trials };
}

export interface ArmSpend {
  trials: number;
  /** The arm's total, accumulated with `addUsage`, so a count no trial reported
   *  stays absent instead of summing to a zero the harness never observed. */
  usage: Usage;
  /** Uncached input plus output — what the arm actually asked the model to
   *  process. Two arms at "equal spend" must match on this, not on trial count,
   *  which is exactly why it is null as soon as one trial reported no input or no
   *  output: an arm holding unmeasured tasks cannot be equalized against
   *  anything, and summing those tasks as zero made it look CHEAPER than the arm
   *  it was being equalized with, which is the one direction the claim cannot
   *  survive. An unreported cache read is treated as no cache read, the
   *  conservative direction — it can only overstate what this arm was billed. */
  billableTokens: number | null;
  models: string[];
  evolveFlags: (boolean | null)[];
  totalEvolutionEvents: number | null;
  errored: number;
  /** Trials on which the mechanism was OBSERVED to act, over trials that could
   *  have reported. Configured state is `evolveFlags`; this is what happened. */
  trialsWithEvolution: number;
  /** Turns the environment graded, and the turns it had to grade. `null` on
   *  either side is missing evidence — the probe left nothing readable — and is
   *  reported as missing rather than converted to zero, the same rule the
   *  harness already applies to model-call counts. */
  executionGradedTurns: number | null;
  turnsCompleted: number | null;
  /** Trials whose grading probe produced no readable answer. */
  gradingUnreported: number;
  /** Trials that reported no usage at all — a turn the agent timeout killed
   *  emits no `turn_end`. While this is non-zero the token totals above are a
   *  LOWER BOUND, and they under-report exactly the longest trials. */
  spendUnreported: number;
}

export function armSpend(arm: ExternalArm): ArmSpend {
  const events = arm.trials.map((t) => t.evolutionEvents);
  const billable = arm.trials.map((t) => (
    t.usage.input === undefined || t.usage.output === undefined
      ? null
      : Math.max(0, t.usage.input - (t.usage.cacheRead ?? 0)) + t.usage.output
  ));
  const graded = arm.trials.map((t) => t.executionGradedTurns);
  const completed = arm.trials.map((t) => t.turnsCompleted);
  // `every === null` means no trial reported at all, which is missing evidence.
  // Summing over a mix reports what was measured and `gradingUnreported` says
  // how much of the arm the sum does not cover.
  const total = (xs: readonly (number | null)[]) => (xs.every((n) => n === null)
    ? null
    : xs.reduce<number>((n, x) => n + (x ?? 0), 0));
  return {
    trials: arm.trials.length,
    usage: arm.trials.reduce<Usage>((total, t) => addUsage(total, t.usage), {}),
    spendUnreported: arm.trials.filter((t) => !usageReported(t.usage)).length,
    billableTokens: billable.every((tokens) => tokens !== null)
      ? billable.reduce((total, tokens) => total + tokens, 0)
      : null,
    models: [...new Set(arm.trials.map((t) => t.model ?? 'unknown'))].sort(),
    evolveFlags: [...new Set(arm.trials.map((t) => t.evolve))],
    totalEvolutionEvents: total(events),
    errored: arm.trials.filter((t) => t.errored).length,
    trialsWithEvolution: arm.trials.filter((t) => (t.evolutionEvents ?? 0) > 0).length,
    executionGradedTurns: total(graded),
    turnsCompleted: total(completed),
    gradingUnreported: arm.trials.filter((t) => t.executionGradedTurns === null).length,
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

/** How far apart two arms' billable spend may be before the contrast is
 *  measuring provisioning rather than the mechanism. Symmetric on purpose: 1.5x
 *  in either direction is the same confound. */
const SPEND_RATIO_TOLERANCE = 1.5;

export interface AdmissibilityCondition {
  name: string;
  met: boolean;
  /** What was actually observed, whether or not it cleared the bar. */
  detail: string;
}

export interface Admissibility {
  admissible: boolean;
  conditions: AdmissibilityCondition[];
}

/**
 * Whether this pair of arms can carry a claim at all — asked BEFORE any effect
 * is reported, and answered from what the trials observed rather than from what
 * they were configured with.
 *
 * Both prior Terminal-Bench runs were configured `evolve=false` in both arms and
 * later read as a comparison of evolution. Nothing in the pipeline objected,
 * because the pipeline only ever saw a pass rate. The rule this encodes is that
 * a check must measure the set it governs, must be able to fail loudly, must not
 * publish a number when it fails, and must sit upstream of everything that
 * publishes — which is why the caller consults this before printing an effect
 * and not alongside it.
 *
 * `candidateEvolves` is the arm state the caller is claiming to compare. A pair
 * where neither arm was supposed to evolve is a legitimate replication and is
 * held to the mirror-image bar.
 */
export function admissibility(
  a: ExternalArm, b: ExternalArm, paired: readonly PairedTask[],
): Admissibility {
  const spendA = armSpend(a);
  const spendB = armSpend(b);
  const candidateEvolves = spendB.evolveFlags.length === 1 && spendB.evolveFlags[0] === true;
  // Null when either arm holds an unmetered trial: a ratio against a floor is
  // not a ratio, and summing unmeasured trials as zero made the candidate arm
  // look cheaper than the arm it was being equalized against.
  const ratio = spendA.billableTokens === null || spendB.billableTokens === null
    || spendA.billableTokens === 0
    ? null
    : spendB.billableTokens / spendA.billableTokens;
  const mismatched = paired.filter((p) => p.sameChecksum === false).map((p) => p.taskId);
  const gradedB = spendB.executionGradedTurns;

  const conditions: AdmissibilityCondition[] = [
    {
      name: 'each arm ran one arm state',
      met: spendA.evolveFlags.length === 1 && spendB.evolveFlags.length === 1,
      detail: `A=${spendA.evolveFlags.join('/')}  B=${spendB.evolveFlags.join('/')}`,
    },
    {
      name: 'the two arms differ in that state',
      met: spendA.evolveFlags.length === 1 && spendB.evolveFlags.length === 1
        && spendA.evolveFlags[0] !== spendB.evolveFlags[0],
      detail: spendA.evolveFlags[0] === spendB.evolveFlags[0]
        ? `both arms ran evolve=${String(spendA.evolveFlags[0])} — this is a replication, not a contrast`
        : `evolve ${String(spendA.evolveFlags[0])} vs ${String(spendB.evolveFlags[0])}`,
    },
    {
      name: 'the candidate mechanism was OBSERVED to act',
      met: candidateEvolves
        ? spendB.trialsWithEvolution * 2 >= spendB.trials
        : spendB.trialsWithEvolution === 0,
      detail: `${spendB.trialsWithEvolution}/${spendB.trials} candidate trial(s) emitted an evolution event`
        + `${candidateEvolves ? ' (needs a majority)' : ' (evolve=false, needs none)'}`,
    },
    {
      name: 'the baseline mechanism stayed off',
      met: spendA.evolveFlags[0] === true || spendA.trialsWithEvolution === 0,
      detail: `${spendA.trialsWithEvolution}/${spendA.trials} baseline trial(s) emitted an evolution event`,
    },
    {
      name: 'the candidate turns were GRADED',
      met: gradedB !== null && gradedB > 0,
      detail: gradedB === null
        ? `unreported — ${spendB.gradingUnreported}/${spendB.trials} candidate trial(s) left no readable `
          + 'grading probe, so this arm cannot say whether its turns were graded'
        : `${gradedB} execution-graded turn(s) over ${spendB.turnsCompleted ?? 'unreported'} completed`
          + `${spendB.gradingUnreported > 0 ? `, ${spendB.gradingUnreported} trial(s) unreported` : ''}`,
    },
    {
      name: 'both arms scored the identical task',
      met: mismatched.length === 0,
      detail: mismatched.length === 0
        ? `${paired.length} paired task(s), no checksum mismatch`
        : `${mismatched.length} task(s) differ between the arms: ${mismatched.join(', ')}`,
    },
    {
      name: 'the arms spent comparably',
      met: ratio !== null && ratio <= SPEND_RATIO_TOLERANCE && ratio >= 1 / SPEND_RATIO_TOLERANCE,
      detail: ratio === null
        ? 'the baseline arm billed 0 tokens, so no ratio exists'
        : `B/A = ${ratio.toFixed(3)} on billable tokens (tolerance `
          + `${(1 / SPEND_RATIO_TOLERANCE).toFixed(3)}–${SPEND_RATIO_TOLERANCE.toFixed(3)})`,
    },
  ];
  return { admissible: conditions.every((c) => c.met), conditions };
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
  const count = (value: number | undefined): string => (
    value === undefined ? 'unreported' : value.toLocaleString()
  );
  return `${label.padEnd(28)} trials=${String(spend.trials).padStart(3)}  `
    + `billable=${(spend.billableTokens === null ? 'unmeasurable' : spend.billableTokens.toLocaleString()).padStart(12)}  `
    + `in=${count(spend.usage.input).padStart(12)}  `
    + `cached=${count(spend.usage.cacheRead).padStart(12)}  `
    + `out=${count(spend.usage.output).padStart(9)}  `
    + (spend.spendUnreported > 0 ? `unmetered=${String(spend.spendUnreported)}/${String(spend.trials)}  ` : '')
    + `evolve=${spend.evolveFlags.map((f) => String(f)).join('/')}  `
    + `evolutionEvents=${spend.totalEvolutionEvents ?? 'not recorded'}  `
    + `firedOn=${spend.trialsWithEvolution}/${spend.trials}  `
    + `gradedTurns=${spend.executionGradedTurns ?? 'unreported'}/`
    + `${spend.turnsCompleted ?? 'unreported'}  `
    + `errors=${spend.errored}  models=${spend.models.join(',')}`
    + (spend.spendUnreported > 0
      ? `\n${' '.repeat(30)}LOWER BOUND: ${spend.spendUnreported}/${spend.trials} trial(s) reported no usage `
        + '(no turn_end — the agent timeout killed the turn), so these totals omit them entirely'
      : '');
}

function describeAdmissibility(verdict: Admissibility): void {
  console.log(verdict.admissible
    ? 'ADMISSIBLE — the arms differ in the mechanism, the mechanism acted, and the turns were graded.'
    : 'INADMISSIBLE — this pair of arms cannot carry a claim about the mechanism.');
  for (const c of verdict.conditions) {
    console.log(`  ${c.met ? 'ok  ' : 'NO  '}${c.name.padEnd(42)} ${c.detail}`);
  }
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
  // A ratio against a floor is not a ratio: one unmetered trial in either arm and
  // the equal-spend claim is unmeasurable rather than favourable.
  const spendRatio = spendA.billableTokens === null || spendB.billableTokens === null
    || spendA.billableTokens === 0
    ? null
    : spendB.billableTokens / spendA.billableTokens;
  const noRatioBecause = spendA.billableTokens === null || spendB.billableTokens === null
    ? 'unmeasurable — an arm holds trials that reported no token counts'
    : 'n/a — arm A billed no tokens';
  const verdict = admissibility(a, b, paired);

  const report = {
    kind: 'external-paired-comparison',
    armA: { id: a.id, dir: a.dir, spend: spendA },
    armB: { id: b.id, dir: b.dir, spend: spendB },
    spendRatio,
    admissibility: verdict,
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
  console.log(`  spend ratio B/A on billable tokens: ${spendRatio === null ? noRatioBecause : spendRatio.toFixed(3)}`);
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
  describeAdmissibility(verdict);
  console.log('');
  console.log(`flips over all shared tasks:  ${flips.overAllShared.flips}/${flips.overAllShared.of} = ${(flips.overAllShared.rate * 100).toFixed(1)}%`);
  console.log(flips.overSameChecksum === null
    ? 'flips over same-checksum tasks: no task carried the same checksum in both arms'
    : `flips over same-checksum tasks: ${flips.overSameChecksum.flips}/${flips.overSameChecksum.of} = ${(flips.overSameChecksum.rate * 100).toFixed(1)}%`);
  console.log('');
  // The effect is printed only behind the gate. Every per-task reward is in the
  // retained artifact either way — withholding evidence would be worse than
  // publishing a bad headline — but an inadmissible pair must not hand a reader
  // a number to quote, because that is exactly how 5/10 over two evolve=false
  // arms became a sentence about self-evolution.
  if (!verdict.admissible) {
    console.log('effect: WITHHELD. A contrast that failed admissibility has no effect to report — the');
    console.log('failing condition above is the result. Per-task rewards are retained in full.');
    console.log(`retained: ${dir}`);
    return 1;
  }
  console.log(`effect (B − A): ${fmtPp(stats.effect)}  CI [${fmtPp(stats.ci.lo)}, ${fmtPp(stats.ci.hi)}]  p=${stats.pValue.toFixed(4)}`);
  console.log(`differing pairs: ${stats.discordant}/${stats.pairs}  `
    + `floor p=${stats.floorPValue.toExponential(4)}  canReachSignificance=${stats.canReachSignificance}`);
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
