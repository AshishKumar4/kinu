/**
 * SQLite schema for branching heads, private to the owning actor; idempotent (IF NOT EXISTS).
 * Every table carries `actor_id` in its primary key: head, step and evidence ids are not globally
 * unique (`journal.ts` insertSpawn derives head ids).
 */

import type { RawSqlExec } from '../types/primitives';
import type { Usage } from '../usage';

/** Total over `keyof Usage`, so a new field fails to compile rather than being dropped at persistence. */
export const HEAD_USAGE_COLUMNS = {
  input: 'token_input',
  output: 'token_output',
  cacheRead: 'token_cache_read',
  cacheWrite: 'token_cache_write',
  cacheWrite1h: 'token_cache_write_1h',
  reasoning: 'token_reasoning',
  neurons: 'neurons',
} as const satisfies Readonly<Record<keyof Usage, string>>;

type HeadUsageColumn = (typeof HEAD_USAGE_COLUMNS)[keyof Usage];

/** NULL wherever the provider said nothing. `heads/journal.ts` owns the one decoder. */
export type StoredHeadUsage = { readonly [C in HeadUsageColumn]: number | null };

/** `neurons` is REAL because it is billed in a fractional unit. */

/** Usage columns are NULLable with no default: NULL means never reported, and `insertSpawn` names no usage column. */
const HEAD_JOURNAL_DDL = `CREATE TABLE IF NOT EXISTS head_journal (
  actor_id TEXT NOT NULL,
  id TEXT NOT NULL,
  parent_id TEXT,
  root_id TEXT NOT NULL,
  depth INTEGER NOT NULL,
  task TEXT NOT NULL,
  rationale TEXT,
  status TEXT NOT NULL,
  spawned_at INTEGER NOT NULL,
  completed_at INTEGER,
  token_input INTEGER,
  token_output INTEGER,
  token_cache_read INTEGER,
  token_cache_write INTEGER,
  token_cache_write_1h INTEGER,
  token_reasoning INTEGER,
  neurons REAL,
  wall_clock_ms INTEGER DEFAULT 0,
  summary TEXT,
  error_message TEXT,
  decisions_json TEXT,
  artifacts_json TEXT,
  tool_calls_json TEXT,
  child_head_ids_json TEXT,
  file_changes_json TEXT,
  merge_strategy TEXT NOT NULL DEFAULT 'synthesize',
  PRIMARY KEY (actor_id, id)
)`;

/** Cached merges keyed by root_id. `cost_total_tokens` is NULLable: an unknown cost is not zero. */
const HEAD_MERGE_RESULTS_DDL = `CREATE TABLE IF NOT EXISTS head_merge_results (
  actor_id TEXT NOT NULL,
  root_id TEXT NOT NULL,
  merged_narrative TEXT NOT NULL,
  selected_decisions_json TEXT,
  unresolved_questions_json TEXT,
  recommendations_json TEXT,
  cost_head_count INTEGER NOT NULL,
  cost_total_tokens INTEGER,
  cost_total_wall_ms INTEGER NOT NULL,
  cost_max_depth INTEGER NOT NULL,
  merged_at INTEGER NOT NULL,
  merge_strategy TEXT NOT NULL,
  blind_spots_json TEXT,
  PRIMARY KEY (actor_id, root_id)
)`;

export function initHeadsTables(execRaw: RawSqlExec): void {
  // One row per split, anchoring top-level runs whose heads all have a NULL parent_id.
  execRaw(`CREATE TABLE IF NOT EXISTS head_runs (
    actor_id TEXT NOT NULL,
    root_id TEXT NOT NULL,
    rationale TEXT,
    spawned_at INTEGER NOT NULL,
    PRIMARY KEY (actor_id, root_id)
  )`);

  execRaw(HEAD_JOURNAL_DDL);

  execRaw(`CREATE INDEX IF NOT EXISTS idx_head_journal_root ON head_journal(actor_id, root_id)`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_head_journal_parent ON head_journal(actor_id, parent_id)`);
  // `root_id` trails the status so `listLive` (DISTINCT root_id of running heads) seeks only open rows.
  execRaw(`CREATE INDEX IF NOT EXISTS idx_head_journal_status ON head_journal(actor_id, status, root_id)`);

  execRaw(`CREATE TABLE IF NOT EXISTS head_evidence (
    actor_id TEXT NOT NULL,
    id TEXT NOT NULL,
    head_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    body TEXT NOT NULL,
    ref TEXT,
    confidence REAL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (actor_id, id)
  )`);

  execRaw(`CREATE INDEX IF NOT EXISTS idx_head_evidence_head ON head_evidence(actor_id, head_id)`);

  execRaw(`CREATE TABLE IF NOT EXISTS head_steps (
    actor_id TEXT NOT NULL,
    id TEXT NOT NULL,
    head_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    text TEXT,
    reasoning TEXT,
    tool_calls_json TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (actor_id, id)
  )`);

  execRaw(`CREATE INDEX IF NOT EXISTS idx_head_steps_head ON head_steps(actor_id, head_id, seq)`);

  execRaw(HEAD_MERGE_RESULTS_DDL);

}
