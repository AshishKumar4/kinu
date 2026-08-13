// The things being measured, plus the controls that measure the measurer.
//
// Controls exist because a benchmark nobody has calibrated is not evidence. An
// oracle must score 1.0 and a null must score 0.0 on every task, or the harness
// is broken; two noisy oracles with a known gap must recover that gap through
// the statistics, or the statistics are broken. All three run without a single
// model call, so the instrument can be validated for free.
import { join } from 'node:path';
import { unitHash } from '../packages/core/src/index.js';
import type { LLMProviderConfig, Solver, SolverContext, SolverResult } from '../packages/core/src/index.js';
import { applyPatch, sandboxEnv } from './bench-sandbox.js';

export type PatchLookup = ReadonlyMap<string, string>;

/** Does nothing. The floor: whatever this scores is what the defect itself
 *  scores, and it must be zero on every task. */
export const nullSolver: Solver = {
  id: 'null',
  description: 'no-op control — must fail every task',
  async solve(): Promise<SolverResult> {
    return {};
  },
};

/** Reverses the defect. The ceiling: must pass every task. */
export function createOracleSolver(patches: PatchLookup): Solver {
  return {
    id: 'oracle',
    description: 'reverse-applies the defect — must pass every task',
    async solve(ctx: SolverContext): Promise<SolverResult> {
      applyPatch(ctx.sandboxDir, patchFor(patches, ctx.task.id), { reverse: true });
      return {};
    },
  };
}

/** Solves with probability `rate`, decided by a hash of (seed, task, repeat, id)
 *  so a run reproduces exactly. The repeat index is in the draw deliberately: a
 *  solver with a success rate is a model of run-to-run noise, and one that
 *  returned the same answer to every repeat would make `--repeats` measure
 *  nothing and pass^k trivially equal to pass@1. Two of these with different
 *  rates are a known-truth pair: the harness must recover the gap between them. */
export function createNoisyOracleSolver(patches: PatchLookup, rate: number, label: string): Solver {
  if (!(rate >= 0 && rate <= 1)) throw new Error(`noisy oracle rate must be in [0,1], got ${rate}`);
  return {
    id: label,
    description: `synthetic solver with a ${(rate * 100).toFixed(0)}% success rate`,
    async solve(ctx: SolverContext): Promise<SolverResult> {
      const draw = unitHash(`${label}:${ctx.seed}:${ctx.task.id}:${ctx.repeat}`);
      if (draw < rate) applyPatch(ctx.sandboxDir, patchFor(patches, ctx.task.id), { reverse: true });
      return {};
    },
  };
}

function patchFor(patches: PatchLookup, taskId: string): string {
  const patch = patches.get(taskId);
  if (!patch) throw new Error(`no defect patch for task ${taskId}`);
  return patch;
}

export interface AgentSolverOptions {
  id: string;
  description: string;
  /** 'fresh' starts a v0 workspace per attempt — no memory, no crafted tools,
   *  no lessons, bootstrap scaffold. 'shared' carries one workspace across the
   *  whole arm, which is what accumulates evolution state. */
  state: 'fresh' | 'shared';
  /** Enable the three-timescale evolution machinery during the attempt. */
  autoEvolve: boolean;
  llm: LLMProviderConfig;
  repoRoot: string;
  /** Home for the 'shared' arm. Ignored when state is 'fresh'. */
  sharedHome?: string;
}

interface WorkerOutput {
  tokens: number;
  steps: number;
  hadError: boolean;
  budgetBreach: 'tokens' | null;
  peakPromptTokens: number;
  error?: string;
}

export interface AgentWorkerOptions extends Omit<AgentSolverOptions, 'id' | 'description'> {
  ctx: SolverContext;
  /** What the workspace is told it is for. */
  purpose: string;
  /** Sent in order on ONE session. A defect task sends one. */
  asks: readonly string[];
  /** Parallel to `asks`: a sandbox-relative path removed once that ask has been
   *  answered, or null. */
  removeAfterAsk: ReadonlyArray<string | null>;
}

/** Drive the agent worker over a task's ask sequence, in its own process.
 *  Shared by both families — the only thing that differs between them is what
 *  the asks say and what gets removed between them. */
export async function runAgentWorker(opts: AgentWorkerOptions): Promise<SolverResult> {
  const { ctx } = opts;
  const home = opts.state === 'shared'
    ? (opts.sharedHome ?? (() => { throw new Error('shared-state solver needs a sharedHome'); })())
    : ctx.proteusHome;
  const workspaceName = opts.state === 'shared' ? 'bench' : `bench-${ctx.task.id}`;

  const input = {
    dbPath: join(home, workspaceName, 'agent.db'),
    workspaceName,
    purpose: opts.purpose,
    asks: opts.asks,
    removeAfterAsk: opts.removeAfterAsk,
    maxTokens: ctx.budget.maxTokens,
    autoEvolve: opts.autoEvolve,
    llm: opts.llm,
    sessionId: opts.state === 'shared' ? 'bench' : ctx.task.id,
  };

  return spawnWorker({
    script: join(opts.repoRoot, 'scripts', 'bench-agent-worker.ts'),
    home, ctx, input,
  });
}

export interface PanelSolverOptions {
  id: string;
  description: string;
  /** One provider config per fork. All identical is the self-MoA arm; one per
   *  vendor family is the mixed arm. */
  panel: readonly LLMProviderConfig[];
  /** The merge model, held constant across arms so a difference is the panel's. */
  analyst: LLMProviderConfig;
  repoRoot: string;
}

/**
 * A fork PANEL against the sandbox — the mixed-vs-self MoA arms.
 *
 * Deliberately not an agent turn: the panel is the treatment, so nothing
 * upstream of it may vary between arms. Both arms run the identical worker with
 * the identical task and differ only in the provider list.
 */
export function createPanelSolver(opts: PanelSolverOptions): Solver {
  return {
    id: opts.id,
    description: opts.description,
    async solve(ctx: SolverContext): Promise<SolverResult> {
      return spawnWorker({
        script: join(opts.repoRoot, 'scripts', 'bench-panel-worker.ts'),
        home: ctx.proteusHome,
        ctx,
        input: {
          dbPath: join(ctx.proteusHome, `panel-${ctx.task.id}`, 'agent.db'),
          workspaceName: `panel-${ctx.task.id}`,
          purpose: 'Fix defects in a TypeScript repository so its own test suite and typecheck pass.',
          ask: ctx.task.prompt,
          panel: opts.panel,
          analyst: opts.analyst,
          maxTokens: ctx.budget.maxTokens,
        },
      });
    },
  };
}

/** Spawn a worker script over the attempt's sandbox + throwaway home and read
 *  its single JSON result line. Shared by the agent and panel solvers — the
 *  isolation contract (cwd, pruned env, one JSON line on stdout) is the same
 *  for both and must not drift between them. */
async function spawnWorker(opts: {
  script: string;
  home: string;
  ctx: SolverContext;
  input: unknown;
}): Promise<SolverResult> {
  const proc = Bun.spawn(['bun', opts.script], {
    cwd: opts.ctx.sandboxDir,
    env: sandboxEnv(opts.home),
    stdin: Buffer.from(JSON.stringify(opts.input)),
    stdout: 'pipe',
    stderr: 'pipe',
    signal: opts.ctx.signal,
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;

  const line = stdout.trim().split('\n').filter(Boolean).pop();
  if (!line) {
    return { error: `worker produced no result (exit ${proc.exitCode}): ${stderr.slice(-800)}` };
  }
  let parsed: WorkerOutput;
  try {
    parsed = JSON.parse(line) as WorkerOutput;
  } catch {
    return { error: `worker emitted unparseable output: ${line.slice(0, 400)}` };
  }
  return {
    tokens: parsed.tokens,
    peakPromptTokens: parsed.peakPromptTokens,
    ...(parsed.error ? { error: parsed.error } : {}),
  };
}

/** The real thing: one Proteus turn against the sandbox, in its own process. */
export function createAgentSolver(opts: AgentSolverOptions): Solver {
  return {
    id: opts.id,
    description: opts.description,
    solve: (ctx: SolverContext) => runAgentWorker({
      ...opts,
      ctx,
      purpose: 'Fix defects in a TypeScript repository so its own test suite and typecheck pass.',
      asks: [ctx.task.prompt],
      removeAfterAsk: [null],
    }),
  };
}
