/**
 * SQLite schema for branching heads.
 *
 * Two tables:
 *   head_journal  — one row per head, lifecycle state + final summary
 *   head_evidence — one row per piece of evidence a head considered
 *
 * Schema is idempotent (IF NOT EXISTS) so this can run on every DO cold-start.
 *
 * Lives on the orchestrator's storage. Heads themselves (Facets) keep their
 * own ephemeral state in their own SQLite — the journal here is the
 * orchestrator's view for telemetry, UI, and merge-time gathering.
 */

import type { RawSqlExec } from '../types/primitives.js';

export function initHeadsTables(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS head_journal (
    id TEXT PRIMARY KEY,
    parent_id TEXT,
    root_id TEXT NOT NULL,
    depth INTEGER NOT NULL,
    task TEXT NOT NULL,
    rationale TEXT,
    status TEXT NOT NULL,
    spawned_at INTEGER NOT NULL,
    completed_at INTEGER,
    token_input INTEGER DEFAULT 0,
    token_output INTEGER DEFAULT 0,
    wall_clock_ms INTEGER DEFAULT 0,
    summary TEXT,
    error_message TEXT,
    decisions_json TEXT,
    artifacts_json TEXT,
    tool_calls_json TEXT,
    child_head_ids_json TEXT,
    merge_strategy TEXT NOT NULL DEFAULT 'synthesize'
  )`);

  execRaw(`CREATE INDEX IF NOT EXISTS idx_head_journal_root ON head_journal(root_id)`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_head_journal_parent ON head_journal(parent_id)`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_head_journal_status ON head_journal(status)`);

  execRaw(`CREATE TABLE IF NOT EXISTS head_evidence (
    id TEXT PRIMARY KEY,
    head_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    body TEXT NOT NULL,
    ref TEXT,
    confidence REAL,
    created_at INTEGER NOT NULL
  )`);

  execRaw(`CREATE INDEX IF NOT EXISTS idx_head_evidence_head ON head_evidence(head_id)`);

  // Cached merge results keyed by root_id — lets the orchestrator avoid
  // re-running synthesis if the user re-asks the same split.
  execRaw(`CREATE TABLE IF NOT EXISTS head_merge_results (
    root_id TEXT PRIMARY KEY,
    merged_narrative TEXT NOT NULL,
    selected_decisions_json TEXT,
    unresolved_questions_json TEXT,
    recommendations_json TEXT,
    cost_head_count INTEGER NOT NULL,
    cost_total_tokens INTEGER NOT NULL,
    cost_total_wall_ms INTEGER NOT NULL,
    cost_max_depth INTEGER NOT NULL,
    merged_at INTEGER NOT NULL,
    merge_strategy TEXT NOT NULL
  )`);
}
