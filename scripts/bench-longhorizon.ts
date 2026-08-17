// The long-horizon family's half of the runner: load the corpus, materialize a
// task's materials into a sandbox, and supply the family's controls.
//
// Everything family-specific lives here. The split, the seal, the pairing, the
// statistics, the sandbox isolation and the report are the ones the defect
// family already uses — this is a second corpus through one harness, not a
// second harness.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as v from 'valibot';
import {
  LONGHORIZON_ANSWER_FILE, buildLongHorizonAsks, buildLongHorizonQuestions,
  encodeLongHorizonSpec, generateLongHorizonFiles, longHorizonAsksLeakAnswer,
  partitionCorpus, renderLongHorizonAnswerFile, unitHash,
} from '../packages/core/src/index.js';
import type {
  BenchCorpus, BenchTask, LLMProviderConfig, LongHorizonSpec, PartitionOptions,
  Solver, SolverContext, SolverResult,
} from '../packages/core/src/index.js';
import { runAgentWorker, runPiWorker, type AgentWorkerOptions } from './bench-solvers.js';

/** The checker's argv. Run inside the sandbox like every other check; the
 *  answer key is not on disk, it is recomputed from the spec the check carries
 *  — and the spec never enters the sandbox, because the task corpus is
 *  excluded from the copy. */
const CHECK_COMMAND = ['bun', 'scripts/bench-longhorizon-check.ts'] as const;

/** Restored from the pristine tree before scoring. The measuring apparatus here
 *  is the checker plus everything it imports, so the guard is the whole of
 *  `scripts` and `packages/core/src` — the solver's edit surface on these tasks
 *  is the answer file and its own notes, and nothing in the repo. */
const LONGHORIZON_GUARDED = ['scripts', 'packages/core/src'] as const;

const SpecLineSchema = v.object({
  id: v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]*$/, 'id must be lowercase kebab-case')),
  title: v.pipe(v.string(), v.minLength(1)),
  mode: v.picklist(['digest', 'continuation']),
  seed: v.pipe(v.number(), v.integer(), v.minValue(0)),
  entries: v.pipe(v.number(), v.integer(), v.minValue(1)),
  filler: v.pipe(v.number(), v.integer(), v.minValue(0)),
  markers: v.pipe(v.number(), v.integer(), v.minValue(1)),
  parts: v.pipe(v.number(), v.integer(), v.minValue(1)),
  tags: v.optional(v.array(v.string())),
});

export interface LoadedLongHorizonCorpus {
  corpus: BenchCorpus;
  /** Generator parameters per task id. The solver reaches its ask sequence and
   *  the oracle reaches the answers through this, the same way the defect
   *  family's solvers reach their patch. */
  specs: ReadonlyMap<string, LongHorizonSpec>;
  path: string;
}

export function loadLongHorizonCorpus(repoRoot: string, opts: PartitionOptions = {}): LoadedLongHorizonCorpus {
  const path = join(repoRoot, 'tests', 'bench', 'longhorizon.jsonl');
  const raw = readFileSync(path, 'utf8');
  const tasks: BenchTask[] = [];
  const specs = new Map<string, LongHorizonSpec>();

  raw.split('\n').forEach((line, i) => {
    const text = line.trim();
    if (!text || text.startsWith('#')) return;
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(text);
    } catch (err) {
      throw new Error(`${path}:${i + 1}: not valid JSON`, { cause: err });
    }
    const parsed = v.safeParse(SpecLineSchema, parsedJson);
    if (!parsed.success) throw new Error(`${path}:${i + 1}: ${parsed.issues.map((x) => x.message).join('; ')}`);
    const line_ = parsed.output;
    const spec: LongHorizonSpec = {
      mode: line_.mode, seed: line_.seed, entries: line_.entries,
      filler: line_.filler, markers: line_.markers, parts: line_.parts,
    };

    const { asks } = buildLongHorizonAsks(spec);
    const leak = longHorizonAsksLeakAnswer(asks, buildLongHorizonQuestions(spec));
    if (leak) throw new Error(`${path}:${i + 1}: an ask quotes the answer ("${leak}") — that is not a task`);

    specs.set(line_.id, spec);
    tasks.push({
      id: line_.id,
      title: line_.title,
      prompt: asks[0]!,
      editable: [LONGHORIZON_ANSWER_FILE],
      guarded: LONGHORIZON_GUARDED,
      // The encoded spec rides in the argv, so it rides in the task hash: a
      // corpus quietly regenerated at a different size changes the manifest.
      checks: [{ id: 'longhorizon-answers', command: [...CHECK_COMMAND, encodeLongHorizonSpec(spec)], timeoutMs: 60_000 }],
      tags: [line_.mode, ...(line_.tags ?? [])],
    });
  });

  if (tasks.length === 0) throw new Error(`${path}: no tasks — an empty corpus proves nothing`);
  return { corpus: partitionCorpus(tasks, opts), specs, path };
}

export function specFor(specs: ReadonlyMap<string, LongHorizonSpec>, taskId: string): LongHorizonSpec {
  const spec = specs.get(taskId);
  if (!spec) throw new Error(`no long-horizon spec for task ${taskId}`);
  return spec;
}

/** Write a task's materials into a fresh sandbox. */
export function materializeLongHorizon(dir: string, spec: LongHorizonSpec): void {
  for (const file of generateLongHorizonFiles(spec)) {
    const target = join(dir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.text);
  }
}

function writeAnswerFile(dir: string, spec: LongHorizonSpec): void {
  writeFileSync(join(dir, LONGHORIZON_ANSWER_FILE), renderLongHorizonAnswerFile(buildLongHorizonQuestions(spec)));
}

/** The ceiling: writes the answers the checker recomputes. Must pass every
 *  task, or the checker cannot be passed at all. */
export function createLongHorizonOracleSolver(specs: ReadonlyMap<string, LongHorizonSpec>): Solver {
  return {
    id: 'oracle',
    description: 'writes the generated answers — must pass every task',
    async solve(ctx: SolverContext): Promise<SolverResult> {
      writeAnswerFile(ctx.sandboxDir, specFor(specs, ctx.task.id));
      return { modelCalls: 0 };
    },
  };
}

/** Answers correctly with probability `rate`, decided by a hash of (seed, task,
 *  repeat, label) so a run reproduces exactly. Two of these with different
 *  rates are a known-truth pair the statistics must recover. */
export function createLongHorizonNoisySolver(
  specs: ReadonlyMap<string, LongHorizonSpec>,
  rate: number,
  label: string,
): Solver {
  if (!(rate >= 0 && rate <= 1)) throw new Error(`noisy oracle rate must be in [0,1], got ${rate}`);
  return {
    id: label,
    description: `synthetic solver with a ${(rate * 100).toFixed(0)}% success rate`,
    async solve(ctx: SolverContext): Promise<SolverResult> {
      if (unitHash(`${label}:${ctx.seed}:${ctx.task.id}:${ctx.repeat}`) < rate) {
        writeAnswerFile(ctx.sandboxDir, specFor(specs, ctx.task.id));
      }
      return { modelCalls: 0 };
    },
  };
}

export interface LongHorizonAgentSolverOptions {
  id: string;
  description: string;
  state: 'fresh' | 'shared';
  autoEvolve: boolean;
  llm: LLMProviderConfig;
  repoRoot: string;
  sharedHome?: string;
  specs: ReadonlyMap<string, LongHorizonSpec>;
}

export interface LongHorizonPiSolverOptions {
  id: 'pi:vanilla' | 'pi:retry';
  description: string;
  verifierRetry: boolean;
  llm: LLMProviderConfig;
  repoRoot: string;
  specs: ReadonlyMap<string, LongHorizonSpec>;
}

export function createLongHorizonPiSolver(opts: LongHorizonPiSolverOptions): Solver {
  return {
    id: opts.id,
    description: opts.description,
    async solve(ctx: SolverContext): Promise<SolverResult> {
      const { asks, removeAfterAsk } = buildLongHorizonAsks(specFor(opts.specs, ctx.task.id));
      return runPiWorker({
        ctx,
        llm: opts.llm,
        repoRoot: opts.repoRoot,
        asks,
        removeAfterAsk,
        verifierRetry: opts.verifierRetry,
      });
    },
  };
}

/** The real thing: the task's whole ask sequence driven on ONE session, in its
 *  own process. Between asks the worker arms a forced compaction and removes
 *  the part just read — the two halves of what the continuation mode measures. */
export function createLongHorizonAgentSolver(opts: LongHorizonAgentSolverOptions): Solver {
  return {
    id: opts.id,
    description: opts.description,
    async solve(ctx: SolverContext): Promise<SolverResult> {
      const { asks, removeAfterAsk } = buildLongHorizonAsks(specFor(opts.specs, ctx.task.id));
      const worker: AgentWorkerOptions = {
        ctx,
        repoRoot: opts.repoRoot,
        llm: opts.llm,
        state: opts.state,
        autoEvolve: opts.autoEvolve,
        asks,
        removeAfterAsk,
        purpose: 'Answer questions about a log corpus that is far larger than one request, and carry what you learn across turns.',
      };
      if (opts.sharedHome) worker.sharedHome = opts.sharedHome;
      return runAgentWorker(worker);
    },
  };
}
