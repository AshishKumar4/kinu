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
// Variants: null | oracle | noisy:<rate> | agent | agent-evolving
// The first three make no model calls and exist to validate the instrument.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_ATTEMPT_BUDGET, buildBenchReport, buildGainReport, renderBenchSummary,
  renderGainSummary, runOrder, fnv1a64,
} from '../packages/core/src/index.js';
import type {
  AttemptBudget, AttemptOutcome, BenchRunConfig, BenchTask, GainTaskScore,
  LLMProviderConfig, SealedScorecard, Solver,
} from '../packages/core/src/index.js';
import { loadBenchCorpus } from './bench-corpus.js';
import {
  budgetSignal, createAttemptSandbox, ensureRunRoot, scoreSandbox,
} from './bench-sandbox.js';
import {
  createAgentSolver, createNoisyOracleSolver, createOracleSolver, nullSolver,
  type PatchLookup,
} from './bench-solvers.js';

const REPO_ROOT = join(import.meta.dir, '..');
const SEAL_LEDGER = join(REPO_ROOT, 'tests', 'bench', 'seal-ledger.jsonl');

interface CommonOptions {
  runRoot: string;
  seed: number;
  budget: AttemptBudget;
  limit: number | null;
  out: string | null;
  keepSandboxes: boolean;
}

function parseCommon(args: Map<string, string>): CommonOptions {
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
  const limitRaw = args.get('limit');
  return {
    runRoot: ensureRunRoot(runRoot, REPO_ROOT),
    seed: num('seed', 1),
    budget: {
      wallClockMs: num('wall-clock-ms', DEFAULT_ATTEMPT_BUDGET.wallClockMs),
      maxTokens: num('max-tokens', DEFAULT_ATTEMPT_BUDGET.maxTokens),
    },
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

function resolveSolver(spec: string, patches: PatchLookup, opts: { sharedHome?: string }): Solver {
  if (spec === 'null') return nullSolver;
  if (spec === 'oracle') return createOracleSolver(patches);
  if (spec.startsWith('noisy:')) {
    const rate = Number(spec.slice('noisy:'.length));
    return createNoisyOracleSolver(patches, rate, spec);
  }
  if (spec === 'agent' || spec === 'agent-evolving') {
    const evolving = spec === 'agent-evolving';
    return createAgentSolver({
      id: spec,
      description: evolving
        ? 'Proteus with evolution live and state carried across the sequence'
        : 'Proteus from a fresh v0 workspace per task',
      state: evolving ? 'shared' : 'fresh',
      autoEvolve: evolving,
      llm: benchLLM(),
      repoRoot: REPO_ROOT,
      ...(opts.sharedHome ? { sharedHome: opts.sharedHome } : {}),
    });
  }
  throw new Error(`unknown variant "${spec}" (expected null | oracle | noisy:<rate> | agent | agent-evolving)`);
}

interface AttemptRequest {
  task: BenchTask;
  solver: Solver;
  slot: 'a' | 'b';
  patches: PatchLookup;
  common: CommonOptions;
  attemptId: string;
}

async function runAttempt(req: AttemptRequest): Promise<AttemptOutcome> {
  const { task, solver, common } = req;
  const defect = req.patches.get(task.id);
  if (!defect) throw new Error(`no defect patch for task ${task.id}`);

  const sandbox = createAttemptSandbox({
    repoRoot: REPO_ROOT,
    runRoot: common.runRoot,
    attemptId: req.attemptId,
    defect,
  });

  const started = Date.now();
  const budget = budgetSignal(common.budget);
  let tokens = 0;
  let error: string | undefined;
  try {
    const result = await solver.solve({
      task,
      sandboxDir: sandbox.dir,
      proteusHome: sandbox.proteusHome,
      budget: common.budget,
      signal: budget.signal,
      seed: common.seed,
    });
    tokens = result.tokens ?? 0;
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
    passed: passed && !budgetBreach,
    checks,
    durationMs: solveMs,
    tokens,
    budgetBreach,
    ...(error ? { error } : {}),
  };
}

/** Both variants on one task, order randomized from the seed, each in its own
 *  sandbox and its own PROTEUS_HOME — so no memory, CraftStore, or scaffold
 *  state from one variant can reach the next. */
async function runPair(
  task: BenchTask,
  solvers: { a: Solver; b: Solver },
  patches: PatchLookup,
  common: CommonOptions,
): Promise<{ a: AttemptOutcome; b: AttemptOutcome }> {
  const order = runOrder(task.id, common.seed);
  const first = order === 'ab' ? 'a' : 'b';
  const second = first === 'a' ? 'b' : 'a';
  const attempt = (slot: 'a' | 'b') => runAttempt({
    task, solver: solvers[slot], slot, patches, common,
    attemptId: `${task.id}-${slot}-${fnv1a64(`${common.seed}:${task.id}:${slot}`).slice(0, 8)}`,
  });
  const firstOut = await attempt(first);
  const secondOut = await attempt(second);
  return first === 'a' ? { a: firstOut, b: secondOut } : { a: secondOut, b: firstOut };
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

/** A task is well-formed when the defect breaks this repo's checks and
 *  reversing it restores them. Both directions are machine-run; neither
 *  involves a variant, so this says nothing about anyone's performance. */
async function isWellFormed(
  task: BenchTask,
  patches: PatchLookup,
  common: CommonOptions,
  oracle: Solver,
): Promise<{ ok: boolean; detail: string }> {
  const broken = await runAttempt({
    task, solver: nullSolver, slot: 'a', patches, common,
    attemptId: `validate-broken-${task.id}`,
  });
  const fixed = await runAttempt({
    task, solver: oracle, slot: 'b', patches, common,
    attemptId: `validate-fixed-${task.id}`,
  });
  const ok = !broken.passed && fixed.passed;
  const failing = broken.checks.find((c) => !c.passed)?.id ?? 'none';
  return {
    ok,
    detail: ok
      ? `defect trips ${failing}, oracle restores it`
      : `defect→${broken.passed ? 'PASS (breaks nothing)' : 'fail'}, oracle→${fixed.passed ? 'pass' : `FAIL${fixed.error ? ` ${fixed.error}` : ''}`}`,
  };
}

async function cmdValidate(common: CommonOptions): Promise<number> {
  const { corpus, patches, path } = loadBenchCorpus(REPO_ROOT);
  const devTasks = limitTasks(corpus.dev, common.limit);
  const oracle = createOracleSolver(patches);

  console.log(`Validating ${path}`);
  console.log('Each task must FAIL with its defect applied and PASS once the defect is reversed.\n');

  let bad = 0;
  console.log(`dev split (${devTasks.length} tasks):`);
  for (const task of devTasks) {
    const { ok, detail } = await isWellFormed(task, patches, common, oracle);
    if (!ok) bad++;
    console.log(`  ${ok ? 'ok  ' : 'BAD '} ${task.id.padEnd(28)} ${detail}`);
  }

  // The seal returns which held-out tasks are BROKEN and nothing else — a
  // corpus bug report, never a scoreboard.
  const sealedResult = await corpus.sealed.validate(async (task) => (await isWellFormed(task, patches, common, oracle)).ok);
  bad += sealedResult.invalid.length;
  console.log(`\nsealed split (${sealedResult.checked} tasks): ${sealedResult.checked - sealedResult.invalid.length} valid`);
  for (const id of sealedResult.invalid) console.log(`  BAD  ${id}`);

  const total = devTasks.length + sealedResult.checked;
  console.log(`\n${total - bad}/${total} tasks valid.`);
  if (bad > 0) console.log('A task whose defect breaks nothing, or whose fix does not restore the checks, is not a task.');
  return bad === 0 ? 0 : 1;
}

async function cmdCompare(args: Map<string, string>, common: CommonOptions): Promise<number> {
  const specA = args.get('a');
  const specB = args.get('b');
  if (!specA || !specB) throw new Error('compare needs --a <variant> and --b <variant>');
  const { corpus, patches, path } = loadBenchCorpus(REPO_ROOT);

  const sharedHomeA = join(common.runRoot, 'shared-a');
  const sharedHomeB = join(common.runRoot, 'shared-b');
  const solvers = {
    a: resolveSolver(specA, patches, { sharedHome: sharedHomeA }),
    b: resolveSolver(specB, patches, { sharedHome: sharedHomeB }),
  };

  const devTasks = limitTasks(corpus.dev, common.limit);
  const config: BenchRunConfig = {
    corpus: corpusLabel(path, common.limit),
    budget: common.budget,
    seed: common.seed,
    variantA: solvers.a.id,
    variantB: solvers.b.id,
    manifestHash: corpus.manifestHash,
  };
  const runId = fnv1a64(`${Date.now()}:${config.variantA}:${config.variantB}:${config.seed}`).slice(0, 12);

  console.error(`dev split: ${devTasks.length} tasks × 2 variants`);
  const devAttempts: AttemptOutcome[] = [];
  for (const task of devTasks) {
    const { a, b } = await runPair(task, solvers, patches, common);
    devAttempts.push(a, b);
    console.error(`  ${task.id.padEnd(28)} ${config.variantA}=${a.passed ? 'pass' : 'fail'}  ${config.variantB}=${b.passed ? 'pass' : 'fail'}`);
  }

  let sealed: SealedScorecard | null = null;
  let ordinal: number | null = null;
  if (args.has('sealed')) {
    console.error(`sealed split: ${corpus.sealed.size} tasks × 2 variants (aggregates only)`);
    sealed = await corpus.sealed.evaluate(async (task) => {
      const { a, b } = await runPair(task, solvers, patches, common);
      return { a: a.passed, b: b.passed };
    }, { seed: common.seed });
    ordinal = appendSealLedger({
      ts: Date.now(), runId, manifestHash: sealed.manifestHash,
      variantA: config.variantA, variantB: config.variantB,
      tasks: sealed.tasks, effect: sealed.stats.effect, pValue: sealed.stats.pValue,
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
  const { corpus, patches, path } = loadBenchCorpus(REPO_ROOT);
  const sequence = limitTasks(corpus.dev, common.limit);
  if (sequence.length === 0) throw new Error('no tasks in the sequence');

  const sharedHome = join(common.runRoot, 'stateful-home');
  const stateful = resolveSolver(statefulSpec, patches, { sharedHome });
  const stateless = resolveSolver(statelessSpec, patches, {});

  const config: BenchRunConfig = {
    corpus: corpusLabel(path, common.limit),
    budget: common.budget,
    seed: common.seed,
    variantA: stateless.id,
    variantB: stateful.id,
    manifestHash: corpus.manifestHash,
  };
  const runId = fnv1a64(`gain:${Date.now()}:${config.seed}`).slice(0, 12);

  // Both arms see the identical sequence in the identical order — that is the
  // whole design. Which arm runs first is randomized from the seed so any host
  // drift over the run does not systematically favour one of them.
  const statefulFirst = runOrder('arm-order', common.seed) === 'ab';
  const arms: Array<{ solver: Solver; key: 'stateful' | 'stateless' }> = statefulFirst
    ? [{ solver: stateful, key: 'stateful' }, { solver: stateless, key: 'stateless' }]
    : [{ solver: stateless, key: 'stateless' }, { solver: stateful, key: 'stateful' }];

  const scores = new Map<string, { stateful: number; stateless: number }>();
  for (const arm of arms) {
    console.error(`${arm.key} arm: ${sequence.length} tasks in sequence`);
    for (const [index, task] of sequence.entries()) {
      const outcome = await runAttempt({
        task, solver: arm.solver, slot: arm.key === 'stateful' ? 'b' : 'a', patches, common,
        attemptId: `gain-${arm.key}-${index}-${task.id}`,
      });
      const entry = scores.get(task.id) ?? { stateful: 0, stateless: 0 };
      entry[arm.key] = outcome.passed ? 1 : 0;
      scores.set(task.id, entry);
      console.error(`  ${String(index).padStart(2)} ${task.id.padEnd(28)} ${outcome.passed ? 'pass' : 'fail'}`);
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
  bun scripts/bench.ts validate  --run-root <dir> [--limit n]
  bun scripts/bench.ts compare   --run-root <dir> --a <variant> --b <variant> [--sealed] [--require-accept]
  bun scripts/bench.ts gain      --run-root <dir> [--stateful <variant>] [--stateless <variant>]

Variants:
  null              no-op control (must fail everything)
  oracle            reverses the defect (must pass everything)
  noisy:<rate>      synthetic solver with a known success rate, seeded
  agent             Proteus from a fresh v0 workspace per task
  agent-evolving    Proteus with evolution live, state carried across the sequence

Options:
  --run-root <dir>     REQUIRED. Throwaway directory outside your home.
  --seed <n>           Run seed: pairing order, bootstrap, noisy draws (default 1)
  --wall-clock-ms <n>  Per-attempt wall-clock budget (default ${DEFAULT_ATTEMPT_BUDGET.wallClockMs})
  --max-tokens <n>     Per-attempt token budget (default ${DEFAULT_ATTEMPT_BUDGET.maxTokens})
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
