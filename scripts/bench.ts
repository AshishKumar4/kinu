#!/usr/bin/env bun
// The Proteus bench harness — a machine-scored answer to "does any of this
// help?", with rejection by default and a held-out split.
//
//   bun scripts/bench.ts validate
//       Prove every task is a task: the defect must fail this repo's checks and
//       reversing it must pass them. Runs no model.
//
//   bun scripts/bench.ts compare --a <variant> --b <variant> [--sealed]
//       Paired comparison. Same tasks, both variants, order randomized per task
//       from the seed, every attempt in its own throwaway sandbox and home.
//
//   bun scripts/bench.ts gain --stateful <variant> --stateless <variant>
//       CL-Bench's stateful-vs-stateless primitive: one identical sequence run
//       twice, once with evolution state live and once from a fresh v0.
//
// Two corpora, selected by --family and never mixed: `defect` (a seeded defect
// in this repo) and `longhorizon` (a generated corpus, digested in one ask or
// carried across episodes through forced compaction).
//
// Variants: null | oracle | noisy:<rate> | agent | agent-evolving
// The first three make no model calls and exist to validate the instrument.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_ATTEMPT_BUDGET, buildBenchReport, buildGainReport, renderBenchSummary,
  renderGainSummary, runOrder, validateWithRetries, fnv1a64,
} from '../packages/core/src/index.js';
import type {
  AttemptBudget, AttemptOutcome, BenchCorpus, BenchRunConfig, BenchTask, GainTaskScore,
  LLMProviderConfig, SealedScorecard, Solver, TaskValidation,
} from '../packages/core/src/index.js';
import { loadBenchCorpus } from './bench-corpus.js';
import {
  applyPatch, budgetSignal, createAttemptSandbox, ensureRunRoot, scoreSandbox,
} from './bench-sandbox.js';
import {
  createAgentSolver, createNoisyOracleSolver, createOracleSolver, nullSolver,
  type PatchLookup,
} from './bench-solvers.js';
import {
  createLongHorizonAgentSolver, createLongHorizonNoisySolver, createLongHorizonOracleSolver,
  loadLongHorizonCorpus, materializeLongHorizon, specFor,
} from './bench-longhorizon.js';

const REPO_ROOT = join(import.meta.dir, '..');
const SEAL_LEDGER = join(REPO_ROOT, 'tests', 'bench', 'seal-ledger.jsonl');

/** Extra well-formedness checks a failing task gets before it is called BAD.
 *  Bounded on purpose: retrying is for absorbing a false fail, not for hunting
 *  until a broken task happens to pass once. */
export const DEFAULT_VALIDATE_RETRIES = 2;

export interface CommonOptions {
  runRoot: string;
  seed: number;
  budget: AttemptBudget;
  /** Attempts per task per variant. */
  repeats: number;
  validateRetries: number;
  limit: number | null;
  out: string | null;
  keepSandboxes: boolean;
  family: BenchFamilyId;
}

/** Two corpora, never mixed. `defect` scores a seeded repo defect by running
 *  this repo's own checks; `longhorizon` scores exact answers over a generated
 *  corpus, in the digestion and continuation shapes. They measure different
 *  things, so averaging them would produce a number about nothing — the family
 *  is part of the run configuration and therefore part of the config hash. */
export const BENCH_FAMILIES = ['defect', 'longhorizon'] as const;
export type BenchFamilyId = (typeof BENCH_FAMILIES)[number];

export function parseCommon(args: Map<string, string>): CommonOptions {
  const runRoot = args.get('run-root') ?? process.env.BENCH_RUN_ROOT ?? null;
  if (!runRoot) {
    throw new Error('--run-root is required (or set BENCH_RUN_ROOT). It must be a throwaway directory outside your home — the harness refuses anything else.');
  }
  const num = (key: string, fallback: number): number => {
    const raw = args.get(key);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`--${key} must be a number, got ${raw}`);
    return n;
  };
  const count = (key: string, fallback: number, min: number): number => {
    const n = num(key, fallback);
    if (!Number.isInteger(n) || n < min) throw new Error(`--${key} must be an integer ≥ ${min}, got ${n}`);
    return n;
  };
  const limitRaw = args.get('limit');
  const family = args.get('family') ?? 'defect';
  if (!(BENCH_FAMILIES as readonly string[]).includes(family)) {
    throw new Error(`--family must be one of ${BENCH_FAMILIES.join(' | ')}, got "${family}"`);
  }
  return {
    family: family as BenchFamilyId,
    runRoot: ensureRunRoot(runRoot, REPO_ROOT),
    seed: num('seed', 1),
    budget: {
      wallClockMs: num('wall-clock-ms', DEFAULT_ATTEMPT_BUDGET.wallClockMs),
      maxTokens: num('max-tokens', DEFAULT_ATTEMPT_BUDGET.maxTokens),
    },
    repeats: count('repeats', 1, 1),
    validateRetries: count('validate-retries', DEFAULT_VALIDATE_RETRIES, 0),
    limit: limitRaw === undefined ? null : Number(limitRaw),
    out: args.get('out') ?? null,
    keepSandboxes: args.has('keep-sandboxes'),
  };
}

/** Provider config for the agent variants, taken from BENCH_* rather than
 *  PROTEUS_* so an operator's ambient environment — which may point at their
 *  real workspaces — can never be what a scored run talks to. */
function benchLLM(): LLMProviderConfig {
  const baseURL = process.env.BENCH_BASE_URL;
  const auth = process.env.BENCH_AUTH;
  const model = process.env.BENCH_MODEL;
  if (!baseURL || !auth || !model) {
    throw new Error('agent variants need BENCH_BASE_URL, BENCH_AUTH and BENCH_MODEL. Deterministic variants (null/oracle/noisy) need none.');
  }
  return {
    name: model.startsWith('@cf/') ? 'workers-ai' : 'openai-compat',
    baseURL,
    headers: { Authorization: auth },
    model,
  };
}

/** One corpus, its sandbox seeding, and its controls. The two families differ
 *  in exactly these three things; everything downstream — pairing, seal,
 *  statistics, report — is shared. */
interface BenchFamily {
  id: BenchFamilyId;
  corpus: BenchCorpus;
  /** Corpus file path, printed in the report. */
  path: string;
  /** Puts the task's starting state into a fresh sandbox copy. */
  prepare(task: BenchTask): (dir: string) => void;
  resolveSolver(spec: string, opts: { sharedHome?: string }): Solver;
}

/** Shared by both families: the agent variants differ only in which solver
 *  factory builds them. */
function agentVariant(spec: string): { id: string; description: string; state: 'fresh' | 'shared'; autoEvolve: boolean } {
  const evolving = spec === 'agent-evolving';
  return {
    id: spec,
    description: evolving
      ? 'Proteus with evolution live and state carried across the sequence'
      : 'Proteus from a fresh v0 workspace per task',
    state: evolving ? 'shared' : 'fresh',
    autoEvolve: evolving,
  };
}

function unknownVariant(spec: string): never {
  throw new Error(`unknown variant "${spec}" (expected null | oracle | noisy:<rate> | agent | agent-evolving)`);
}

function noisyRate(spec: string): number | null {
  return spec.startsWith('noisy:') ? Number(spec.slice('noisy:'.length)) : null;
}

function loadFamily(id: BenchFamilyId): BenchFamily {
  if (id === 'defect') {
    const { corpus, patches, path } = loadBenchCorpus(REPO_ROOT);
    return {
      id, corpus, path,
      prepare: (task) => (dir) => applyPatch(dir, patchFor(patches, task.id), { reverse: false }),
      resolveSolver: (spec, opts) => {
        if (spec === 'null') return nullSolver;
        if (spec === 'oracle') return createOracleSolver(patches);
        const rate = noisyRate(spec);
        if (rate !== null) return createNoisyOracleSolver(patches, rate, spec);
        if (spec === 'agent' || spec === 'agent-evolving') {
          return createAgentSolver({
            ...agentVariant(spec), llm: benchLLM(), repoRoot: REPO_ROOT,
            ...(opts.sharedHome ? { sharedHome: opts.sharedHome } : {}),
          });
        }
        return unknownVariant(spec);
      },
    };
  }
  const { corpus, specs, path } = loadLongHorizonCorpus(REPO_ROOT);
  return {
    id, corpus, path,
    prepare: (task) => (dir) => materializeLongHorizon(dir, specFor(specs, task.id)),
    resolveSolver: (spec, opts) => {
      if (spec === 'null') return nullSolver;
      if (spec === 'oracle') return createLongHorizonOracleSolver(specs);
      const rate = noisyRate(spec);
      if (rate !== null) return createLongHorizonNoisySolver(specs, rate, spec);
      if (spec === 'agent' || spec === 'agent-evolving') {
        return createLongHorizonAgentSolver({
          ...agentVariant(spec), llm: benchLLM(), repoRoot: REPO_ROOT, specs,
          ...(opts.sharedHome ? { sharedHome: opts.sharedHome } : {}),
        });
      }
      return unknownVariant(spec);
    },
  };
}

function patchFor(patches: PatchLookup, taskId: string): string {
  const patch = patches.get(taskId);
  if (!patch) throw new Error(`no defect patch for task ${taskId}`);
  return patch;
}

interface AttemptRequest {
  task: BenchTask;
  solver: Solver;
  slot: 'a' | 'b';
  repeat: number;
  family: BenchFamily;
  common: CommonOptions;
  attemptId: string;
}

async function runAttempt(req: AttemptRequest): Promise<AttemptOutcome> {
  const { task, solver, common } = req;

  const sandbox = createAttemptSandbox({
    repoRoot: REPO_ROOT,
    runRoot: common.runRoot,
    attemptId: req.attemptId,
    prepare: req.family.prepare(task),
  });

  const started = Date.now();
  const budget = budgetSignal(common.budget);
  let tokens = 0;
  let peakPromptTokens = 0;
  let error: string | undefined;
  try {
    const result = await solver.solve({
      task,
      sandboxDir: sandbox.dir,
      proteusHome: sandbox.proteusHome,
      budget: common.budget,
      signal: budget.signal,
      seed: common.seed,
      repeat: req.repeat,
    });
    tokens = result.tokens ?? 0;
    peakPromptTokens = result.peakPromptTokens ?? 0;
    error = result.error;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    budget.done();
  }
  const solveMs = Date.now() - started;

  // Scoring happens after the budget window and is never charged to it: the
  // variant is what is being measured, not the scorer.
  const { checks, passed } = await scoreSandbox(task, sandbox, REPO_ROOT);
  if (!common.keepSandboxes) sandbox.dispose();

  const budgetBreach = budget.timedOut() ? 'wall-clock' : (tokens > common.budget.maxTokens ? 'tokens' : null);
  return {
    taskId: task.id,
    variantId: solver.id,
    slot: req.slot,
    repeat: req.repeat,
    passed: passed && !budgetBreach,
    checks,
    durationMs: solveMs,
    tokens,
    peakPromptTokens,
    budgetBreach,
    ...(error ? { error } : {}),
  };
}

/** Both variants on one task, order randomized from the seed, each in its own
 *  sandbox and its own PROTEUS_HOME — so no memory, CraftStore, or scaffold
 *  state from one variant can reach the next. */
async function runPair(
  task: BenchTask,
  repeat: number,
  solvers: { a: Solver; b: Solver },
  family: BenchFamily,
  common: CommonOptions,
): Promise<{ a: AttemptOutcome; b: AttemptOutcome }> {
  const order = runOrder(task.id, common.seed, repeat);
  const first = order === 'ab' ? 'a' : 'b';
  const second = first === 'a' ? 'b' : 'a';
  const attempt = (slot: 'a' | 'b') => runAttempt({
    task, solver: solvers[slot], slot, repeat, family, common,
    attemptId: `${task.id}-${slot}-r${repeat}-${fnv1a64(`${common.seed}:${task.id}:${slot}:${repeat}`).slice(0, 8)}`,
  });
  const firstOut = await attempt(first);
  const secondOut = await attempt(second);
  return first === 'a' ? { a: firstOut, b: secondOut } : { a: secondOut, b: firstOut };
}

/** Every repeat of one task, both variants. The repeats are attempts at the
 *  SAME task and are aggregated as one pair downstream — see bench/stats.ts. */
async function runRepeats(
  task: BenchTask,
  solvers: { a: Solver; b: Solver },
  family: BenchFamily,
  common: CommonOptions,
): Promise<{ a: AttemptOutcome[]; b: AttemptOutcome[] }> {
  const a: AttemptOutcome[] = [];
  const b: AttemptOutcome[] = [];
  for (let repeat = 0; repeat < common.repeats; repeat++) {
    const pair = await runPair(task, repeat, solvers, family, common);
    a.push(pair.a);
    b.push(pair.b);
  }
  return { a, b };
}

/** `2/3` when the repeats disagreed, `pass`/`fail` when there is only one. */
function tally(outcomes: readonly AttemptOutcome[]): string {
  const passes = outcomes.filter((o) => o.passed).length;
  if (outcomes.length === 1) return passes === 1 ? 'pass' : 'fail';
  return `${passes}/${outcomes.length}${passes > 0 && passes < outcomes.length ? '~' : ''}`;
}

function limitTasks(tasks: readonly BenchTask[], limit: number | null): BenchTask[] {
  const ordered = [...tasks].sort((x, y) => x.id.localeCompare(y.id));
  return limit === null ? ordered : ordered.slice(0, limit);
}

function corpusLabel(path: string, limit: number | null): string {
  return limit === null ? path : `${path} (limit ${limit})`;
}

function appendSealLedger(entry: Record<string, unknown>): number {
  mkdirSync(join(REPO_ROOT, 'tests', 'bench'), { recursive: true });
  const prior = existsSync(SEAL_LEDGER)
    ? readFileSync(SEAL_LEDGER, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#')).length
    : 0;
  const ordinal = prior + 1;
  appendFileSync(SEAL_LEDGER, `${JSON.stringify({ ordinal, ...entry })}\n`);
  return ordinal;
}

/** One well-formedness check: the task must fail with nothing done and pass
 *  under the oracle. Both directions are machine-run; neither involves a
 *  variant, so this says nothing about anyone's performance. */
async function checkWellFormed(
  task: BenchTask,
  repeat: number,
  family: BenchFamily,
  common: CommonOptions,
  oracle: Solver,
): Promise<{ ok: boolean; detail: string }> {
  const broken = await runAttempt({
    task, solver: nullSolver, slot: 'a', repeat, family, common,
    attemptId: `validate-broken-${task.id}-${repeat}`,
  });
  const fixed = await runAttempt({
    task, solver: oracle, slot: 'b', repeat, family, common,
    attemptId: `validate-fixed-${task.id}-${repeat}`,
  });
  const ok = !broken.passed && fixed.passed;
  const failing = broken.checks.find((c) => !c.passed)?.id ?? 'none';
  return {
    ok,
    detail: ok
      ? `unsolved trips ${failing}, oracle restores it`
      : `unsolved→${broken.passed ? 'PASS (nothing to solve)' : 'fail'}, oracle→${fixed.passed ? 'pass' : `FAIL${fixed.error ? ` ${fixed.error}` : ''}`}`,
  };
}

/** Well-formedness with a bounded retry, because validation is itself noisy: a
 *  full 165-task run once flagged `autojudge-slot-scores-swapped` BAD, and it
 *  then validated 5/5 in isolation and passed the next complete run. One scored
 *  attempt can record a false fail, so a failure is re-checked before the task
 *  is condemned — see validateWithRetries for why the budget is bounded. */
function isWellFormed(
  task: BenchTask,
  family: BenchFamily,
  common: CommonOptions,
  oracle: Solver,
): Promise<TaskValidation> {
  return validateWithRetries(common.validateRetries, (attempt) =>
    checkWellFormed(task, attempt - 1, family, common, oracle));
}

async function cmdValidate(common: CommonOptions): Promise<number> {
  const family = loadFamily(common.family);
  const corpus = family.corpus;
  const devTasks = limitTasks(corpus.dev, common.limit);
  const oracle = family.resolveSolver('oracle', {});

  console.log(`Validating ${family.path}`);
  console.log('Each task must FAIL with nothing done and PASS under the oracle.');
  console.log(`A failing task is re-checked up to ${common.validateRetries} more time(s) before it is called BAD.\n`);

  let bad = 0;
  const flakyDev: string[] = [];
  console.log(`dev split (${devTasks.length} tasks):`);
  for (const task of devTasks) {
    const result = await isWellFormed(task, family, common, oracle);
    const onlyOnRetry = result.ok && (result.passedOnAttempt ?? 1) > 1;
    if (!result.ok) bad++;
    else if (onlyOnRetry) flakyDev.push(task.id);
    console.log(`  ${!result.ok ? 'BAD ' : onlyOnRetry ? 'FLKY' : 'ok  '} ${task.id.padEnd(28)} ${result.detail}`);
  }

  // The seal returns which held-out tasks are BROKEN or UNSTABLE and nothing
  // else — a corpus bug report, never a scoreboard.
  const sealedResult = await corpus.sealed.validate((task) => isWellFormed(task, family, common, oracle));
  bad += sealedResult.invalid.length;
  console.log(`\nsealed split (${sealedResult.checked} tasks): ${sealedResult.checked - sealedResult.invalid.length} valid`);
  for (const id of sealedResult.invalid) console.log(`  BAD  ${id}`);
  for (const id of sealedResult.flaky) console.log(`  FLKY ${id}`);

  const total = devTasks.length + sealedResult.checked;
  const flaky = flakyDev.length + sealedResult.flaky.length;
  console.log(`\n${total - bad}/${total} tasks valid.`);
  if (flaky > 0) {
    // Valid, but not trustworthy as a single scored attempt: the same
    // non-determinism that made these pass on a retry can make a compare run
    // record a false fail.
    console.log(`${flaky} task(s) only passed on a retry — non-deterministic, and a single scored attempt on them can record a false fail:`);
    for (const id of [...flakyDev, ...sealedResult.flaky]) console.log(`  ${id}`);
    console.log('Run compare with --repeats > 1 so these show up as unstable rather than as a score.');
  }
  if (bad > 0) console.log('A task that passes with nothing done, or that the oracle cannot pass, is not a task.');
  return bad === 0 ? 0 : 1;
}

async function cmdCompare(args: Map<string, string>, common: CommonOptions): Promise<number> {
  const specA = args.get('a');
  const specB = args.get('b');
  if (!specA || !specB) throw new Error('compare needs --a <variant> and --b <variant>');
  const family = loadFamily(common.family);
  const corpus = family.corpus;

  const sharedHomeA = join(common.runRoot, 'shared-a');
  const sharedHomeB = join(common.runRoot, 'shared-b');
  const solvers = {
    a: family.resolveSolver(specA, { sharedHome: sharedHomeA }),
    b: family.resolveSolver(specB, { sharedHome: sharedHomeB }),
  };

  const devTasks = limitTasks(corpus.dev, common.limit);
  const config: BenchRunConfig = {
    corpus: corpusLabel(family.path, common.limit),
    budget: common.budget,
    seed: common.seed,
    variantA: solvers.a.id,
    variantB: solvers.b.id,
    repeats: common.repeats,
    manifestHash: corpus.manifestHash,
  };
  const runId = fnv1a64(`${Date.now()}:${config.variantA}:${config.variantB}:${config.seed}`).slice(0, 12);

  console.error(`dev split: ${devTasks.length} tasks × 2 variants × ${common.repeats} repeat(s)`);
  const devAttempts: AttemptOutcome[] = [];
  for (const task of devTasks) {
    const { a, b } = await runRepeats(task, solvers, family, common);
    devAttempts.push(...a, ...b);
    console.error(`  ${task.id.padEnd(28)} ${config.variantA}=${tally(a)}  ${config.variantB}=${tally(b)}`);
  }

  let sealed: SealedScorecard | null = null;
  let ordinal: number | null = null;
  if (args.has('sealed')) {
    console.error(`sealed split: ${corpus.sealed.size} tasks × 2 variants × ${common.repeats} repeat(s) (aggregates only)`);
    sealed = await corpus.sealed.evaluate(async (task) => {
      const { a, b } = await runRepeats(task, solvers, family, common);
      return { a: a.map((o) => o.passed), b: b.map((o) => o.passed) };
    }, { seed: common.seed });
    ordinal = appendSealLedger({
      ts: Date.now(), runId, family: family.id, manifestHash: sealed.manifestHash,
      variantA: config.variantA, variantB: config.variantB, repeats: common.repeats,
      tasks: sealed.tasks, effect: sealed.stats.effect, pValue: sealed.stats.pValue,
      passAllA: sealed.stats.passAllA, passAllB: sealed.stats.passAllB,
      unstable: sealed.stats.flakyEither,
    });
  }

  const report = buildBenchReport({ runId, config, devAttempts, sealed, sealAccessOrdinal: ordinal });
  if (common.out) {
    writeFileSync(common.out, JSON.stringify(report, null, 2));
    console.error(`Wrote ${common.out}`);
  }
  console.log(renderBenchSummary(report));
  return args.has('require-accept') && !report.decision.accept ? 1 : 0;
}

async function cmdGain(args: Map<string, string>, common: CommonOptions): Promise<number> {
  const statefulSpec = args.get('stateful') ?? 'agent-evolving';
  const statelessSpec = args.get('stateless') ?? 'agent';
  const family = loadFamily(common.family);
  const sequence = limitTasks(family.corpus.dev, common.limit);
  if (sequence.length === 0) throw new Error('no tasks in the sequence');

  const stateless = family.resolveSolver(statelessSpec, {});
  // The replicate here is a whole PASS over the sequence, not an individual
  // attempt: the stateful arm's point is that state accumulates ALONG the
  // sequence, so re-attempting one task mid-run would be measuring the same
  // accumulated state twice, not an independent draw. Each pass therefore gets
  // its own shared home — a genuinely fresh v0 identity — and a task's reward
  // is its mean over passes.
  const statefulPasses = Array.from({ length: common.repeats }, (_, pass) => family.resolveSolver(
    statefulSpec, { sharedHome: join(common.runRoot, `stateful-home-${pass}`) },
  ));

  const config: BenchRunConfig = {
    corpus: corpusLabel(family.path, common.limit),
    budget: common.budget,
    seed: common.seed,
    variantA: stateless.id,
    variantB: statefulPasses[0]!.id,
    repeats: common.repeats,
    manifestHash: family.corpus.manifestHash,
  };
  const runId = fnv1a64(`gain:${Date.now()}:${config.seed}`).slice(0, 12);

  const scores = new Map<string, { stateful: number; stateless: number }>();
  for (let pass = 0; pass < common.repeats; pass++) {
    const stateful = statefulPasses[pass]!;

    // Both arms see the identical sequence in the identical order — that is the
    // whole design. Which arm runs first is randomized from the seed so any host
    // drift over the run does not systematically favour one of them.
    const statefulFirst = runOrder('arm-order', common.seed, pass) === 'ab';
    const arms: Array<{ solver: Solver; key: 'stateful' | 'stateless' }> = statefulFirst
      ? [{ solver: stateful, key: 'stateful' }, { solver: stateless, key: 'stateless' }]
      : [{ solver: stateless, key: 'stateless' }, { solver: stateful, key: 'stateful' }];

    for (const arm of arms) {
      console.error(`${arm.key} arm, pass ${pass + 1}/${common.repeats}: ${sequence.length} tasks in sequence`);
      for (const [index, task] of sequence.entries()) {
        const outcome = await runAttempt({
          task, solver: arm.solver, slot: arm.key === 'stateful' ? 'b' : 'a', repeat: pass, family, common,
          attemptId: `gain-${arm.key}-p${pass}-${index}-${task.id}`,
        });
        const entry = scores.get(task.id) ?? { stateful: 0, stateless: 0 };
        entry[arm.key] += (outcome.passed ? 1 : 0) / common.repeats;
        scores.set(task.id, entry);
        console.error(`  ${String(index).padStart(2)} ${task.id.padEnd(28)} ${outcome.passed ? 'pass' : 'fail'}`);
      }
    }
  }

  const perTask: GainTaskScore[] = sequence.map((task, index) => ({
    taskId: task.id,
    index,
    stateful: scores.get(task.id)!.stateful,
    stateless: scores.get(task.id)!.stateless,
  }));

  const report = buildGainReport({ runId, config, perTask });
  if (common.out) {
    writeFileSync(common.out, JSON.stringify(report, null, 2));
    console.error(`Wrote ${common.out}`);
  }
  console.log(renderGainSummary(report));
  return 0;
}

const USAGE = `Proteus bench harness — machine-scored, sealed-split, rejection by default

Usage:
  bun scripts/bench.ts validate  --run-root <dir> [--limit n] [--validate-retries n]
  bun scripts/bench.ts compare   --run-root <dir> --a <variant> --b <variant> [--repeats n] [--sealed] [--require-accept]
  bun scripts/bench.ts gain      --run-root <dir> [--stateful <variant>] [--stateless <variant>] [--repeats n]

Families (--family, default defect):
  defect            a seeded defect in this repo, scored by this repo's own checks
  longhorizon       a generated corpus, scored by exact answers, in two shapes:
                    single-query digestion and multi-episode continuation across
                    forced compaction. Never mixed with defect — they measure
                    different things, so --family is part of the config hash.

Variants:
  null              no-op control (must fail everything)
  oracle            reverses the defect (must pass everything)
  noisy:<rate>      synthetic solver with a known success rate, seeded
  agent             Proteus from a fresh v0 workspace per task
  agent-evolving    Proteus with evolution live, state carried across the sequence

Options:
  --run-root <dir>     REQUIRED. Throwaway directory outside your home.
  --family <name>      Which corpus to run (default defect)
  --seed <n>           Run seed: pairing order, bootstrap, noisy draws (default 1)
  --wall-clock-ms <n>  Per-attempt wall-clock budget (default ${DEFAULT_ATTEMPT_BUDGET.wallClockMs})
  --max-tokens <n>     Per-attempt token budget (default ${DEFAULT_ATTEMPT_BUDGET.maxTokens})
  --repeats <n>        compare: attempts per task per variant; gain: passes over
                       the sequence (default 1). Reports pass^n alongside pass@1
                       and surfaces tasks whose repeats disagree. The pairing
                       unit stays the TASK, so repeats buy precision, not power.
  --validate-retries <n>  validate: extra well-formedness checks a failing task
                       gets before it is called BAD (default ${DEFAULT_VALIDATE_RETRIES}). A task that
                       only passes on a retry is reported as FLKY, not ok.
  --limit <n>          Use only the first n tasks (recorded in the report)
  --out <path>         Write the JSON report here
  --keep-sandboxes     Do not delete attempt sandboxes (debugging)

Agent variants read BENCH_BASE_URL / BENCH_AUTH / BENCH_MODEL. Deterministic
variants need no credentials and make no model calls.`;

export function parseArgv(argv: string[]): { command: string; args: Map<string, string> } {
  const args = new Map<string, string>();
  const command = argv[0] ?? '';
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args.set(key, '');
    else { args.set(key, next); i++; }
  }
  return { command, args };
}

async function main(): Promise<void> {
  const { command, args } = parseArgv(process.argv.slice(2));
  if (!command || args.has('help') || command === 'help') {
    console.log(USAGE);
    return;
  }
  const common = parseCommon(args);
  const code = command === 'validate' ? await cmdValidate(common)
    : command === 'compare' ? await cmdCompare(args, common)
    : command === 'gain' ? await cmdGain(args, common)
    : (() => { throw new Error(`unknown command "${command}"`); })();
  process.exit(code);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
}
