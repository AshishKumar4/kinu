// Durable swarm run ledger (B6): resolved config per run, private to the actor that started it, so
// an evicted run resumes against its persisted tree.
// Writes are stamped with a monotonic lease epoch that fences zombie executors (agent-core SPEC §5.3).
// Private because reclaim keys on task text; search_nodes reach their owner through this row's root_id.

import { modelMessageSchema, type ModelMessage } from 'ai';
import { Effect } from 'effect';
import * as v from 'valibot';
import { settleSync } from '../obs/effect';
import { jsonText, type JsonValue } from '../utils/json';
import type { SqlExecutor, RawSqlExec } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import type { WorkMode } from '../types/turn';
import { validateSwarmProfileSnapshot, type SwarmProfileSnapshot } from '../profiles';

const StoredModelMessageSchema: v.GenericSchema<ModelMessage> =
  v.custom<ModelMessage>((value) => modelMessageSchema.safeParse(value).success);

const StoredSwarmConfigSchema = v.looseObject({
  profile: v.optional(v.unknown()),
  originContext: v.optional(v.array(StoredModelMessageSchema)),
});

/** The tree knobs a swarm run records; what `read-models/fork-params.ts` reads. */
export interface PersistedSearchKnobs {
  readonly budget: number;
  readonly branches: number;
  readonly mode?: WorkMode;
  readonly maxDepth?: number;
  readonly explorationWeight?: number;
  /** Judge samples requested; the realised count comes from {@link MctsSearchStore.observeJudgeEnsemble}. */
  readonly judgeSamples?: number;
  /** The turn profile frozen at `begin`, replayed by every re-drive. */
  readonly profile?: SwarmProfileSnapshot;
  readonly originContext?: readonly ModelMessage[];
}

/** One running swarm row. `iteration` and `budget` are derived from the durable tree at read time. */
export interface ResumableSwarm {
  readonly rootId: string;
  readonly iteration: number;
  readonly budget: number;
  readonly epoch: number;
}

type SearchStatus = 'running' | 'converged' | 'failed' | 'superseded';

/** Unrecognised stored status reads as `running`, the column default, which invents no outcome. */
function readStatus(raw: string): SearchStatus {
  return raw === 'converged' || raw === 'failed' || raw === 'superseded' ? raw : 'running';
}

interface Row {
  root_id: string; task: string; config_json: string; status: string; epoch: number;
}

/** Progress numbers are derived from the run's tree ({@link ResumableSwarm}). */
export interface MctsSearchRunSummary {
  rootId: string;
  task: string;
  status: SearchStatus;
  iteration: number;
  budget: number;
  epoch: number;
  createdAt: number;
  updatedAt: number;
}

export function initMctsSearchTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS mcts_search_runs (
    actor_id     TEXT NOT NULL,
    root_id      TEXT NOT NULL,
    task         TEXT NOT NULL,
    config_json  TEXT NOT NULL,
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

function storedJson(rootId: string, configJson: string): Effect.Effect<JsonValue> {
  return jsonText(configJson, `swarm run ${rootId}: its ledger config_json will not parse`);
}

export class MctsSearchStore {
  private readonly actorId: string;

  constructor(private readonly sql: SqlExecutor, private readonly actor: ActorHandle) {
    this.actorId = actor.actorId;
  }

  /**
   * Record a fresh run (status='running', epoch 0) and prune old settled rows. A repeated root id
   * throws rather than replacing.
   */
  begin(opts: { rootId: string; task: string; config: PersistedSearchKnobs; now: number }): void {
    this.actor.assertCurrent();
    void this.sql`DELETE FROM mcts_search_runs
      WHERE actor_id = ${this.actorId} AND status != 'running'
        AND updated_at < ${opts.now - SETTLED_RETENTION_MS}`;
    void this.sql`INSERT INTO mcts_search_runs
      (actor_id, root_id, task, config_json, status, epoch, judge_samples_realised, created_at, updated_at)
      VALUES (${this.actorId}, ${opts.rootId}, ${opts.task}, ${JSON.stringify(opts.config)},
              'running', 0, NULL, ${opts.now}, ${opts.now})`;
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

  touch(rootId: string, epoch: number, now: number): void {
    this.actor.assertCurrent();
    void this.sql`UPDATE mcts_search_runs SET updated_at=${now}
      WHERE actor_id=${this.actorId} AND root_id=${rootId} AND status='running' AND epoch=${epoch}`;
  }

  /** A swarm run's initial expansion budget from its frozen config; unparseable throws rather than reading zero. */
  private storedBudget(rootId: string, configJson: string): Effect.Effect<number> {
    return Effect.flatMap(storedJson(rootId, configJson), (raw) => {
      const parsed = v.safeParse(v.object({ budget: v.number() }), raw);

      return parsed.success
        ? Effect.succeed(parsed.output.budget)
        : Effect.die(new Error(`swarm run ${rootId}: its ledger config_json carries no budget`));
    });
  }

  private childrenOf(rootId: string): number {
    return this.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM search_nodes
      WHERE actor_id = ${this.actorId} AND root_id = ${rootId}
        AND parent_id IS NOT NULL`[0]?.n ?? 0;
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
      WHERE r.actor_id=${this.actorId} AND r.status='running' AND r.task=${task}
      ORDER BY r.updated_at DESC, r.created_at DESC, r.root_id DESC`;

    return settleSync(Effect.forEach(rows, (row) => Effect.map(this.storedBudget(row.root_id, row.config_json), (budget): ResumableSwarm => ({
      rootId: row.root_id,
      iteration: row.children,
      budget: Math.max(0, budget - row.children),
      epoch: row.epoch,
    }))));
  }

  private readStoredSwarmConfig(
    rootId: string,
  ): Effect.Effect<v.InferOutput<typeof StoredSwarmConfigSchema> | null> {
    const row = this.sql<{ config_json: string }>`
      SELECT config_json FROM mcts_search_runs
      WHERE actor_id = ${this.actorId} AND root_id = ${rootId} LIMIT 1`[0];

    if (!row) return Effect.succeed(null);

    return Effect.flatMap(storedJson(rootId, row.config_json), (raw) => Effect.try({
      try: () => v.parse(StoredSwarmConfigSchema, raw),
      catch: (cause) => ({ cause }),
    }).pipe(Effect.catch((failed) => Effect.die(new Error(`swarm run ${rootId}: its ledger config_json is not an object`, { cause: failed.cause })))));
  }

  readSwarmProfile(rootId: string): SwarmProfileSnapshot | null {
    return settleSync(Effect.map(this.readStoredSwarmConfig(rootId), (stored) =>
      (stored?.profile === undefined ? null : validateSwarmProfileSnapshot({ value: stored.profile }))));
  }

  readSwarmOriginContext(rootId: string): readonly ModelMessage[] | null {
    return settleSync(Effect.map(this.readStoredSwarmConfig(rootId), (stored) => stored?.originContext ?? null));
  }
  /** Whether any swarm row still claims a live executor; covers headless `unit:'thought'` searches. */
  hasRunningSwarms(): boolean {
    this.actor.assertCurrent();

    return this.sql<{ present: number }>`
      SELECT 1 AS present FROM mcts_search_runs
      WHERE actor_id=${this.actorId} AND status='running' LIMIT 1`.length > 0;
  }

  runningSwarmRoots(createdBefore: number): readonly string[] {
    this.actor.assertCurrent();

    return this.sql<{ root_id: string }>`
      SELECT root_id FROM mcts_search_runs
      WHERE actor_id=${this.actorId} AND status='running' AND created_at < ${createdBefore}
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
      WHERE actor_id=${this.actorId} AND status='running' AND created_at < ${now}`
      .map((row) => row.root_id)
      .filter((rootId) => !exceptRoots.has(rootId));

    for (const rootId of candidates) {
      void this.sql`UPDATE mcts_search_runs SET status='failed', updated_at=${now}
        WHERE actor_id=${this.actorId} AND root_id=${rootId} AND status='running'`;
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

  fail(rootId: string, epoch: number, now: number): void {
    this.actor.assertCurrent();
    void this.sql`UPDATE mcts_search_runs SET status='failed', updated_at=${now}
      WHERE actor_id=${this.actorId} AND root_id=${rootId} AND status='running' AND epoch=${epoch}`;
  }

  get(rootId: string): { status: SearchStatus; iteration: number; budget: number; epoch: number } | null {
    this.actor.assertCurrent();

    const r = this.sql<Row>`
      SELECT root_id, task, config_json, status, epoch
      FROM mcts_search_runs WHERE actor_id=${this.actorId} AND root_id=${rootId} LIMIT 1`[0];

    if (!r) return null;

    return settleSync(Effect.map(this.swarmProgress(r.root_id, r.config_json), (progress) => ({ status: readStatus(r.status), ...progress, epoch: r.epoch })));
  }

  private swarmProgress(rootId: string, configJson: string): Effect.Effect<{ iteration: number; budget: number }> {
    const children = this.childrenOf(rootId);

    return Effect.map(this.storedBudget(rootId, configJson), (budget) => ({ iteration: children, budget: Math.max(0, budget - children) }));
  }


  list(limit = 20): MctsSearchRunSummary[] {
    this.actor.assertCurrent();

    const rows = this.sql<Row & { created_at: number; updated_at: number }>`
      SELECT root_id, task, config_json, status, epoch, created_at, updated_at
      FROM mcts_search_runs WHERE actor_id=${this.actorId}
      ORDER BY updated_at DESC LIMIT ${limit}`;

    return settleSync(Effect.forEach(rows, (r) => Effect.map(this.swarmProgress(r.root_id, r.config_json), (progress): MctsSearchRunSummary => ({
      rootId: r.root_id,
      task: r.task,
      status: readStatus(r.status),
      ...progress,
      epoch: r.epoch,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }))));
  }
}
