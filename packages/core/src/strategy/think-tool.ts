// `think(strategy, task, budget?)` — single tool the LLM calls to dispatch
// to a registered ExplorationStrategy. Replaces the previous "1 named tool
// per strategy" surface (explore, split_heads, …) with one stable surface.
//
// Strategies plug into the StrategyRegistry; adding a new one = registering
// it, no tool/UI changes.
//
// Host-injected infrastructure (a MCTS SessionWriter, the HeadController,
// inherited conversation context, an onPhase event sink) flows in via
// `defaultOptions()`. The LLM never supplies these — it only supplies task
// parameters (head specs, merge strategy, tuning knobs). The two are combined
// with a one-level deep merge so caller tuning can sit alongside injected
// infra without clobbering it.
import { tool, jsonSchema } from 'ai';
import type { ToolSet } from 'ai';
import type { StrategyRegistry, StrategyContext } from './types.js';
import type { AgentRuntime } from '../types/agent-runtime.js';
import type { LanguageModel } from 'ai';
import type { MergeStrategy } from '../heads/types.js';

export interface ThinkToolDeps {
  registry: StrategyRegistry;
  rt: AgentRuntime;
  model: LanguageModel;
  /** Build per-strategy infrastructure options the LLM must not set —
   *  e.g. `{ mcts: { session }, heads: { controller, inheritedContext, onPhase } }`.
   *  Called once per `think` invocation and deep-merged (one level) under the
   *  caller's options so injected infra survives caller-supplied tuning. */
  defaultOptions?: () => Record<string, unknown>;
}

/** A single reasoning head spec for the `heads` strategy. Mirrors
 *  SplitRequest['heads'][number] minus the infra the host injects. */
interface ThinkHeadSpec {
  task: string;
  rationale: string;
  /** Per-head model spec (e.g. `codex/gpt-5.5`). Omit to inherit the agent's. */
  model?: string;
  allowedSandboxes?: string[];
  allowedTools?: string[];
}

interface ThinkInput {
  strategy: string;
  task: string;
  /** Max iterations / branches / sub-calls. Unset = the strategy's own
   *  default (which the host may override from stored agent config). */
  budget?: number;
  /** Wall-clock budget in ms. Default 60s. */
  wall_clock_ms?: number;
  /** strategy=heads: the parallel reasoning heads to spawn (2–6). */
  heads?: ThinkHeadSpec[];
  /** strategy=heads: how to combine head findings. Default 'synthesize'. */
  merge_strategy?: MergeStrategy;
  /** strategy=heads: model spec for the merge LLM. Omit to inherit the agent's. */
  merge_model?: string;
  /** Advanced per-strategy tuning (e.g. mcts branches/maxDepth). Deep-merged
   *  under injected infra. Most callers never set this. */
  options?: Record<string, unknown>;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function createThinkTool(deps: ThinkToolDeps): ToolSet[string] {
  // Only advertised strategies appear in the enum + docstring; the dispatch
  // below still resolves any registered id (eval harnesses use the baseline).
  const advertised = deps.registry.list().filter(s => s.advertised !== false);
  const strategies = advertised.map(s => s.id);
  const descriptions = advertised
    .map(s => `  - **${s.id}** — ${s.description ?? s.label ?? s.id}`)
    .join('\n');
  const hasHeads = strategies.includes('heads');

  return tool({
    description:
      'Run an exploration strategy over the task and return the best candidate.\n' +
      'Strategies available:\n' + descriptions + '\n\n' +
      'Use only when the task genuinely needs it — not for linear work you can simply do directly.' +
      (hasHeads
        ? '\n\nFor strategy=heads, pass `heads` (2–6 specs, each {task, rationale, model?}) ' +
          'and optionally `merge_strategy` (synthesize | best_of | consensus).'
        : ''),
    inputSchema: jsonSchema<ThinkInput>({
      type: 'object',
      required: ['strategy', 'task'],
      properties: {
        strategy: { type: 'string', enum: strategies, description: 'Strategy id.' },
        task: { type: 'string', description: 'Concrete task to explore.' },
        budget: { type: 'integer', minimum: 1, maximum: 200, description: 'Max iterations.' },
        wall_clock_ms: { type: 'integer', minimum: 1000, description: 'Wall-clock cap in ms.' },
        heads: {
          type: 'array',
          minItems: 2,
          maxItems: 6,
          description: 'strategy=heads only: the parallel reasoning heads to spawn.',
          items: {
            type: 'object',
            required: ['task', 'rationale'],
            properties: {
              task: { type: 'string', description: 'What this head explores. Be concrete.' },
              rationale: { type: 'string', description: 'Why this angle matters.' },
              model: { type: 'string', description: "Per-head model spec (e.g. 'codex/gpt-5.5'). Omit to inherit." },
              allowedSandboxes: { type: 'array', items: { type: 'string' }, description: 'Sandbox namespaces this head may use.' },
              allowedTools: { type: 'array', items: { type: 'string' }, description: 'Tool names this head may invoke.' },
            },
          },
        },
        merge_strategy: {
          type: 'string',
          enum: ['synthesize', 'best_of', 'consensus'],
          description: 'strategy=heads only: how to combine head findings. Default synthesize.',
        },
        merge_model: {
          type: 'string',
          description: 'strategy=heads only: model spec for the merge LLM. Omit to inherit.',
        },
        options: { type: 'object', description: 'Advanced per-strategy tuning. Most callers leave unset.' },
      },
    }),
    execute: async (input: ThinkInput, toolOptions?: unknown) => {
      const strat = deps.registry.get(input.strategy);
      if (!strat) {
        return { error: `Unknown strategy "${input.strategy}". Available: ${strategies.join(', ')}` };
      }

      // One-level deep merge: caller tuning sits alongside injected infra
      // (session / controller / onPhase) instead of replacing the whole
      // per-strategy bag.
      const defaults = deps.defaultOptions?.() ?? {};
      const callerOpts = input.options ?? {};
      const options: Record<string, unknown> = { ...defaults };
      for (const [k, v] of Object.entries(callerOpts)) {
        const d = options[k];
        options[k] = isPlainObject(d) && isPlainObject(v) ? { ...d, ...v } : v;
      }

      // Ergonomic heads input: fold the typed top-level fields into
      // options.heads, preserving the injected controller/context/onPhase.
      if (input.heads) {
        options.heads = {
          ...(isPlainObject(options.heads) ? options.heads : {}),
          heads: input.heads,
          ...(input.merge_strategy ? { mergeStrategy: input.merge_strategy } : {}),
          ...(input.merge_model ? { mergeModel: input.merge_model } : {}),
        };
      }

      const ctx: StrategyContext = {
        task: input.task,
        rt: deps.rt,
        model: deps.model,
        signal: readAbortSignal(toolOptions),
        budget: {
          // Unset = strategy default (lets stored agent-config overrides apply).
          maxIterations: input.budget,
          // Only set a wall-clock bound when the caller explicitly asks for one.
          // A blanket 60s default silently killed heads mid-work (each head's
          // sub-agent cold-start alone could eat it); leaving it undefined lets
          // heads fall through to DEFAULT_HEAD_BUDGET (5 min).
          wallClockMs: input.wall_clock_ms,
        },
        options,
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

function readAbortSignal(options: unknown): AbortSignal | undefined {
  if (!options || typeof options !== 'object' || !('abortSignal' in options)) return undefined;
  const signal = (options as { abortSignal?: unknown }).abortSignal;
  return typeof signal === 'object' && signal !== null && 'aborted' in signal && 'addEventListener' in signal
    ? signal as AbortSignal
    : undefined;
}
