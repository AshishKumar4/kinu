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

/** Solves with probability `rate`, decided by a hash of (seed, task, id) so a
 *  run reproduces exactly. Two of these with different rates are a known-truth
 *  pair: the harness must recover the gap between them. */
export function createNoisyOracleSolver(patches: PatchLookup, rate: number, label: string): Solver {
  if (!(rate >= 0 && rate <= 1)) throw new Error(`noisy oracle rate must be in [0,1], got ${rate}`);
  return {
    id: label,
    description: `synthetic solver with a ${(rate * 100).toFixed(0)}% success rate`,
    async solve(ctx: SolverContext): Promise<SolverResult> {
      const draw = unitHash(`${label}:${ctx.seed}:${ctx.task.id}`);
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
  error?: string;
}

/** The real thing: one Proteus turn against the sandbox, in its own process. */
export function createAgentSolver(opts: AgentSolverOptions): Solver {
  return {
    id: opts.id,
    description: opts.description,
    async solve(ctx: SolverContext): Promise<SolverResult> {
      const home = opts.state === 'shared'
        ? (opts.sharedHome ?? (() => { throw new Error('shared-state solver needs a sharedHome'); })())
        : ctx.proteusHome;
      const workspaceName = opts.state === 'shared' ? 'bench' : `bench-${ctx.task.id}`;

      const input = {
        dbPath: join(home, workspaceName, 'agent.db'),
        workspaceName,
        purpose: 'Fix defects in a TypeScript repository so its own test suite and typecheck pass.',
        prompt: ctx.task.prompt,
        maxTokens: ctx.budget.maxTokens,
        autoEvolve: opts.autoEvolve,
        llm: opts.llm,
        sessionId: opts.state === 'shared' ? 'bench' : ctx.task.id,
      };

      const proc = Bun.spawn(
        ['bun', join(opts.repoRoot, 'scripts', 'bench-agent-worker.ts')],
        {
          cwd: ctx.sandboxDir,
          env: { ...sandboxEnv(home), PROTEUS_HOME: home },
          stdin: Buffer.from(JSON.stringify(input)),
          stdout: 'pipe',
          stderr: 'pipe',
          signal: ctx.signal,
        },
      );

      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      await proc.exited;

      const line = stdout.trim().split('\n').filter(Boolean).pop();
      if (!line) {
        return { error: `agent worker produced no result (exit ${proc.exitCode}): ${stderr.slice(-800)}` };
      }
      let parsed: WorkerOutput;
      try {
        parsed = JSON.parse(line) as WorkerOutput;
      } catch {
        return { error: `agent worker emitted unparseable output: ${line.slice(0, 400)}` };
      }
      return {
        tokens: parsed.tokens,
        ...(parsed.error ? { error: parsed.error } : {}),
      };
    },
  };
}
