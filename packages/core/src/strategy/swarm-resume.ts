/**
 * A swarm node's scoring outcome, its per-node record store, and how a re-driven `agents.swarm` job
 * re-enters its own interrupted search. docs/EXPLORATION.md "A node is an agent", "The journal read
 * model", "Inherited context", "Merge-back", "The publication seal".
 *
 * `search_nodes` holds selection state only; this store holds the content a re-entry needs.
 * Turns stay in `head_journal`/`head_steps`. Named losses on re-entry: paid grants never expanded
 * (refunded), a thought node's unanswered proposal, and a fan-in barrier's partial accumulation.
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
import type { ActorHandle } from '../identity/actor-handle';
import { JsonValueSchema, type JsonValue } from '../utils/json';
import {
  FloorBreachSchema, MeasuredValueSchema,
  type FloorBreach, type MeasuredValue, type ParetoAxis, type ParetoEvidence, type PublicationState,
} from './objective';
import type { SwarmProfileSnapshot } from '../profiles';
import type { SwarmCandidate } from './swarm';

/**
 * What scoring one child produced. Declared here because the settled arms are the persisted row;
 * `instrument-faulted` fails the run and never reaches a row.
 */
export type ChildOutcome =
  | { readonly kind: 'instrument-faulted'; readonly error: string }
  | { readonly kind: 'unmeasurable'; readonly detail: string; readonly witnessFound?: boolean | null }
  | {
    /**
     * The node never finished: a fact about the run, unlike `unmeasurable` (a fact about the answer).
     * Not backpropagated and out of selection.
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
    /** Scored by the judge ensemble; the [0,1] median is the number, with no raw measurement and no `sealed` counterpart. */
    readonly kind: 'judged';
    readonly score: number;
    /** Ensemble actually sampled after the call-budget clamp; zero when the cascade short-circuited. */
    readonly ensemble: number;
    readonly grounding: string;
  };

/** Every arm a node can be recorded under. */
export type SettledChildOutcome = Exclude<ChildOutcome, { kind: 'instrument-faulted' }>;

/** One reading of a recorded outcome for scoring, re-entry and harvest; sealed ranks nothing. */
export function outcomeFacts(outcome: SettledChildOutcome | null): Omit<SwarmCandidate, 'id' | 'artifact'> & {
  readonly breach: FloorBreach | null;
  readonly rank: number | null;
  readonly ensemble: number;
} {
  const score = outcome?.kind === 'scored' || outcome?.kind === 'judged' ? outcome.score : null;

  return {
    measured: outcome?.kind === 'sealed' || outcome?.kind === 'scored' ? outcome.measurement : null,
    pareto: outcome?.kind === 'pareto' ? outcome.evidence : null,
    unmeasurable: outcome?.kind === 'unmeasurable' ? outcome.detail : null,
    incomplete: outcome?.kind === 'incomplete' ? outcome.detail : null,
    score,
    witnessFound: outcome?.kind === 'sealed' || outcome?.kind === 'scored' || outcome?.kind === 'unmeasurable'
      ? outcome.witnessFound ?? null
      : null,
    breach: outcome?.kind === 'sealed' ? outcome.breach : null,
    rank: outcome?.kind === 'scored' ? outcome.measurement.value : score,
    ensemble: outcome?.kind === 'judged' ? outcome.ensemble : 0,
  };
}

/**
 * What the engine recorded about one node that `search_nodes` cannot answer. `aggregated` is the
 * DAG's dependency edges (*Merge-back*'s order), distinct from `parent_id`.
 */
export interface SwarmNodeRecord {
  /** Null when the `score` axis measures nothing, distinct from an outcome with no number.
   *  `search_node_scores` reads its `score` in SQL. */
  readonly outcome: SettledChildOutcome | null;
  readonly conclusion: string | null;
  readonly aggregated: readonly string[];
  /** Null where the provider reported nothing; not zero. */
  readonly tokens: number | null;
}

/** Stamped into every record envelope; an unknown version refuses by name. */
export const RECORD_SCHEMA_VERSION = 1;

/** A record as stored, with its version stamp; {@link recordSwarmNode} is the only writer. */
type StoredSwarmNodeRecord = SwarmNodeRecord & { readonly v: typeof RECORD_SCHEMA_VERSION };

/** Durable gate over {@link StoredSwarmNodeRecord}, bound to the type so the two cannot drift. */
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

/** No `reconcileColumns`: the table shipped whole. */
export function initSwarmNodeRecords(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS swarm_node_records (
    actor_id    TEXT NOT NULL,
    node_id     TEXT NOT NULL,
    root_id     TEXT NOT NULL,
    record_json TEXT NOT NULL,
    merged_at   INTEGER,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (actor_id, node_id)
  )`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_swarm_node_records_root
    ON swarm_node_records(actor_id, root_id)`);
}

/** The only writer of a node's record. `INSERT OR REPLACE`: a re-entry rewrites a re-expanded node under its reserved id. */
export function recordSwarmNode(sql: SqlExecutor, actor: ActorHandle, input: {
  readonly rootId: string;
  readonly nodeId: string;
  readonly record: SwarmNodeRecord;
  readonly now: number;
}): void {
  actor.assertCurrent();
  const actorId = actor.actorId;
  void sql`INSERT OR REPLACE INTO swarm_node_records
    (actor_id, node_id, root_id, record_json, merged_at, created_at)
    VALUES (${actorId}, ${input.nodeId}, ${input.rootId},
            ${JSON.stringify({ v: RECORD_SCHEMA_VERSION, ...input.record })},
            (SELECT merged_at FROM swarm_node_records
               WHERE actor_id = ${actorId} AND node_id = ${input.nodeId}),
            ${input.now})`;
}

/** Record that this member's work reached the origin, so a re-entry does not re-apply it in a fan-in. */
export function markSwarmNodeMerged(
  sql: SqlExecutor, actor: ActorHandle, nodeId: string, now: number,
): void {
  actor.assertCurrent();
  void sql`UPDATE swarm_node_records SET merged_at = ${now}
    WHERE actor_id = ${actor.actorId} AND node_id = ${nodeId}`;
}

/** One node of an interrupted search, as the re-entry hands it back. */
export interface ReenteredSwarmNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly depth: number;
  /** `search_nodes.observation` — the complete answer this node is. */
  readonly artifact: string;
  /** Null for the root and for a node whose activation died between the two writes. */
  readonly record: SwarmNodeRecord | null;
  /** Whether this member's work already reached the origin. */
  readonly merged: boolean;
  /** What an inherit-child of this node inherits; empty for a toolless node. */
  readonly produced: readonly ModelMessage[];
}

/**
 * A node the search paid for with no answer: its spawn is durable (`insertSpawn`), its tree row
 * is not (written after the level barrier). Re-run under its own id and counted as the expansion
 * it already was; never retired or re-created.
 */
export interface PendingSwarmNode {
  readonly id: string;
  readonly parentId: string;
  readonly depth: number;
  /** `head_journal.task` — what this node was asked, verbatim. */
  readonly task: string;
  /** `head_journal.rationale`; under an explicit per-node assignment, the caller's prompt. Empty if none. */
  readonly rationale: string;
  /** Every sibling's durable brief, including siblings that already settled. */
  readonly briefs: readonly string[];
  /**
   * Original slot and level width, derived from the parent's full child set so a re-run node is
   * re-asked in its original words. A parent expanded over several waves is read as one level, so a
   * later-wave member may get a later slot.
   */
  readonly index: number;
  readonly siblings: number;
}

/** An interrupted search, re-entered. */
export interface SwarmReentry {
  readonly rootId: string;
  /** Stamped on every ledger write of the resumed run, fencing the dead activation. */
  readonly epoch: number;
  /** Root first, then parent-before-child. */
  readonly nodes: readonly ReenteredSwarmNode[];
  /** Ledger rows for the same task this re-entry retired. */
  readonly superseded: readonly string[];
  /** Unfinished nodes to re-run under their own ids, level order then spawn order. */
  readonly pending: readonly PendingSwarmNode[];
  /** The profile the search started under; null when no catalog was wired. */
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
 * Re-enter the interrupted swarm for this task, or null for a fresh search. Only called for a
 * re-drive (gated in `agents-tool.ts`). Order is the concurrency story: find running rows, supersede
 * all but the newest, `reclaim` (null: another activation settled it), read the tree, claim pending
 * nodes. Never `abandonRunning` here: only start-of-life reconciliation (`heads/reconcile.ts`) may
 * say a run will not continue.
 */
export function reenterSwarm(deps: {
  readonly sql: SqlExecutor;
  readonly ledger: MctsSearchStore;
  readonly journal: HeadJournal;
  /** Whose re-entry; journal rows are actor-private. */
  readonly actor: ActorHandle;
}, input: {
  readonly task: string;
  readonly now: number;
}): SwarmReentry | null {
  deps.actor.assertCurrent();
  const actorId = deps.actor.actorId;
  const [newest, ...older] = deps.ledger.findRunningSwarms(input.task);

  if (!newest) return null;
  const superseded = older.map((row) => row.rootId);

  for (const stale of superseded) deps.ledger.supersede(stale, input.now);
  const epoch = deps.ledger.reclaim(newest.rootId);

  if (epoch === null) return null;

  const rows = deps.sql<NodeRow>`
    SELECT id, parent_id, depth, observation FROM search_nodes
    WHERE actor_id = ${actorId} AND root_id = ${newest.rootId}
    ORDER BY depth ASC, created_at ASC`;

  const records = new Map<string, { record: string; merged: boolean }>();

  for (const row of deps.sql<{ node_id: string; record_json: string; merged_at: number | null }>`
    SELECT node_id, record_json, merged_at FROM swarm_node_records
    WHERE actor_id = ${actorId} AND root_id = ${newest.rootId}`) {
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
    // Started-under profile off the claimed row; never today's catalog.
    profile: deps.ledger.readSwarmProfile(newest.rootId),
    originContext: deps.ledger.readSwarmOriginContext(newest.rootId) ?? [],
    nodes,
    superseded,
    pending: pendingNodes(deps.sql, deps.actor.actorId, newest.rootId),
  };
}

/**
 * Spawned nodes with no tree row whose parent the tree holds, level then spawn order. Ordered on
 * `rowid`: re-running moves `spawned_at`, which would reshuffle siblings' angles.
 */
function pendingNodes(sql: SqlExecutor, actorId: string, rootId: string): readonly PendingSwarmNode[] {
  // Every spawned child, recorded or not: a pending node's slot is its position among its parent's children.
  const rows = sql<{
    id: string; parent_id: string; depth: number;
    task: string; rationale: string | null; recorded: number;
  }>`
    SELECT j.id, j.parent_id, j.depth, j.task, j.rationale,
      (SELECT COUNT(*) FROM search_nodes s
         WHERE s.actor_id = ${actorId} AND s.id = j.id) AS recorded
    FROM head_journal j
    WHERE j.actor_id = ${actorId} AND j.root_id = ${rootId}
      AND j.parent_id IN (
        SELECT id FROM search_nodes WHERE actor_id = ${actorId} AND root_id = ${rootId})
    ORDER BY j.depth ASC, j.rowid ASC`;

  const levels = new Map<string, typeof rows>();

  for (const row of rows) {
    const level = levels.get(row.parent_id);

    if (level) level.push(row);
    else levels.set(row.parent_id, [row]);
  }

  const pending: PendingSwarmNode[] = [];

  for (const level of levels.values()) {
    const briefs = level.map((row) => row.rationale ?? '');

    for (const [index, row] of level.entries()) {
      if (row.recorded > 0) continue;
      pending.push({
        id: row.id,
        parentId: row.parent_id,
        depth: row.depth,
        task: row.task,
        rationale: row.rationale ?? '',
        index,
        briefs,
        siblings: level.length,
      });
    }
  }

  // Shallowest first so a resumed child's parent is already rebuilt.
  return pending.sort((left, right) => left.depth - right.depth);
}

/**
 * The profile the interrupted search for this task started under, read without claiming, so axes
 * resolve before {@link reenterSwarm}. Same row selection as `reenterSwarm`; read-only.
 */
export function readStartedSwarmProfile(storage: {
  readonly sql: SqlExecutor;
  readonly execRaw: RawSqlExec;
}, actor: ActorHandle, task: string): SwarmProfileSnapshot | null {
  initSearchTables(storage.execRaw);
  initMctsSearchTable(storage.execRaw);
  const ledger = new MctsSearchStore(storage.sql, actor);
  const [newest] = ledger.findRunningSwarms(task);

  return newest ? ledger.readSwarmProfile(newest.rootId) : null;
}

/** One reader per envelope version; each parses the whole envelope under its own schema. */
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
 * A stored record, or a throw naming the node. Never a default: this row ranks the winner and
 * holds the seal. A missing stamp is corruption.
 */
function parseRecord(nodeId: string, json: string): SwarmNodeRecord {
  const decoded = v.parse(JsonValueSchema, JSON.parse(json));
  const stamped = v.safeParse(RecordVersionSchema, decoded);

  if (stamped.success && stamped.output.v !== RECORD_SCHEMA_VERSION) {
    throw new KinuError('io',
      `the durable record for node ${nodeId} of this search carries schema version `
      + `${String(stamped.output.v)}, which this build does not know: it was written by a newer `
      + 'engine, and continuing would rank candidates against rows this build cannot read.');
  }

  return RECORD_READERS[RECORD_SCHEMA_VERSION](nodeId, decoded);
}

export function readSwarmNodeRecords(
  sql: SqlExecutor, actor: ActorHandle, rootId: string,
): readonly { readonly nodeId: string; readonly record: SwarmNodeRecord }[] {
  actor.assertCurrent();

  return sql<{ node_id: string; record_json: string }>`
    SELECT node_id, record_json
    FROM swarm_node_records
    WHERE actor_id = ${actor.actorId} AND root_id = ${rootId}
    ORDER BY node_id ASC`
    .map((row) => ({ nodeId: row.node_id, record: parseRecord(row.node_id, row.record_json) }));
}

/**
 * One node's turns as an inherit-child sees them, rebuilt from `head_steps`. Tool calls become text:
 * providers require tool-call parts to be answered by ids the journal does not keep. Empty steps
 * are dropped.
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

/** One candidate an unfinished search already measured. */
export interface HarvestedCandidate {
  readonly nodeId: string;
  readonly depth: number;
  /** `search_nodes.observation`. */
  readonly artifact: string;
  /** The [0,1] the tree ranks on, or null when the instrument produced no number. */
  readonly score: number | null;
  readonly outcome: SettledChildOutcome['kind'] | 'unrecorded';
  readonly breach: FloorBreach | null;
  readonly witnessFound: boolean | null;
}

/** Everything an unfinished search can hand its caller. */
export interface SwarmHarvest {
  readonly rootId: string;
  /** `epoch + 1`, the same arithmetic as the settle report's `attempt`. */
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
  /** Ranked on the normalised [0,1], so no direction is needed. */
  readonly best: HarvestedCandidate | null;
  /** Aggregate witness verdict when candidate records contain one. */
  readonly witnessFound: boolean | null;
}

/**
 * What an unfinished search already has, for a job that hit its bound (`jobs/runner.ts`): partial
 * candidates are results. Read-only; the caller settles the ledger row. Null when nothing runs.
 */
export function harvestSwarm(deps: {
  readonly sql: SqlExecutor;
  readonly ledger: MctsSearchStore;
  /** Whose harvest; tree and node records are actor-private. */
  readonly actor: ActorHandle;
}, task: string): SwarmHarvest | null {
  deps.actor.assertCurrent();
  const actorId = deps.actor.actorId;
  const [running] = deps.ledger.findRunningSwarms(task);

  if (!running) return null;

  const records = new Map<string, SwarmNodeRecord>();
  const unreadable = new Set<string>();

  for (const row of deps.sql<{ node_id: string; record_json: string }>`
    SELECT node_id, record_json FROM swarm_node_records
    WHERE actor_id = ${actorId} AND root_id = ${running.rootId}`) {
    // Skipped, unlike `parseRecord`: a harvest is final, so partial delivery beats none.
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
    WHERE actor_id = ${actorId} AND root_id = ${running.rootId} AND parent_id IS NOT NULL
    ORDER BY depth ASC, created_at ASC`) {
    const outcome = records.get(row.id)?.outcome ?? null;

    if (unreadable.has(row.id)) continue;
    const artifact = row.observation.trim();

    if (outcome?.kind === 'incomplete' || artifact.length === 0) continue;
    const { score, breach, witnessFound } = outcomeFacts(outcome);
    candidates.push({
      nodeId: row.id, depth: row.depth, artifact, score, outcome: outcome?.kind ?? 'unrecorded', breach, witnessFound,
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
        state: { kind: 'sealed', breach: firstBreach },
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
