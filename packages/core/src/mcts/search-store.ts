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

import { modelMessageSchema, type ModelMessage } from 'ai';
import * as v from 'valibot';
import type { SqlExecutor, RawSqlExec } from '../types/primitives';
import type { MCTSConfig } from '../types/mcts';
import type { WorkMode } from '../prompting/surface';
import { validateSwarmProfileSnapshot, type SwarmProfileSnapshot } from '../profiles';

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
const StoredModelMessageSchema: v.GenericSchema<ModelMessage> =
  v.custom<ModelMessage>((value) => modelMessageSchema.safeParse(value).success);

const StoredSwarmConfigSchema = v.looseObject({
  profile: v.optional(v.unknown()),
  originContext: v.optional(v.array(StoredModelMessageSchema)),
});

/**
 * The engines that write this ledger, and the column that tells their rows apart.
 *
 * `mcts` is `mcts/engine.ts` — a judged search with a resume loop. `swarm` is
 * `strategy/swarm-run.ts` — an objective-scored search whose nodes are agents, and
 * which has a resume loop of its own ({@link MctsSearchStore.findResumableSwarm}).
 * The discriminator is load-bearing rather than descriptive, and it is what keeps the
 * two loops from re-entering each other's trees: both key on
 * `status='running' AND task=?`, so without the column a swarm that died mid-run
 * would be handed to the MCTS loop as a resumable search of the same task, which
 * would then expand the swarm's tree with judged branches under the swarm's own root
 * id — and a swarm's config parses as a persisted MCTS config, so nothing downstream
 * would notice.
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
  /**
   * The resolved turn profile this run started under, with its precedence
   * sources — swarm runs only (an MCTS loop has no role), and only where the
   * caller wired a catalog to resolve one. Written by `runSwarm` at `begin`, so
   * a durable detach and every later re-drive of the job replay THIS record
   * instead of resolving against today's catalog: catalog edits are for later
   * turns, never an in-flight tree.
   */
  readonly profile?: SwarmProfileSnapshot;
  /** The caller conversation frozen when this swarm began. */
  readonly originContext?: readonly ModelMessage[];
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

/**
 * One still-running SWARM row, as {@link MctsSearchStore.findRunningSwarms} hands it
 * back.
 *
 * The progress numbers are DERIVED at read time from the durable tree: `iteration`
 * is the children `search_nodes` records below the run's root row, and `budget` is
 * the initial expansion budget the row's persisted config carries minus those
 * children. The tree is what a run actually expanded, so a poll halfway through a
 * level and a poll after re-entry both read exactly what happened — there is no
 * second progress record to lag the tree or disagree with it. The row's own integer
 * columns are the MCTS loop's checkpoint fields and are never consulted for a swarm.
 */
export interface ResumableSwarm {
  readonly rootId: string;
  readonly iteration: number;
  readonly budget: number;
  /** Current lease epoch, pre-reclaim. */
  readonly epoch: number;
}

type SearchStatus = 'running' | 'converged' | 'failed' | 'superseded' | 'no_acceptable_candidate';

/** The stored status, narrowed. Anything a writer of this table never wrote reads as
 *  `running`, which is the column's own default and the only reading that cannot
 *  invent an outcome: a row whose status is unrecognised has not been settled by
 *  anything here. */
function readStatus(raw: string): SearchStatus {
  return raw === 'converged' || raw === 'failed' || raw === 'superseded'
    || raw === 'no_acceptable_candidate' ? raw : 'running';
}

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
  /** Which engine ran it. Their rows differ in what their progress numbers mean:
   *  an MCTS row checkpoints its loop into the columns; a swarm's are derived from
   *  its tree at read time ({@link ResumableSwarm}). */
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

export function initMctsSearchTable(execRaw: RawSqlExec): void {
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
  /** Persist the MCTS loop's progress — its iteration count and remaining budget.
   *  Fenced: a stale epoch (a zombie executor after a reclaim) is a no-op.
   *
   *  A swarm does NOT call this: its progress is derived from its tree
   *  ({@link ResumableSwarm}), so its only live-row write is {@link touch}. */
  checkpoint(rootId: string, epoch: number, iteration: number, budget: number, now: number): void {
    void this.sql`UPDATE mcts_search_runs SET iteration=${iteration}, budget=${budget}, updated_at=${now}
      WHERE root_id=${rootId} AND status='running' AND epoch=${epoch}`;
  }

  /** Refresh a SWARM run's heartbeat — `updated_at` alone, fenced on epoch like every
   *  write of this table. Progress needs no row write (the tree IS the progress), but
   *  freshness still answers "is this search hung or working" for every reader that
   *  keys on recency. */
  touch(rootId: string, epoch: number, now: number): void {
    void this.sql`UPDATE mcts_search_runs SET updated_at=${now}
      WHERE root_id=${rootId} AND status='running' AND epoch=${epoch}`;
  }

  /** A swarm run's initial expansion budget, read off the config its `begin` froze.
   *  Unparseable is corruption, not zero: a fabricated budget would understate what
   *  the run was given and overstate what is left. */
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

  /** Children the TREE records below a run's root row — every node that names the
   *  run and has a parent. This is the swarm's spent expansions, one fact read one
   *  way by every consumer. */
  private childrenOf(rootId: string): number {
    return this.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM search_nodes
      WHERE root_id = ${rootId} AND parent_id IS NOT NULL`[0]?.n ?? 0;
  }

  /**
   * The most recently-updated still-running MCTS search for a task — the resume
   * source when an evicted tree search is re-driven.
   *
   * Scoped to this engine's own rows. The swarm has a resume of its own now
   * ({@link findRunningSwarms}), so the scoping is no longer about which engine can be
   * resumed at all: it is that neither loop can execute the other's tree faithfully. A
   * swarm's is scored against an objective this loop has no seam for, so re-entering one
   * here would grow it with judged branches and report the result under the swarm's own
   * root id — and a swarm's stored config parses as a persisted MCTS config, so nothing
   * downstream would notice.
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

  /**
   * Every still-running SWARM row for a task, NEWEST FIRST — the read a re-driven
   * `agents.swarm` job re-enters its own search from, instead of starting another.
   *
   * WHY THE TASK IS A SAFE KEY. A durable job row carries the tool INPUT and nothing
   * else: no root id, because the root is minted inside the run. So the only identity
   * a re-drive can present is the one the caller gave, and `task` is that identity —
   * `resumableAgentsInput` refuses a stored row with no `task` outright, so a re-drive
   * that reaches here always has one. It is also the key {@link findResumable} has
   * used since B6 and the key `HeadJournal.findResumableRun` adopted for the same
   * reason, and that matters more than the key itself: three resume paths keyed three
   * ways is three sets of collision behaviour to reason about.
   *
   * WHY PLURAL, AND THE COLLISION RULE. `task` is not unique among `running` rows: two
   * `agents.swarm` calls with the same task can both be in flight in one workspace, and
   * two earlier attempts can both have been evicted. So the rows are handed back whole
   * and the RULE lives with the re-entry that applies it (`strategy/swarm-resume.ts`):
   * the newest running row wins and every older one is retired by {@link supersede}.
   *
   *   - NEWEST, because a re-drive continues the most recent attempt; the older rows
   *     are what earlier evictions left behind, and leaving them `running` is the
   *     defect that had two rows reading `running iter=0/5` eleven hours after their
   *     search died.
   *   - SUPERSEDED rather than failed, because `failed` says the search broke while
   *     these were taken over — different things to whoever reads the ledger, and they
   *     send an operator looking for different causes.
   *   - AND A FRESH CALL NEVER RE-ENTERS AT ALL. This is what keeps the rule from
   *     absorbing a LIVE sibling: re-entry is gated on the call being a re-drive
   *     (`jobs/threshold.ts`'s re-drive marker), so a second `agents.swarm` with the
   *     same task gets its own root while the first is still expanding. What remains is
   *     two RE-DRIVES of two evicted identical-task attempts converging on the newest
   *     tree — one continued search rather than two abandoned ones, which is the outcome
   *     this whole path exists to produce. {@link findResumable} has no such gate and
   *     accepts the wider collision; the swarm's is narrower on purpose.
   *
   * A READ, and only a read: a finder that writes cannot be used to ask what would
   * happen. Every write the rule needs is {@link supersede} and {@link reclaim}.
   */
  findRunningSwarms(task: string): readonly ResumableSwarm[] {
    const rows = this.sql<{ root_id: string; config_json: string; epoch: number; children: number }>`
      SELECT r.root_id, r.config_json, r.epoch,
        (SELECT COUNT(*) FROM search_nodes s
         WHERE s.root_id = r.root_id AND s.parent_id IS NOT NULL) AS children
      FROM mcts_search_runs r
      WHERE status='running' AND task=${task} AND engine='swarm'
      ORDER BY updated_at DESC, created_at DESC, root_id DESC`;
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
      SELECT config_json FROM mcts_search_runs WHERE root_id = ${rootId} LIMIT 1`[0];
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
    return stored?.profile === undefined ? null : validateSwarmProfileSnapshot(stored.profile);
  }

  readSwarmOriginContext(rootId: string): readonly ModelMessage[] | null {
    const stored = this.readStoredSwarmConfig(rootId);
    return stored?.originContext ?? null;
  }
  /** How many SWARM rows still claim a live executor. The start-of-life
   *  reconciliation reads this so a dead search's row reaches its closer even
   *  when the search journalled no heads of its own (`unit:'thought'` nodes
   *  write none) — the case the journal sweep cannot see. */
  runningSwarmCount(): number {
    return this.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM mcts_search_runs WHERE status='running' AND engine='swarm'`[0]?.n ?? 0;
  }

  /** Every running swarm root. Activation reconciliation offers these roots to
   *  the durable-job resume gate even when no head row was written yet. */
  runningSwarmRoots(): readonly string[] {
    return this.sql<{ root_id: string }>`
      SELECT root_id FROM mcts_search_runs
      WHERE status='running' AND engine='swarm'
      ORDER BY created_at ASC`.map((row) => row.root_id);
  }

  /**
   * Close every `running` SWARM row EXCEPT the named roots, as `failed`, and
   * return the root ids it closed.
   *
   * THE SEAM A FAILED JOB WAS MISSING. A search's own loop writes converge/fail
   * from inside its executor; when the durable job driving it gives up — the
   * resume cap exhausted, the kind not re-drivable — that executor is gone and
   * nothing ever writes the terminal row. Measured on the owner's workspace:
   * `2rye1eyny1efm9583sqye` read `running` eleven hours after its job had
   * settled `failed`, because the only writers left were fenced on an epoch
   * whose holder would never wake.
   *
   * Unfenced on purpose, exactly like {@link supersede}: this runs at the start
   * of an activation, after the resume gate answered, so a row still `running`
   * here was held by an executor that no longer exists by construction. The
   * except-set is what makes it safe rather than broad — a root the gate claimed
   * is being re-entered right now and keeps its row until the re-entry settles
   * it. `failed`, not superseded: nothing took the work over; the work died.
   */
  closeUnclaimed(exceptRoots: ReadonlySet<string>, now: number): readonly string[] {
    const candidates = this.sql<{ root_id: string }>`
      SELECT root_id FROM mcts_search_runs WHERE status='running' AND engine='swarm'`
      .map((row) => row.root_id)
      .filter((rootId) => !exceptRoots.has(rootId));
    for (const rootId of candidates) {
      void this.sql`UPDATE mcts_search_runs SET status='failed', updated_at=${now}
        WHERE root_id=${rootId} AND status='running' AND engine='swarm'`;
    }
    return candidates;
  }


  /** Retire a `running` row a newer attempt of the same task took over. Terminal and
   *  distinct from {@link fail}: the run did not break, it was superseded, and a
   *  reader that cannot tell those apart looks for a fault that never happened.
   *  Unfenced on purpose — the executor that held this row is gone by construction,
   *  which is why it is being superseded. */
  supersede(rootId: string, now: number): void {
    void this.sql`UPDATE mcts_search_runs SET status='superseded', updated_at=${now}
      WHERE root_id=${rootId} AND status='running'`;
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

  /** Settle a search that finished without an acceptable answer (fenced on
   *  epoch). This is distinct from `failed` (the search broke) and `converged`
   *  (a candidate cleared the floor). */
  noAcceptableCandidate(rootId: string, epoch: number, now: number): void {
    void this.sql`UPDATE mcts_search_runs SET status='no_acceptable_candidate', updated_at=${now}
      WHERE root_id=${rootId} AND status='running' AND epoch=${epoch}`;
  }

  /** Mark a search failed (fenced on epoch). */
  fail(rootId: string, epoch: number, now: number): void {
    void this.sql`UPDATE mcts_search_runs SET status='failed', updated_at=${now}
      WHERE root_id=${rootId} AND status='running' AND epoch=${epoch}`;
  }

  get(rootId: string): { status: SearchStatus; iteration: number; budget: number; epoch: number } | null {
    const rows = this.sql<Row & { engine: string }>`
      SELECT root_id, task, root_msg_id, config_json, engine, iteration, budget, status, epoch
      FROM mcts_search_runs WHERE root_id=${rootId} LIMIT 1`;
    const r = rows[0];
    if (!r) return null;
    if (r.engine === 'swarm') {
      const children = this.childrenOf(r.root_id);
      return {
        status: readStatus(r.status),
        iteration: children,
        budget: Math.max(0, this.storedBudget(r.root_id, r.config_json) - children),
        epoch: r.epoch,
      };
    }
    return { status: readStatus(r.status), iteration: r.iteration, budget: r.budget, epoch: r.epoch };
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
    return rows.map((r) => {
      const swarm = r.engine === 'swarm';
      const children = swarm ? this.childrenOf(r.root_id) : null;
      return {
        rootId: r.root_id,
        task: r.task,
        engine: swarm ? 'swarm' : 'mcts',
        status: readStatus(r.status),
        iteration: swarm ? children! : r.iteration,
        budget: swarm ? Math.max(0, this.storedBudget(r.root_id, r.config_json) - children!) : r.budget,
        epoch: r.epoch,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    });
  }
}
