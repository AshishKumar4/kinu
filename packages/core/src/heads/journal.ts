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
import { mapPage, seekPage, StaleCursorError, type Page, type PageRequest } from '../read-models/page';
import type { ActiveRoster } from '../prompting/volatile-context';


/** The whole-trace totals a paged transcript reports beside its page. */
export interface StepTotals {
  readonly steps: number;
  readonly toolCalls: number;
}

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
 * disagree with them. That aggregate is ALL a run view takes from that table —
 * the prose belongs to {@link HeadJournal.readSteps}, which one opened branch
 * asks for by id.
 *
 * Usage arrives as {@link StoredHeadUsage}, not as two token columns: {@link
 * storedUsage} folds every usage column the journal stores, and naming a subset
 * here is how a cache-read or reasoning figure gets dropped on the way to a
 * surface while every type still checks.
 */
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
    decisions: parseArray<{ question?: unknown; choice?: unknown; rationale?: unknown }>(row.decisions_json)
      .map((d) => ({
        question: String(d?.question ?? ''),
        choice: String(d?.choice ?? ''),
        rationale: String(d?.rationale ?? ''),
      })),
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

/**
 * Why a head carries no report of its own on a run that settled.
 *
 * The synthesis is the run's answer, and it is written from the reports that
 * arrived. A head still in flight when that happens has missed its own run:
 * `head_merge_results` is what every reader treats as the settlement, so the
 * head cannot report into it afterwards. Its own sentence rather than
 * `FORK_INTERRUPTED_REASON`, which is about a later activation finding no
 * executor — a different fact with a different remedy.
 */
export const UNREPORTED_AT_MERGE_REASON =
  'no report at the synthesis: the run merged what had arrived, and this head '
  + 'was still in flight when it did';

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

  /**
   * Open this branch's row — or RE-OPEN the row this id already has.
   *
   * THE ONE RESET TRANSITION, and both re-drive paths reach it. It is an UPSERT
   * because a branch has no durable checkpoint: a re-drive can only re-RUN it, and
   * the one thing it must not do is re-run it as a NEW branch. Both callers therefore
   * arrive with an id they already used —
   *
   *   - a swarm's re-entry re-runs a node that was spawned and never recorded a tree
   *     row, under the id its own row carries (`strategy/swarm-resume.ts`);
   *   - a fork's re-drive re-spawns a head whose id is DERIVED from its branch point
   *     and slot rather than minted (`heads/controller.ts`).
   *
   * so neither needs a reset of its own, and there is no second place where a head
   * row's outcome is cleared.
   *
   * A plain `INSERT` could not be reached twice, which is why both paths used to
   * retire the old rows and mint a parallel set: a five-branch request grew five
   * fresh `aborted` rows per attempt until thirty rows described five branches, and
   * the surface drew every one of them as a failure.
   *
   * WHAT A RE-OPEN CLEARS is everything the previous attempt asserted about an
   * OUTCOME — the terminal status, its clock, its summary, its error, its decisions
   * and artifacts, and every usage column. Usage especially: a re-attempt that
   * inherited the dead one's token counts would bill the search twice for the work
   * it is doing again.
   *
   * `spawned_at` MOVES TO NOW, and that is load-bearing rather than cosmetic.
   * {@link markInterrupted} and {@link abandonRunning} are both bounded by
   * `spawnedBefore`, so a re-opened row is outside a sweep running beside it —
   * whichever order the two run in.
   *
   * THE STEPS GO WITH IT. `head_steps` is this branch's transcript and the seq space
   * is its own, so leaving the dead attempt's tail under a shorter new one would
   * render a transcript no single attempt ever produced.
   *
   * THE CONFLICT ARM IS THE RE-DRIVE, and a FIRST attempt never reaches it: a fresh
   * root's ids have never been written. So this is not a general-purpose upsert with
   * a hidden second meaning — the insert opens a branch, the update re-opens one.
   */
  insertSpawn(input: HeadInput): void {
    void this.sql`INSERT INTO head_journal
      (id, parent_id, root_id, depth, task, rationale, status, spawned_at, merge_strategy)
      VALUES (${input.id}, ${input.parentId}, ${input.rootId}, ${input.depth},
              ${input.task}, ${input.rationale}, 'running', ${input.budget.spawnedAt},
              ${input.mergeStrategy})
      ON CONFLICT(id) DO UPDATE SET
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
    void this.sql`DELETE FROM head_steps WHERE head_id = ${input.id}`;
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
   * Mark heads still claiming to execute as `interrupted` — the FIRST half of a
   * cold activation's reconciliation, and a non-terminal state.
   *
   * `running` means "spawned, and no report recorded". Nothing keeps a head alive
   * across a process exit or a DO eviction, so at the start of an activation that
   * predicate is false for every row still carrying it, whatever became of the
   * executor. Left alone the row is PERMANENT, and its root then satisfies
   * {@link listLive}'s running-head predicate forever, asserting the fork is in
   * flight into every model step for the life of the workspace. That is what it
   * did: `background_jobs` read `cancelled by operator` while the dynamic-context
   * block kept rendering "4 of 4 heads running".
   *
   * WHY THIS IS NOT THE RETIREMENT. Curing that lie and DISCARDING the run are two
   * different acts, and doing them in one write is what cost the owner a search:
   * five heads were retired with "nothing left that could run it" while the durable
   * job that could re-enter them was still re-drivable. `interrupted` says exactly
   * what is known at this instant — the executor is gone, the outcome is not — so
   * the roster stops claiming the work is live while the run stays re-enterable.
   * {@link abandonRunning} is the terminal half, and it runs only for a run the
   * resume gate refused.
   *
   * `spawnedBefore` bounds it to rows an EARLIER activation spawned, so a head this
   * activation has already started is outside it whichever order the two run in.
   *
   * Returns the runs THIS call touched, which is a log of the transition and not
   * the resume gate's offered set: a row an earlier activation already marked is
   * not marked twice. {@link unfinishedRoots} is what the gate is offered.
   */
  markInterrupted(
    scope?: { readonly spawnedBefore?: number },
    now = Date.now(),
  ): AbandonedHeadRun[] {
    const before = scope?.spawnedBefore ?? null;
    const runs = this.unfinishedRuns(null, null, before);
    if (runs.length === 0) return [];
    // No `error_message`: nothing has failed. The column is the retirement's, and
    // writing a reason here is how a reader would come to believe the run ended.
    void this.sql`UPDATE head_journal
      SET status = 'interrupted', completed_at = ${now}
      WHERE status = 'running' AND (${before} IS NULL OR spawned_at < ${before})`;
    return runs;
  }

  /**
   * Every root still holding an unfinished head — `running` or `interrupted` —
   * spawned before `spawnedBefore`. The resume gate's OFFERED SET.
   *
   * Deliberately not {@link markInterrupted}'s return value. That names only the
   * rows this activation transitioned, so a run an earlier activation marked was
   * offered to nobody while {@link abandonRunning} swept exactly those rows: the
   * re-drive the job registry had already claimed was retired underneath it, and
   * the agent was told to re-fork work that was executing. The unfinished set is
   * the same population the retirement reads, so what can be spared is what can
   * be swept.
   */
  unfinishedRoots(spawnedBefore: number): HeadId[] {
    return this.unfinishedRuns('interrupted', null, spawnedBefore).map((run) => run.rootId);
  }

  /**
   * Settle heads that are not going to report as `aborted` — the last terminal
   * writer of `head_journal.status`.
   *
   * TWO CALLERS, one meaning: this run is over and nothing will continue it.
   * The reconciliation calls it for a run the resume gate REFUSED, and a re-entry
   * calls it `rootId`-scoped for the attempt it is taking over. Same transition and
   * the same `error_message` column for both, so a reclaim does not become a second
   * writer of the status this bug was caused by having only one of.
   *
   * The predicate covers `interrupted` as well as `running`, because
   * {@link markInterrupted} runs first on every cold activation: a retirement that
   * only looked at `running` would find nothing exactly when it is needed.
   *
   * `scope` narrows it, and all three narrowings are load-bearing.
   *
   * `rootId` narrows to one run — the re-entry's own scoping. Omitted, it sweeps
   * every run.
   *
   * `exceptRoots` spares the runs the resume gate CLAIMED. Those are being
   * continued, and telling the agent they were retired is both false and expensive:
   * it is what sent the owner's agent off to re-fork a search that was running.
   *
   * `spawnedBefore` bounds the write to rows an earlier activation spawned, so a
   * re-entry's own fresh heads are never retired by a sweep running beside it.
   * Omitted, it sweeps regardless of spawn time, which is what a `rootId`-scoped
   * reclaim wants: it is retiring exactly the attempt it is taking over.
   *
   * Returns the runs it settled so the caller can tell the agent — a fork
   * disappearing from the roster is not the same as the agent learning it is gone.
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
    const root = scope?.rootId ?? null;
    const before = scope?.spawnedBefore ?? null;
    const spared = new Set(scope?.exceptRoots ?? []);
    // Filtered here rather than in the predicate: this executor binds one value per
    // interpolation, so a set cannot cross into SQL without hand-built placeholders.
    const runs = this.unfinishedRuns('interrupted', root, before)
      .filter((run) => !spared.has(run.rootId));
    // One write per run, for the same reason — and the retiring set is the runs
    // just read, so the rows a caller is told about are exactly the rows written.
    for (const run of runs) {
      void this.sql`UPDATE head_journal
        SET status = 'aborted', completed_at = ${now}, error_message = ${reason}
        WHERE root_id = ${run.rootId}
          AND (status = 'running' OR status = 'interrupted')
          AND (${before} IS NULL OR spawned_at < ${before})`;
    }
    return runs;
  }

  /**
   * Runs holding a head that has not reported, with the count this scope covers.
   *
   * ONE query for both transitions above, so the rows a caller is told about and
   * the rows the following write touches cannot come to disagree about a scope.
   * `alsoState` admits a second unfinished status beside `running` — null admits
   * none, because null equals nothing in SQL.
   */
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
      FROM head_journal j LEFT JOIN head_runs r ON r.root_id = j.root_id
      WHERE ${root} IS NULL OR j.root_id = ${root}
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
   * The unfinished run for this task, or null — the reclaim that keeps ONE
   * request from becoming N runs.
   *
   * A fork's background job is re-driven on eviction/exit recovery
   * (jobs/runner.ts), and re-driving a fork means re-running its heads: they are
   * ephemeral facets with no durable checkpoint, so there is nothing else a resume
   * can do. A tree search survived that because its re-entry reclaims the same
   * search by task (MctsSearchStore.findResumable), so its tree keeps ONE root_id
   * across any number of re-drives. Heads had no such reclaim, so every re-drive
   * minted a fresh nanoid root — one request appearing as four near-identical
   * `merged · N branches` runs, each having really spawned and paid for its own
   * N heads.
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

  /** Reading bound and default for one trace page. A page is what one click
   *  opens; the whole trace stays reachable through the cursor. */
  static readonly STEP_PAGE = { limit: 60, max: 200 } as const;

  /**
   * One page of a head's recorded trace — newest page first, each page
   * oldest-first, cursor anchored on the row id (`${headId}-s${seq}`; `seq` is
   * the total order, so a seek on it cannot tie). The page is built over the
   * RAW rows and only then reversed, so the cursor is minted on the row the
   * query actually stopped at, exactly as the chat history's
   * `chronological` does. `readSteps` stays for the readers that reconstruct
   * the whole trace server-side (swarm resume); the page is the wire contract.
   */
  readStepsPage(headId: HeadId, request: PageRequest = {}): Page<HeadStep> {
    const limit = Math.max(1, Math.min(HeadJournal.STEP_PAGE.max, Math.floor(request.limit ?? HeadJournal.STEP_PAGE.limit)));
    const over = limit + 1;
    const after = request.cursor?.after ?? null;
    const from = after === null ? null : this.stepAnchor(headId, after);
    type Row = { id: string; text: string | null; reasoning: string | null; tool_calls_json: string | null };
    return mapPage(seekPage(from === null
      ? this.sql<Row>`
        SELECT id, text, reasoning, tool_calls_json FROM head_steps
        WHERE head_id = ${headId} ORDER BY seq DESC LIMIT ${over}`
      : this.sql<Row>`
        SELECT id, text, reasoning, tool_calls_json FROM head_steps
        WHERE head_id = ${headId} AND seq < ${from} ORDER BY seq DESC LIMIT ${over}`,
      limit, (row) => row.id), (rows) => rows.slice().reverse().map((r) => ({
        text: r.text ?? '',
        reasoning: r.reasoning ?? undefined,
        toolCalls: parseArray<HeadStepToolCall>(r.tool_calls_json),
      })));
  }

  /** How much trace this head has, steps and tool calls across them — the
   *  honest totals behind the transcript's metrics when only a page is on the
   *  wire. Two aggregates, one scan. */
  countSteps(headId: HeadId): StepTotals {
    const row = this.sql<StepTotals & { tools: number | null }>`
      SELECT COUNT(*) AS steps, SUM(json_array_length(tool_calls_json)) AS tools
      FROM head_steps WHERE head_id = ${headId}`[0];
    return { steps: row?.steps ?? 0, toolCalls: row?.tools ?? 0 };
  }

  /** The seq an anchor names, or StaleCursorError when it names nothing — the
   *  caller restarts the walk rather than resuming from a row that is gone. */
  private stepAnchor(headId: HeadId, after: string): number {
    const row = this.sql<{ seq: number }>`
      SELECT seq FROM head_steps WHERE id = ${after} AND head_id = ${headId}`[0];
    if (row === undefined) throw new StaleCursorError('trace', after);
    return row.seq;
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

  /**
   * The settlement — and the transition that CLOSES the roster.
   *
   * A cached merge IS the run's settlement: `findResumableRun` treats a run with
   * a `head_merge_results` row as finished, and `assembleRun` reports it
   * `completed`. So every head still claiming to execute has to be settled HERE,
   * in the same transition, and before the merge row exists: a settled run whose
   * roster still counts a running head is a run the surface describes as *settled
   * · 1 running · 3 reported*, and a run that has already synthesised cannot
   * accept a report from that head afterwards.
   *
   * `aborted` with a reason, which is the terminal state {@link abandonRunning}
   * writes for the same fact — a head that will not report. NOT
   * `FORK_INTERRUPTED_REASON`: that sentence is about a later activation finding
   * no executor, and what happened here is that the synthesis went ahead without
   * this head. The counts stay total-consistent because the status moves and
   * nothing else does — no row is added, none is removed.
   *
   * Idempotent in both halves: `INSERT OR REPLACE` for the merge, and a
   * predicate that matches only unfinished rows, so settling twice writes the
   * same row and touches no head the first pass already closed.
   */
  cacheMerge(rootId: HeadId, result: MergeResult, strategy: MergeStrategy): void {
    void this.sql`UPDATE head_journal
      SET status = 'aborted', completed_at = ${Date.now()},
          error_message = ${UNREPORTED_AT_MERGE_REASON}
      WHERE root_id = ${rootId}
        AND id != ${rootId}
        AND (status = 'running' OR status = 'interrupted')`;
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
  listLive(limit = 8): ActiveRoster<LiveHeadRun> {
    const total = this.sql<{ n: number }>`
      SELECT COUNT(DISTINCT root_id) AS n FROM head_journal WHERE status = 'running'`[0]?.n ?? 0;
    const items = this.sql<{ root_id: string; rationale: string | null; running: number; total: number; spawned_at: number }>`
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
    return { items, total };
  }

  /**
   * Every run with a head still marked running, as full run projections.
   *
   * This is an authority/recovery read, not a UI page: omitting a 101st root
   * would leave it permanently live after an activation sweep. The root query
   * stays bounded by the running-status index rather than by journal history,
   * then each root uses the same projection as listRuns/readRun.
   */
  listRunningRuns(): HeadRunView[] {
    const roots = this.sql<{ root_id: string; spawned_at: number }>`
      SELECT root_id, MIN(spawned_at) AS spawned_at
      FROM head_journal
      WHERE status = 'running'
      GROUP BY root_id
      ORDER BY spawned_at ASC`;
    return roots.map((row) => this.assembleRun(row.root_id, row.spawned_at));
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
   * every head of a run in a single pass, and this one answers a reader that
   * opened exactly one branch. Both hand their row to {@link headViewOf}, so
   * neither can describe a head differently from the other. Neither loads the
   * trace — {@link readSteps} is its own read, taken by the one reader that
   * renders prose.
   */
  readHeadView(headId: HeadId): HeadRunHeadView | null {
    const row = this.sql<HeadViewRow>`
      SELECT j.id, j.parent_id, j.depth, j.task, j.rationale, j.status, j.summary, j.error_message,
             j.token_input, j.token_output, j.wall_clock_ms, j.spawned_at,
             j.decisions_json, MAX(s.created_at) AS last_step_at
      FROM head_journal j LEFT JOIN head_steps s ON s.head_id = j.id
      WHERE j.id = ${headId}
      GROUP BY j.id`[0];
    return row ? headViewOf(row) : null;
  }

  /**
   * WHEN THIS HEAD LAST DID ANYTHING — its newest step, or its spawn where it has
   * taken none — and null for a head this journal never opened.
   *
   * THE LIVENESS READ, for a watchdog that has to tell a head which is between steps
   * from one which is wedged on a call that never answers. It is the same aggregate
   * {@link readHeadView} folds, asked once per envelope per head without the rest of
   * the projection. Both read `MAX(created_at)` over the same two tables, so there is
   * one definition of progress and this is its cheap scoping.
   *
   * NULL IS ABSENT AND NOT ZERO: a head with no row has not been spawned, which a caller
   * distinguishes from a head spawned and idle since. Falling back to `spawned_at` inside
   * the row is not the same fabrication — a head that has taken no step has been idle
   * since it was spawned, which is a fact the row states.
   */
  lastActivityAt(headId: HeadId): number | null {
    const row = this.sql<{ spawned_at: number; last_step_at: number | null }>`
      SELECT j.spawned_at, MAX(s.created_at) AS last_step_at
      FROM head_journal j LEFT JOIN head_steps s ON s.head_id = j.id
      WHERE j.id = ${headId}
      GROUP BY j.id`[0];
    return row ? row.last_step_at ?? row.spawned_at : null;
  }

  private assembleRun(rootId: HeadId, spawnedAt: number): HeadRunView {
    // last_step_at comes from the trace itself rather than a column on the head
    // row: the steps ARE the progress record, so a second field could only ever
    // disagree with them.
    const rows = this.sql<HeadViewRow>`
      SELECT j.id, j.parent_id, j.depth, j.task, j.rationale, j.status, j.summary, j.error_message,
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
      .map((h) => headViewOf(h));

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
