/**
 * What a swarm node's SCORING OUTCOME is, where it persists, and how a re-driven
 * `agents.swarm` job re-enters its own interrupted search instead of starting a new
 * one.
 *
 * Specified by docs/EXPLORATION.md — "A node is an agent", "The journal read model",
 * "Inherited context", "Merge-back" and "The publication seal". Handles named alone
 * below are that document's.
 *
 * ── THE DEFECT THIS CLOSES ────────────────────────────────────────────────────
 *
 * A hosted swarm runs inside one Durable Object activation. `jobs/runner.ts` already
 * recovers an evicted background job completely — epoch-fenced reclaim, an attempt
 * cap, a fresh durable fiber — and `orchestrator/background-tools.ts` re-executes the
 * stored `agents` input on that fiber. For MCTS that IS a resume, because
 * `MctsSearchStore.findResumable` re-enters the tree keyed on the task. For a swarm it
 * was a SECOND SEARCH: `runSwarm` minted a fresh root id, wrote a second ledger row,
 * re-paid for every expansion, and left the first tree abandoned with its rows reading
 * `running` forever. Measured on a live `preset:'ideate'` run: five heads spawned, the
 * DO idled and was evicted inside five minutes, the re-drive created a second search,
 * that one died the same way, and the job settled `completed — took 18m` carrying an
 * aborted result while two ledger rows still read `running iter=0/5` eleven hours
 * later.
 *
 * ── WHY A STORE OF ITS OWN ────────────────────────────────────────────────────
 *
 * `search_nodes` is the TREE and stays it: structure, the backpropagated mean, the
 * visit count, the status. That is the division `swarm-run.ts`'s own `TreeNode` states
 * — the row holds SELECTION state, the in-memory node holds CONTENT — and it is why
 * the row cannot answer a resume: `value` is a running mean over a subtree, so an
 * internal node's own score is not recoverable from it, and no column holds the RAW
 * measurement the winner is ranked on, the floor breach that sealed the run, or the
 * ensemble a judged candidate realised. Re-entering without those would continue the
 * tree and crown the wrong candidate.
 *
 * So the CONTENT a re-entry needs is written beside the tree, one row per node, by the
 * engine that scored it. `head_journal` and `head_steps` keep the TURNS, unchanged and
 * unduplicated — this store holds no transcript, and what a `context:'fork'` child of
 * a re-entered parent inherits is read back out of the journal
 * ({@link reconstructedTurns}).
 *
 * ── WHAT A RE-ENTRY CANNOT RECOVER, NAMED ─────────────────────────────────────
 *
 * Three things were only ever in memory, and each is stated rather than papered over:
 *
 *   - A PAID GRANT THAT WAS NEVER EXPANDED. An agent node's `propose_branch` debits
 *     the budget from inside its own tool call, so an eviction can lose children the
 *     run had already bought. The re-entry derives the remaining budget from the TREE
 *     — expansions the search actually made — so those debits are refunded, which is
 *     correct: nothing was created, so nothing was spent. The node's own angles for
 *     those children are the loss.
 *   - A THOUGHT NODE'S UNANSWERED PROPOSAL. Arbitration answers one when selection
 *     reaches the node, and a proposal selection never reached was in the post-loop
 *     sweep's hands. A re-entered node is selectable again and expands through
 *     `advance` under the run's own `context`, so the expansion survives and the
 *     per-branch angles do not.
 *   - THE FAN-IN's ORDER WITHIN A LEVEL. Which members a barrier had already merged IS
 *     durable (`merged_at`), so a re-entry does not re-apply them; what is not is the
 *     partial accumulation of a barrier cut halfway through, whose remaining members
 *     are simply re-offered at the next barrier in dependency order.
 */

import type { ModelMessage } from 'ai';
import * as v from 'valibot';
import { KinuError } from '../obs/error';
import { diagnostics, renderThrownChain } from '../obs/index';
import type { HeadJournal } from '../heads/journal';
import type { HeadStep } from '../heads/types';
import { initSearchTables } from '../mcts/schemas';
import { initMctsSearchTable, MctsSearchStore } from '../mcts/search-store';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import { JsonValueSchema, type JsonValue } from '../utils/json';
import type {
  FloorBreach, MeasuredValue, ParetoAxis, ParetoEvidence, PublicationState,
} from './objective';
import type { SwarmProfileSnapshot } from '../profiles';

/**
 * What scoring one child produced, and what the tree must do about it.
 *
 * DECLARED HERE rather than in the runner because the settled arms are exactly what
 * persists: a node's row in {@link initSwarmNodeRecords}' table IS this union, so the
 * type and its durable codec cannot come apart. `instrument-faulted` is the one arm
 * that never reaches a row — it fails the whole run, so no node is scored under it.
 */
export type ChildOutcome =
  | { readonly kind: 'instrument-faulted'; readonly error: string }
  | { readonly kind: 'unmeasurable'; readonly detail: string; readonly witnessFound?: boolean | null }
  | {
    /**
     * THE NODE NEVER FINISHED, so nothing was measured and nothing may be inferred.
     *
     * A SEPARATE ARM from `unmeasurable`, and the distinction is the whole point: an
     * unmeasurable candidate is an answer the INSTRUMENT could not turn into a number,
     * which is a fact about the answer; an incomplete node has no answer for the
     * instrument to look at, which is a fact about the run. Collapsing them makes the
     * verifier's reason ("no runnable code") the story of a node the clock stopped —
     * and where an unfinished node's status line happens to carry a fence, collapsing
     * them SCORES it, which is the ranking measuring the clock.
     *
     * Neither is backpropagated, both take the node out of selection, and only this one
     * says the run was cut.
     */
    readonly kind: 'incomplete';
    readonly detail: string;
  }
  | {
    readonly kind: 'sealed';
    readonly measurement: MeasuredValue;
    readonly breach: FloorBreach;
    readonly witnessFound?: boolean | null;
  }
  | {
    readonly kind: 'scored';
    readonly measurement: MeasuredValue;
    /** Null where the objective's own range admits no score for this value. */
    readonly score: number | null;
    readonly witnessFound?: boolean | null;
  }
  | {
    readonly kind: 'pareto';
    readonly axes: readonly ParetoAxis[];
    readonly evidence: ParetoEvidence;
    readonly detail: string;
  }
  | {
    /**
     * Scored by the marginalised judge ensemble rather than by an instrument.
     *
     * A SEPARATE ARM and not a `scored` with a synthesised `MeasuredValue`, because a
     * judged node has no raw value in any objective's unit — the ensemble's [0,1]
     * median IS the number, and manufacturing a `measurement` around it would put a
     * judge's opinion into the field the records store keeps raw measurements in.
     * There is no `sealed` counterpart for the same reason: a floor is a bound on a
     * measured quantity and nothing here measured one.
     */
    readonly kind: 'judged';
    readonly score: number;
    /** The ensemble this candidate ACTUALLY sampled, which is the request after the
     *  per-evaluation call budget clamped it. Zero when the cascade short-circuited
     *  before the ensemble was reached — never asked, not asked and answered. */
    readonly ensemble: number;
    readonly grounding: string;
  };

/** Every arm a node can be RECORDED under: {@link ChildOutcome} minus the one that
 *  fails the run before any node is scored. */
export type SettledChildOutcome = Exclude<ChildOutcome, { kind: 'instrument-faulted' }>;

/**
 * What the engine recorded about ONE node, beyond the tree columns.
 *
 * Every field is something a re-entry needs and `search_nodes` cannot answer:
 * `outcome` carries the raw measurement the winner is ranked on, the breach that seals
 * the run and the ensemble a judged candidate realised; `conclusion` is what a `fresh`
 * child is seeded with; `aggregated` is the DAG's dependency edges, which are a
 * different edge from `parent_id` (*Merge-back*'s order, not selection's lineage); and
 * `tokens` is this candidate's own spend, which a records write quotes per row.
 */
export interface SwarmNodeRecord {
  /** Null for a run whose `score` axis measures nothing — an outcome that was never
   *  asked for, which is a different fact from one that produced no number. */
  readonly outcome: SettledChildOutcome | null;
  readonly conclusion: string | null;
  readonly aggregated: readonly string[];
  /** Null where the provider reported nothing. An unmeasured spend is not a free one. */
  readonly tokens: number | null;
}

const MeasuredValueSchema: v.GenericSchema<MeasuredValue> = v.object({
  kind: v.literal('measured'),
  value: v.number(),
  detail: v.string(),
  measured: v.optional(v.record(v.string(), v.number())),
  perInstance: v.optional(v.record(v.string(), v.number())),
});

const FloorBreachSchema: v.GenericSchema<FloorBreach> = v.object({
  floor: v.object({
    value: v.number(),
    proof: v.string(),
    kind: v.picklist(['certificate', 'adversary', 'physical']),
    bestKnownHonest: v.number(),
  }),
  measured: MeasuredValueSchema,
  margin: v.number(),
  hypotheses: v.tuple([v.literal('floor_wrong'), v.literal('verifier_gameable')]),
});

/**
 * The schema version this engine stamps into every record envelope. A reader must be
 * able to tell a row THIS engine wrote from one a FUTURE engine wrote: an unknown
 * version refuses by name instead of being quietly reshaped into something it is not.
 */
export const RECORD_SCHEMA_VERSION = 1;

/** A record AS IT IS STORED: the fields, plus the stamp naming the engine that wrote
 *  them. There is no unstamped form — {@link recordSwarmNode} is the table's only
 *  writer and it stamps every envelope. */
type StoredSwarmNodeRecord = SwarmNodeRecord & { readonly v: typeof RECORD_SCHEMA_VERSION };

/**
 * The durable gate over {@link StoredSwarmNodeRecord}, bound to the type it mirrors.
 *
 * `v.GenericSchema<T>` rather than an inferred shape, for the reason
 * `mcts/search-store.ts` binds its own persisted config the same way: a row is read
 * back by code that has moved on since it was written, and a schema that merely
 * happens to match the type today is a schema that stops matching it silently.
 *
 * The stamp is IN the schema, so there is exactly one shape a stored row may have and
 * no second schema to drift from this one.
 */
const StoredSwarmNodeRecordSchema: v.GenericSchema<StoredSwarmNodeRecord> = v.object({
  v: v.literal(RECORD_SCHEMA_VERSION),
  outcome: v.nullable(v.variant('kind', [
    v.object({
      kind: v.literal('unmeasurable'),
      detail: v.string(),
      witnessFound: v.optional(v.nullable(v.boolean())),
    }),
    v.object({ kind: v.literal('incomplete'), detail: v.string() }),
    v.object({
      kind: v.literal('sealed'),
      measurement: MeasuredValueSchema,
      breach: FloorBreachSchema,
      witnessFound: v.optional(v.nullable(v.boolean())),
    }),
    v.object({
      kind: v.literal('scored'),
      measurement: MeasuredValueSchema,
      score: v.nullable(v.number()),
      witnessFound: v.optional(v.nullable(v.boolean())),
    }),
    v.object({
      kind: v.literal('pareto'),
      axes: v.array(v.object({
        id: v.string(),
        direction: v.picklist(['minimise', 'maximise']),
      })),
      evidence: v.record(v.string(), v.number()),
      detail: v.string(),
    }),
    v.object({
      kind: v.literal('judged'),
      score: v.number(),
      ensemble: v.number(),
      grounding: v.string(),
    }),
  ])),
  conclusion: v.nullable(v.string()),
  aggregated: v.array(v.string()),
  tokens: v.nullable(v.number()),
});
const RecordVersionSchema = v.object({ v: v.number() });

/** The DDL, once. No `reconcileColumns`: the table ships whole, so there is no
 *  post-release column for a workspace to be missing. */
export function initSwarmNodeRecords(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS swarm_node_records (
    node_id     TEXT PRIMARY KEY,
    root_id     TEXT NOT NULL,
    record_json TEXT NOT NULL,
    merged_at   INTEGER,
    created_at  INTEGER NOT NULL
  )`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_swarm_node_records_root
    ON swarm_node_records(root_id)`);
}

/** The ONE writer of a node's record, so a second cannot drift from it. `INSERT OR
 *  REPLACE` because a re-entry that re-expands a node writes the node's row again,
 *  under the same id the grant reserved. */
export function recordSwarmNode(sql: SqlExecutor, input: {
  readonly rootId: string;
  readonly nodeId: string;
  readonly record: SwarmNodeRecord;
  readonly now: number;
}): void {
  void sql`INSERT OR REPLACE INTO swarm_node_records
    (node_id, root_id, record_json, merged_at, created_at)
    VALUES (${input.nodeId}, ${input.rootId},
            ${JSON.stringify({ v: RECORD_SCHEMA_VERSION, ...input.record })},
            (SELECT merged_at FROM swarm_node_records WHERE node_id = ${input.nodeId}),
            ${input.now})`;
}

/** Record that this member's work reached the ORIGIN. Its own column and its own
 *  writer: the record blob is what the node produced and this is what the run then did
 *  with it, and a re-entry offering an already-merged member to a fan-in would re-apply
 *  bytes the origin holds. */
export function markSwarmNodeMerged(sql: SqlExecutor, nodeId: string, now: number): void {
  void sql`UPDATE swarm_node_records SET merged_at = ${now} WHERE node_id = ${nodeId}`;
}

/** One node of an interrupted search, as the re-entry hands it back. */
export interface ReenteredSwarmNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly depth: number;
  /** `search_nodes.observation` — the complete answer this node is. */
  readonly artifact: string;
  /** Null for a node the tree holds and this store does not: the ROOT, which no model
   *  wrote, and a node whose activation died between the two writes. */
  readonly record: SwarmNodeRecord | null;
  /** Whether this member's work already reached the origin. */
  readonly merged: boolean;
  /** This node's own turns, reconstructed from its journal — what a `context:'fork'`
   *  child of it inherits. Empty for a toolless node, which journals nothing. */
  readonly produced: readonly ModelMessage[];
}

/**
 * One node the search PAID FOR and holds no answer for: its spawn is durable, its
 * tree row is not. The work a re-entry OWNS.
 *
 * THE TWO WRITES ARE NOT ONE. A node's existence becomes durable at
 * `HeadJournal.insertSpawn`, before its model runs; its answer becomes durable at
 * `swarm-scoring.ts`'s `recordSwarmNode` + `insertSearchNode`, which run only after
 * the whole LEVEL's barrier has returned. An activation destroyed between them — the
 * ordinary eviction — therefore leaves a node whose spawn the store remembers and
 * whose answer nothing does.
 *
 * THAT WINDOW WAS THE DEFECT, in both directions at once. The tree row was the only
 * evidence the accounting read, so a five-node search cut inside its only level
 * counted ZERO expansions on re-entry, recreated the whole budget and expanded five
 * MORE nodes under fresh ids — while the five it had already paid for were stamped
 * `aborted` with prose claiming "the nodes after it are the continuation". Ten rows,
 * five of them failures, for a search that asked for five nodes; and again per
 * eviction.
 *
 * So a node in this state is neither retired nor re-created: it is RE-RUN under its
 * own id, and it is COUNTED as the expansion it already was. Every field here is what
 * re-running it needs and the tree cannot answer, read off the row its spawn wrote.
 */
export interface PendingSwarmNode {
  readonly id: string;
  /** Never null: a pending node is a child, and the query admits only children whose
   *  parent the tree holds. */
  readonly parentId: string;
  readonly depth: number;
  /** `head_journal.task` — what this node was asked, verbatim. */
  readonly task: string;
  /** `head_journal.rationale` — its brief, and under an explicit per-node assignment
   *  the caller's own prompt. Empty where the row recorded none. */
  readonly rationale: string;
  /**
   * THE SLOT THIS NODE WAS ORIGINALLY ASKED IN, and the level width it was told
   * about — the pair every expansion prompt is built from (its diversity angle, and
   * the sibling angles it is told to differ from).
   *
   * DERIVED FROM ITS PARENT'S CHILD SET rather than from the pending set, and the
   * difference is the whole reason these are fields. A level's members are scored one
   * at a time after the barrier, so an activation can die with three of five siblings
   * recorded — and re-running the other two as "1 of 2" and "2 of 2" would hand them
   * the first two siblings' angles and ask them a question neither was asked. Read
   * this way, a node cut anywhere in its level is re-asked in exactly the words it
   * was asked in.
   *
   * A parent expanded in MORE THAN ONE wave — `uct` re-widening a node it already
   * expanded — has all of its children read as one level here, so a member of its
   * second wave is re-asked at a later slot than it originally held. That is a
   * different angle, not a lost one, and it is the one imprecision this recovery has.
   */
  readonly index: number;
  readonly siblings: number;
}

/** An interrupted search, re-entered: its identity, its lease, its tree, and the work
 *  it still owes. */
export interface SwarmReentry {
  readonly rootId: string;
  /** The lease this re-entry claimed. Every ledger write of the resumed run is stamped
   *  with it, so an executor from the dead activation is fenced. */
  readonly epoch: number;
  /** Root FIRST, then every other node parent-before-child, so a caller composing
   *  inherited context per node never looks at a parent it has not built. */
  readonly nodes: readonly ReenteredSwarmNode[];
  /** Ledger rows for the same task this re-entry retired. */
  readonly superseded: readonly string[];
  /** Nodes this re-entry must RE-RUN under their own ids, level order then spawn
   *  order — the unfinished work, and nothing else. */
  readonly pending: readonly PendingSwarmNode[];
  /** The resolved profile the search STARTED under, off its ledger row. Null for
   *  a run whose caller wired no catalog to resolve one. */
  readonly profile: SwarmProfileSnapshot | null;
  /** The caller conversation frozen when the first attempt began. */
  readonly originContext: readonly ModelMessage[];
}

interface NodeRow {
  id: string;
  parent_id: string | null;
  depth: number;
  observation: string;
}

/**
 * Re-enter the interrupted swarm for this task, or return null for a fresh search.
 *
 * ONLY CALLED FOR A RE-DRIVE. `agents-tool.ts` gates this on the re-drive marker
 * (`jobs/threshold.ts`), so a first `agents.swarm` call never reaches here and cannot
 * adopt the tree of a sibling that is still expanding. That gate is half the collision
 * rule; the other half is below.
 *
 * FIVE STEPS, in this order, and the order is the whole of the concurrency story:
 *
 *  1. FIND. `findRunningSwarms` returns every `running` row for the task, newest
 *     first. Task-keyed because a durable job row carries the tool input and no root
 *     id — see that method for why the key is safe.
 *  2. APPLY THE RULE: the newest row is re-entered and every older one is SUPERSEDED,
 *     so no later re-drive re-enters a row this one took over and no ledger row is
 *     left `running` with nothing behind it. That is the state the incident left —
 *     rows reading `running iter=0/5` eleven hours after their search died.
 *  3. CLAIM. `reclaim` bumps the lease epoch, fencing any executor still holding the
 *     old one. A null claim means the row settled between the find and here — another
 *     activation got there first — and this returns null, so the caller starts a fresh
 *     search rather than expanding a tree somebody else just finished.
 *  4. READ THE TREE, with each node's record and its reconstructed turns.
 *  5. CLAIM THE UNFINISHED WORK ({@link PendingSwarmNode}) rather than retiring it.
 *
 * STEP 5 REPLACED A TERMINAL WRITE, and that is this function's own defect closed.
 * It used to call `HeadJournal.abandonRunning` here, scoped to the root, stamping
 * every unreported row `aborted` with prose that said the nodes after it were the
 * continuation — while the accounting, blind to those rows, went on to create that
 * continuation out of fresh ids. Both halves were wrong and they compounded: a
 * five-node search reported five failures and five new nodes per eviction.
 *
 * `abandonRunning` KEEPS ITS ONE MEANING, which is why nothing here writes a status
 * at all: it says "nothing will ever continue this run", and the only caller that can
 * honestly say so is the start-of-life reconciliation, for a root whose durable job
 * the resume gate could not re-drive (`heads/reconcile.ts`). A re-entry is the exact
 * opposite claim. The roster is not left lying in the meantime — `markInterrupted`
 * has already moved those rows off `running`, and re-running one re-opens it.
 */
export function reenterSwarm(deps: {
  readonly sql: SqlExecutor;
  readonly ledger: MctsSearchStore;
  readonly journal: HeadJournal;
}, input: {
  readonly task: string;
  readonly now: number;
}): SwarmReentry | null {
  const [newest, ...older] = deps.ledger.findRunningSwarms(input.task);
  if (!newest) return null;
  const superseded = older.map((row) => row.rootId);
  for (const stale of superseded) deps.ledger.supersede(stale, input.now);
  const epoch = deps.ledger.reclaim(newest.rootId);
  if (epoch === null) return null;
  const rows = deps.sql<NodeRow>`
    SELECT id, parent_id, depth, observation FROM search_nodes
    WHERE root_id = ${newest.rootId} ORDER BY depth ASC, created_at ASC`;
  const records = new Map<string, { record: string; merged: boolean }>();
  for (const row of deps.sql<{ node_id: string; record_json: string; merged_at: number | null }>`
    SELECT node_id, record_json, merged_at FROM swarm_node_records
    WHERE root_id = ${newest.rootId}`) {
    records.set(row.node_id, { record: row.record_json, merged: row.merged_at !== null });
  }
  const nodes = rows.map((row): ReenteredSwarmNode => {
    const stored = records.get(row.id);
    return {
      id: row.id,
      parentId: row.parent_id,
      depth: row.depth,
      artifact: row.observation,
      record: stored ? parseRecord(row.id, stored.record) : null,
      merged: stored?.merged ?? false,
      produced: reconstructedTurns(deps.journal.readSteps(row.id)),
    };
  });
  return {
    rootId: newest.rootId,
    epoch,
    // The STARTED-UNDER profile, read back off the claimed row. A re-drive
    // never resolves against today's catalog — this record is what the first
    // attempt froze before it detached, so the tree continues under the role,
    // tier and preset it began with. Null where the caller wired no catalog.
    profile: deps.ledger.readSwarmProfile(newest.rootId),
    originContext: deps.ledger.readSwarmOriginContext(newest.rootId) ?? [],
    nodes,
    superseded,
    pending: pendingNodes(deps.sql, newest.rootId),
  };
}

/**
 * The nodes this search spawned and holds no tree row for, level order then spawn
 * order.
 *
 * `head_journal` IS the durable record of a node's existence — `insertSpawn` is the
 * first write of the expansion — so this is the only query that can see the window
 * between a spawn and its answer. The join is what keeps it honest in both
 * directions: a node WITH a tree row is finished as far as the search is concerned
 * (its record carries its outcome, `incomplete` included) and is not re-run, and a
 * node whose PARENT the tree does not hold is not re-run either, because there is
 * nothing to continue it from. The second case cannot arise from this engine —
 * selection reads `search_nodes`, so a parent always has a row — and is excluded by
 * the query rather than by a branch, so an older workspace's orphan settles with its
 * root instead of stopping the run.
 *
 * ORDERED ON `rowid`, not on `spawned_at`. Insertion order IS the order the wave was
 * spawned in, and it is the one ordering a re-open cannot disturb: re-running a node
 * moves its `spawned_at` forward, so ordering on that column would reshuffle siblings
 * on the second re-entry and hand them each other's diversity angles.
 */
function pendingNodes(sql: SqlExecutor, rootId: string): readonly PendingSwarmNode[] {
  // EVERY CHILD THIS SEARCH SPAWNED, recorded or not, because a pending node's slot
  // is its position among its PARENT'S children and that cannot be read off the
  // pending set alone. `recorded` is the join that says which of them the tree
  // already holds — the ones that are finished with, and are not re-run.
  const rows = sql<{
    id: string; parent_id: string; depth: number;
    task: string; rationale: string | null; recorded: number;
  }>`
    SELECT j.id, j.parent_id, j.depth, j.task, j.rationale,
      (SELECT COUNT(*) FROM search_nodes s WHERE s.id = j.id) AS recorded
    FROM head_journal j
    WHERE j.root_id = ${rootId}
      AND j.parent_id IN (SELECT id FROM search_nodes WHERE root_id = ${rootId})
    ORDER BY j.depth ASC, j.rowid ASC`;
  const levels = new Map<string, typeof rows>();
  for (const row of rows) {
    const level = levels.get(row.parent_id);
    if (level) level.push(row);
    else levels.set(row.parent_id, [row]);
  }
  const pending: PendingSwarmNode[] = [];
  for (const level of levels.values()) {
    for (const [index, row] of level.entries()) {
      if (row.recorded > 0) continue;
      pending.push({
        id: row.id,
        parentId: row.parent_id,
        depth: row.depth,
        task: row.task,
        rationale: row.rationale ?? '',
        index,
        siblings: level.length,
      });
    }
  }
  // Back into level-then-spawn order: the grouping above is by parent, and the run
  // re-runs the shallowest wave first so a resumed child's parent is always a node
  // this attempt has already rebuilt.
  return pending.sort((left, right) => left.depth - right.depth);
}

/**
 * The profile the interrupted search for this task STARTED under, read WITHOUT
 * claiming it.
 *
 * WHY A SECOND READER EXISTS. A re-drive replays the durable row's raw tool
 * input, and a first attempt that took its preset from its role's default never
 * had a `preset` to store — so the re-drive arrives with the field absent and,
 * resolving nothing, lands on the literal fallback. That is not a smaller
 * search, it is a DIFFERENT one: `ideate`'s branches, depth, carry and settle
 * re-enter the auditor's own tree, under the auditor's root id and claimed
 * epoch. The axes are resolved before {@link reenterSwarm} runs, which is why
 * the record has to be readable before the claim.
 *
 * THE SAME SELECTION `reenterSwarm` makes — the newest running row for the task
 * — because a preset derived from one row while a different row is re-entered
 * is exactly the drift this shares code to prevent.
 *
 * READ-ONLY: no supersede, no reclaim, no abandon. The claim still happens
 * exactly once, inside `reenterSwarm`. A row that settles between this read and
 * that claim turns the re-drive into a fresh search, which is already the
 * behaviour there, and a fresh search resolves its own preset.
 *
 * The tables are initialised here for `runSwarm`'s reason: a workspace that has
 * never run a search has no `mcts_search_runs`, and this read would be a query
 * against a table that does not exist.
 */
export function readStartedSwarmProfile(storage: {
  readonly sql: SqlExecutor;
  readonly execRaw: RawSqlExec;
}, task: string): SwarmProfileSnapshot | null {
  initSearchTables(storage.execRaw, storage.sql);
  initMctsSearchTable(storage.execRaw, storage.sql);
  const ledger = new MctsSearchStore(storage.sql);
  const [newest] = ledger.findRunningSwarms(task);
  return newest ? ledger.readSwarmProfile(newest.rootId) : null;
}

/** One reader per envelope version this build understands. A reader parses the WHOLE
 *  decoded envelope under its own schema, so a future arm added at v2 cannot be
 *  silently stripped down to the fields v1 happened to name. */
const RECORD_READERS = {
  1(nodeId: string, decoded: JsonValue): SwarmNodeRecord {
    const parsed = v.safeParse(StoredSwarmNodeRecordSchema, decoded);
    if (!parsed.success) {
      throw new KinuError('io',
        `the durable record for node ${nodeId} of this search will not read back under its own `
        + 'schema version 1: '
        + `${parsed.issues.map((issue) => issue.message).join('; ')}. This engine writes that `
        + 'version itself, so it is corruption rather than an old shape.');
    }
    const { v: _version, ...record } = parsed.output;
    return record;
  },
} satisfies Record<number, (nodeId: string, decoded: JsonValue) => SwarmNodeRecord>;

/**
 * A stored record, or a throw naming the node.
 *
 * NOT a fabricated default, for `MctsSearchStore.findResumable`'s reason and one
 * stronger: this row is what the winner is ranked on and what the seal is read from, so
 * a run continued past an unreadable one would crown a candidate it never measured and
 * could publish under a floor it had breached. The throw reaches the job runner, which
 * fails the attempt with the cause intact and bounds the retries.
 *
 * A MISSING STAMP IS CORRUPTION, not an older shape: {@link recordSwarmNode} is the
 * only writer this table has, and it stamps every envelope. So an unstamped row goes to
 * the same reader as a stamped one, whose `v` literal names the absent stamp for what
 * it is instead of guessing at a spelling nothing ever wrote.
 */
function parseRecord(nodeId: string, json: string): SwarmNodeRecord {
  const decoded = v.parse(JsonValueSchema, JSON.parse(json));
  const stamped = v.safeParse(RecordVersionSchema, decoded);
  // A row THIS build did not write is refused by NAME, not reshaped: continuing past
  // one would rank candidates against measurements this build cannot see.
  if (stamped.success && stamped.output.v !== RECORD_SCHEMA_VERSION) {
    throw new KinuError('io',
      `the durable record for node ${nodeId} of this search carries schema version `
      + `${String(stamped.output.v)}, which this build does not know: it was written by a newer `
      + 'engine, and continuing would rank candidates against rows this build cannot read.');
  }
  return RECORD_READERS[RECORD_SCHEMA_VERSION](nodeId, decoded);
}

export function readSwarmNodeRecords(
  sql: SqlExecutor, rootId: string,
): readonly { readonly nodeId: string; readonly record: SwarmNodeRecord }[] {
  return sql<{ node_id: string; record_json: string }>`
    SELECT node_id, record_json
    FROM swarm_node_records
    WHERE root_id = ${rootId}
    ORDER BY node_id ASC`
    .map((row) => ({ nodeId: row.node_id, record: parseRecord(row.node_id, row.record_json) }));
}

/**
 * One node's turns as a `context:'fork'` child inherits them, rebuilt from the journal.
 *
 * A RECONSTRUCTION, and the loss is named. The loop's own `ModelMessage[]` was never
 * durable — `head_steps` is, and it holds what the node SAID and what it CALLED, per
 * step, which is the read model the Exploration surface renders. So each step comes
 * back as one assistant turn carrying its text and a rendering of its tool calls.
 *
 * The calls arrive as TEXT rather than as tool-call parts, for exactly the reason
 * `heads/head-inference.ts` gives about an inherited tool message: a provider requires
 * every tool-call part to be answered by a result part with the same `toolCallId`, the
 * journal keeps no id, and inventing one makes the request malformed at the provider.
 * A step that neither said nor called anything is dropped rather than sent as an empty
 * assistant turn, which several providers reject outright.
 */
function reconstructedTurns(steps: readonly HeadStep[]): ModelMessage[] {
  const turns: ModelMessage[] = [];
  for (const step of steps) {
    const parts: string[] = [];
    if (step.reasoning) parts.push(step.reasoning);
    if (step.text) parts.push(step.text);
    for (const call of step.toolCalls) {
      const body = [
        call.input === undefined ? '' : `in: ${JSON.stringify(call.input)}`,
        call.output === undefined ? '' : `out: ${JSON.stringify(call.output)}`,
      ].filter((half) => half.length > 0).join('\n');
      parts.push(body.length > 0 ? `[${call.name}]\n${body}` : `[${call.name}]`);
    }
    if (parts.length === 0) continue;
    turns.push({ role: 'assistant', content: parts.join('\n\n') });
  }
  return turns;
}

/* ── what an unfinished search already has ────────────────────────────────── */

/** One candidate an unfinished search already measured. */
export interface HarvestedCandidate {
  readonly nodeId: string;
  readonly depth: number;
  /** The complete answer this node is — `search_nodes.observation`. */
  readonly artifact: string;
  /** The [0,1] the tree ranks on, or null for a node the instrument could not turn
   *  into a number. A null-scored candidate is still content somebody may want. */
  readonly score: number | null;
  /** What the outcome was, in the engine's own vocabulary. */
  readonly outcome: SettledChildOutcome['kind'] | 'unrecorded';
  readonly breach: FloorBreach | null;
  readonly witnessFound: boolean | null;
}

/** Everything an unfinished search can hand its caller. */
export interface SwarmHarvest {
  readonly rootId: string;
  /** How many attempts this search has had. Epoch 0 is the first, so this is
   *  `epoch + 1` — the same arithmetic the settle report's `attempt` uses. */
  readonly generations: number;
  /** Children the ledger had counted at its last level barrier. */
  readonly iteration: number;
  readonly candidates: readonly HarvestedCandidate[];
  /** Durable records omitted because they could not be decoded. */
  readonly unreadableNodes: readonly string[];
  /** Publication state inherited from any candidate that crossed its floor. */
  readonly publication: {
    readonly state: PublicationState;
    readonly caveat: string | null;
  };
  /** The best-scoring candidate, or null when nothing scored. Ranked on the
   *  normalised [0,1] the tree climbs, so no objective direction is needed here —
   *  the engine already resolved it when it wrote the record. */
  readonly best: HarvestedCandidate | null;
  /** Aggregate witness verdict when candidate records contain one. */
  readonly witnessFound: boolean | null;
}

/**
 * WHAT AN UNFINISHED SEARCH ALREADY HAS, for a caller that will not get a finished
 * one.
 *
 * A background `agents.swarm` job is bounded: it may be re-driven only so many times
 * and may live only so long (`jobs/runner.ts`). When a bound is reached the job has to
 * settle, and the question is what it settles WITH. It used to be nothing — an
 * eviction message — and that was measured costing the owner real work: root
 * `2rye1eyny1efm9583sqye` held TWO completed candidates with real content while its
 * job showed nothing at all, and the owner asked why the turn would not give itself
 * up. PARTIAL CANDIDATES ARE RESULTS. A search that measured two of five answers
 * measured two answers.
 *
 * READ-ONLY, and deliberately so: this is what the search HAS, not a transition. The
 * caller that reaches a bound is the one that settles the ledger row, because it is
 * the one that decided to stop.
 *
 * Returns null when there is nothing running for this task — which is the ordinary
 * case for a job that settled normally, and is why a harvest is never the first thing
 * tried.
 */
export function harvestSwarm(deps: {
  readonly sql: SqlExecutor;
  readonly ledger: MctsSearchStore;
}, task: string): SwarmHarvest | null {
  const [running] = deps.ledger.findRunningSwarms(task);
  if (!running) return null;

  const records = new Map<string, SwarmNodeRecord>();
  const unreadable = new Set<string>();
  for (const row of deps.sql<{ node_id: string; record_json: string }>`
    SELECT node_id, record_json FROM swarm_node_records WHERE root_id = ${running.rootId}`) {
    // A row this build cannot read is SKIPPED rather than thrown, and that is the
    // opposite of `parseRecord`'s rule on purpose: a re-entry that misreads a record
    // would continue a tree and crown a candidate it never measured, so it must stop.
    // A harvest is the last thing that will ever be said about this search, and
    // dropping one unreadable candidate to deliver four readable ones is strictly
    // better than delivering none.
    try {
      records.set(row.node_id, parseRecord(row.node_id, row.record_json));
    } catch (error) {
      diagnostics.event('swarm.harvest_record_unreadable', {
        nodeId: row.node_id,
        error: renderThrownChain({ cause: error }),
      });
      unreadable.add(row.node_id);
    }
  }

  const candidates: HarvestedCandidate[] = [];
  for (const row of deps.sql<NodeRow>`
    SELECT id, parent_id, depth, observation FROM search_nodes
    WHERE root_id = ${running.rootId} AND parent_id IS NOT NULL
    ORDER BY depth ASC, created_at ASC`) {
    const outcome = records.get(row.id)?.outcome ?? null;
    if (unreadable.has(row.id)) continue;
    const artifact = row.observation.trim();
    if (outcome?.kind === 'incomplete' || artifact.length === 0) continue;
    candidates.push({
      nodeId: row.id,
      depth: row.depth,
      artifact,
      score: outcome?.kind === 'scored' || outcome?.kind === 'judged' ? outcome.score : null,
      outcome: outcome?.kind ?? 'unrecorded',
      breach: outcome?.kind === 'sealed' ? outcome.breach : null,
      witnessFound: outcome?.kind === 'scored'
        || outcome?.kind === 'sealed'
        || outcome?.kind === 'unmeasurable'
        ? outcome.witnessFound ?? null
        : null,
    });
  }
  if (candidates.length === 0 && unreadable.size > 0) {
    throw new KinuError(
      'io',
      `the bounded search has ${String(unreadable.size)} candidate record(s), but none can be decoded: `
        + [...unreadable].join(', '),
    );
  }
  if (candidates.length === 0) return null;

  let best: HarvestedCandidate | null = null;
  for (const candidate of candidates) {
    if (candidate.score === null) continue;
    if (best === null || candidate.score > (best.score ?? Number.NEGATIVE_INFINITY)) best = candidate;
  }

  const firstBreach = candidates.find((candidate) => candidate.breach !== null)?.breach ?? null;
  const publication: SwarmHarvest['publication'] = firstBreach === null
    ? { state: { kind: 'open' }, caveat: null }
    : {
        state: { kind: 'sealed', breach: firstBreach, clearedBy: null },
        caveat: 'At least one candidate crossed the objective floor. Harvested artifacts are not publishable until the floor is re-derived.',
      };
  const witnessed = candidates
    .map((candidate) => candidate.witnessFound)
    .filter((found): found is boolean => found !== null);
  const witnessFound = witnessed.length === 0 ? null : witnessed.some(Boolean);

  return {
    rootId: running.rootId,
    generations: running.epoch + 1,
    iteration: running.iteration,
    candidates,
    best,
    unreadableNodes: [...unreadable],
    publication,
    witnessFound,
  };
}
