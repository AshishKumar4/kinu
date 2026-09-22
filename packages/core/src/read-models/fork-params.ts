/**
 * An exploration run's dispatch parameters, per half: search (`mcts_search_runs`) and journalled
 * nodes (`head_journal`). An agent-unit swarm has both. Read from persisted dispatch state only.
 */

import * as v from 'valibot';
import { tolerate } from '../obs/index';
import type { SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';

/** A search's dispatch parameters; remaining budget is progress, not a parameter. */
export interface SearchRunParams {
  readonly budget: number;
  readonly branches: number;
  readonly maxDepth: number | null;
  /** UCT exploration constant. */
  readonly explorationWeight: number | null;
  readonly judgeSamplesRequested: number | null;
  /**
   * Smallest ensemble any candidate was observed to sample; may be below the request when the call
   * pool cannot fund it (mcts/evaluation.ts judgeCallBudget). Null when never observed; never predicted.
   */
  readonly judgeSamplesRealised: number | null;
  readonly mode: string | null;
}

export interface TranscriptRunParams {
  /** How a fork's heads combine; for a swarm, the derived settle in head vocabulary. */
  readonly mergeStrategy: string;
  readonly branches: number;
}

/** One run's halves, null for a half it lacks. A run with neither is omitted. */
export interface ForkRunParams {
  readonly rootId: string;
  /** Null when no ledger row survives retention pruning. */
  readonly search: SearchRunParams | null;
  readonly transcripts: TranscriptRunParams | null;
}

const ConfigSchema = v.object({
  budget: v.number(),
  branches: v.number(),
  mode: v.optional(v.string()),
  maxDepth: v.optional(v.number()),
  explorationWeight: v.optional(v.number()),
  judgeSamples: v.optional(v.number()),
});

/** Null when the checkpoint cannot be read as a config; defaults are never invented. */
function searchParams(configJson: string, realised: number | null): SearchRunParams | null {
  // Only non-JSON is tolerated as a value; any other failure propagates.
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

/** Dispatch parameters for the named runs, one read per store. */
export function readForkRunParams(
  sql: SqlExecutor,
  actor: ActorHandle,
  rootIds: readonly string[],
): ForkRunParams[] {
  actor.assertCurrent();

  if (rootIds.length === 0) return [];
  const wanted = new Set(rootIds);
  const search = new Map<string, SearchRunParams>();
  const transcripts = new Map<string, TranscriptRunParams>();

  const searches = sql<{
    root_id: string; config_json: string; judge_samples_realised: number | null;
  }>`SELECT root_id, config_json, judge_samples_realised FROM mcts_search_runs
     WHERE actor_id = ${actor.actorId}`;

  for (const row of searches) {
    if (!wanted.has(row.root_id)) continue;
    const params = searchParams(row.config_json, row.judge_samples_realised);

    if (params) search.set(row.root_id, params);
  }

  // Strategy is stamped on every node; the count excludes the row a sub-split's parent head owns.
  const journals = sql<{ root_id: string; merge_strategy: string; heads: number }>`
    SELECT root_id,
           MAX(merge_strategy)                             AS merge_strategy,
           SUM(CASE WHEN id != root_id THEN 1 ELSE 0 END)  AS heads
    FROM head_journal WHERE actor_id = ${actor.actorId} GROUP BY root_id`;

  for (const row of journals) {
    if (!wanted.has(row.root_id)) continue;
    transcripts.set(row.root_id, { mergeStrategy: row.merge_strategy, branches: row.heads });
  }

  return rootIds.flatMap((rootId) => {
    const halves = { search: search.get(rootId) ?? null, transcripts: transcripts.get(rootId) ?? null };

    return halves.search === null && halves.transcripts === null ? [] : [{ rootId, ...halves }];
  });
}
