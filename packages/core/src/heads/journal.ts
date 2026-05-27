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
  HeadId, HeadInput, HeadReport, Evidence, MergeResult, MergeStrategy,
} from './types.js';

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
      costSummary: {
        headCount: r.cost_head_count,
        totalTokens: r.cost_total_tokens,
        totalWallClockMs: r.cost_total_wall_ms,
        maxDepth: r.cost_max_depth,
      },
    };
  }
}
