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
import { ProteusError } from '../obs/error';
import type { HeadJournal } from '../heads/journal';
import type { HeadStep } from '../heads/types';
import type { MctsSearchStore } from '../mcts/search-store';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import type { FloorBreach, MeasuredValue } from './objective';

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
  | { readonly kind: 'unmeasurable'; readonly detail: string }
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
  }
  | {
    readonly kind: 'scored';
    readonly measurement: MeasuredValue;
    /** Null where the objective's own range admits no score for this value. */
    readonly score: number | null;
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
 * The durable gate over {@link SwarmNodeRecord}, bound to the type it mirrors.
 *
 * `v.GenericSchema<T>` rather than an inferred shape, for the reason
 * `mcts/search-store.ts` binds its own persisted config the same way: a row is read
 * back by code that has moved on since it was written, and a schema that merely
 * happens to match the type today is a schema that stops matching it silently.
 */
const SwarmNodeRecordSchema: v.GenericSchema<SwarmNodeRecord> = v.object({
  outcome: v.nullable(v.variant('kind', [
    v.object({ kind: v.literal('unmeasurable'), detail: v.string() }),
    v.object({ kind: v.literal('incomplete'), detail: v.string() }),
    v.object({
      kind: v.literal('sealed'),
      measurement: MeasuredValueSchema,
      breach: FloorBreachSchema,
    }),
    v.object({
      kind: v.literal('scored'),
      measurement: MeasuredValueSchema,
      score: v.nullable(v.number()),
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
    VALUES (${input.nodeId}, ${input.rootId}, ${JSON.stringify(input.record)},
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

/** An interrupted search, re-entered: its identity, its lease, and its tree. */
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
  /** Node rows the dead activation left `running`, settled through
   *  `HeadJournal.abandonRunning` — the count, for the run's own disclosure. */
  readonly abandoned: number;
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
 *  4. SETTLE THE DEAD ATTEMPT'S NODES, through `HeadJournal.abandonRunning` scoped to
 *     this root. The EXISTING transition and no other: `head_journal.status` has
 *     exactly two terminal writers and a third would be the defect that one had only
 *     one. Those nodes stay re-expandable rows in `search_nodes` afterwards; what is
 *     settled is the claim that something is still executing them.
 *  5. READ THE TREE, with each node's record and its reconstructed turns.
 */
export function reenterSwarm(deps: {
  readonly sql: SqlExecutor;
  readonly ledger: MctsSearchStore;
  readonly journal: HeadJournal;
}, input: {
  readonly task: string;
  readonly reason: string;
  readonly now: number;
}): SwarmReentry | null {
  const [newest, ...older] = deps.ledger.findRunningSwarms(input.task);
  if (!newest) return null;
  const superseded = older.map((row) => row.rootId);
  for (const stale of superseded) deps.ledger.supersede(stale, input.now);
  const epoch = deps.ledger.reclaim(newest.rootId);
  if (epoch === null) return null;
  const abandoned = deps.journal.abandonRunning(
    input.reason, { rootId: newest.rootId }, input.now,
  );
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
    nodes,
    superseded,
    abandoned: abandoned.reduce((total, run) => total + run.abandoned, 0),
  };
}

/**
 * A stored record, or a throw naming the node.
 *
 * NOT a fabricated default, for `MctsSearchStore.findResumable`'s reason and one
 * stronger: this row is what the winner is ranked on and what the seal is read from, so
 * a run continued past an unreadable one would crown a candidate it never measured and
 * could publish under a floor it had breached. The throw reaches the job runner, which
 * fails the attempt with the cause intact and bounds the retries.
 */
function parseRecord(nodeId: string, json: string): SwarmNodeRecord {
  const parsed = v.safeParse(SwarmNodeRecordSchema, JSON.parse(json));
  if (parsed.success) return parsed.output;
  throw new ProteusError('io',
    `the durable record for node ${nodeId} of this search will not read back, so the run `
    + 'cannot be continued faithfully: '
    + `${parsed.issues.map((issue) => issue.message).join('; ')}. This engine wrote that row, `
    + 'so it is corruption rather than an old shape, and continuing would rank candidates '
    + 'against a measurement nobody can see.');
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
export function reconstructedTurns(steps: readonly HeadStep[]): ModelMessage[] {
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
