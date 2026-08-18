/**
 * What a fork run was DISPATCHED with — the settle policy by its own name, and
 * the parameters that policy was given.
 *
 * `ForkRunSummary` answers "when did it fork, and how did that one settle",
 * deliberately stopping at the summary. It says `merged` or `competed`, which is
 * the outcome vocabulary and not the dispatch: the agent wrote
 * `settle:"merge"` or `settle:"mcts"`, and those two produce genuinely
 * different objects. A search has an iteration budget, a branching factor, a
 * depth cap and an exploration constant, and it RANKS its branches. A merge has
 * a merge strategy and a head count, and it ranks nothing. Reading one as the
 * other is what made the surface unable to say which it was looking at.
 *
 * Read from what the dispatch already persisted, so nothing here can drift from
 * what actually ran: `mcts_search_runs.config_json` is the resolved
 * PersistedMCTSConfig the engine checkpointed, and `head_journal.merge_strategy`
 * is the strategy every head of a split was spawned under.
 */

import * as v from 'valibot';
import { tolerate } from '../obs/index';
import { judgeCallBudget } from '../mcts/evaluation';
import type { SqlExecutor } from '../types/primitives';

/** The settle policy as the caller names it — `agents(action:'fork', settle)`. */
export type ForkSettlePolicy = 'merge' | 'mcts';

/**
 * A search's dispatch parameters. `budget` is the iteration budget it was given;
 * the remaining budget and iterations already spent live on the ledger row and
 * are a progress reading, not a parameter.
 */
export interface CompetedForkParams {
  readonly policy: 'mcts';
  readonly budget: number;
  /** Branches expanded per iteration. */
  readonly branches: number;
  readonly maxDepth: number | null;
  /** The UCT exploration constant this search selected with. */
  readonly explorationWeight: number | null;
  /** Judge samples per branch the run ASKED for, median-aggregated. */
  readonly judgeSamplesRequested: number | null;
  /** Judge samples a CODE-BEARING branch actually got. The two spend knobs share
   *  one per-evaluation call pool, so a request the pool cannot fund is realised
   *  lower (mcts/evaluation.ts judgeCallBudget) — a run that asked for 20 and ran
   *  3 says so here rather than reading as a run that ran 20.
   *
   *  A prose-only branch of the same BUILD search realises one more, because it
   *  spends no call generating a check suite; a plan search has no code branches
   *  at all and this is its every branch. Null when the record does not carry
   *  both knobs — the realised size is then genuinely unknown, which is not the
   *  same claim as equal to the request. */
  readonly judgeSamplesRealised: number | null;
  /** The trusted work mode the search ran under. */
  readonly mode: string | null;
}

/** A merge's dispatch parameters. There is no budget and no ranking here. */
export interface MergedForkParams {
  readonly policy: 'merge';
  /** How the heads' findings were combined. */
  readonly mergeStrategy: string;
  /** Heads the split was dispatched with. */
  readonly branches: number;
}

export type ForkRunParams = (CompetedForkParams | MergedForkParams) & { readonly rootId: string };

/** The knobs a search's own checkpoint records — the subset the surface shows,
 *  read off the `PersistedMCTSConfig` the engine wrote. */
const ConfigSchema = v.object({
  budget: v.number(),
  branches: v.number(),
  mode: v.optional(v.string()),
  maxDepth: v.optional(v.number()),
  explorationWeight: v.optional(v.number()),
  judgeSamples: v.optional(v.number()),
  maxEvalLLMCalls: v.optional(v.number()),
});

/**
 * One search's dispatch parameters, or null when its checkpoint cannot be read
 * as a config.
 *
 * The JSON is decoded and validated in the same step it is consumed, so no
 * loosely-typed value ever leaves this function: a caller gets the domain type
 * or nothing. Null means "not recoverable", which the surface reports as such —
 * a number shown beside a run must be the number that run used, and inventing
 * defaults here would make an unrecorded knob indistinguishable from a knob left
 * at its default.
 */
function competedParams(rootId: string, configJson: string): ForkRunParams | null {
  // A checkpoint column that is not JSON is the one failure this read treats as
  // a value; any other failure is a fault in the read itself and propagates.
  const decoded: unknown = tolerate(() => JSON.parse(configJson), 'malformed-input');
  if (decoded === undefined) return null;
  const parsed = v.safeParse(ConfigSchema, decoded);
  if (!parsed.success) return null;
  const config = parsed.output;
  return {
    rootId,
    policy: 'mcts',
    budget: config.budget,
    branches: config.branches,
    maxDepth: config.maxDepth ?? null,
    explorationWeight: config.explorationWeight ?? null,
    judgeSamplesRequested: config.judgeSamples ?? null,
    judgeSamplesRealised: config.judgeSamples !== undefined && config.maxEvalLLMCalls !== undefined
      ? judgeCallBudget({
        judgeSamples: config.judgeSamples,
        maxLLMCalls: config.maxEvalLLMCalls,
        // A plan-mode search never runs the executor, so no call is spent on a
        // check suite and the whole pool is the ensemble's.
        offersRunnableCode: (config.mode ?? 'build') === 'build',
      }).ensemble
      : null,
    mode: config.mode ?? null,
  };
}

/**
 * Dispatch parameters for the named runs, in one read per store.
 *
 * Runs whose parameters are not recoverable are simply absent: a settled search
 * older than the ledger's retention has no `mcts_search_runs` row left (the
 * store prunes them), and the surface says "parameters no longer recorded"
 * rather than showing a plausible fiction.
 */
export function readForkRunParams(
  sql: SqlExecutor,
  rootIds: readonly string[],
): ForkRunParams[] {
  if (rootIds.length === 0) return [];
  const wanted = new Set(rootIds);
  const params: ForkRunParams[] = [];

  const searches = sql<{ root_id: string; config_json: string }>`
    SELECT root_id, config_json FROM mcts_search_runs`;
  for (const row of searches) {
    if (!wanted.has(row.root_id)) continue;
    const entry = competedParams(row.root_id, row.config_json);
    if (entry) params.push(entry);
  }

  // A split's strategy is stamped on every head it spawned, so the run's is any
  // of them; heads are counted the way the run list counts branches, excluding
  // the row a recursive sub-split's parent head owns.
  const splits = sql<{ root_id: string; merge_strategy: string; heads: number }>`
    SELECT root_id,
           MAX(merge_strategy)                             AS merge_strategy,
           SUM(CASE WHEN id != root_id THEN 1 ELSE 0 END)  AS heads
    FROM head_journal GROUP BY root_id`;
  for (const row of splits) {
    if (!wanted.has(row.root_id)) continue;
    params.push({
      rootId: row.root_id,
      policy: 'merge',
      mergeStrategy: row.merge_strategy,
      branches: row.heads,
    });
  }

  return params;
}

