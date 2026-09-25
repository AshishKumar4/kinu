/**
 * HeadJournal: the spawning actor's persistent view of head lifecycle, private to that actor.
 * Every statement carries the owner predicate: `findResumableRun` reclaims by task text, so two actors
 * splitting one task would otherwise reclaim each other's root. Tables: `initHeadsTables` (schema.ts).
 */

import * as v from 'valibot';
import type { SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import type {
  HeadId, HeadInput, HeadReport, HeadStep, Evidence,
  HeadFileChangeSet, MergeResult, MergeStrategy, HeadRunView, HeadRunHeadView,
} from './types';
import { EVIDENCE_KINDS } from './types';
import { DecisionSchema } from './merge-schema';
import { headProducedFindings } from './head-summary';
import { USAGE_FIELDS, type Usage } from '../usage';
import { HEAD_USAGE_COLUMNS, type StoredHeadUsage } from './schema';
import { mapPage, seekPage, StaleCursorError, type Page, type PageRequest } from '../session/page';
import type { ActiveRoster } from '../types/dynamic-context';


export interface StepTotals {
  readonly steps: number;
  readonly toolCalls: number;
}

const EvidenceKindSchema = v.picklist(EVIDENCE_KINDS);

const ToolCallSchema = v.object({
  toolCallId: v.optional(v.string()),
  name: v.string(),
  input: v.optional(v.unknown()),
  output: v.optional(v.unknown()),
});

const FileChangeSchema = v.object({
  path: v.string(),
  status: v.picklist(['added', 'removed', 'changed']),
  added: v.number(),
  removed: v.number(),
  binary: v.optional(v.boolean()),
});

const ArtifactRefSchema = v.object({
  kind: v.picklist(['file', 'port', 'memory', 'note']),
  ref: v.string(),
  description: v.optional(v.string()),
});

/** This module is the column's only writer, so any other shape is corruption and propagates, named. */
function parseArray<Item extends v.GenericSchema>(item: Item, json: string | null): v.InferOutput<Item>[] {
  if (json === null || json === '') return [];

  return v.parse(v.array(item), JSON.parse(json));
}

/** Rootless run status: running while any head is; completed once merged, else `partial`. */
function runStatusOf(heads: readonly HeadRunHeadView[], merged: boolean): string {
  if (heads.some((h) => h.status === 'running')) return 'running';

  if (merged) return 'completed';

  return heads.every((h) => h.status === 'completed') ? 'completed' : 'partial';
}

type StepRow = { text: string | null; reasoning: string | null; tool_calls_json: string | null };

/** A NULL `reasoning` reads back absent, not empty. */
function stepOf(row: StepRow): HeadStep {
  return {
    text: row.text ?? '',
    reasoning: row.reasoning ?? undefined,
    toolCalls: parseArray(ToolCallSchema, row.tool_calls_json),
  };
}

/** A NULL column becomes an absent field (never reported, not zero). Shared with `read-models/workspace-spend.ts` so there is one decoder. */
export function storedUsage(row: StoredHeadUsage): Usage {
  const usage: { -readonly [K in keyof Usage]: number } = {};

  for (const field of USAGE_FIELDS) {
    const stored = row[HEAD_USAGE_COLUMNS[field]];

    if (stored !== null) usage[field] = stored;
  }

  return usage;
}

/** `last_step_at` aggregates `head_steps`, the progress record; usage arrives whole as {@link StoredHeadUsage}. */
interface HeadViewRow extends StoredHeadUsage {
  id: string; parent_id: string | null; depth: number;
  task: string; rationale: string | null; status: string;
  summary: string | null; error_message: string | null; wall_clock_ms: number;
  spawned_at: number; last_step_at: number | null; decisions_json: string | null;
}

function headViewOf(row: HeadViewRow): HeadRunHeadView {
  return {
    id: row.id, parentId: row.parent_id, depth: row.depth,
    task: row.task, rationale: row.rationale ?? '', status: row.status,
    summary: row.summary, errorMessage: row.error_message,
    usage: storedUsage(row), wallClockMs: row.wall_clock_ms,
    spawnedAt: row.spawned_at, lastStepAt: row.last_step_at,
    decisions: parseArray(DecisionSchema, row.decisions_json)
      .map((d) => ({ question: d.question, choice: d.choice, rationale: d.rationale })),
  };
}

export interface HeadJournalRow extends StoredHeadUsage {
  id: HeadId;
  parent_id: HeadId | null;
  root_id: HeadId;
  depth: number;
  task: string;
  rationale: string | null;
  status: HeadReport['status'] | 'running';
  spawned_at: number;
  completed_at: number | null;
  wall_clock_ms: number;
  summary: string | null;
  error_message: string | null;
  merge_strategy: MergeStrategy;
}

export interface LiveHeadRun {
  readonly rootId: HeadId;
  /** Empty when never labelled. */
  readonly rationale: string;
  readonly running: number;
  readonly total: number;
}

/** Its own sentence, not `FORK_INTERRUPTED_REASON`: the synthesis went ahead without this head. */
export const UNREPORTED_AT_MERGE_REASON =
  'no report at the synthesis: the run merged what had arrived, and this head '
  + 'was still in flight when it did';

/** What {@link HeadJournal.abandonRunning} settled. */
export interface AbandonedHeadRun {
  readonly rootId: HeadId;
  /** Empty when never labelled. */
  readonly rationale: string;
  readonly abandoned: number;
  readonly total: number;
}

export class HeadJournal {
  protected readonly actorId: string;

  /** `actorId` is captured once; `assertCurrent()` runs before every statement. */
  constructor(protected readonly sql: SqlExecutor, protected readonly actor: ActorHandle) {
    this.actorId = actor.actorId;
  }

  /** The rationale is the run's header label. */
  recordSplit(rootId: HeadId, rationale: string, spawnedAt: number): void {
    this.actor.assertCurrent();
    void this.sql`INSERT INTO head_runs (actor_id, root_id, rationale, spawned_at)
      VALUES (${this.actorId}, ${rootId}, ${rationale}, ${spawnedAt})
      ON CONFLICT(actor_id, root_id) DO UPDATE SET rationale = excluded.rationale`;
  }

  /**
   * Open this branch's row, or re-open the one this id already has: the one reset transition, reached by
   * swarm re-entry (`strategy/swarm-resume.ts`) and fork re-drive (`heads/controller.ts`). A re-open clears
   * every outcome field (usage especially) and the branch's steps, and moves `spawned_at` to now so
   * `spawnedBefore`-bounded sweeps skip it. A first attempt never reaches the conflict arm.
   */
  insertSpawn(input: HeadInput): void {
    this.actor.assertCurrent();
    void this.sql`INSERT INTO head_journal
      (actor_id, id, parent_id, root_id, depth, task, rationale, status, spawned_at, merge_strategy)
      VALUES (${this.actorId}, ${input.id}, ${input.parentId}, ${input.rootId}, ${input.depth},
              ${input.task}, ${input.rationale}, 'running', ${input.budget.spawnedAt},
              ${input.mergeStrategy})
      ON CONFLICT(actor_id, id) DO UPDATE SET
        status = 'running',
        spawned_at = excluded.spawned_at,
        task = excluded.task,
        rationale = excluded.rationale,
        completed_at = NULL,
        wall_clock_ms = 0,
        summary = NULL,
        error_message = NULL,
        decisions_json = NULL,
        artifacts_json = NULL,
        tool_calls_json = NULL,
        child_head_ids_json = NULL,
        file_changes_json = NULL,
        token_input = NULL,
        token_output = NULL,
        token_cache_read = NULL,
        token_cache_write = NULL,
        token_cache_write_1h = NULL,
        token_reasoning = NULL,
        neurons = NULL`;
    void this.sql`DELETE FROM head_steps WHERE actor_id = ${this.actorId} AND head_id = ${input.id}`;
  }

  recordReport(report: HeadReport): void {
    this.actor.assertCurrent();
    void this.sql`UPDATE head_journal SET
      status = ${report.status},
      completed_at = ${Date.now()},
      token_input = ${report.usage.input ?? null},
      token_output = ${report.usage.output ?? null},
      token_cache_read = ${report.usage.cacheRead ?? null},
      token_cache_write = ${report.usage.cacheWrite ?? null},
      token_cache_write_1h = ${report.usage.cacheWrite1h ?? null},
      token_reasoning = ${report.usage.reasoning ?? null},
      neurons = ${report.usage.neurons ?? null},
      wall_clock_ms = ${report.wallClockMs},
      summary = ${report.summary},
      error_message = ${report.errorMessage ?? null},
      decisions_json = ${JSON.stringify(report.decisions)},
      artifacts_json = ${JSON.stringify(report.artifactRefs)},
      tool_calls_json = ${JSON.stringify(report.toolCalls)},
      child_head_ids_json = ${JSON.stringify(report.childHeadIds)},
      file_changes_json = ${JSON.stringify(report.fileChanges ?? [])}
      WHERE actor_id = ${this.actorId} AND id = ${report.id}`;

    for (const ev of report.evidence) {
      this.insertEvidence(report.id, ev);
    }
  }

  /**
   * First, non-terminal half of cold-activation reconciliation: stale `running` rows become `interrupted`, so
   * the roster stops claiming live work while the run stays re-enterable. Bounded by `spawnedBefore`.
   * Returns only runs this call touched; the gate is offered {@link unfinishedRoots}.
   */
  markInterrupted(
    scope?: { readonly spawnedBefore?: number },
    now = Date.now(),
  ): AbandonedHeadRun[] {
    this.actor.assertCurrent();
    const before = scope?.spawnedBefore ?? null;
    const runs = this.unfinishedRuns(null, null, before);

    if (runs.length === 0) return [];
    // No `error_message`: nothing has failed; the column is the retirement's.
    void this.sql`UPDATE head_journal
      SET status = 'interrupted', completed_at = ${now}
      WHERE actor_id = ${this.actorId} AND status = 'running'
        AND (${before} IS NULL OR spawned_at < ${before})`;

    return runs;
  }

  /** The resume gate's offered set: the same population {@link abandonRunning} sweeps, not {@link markInterrupted}'s return. */
  unfinishedRoots(spawnedBefore: number): HeadId[] {
    this.actor.assertCurrent();

    return this.unfinishedRuns('interrupted', null, spawnedBefore).map((run) => run.rootId);
  }

  /**
   * Settle unfinished (`running` or `interrupted`) heads as `aborted`; the last terminal writer of
   * `head_journal.status`. `rootId` scopes to one run, `exceptRoots` spares gate-claimed runs, and
   * `spawnedBefore` protects fresh heads. Returns the settled runs so the caller can tell the agent.
   */
  abandonRunning(
    reason: string,
    scope?: {
      readonly rootId?: HeadId;
      readonly spawnedBefore?: number;
      readonly exceptRoots?: readonly HeadId[];
    },
    now = Date.now(),
  ): AbandonedHeadRun[] {
    this.actor.assertCurrent();
    const root = scope?.rootId ?? null;
    const before = scope?.spawnedBefore ?? null;
    const spared = new Set(scope?.exceptRoots ?? []);

    // Filtered here: this executor binds one value per interpolation, so a set cannot cross into SQL.
    const runs = this.unfinishedRuns('interrupted', root, before)
      .filter((run) => !spared.has(run.rootId));

    // One write per run over the runs just read, so reported rows are exactly the written rows.
    for (const run of runs) {
      void this.sql`UPDATE head_journal
        SET status = 'aborted', completed_at = ${now}, error_message = ${reason}
        WHERE actor_id = ${this.actorId} AND root_id = ${run.rootId}
          AND (status = 'running' OR status = 'interrupted')
          AND (${before} IS NULL OR spawned_at < ${before})`;
    }

    return runs;
  }

  /** One query for both transitions, so the reported and written scopes cannot disagree. A null `alsoState` admits nothing. */
  private unfinishedRuns(
    alsoState: string | null,
    root: HeadId | null,
    before: number | null,
  ): AbandonedHeadRun[] {
    return this.sql<{ root_id: string; rationale: string | null; abandoned: number; total: number }>`
      SELECT j.root_id AS root_id,
             MAX(r.rationale) AS rationale,
             SUM(CASE WHEN (j.status = 'running' OR j.status = ${alsoState})
                       AND (${before} IS NULL OR j.spawned_at < ${before})
                      THEN 1 ELSE 0 END) AS abandoned,
             COUNT(*) AS total
      FROM head_journal j LEFT JOIN head_runs r
        ON r.actor_id = j.actor_id AND r.root_id = j.root_id
      WHERE j.actor_id = ${this.actorId} AND (${root} IS NULL OR j.root_id = ${root})
      GROUP BY j.root_id HAVING abandoned > 0
      ORDER BY MIN(j.spawned_at) DESC`
      .map((row) => ({
        rootId: row.root_id,
        rationale: row.rationale ?? '',
        abandoned: row.abandoned,
        total: row.total,
      }));
  }

  /**
   * The unfinished run for this task, so one request stays one run across re-drives. Keyed like MCTS: the
   * task plus no `head_merge_results` row; independent of head status, which `abandonRunning` may already
   * have settled. The owner predicate is what makes the task key safe.
   */
  findResumableRun(task: string): HeadId | null {
    this.actor.assertCurrent();

    const rows = this.sql<{ root_id: string }>`
      SELECT r.root_id AS root_id
      FROM head_runs r
      LEFT JOIN head_merge_results m ON m.actor_id = r.actor_id AND m.root_id = r.root_id
      WHERE r.actor_id = ${this.actorId} AND r.rationale = ${task} AND m.root_id IS NULL
      ORDER BY r.spawned_at DESC LIMIT 1`;

    return rows[0]?.root_id ?? null;
  }

  /** The only writer of `head_steps`, keyed `${headId}-s${seq}` with INSERT OR REPLACE. `created_at` is liveness: never rewrite it in bulk. */
  appendStep(headId: HeadId, seq: number, step: HeadStep): void {
    this.actor.assertCurrent();
    void this.sql`INSERT OR REPLACE INTO head_steps
      (actor_id, id, head_id, seq, text, reasoning, tool_calls_json, created_at)
      VALUES (${this.actorId}, ${`${headId}-s${seq}`}, ${headId}, ${seq}, ${step.text}, ${step.reasoning ?? null},
              ${JSON.stringify(step.toolCalls)}, ${Date.now()})`;
  }

  readSteps(headId: HeadId): HeadStep[] {
    this.actor.assertCurrent();

    return this.sql<StepRow>`
      SELECT text, reasoning, tool_calls_json FROM head_steps
      WHERE actor_id = ${this.actorId} AND head_id = ${headId} ORDER BY seq`.map(stepOf);
  }

  static readonly STEP_PAGE = { limit: 60, max: 200 } as const;

  /** Newest page first, each page oldest-first; the cursor is minted on the raw row the query stopped at. */
  readStepsPage(headId: HeadId, request: PageRequest = {}): Page<HeadStep> {
    this.actor.assertCurrent();
    const limit = Math.max(1, Math.min(HeadJournal.STEP_PAGE.max, Math.floor(request.limit ?? HeadJournal.STEP_PAGE.limit)));
    const over = limit + 1;
    const after = request.cursor?.after ?? null;
    const from = after === null ? null : this.stepAnchor(headId, after);

    type Row = StepRow & { id: string };

    return mapPage(seekPage(from === null
      ? this.sql<Row>`
        SELECT id, text, reasoning, tool_calls_json FROM head_steps
        WHERE actor_id = ${this.actorId} AND head_id = ${headId} ORDER BY seq DESC LIMIT ${over}`
      : this.sql<Row>`
        SELECT id, text, reasoning, tool_calls_json FROM head_steps
        WHERE actor_id = ${this.actorId} AND head_id = ${headId} AND seq < ${from} ORDER BY seq DESC LIMIT ${over}`,
      limit, (row) => row.id), (rows) => rows.slice().reverse().map(stepOf));
  }

  countSteps(headId: HeadId): StepTotals {
    this.actor.assertCurrent();

    const row = this.sql<StepTotals & { tools: number | null }>`
      SELECT COUNT(*) AS steps, SUM(json_array_length(tool_calls_json)) AS tools
      FROM head_steps WHERE actor_id = ${this.actorId} AND head_id = ${headId}`[0];

    return { steps: row?.steps ?? 0, toolCalls: row?.tools ?? 0 };
  }

  /** StaleCursorError when the anchor names nothing, including another actor's trace. */
  private stepAnchor(headId: HeadId, after: string): number {
    const row = this.sql<{ seq: number }>`
      SELECT seq FROM head_steps
      WHERE actor_id = ${this.actorId} AND id = ${after} AND head_id = ${headId}`[0];

    if (row === undefined) throw new StaleCursorError('trace', after);

    return row.seq;
  }

  insertEvidence(headId: HeadId, ev: Evidence): void {
    this.actor.assertCurrent();
    void this.sql`INSERT OR REPLACE INTO head_evidence
      (actor_id, id, head_id, kind, body, ref, confidence, created_at)
      VALUES (${this.actorId}, ${ev.id}, ${headId}, ${ev.kind}, ${ev.body},
              ${ev.ref ?? null}, ${ev.confidence ?? null}, ${Date.now()})`;
  }

  readHead(id: HeadId): HeadJournalRow | null {
    this.actor.assertCurrent();

    const rows = this.sql<HeadJournalRow>`
      SELECT id, parent_id, root_id, depth, task, rationale, status,
             spawned_at, completed_at, token_input, token_output,
             token_cache_read, token_cache_write, token_cache_write_1h,
             token_reasoning, neurons,
             wall_clock_ms, summary, error_message, merge_strategy
      FROM head_journal WHERE actor_id = ${this.actorId} AND id = ${id}`;

    return rows[0] ?? null;
  }

  readTree(rootId: HeadId): HeadJournalRow[] {
    this.actor.assertCurrent();

    return this.sql<HeadJournalRow>`
      SELECT id, parent_id, root_id, depth, task, rationale, status,
             spawned_at, completed_at, token_input, token_output,
             token_cache_read, token_cache_write, token_cache_write_1h,
             token_reasoning, neurons,
             wall_clock_ms, summary, error_message, merge_strategy
      FROM head_journal WHERE actor_id = ${this.actorId} AND root_id = ${rootId}
      ORDER BY depth, spawned_at`;
  }

  readEvidence(headId: HeadId): Evidence[] {
    this.actor.assertCurrent();

    type Row = { id: string; kind: string; body: string; ref: string | null; confidence: number | null };

    const rows = this.sql<Row>`
      SELECT id, kind, body, ref, confidence
      FROM head_evidence WHERE actor_id = ${this.actorId} AND head_id = ${headId}`;

    return rows.map((r) => ({
      id: r.id,
      kind: v.parse(EvidenceKindSchema, r.kind),
      body: r.body,
      ref: r.ref ?? undefined,
      confidence: r.confidence ?? undefined,
    }));
  }

  /**
   * The settlement: a cached merge closes the run, so every unfinished head is settled `aborted` in the same
   * transition, before the merge row exists. Idempotent in both halves.
   */
  cacheMerge(rootId: HeadId, result: MergeResult, strategy: MergeStrategy): void {
    this.actor.assertCurrent();
    void this.sql`UPDATE head_journal
      SET status = 'aborted', completed_at = ${Date.now()},
          error_message = ${UNREPORTED_AT_MERGE_REASON}
      WHERE actor_id = ${this.actorId}
        AND root_id = ${rootId}
        AND id != ${rootId}
        AND (status = 'running' OR status = 'interrupted')`;
    void this.sql`INSERT OR REPLACE INTO head_merge_results
      (actor_id, root_id, merged_narrative, selected_decisions_json, unresolved_questions_json,
       recommendations_json, blind_spots_json, cost_head_count, cost_total_tokens,
       cost_total_wall_ms, cost_max_depth, merged_at, merge_strategy)
      VALUES (${this.actorId}, ${rootId}, ${result.mergedNarrative},
              ${JSON.stringify(result.selectedDecisions)},
              ${JSON.stringify(result.unresolvedQuestions)},
              ${JSON.stringify(result.recommendations)},
              ${JSON.stringify(result.blindSpots)},
              ${result.costSummary.headCount},
              ${result.costSummary.totalTokens ?? null},
              ${result.costSummary.totalWallClockMs},
              ${result.costSummary.maxDepth},
              ${Date.now()}, ${strategy})`;
  }

  /** Read on every model step, so the `root_id IN (running)` subquery bounds the aggregate to open roots via `idx_head_journal_status` instead of scanning all history. */
  listLive(limit = 8): ActiveRoster<LiveHeadRun> {
    this.actor.assertCurrent();

    const total = this.sql<{ n: number }>`
      SELECT COUNT(DISTINCT root_id) AS n FROM head_journal
      WHERE actor_id = ${this.actorId} AND status = 'running'`[0]?.n ?? 0;

    const items = this.sql<{ root_id: string; rationale: string | null; running: number; total: number; spawned_at: number }>`
      SELECT j.root_id AS root_id,
             MAX(r.rationale) AS rationale,
             SUM(CASE WHEN j.status = 'running' THEN 1 ELSE 0 END) AS running,
             COUNT(*) AS total,
             MIN(j.spawned_at) AS spawned_at
      FROM head_journal j LEFT JOIN head_runs r
        ON r.actor_id = j.actor_id AND r.root_id = j.root_id
      WHERE j.actor_id = ${this.actorId}
        AND j.root_id IN (SELECT root_id FROM head_journal
                          WHERE actor_id = ${this.actorId} AND status = 'running')
      GROUP BY j.root_id
      ORDER BY spawned_at DESC LIMIT ${limit}`
      .map((row) => ({
        rootId: row.root_id,
        rationale: row.rationale ?? '',
        running: row.running,
        total: row.total,
      }));

    return { items, total };
  }

  /** An authority/recovery read, not a UI page: it must not be windowed. */
  listRunningRuns(): HeadRunView[] {
    this.actor.assertCurrent();

    const roots = this.sql<{ root_id: string; spawned_at: number }>`
      SELECT root_id, MIN(spawned_at) AS spawned_at
      FROM head_journal
      WHERE actor_id = ${this.actorId} AND status = 'running'
      GROUP BY root_id
      ORDER BY spawned_at ASC`;

    return roots.map((row) => this.assembleRun(row.root_id, row.spawned_at));
  }

  /** `interrupted` counts: claimed and gate-failed roots are left interrupted on purpose. */
  hasUnfinishedHeads(): boolean {
    this.actor.assertCurrent();

    return this.sql<{ present: number }>`
      SELECT 1 AS present FROM head_journal
      WHERE actor_id = ${this.actorId}
        AND (status = 'running' OR status = 'interrupted') LIMIT 1`.length > 0;
  }

  /** The activation sweep's read, run in the init gate. Sealing moves a row off `running`, so the mutation is the cursor. */
  listRunningBranchHeads(
    prefix: string, limit: number, spawnedBefore: number,
  ): { id: HeadId; rootId: HeadId; task: string }[] {
    this.actor.assertCurrent();

    return this.sql<{ id: string; root_id: string; task: string }>`
      SELECT id, root_id, task FROM head_journal
      WHERE actor_id = ${this.actorId} AND status = 'running' AND root_id LIKE ${`${prefix}%`}
        AND spawned_at < ${spawnedBefore}
      ORDER BY spawned_at ASC LIMIT ${limit}`
      .map((row) => ({ id: row.id, rootId: row.root_id, task: row.task }));
  }

  /** Grouped by root_id from head_journal, so a top-level split collapses into one run. */
  listRuns(limit: number): HeadRunView[] {
    this.actor.assertCurrent();

    const roots = this.sql<{ root_id: string; spawned_at: number }>`
      SELECT root_id, MIN(spawned_at) AS spawned_at FROM head_journal
      WHERE actor_id = ${this.actorId}
      GROUP BY root_id ORDER BY spawned_at DESC LIMIT ${limit}`;

    return roots.map((r) => this.assembleRun(r.root_id, r.spawned_at));
  }

  /** Null for a root this actor never ran, including one a sibling owns. */
  readRun(rootId: HeadId): HeadRunView | null {
    this.actor.assertCurrent();

    const row = this.sql<{ spawned_at: number | null }>`
      SELECT MIN(spawned_at) AS spawned_at
      FROM head_journal WHERE actor_id = ${this.actorId} AND root_id = ${rootId}`[0];

    return row?.spawned_at == null ? null : this.assembleRun(rootId, row.spawned_at);
  }

  /** Same projection as {@link listRuns} via {@link headViewOf}. Every usage column must be named: an unselected one reads back as never reported. */
  readHeadView(headId: HeadId): HeadRunHeadView | null {
    this.actor.assertCurrent();

    const row = this.sql<HeadViewRow>`
      SELECT j.id, j.parent_id, j.depth, j.task, j.rationale, j.status, j.summary, j.error_message,
             j.token_input, j.token_output, j.token_cache_read, j.token_cache_write,
             j.token_cache_write_1h, j.token_reasoning, j.neurons,
             j.wall_clock_ms, j.spawned_at,
             j.decisions_json, MAX(s.created_at) AS last_step_at
      FROM head_journal j LEFT JOIN head_steps s ON s.actor_id = j.actor_id AND s.head_id = j.id
      WHERE j.actor_id = ${this.actorId} AND j.id = ${headId}
      GROUP BY j.id`[0];

    return row ? headViewOf(row) : null;
  }

  private assembleRun(rootId: HeadId, spawnedAt: number): HeadRunView {
    const rows = this.sql<HeadViewRow>`
      SELECT j.id, j.parent_id, j.depth, j.task, j.rationale, j.status, j.summary, j.error_message,
             j.token_input, j.token_output, j.token_cache_read, j.token_cache_write,
             j.token_cache_write_1h, j.token_reasoning, j.neurons,
             j.wall_clock_ms, j.spawned_at,
             j.decisions_json, MAX(s.created_at) AS last_step_at
      FROM head_journal j LEFT JOIN head_steps s ON s.actor_id = j.actor_id AND s.head_id = j.id
      WHERE j.actor_id = ${this.actorId} AND j.root_id = ${rootId}
      GROUP BY j.id ORDER BY j.depth, j.spawned_at`;

    // A sub-split's parent head is the run header; for a synthetic root nothing matches.
    const rootRow = rows.find((h) => h.id === rootId) ?? null;

    const heads: HeadRunHeadView[] = rows
      .filter((h) => h.id !== rootId)
      .map((h) => headViewOf(h));

    const runRow = this.sql<{ rationale: string | null }>`
      SELECT rationale FROM head_runs WHERE actor_id = ${this.actorId} AND root_id = ${rootId}`[0];

    const rationale = runRow?.rationale ?? rootRow?.rationale ?? '';

    // An empty task is labelled by the rationale, then the first head's task.
    const named = [rootRow?.task, rationale, heads.at(0)?.task].find((candidate) => candidate !== undefined && candidate !== '');
    const task = named ?? '(head run)';

    const mergeRow = this.sql<{ merged_narrative: string; cost_head_count: number; cost_total_tokens: number | null }>`
      SELECT merged_narrative, cost_head_count, cost_total_tokens
      FROM head_merge_results WHERE actor_id = ${this.actorId} AND root_id = ${rootId}`[0];

    const merge = mergeRow
      ? { narrative: mergeRow.merged_narrative, headCount: mergeRow.cost_head_count, totalTokens: mergeRow.cost_total_tokens }
      : null;

    const status = rootRow?.status ?? runStatusOf(heads, merge !== null);

    return { rootId, task, rationale, status, spawnedAt, heads, merge };
  }

  /** Rebuilt from the journal, not cached, so a replay cannot disagree with the live run. */
  readFileChanges(rootId: HeadId): HeadFileChangeSet[] {
    this.actor.assertCurrent();

    return this.sql<{ id: string; file_changes_json: string | null }>`
      SELECT id, file_changes_json FROM head_journal
      WHERE actor_id = ${this.actorId} AND root_id = ${rootId} ORDER BY depth, spawned_at`
      .map((r) => ({ id: r.id, changes: parseArray(FileChangeSchema, r.file_changes_json) }))
      .filter((set) => set.changes.length > 0);
  }

  readCachedMerge(rootId: HeadId): MergeResult | null {
    this.actor.assertCurrent();

    type Row = {
      merged_narrative: string;
      selected_decisions_json: string | null;
      unresolved_questions_json: string | null;
      recommendations_json: string | null;
      blind_spots_json: string | null;
      cost_head_count: number;
      cost_total_tokens: number | null;
      cost_total_wall_ms: number;
      cost_max_depth: number;
    };

    const rows = this.sql<Row>`
      SELECT merged_narrative, selected_decisions_json, unresolved_questions_json,
             recommendations_json, blind_spots_json, cost_head_count, cost_total_tokens,
             cost_total_wall_ms, cost_max_depth
      FROM head_merge_results WHERE actor_id = ${this.actorId} AND root_id = ${rootId}`;

    const r = rows[0];

    if (!r) return null;
    const tree = this.readTree(rootId);
    const evidence: Evidence[] = tree.flatMap((h) => this.readEvidence(h.id));
    const headIds: HeadId[] = tree.filter((h) => h.parent_id == null || h.parent_id === '').map((h) => h.id);
    const ids = headIds.length > 0 ? headIds : tree.map((h) => h.id);

    return {
      mergedNarrative: r.merged_narrative,
      selectedDecisions: parseArray(DecisionSchema, r.selected_decisions_json),
      unresolvedQuestions: parseArray(v.string(), r.unresolved_questions_json),
      recommendations: parseArray(v.string(), r.recommendations_json),
      blindSpots: parseArray(v.string(), r.blind_spots_json),
      evidenceAggregate: evidence,
      headIds: ids,
      // Grounded scores are live-only; the cached read carries none.
      headScores: [],
      fileChanges: this.readFileChanges(rootId),
      grounded: false,
      costSummary: {
        headCount: r.cost_head_count,
        headsWithFindings: this.countHeadsWithFindings(ids),
        // NULL back to an absent field, as the live merge reported it.
        totalTokens: r.cost_total_tokens ?? undefined,
        totalWallClockMs: r.cost_total_wall_ms,
        maxDepth: r.cost_max_depth,
      },
    };
  }

  /** Derived through the same predicate as the merge path, not stored. */
  private countHeadsWithFindings(headIds: readonly HeadId[]): number {
    return headIds.filter((id) => {
      const row = this.sql<{ status: string; decisions_json: string | null; artifacts_json: string | null }>`
        SELECT status, decisions_json, artifacts_json FROM head_journal
        WHERE actor_id = ${this.actorId} AND id = ${id}`[0];

      if (!row) return false;

      return headProducedFindings({
        status: row.status === 'completed' ? 'completed' : 'aborted',
        evidence: this.readEvidence(id),
        decisions: parseArray(DecisionSchema, row.decisions_json),
        artifactRefs: parseArray(ArtifactRefSchema, row.artifacts_json),
      });
    }).length;
  }
}
