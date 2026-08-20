#!/usr/bin/env bun
// Single-shot A/B between two models, judged by a third.
//
// What this measures, exactly: one `generateText` call per model per case, on
// the corpus cases a model with no tools can actually answer, scored by an LLM
// judge. That is the whole claim. It is NOT a measurement of the agent — no
// tools, no system prompt, no loop — and it is not a substitute for
// scripts/bench.ts, which runs real agent solvers in isolated sandboxes against
// this repo's own checks with a sealed split.
//
// It runs only when someone asks for it. It used to run nightly on a schedule
// with the baseline defaulting to the candidate model, which billed for a model
// judged against itself; both of those are now refused.
//
//   bun scripts/eval.ts --baseline-model <spec>  # required: A/B needs two models
//   bun scripts/eval.ts --model <spec> --baseline-model <spec> --out out.json
//
// Model resolution reuses the CLI's local resolver, so any provider the CLI can
// reach works (env keys, ~/.kinu config, or the signed-in Cloudflare proxy).
// With nothing configured it fails with an honest message — no hardcoded keys.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateText } from 'ai';
import type { LanguageModel } from 'ai';
import { safeParse } from 'valibot';
import {
  parseCorpus, runEvalPair, buildEvalReport, evaluateGate, renderEvalSummary,
  createLLMJudge, extractJsonObject, jsonObjectOnlyInstruction,
  VerdictSchema, DEFAULT_QUALITY_THRESHOLD,
} from '../packages/core/src/index';
import type {
  EvalCase, ExplorationStrategy, StrategyContext, StrategyResult, JudgeFn, Verdict,
} from '../packages/core/src/index';
import { createConfiguredLocalModelResolver } from '../packages/cli/src/local-model-resolver';
import { createTestRuntime } from '@kinu/test-utils';

const REPO_ROOT = join(import.meta.dir, '..');
const DEFAULT_CORPUS = join(REPO_ROOT, 'tests/eval/corpus/seed.jsonl');

export interface EvalOptions {
  corpus: string;
  /** Candidate (strategy B) model spec, or null → resolver default. */
  model: string | null;
  /** Baseline (strategy A) model spec. null → same as candidate. */
  baselineModel: string | null;
  judgeModel: string | null;
  threshold: number;
  out: string | null;
  help: boolean;
}

export function parseArgs(argv: string[]): EvalOptions {
  const opts: EvalOptions = {
    corpus: DEFAULT_CORPUS,
    model: process.env.KINU_MODEL ?? process.env.EVAL_MODEL ?? null,
    baselineModel: null,
    judgeModel: process.env.EVAL_JUDGE_MODEL ?? null,
    threshold: process.env.EVAL_MIN_SCORE ? Number(process.env.EVAL_MIN_SCORE) : DEFAULT_QUALITY_THRESHOLD,
    out: process.env.EVAL_OUT ?? null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${arg}`);
      return v;
    };
    switch (arg) {
      case '--corpus': opts.corpus = next(); break;
      case '--model': opts.model = next(); break;
      case '--baseline-model': opts.baselineModel = next(); break;
      case '--judge-model': opts.judgeModel = next(); break;
      case '--min-score': opts.threshold = Number(next()); break;
      case '--out': opts.out = next(); break;
      case '-h': case '--help': opts.help = true; break;
      default: throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(opts.threshold) || opts.threshold < 0 || opts.threshold > 1) {
    throw new Error(`--min-score must be in [0,1], got ${opts.threshold}`);
  }
  return opts;
}

const USAGE = `Kinu single-shot model A/B

Usage: bun scripts/eval.ts --baseline-model <spec> [options]

  --corpus <path>          JSONL corpus (default: tests/eval/corpus/seed.jsonl)
  --model <spec>           Candidate model (default: KINU_MODEL / resolver default)
  --baseline-model <spec>  Baseline model. REQUIRED to differ from the candidate:
                           a model judged against itself is not an A/B.
  --judge-model <spec>     Judge model (default: candidate model)
  --min-score <0..1>       Quality floor for the gate (default: ${DEFAULT_QUALITY_THRESHOLD},
                           uncalibrated — no honest run has set it yet)
  --out <path>             Write the structured JSON report here
  -h, --help               Show this help

Cases tagged tool-use or multi-step are excluded and listed: this strategy is a
single generateText call, so it cannot perform them.

Exit code: 0 when aggregate >= floor, 1 on regression or misconfiguration.`;

/** Capabilities this benchmark does not have. `pinnedSingleShot` is one
 *  `generateText` call: no tools, no filesystem, no shell, no second turn. A
 *  case tagged with either of these asks for something the strategy cannot
 *  physically do, so scoring it measures the judge's tolerance for an apology
 *  rather than the model. They are excluded and counted, not silently run. */
const UNRUNNABLE_TAGS: ReadonlySet<string> = new Set(['tool-use', 'multi-step']);

export interface RunnablePartition {
  runnable: EvalCase[];
  excluded: EvalCase[];
}

export function partitionRunnable(cases: readonly EvalCase[]): RunnablePartition {
  const runnable: EvalCase[] = [];
  const excluded: EvalCase[] = [];
  for (const c of cases) {
    const blocked = c.tags?.some((tag) => UNRUNNABLE_TAGS.has(tag)) ?? false;
    (blocked ? excluded : runnable).push(c);
  }
  return { runnable, excluded };
}

/** A single-shot strategy pinned to one resolved model. Single-shot is the
 *  harness's declared baseline and the only strategy that runs without a full
 *  DO runtime — the honest, cheap choice for a standalone benchmark. */
interface PinnedStrategy {
  strategy: ExplorationStrategy;
  model: LanguageModel;
}

function pinnedSingleShot(id: string, model: LanguageModel): PinnedStrategy {
  const strategy: ExplorationStrategy = {
    id,
    advertised: false,
    async explore(ctx: StrategyContext): Promise<StrategyResult> {
      const t0 = Date.now();
      const { text, usage } = await generateText({
        model,
        prompt: ctx.task,
        maxOutputTokens: ctx.budget?.maxOutputTokens ?? 2048,
        abortSignal: ctx.signal,
      });
      const out = text.trim();
      return {
        strategy: id,
        best: { text: out, score: 1, source: id },
        all: [{ text: out, score: 1, source: id }],
        cost: {
          tokens: (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
          durationMs: Date.now() - t0,
          iterations: 1,
        },
      };
    },
  };
  return { strategy, model };
}

/** LLM judge over the AI SDK: structured verdict via the shared JSON-object
 *  extraction + Valibot validation used elsewhere (replay.ts pattern). */
function makeJudge(model: LanguageModel): JudgeFn {
  return createLLMJudge(async (prompt, _schema): Promise<Verdict> => {
    const full = `${prompt}\n\nJSON shape: {"winner":"a"|"b"|"tie","scoreA":<0..1>,"scoreB":<0..1>,"rationale":"<terse>"}\n${jsonObjectOnlyInstruction()}`;
    const { text } = await generateText({ model, prompt: full, maxOutputTokens: 512 });
    const parsed = safeParse(VerdictSchema, extractJsonObject(text));
    if (!parsed.success) {
      throw new Error(`judge output failed schema: ${parsed.issues.map((x) => x.message).join('; ')}`);
    }
    return parsed.output;
  });
}

export interface BenchmarkDeps {
  cases: EvalCase[];
  strategyA: ExplorationStrategy;
  strategyB: ExplorationStrategy;
  buildContext: (c: EvalCase) => StrategyContext;
  judge: JudgeFn;
  threshold: number;
  meta: { modelA?: string; modelB?: string; corpus?: string; ranAt?: number };
}

function errorMessage<Failure>(error: Failure): string {
  return error instanceof Error ? error.message : String(error);
}

/** Run the harness + apply the gate. Pure of model resolution + IO, so tests
 *  drive it with stub strategies + a stub judge (no real LLM). */
export async function runBenchmark(deps: BenchmarkDeps) {
  const results = await runEvalPair({
    cases: deps.cases,
    strategyA: deps.strategyA,
    strategyB: deps.strategyB,
    buildContext: deps.buildContext,
    judge: deps.judge,
  });
  const report = buildEvalReport(results, {
    ...deps.meta,
    strategyA: deps.strategyA.id,
    strategyB: deps.strategyB.id,
  });
  const gate = evaluateGate(report, deps.threshold);
  return { report, gate };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(USAGE); return; }

  let cases: EvalCase[];
  try {
    cases = parseCorpus(readFileSync(opts.corpus, 'utf8'));
  } catch (err) {
    console.error(`Failed to load corpus ${opts.corpus}: ${errorMessage(err)}`);
    process.exit(1);
  }

  // Reuse the CLI's model resolver — throws an honest "no LLM configured"
  // message when neither env keys, ~/.kinu config, nor a signed-in session
  // are present. Never hardcode a key.
  let resolver;
  try {
    resolver = createConfiguredLocalModelResolver({ model: opts.model ?? undefined }).resolver;
  } catch (err) {
    console.error(`Cannot run the benchmark: ${errorMessage(err)}`);
    process.exit(1);
  }

  const candidateSpec = resolver.normalizeSpecSync(opts.model);
  const baselineSpec = resolver.normalizeSpecSync(opts.baselineModel ?? opts.model);
  const judgeSpec = resolver.normalizeSpecSync(opts.judgeModel ?? opts.model);

  // Without a distinct baseline this is one model answering twice and a judge
  // picking a winner between its own outputs. The paired quantity the report
  // leads with (regressionDelta = B − A) is then noise around zero, and the
  // absolute floor is being applied to a self-assessment. Refuse rather than
  // bill for it — the default used to be exactly this run.
  if (baselineSpec === candidateSpec) {
    console.error(
      `Refusing to run: baseline and candidate are both ${candidateSpec}.\n`
      + 'A model judged against itself is not an A/B — pass a different '
      + '--baseline-model (or set vars.EVAL_BASELINE_MODEL) to compare two models.',
    );
    process.exit(1);
  }

  const { runnable, excluded } = partitionRunnable(cases);
  if (runnable.length === 0) {
    console.error(`Refusing to run: all ${cases.length} corpus cases need capabilities this single-shot benchmark does not have.`);
    process.exit(1);
  }

  console.error(`Running ${runnable.length} cases · candidate=${candidateSpec} · baseline=${baselineSpec} · judge=${judgeSpec}`);
  if (excluded.length > 0) {
    console.error(
      `Excluded ${excluded.length} case(s) needing tools or multiple turns, which this `
      + `single-shot strategy has neither of: ${excluded.map((c) => c.id).join(', ')}`,
    );
  }

  const candidate = pinnedSingleShot('candidate', resolver.resolveModel(candidateSpec));
  const baseline = pinnedSingleShot('baseline', resolver.resolveModel(baselineSpec));
  const judge = makeJudge(resolver.resolveModel(judgeSpec));
  const benchmarkRuntime = createTestRuntime().rt;

  const { report, gate } = await runBenchmark({
    cases: runnable,
    strategyA: baseline.strategy,
    strategyB: candidate.strategy,
    buildContext: (c) => ({
      task: c.task,
      mode: 'build',
      rt: benchmarkRuntime,
      model: candidate.model,
      budget: { maxOutputTokens: 2048 },
    }),
    judge,
    threshold: opts.threshold,
    meta: { modelA: baselineSpec, modelB: candidateSpec, corpus: opts.corpus },
  });

  const json = JSON.stringify({ ...report, gate }, null, 2);
  if (opts.out) {
    writeFileSync(opts.out, json);
    console.error(`Wrote ${opts.out}`);
  }
  console.log(renderEvalSummary(report, gate));
  if (!gate.pass) process.exit(1);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  });
}
