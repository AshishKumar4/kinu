// `think(task, heads?, strategy?)` — the ephemeral-fork rung of the delegation
// ladder, and the single tool the LLM calls to dispatch to a registered
// ExplorationStrategy. Replaces the previous "1 named tool per strategy"
// surface (explore, split_heads, …) with one stable surface.
//
// `strategy` is a scoring policy, not a second delegation choice: omitted it
// forks (FORK_STRATEGY_ID) and merges the branches back; `mcts` keeps the same
// fork primitive but settles branches by scoring them against each other.
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
import { BUILTIN_TOOL_DESCRIPTIONS } from '../tools/registry.js';
import { FORK_STRATEGY_ID } from './heads.js';
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

/** A single fork spec. Mirrors SplitRequest['heads'][number] minus the infra
 *  the host injects. */
interface ThinkHeadSpec {
  task: string;
  rationale: string;
  /** Per-fork model spec (e.g. `codex/gpt-5.5`). Omit to inherit the agent's. */
  model?: string;
  allowedSandboxes?: string[];
  allowedTools?: string[];
}

interface ThinkInput {
  /** Omit to fork (FORK_STRATEGY_ID). Named only to change how branches are
   *  settled — e.g. `mcts` scores them by execution instead of merging. */
  strategy?: string;
  task: string;
  /** Max iterations / branches / sub-calls. Unset = the strategy's own
   *  default (which the host may override from stored agent config). */
  budget?: number;
  /** Wall-clock budget in ms. Default 60s. */
  wall_clock_ms?: number;
  /** The parallel forks to spawn (2–6). */
  heads?: ThinkHeadSpec[];
  /** How to combine fork findings. Default 'synthesize'. */
  merge_strategy?: MergeStrategy;
  /** Model spec for the merge LLM. Omit to inherit the agent's. */
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

  return tool({
    // Single source: the registry's think spec carries the strategy doctrine;
    // only the live advertised-strategy id list is appended here. Parameter
    // contracts (heads specs, merge_strategy) live in the input schema.
    description:
      BUILTIN_TOOL_DESCRIPTIONS.think +
      (strategies.length > 0 ? `\nStrategies available this turn: ${strategies.join(', ')}.` : ''),
    inputSchema: jsonSchema<ThinkInput>({
      type: 'object',
      required: ['task'],
      properties: {
        strategy: {
          type: 'string',
          enum: strategies,
          description: `How branches are settled. Defaults to ${FORK_STRATEGY_ID} — ephemeral forks that merge back into this turn.`,
        },
        task: { type: 'string', description: 'Concrete task to explore.' },
        budget: { type: 'integer', minimum: 1, maximum: 200, description: 'Max iterations.' },
        wall_clock_ms: { type: 'integer', minimum: 1000, description: 'Wall-clock cap in ms.' },
        heads: {
          type: 'array',
          minItems: 2,
          maxItems: 6,
          description: 'The parallel forks to spawn. Required when forking.',
          items: {
            type: 'object',
            required: ['task', 'rationale'],
            properties: {
              task: { type: 'string', description: 'What this fork explores. Be concrete.' },
              rationale: { type: 'string', description: 'Why this angle matters.' },
              model: { type: 'string', description: "Per-fork model spec (e.g. 'codex/gpt-5.5'). Omit to inherit." },
              allowedSandboxes: { type: 'array', items: { type: 'string' }, description: 'Sandbox namespaces this fork may use.' },
              allowedTools: { type: 'array', items: { type: 'string' }, description: 'Tool names this fork may invoke.' },
            },
          },
        },
        merge_strategy: {
          type: 'string',
          enum: ['synthesize', 'best_of', 'consensus'],
          description: 'How to combine fork findings. Default synthesize.',
        },
        merge_model: {
          type: 'string',
          description: 'Model spec for the merge LLM. Omit to inherit.',
        },
        options: { type: 'object', description: 'Advanced per-strategy tuning. Most callers leave unset.' },
      },
    }),
    execute: async (input: ThinkInput, toolOptions?: unknown) => {
      const strategyId = input.strategy ?? FORK_STRATEGY_ID;
      const strat = deps.registry.get(strategyId);
      if (!strat) {
        return { error: `Unknown strategy "${strategyId}". Available: ${strategies.join(', ')}` };
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
        return { error: `Strategy ${strategyId} failed: ${(err as Error).message}` };
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
