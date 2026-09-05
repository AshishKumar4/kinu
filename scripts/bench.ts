#!/usr/bin/env bun
// The Kinu bench harness — a machine-scored answer to "does any of this
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
//   bun scripts/bench.ts compare --a panel:self --b panel:mixed
//       The panel-composition experiment: a fork panel of copies of one model
//       against one member per vendor family, scored by the repo's own checks.
//       Pre-registered decision rule at panelArm() below. Needs BENCH_PANEL.
//
//   bun scripts/bench.ts gain --stateful <variant> --stateless <variant>
//       CL-Bench's stateful-vs-stateless primitive: one identical sequence run
//       twice, once with evolution state live and once from a fresh v0.
//
//   bun scripts/bench.ts pilot --variant pi:vanilla --out <report.json>
//       Mandatory one-arm stability run before a model-backed comparison:
//       at least 40 development tasks, repeated at least three times.
//
// Two corpora, selected by --family and never mixed: `defect` (a seeded defect
// in this repo) and `longhorizon` (a generated corpus, digested in one ask or
// carried across episodes through forced compaction).
//
// Variants: null | oracle | noisy:<rate> | pi:vanilla | pi:retry | agent | agent-evolving | panel:self | panel:mixed
// The first three make no model calls and exist to validate the instrument.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_ATTEMPT_BUDGET, buildBenchReport, buildGainReport, decodeJsonValue,
  renderBenchSummary, renderGainSummary, runOrder, fnv1a64, unitHash,
} from '../packages/core/src/index';
import type {
  AttemptBudget, AttemptOutcome, BenchCorpus, BenchRunConfig, BenchTask, GainTaskScore,
  JsonObject, LLMProviderConfig, SealedScorecard, Solver,
} from '../packages/core/src/index';
import { loadBenchCorpus } from './bench-corpus';
import {
  applyPatch, budgetSignal, createAttemptSandbox, ensureRunRoot, scoreSandbox,
} from './bench-sandbox';
import {
  createAgentSolver, createNoisyOracleSolver, createOracleSolver, createPanelSolver, createPiSolver,
  nullSolver, type AgentSolverOptions, type PatchLookup, type PanelSolverOptions,
} from './bench-solvers';
import {
  createLongHorizonAgentSolver, createLongHorizonNoisySolver, createLongHorizonOracleSolver,
  createLongHorizonPiSolver,
  loadLongHorizonCorpus, materializeLongHorizon, specFor,
  type LongHorizonAgentSolverOptions,
} from './bench-longhorizon';
import {
  MIN_PILOT_REPEATS, MIN_PILOT_TASKS, benchProviderHash, buildPilotReport,
  loadAndValidatePilotReport, type PilotReport,
} from './bench-pilot';
import { runValidation, type RunValidationOptions, type WellFormedAttempt } from './bench-validation';
import {
  ARTIFACT_DIRNAME, openRunRetention, resolveArtifactRoot, type RunRetention,
} from './bench-retention';

const REPO_ROOT = join(import.meta.dir, '..');
const SEAL_LEDGER = join(REPO_ROOT, 'tests', 'bench', 'seal-ledger.jsonl');

/** Extra well-formedness checks a failing task gets before it is called BAD.
 *  Bounded on purpose: retrying is for absorbing a false fail, not for hunting
 *  until a broken task happens to pass once. */
export const DEFAULT_VALIDATE_RETRIES = 2;

export interface CommonOptions {
  runRoot: string;
  /** Where per-trial evidence lands. Durable by construction — see
   *  bench-retention.ts. There is no way to run scored and retain nothing. */
  artifactRoot: string;
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
 *  corpus, in the digestion and continuation modes. They measure different
 *  things, so averaging them would produce a number about nothing — the family
 *  is part of the run configuration and therefore part of the config hash. */
export const BENCH_FAMILIES = ['defect', 'longhorizon'] as const;
export type BenchFamilyId = (typeof BENCH_FAMILIES)[number];

function isBenchFamilyId(value: string): value is BenchFamilyId {
  return BENCH_FAMILIES.some((family) => family === value);
}

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
  if (!isBenchFamilyId(family)) {
    throw new Error(`--family must be one of ${BENCH_FAMILIES.join(' | ')}, got "${family}"`);
  }
  const resolvedRunRoot = ensureRunRoot(runRoot, REPO_ROOT);
  return {
    family,
    runRoot: resolvedRunRoot,
    artifactRoot: resolveArtifactRoot({
      flag: args.get('artifacts'), env: { BENCH_ARTIFACTS: process.env.BENCH_ARTIFACTS },
      repoRoot: REPO_ROOT, runRoot: resolvedRunRoot,
    }),
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
 *  KINU_* so an operator's ambient environment — which may point at their
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
interface AgentVariant {
  id: string;
  description: string;
  state: 'fresh' | 'shared';
  autoEvolve: boolean;
}

function agentVariant(spec: string): AgentVariant {
  const evolving = spec === 'agent-evolving';
  return {
    id: spec,
    description: evolving
      ? 'Kinu with evolution live and state carried across the sequence'
      : 'Kinu from a fresh v0 workspace per task',
    state: evolving ? 'shared' : 'fresh',
    autoEvolve: evolving,
  };
}

function piVariant(spec: string): {
  id: 'pi:vanilla' | 'pi:retry'; description: string; verifierRetry: boolean;
} | null {
  if (spec === 'pi:vanilla') {
    return {
      id: spec,
      description: 'official Pi coding agent with native read/bash/edit/write tools',
      verifierRetry: false,
    };
  }
  if (spec === 'pi:retry') {
    return {
      id: spec,
      description: 'official Pi coding agent plus one machine-verifier feedback retry',
      verifierRetry: true,
    };
  }
  return null;
}

const PILOTED_VARIANTS = new Set([
  'pi:vanilla', 'pi:retry', 'agent', 'agent-evolving', 'panel:self', 'panel:mixed',
]);
const PILOT_ARM_VARIANTS = new Set([
  'pi:vanilla', 'pi:retry', 'agent', 'panel:self', 'panel:mixed',
]);

function unknownVariant(spec: string): never {
  throw new Error(`unknown variant "${spec}" (expected null | oracle | noisy:<rate> | pi:vanilla | pi:retry | agent | agent-evolving | panel:self | panel:mixed)`);
}

/**
 * The panel arms — a mixed-model fork panel against copies of one model.
 *
 * PRE-REGISTERED, and written down before any run so the reading of the result
 * cannot move afterwards:
 *
 *   H0  panel composition does not change how often a defect is actually fixed.
 *   Primary outcome: pass rate on the repo's own checks (tests + typecheck),
 *   paired per task, dev split first, sealed split for the reported number.
 *   Decision:
 *     • mixed beats self, CI excludes 0  → per-fork model diversity is real for
 *       agentic coding, and the implementation is to reuse selectEnsembleJudges
 *       (judge-model.ts), NOT a second family selector.
 *     • self beats mixed, CI excludes 0  → Self-MoA replicates WITH execution
 *       ground truth. The current inherit-the-parent default is correct on
 *       evidence rather than by accident, and the question is closed.
 *     • CI includes 0 → underpowered or no effect; report the interval and
 *       change NOTHING. A null result is a result and it is the likely one.
 *   Either way the default does not change on this script's say-so alone: it
 *   changes when the sealed split says so.
 *
 * Cost per full run, at n tasks × r repeats × p panel members:
 *   n·r·(p+1) agent trajectories per arm, both arms → 2·n·r·(p+1). The dev
 *   split (87 tasks, counted 2026-09-05) at r=1, p=3 is 696 trajectories plus
 *   2·n·r merges and the grounded judge calls the heads path makes per fork.
 *   Budget it as ~700 full agentic attempts per arm pair, and note the mixed
 *   arm pays whatever its most expensive vendor charges. This is why the run
 *   needs the owner's approval and why this script ships unrun.
 */
export function panelArm(spec: string, analyst: LLMProviderConfig): PanelSolverOptions | null {
  const mixed = spec === 'panel:mixed';
  if (!mixed && spec !== 'panel:self') return null;
  const size = Number(process.env.BENCH_PANEL_SIZE ?? 3);
  if (!Number.isInteger(size) || size < 2 || size > 6) {
    throw new Error(`BENCH_PANEL_SIZE must be an integer in [2,6], got ${process.env.BENCH_PANEL_SIZE}`);
  }
  // The mixed arm needs real cross-vendor configs; there is no way to synthesize
  // them from one credential, and quietly running one model under N names would
  // make the whole comparison a lie.
  const panel = mixed ? panelProviders(size) : Array.from({ length: size }, () => analyst);
  return {
    id: spec,
    description: mixed
      ? `fork panel of ${size}, one model per vendor family`
      : `fork panel of ${size}, every member the same model (today's default)`,
    panel,
    analyst,
    repoRoot: REPO_ROOT,
  };
}

/** `BENCH_PANEL` — `<baseURL>|<auth>|<model>` per member, separated by `;`. */
export function panelProviders(size: number): LLMProviderConfig[] {
  const raw = (process.env.BENCH_PANEL ?? '').split(';').map((s) => s.trim()).filter(Boolean);
  if (raw.length !== size) {
    throw new Error(
      `panel:mixed needs BENCH_PANEL with ${size} entries (got ${raw.length}). `
      + 'Format: "<baseURL>|<auth>|<model>;<baseURL>|<auth>|<model>;…", one per vendor family.',
    );
  }
  return raw.map((entry, i) => {
    const [baseURL, auth, model] = entry.split('|').map((s) => s.trim());
    if (!baseURL || !auth || !model) {
      throw new Error(`BENCH_PANEL entry ${i + 1} must be "<baseURL>|<auth>|<model>", got "${entry}"`);
    }
    return {
      name: model.startsWith('@cf/') ? 'workers-ai' : 'openai-compat',
      baseURL,
      headers: { Authorization: auth },
      model,
    };
  });
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
        const pi = piVariant(spec);
        if (pi) return createPiSolver({ ...pi, llm: benchLLM(), repoRoot: REPO_ROOT });
        if (spec === 'agent' || spec === 'agent-evolving') {
          const solverOptions: AgentSolverOptions = {
            ...agentVariant(spec), llm: benchLLM(), repoRoot: REPO_ROOT,
          };
          if (opts.sharedHome) solverOptions.sharedHome = opts.sharedHome;
          return createAgentSolver(solverOptions);
        }
        const panel = panelArm(spec, benchLLM());
        if (panel) return createPanelSolver(panel);
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
      const pi = piVariant(spec);
      if (pi) return createLongHorizonPiSolver({ ...pi, llm: benchLLM(), repoRoot: REPO_ROOT, specs });
      if (spec === 'agent' || spec === 'agent-evolving') {
        const solverOptions: LongHorizonAgentSolverOptions = {
          ...agentVariant(spec), llm: benchLLM(), repoRoot: REPO_ROOT, specs,
        };
        if (opts.sharedHome) solverOptions.sharedHome = opts.sharedHome;
        return createLongHorizonAgentSolver(solverOptions);
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
  /** Required, not optional: an attempt that cannot be retained cannot be run,
   *  so the type system asks every caller for a durable home rather than
   *  trusting each command to remember one. */
  retention: RunRetention;
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
  let tokens: number | undefined;
  let modelCalls: number | undefined;
  let peakPromptTokens: number | undefined;
  let error: string | undefined;
  try {
    const result = await solver.solve({
      task,
      sandboxDir: sandbox.dir,
      kinuHome: sandbox.kinuHome,
      budget: common.budget,
      signal: budget.signal,
      seed: common.seed,
      repeat: req.repeat,
    });
    tokens = result.tokens;
    modelCalls = result.modelCalls;
    peakPromptTokens = result.peakPromptTokens;
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

  // An attempt nobody metered cannot be judged against a token cap. Reading its
  // absent total as 0 would have declared every unmeasured attempt comfortably
  // inside an envelope it was never measured against — the cheapest possible
  // false negative, since a variant whose meter silently broke would look both
  // free and compliant. So the token arm fires only on a measurement, and the
  // absence travels on the outcome instead: report.ts folds an unmeasured
  // attempt to a null cost rather than a zero one, the same way it already
  // refuses to render absent model-call evidence as zero.
  const budgetBreach = budget.timedOut() ? 'wall-clock'
    : (tokens !== undefined && tokens > common.budget.maxTokens ? 'tokens' : null);
  const outcome: AttemptOutcome = {
    taskId: task.id,
    variantId: solver.id,
    slot: req.slot,
    repeat: req.repeat,
    passed: passed && !budgetBreach && !error,
    checks,
    durationMs: solveMs,
    budgetBreach,
  };
  if (tokens !== undefined) outcome.tokens = tokens;
  if (peakPromptTokens !== undefined) outcome.peakPromptTokens = peakPromptTokens;
  if (modelCalls !== undefined) outcome.modelCalls = modelCalls;
  if (error) outcome.error = error;
  req.retention.recordAttempt(outcome);
  return outcome;
}

/** Both variants on one task, order randomized from the seed, each in its own
 *  sandbox and its own KINU_HOME — so no memory, CraftStore, or scaffold
 *  state from one variant can reach the next. */
async function runPair(
  task: BenchTask,
  repeat: number,
  solvers: { a: Solver; b: Solver },
  family: BenchFamily,
  common: CommonOptions,
  retention: RunRetention,
): Promise<{ a: AttemptOutcome; b: AttemptOutcome }> {
  const order = runOrder(task.id, common.seed, repeat);
  const first = order === 'ab' ? 'a' : 'b';
  const second = first === 'a' ? 'b' : 'a';
  const attempt = (slot: 'a' | 'b') => runAttempt({
    task, solver: solvers[slot], slot, repeat, family, common, retention,
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
  retention: RunRetention,
): Promise<{ a: AttemptOutcome[]; b: AttemptOutcome[] }> {
  const a: AttemptOutcome[] = [];
  const b: AttemptOutcome[] = [];
  for (let repeat = 0; repeat < common.repeats; repeat++) {
    const pair = await runPair(task, repeat, solvers, family, common, retention);
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

/**
 * The run's subset of the corpus, and why it is a random one.
 *
 * Taking the alphabetical head is what both prior Terminal-Bench runs did:
 * `-l 10` measured the first 10 of 89 task names in sort order, every time, so
 * the sample was not merely small but fixed and unrepresentative — and no
 * comparison drawn from it generalizes to the corpus. Sampling from the seed
 * keeps the run exactly reproducible while making the subset an actual sample.
 * The winners are then run in id order so execution stays stable.
 */
export function selectTasks(
  tasks: readonly BenchTask[],
  limit: number | null,
  seed: number,
): BenchTask[] {
  const byId = [...tasks].sort((x, y) => x.id.localeCompare(y.id));
  if (limit === null || limit >= byId.length) return byId;
  return byId
    .map((task) => ({ task, draw: unitHash(`sample:${seed}:${task.id}`) }))
    .sort((x, y) => x.draw - y.draw)
    .slice(0, limit)
    .map((entry) => entry.task)
    .sort((x, y) => x.id.localeCompare(y.id));
}

function corpusLabel(path: string, limit: number | null, total: number, seed: number): string {
  return limit === null || limit >= total
    ? `${path} (all ${total})`
    : `${path} (random ${limit} of ${total}, seed ${seed})`;
}

function appendSealLedger(entry: JsonObject): number {
  mkdirSync(join(REPO_ROOT, 'tests', 'bench'), { recursive: true });
  const prior = existsSync(SEAL_LEDGER)
    ? readFileSync(SEAL_LEDGER, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#')).length
    : 0;
  const ordinal = prior + 1;
  appendFileSync(SEAL_LEDGER, `${JSON.stringify({ ordinal, ...entry })}\n`);
  return ordinal;
}

/** Provenance every command records, in one place so no command can quietly
 *  record less than another. `evolving` is a field rather than an inference:
 *  both prior Terminal-Bench runs were made with evolution off and later read
 *  as if it had been on, which is how a mechanism gets credited for a number it
 *  never influenced. */
function openRetention(opts: {
  command: string;
  runId: string;
  common: CommonOptions;
  family: BenchFamily;
  variants: readonly string[];
  tasks: readonly BenchTask[];
  /** Recorded, not resolved here: the deterministic controls make no calls, and
   *  a model-backed run already holds its pinned identity in the pilot report. */
  model: string | null;
  providerHash: string | null;
}): RunRetention {
  const { common, family } = opts;
  const retention = openRunRetention({
    artifactRoot: common.artifactRoot,
    repoRoot: REPO_ROOT,
    provenance: {
      command: opts.command,
      runId: opts.runId,
      family: family.id,
      corpus: corpusLabel(family.path, common.limit, family.corpus.dev.length, common.seed),
      manifestHash: family.corpus.manifestHash,
      seed: common.seed,
      repeats: common.repeats,
      budget: common.budget,
      variants: opts.variants,
      evolving: opts.variants.includes('agent-evolving'),
      model: opts.model,
      providerHash: opts.providerHash,
      taskIds: opts.tasks.map((task) => task.id),
    },
  });
  console.error(`retaining per-trial evidence in ${retention.dir}`);
  return retention;
}

/** One well-formedness check: the task must fail with nothing done and pass
 *  under the oracle. Both directions are machine-run; neither involves a
 *  variant, so this says nothing about anyone's performance. */
async function runWellFormedAttempt(
  task: BenchTask,
  repeat: number,
  family: BenchFamily,
  common: CommonOptions,
  oracle: Solver,
  retention: RunRetention,
): Promise<WellFormedAttempt> {
  const broken = await runAttempt({
    task, solver: nullSolver, slot: 'a', repeat, family, common, retention,
    attemptId: `validate-broken-${task.id}-${repeat}`,
  });
  const fixed = await runAttempt({
    task, solver: oracle, slot: 'b', repeat, family, common, retention,
    attemptId: `validate-fixed-${task.id}-${repeat}`,
  });
  return { broken, oracle: fixed };
}

async function cmdValidate(args: Map<string, string>, common: CommonOptions): Promise<number> {
  const family = loadFamily(common.family);
  const corpus = family.corpus;
  const devTasks = selectTasks(corpus.dev, common.limit, common.seed);
  // A typo that validated NOTHING and reported ok is the same defect as a gate
  // over an empty set, so an id naming no task refuses before any sandbox is
  // built. Checked against the WHOLE corpus rather than the dev split, because a
  // re-anchored sealed patch needs re-proving exactly as much as a dev one and
  // well-formedness carries no performance signal either way.
  const only = args.get('id')?.split(',').map((id) => id.trim()).filter((id) => id.length > 0);
  if (only !== undefined) {
    if (only.length === 0) throw new Error('--id needs at least one task id');
    const unknown = only.filter((id) =>
      !corpus.dev.some((task) => task.id === id) && !corpus.sealed.has(id));
    if (unknown.length > 0) {
      throw new Error(`--id names ${String(unknown.length)} task(s) this corpus does not have: `
        + `${unknown.join(', ')} — a narrowed run over nothing would report ok`);
    }
  }
  const oracle = family.resolveSolver('oracle', {});
  const retention = openRetention({
    command: 'validate',
    runId: fnv1a64(`validate:${Date.now()}:${common.seed}`).slice(0, 12),
    common, family, variants: ['null', 'oracle'], tasks: devTasks,
    model: null, providerHash: null,
  });

  const options: RunValidationOptions = {
    family: common.family,
    corpusPath: family.path,
    manifestHash: corpus.manifestHash,
    validateRetries: common.validateRetries,
    diagnosticsDir: retention.dir,
    devTasks,
    sealed: corpus.sealed,
    runAttempt: (task, repeat) => runWellFormedAttempt(task, repeat, family, common, oracle, retention),
  };
  if (only !== undefined) options.only = only;
  const summary = await runValidation(options);
  retention.finish(decodeJsonValue({ value: summary }));
  return summary.ok ? 0 : 1;
}

async function cmdCompare(args: Map<string, string>, common: CommonOptions): Promise<number> {
  const specA = args.get('a');
  const specB = args.get('b');
  if (!specA || !specB) throw new Error('compare needs --a <variant> and --b <variant>');
  const family = loadFamily(common.family);
  const corpus = family.corpus;
  const pilot = requireStabilityPilot(args, common, family, [specA, specB]);

  const sharedHomeA = join(common.runRoot, 'shared-a');
  const sharedHomeB = join(common.runRoot, 'shared-b');
  const solvers = {
    a: family.resolveSolver(specA, { sharedHome: sharedHomeA }),
    b: family.resolveSolver(specB, { sharedHome: sharedHomeB }),
  };

  const devTasks = selectTasks(corpus.dev, common.limit, common.seed);
  const config: BenchRunConfig = {
    corpus: corpusLabel(family.path, common.limit, corpus.dev.length, common.seed),
    budget: common.budget,
    seed: common.seed,
    variantA: solvers.a.id,
    variantB: solvers.b.id,
    repeats: common.repeats,
    manifestHash: corpus.manifestHash,
  };
  const runId = fnv1a64(`${Date.now()}:${config.variantA}:${config.variantB}:${config.seed}`).slice(0, 12);
  const retention = openRetention({
    command: 'compare', runId, common, family,
    variants: [solvers.a.id, solvers.b.id], tasks: devTasks,
    model: pilot?.model ?? null, providerHash: pilot?.providerHash ?? null,
  });

  console.error(`dev split: ${devTasks.length} tasks × 2 variants × ${common.repeats} repeat(s)`);
  const devAttempts: AttemptOutcome[] = [];
  for (const task of devTasks) {
    const { a, b } = await runRepeats(task, solvers, family, common, retention);
    devAttempts.push(...a, ...b);
    console.error(`  ${task.id.padEnd(28)} ${config.variantA}=${tally(a)}  ${config.variantB}=${tally(b)}`);
  }

  let sealed: SealedScorecard | null = null;
  let ordinal: number | null = null;
  if (args.has('sealed')) {
    console.error(`sealed split: ${corpus.sealed.size} tasks × 2 variants × ${common.repeats} repeat(s) (aggregates only)`);
    sealed = await corpus.sealed.evaluate(async (task) => {
      const { a, b } = await runRepeats(task, solvers, family, common, retention);
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

  const report = {
    ...buildBenchReport({ runId, config, devAttempts, sealed, sealAccessOrdinal: ordinal }),
    modelEvidence: pilotEvidence(pilot),
  };
  retention.finish(decodeJsonValue({ value: report }));
  if (common.out) {
    writeFileSync(common.out, JSON.stringify(report, null, 2));
    console.error(`Wrote ${common.out}`);
  }
  console.log(renderBenchSummary(report));
  return args.has('require-accept') && !report.decision.accept ? 1 : 0;
}

function requireStabilityPilot(
  args: Map<string, string>,
  common: CommonOptions,
  family: BenchFamily,
  variants: readonly string[],
): PilotReport | null {
  if (!variants.some((variant) => PILOTED_VARIANTS.has(variant))) return null;
  if (common.repeats < MIN_PILOT_REPEATS) {
    throw new Error(`model-backed runs need at least ${MIN_PILOT_REPEATS} repeats per task; got ${common.repeats}`);
  }
  const path = args.get('pilot-report');
  if (!path) {
    throw new Error(
      `model-backed runs need --pilot-report from a one-arm ${MIN_PILOT_TASKS}-task × ${MIN_PILOT_REPEATS}-repeat stability pilot`,
    );
  }
  const llm = benchLLM();
  return loadAndValidatePilotReport(path, {
    family: family.id,
    manifestHash: family.corpus.manifestHash,
    model: llm.model,
    providerHash: benchProviderHash(llm),
    budget: common.budget,
    comparedVariants: variants,
  });
}

function pilotEvidence(pilot: PilotReport | null): null | {
  variant: string; model: string; providerHash: string; tasks: number; repeats: number; seed: number;
  totalModelCalls: number;
  /** Null when no repeat in the pilot reported a model-call count — an
   *  unmeasured pilot has no mean, and 0 would read as a free arm. */
  meanModelCalls: number | null; maxObservedModelCalls: number | null;
} {
  return pilot ? {
    variant: pilot.variant,
    model: pilot.model,
    providerHash: pilot.providerHash,
    tasks: pilot.tasks,
    repeats: pilot.repeats,
    seed: pilot.seed,
    totalModelCalls: pilot.totalModelCalls,
    meanModelCalls: pilot.meanModelCalls,
    maxObservedModelCalls: pilot.maxObservedModelCalls,
  } : null;
}

async function cmdPilot(args: Map<string, string>, common: CommonOptions): Promise<number> {
  const spec = args.get('variant');
  if (!spec || !PILOT_ARM_VARIANTS.has(spec)) {
    throw new Error(`pilot needs --variant <${[...PILOT_ARM_VARIANTS].join(' | ')}> — exactly one fresh model-backed arm`);
  }
  if (!common.out) throw new Error('pilot needs --out <report.json>');
  const family = loadFamily(common.family);
  const tasks = selectTasks(family.corpus.dev, common.limit, common.seed);
  if (tasks.length < MIN_PILOT_TASKS) {
    throw new Error(`stability pilot needs at least ${MIN_PILOT_TASKS} development tasks; ${family.id} selected ${tasks.length}`);
  }
  if (common.repeats < MIN_PILOT_REPEATS) {
    throw new Error(`stability pilot needs at least ${MIN_PILOT_REPEATS} repeats; got ${common.repeats}`);
  }
  const llm = benchLLM();
  const solver = family.resolveSolver(spec, { sharedHome: join(common.runRoot, 'pilot-shared') });
  const retention = openRetention({
    command: 'pilot',
    runId: fnv1a64(`pilot:${Date.now()}:${solver.id}:${common.seed}`).slice(0, 12),
    common, family, variants: [solver.id], tasks,
    model: llm.model, providerHash: benchProviderHash(llm),
  });
  const outcomes: AttemptOutcome[] = [];
  console.error(`stability pilot: ${tasks.length} tasks × 1 variant × ${common.repeats} repeats`);
  for (const task of tasks) {
    const repeated: AttemptOutcome[] = [];
    for (let repeat = 0; repeat < common.repeats; repeat++) {
      const outcome = await runAttempt({
        task,
        solver,
        slot: 'a',
        repeat,
        family,
        common,
        retention,
        attemptId: `pilot-${task.id}-r${repeat}`,
      });
      repeated.push(outcome);
      outcomes.push(outcome);
    }
    console.error(`  ${task.id.padEnd(28)} ${solver.id}=${tally(repeated)}`);
  }
  const report = buildPilotReport({
    family: family.id,
    manifestHash: family.corpus.manifestHash,
    variant: solver.id,
    llm,
    budget: common.budget,
    seed: common.seed,
    repeats: common.repeats,
    outcomes,
  });
  retention.finish(decodeJsonValue({ value: report }));
  writeFileSync(common.out, JSON.stringify(report, null, 2));
  console.log(
    `Pilot ${report.variant}: ${report.passed}/${report.attempts} attempts passed; `
    + `${report.unstableTaskIds.length}/${report.tasks} tasks unstable; `
    + `${report.totalModelCalls} model calls; ${report.errors} errors; `
    + `${report.budgetBreaches} budget breaches.`,
  );
  return report.errors === 0 && report.budgetBreaches === 0 ? 0 : 1;
}

async function cmdGain(args: Map<string, string>, common: CommonOptions): Promise<number> {
  const statefulSpec = args.get('stateful') ?? 'agent-evolving';
  const statelessSpec = args.get('stateless') ?? 'agent';
  const family = loadFamily(common.family);
  const pilot = requireStabilityPilot(args, common, family, [statefulSpec, statelessSpec]);
  const sequence = selectTasks(family.corpus.dev, common.limit, common.seed);
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
    corpus: corpusLabel(family.path, common.limit, family.corpus.dev.length, common.seed),
    budget: common.budget,
    seed: common.seed,
    variantA: stateless.id,
    variantB: statefulPasses[0]!.id,
    repeats: common.repeats,
    manifestHash: family.corpus.manifestHash,
  };
  const runId = fnv1a64(`gain:${Date.now()}:${config.seed}`).slice(0, 12);
  const retention = openRetention({
    command: 'gain', runId, common, family,
    variants: [stateless.id, statefulPasses[0]!.id], tasks: sequence,
    model: pilot?.model ?? null, providerHash: pilot?.providerHash ?? null,
  });

  const scores = new Map<string, { stateful: number; stateless: number }>();
  const attempts: AttemptOutcome[] = [];
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
          task, solver: arm.solver, slot: arm.key === 'stateful' ? 'b' : 'a', repeat: pass, family, common, retention,
          attemptId: `gain-${arm.key}-p${pass}-${index}-${task.id}`,
        });
        attempts.push(outcome);
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

  const report = {
    ...buildGainReport({ runId, config, perTask, attempts }),
    modelEvidence: pilotEvidence(pilot),
  };
  retention.finish(decodeJsonValue({ value: report }));
  if (common.out) {
    writeFileSync(common.out, JSON.stringify(report, null, 2));
    console.error(`Wrote ${common.out}`);
  }
  console.log(renderGainSummary(report));
  return 0;
}

const USAGE = `Kinu bench harness — machine-scored, sealed-split, rejection by default

Usage:
  bun scripts/bench.ts validate  --run-root <dir> [--id a,b] [--limit n] [--validate-retries n]
  bun scripts/bench.ts pilot     --run-root <dir> --variant <variant> --out <report.json> [--limit n] [--repeats n]
  bun scripts/bench.ts compare   --run-root <dir> --a <variant> --b <variant> [--pilot-report <path>] [--repeats n] [--sealed] [--require-accept]
  bun scripts/bench.ts gain      --run-root <dir> [--stateful <variant>] [--stateless <variant>] --pilot-report <path> [--repeats n]

Families (--family, default defect):
  defect            a seeded defect in this repo, scored by this repo's own checks
  longhorizon       a generated corpus, scored by exact answers, in two modes:
                    single-query digestion and multi-episode continuation across
                    forced compaction. Never mixed with defect — they measure
                    different things, so --family is part of the config hash.

Variants:
  null              no-op control (must fail everything)
  oracle            reverses the defect (must pass everything)
  noisy:<rate>      synthetic solver with a known success rate, seeded
  pi:vanilla        official Pi coding agent, native read/bash/edit/write
  pi:retry          Pi plus one machine-verifier feedback retry
  agent             Kinu from a fresh v0 workspace per task
  agent-evolving    Kinu with evolution live, state carried across the sequence
  panel:self        fork panel whose members all use the analyst model
  panel:mixed       fork panel with one configured model per vendor family

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
  --id <a,b>           validate: re-prove exactly these task ids, either split.
                       What a re-anchored defect patch needs — a patch that
                       APPLIES again is not yet a patch that still BREAKS the
                       checks. One task is two attempts, each a full core-suite run;
                       the whole corpus is ~160 of the same. An
                       id naming no task refuses rather than reporting ok over an
                       empty set. The summary says NARROWED so it cannot be
                       quoted as a verdict on the corpus.
  --limit <n>          Use a RANDOM n-task sample drawn from --seed, not the
                       alphabetical head. Recorded in the report and in the
                       retained provenance as "random n of N, seed s".
  --out <path>         Also write the JSON report here (retention is separate
                       and unconditional)
  --pilot-report <path>  Required for model-backed compare/gain. Must match the
                       corpus, model, endpoint hash, and exact compute envelope.
  --keep-sandboxes     Do not delete attempt sandboxes (debugging)
  --artifacts <dir>    Where per-trial evidence is retained (default
                       <repo>/${ARTIFACT_DIRNAME}, or BENCH_ARTIFACTS). Must be
                       durable: a swept temp root is refused before any attempt
                       runs, because a scored run that leaves no evidence
                       produces a rumour rather than a number.

Model-backed variants read BENCH_BASE_URL / BENCH_AUTH / BENCH_MODEL. Deterministic
variants need no credentials and make no model calls.`;

export interface ParsedBenchArgv {
  command: string;
  args: Map<string, string>;
}

export function parseArgv(argv: string[]): ParsedBenchArgv {
  const args = new Map<string, string>();
  const command = argv[0] ?? '';
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) throw new Error(`argument ${i} is missing`);
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
  if (command === 'pilot') {
    if (!args.has('limit')) args.set('limit', String(MIN_PILOT_TASKS));
    if (!args.has('repeats')) args.set('repeats', String(MIN_PILOT_REPEATS));
  }
  const common = parseCommon(args);
  const code = command === 'validate' ? await cmdValidate(args, common)
    : command === 'pilot' ? await cmdPilot(args, common)
    : command === 'compare' ? await cmdCompare(args, common)
    : command === 'gain' ? await cmdGain(args, common)
    : (() => { throw new Error(`unknown command "${command}"`); })();
  process.exit(code);
}

if (import.meta.main) {
  try {
    await main();
  } catch (cause) {
    console.error(cause instanceof Error ? (cause.stack ?? cause.message) : String(cause));
    process.exit(1);
  }
}
