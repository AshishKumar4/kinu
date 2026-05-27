// `think(strategy, task, budget?)` — single tool the LLM calls to dispatch
// to a registered ExplorationStrategy. Replaces the previous "1 named tool
// per strategy" surface (explore, split_heads, …) with one stable surface.
//
// Strategies plug into the StrategyRegistry; adding a new one = registering
// it, no tool/UI changes.
import { tool, jsonSchema } from 'ai';
import type { ToolSet } from 'ai';
import type { StrategyRegistry, StrategyContext } from './types.js';
import type { AgentRuntime } from '../types/agent-runtime.js';
import type { LanguageModel } from 'ai';

export interface ThinkToolDeps {
  registry: StrategyRegistry;
  rt: AgentRuntime;
  model: LanguageModel;
  /** Build per-strategy options when the LLM doesn't supply them.
   *  e.g. supply HeadController + SessionWriter automatically. */
  defaultOptions?: () => Record<string, unknown>;
}

interface ThinkInput {
  strategy: string;
  task: string;
  /** Max iterations / branches / sub-calls. Default 10. */
  budget?: number;
  /** Wall-clock budget in ms. Default 60s. */
  wall_clock_ms?: number;
  /** Strategy-specific options (model id overrides, head specs, etc.). */
  options?: Record<string, unknown>;
}

export function createThinkTool(deps: ThinkToolDeps): ToolSet[string] {
  const strategies = deps.registry.list().map(s => s.id);
  const descriptions = deps.registry.list()
    .map(s => `  - **${s.id}** — ${s.description ?? s.label ?? s.id}`)
    .join('\n');

  return tool({
    description:
      'Run an exploration strategy over the task and return the best candidate.\n' +
      'Strategies available:\n' + descriptions + '\n\n' +
      'Pick the cheapest strategy that fits: single-shot for simple tasks, mcts for ' +
      'multi-step planning, heads for distinct sub-questions. Strategies share ONE ' +
      'agent surface — no need to remember per-strategy tool names.',
    inputSchema: jsonSchema<ThinkInput>({
      type: 'object',
      required: ['strategy', 'task'],
      properties: {
        strategy: { type: 'string', enum: strategies, description: 'Strategy id.' },
        task: { type: 'string', description: 'Concrete task to explore.' },
        budget: { type: 'integer', minimum: 1, maximum: 200, description: 'Max iterations.' },
        wall_clock_ms: { type: 'integer', minimum: 1000, description: 'Wall-clock cap in ms.' },
        options: { type: 'object', description: 'Strategy-specific options.' },
      },
    }),
    execute: async (input: ThinkInput) => {
      const strat = deps.registry.get(input.strategy);
      if (!strat) {
        return { error: `Unknown strategy "${input.strategy}". Available: ${strategies.join(', ')}` };
      }
      const ctx: StrategyContext = {
        task: input.task,
        rt: deps.rt,
        model: deps.model,
        budget: {
          maxIterations: input.budget ?? 10,
          wallClockMs: input.wall_clock_ms ?? 60_000,
        },
        options: { ...(deps.defaultOptions?.() ?? {}), ...(input.options ?? {}) },
      };
      try {
        const result = await strat.explore(ctx);
        return {
          strategy: result.strategy,
          text: result.best.text,
          score: result.best.score,
          trace: result.trace,
          cost: result.cost,
        };
      } catch (err) {
        return { error: `Strategy ${input.strategy} failed: ${(err as Error).message}` };
      }
    },
  });
}
