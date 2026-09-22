// Durable MCTS search checkpoint (B6): loop progress and resolved config per search run, private
// to the actor that started it, so an evicted search resumes against its persisted tree.
// Writes are stamped with a monotonic lease epoch that fences zombie executors (agent-core SPEC §5.3).
// Private because reclaim keys on task text; search_nodes reach their owner through this row's root_id.

import { modelMessageSchema, type ModelMessage } from 'ai';
import * as v from 'valibot';
import type { SqlExecutor, RawSqlExec } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import type { MCTSConfig } from '../types/mcts';
import type { WorkMode } from '../types/turn';
import { validateSwarmProfileSnapshot, type SwarmProfileSnapshot } from '../profiles';

/** The serializable knobs of an MCTSConfig, minus live handles (signal, callbacks, store, and the
 *  mission port, whose JSON round-trip would silently un-govern a resumed search). */
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

const StoredModelMessageSchema: v.GenericSchema<ModelMessage> =
  v.custom<ModelMessage>((value) => modelMessageSchema.safeParse(value).success);

const StoredSwarmConfigSchema = v.looseObject({
  profile: v.optional(v.unknown()),
  originContext: v.optional(v.array(StoredModelMessageSchema)),
});

/**
 * The engines that write this ledger: `mcts` (mcts/engine.ts) and `swarm` (strategy/swarm-run.ts).
 * Both resume on `status='running' AND task=?`, so this column keeps each loop out of the other's tree.
 */
export type SearchEngine = 'mcts' | 'swarm';

/** The tree knobs every engine writing this table records; what `read-models/fork-params.ts` reads. */
export interface PersistedSearchKnobs {
  readonly budget: number;
  readonly branches: number;
  readonly mode?: WorkMode;
  readonly maxDepth?: number;
  readonly explorationWeight?: number;
  /** Judge samples requested; the realised count comes from {@link MctsSearchStore.observeJudgeEnsemble}. */
  readonly judgeSamples?: number;
  /** Swarm only: the turn profile frozen at `begin`, replayed by every re-drive. */
  readonly profile?: SwarmProfileSnapshot;
  readonly originContext?: readonly ModelMessage[];
}

export interface ResumableSearch {
  rootId: string;
  rootMsgId: string;
  task: string;
  config: PersistedMCTSConfig;
  iteration: number;
  budget: number;
  epoch: number;
}

/** One running swarm row. `iteration` and `budget` are derived from the durable tree at read time;
 *  the row's integer columns are MCTS-only. */
export interface ResumableSwarm {
  readonly rootId: string;
  readonly iteration: number;
  readonly budget: number;
  readonly epoch: number;
}

type SearchStatus = 'running' | 'converged' | 'failed' | 'superseded' | 'no_acceptable_candidate';

/** Unrecognised stored status reads as `running`, the column default, which invents no outcome. */
function readStatus(raw: string): SearchStatus {
  return raw === 'converged' || raw === 'failed' || raw === 'superseded'
    || raw === 'no_acceptable_candidate' ? raw : 'running';
}

interface Row {
  root_id: string; task: string; root_msg_id: string; config_json: string;
  iteration: number; budget: number; status: string; epoch: number;
}

export interface SearchProgress {
  readonly iteration: number;
  readonly budget: number;
  readonly now: number;
}

export interface MctsSearchRunSummary {
  rootId: string;
  task: string;
  /** Which engine ran it; a swarm's progress numbers are derived from its tree ({@link ResumableSwarm}). */
  engine: SearchEngine;
  status: SearchStatus;
  iteration: number;
  budget: number;
  epoch: number;
  createdAt: number;
  updatedAt: number;
}

export function persistableMCTSConfig(config: MCTSConfig): PersistedMCTSConfig {
  const { signal: _signal, onProgress: _onProgress, search: _search, mission: _mission, ...rest } = config;

  return rest;
}

export function initMctsSearchTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS mcts_search_runs (
    actor_id     TEXT NOT NULL,
    root_id      TEXT NOT NULL,
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
    updated_at   INTEGER NOT NULL,
    PRIMARY KEY (actor_id, root_id)
  )`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_mcts_search_status_task ON mcts_search_runs(actor_id, status, task, updated_at)`);
}

const SETTLED_RETENTION_MS = 24 * 60 * 60 * 1000;

export class MctsSearchStore {
  private readonly actorId: string;

  constructor(private readonly sql: SqlExecutor, private readonly actor: ActorHandle) {
    this.actorId = actor.actorId;
  }

  /**
   * Record a fresh search run (status='running', epoch 0) and prune old settled rows. A null
   * `rootMsgId` stores '' (the column is NOT NULL). A repeated root id throws rather than replacing.
   */
  begin(opts: {
    rootId: string; task: string; engine: SearchEngine; rootMsgId: string | null;
    config: PersistedSearchKnobs; budget: number; now: number;
  }): void {
    this.actor.assertCurrent();
    void this.sql`DELETE FROM mcts_search_runs
      WHERE actor_id = ${this.actorId} AND status != 'running'
        AND updated_at < ${opts.now - SETTLED_RETENTION_MS}`;
    void this.sql`INSERT INTO mcts_search_runs
      (actor_id, root_id, task, engine, root_msg_id, config_json, iteration, budget, status, epoch,
       judge_samples_realised, created_at, updated_at)
      VALUES (${this.actorId}, ${opts.rootId}, ${opts.task}, ${opts.engine}, ${opts.rootMsgId ?? ''},
              ${JSON.stringify(opts.config)},
              0, ${opts.budget}, 'running', 0, NULL, ${opts.now}, ${opts.now})`;
  }

  /**
   * Record an observed judge-ensemble size, keeping the smallest any candidate reached. Folded in SQL
   * so concurrent nodes cannot lose an observation.
   */
  observeJudgeEnsemble(rootId: string, realised: number): void {
    this.actor.assertCurrent();
    void this.sql`UPDATE mcts_search_runs
      SET judge_samples_realised = MIN(COALESCE(judge_samples_realised, ${realised}), ${realised})
      WHERE actor_id = ${this.actorId} AND root_id = ${rootId}`;
  }
  /** Persist the MCTS loop's progress; fenced, so a stale epoch is a no-op. Swarms never call this. */
  checkpoint(rootId: string, epoch: number, progress: SearchProgress): void {
    this.actor.assertCurrent();
    void this.sql`UPDATE mcts_search_runs
      SET iteration=${progress.iteration}, budget=${progress.budget}, updated_at=${progress.now}
      WHERE actor_id=${this.actorId} AND root_id=${rootId} AND status='running' AND epoch=${epoch}`;
  }

  touch(rootId: string, epoch: number, now: number): void {
    this.actor.assertCurrent();
    void this.sql`UPDATE mcts_search_runs SET updated_at=${now}
      WHERE actor_id=${this.actorId} AND root_id=${rootId} AND status='running' AND epoch=${epoch}`;
  }

  /** A swarm run's initial expansion budget from its frozen config; unparseable throws rather than reading zero. */
  private storedBudget(rootId: string, configJson: string): number {
    let raw: unknown;

    try {
      raw = JSON.parse(configJson);
    } catch (error) {
      throw new Error(`swarm run ${rootId}: its ledger config_json will not parse`, { cause: error });
    }

    const parsed = v.safeParse(v.object({ budget: v.number() }), raw);

    if (!parsed.success) {
      throw new Error(`swarm run ${rootId}: its ledger config_json carries no budget`);
    }

    return parsed.output.budget;
  }

  private childrenOf(rootId: string): number {
    return this.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM search_nodes
      WHERE actor_id = ${this.actorId} AND root_id = ${rootId}
        AND parent_id IS NOT NULL`[0]?.n ?? 0;
  }

  /**
   * The most recently-updated running MCTS search for a task. Scoped to `mcts` rows: a swarm's
   * stored config parses as an MCTS config, so nothing downstream would catch a cross-engine resume.
   */
  findResumable(task: string, mode: WorkMode = 'build'): ResumableSearch | null {
    this.actor.assertCurrent();

    const rows = this.sql<Row>`SELECT root_id, task, root_msg_id, config_json, iteration, budget, status, epoch
      FROM mcts_search_runs
      WHERE actor_id=${this.actorId} AND status='running' AND task=${task} AND engine='mcts'
      ORDER BY updated_at DESC`;

    for (const row of rows) {
      // A row that will not parse is corruption; resuming on a fabricated default is not a resume.
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

  /**
   * Every running swarm row for a task, newest first, for a re-driven `agents.swarm` job to re-enter.
   * The collision rule lives in `strategy/swarm-resume.ts`: newest wins, older rows are superseded,
   * and a fresh (non-re-drive) call never re-enters. Read-only.
   */
  findRunningSwarms(task: string): readonly ResumableSwarm[] {
    this.actor.assertCurrent();

    const rows = this.sql<{ root_id: string; config_json: string; epoch: number; children: number }>`
      SELECT r.root_id, r.config_json, r.epoch,
        (SELECT COUNT(*) FROM search_nodes s
         WHERE s.actor_id = r.actor_id AND s.root_id = r.root_id
           AND s.parent_id IS NOT NULL) AS children
      FROM mcts_search_runs r
      WHERE r.actor_id=${this.actorId} AND r.status='running' AND r.task=${task} AND r.engine='swarm'
      ORDER BY r.updated_at DESC, r.created_at DESC, r.root_id DESC`;

    return rows.map((row) => ({
      rootId: row.root_id,
      iteration: row.children,
      budget: Math.max(0, this.storedBudget(row.root_id, row.config_json) - row.children),
      epoch: row.epoch,
    }));
  }

  private readStoredSwarmConfig(
    rootId: string,
  ): v.InferOutput<typeof StoredSwarmConfigSchema> | null {
    const row = this.sql<{ config_json: string }>`
      SELECT config_json FROM mcts_search_runs
      WHERE actor_id = ${this.actorId} AND root_id = ${rootId} LIMIT 1`[0];

    if (!row) return null;
    let raw: unknown;

    try {
      raw = JSON.parse(row.config_json);
    } catch (error) {
      throw new Error(`swarm run ${rootId}: its ledger config_json will not parse`, { cause: error });
    }

    try {
      return v.parse(StoredSwarmConfigSchema, raw);
    } catch (error) {
      throw new Error(`swarm run ${rootId}: its ledger config_json is not an object`, { cause: error });
    }
  }

  readSwarmProfile(rootId: string): SwarmProfileSnapshot | null {
    const stored = this.readStoredSwarmConfig(rootId);

    return stored?.profile === undefined ? null : validateSwarmProfileSnapshot({ value: stored.profile });
  }

  readSwarmOriginContext(rootId: string): readonly ModelMessage[] | null {
    const stored = this.readStoredSwarmConfig(rootId);

    return stored?.originContext ?? null;
  }
  /** Every running swarm root, including searches that journalled no heads (`unit:'thought'`). */
  /** Whether any swarm row still claims a live executor; covers headless `unit:'thought'` searches. */
  hasRunningSwarms(): boolean {
    return this.hasRunning('swarm');
  }

  /** Whether any search of this actor, either engine, still claims a live executor. */
  hasRunningSearches(): boolean {
    return this.hasRunning(null);
  }

  /** One LIMIT-1 existence probe over this actor's unsettled runs; null `engine` means every engine. */
  private hasRunning(engine: 'swarm' | null): boolean {
    this.actor.assertCurrent();

    return this.sql<{ present: number }>`
      SELECT 1 AS present FROM mcts_search_runs
      WHERE actor_id=${this.actorId} AND status='running'
        AND (${engine} IS NULL OR engine=${engine}) LIMIT 1`.length > 0;
  }

  runningSwarmRoots(createdBefore: number): readonly string[] {
    this.actor.assertCurrent();

    return this.sql<{ root_id: string }>`
      SELECT root_id FROM mcts_search_runs
      WHERE actor_id=${this.actorId} AND status='running' AND engine='swarm' AND created_at < ${createdBefore}
      ORDER BY created_at ASC`.map((row) => row.root_id);
  }

  /**
   * Close every running swarm row except the named roots as `failed`; returns the closed root ids.
   * Unfenced like {@link supersede}: it runs after the resume gate, so remaining running rows have no
   * live executor; the except-set protects roots being re-entered.
   */
  closeUnclaimed(exceptRoots: ReadonlySet<string>, now: number): readonly string[] {
    this.actor.assertCurrent();

    // `now` is also the activation cutoff: rows created after it belong to live requests.
    const candidates = this.sql<{ root_id: string }>`
      SELECT root_id FROM mcts_search_runs
      WHERE actor_id=${this.actorId} AND status='running' AND engine='swarm' AND created_at < ${now}`
      .map((row) => row.root_id)
      .filter((rootId) => !exceptRoots.has(rootId));

    for (const rootId of candidates) {
      void this.sql`UPDATE mcts_search_runs SET status='failed', updated_at=${now}
        WHERE actor_id=${this.actorId} AND root_id=${rootId} AND status='running' AND engine='swarm'`;
    }

    return candidates;
  }


  /** Retire a running row a newer attempt of the same task took over; unfenced, distinct from {@link fail}. */
  supersede(rootId: string, now: number): void {
    this.actor.assertCurrent();
    void this.sql`UPDATE mcts_search_runs SET status='superseded', updated_at=${now}
      WHERE actor_id=${this.actorId} AND root_id=${rootId} AND status='running'`;
  }

  /** Claim a running search for resume by bumping the lease epoch; null if not running or not owned. */
  reclaim(rootId: string): number | null {
    this.actor.assertCurrent();
    void this.sql`UPDATE mcts_search_runs SET epoch = epoch + 1
      WHERE actor_id=${this.actorId} AND root_id=${rootId} AND status='running'`;

    const rows = this.sql<{ epoch: number; status: string }>`
      SELECT epoch, status FROM mcts_search_runs
      WHERE actor_id=${this.actorId} AND root_id=${rootId} LIMIT 1`;

    const row = rows[0];

    return row && row.status === 'running' ? row.epoch : null;
  }

  converge(rootId: string, epoch: number, now: number): void {
    this.actor.assertCurrent();
    void this.sql`UPDATE mcts_search_runs SET status='converged', updated_at=${now}
      WHERE actor_id=${this.actorId} AND root_id=${rootId} AND status='running' AND epoch=${epoch}`;
  }

  noAcceptableCandidate(rootId: string, epoch: number, now: number): void {
    this.actor.assertCurrent();
    void this.sql`UPDATE mcts_search_runs SET status='no_acceptable_candidate', updated_at=${now}
      WHERE actor_id=${this.actorId} AND root_id=${rootId} AND status='running' AND epoch=${epoch}`;
  }

  fail(rootId: string, epoch: number, now: number): void {
    this.actor.assertCurrent();
    void this.sql`UPDATE mcts_search_runs SET status='failed', updated_at=${now}
      WHERE actor_id=${this.actorId} AND root_id=${rootId} AND status='running' AND epoch=${epoch}`;
  }

  get(rootId: string): { status: SearchStatus; iteration: number; budget: number; epoch: number } | null {
    this.actor.assertCurrent();

    const rows = this.sql<Row & { engine: string }>`
      SELECT root_id, task, root_msg_id, config_json, engine, iteration, budget, status, epoch
      FROM mcts_search_runs WHERE actor_id=${this.actorId} AND root_id=${rootId} LIMIT 1`;

    const r = rows[0];

    if (!r) return null;

    const progress = r.engine === 'swarm'
      ? this.swarmProgress(r.root_id, r.config_json)
      : { iteration: r.iteration, budget: r.budget };

    return { status: readStatus(r.status), ...progress, epoch: r.epoch };
  }

  private swarmProgress(rootId: string, configJson: string) {
    const children = this.childrenOf(rootId);

    return { iteration: children, budget: Math.max(0, this.storedBudget(rootId, configJson) - children) };
  }


  list(limit = 20): MctsSearchRunSummary[] {
    this.actor.assertCurrent();

    const rows = this.sql<Row & { engine: string; created_at: number; updated_at: number }>`
      SELECT root_id, task, engine, root_msg_id, config_json, iteration, budget, status, epoch,
             created_at, updated_at
      FROM mcts_search_runs WHERE actor_id=${this.actorId}
      ORDER BY updated_at DESC LIMIT ${limit}`;

    return rows.map((r) => {
      const swarm = r.engine === 'swarm';

      const progress = swarm
        ? this.swarmProgress(r.root_id, r.config_json)
        : { iteration: r.iteration, budget: r.budget };

      return {
        rootId: r.root_id,
        task: r.task,
        engine: swarm ? 'swarm' : 'mcts',
        status: readStatus(r.status),
        ...progress,
        epoch: r.epoch,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    });
  }
}
