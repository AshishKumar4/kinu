// Durable MCTS search checkpoint — the resume record that survives DO eviction.
//
// The search TREE (search_nodes) is already durable SQL; the only volatile state
// is the loop's progress (iteration + remaining budget) and the resolved config.
// This store persists that per search run so an evicted MCTS can be re-entered
// and continue its remaining budget against the persisted tree instead of being
// discarded (B6). It carries a monotonic lease epoch so a zombie search executor
// from a dead process is fenced (agent-core SPEC §5.3): every checkpoint/converge
// write is stamped with the epoch and rejected when stale.
//
// The engine's fiber snapshot (cf_agents_runs) is per-fiber and deleted once the
// SDK's recovery hook returns, so it can't drive a cross-activation resume; this
// store is the source of truth when injected, keyed by the search's root id.

import * as v from 'valibot';
import type { SqlExecutor, RawSqlExec } from '../types/primitives';
import { reconcileColumns } from '../identity/columns';
import type { MCTSConfig } from '../types/mcts';
import type { WorkMode } from '../prompting/surface';

/** The serializable knobs of an MCTSConfig — everything a resumed loop needs,
 *  minus the live handles (AbortSignal, callbacks, the store itself, and the
 *  mission port, which is a live object whose JSON round-trip would come back
 *  as an empty stub and silently un-govern a resumed search). */
export type PersistedMCTSConfig = Omit<MCTSConfig, 'signal' | 'onProgress' | 'search' | 'mission'>;
const PersistedMCTSConfigSchema: v.GenericSchema<PersistedMCTSConfig> = v.object({
  mode: v.optional(v.picklist(['build', 'plan'])),
  budget: v.number(),
  branches: v.number(),
  maxDepth: v.optional(v.number()),
  explorationWeight: v.optional(v.number()),
  pruneThreshold: v.optional(v.number()),
  minAcceptableScore: v.optional(v.number()),
  maxCostUSD: v.optional(v.number()),
  judgeSamples: v.optional(v.number()),
  maxEvalLLMCalls: v.optional(v.number()),
  takesEpsilon: v.optional(v.number()),
});

/**
 * The engines that write this ledger, and the column that tells their rows apart.
 *
 * `mcts` is `mcts/engine.ts` — a judged search with a resume loop. `swarm` is
 * `strategy/swarm-run.ts` — an objective-scored search whose nodes are agents, and
 * which has no resume: it settles or it is gone. The discriminator is load-bearing
 * rather than descriptive. {@link MctsSearchStore.findResumable} keys on
 * `status='running' AND task=?`, so without it a swarm that died mid-run would be
 * handed to the MCTS loop as a resumable search of the same task, which would then
 * expand the swarm's tree with judged branches under the swarm's own root id.
 */
export type SearchEngine = 'mcts' | 'swarm';

/**
 * The tree knobs a ledger row records: the subset every engine that writes this
 * table states, and exactly what `read-models/fork-params.ts` reads back.
 *
 * A resumable MCTS search records a superset — {@link PersistedMCTSConfig}, which is
 * assignable to this — because its loop needs every knob it was configured with. A
 * swarm records these and nothing else, because these are the knobs it has.
 */
export interface PersistedSearchKnobs {
  /** Expansions the run was given: iterations for `mcts`, children for `swarm`. */
  readonly budget: number;
  readonly branches: number;
  readonly mode?: WorkMode;
  readonly maxDepth?: number;
  readonly explorationWeight?: number;
  /** Judge samples per branch the run ASKED for. What it REALISED is observed
   *  rather than predicted — see {@link MctsSearchStore.observeJudgeEnsemble}. */
  readonly judgeSamples?: number;
}

/** A resumable (interrupted) search: enough to continue the loop from checkpoint. */
export interface ResumableSearch {
  rootId: string;
  rootMsgId: string;
  task: string;
  config: PersistedMCTSConfig;
  /** Iterations already completed. */
  iteration: number;
  /** Remaining iteration budget. */
  budget: number;
  /** Current lease epoch (pre-reclaim). */
  epoch: number;
}

type SearchStatus = 'running' | 'converged' | 'failed';

interface Row {
  root_id: string; task: string; root_msg_id: string; config_json: string;
  iteration: number; budget: number; status: string; epoch: number;
}

/** One search run's ledger row — the checkpoint metadata, without the live
 *  config blob. What "how many searches has this workspace run, and how did
 *  each end" reads. */
export interface MctsSearchRunSummary {
  rootId: string;
  task: string;
  /** Which engine ran it. Two do, and their rows differ in what the progress
   *  columns mean: a swarm never checkpoints, so its `iteration` is the children it
   *  finished and its `budget` is what it had left when it settled. */
  engine: SearchEngine;
  status: SearchStatus;
  iteration: number;
  budget: number;
  epoch: number;
  createdAt: number;
  updatedAt: number;
}

/** Strip the live, non-serializable fields off an MCTSConfig for persistence. */
export function persistableMCTSConfig(config: MCTSConfig): PersistedMCTSConfig {
  const { signal: _signal, onProgress: _onProgress, search: _search, mission: _mission, ...rest } = config;
  return rest;
}

/**
 * Columns `mcts_search_runs` gained after its first release, and the one place they
 * are listed. `CREATE TABLE IF NOT EXISTS` is a no-op on a workspace whose table
 * predates one of them while every reader still selects it by name — the failure
 * `SEARCH_NODES_POST_RELEASE_COLUMNS` exists for.
 */
const MCTS_SEARCH_RUNS_POST_RELEASE_COLUMNS = {
  engine: `TEXT NOT NULL DEFAULT 'mcts'`,
  judge_samples_realised: 'INTEGER',
} satisfies Readonly<Record<string, string>>;

export function initMctsSearchTable(execRaw: RawSqlExec, sql: SqlExecutor): void {
  execRaw(`CREATE TABLE IF NOT EXISTS mcts_search_runs (
    root_id      TEXT PRIMARY KEY,
    task         TEXT NOT NULL,
    engine       TEXT NOT NULL DEFAULT 'mcts',
    root_msg_id  TEXT NOT NULL,
    config_json  TEXT NOT NULL,
    iteration    INTEGER NOT NULL DEFAULT 0,
    budget       INTEGER NOT NULL,
    status       TEXT NOT NULL DEFAULT 'running',
    epoch        INTEGER NOT NULL DEFAULT 0,
    judge_samples_realised INTEGER,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  )`);
  reconcileColumns(sql, execRaw, 'mcts_search_runs', MCTS_SEARCH_RUNS_POST_RELEASE_COLUMNS);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_mcts_search_status_task ON mcts_search_runs(status, task, updated_at)`);
}

/** Retain settled search rows for a day, then prune — enough for post-hoc
 *  inspection without unbounded growth. */
const SETTLED_RETENTION_MS = 24 * 60 * 60 * 1000;

export class MctsSearchStore {
  constructor(private readonly sql: SqlExecutor) {}

  /**
   * Record a fresh search run (status='running', epoch 0). Also prunes old settled
   * rows so the table stays bounded.
   *
   * `rootMsgId` is null for an engine whose root is not a chat message — the swarm's
   * root is the workspace as found. The column is `NOT NULL` and relaxing it would be
   * a table rebuild, so a rootless run stores the empty string; nothing reads it back
   * except the resume path, which {@link findResumable} scopes to `mcts` rows.
   */
  begin(opts: {
    rootId: string; task: string; engine: SearchEngine; rootMsgId: string | null;
    config: PersistedSearchKnobs; budget: number; now: number;
  }): void {
    void this.sql`DELETE FROM mcts_search_runs
      WHERE status != 'running' AND updated_at < ${opts.now - SETTLED_RETENTION_MS}`;
    void this.sql`INSERT OR REPLACE INTO mcts_search_runs
      (root_id, task, engine, root_msg_id, config_json, iteration, budget, status, epoch,
       judge_samples_realised, created_at, updated_at)
      VALUES (${opts.rootId}, ${opts.task}, ${opts.engine}, ${opts.rootMsgId ?? ''},
              ${JSON.stringify(opts.config)},
              0, ${opts.budget}, 'running', 0, NULL, ${opts.now}, ${opts.now})`;
  }

  /**
   * Record the ensemble a candidate of this run was OBSERVED to sample, keeping the
   * SMALLEST any candidate reached.
   *
   * The smallest rather than the last, because the number answers "was the request
   * honoured": the two spend knobs share one per-evaluation call pool, so a candidate
   * the pool could not fund realises fewer, and a run that funded one candidate and
   * clamped the next did clamp. Folded in SQL so concurrent nodes of one swarm cannot
   * lose an observation to a read-modify-write, and never predicted from the knobs —
   * the pool arithmetic gives the ceiling, which an evaluation that short-circuited
   * before judging does not reach.
   */
  observeJudgeEnsemble(rootId: string, realised: number): void {
    void this.sql`UPDATE mcts_search_runs
      SET judge_samples_realised = MIN(COALESCE(judge_samples_realised, ${realised}), ${realised})
      WHERE root_id = ${rootId}`;
  }

  /** Persist loop progress. Fenced: a stale epoch (a zombie executor after a
   *  reclaim) is a no-op. */
  checkpoint(rootId: string, epoch: number, iteration: number, budget: number, now: number): void {
    void this.sql`UPDATE mcts_search_runs SET iteration=${iteration}, budget=${budget}, updated_at=${now}
      WHERE root_id=${rootId} AND status='running' AND epoch=${epoch}`;
  }

  /**
   * The most recently-updated still-running MCTS search for a task — the resume
   * source when an evicted tree search is re-driven.
   *
   * Scoped to this engine's own rows: a swarm has no resume, and its tree is scored
   * against an objective this loop has no seam for, so re-entering one here would
   * grow a swarm's tree with judged branches and report the result under the
   * swarm's root id.
   */
  findResumable(task: string, mode: WorkMode = 'build'): ResumableSearch | null {
    const rows = this.sql<Row>`SELECT root_id, task, root_msg_id, config_json, iteration, budget, status, epoch
      FROM mcts_search_runs WHERE status='running' AND task=${task} AND engine='mcts'
      ORDER BY updated_at DESC`;
    for (const row of rows) {
      // `begin` wrote this column with JSON.stringify, so a row that will not
      // parse is corruption. Resuming on a fabricated default would re-enter
      // the search with one branch and no budget and call it a resume.
      const config = v.parse(PersistedMCTSConfigSchema, JSON.parse(row.config_json));
      if ((config.mode ?? 'build') !== mode) continue;
      return {
        rootId: row.root_id,
        rootMsgId: row.root_msg_id,
        task: row.task,
        config,
        iteration: row.iteration,
        budget: row.budget,
        epoch: row.epoch,
      };
    }
    return null;
  }

  /** Claim a still-running search for a resume: bump the lease epoch (fencing
   *  any executor still holding the old one) and return it. Null if not running. */
  reclaim(rootId: string): number | null {
    void this.sql`UPDATE mcts_search_runs SET epoch = epoch + 1 WHERE root_id=${rootId} AND status='running'`;
    const rows = this.sql<{ epoch: number; status: string }>`
      SELECT epoch, status FROM mcts_search_runs WHERE root_id=${rootId} LIMIT 1`;
    const row = rows[0];
    return row && row.status === 'running' ? row.epoch : null;
  }

  /** Mark a search converged (fenced on epoch). */
  converge(rootId: string, epoch: number, now: number): void {
    void this.sql`UPDATE mcts_search_runs SET status='converged', updated_at=${now}
      WHERE root_id=${rootId} AND status='running' AND epoch=${epoch}`;
  }

  /** Mark a search failed (fenced on epoch). */
  fail(rootId: string, epoch: number, now: number): void {
    void this.sql`UPDATE mcts_search_runs SET status='failed', updated_at=${now}
      WHERE root_id=${rootId} AND status='running' AND epoch=${epoch}`;
  }

  get(rootId: string): { status: SearchStatus; iteration: number; budget: number; epoch: number } | null {
    const rows = this.sql<Row>`SELECT root_id, task, root_msg_id, config_json, iteration, budget, status, epoch
      FROM mcts_search_runs WHERE root_id=${rootId} LIMIT 1`;
    const r = rows[0];
    if (!r) return null;
    const status: SearchStatus = r.status === 'converged' || r.status === 'failed' ? r.status : 'running';
    return { status, iteration: r.iteration, budget: r.budget, epoch: r.epoch };
  }

  /** Recent search runs, newest-updated first — the run-level ledger a
   *  debugging surface needs to tell "how many searches has this workspace
   *  run, and which root_id does the latest one own" without touching
   *  search_nodes at all. */
  list(limit = 20): MctsSearchRunSummary[] {
    const rows = this.sql<Row & { engine: string; created_at: number; updated_at: number }>`
      SELECT root_id, task, engine, root_msg_id, config_json, iteration, budget, status, epoch,
             created_at, updated_at
      FROM mcts_search_runs ORDER BY updated_at DESC LIMIT ${limit}`;
    return rows.map((r) => ({
      rootId: r.root_id,
      task: r.task,
      engine: r.engine === 'swarm' ? 'swarm' : 'mcts',
      status: r.status === 'converged' || r.status === 'failed' ? r.status : 'running',
      iteration: r.iteration,
      budget: r.budget,
      epoch: r.epoch,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }
}
