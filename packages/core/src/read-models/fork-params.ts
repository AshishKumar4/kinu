/**
 * What an exploration run was DISPATCHED with — the knobs of each half it has.
 *
 * `ForkRunSummary` answers "when did it search, and what did that run leave
 * behind", deliberately stopping at the summary. This is the layer that says what
 * the run was configured with, and it has the same shape for the same reason: a
 * run is not one of two dispatch policies. A search has an expansion budget, a
 * branching factor, a depth cap and an exploration constant; journalled nodes have
 * a strategy label and a count. A swarm whose `unit` is an agent has BOTH, and
 * reading it as one policy is what made a swarm's search knobs unreachable — the
 * canvas keyed these by root id, so the transcript entry simply overwrote the
 * search entry and every swarm reported a strategy label and no budget at all.
 *
 * Read from what the dispatch already persisted, so nothing here can drift from
 * what actually ran: `mcts_search_runs.config_json` is the resolved config the
 * engine that ran checkpointed, `mcts_search_runs.judge_samples_realised` is the
 * ensemble a candidate was OBSERVED to sample, and `head_journal.merge_strategy`
 * is the strategy every journalled node of a run was spawned under.
 */

import * as v from 'valibot';
import { tolerate } from '../obs/index';
import type { SqlExecutor } from '../types/primitives';

/**
 * A search's dispatch parameters. `budget` is the expansion budget it was given;
 * the remaining budget and the iterations already spent live on the ledger row and
 * are a progress reading, not a parameter.
 */
export interface SearchRunParams {
  readonly budget: number;
  /** Branches expanded per expansion. */
  readonly branches: number;
  readonly maxDepth: number | null;
  /** The UCT exploration constant this search selected with. */
  readonly explorationWeight: number | null;
  /** Judge samples per branch the run ASKED for. */
  readonly judgeSamplesRequested: number | null;
  /**
   * Judge samples a branch of this run was OBSERVED to actually sample — the
   * smallest ensemble any candidate reached, recorded by the engine that ran it.
   *
   * The two spend knobs share one per-evaluation call pool, so a request the pool
   * cannot fund is realised lower (mcts/evaluation.ts judgeCallBudget) — a run that
   * asked for 20 and ran 3 says so here rather than reading as a run that ran 20.
   *
   * Null means no candidate's ensemble was ever observed: a run that scored by
   * something other than a judge, or one whose every evaluation short-circuited
   * before the ensemble. Null is not the same claim as equal to the request, and
   * this number is never predicted from the knobs — the pool arithmetic gives the
   * CEILING the request was clamped to, which a run that short-circuits does not
   * reach.
   */
  readonly judgeSamplesRealised: number | null;
  /** The trusted work mode the search ran under. */
  readonly mode: string | null;
}

/** The journalled nodes' parameters. There is no budget and no ranking here. */
export interface TranscriptRunParams {
  /** The label every node of this run was journalled under — how a fork's heads
   *  were to be combined, and the derived settle in head vocabulary for a swarm. */
  readonly mergeStrategy: string;
  /** Nodes the run journalled. */
  readonly branches: number;
}

/**
 * One run's parameters: the halves it has, and null for a half it does not.
 *
 * BOTH null is not a value this read model produces — such a run is absent from
 * the result, which is what "parameters no longer recorded" means to the surface.
 */
export interface ForkRunParams {
  readonly rootId: string;
  /** The search half, or null when no ledger row survives: a settled search older
   *  than the ledger's retention has none (the store prunes them), and the surface
   *  says so rather than showing a plausible fiction. */
  readonly search: SearchRunParams | null;
  readonly transcripts: TranscriptRunParams | null;
}

/** The knobs a search's own checkpoint records — the subset the surface shows,
 *  read off the persisted config the engine wrote. */
const ConfigSchema = v.object({
  budget: v.number(),
  branches: v.number(),
  mode: v.optional(v.string()),
  maxDepth: v.optional(v.number()),
  explorationWeight: v.optional(v.number()),
  judgeSamples: v.optional(v.number()),
});

/**
 * One search's dispatch parameters, or null when its checkpoint cannot be read as
 * a config.
 *
 * The JSON is decoded and validated in the same step it is consumed, so no
 * loosely-typed value ever leaves this function: a caller gets the domain type or
 * nothing. Null means "not recoverable", which the surface reports as such — a
 * number shown beside a run must be the number that run used, and inventing
 * defaults here would make an unrecorded knob indistinguishable from a knob left
 * at its default.
 */
function searchParams(configJson: string, realised: number | null): SearchRunParams | null {
  // A checkpoint column that is not JSON is the one failure this read treats as a
  // value; any other failure is a fault in the read itself and propagates.
  const decoded: unknown = tolerate(() => JSON.parse(configJson), 'malformed-input');
  if (decoded === undefined) return null;
  const parsed = v.safeParse(ConfigSchema, decoded);
  if (!parsed.success) return null;
  const config = parsed.output;
  return {
    budget: config.budget,
    branches: config.branches,
    maxDepth: config.maxDepth ?? null,
    explorationWeight: config.explorationWeight ?? null,
    judgeSamplesRequested: config.judgeSamples ?? null,
    judgeSamplesRealised: realised,
    mode: config.mode ?? null,
  };
}

/**
 * Dispatch parameters for the named runs, in one read per store.
 *
 * One entry per root id, carrying both halves where the run has both. Runs with
 * neither half recoverable are simply absent.
 */
export function readForkRunParams(
  sql: SqlExecutor,
  rootIds: readonly string[],
): ForkRunParams[] {
  if (rootIds.length === 0) return [];
  const wanted = new Set(rootIds);
  const search = new Map<string, SearchRunParams>();
  const transcripts = new Map<string, TranscriptRunParams>();

  const searches = sql<{
    root_id: string; config_json: string; judge_samples_realised: number | null;
  }>`SELECT root_id, config_json, judge_samples_realised FROM mcts_search_runs`;
  for (const row of searches) {
    if (!wanted.has(row.root_id)) continue;
    const params = searchParams(row.config_json, row.judge_samples_realised);
    if (params) search.set(row.root_id, params);
  }

  // A run's strategy label is stamped on every node it journalled, so the run's is
  // any of them; nodes are counted the way the run list counts branches, excluding
  // the row a recursive sub-split's parent head owns.
  const journals = sql<{ root_id: string; merge_strategy: string; heads: number }>`
    SELECT root_id,
           MAX(merge_strategy)                             AS merge_strategy,
           SUM(CASE WHEN id != root_id THEN 1 ELSE 0 END)  AS heads
    FROM head_journal GROUP BY root_id`;
  for (const row of journals) {
    if (!wanted.has(row.root_id)) continue;
    transcripts.set(row.root_id, { mergeStrategy: row.merge_strategy, branches: row.heads });
  }

  return rootIds.flatMap((rootId) => {
    const halves = { search: search.get(rootId) ?? null, transcripts: transcripts.get(rootId) ?? null };
    return halves.search === null && halves.transcripts === null ? [] : [{ rootId, ...halves }];
  });
}
