/**
 * GEPA → CraftStore bridge — `runCraftedToolGepa`.
 *
 * Mirrors `runScaffoldGepa` for crafted tools: when a CraftStore tool's EMA
 * score dips below threshold (or the operator asks), run GEPA on its
 * implementation source, then commit the winner via `craftStore.update`.
 *
 * Constraints mirror the structural rules CraftStore + the codemode
 * executor enforce on tool source:
 *   - The body must be a single JS expression evaluable to an async
 *     function (matches `new Function('return (' + code + ')')()` shape).
 *   - No `require`/`import`/`eval`/`Function`/`globalThis` references — same
 *     blocklist as scaffold/modify.ts. (Crafted tools live in the codemode
 *     sandbox, but disallowing these patterns keeps the eval surface small.)
 *   - 8 KB hard cap on body length — Hermes uses ≤500 chars for tool
 *     *descriptions*; tool *bodies* legitimately need more room.
 *
 * Promotion model:
 *   - GEPA produces a winner.
 *   - If the winner's aggregate strictly exceeds the seed's, we call
 *     `craftStore.update(toolName, { code: winner.source })`. This is
 *     immediate (no shadow eval) because crafted tools are already
 *     filter-gated by their EMA score on the next turn — if the swap
 *     regresses quality, EMA decay will surface a fresh GEPA invocation.
 *   - The previous code is backed up in memory as `craftedTool.${name}.v${ts}`
 *     so an operator can restore if needed.
 */

import type { AgentRuntime } from '../../types/agent-runtime.js';
import { SCAFFOLD_FORBIDDEN_PATTERNS } from '../../scaffold/safety-patterns.js';
import { runGepa } from './engine.js';
import type {
  EvalInstance, GepaConfig, GepaMetric, GepaResult, ReflectionLM,
} from './types.js';

/** Crafted tool bodies look like `async (arg) => {...}` or
 *  `async function name(arg) {...}` — both reduce to a callable after
 *  `new Function('return (' + code + ')')()`. The constraint pattern
 *  accepts either. (Looser than the scaffold's generator-signature gate;
 *  the forbidden-construct blocklist is shared with the scaffold.) */
const TOOL_REQUIRED = /async\b/;

const TOOL_MAX_BYTES = 8 * 1024;

export interface RunCraftedToolGepaOpts<I = unknown, E = unknown> {
  rt: AgentRuntime;
  /** Name of the crafted tool to optimise. Must exist in the CraftStore. */
  toolName: string;
  evalSet: ReadonlyArray<EvalInstance<I, E>>;
  metric: GepaMetric<I, E>;
  reflectionLm: ReflectionLM;
  /** Defaults to the current tool's body. */
  seed?: string;
  budget?: GepaConfig<I, E>['budget'];
  parentSelection?: GepaConfig<I, E>['parentSelection'];
  random?: () => number;
  onIteration?: GepaConfig<I, E>['onIteration'];
  /** Skip the craftStore.update call and return the GEPA result. Default false. */
  dryRun?: boolean;
}

export interface RunCraftedToolGepaResult<I = unknown, E = unknown> {
  gepa: GepaResult;
  /** Whether the winner was committed to the CraftStore. */
  promoted: boolean;
  /** If promoted, the timestamp the new body was written. */
  promotedAt: number | null;
  /** If promoted, the backup path that holds the prior body. */
  backupPath: string | null;
  skipReason?: 'dry_run' | 'tool_not_found' | 'winner_equals_seed';
}

export async function runCraftedToolGepa<I = unknown, E = unknown>(
  opts: RunCraftedToolGepaOpts<I, E>,
): Promise<RunCraftedToolGepaResult<I, E>> {
  const tool = opts.rt.craftStore.get(opts.toolName);
  if (!tool) {
    // Seed unknown — return an empty GEPA result without invoking the LM.
    return {
      gepa: {
        winner: {
          id: 'noop', parentId: null, source: '', scores: new Map(),
          feedback: new Map(), aggregateScore: 0, createdAt: Date.now(),
        },
        paretoFront: [], history: [], metricCallsUsed: 0,
        iterationsRun: 0, stopReason: 'no_improvement_possible',
      },
      promoted: false, promotedAt: null, backupPath: null,
      skipReason: 'tool_not_found',
    };
  }

  const seed = opts.seed ?? tool.code;

  const gepa = await runGepa({
    seed,
    evalSet: opts.evalSet,
    metric: opts.metric,
    reflectionLm: opts.reflectionLm,
    budget: opts.budget,
    parentSelection: opts.parentSelection,
    random: opts.random,
    onIteration: opts.onIteration,
    constraints: {
      maxSizeBytes: TOOL_MAX_BYTES,
      requiredPattern: TOOL_REQUIRED,
      forbiddenPatterns: [...SCAFFOLD_FORBIDDEN_PATTERNS],
    },
  });

  if (opts.dryRun) {
    return { gepa, promoted: false, promotedAt: null, backupPath: null, skipReason: 'dry_run' };
  }

  if (gepa.winner.source === seed) {
    return { gepa, promoted: false, promotedAt: null, backupPath: null, skipReason: 'winner_equals_seed' };
  }

  // Back up the prior body before swapping.
  const now = Date.now();
  const backupPath = `memory/crafted-tool-backups/${opts.toolName}.v${now}.js`;
  try {
    await opts.rt.storage.vfs.writeFile(backupPath, tool.code);
  } catch (err) {
    console.warn('[gepa] backup write failed:', (err as Error).message);
  }

  opts.rt.craftStore.update(opts.toolName, { code: gepa.winner.source });

  return {
    gepa, promoted: true, promotedAt: now, backupPath,
  };
}
