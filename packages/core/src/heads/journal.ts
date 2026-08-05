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

import type { SqlExecutor } from '../types/primitives.js';
import type {
  HeadId, HeadInput, HeadReport, HeadStep, HeadStepToolCall, Evidence, MergeResult, MergeStrategy,
  HeadRunView, HeadRunHeadView,
} from './types.js';

/** Defensive JSON parse → array (head_journal/head_steps JSON columns). */
function parseArray<T>(json: string | null): T[] {
  if (!json) return [];
  try { const v = JSON.parse(json); return Array.isArray(v) ? v : []; } catch { return []; }
}

export interface HeadJournalRow {
  id: HeadId;
  parent_id: HeadId | null;
  root_id: HeadId;
  depth: number;
  task: string;
  rationale: string | null;
  status: HeadReport['status'] | 'running';
  spawned_at: number;
  completed_at: number | null;
  token_input: number;
  token_output: number;
  wall_clock_ms: number;
  summary: string | null;
  error_message: string | null;
  merge_strategy: MergeStrategy;
}

export class HeadJournal {
  constructor(private readonly sql: SqlExecutor) {}

  /** Record the run identity for a split so its heads group under one root —
   *  the rationale is the "why split", shown as the run's header label. */
  recordSplit(rootId: HeadId, rationale: string, spawnedAt: number): void {
    this.sql`INSERT INTO head_runs (root_id, rationale, spawned_at)
      VALUES (${rootId}, ${rationale}, ${spawnedAt})
      ON CONFLICT(root_id) DO UPDATE SET rationale = excluded.rationale`;
  }

  insertSpawn(input: HeadInput): void {
    this.sql`INSERT INTO head_journal
      (id, parent_id, root_id, depth, task, rationale, status, spawned_at, merge_strategy)
      VALUES (${input.id}, ${input.parentId}, ${input.rootId}, ${input.depth},
              ${input.task}, ${input.rationale}, 'running', ${input.budget.spawnedAt},
              ${input.mergeStrategy})`;
  }

  updateRunning(id: HeadId): void {
    this.sql`UPDATE head_journal SET status = 'running' WHERE id = ${id}`;
  }

  recordReport(report: HeadReport): void {
    this.sql`UPDATE head_journal SET
      status = ${report.status},
      completed_at = ${Date.now()},
      token_input = ${report.tokenUsage.input},
      token_output = ${report.tokenUsage.output},
      wall_clock_ms = ${report.wallClockMs},
      summary = ${report.summary},
      error_message = ${report.errorMessage ?? null},
      decisions_json = ${JSON.stringify(report.decisions)},
      artifacts_json = ${JSON.stringify(report.artifactRefs)},
      tool_calls_json = ${JSON.stringify(report.toolCalls)},
      child_head_ids_json = ${JSON.stringify(report.childHeadIds)}
      WHERE id = ${report.id}`;
    for (const ev of report.evidence) {
      this.insertEvidence(report.id, ev);
    }
    this.recordSteps(report.id, report.steps);
  }

  /** Persist a head's ordered step trace. Idempotent: step ids are
   *  `${headId}-s${seq}` so re-recording a report replaces in place. The
   *  report arrives over a DO RPC boundary, so tolerate a missing array. */
  recordSteps(headId: HeadId, steps: readonly HeadStep[] | undefined): void {
    this.sql`DELETE FROM head_steps WHERE head_id = ${headId}`;
    (steps ?? []).forEach((s, seq) => {
      this.sql`INSERT INTO head_steps (id, head_id, seq, text, reasoning, tool_calls_json, created_at)
        VALUES (${`${headId}-s${seq}`}, ${headId}, ${seq}, ${s.text}, ${s.reasoning ?? null},
                ${JSON.stringify(s.toolCalls)}, ${Date.now()})`;
    });
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
    this.sql`INSERT OR REPLACE INTO head_evidence
      (id, head_id, kind, body, ref, confidence, created_at)
      VALUES (${ev.id}, ${headId}, ${ev.kind}, ${ev.body},
              ${ev.ref ?? null}, ${ev.confidence ?? null}, ${Date.now()})`;
  }

  readHead(id: HeadId): HeadJournalRow | null {
    const rows = this.sql<HeadJournalRow>`
      SELECT id, parent_id, root_id, depth, task, rationale, status,
             spawned_at, completed_at, token_input, token_output,
             wall_clock_ms, summary, error_message, merge_strategy
      FROM head_journal WHERE id = ${id}`;
    return rows[0] ?? null;
  }

  readTree(rootId: HeadId): HeadJournalRow[] {
    return this.sql<HeadJournalRow>`
      SELECT id, parent_id, root_id, depth, task, rationale, status,
             spawned_at, completed_at, token_input, token_output,
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
      kind: r.kind as Evidence['kind'],
      body: r.body,
      ref: r.ref ?? undefined,
      confidence: r.confidence ?? undefined,
    }));
  }

  cacheMerge(rootId: HeadId, result: MergeResult, strategy: MergeStrategy): void {
    this.sql`INSERT OR REPLACE INTO head_merge_results
      (root_id, merged_narrative, selected_decisions_json, unresolved_questions_json,
       recommendations_json, cost_head_count, cost_total_tokens, cost_total_wall_ms,
       cost_max_depth, merged_at, merge_strategy)
      VALUES (${rootId}, ${result.mergedNarrative},
              ${JSON.stringify(result.selectedDecisions)},
              ${JSON.stringify(result.unresolvedQuestions)},
              ${JSON.stringify(result.recommendations)},
              ${result.costSummary.headCount},
              ${result.costSummary.totalTokens},
              ${result.costSummary.totalWallClockMs},
              ${result.costSummary.maxDepth},
              ${Date.now()}, ${strategy})`;
  }

  /** Recent runs for the Reasoning surface, grouped by root_id. Grouping is
   *  driven by head_journal (always present) so top-level splits — whose
   *  synthetic root has no head row and whose heads all have parent_id NULL —
   *  collapse into ONE run instead of N empty roots. head_runs supplies the
   *  rationale label; head_steps the per-head trace; head_merge_results the
   *  synthesis. */
  listRuns(limit: number): HeadRunView[] {
    const roots = this.sql<{ root_id: string; spawned_at: number }>`
      SELECT root_id, MIN(spawned_at) AS spawned_at FROM head_journal
      GROUP BY root_id ORDER BY spawned_at DESC LIMIT ${limit}`;
    return roots.map((r) => this.assembleRun(r.root_id, r.spawned_at));
  }

  private assembleRun(rootId: HeadId, spawnedAt: number): HeadRunView {
    type HeadRow = {
      id: string; task: string; rationale: string | null; status: string;
      summary: string | null; error_message: string | null;
      token_input: number; token_output: number; wall_clock_ms: number;
      tool_calls_json: string | null; decisions_json: string | null;
    };
    const rows = this.sql<HeadRow>`
      SELECT id, task, rationale, status, summary, error_message,
             token_input, token_output, wall_clock_ms, tool_calls_json, decisions_json
      FROM head_journal WHERE root_id = ${rootId} ORDER BY depth, spawned_at`;
    // A recursive sub-split's parent head is the run header, not one of its own
    // children; for top-level splits (synthetic root) nothing matches, so all
    // rows are heads.
    const rootRow = rows.find((h) => h.id === rootId) ?? null;
    const heads: HeadRunHeadView[] = rows.filter((h) => h.id !== rootId).map((h) => ({
      id: h.id, task: h.task, rationale: h.rationale ?? '', status: h.status,
      summary: h.summary, errorMessage: h.error_message,
      tokenInput: h.token_input, tokenOutput: h.token_output, wallClockMs: h.wall_clock_ms,
      // ToolCallRecord carries { name, args, result }; the view surfaces the
      // short outcome the head tools record ('ok', 'error: …', 'exit=0').
      toolCalls: parseArray<{ name?: unknown; result?: unknown }>(h.tool_calls_json)
        .map((t) => ({ name: String(t?.name ?? '?'), status: String(t?.result ?? '') })),
      decisions: parseArray<{ question?: unknown; choice?: unknown; rationale?: unknown }>(h.decisions_json)
        .map((d) => ({ question: String(d?.question ?? ''), choice: String(d?.choice ?? ''), rationale: String(d?.rationale ?? '') })),
      steps: this.readSteps(h.id),
    }));

    const runRow = this.sql<{ rationale: string | null }>`
      SELECT rationale FROM head_runs WHERE root_id = ${rootId}`[0];
    const rationale = runRow?.rationale ?? rootRow?.rationale ?? '';
    const task = rootRow?.task || rationale || heads[0]?.task || '(head run)';

    const mergeRow = this.sql<{ merged_narrative: string; cost_head_count: number; cost_total_tokens: number }>`
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

  readCachedMerge(rootId: HeadId): MergeResult | null {
    type Row = {
      merged_narrative: string;
      selected_decisions_json: string | null;
      unresolved_questions_json: string | null;
      recommendations_json: string | null;
      cost_head_count: number;
      cost_total_tokens: number;
      cost_total_wall_ms: number;
      cost_max_depth: number;
    };
    const rows = this.sql<Row>`
      SELECT merged_narrative, selected_decisions_json, unresolved_questions_json,
             recommendations_json, cost_head_count, cost_total_tokens,
             cost_total_wall_ms, cost_max_depth
      FROM head_merge_results WHERE root_id = ${rootId}`;
    const r = rows[0];
    if (!r) return null;
    // Evidence aggregate + headIds are not cached as separate columns —
    // rebuild from head_journal/head_evidence on demand.
    const tree = this.readTree(rootId);
    const evidence: Evidence[] = tree.flatMap((h) => this.readEvidence(h.id));
    const headIds: HeadId[] = tree.filter((h) => h.parent_id == null || h.parent_id === '').map((h) => h.id);
    return {
      mergedNarrative: r.merged_narrative,
      selectedDecisions: r.selected_decisions_json ? JSON.parse(r.selected_decisions_json) : [],
      unresolvedQuestions: r.unresolved_questions_json ? JSON.parse(r.unresolved_questions_json) : [],
      recommendations: r.recommendations_json ? JSON.parse(r.recommendations_json) : [],
      evidenceAggregate: evidence,
      headIds: headIds.length > 0 ? headIds : tree.map((h) => h.id),
      // Per-head grounded scores are a live-run signal, not persisted as columns;
      // the cached read (UI replay) carries none.
      headScores: [],
      grounded: false,
      costSummary: {
        headCount: r.cost_head_count,
        totalTokens: r.cost_total_tokens,
        totalWallClockMs: r.cost_total_wall_ms,
        maxDepth: r.cost_max_depth,
      },
    };
  }
}
