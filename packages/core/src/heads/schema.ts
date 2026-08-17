/**
 * SQLite schema for branching heads.
 *
 * Tables:
 *   head_runs     — one row per split: the run identity (rationale + spawn time)
 *   head_journal  — one row per head, lifecycle state + final summary
 *   head_evidence — one row per piece of evidence a head considered
 *   head_steps    — ordered per-head reasoning trace (text + tool calls)
 *
 * Schema is idempotent (IF NOT EXISTS) so this can run on every DO cold-start.
 * There are no schema versions: a column added after release is reached by
 * `reconcileColumns`, and a COLUMN CONSTRAINT changed after release — which
 * SQLite bakes into the stored table definition and offers no ALTER for — is
 * reached by `rebuildIfStale`.
 *
 * Lives on the orchestrator's storage. Heads themselves (Facets) keep their
 * own ephemeral state in their own SQLite — the journal here is the
 * orchestrator's view for telemetry, UI, and merge-time gathering.
 */

import type { RawSqlExec, SqlExecutor } from '../types/primitives.js';
import { reconcileColumns } from '../identity/columns.js';

/**
 * One row per head. `token_input`/`token_output` are NULLable and carry NO
 * default on purpose: NULL means this head's provider never reported that
 * count, which is not the same claim as reporting zero. A head aborted before
 * its first model call spent an unknown number of tokens, and `DEFAULT 0` used
 * to record it as having spent none.
 *
 * The invariant "absent means not reported, never zero" cannot be held by
 * application code alone while the DDL manufactures zeros underneath it — the
 * default WAS the fabricator here, because `insertSpawn` names neither column.
 */
const HEAD_JOURNAL_DDL = `CREATE TABLE IF NOT EXISTS head_journal (
  id TEXT PRIMARY KEY,
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
  wall_clock_ms INTEGER DEFAULT 0,
  summary TEXT,
  error_message TEXT,
  decisions_json TEXT,
  artifacts_json TEXT,
  tool_calls_json TEXT,
  child_head_ids_json TEXT,
  file_changes_json TEXT,
  merge_strategy TEXT NOT NULL DEFAULT 'synthesize'
)`;

const HEAD_JOURNAL_COLUMNS = [
  'id', 'parent_id', 'root_id', 'depth', 'task', 'rationale', 'status',
  'spawned_at', 'completed_at', 'token_input', 'token_output', 'wall_clock_ms',
  'summary', 'error_message', 'decisions_json', 'artifacts_json',
  'tool_calls_json', 'child_head_ids_json', 'file_changes_json', 'merge_strategy',
] as const;

/**
 * Cached merge results keyed by root_id — lets the orchestrator avoid
 * re-running synthesis if the user re-asks the same split.
 *
 * `cost_total_tokens` is NULLable for the same reason as the journal's token
 * columns: a split whose heads all died before their first model call has an
 * unknown cost, and `NOT NULL` left the writer no way to say that.
 */
const HEAD_MERGE_RESULTS_DDL = `CREATE TABLE IF NOT EXISTS head_merge_results (
  root_id TEXT PRIMARY KEY,
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
  blind_spots_json TEXT
)`;

const HEAD_MERGE_RESULTS_COLUMNS = [
  'root_id', 'merged_narrative', 'selected_decisions_json',
  'unresolved_questions_json', 'recommendations_json', 'cost_head_count',
  'cost_total_tokens', 'cost_total_wall_ms', 'cost_max_depth', 'merged_at',
  'merge_strategy', 'blind_spots_json',
] as const;

/**
 * Rebuild a table whose stored definition still carries a column constraint the
 * DDL above has since dropped.
 *
 * SQLite bakes defaults and NOT NULL into the stored definition and has no
 * ALTER COLUMN, so neither `CREATE TABLE IF NOT EXISTS` (a no-op on an existing
 * table) nor `reconcileColumns` (adds columns only) can reach them. Both token
 * columns here were `DEFAULT 0` / `NOT NULL`, which means every workspace
 * created before this change would either record an unreported head as having
 * cost zero or, for `cost_total_tokens`, reject the NULL outright and fail the
 * merge cache write.
 *
 * Same sequence and same crash-safety as evolution/outcomes.ts: DO SQLite
 * forbids explicit transactions, so instead the `_legacy` branch finishes an
 * interrupted rebuild and `INSERT OR IGNORE` on the primary key makes every
 * intermediate state recoverable. Columns are NAMED rather than `SELECT *`-ed
 * because both tables have gained a column through `reconcileColumns`, which
 * appends at the end while the DDL declares it in place — a positional copy
 * would silently transpose the two.
 *
 * `stale` is a fragment of the OLD definition, so the probe stops matching as
 * soon as the rebuild has happened and a cold start does no work.
 */
function rebuildIfStale(
  sql: SqlExecutor,
  execRaw: RawSqlExec,
  table: string,
  ddl: string,
  columns: readonly string[],
  stale: string,
): void {
  const legacy = `${table}_legacy`;
  const definitionOf = (name: string): string | null =>
    sql<{ sql: string }>`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ${name}`[0]?.sql ?? null;
  const list = columns.join(', ');
  const drain = (): void => {
    execRaw(`INSERT OR IGNORE INTO ${table} (${list}) SELECT ${list} FROM ${legacy}`);
    execRaw(`DROP TABLE ${legacy}`);
  };

  if (definitionOf(legacy) !== null) {
    execRaw(ddl);
    drain();
  }
  const current = definitionOf(table);
  if (current === null || !current.includes(stale)) return;
  execRaw(`ALTER TABLE ${table} RENAME TO ${legacy}`);
  execRaw(ddl);
  drain();
}

export function initHeadsTables(execRaw: RawSqlExec, sql: SqlExecutor): void {
  // The run identity: a split groups N heads under one root_id. Without this,
  // top-level splits (synthetic root_id, every head parent_id NULL) had no row
  // to anchor the run, so the UI saw each head as its own empty "root".
  execRaw(`CREATE TABLE IF NOT EXISTS head_runs (
    root_id TEXT PRIMARY KEY,
    rationale TEXT,
    spawned_at INTEGER NOT NULL
  )`);

  execRaw(HEAD_JOURNAL_DDL);

  // Journals created before heads reported their file changes predate the
  // column, and CREATE TABLE IF NOT EXISTS will not add it to them.
  reconcileColumns(sql, execRaw, 'head_journal', { file_changes_json: 'TEXT' });

  // After the column reconcile (the rebuild's SELECT names every column of the
  // DDL) and before the index pass (RENAME carries the old indexes onto the
  // legacy table, and DROP TABLE takes them with it).
  rebuildIfStale(sql, execRaw, 'head_journal', HEAD_JOURNAL_DDL, HEAD_JOURNAL_COLUMNS,
    'token_input INTEGER DEFAULT 0');

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

  // Ordered reasoning trace per head — one row per generateText step.
  execRaw(`CREATE TABLE IF NOT EXISTS head_steps (
    id TEXT PRIMARY KEY,
    head_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    text TEXT,
    reasoning TEXT,
    tool_calls_json TEXT,
    created_at INTEGER NOT NULL
  )`);

  execRaw(`CREATE INDEX IF NOT EXISTS idx_head_steps_head ON head_steps(head_id)`);

  execRaw(HEAD_MERGE_RESULTS_DDL);

  // Same post-release column as head_journal above: merges cached before the
  // blind-spot field existed predate the column.
  reconcileColumns(sql, execRaw, 'head_merge_results', { blind_spots_json: 'TEXT' });
  rebuildIfStale(sql, execRaw, 'head_merge_results', HEAD_MERGE_RESULTS_DDL,
    HEAD_MERGE_RESULTS_COLUMNS, 'cost_total_tokens INTEGER NOT NULL');
}
