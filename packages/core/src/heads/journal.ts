/**
 * HeadJournal — persistent journal of all head activity, owned by the orchestrator.
 *
 * Lives on the orchestrator's SQLite. Heads themselves run as Facets with
 * their own ephemeral storage; the journal is the orchestrator's *view* of
 * head lifecycle — used by the UI, telemetry, and merge gathering.
 *
 * Tables initialized by `initHeadsTables` (schema.ts):
 *   head_journal        — spawn + status + final report metadata per head
 *   head_evidence       — pieces of evidence each head considered
 *   head_merge_results  — cached merge synthesis per root_id
 */

import * as v from 'valibot';
import type { SqlExecutor } from '../types/primitives';
import type {
  HeadId, HeadInput, HeadReport, HeadStep, HeadStepToolCall, Evidence, Decision, ArtifactRef,
  HeadFileChange, HeadFileChangeSet, MergeResult, MergeStrategy, HeadRunView, HeadRunHeadView,
} from './types';
import { headProducedFindings } from './head-summary';
import { USAGE_FIELDS, type Usage } from '../usage';
import { HEAD_USAGE_COLUMNS, type StoredHeadUsage } from './schema';

const EvidenceKindSchema = v.picklist(['tool_output', 'fact', 'citation', 'artifact']);

/** JSON array column → array (head_journal/head_steps). This module is what
 *  writes those columns, so a malformed or non-array blob is corruption: it
 *  propagates rather than reading back as "this head recorded nothing". */
function parseArray<T>(json: string | null): T[] {
  if (!json) return [];
  const parsed = JSON.parse(json);
  if (!Array.isArray(parsed)) {
    throw new Error(`head journal JSON column is not an array: ${json.slice(0, 120)}`);
  }
  return parsed;
}

/**
 * The stored usage columns as a {@link Usage}.
 *
 * A NULL column becomes an ABSENT field, which is the whole point of the
 * columns having no default: it keeps "this head's provider never reported"
 * distinguishable from "this head reported zero" all the way out to the
 * surface, where the difference is a head that may have cost real money versus
 * one that demonstrably cost nothing.
 *
 * Exported for `read-models/workspace-spend.ts`, which reads the same row for
 * the workspace total. Two decoders over one storage shape is how a head's
 * cache reads end up counted on one surface and dropped on the other.
 */
export function storedUsage(row: StoredHeadUsage): Usage {
  const usage: { -readonly [K in keyof Usage]: number } = {};
  for (const field of USAGE_FIELDS) {
    const stored = row[HEAD_USAGE_COLUMNS[field]];
    if (stored !== null) usage[field] = stored;
  }
  return usage;
}

/**
 * The columns behind a {@link HeadRunHeadView}, and the fold from them.
 *
 * `last_step_at` is an aggregate over `head_steps` rather than a column on the
 * head row: the steps ARE the progress record, so a second field could only ever
 * disagree with them.
 *
 * Usage arrives as {@link StoredHeadUsage}, not as two token columns: {@link
 * storedUsage} folds every usage column the journal stores, and naming a subset
 * here is how a cache-read or reasoning figure gets dropped on the way to a
 * surface while every type still checks.
 */
interface HeadViewRow extends StoredHeadUsage {
  id: string; task: string; rationale: string | null; status: string;
  summary: string | null; error_message: string | null; wall_clock_ms: number;
  spawned_at: number; last_step_at: number | null; decisions_json: string | null;
}

function headViewOf(row: HeadViewRow, steps: HeadStep[]): HeadRunHeadView {
  return {
    id: row.id, task: row.task, rationale: row.rationale ?? '', status: row.status,
    summary: row.summary, errorMessage: row.error_message,
    usage: storedUsage(row), wallClockMs: row.wall_clock_ms,
    spawnedAt: row.spawned_at, lastStepAt: row.last_step_at,
    decisions: parseArray<{ question?: unknown; choice?: unknown; rationale?: unknown }>(row.decisions_json)
      .map((d) => ({
        question: String(d?.question ?? ''),
        choice: String(d?.choice ?? ''),
        rationale: String(d?.rationale ?? ''),
      })),
    steps,
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

/** One still-open head run, as the live fork roster needs it. */
export interface LiveHeadRun {
  readonly rootId: HeadId;
  /** The split's "why", as recorded by recordSplit. Empty when never labelled. */
  readonly rationale: string;
  readonly running: number;
  readonly total: number;
}

/** One run whose heads were still marked `running` when nothing was left to
 *  run them — what {@link HeadJournal.abandonRunning} settled. */
export interface AbandonedHeadRun {
  readonly rootId: HeadId;
  /** The split's "why", as recorded by recordSplit. Empty when never labelled. */
  readonly rationale: string;
  /** Heads this settled — the ones the roster had been counting as running. */
  readonly abandoned: number;
  readonly total: number;
}

export class HeadJournal {
  constructor(private readonly sql: SqlExecutor) {}

  /** Record the run identity for a split so its heads group under one root —
   *  the rationale is the "why split", shown as the run's header label. */
  recordSplit(rootId: HeadId, rationale: string, spawnedAt: number): void {
    void this.sql`INSERT INTO head_runs (root_id, rationale, spawned_at)
      VALUES (${rootId}, ${rationale}, ${spawnedAt})
      ON CONFLICT(root_id) DO UPDATE SET rationale = excluded.rationale`;
  }

  insertSpawn(input: HeadInput): void {
    void this.sql`INSERT INTO head_journal
      (id, parent_id, root_id, depth, task, rationale, status, spawned_at, merge_strategy)
      VALUES (${input.id}, ${input.parentId}, ${input.rootId}, ${input.depth},
              ${input.task}, ${input.rationale}, 'running', ${input.budget.spawnedAt},
              ${input.mergeStrategy})`;
  }

  recordReport(report: HeadReport): void {
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
      WHERE id = ${report.id}`;
    for (const ev of report.evidence) {
      this.insertEvidence(report.id, ev);
    }
  }

  /**
   * Settle heads still marked `running` as `aborted` — the second and last
   * terminal writer of `head_journal.status`, and the reconciliation both
   * backends run once at start of life.
   *
   * `running` means "spawned, and no report recorded". Nothing keeps a head
   * alive across a process exit or a DO eviction, and an operator cancel
   * settles the fork's background job without the controller ever reaching
   * {@link recordReport} — so at the start of an activation that predicate is
   * false for every row still carrying it, whatever became of the executor.
   * Left alone the row is PERMANENT, and its root then satisfies
   * {@link listLive}'s running-head predicate forever, asserting the fork is in
   * flight into every model step for the life of the workspace. That is what it
   * did: `background_jobs` read `cancelled by operator` while the
   * dynamic-context block kept rendering "4 of 4 heads running".
   *
   * `scope` narrows it to one run, for the re-drive that reclaims that run's
   * identity: same transition, same `error_message` column, so a reclaim does
   * not get a second writer of the status this bug was caused by having only
   * one of. Omitted, it sweeps the whole journal.
   *
   * Returns the runs it settled so the caller can tell the agent — a fork
   * disappearing from the roster is not the same as the agent learning it is
   * gone. Empty on a clean start, which is the common case.
   */
  abandonRunning(
    reason: string,
    scope?: { readonly rootId: HeadId },
    now = Date.now(),
  ): AbandonedHeadRun[] {
    const root = scope?.rootId ?? null;
    const runs = this.sql<{ root_id: string; rationale: string | null; abandoned: number; total: number }>`
      SELECT j.root_id AS root_id,
             MAX(r.rationale) AS rationale,
             SUM(CASE WHEN j.status = 'running' THEN 1 ELSE 0 END) AS abandoned,
             COUNT(*) AS total
      FROM head_journal j LEFT JOIN head_runs r ON r.root_id = j.root_id
      WHERE ${root} IS NULL OR j.root_id = ${root}
      GROUP BY j.root_id HAVING abandoned > 0
      ORDER BY MIN(j.spawned_at) DESC`;
    if (runs.length === 0) return [];
    void this.sql`UPDATE head_journal
      SET status = 'aborted', completed_at = ${now}, error_message = ${reason}
      WHERE status = 'running' AND (${root} IS NULL OR root_id = ${root})`;
    return runs.map((row) => ({
      rootId: row.root_id,
      rationale: row.rationale ?? '',
      abandoned: row.abandoned,
      total: row.total,
    }));
  }

  /**
   * The unfinished run for this task, or null — the reclaim that keeps ONE
   * request from becoming N runs.
   *
   * A fork's background job is re-driven on eviction/exit recovery
   * (jobs/runner.ts), and re-driving a settle=merge fork means re-running its
   * heads: they are ephemeral facets with no durable checkpoint, so there is
   * nothing else a resume can do. MCTS survived that because its re-entry
   * reclaims the same search by task (MctsSearchStore.findResumable), so its
   * tree keeps ONE root_id across any number of re-drives. Heads had no such
   * reclaim, so every re-drive minted a fresh nanoid root — one request
   * appearing as four near-identical `merged · N branches` runs, each having
   * really spawned and paid for its own N heads.
   *
   * Keyed the same way MCTS keys it: the task, plus not-yet-settled. `head_runs`
   * has no status of its own, and a cached merge IS the settlement, so a run
   * with no `head_merge_results` row is one that never reached an answer.
   * Deliberately independent of `head_journal.status`: {@link abandonRunning}
   * retires stale head rows at start of life, BEFORE any resume runs, so a
   * head-status predicate would find nothing exactly when it is needed.
   */
  findResumableRun(task: string): HeadId | null {
    const rows = this.sql<{ root_id: string }>`
      SELECT r.root_id AS root_id
      FROM head_runs r
      LEFT JOIN head_merge_results m ON m.root_id = r.root_id
      WHERE r.rationale = ${task} AND m.root_id IS NULL
      ORDER BY r.spawned_at DESC LIMIT 1`;
    return rows[0]?.root_id ?? null;
  }

  /**
   * Record one finished step of a head that is still running.
   *
   * The ONLY writer of `head_steps`. A head calls this as each step lands, so
   * `assembleRun` serves a branch's trace mid-flight instead of the empty pane
   * a running fork used to show. Keyed `${headId}-s${seq}` and written with
   * INSERT OR REPLACE so a retried step overwrites rather than duplicates.
   *
   * `created_at` is this step's own arrival time and is what liveness is read
   * from — do not rewrite it in bulk later.
   */
  appendStep(headId: HeadId, seq: number, step: HeadStep): void {
    void this.sql`INSERT OR REPLACE INTO head_steps
      (id, head_id, seq, text, reasoning, tool_calls_json, created_at)
      VALUES (${`${headId}-s${seq}`}, ${headId}, ${seq}, ${step.text}, ${step.reasoning ?? null},
              ${JSON.stringify(step.toolCalls)}, ${Date.now()})`;
  }

  readSteps(headId: HeadId): HeadStep[] {
    type Row = { text: string | null; reasoning: string | null; tool_calls_json: string | null };
    return this.sql<Row>`
      SELECT text, reasoning, tool_calls_json FROM head_steps
      WHERE head_id = ${headId} ORDER BY seq`.map((r) => ({
        text: r.text ?? '',
        reasoning: r.reasoning ?? undefined,
        toolCalls: parseArray<HeadStepToolCall>(r.tool_calls_json),
      }));
  }

  insertEvidence(headId: HeadId, ev: Evidence): void {
    void this.sql`INSERT OR REPLACE INTO head_evidence
      (id, head_id, kind, body, ref, confidence, created_at)
      VALUES (${ev.id}, ${headId}, ${ev.kind}, ${ev.body},
              ${ev.ref ?? null}, ${ev.confidence ?? null}, ${Date.now()})`;
  }

  readHead(id: HeadId): HeadJournalRow | null {
    const rows = this.sql<HeadJournalRow>`
      SELECT id, parent_id, root_id, depth, task, rationale, status,
             spawned_at, completed_at, token_input, token_output,
             token_cache_read, token_cache_write, token_cache_write_1h,
             token_reasoning, neurons,
             wall_clock_ms, summary, error_message, merge_strategy
      FROM head_journal WHERE id = ${id}`;
    return rows[0] ?? null;
  }

  readTree(rootId: HeadId): HeadJournalRow[] {
    return this.sql<HeadJournalRow>`
      SELECT id, parent_id, root_id, depth, task, rationale, status,
             spawned_at, completed_at, token_input, token_output,
             token_cache_read, token_cache_write, token_cache_write_1h,
             token_reasoning, neurons,
             wall_clock_ms, summary, error_message, merge_strategy
      FROM head_journal WHERE root_id = ${rootId}
      ORDER BY depth, spawned_at`;
  }

  readEvidence(headId: HeadId): Evidence[] {
    type Row = { id: string; kind: string; body: string; ref: string | null; confidence: number | null };
    const rows = this.sql<Row>`
      SELECT id, kind, body, ref, confidence
      FROM head_evidence WHERE head_id = ${headId}`;
    return rows.map((r) => ({
      id: r.id,
      kind: v.parse(EvidenceKindSchema, r.kind),
      body: r.body,
      ref: r.ref ?? undefined,
      confidence: r.confidence ?? undefined,
    }));
  }

  cacheMerge(rootId: HeadId, result: MergeResult, strategy: MergeStrategy): void {
    void this.sql`INSERT OR REPLACE INTO head_merge_results
      (root_id, merged_narrative, selected_decisions_json, unresolved_questions_json,
       recommendations_json, blind_spots_json, cost_head_count, cost_total_tokens,
       cost_total_wall_ms, cost_max_depth, merged_at, merge_strategy)
      VALUES (${rootId}, ${result.mergedNarrative},
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

  /** Recent runs for the Exploration surface, grouped by root_id. Grouping is
   *  driven by head_journal (always present) so top-level splits — whose
   *  synthetic root has no head row and whose heads all have parent_id NULL —
   *  collapse into ONE run instead of N empty roots. head_runs supplies the
   *  rationale label; head_steps the per-head trace; head_merge_results the
   *  synthesis. */
  /**
   * The runs that still have a head in flight — the live fork roster the
   * dynamic context carries into every model step.
   *
   * Deliberately narrower than {@link listRuns}: no per-head steps, no merge
   * synthesis, one query. It is read on every request of every turn, and a
   * roster line only has to say which run is open and how far along it is.
   *
   * The `root_id IN (running)` subquery is what keeps it that way. Aggregating
   * the whole table first and filtering the groups with `HAVING running > 0`
   * reads every head ever spawned — the journal has no GC, so that scan grows
   * for the life of the workspace and is paid on every model step, against a
   * roster that is empty almost all the time. Measured on bun:sqlite with this
   * DDL, one live root among settled ones: 1.6 ms at 4k head rows and 41.5 ms
   * at 80k, versus 0.004 ms and 0.007 ms here — the scan grows with the table
   * and this does not. Selecting the open roots off
   * `idx_head_journal_status` first bounds the aggregate to those roots, and
   * the result is identical: every root with a running head, and no other.
   */
  listLive(limit = 8): LiveHeadRun[] {
    return this.sql<{ root_id: string; rationale: string | null; running: number; total: number; spawned_at: number }>`
      SELECT j.root_id AS root_id,
             MAX(r.rationale) AS rationale,
             SUM(CASE WHEN j.status = 'running' THEN 1 ELSE 0 END) AS running,
             COUNT(*) AS total,
             MIN(j.spawned_at) AS spawned_at
      FROM head_journal j LEFT JOIN head_runs r ON r.root_id = j.root_id
      WHERE j.root_id IN (SELECT root_id FROM head_journal WHERE status = 'running')
      GROUP BY j.root_id
      ORDER BY spawned_at DESC LIMIT ${limit}`
      .map((row) => ({
        rootId: row.root_id,
        rationale: row.rationale ?? '',
        running: row.running,
        total: row.total,
      }));
  }

  listRuns(limit: number): HeadRunView[] {
    const roots = this.sql<{ root_id: string; spawned_at: number }>`
      SELECT root_id, MIN(spawned_at) AS spawned_at FROM head_journal
      GROUP BY root_id ORDER BY spawned_at DESC LIMIT ${limit}`;
    return roots.map((r) => this.assembleRun(r.root_id, r.spawned_at));
  }

  /** One named run, independent of the recent-list window used by summaries. */
  readRun(rootId: HeadId): HeadRunView | null {
    const row = this.sql<{ spawned_at: number | null }>`
      SELECT MIN(spawned_at) AS spawned_at
      FROM head_journal WHERE root_id = ${rootId}`[0];
    return row?.spawned_at == null ? null : this.assembleRun(rootId, row.spawned_at);
  }

  /**
   * One head, as a reader of a single branch needs it — the same projection
   * {@link listRuns} folds, scoped to one id instead of to a run.
   *
   * Two scopings of ONE projection: the batch query in {@link assembleRun} joins
   * every head of a run in a single pass (a per-head read there would be N+1),
   * and this one answers a reader that opened exactly one branch and must not
   * pay for its siblings' traces. Both hand their row to {@link headViewOf}, so
   * neither can describe a head differently from the other.
   */
  readHeadView(headId: HeadId): HeadRunHeadView | null {
    const row = this.sql<HeadViewRow>`
      SELECT j.id, j.task, j.rationale, j.status, j.summary, j.error_message,
             j.token_input, j.token_output, j.wall_clock_ms, j.spawned_at,
             j.decisions_json, MAX(s.created_at) AS last_step_at
      FROM head_journal j LEFT JOIN head_steps s ON s.head_id = j.id
      WHERE j.id = ${headId}
      GROUP BY j.id`[0];
    return row ? headViewOf(row, this.readSteps(row.id)) : null;
  }

  private assembleRun(rootId: HeadId, spawnedAt: number): HeadRunView {
    // last_step_at comes from the trace itself rather than a column on the head
    // row: the steps ARE the progress record, so a second field could only ever
    // disagree with them.
    const rows = this.sql<HeadViewRow>`
      SELECT j.id, j.task, j.rationale, j.status, j.summary, j.error_message,
             j.token_input, j.token_output, j.token_cache_read, j.token_cache_write,
             j.token_cache_write_1h, j.token_reasoning, j.neurons,
             j.wall_clock_ms, j.spawned_at,
             j.decisions_json, MAX(s.created_at) AS last_step_at
      FROM head_journal j LEFT JOIN head_steps s ON s.head_id = j.id
      WHERE j.root_id = ${rootId}
      GROUP BY j.id ORDER BY j.depth, j.spawned_at`;
    // A recursive sub-split's parent head is the run header, not one of its own
    // children; for top-level splits (synthetic root) nothing matches, so all
    // rows are heads.
    const rootRow = rows.find((h) => h.id === rootId) ?? null;
    const heads: HeadRunHeadView[] = rows
      .filter((h) => h.id !== rootId)
      .map((h) => headViewOf(h, this.readSteps(h.id)));

    const runRow = this.sql<{ rationale: string | null }>`
      SELECT rationale FROM head_runs WHERE root_id = ${rootId}`[0];
    const rationale = runRow?.rationale ?? rootRow?.rationale ?? '';
    const task = rootRow?.task || rationale || heads[0]?.task || '(head run)';

    const mergeRow = this.sql<{ merged_narrative: string; cost_head_count: number; cost_total_tokens: number | null }>`
      SELECT merged_narrative, cost_head_count, cost_total_tokens
      FROM head_merge_results WHERE root_id = ${rootId}`[0];
    const merge = mergeRow
      ? { narrative: mergeRow.merged_narrative, headCount: mergeRow.cost_head_count, totalTokens: mergeRow.cost_total_tokens }
      : null;

    // Run status: still running while any head is; otherwise completed once the
    // merge lands, else surface that heads finished without a synthesis.
    const status = rootRow?.status
      ?? (heads.some((h) => h.status === 'running') ? 'running'
        : merge ? 'completed'
        : heads.every((h) => h.status === 'completed') ? 'completed' : 'partial');

    return { rootId, task, rationale, status, spawnedAt, heads, merge };
  }

  /** What each head in this tree changed on the shared planes, heads that
   *  changed nothing omitted. The queryable form of MergeResult.fileChanges —
   *  rebuilt from the journal rather than cached beside the merge, so a replay
   *  can never disagree with the live run. */
  readFileChanges(rootId: HeadId): HeadFileChangeSet[] {
    return this.sql<{ id: string; file_changes_json: string | null }>`
      SELECT id, file_changes_json FROM head_journal
      WHERE root_id = ${rootId} ORDER BY depth, spawned_at`
      .map((r) => ({ id: r.id, changes: parseArray<HeadFileChange>(r.file_changes_json) }))
      .filter((set) => set.changes.length > 0);
  }

  readCachedMerge(rootId: HeadId): MergeResult | null {
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
      FROM head_merge_results WHERE root_id = ${rootId}`;
    const r = rows[0];
    if (!r) return null;
    // Evidence aggregate + headIds are not cached as separate columns —
    // rebuild from head_journal/head_evidence on demand.
    const tree = this.readTree(rootId);
    const evidence: Evidence[] = tree.flatMap((h) => this.readEvidence(h.id));
    const headIds: HeadId[] = tree.filter((h) => h.parent_id == null || h.parent_id === '').map((h) => h.id);
    const ids = headIds.length > 0 ? headIds : tree.map((h) => h.id);
    return {
      mergedNarrative: r.merged_narrative,
      selectedDecisions: r.selected_decisions_json ? JSON.parse(r.selected_decisions_json) : [],
      unresolvedQuestions: r.unresolved_questions_json ? JSON.parse(r.unresolved_questions_json) : [],
      recommendations: r.recommendations_json ? JSON.parse(r.recommendations_json) : [],
      blindSpots: r.blind_spots_json ? JSON.parse(r.blind_spots_json) : [],
      evidenceAggregate: evidence,
      headIds: ids,
      // Per-head grounded scores are a live-run signal, not persisted as columns;
      // the cached read (UI replay) carries none.
      headScores: [],
      fileChanges: this.readFileChanges(rootId),
      grounded: false,
      costSummary: {
        headCount: r.cost_head_count,
        headsWithFindings: this.countHeadsWithFindings(ids),
        // NULL back to an absent field: the domain type spells "no head
        // reported" by omission, the column by NULL, and a replayed merge must
        // make the same claim the live one made.
        totalTokens: r.cost_total_tokens ?? undefined,
        totalWallClockMs: r.cost_total_wall_ms,
        maxDepth: r.cost_max_depth,
      },
    };
  }

  /** How many of these heads banked a finding. Derived from the journal rows
   *  rather than stored as a column, so a replayed merge can never disagree with
   *  the live one — and through the SAME predicate the merge path uses. */
  private countHeadsWithFindings(headIds: readonly HeadId[]): number {
    return headIds.filter((id) => {
      const row = this.sql<{ status: string; decisions_json: string | null; artifacts_json: string | null }>`
        SELECT status, decisions_json, artifacts_json FROM head_journal WHERE id = ${id}`[0];
      if (!row) return false;
      return headProducedFindings({
        // 'running' is not a terminal status: a head still in flight has banked
        // nothing beyond what the recorded arrays below already show.
        status: row.status === 'completed' ? 'completed' : 'aborted',
        evidence: this.readEvidence(id),
        decisions: parseArray<Decision>(row.decisions_json),
        artifactRefs: parseArray<ArtifactRef>(row.artifacts_json),
      });
    }).length;
  }
}
