/**
 * SQLite schema for branching heads, PRIVATE to the actor that owns the run.
 *
 * Tables:
 *   head_runs     — one row per split: the run identity (rationale + spawn time)
 *   head_journal  — one row per head, lifecycle state + final summary
 *   head_evidence — one row per piece of evidence a head considered
 *   head_steps    — ordered per-head reasoning trace (text + tool calls)
 *
 * Schema is idempotent (IF NOT EXISTS) so this runs on every DO cold-start.
 * Each CREATE TABLE statement declares every column readers name.
 *
 * EVERY TABLE CARRIES `actor_id`, AND IT IS IN EVERY PRIMARY KEY, because none
 * of these ids is minted globally. A fork re-drive derives a head id from its
 * branch point and slot rather than minting one (`journal.ts` insertSpawn), a
 * step id is `${headId}-s${seq}`, and evidence ids come from the report — so two
 * actors branching the same way produce the same ids, and a bare `id PRIMARY
 * KEY` would make one of them overwrite the other's trace. Owning the column on
 * each table rather than joining every statement back to `head_runs` also keeps
 * the roster read the dynamic context takes on EVERY model step a single
 * indexed scan.
 */

import type { RawSqlExec } from '../types/primitives';
import type { Usage } from '../usage';

/**
 * Every {@link Usage} field's column in `head_journal`, keyed by the field it
 * carries.
 *
 * Total over `keyof Usage`, so a field added to the type fails to compile here
 * rather than being dropped on the way to storage. That is not hypothetical:
 * only `input` and `output` had columns, so a fork's cache reads and its Workers
 * AI `neurons` — the one figure a provider actually bills in — were discarded at
 * persistence while every other producer's were kept.
 */
export const HEAD_USAGE_COLUMNS = {
  input: 'token_input',
  output: 'token_output',
  cacheRead: 'token_cache_read',
  cacheWrite: 'token_cache_write',
  cacheWrite1h: 'token_cache_write_1h',
  reasoning: 'token_reasoning',
  neurons: 'neurons',
} as const satisfies Readonly<Record<keyof Usage, string>>;

/** One stored usage column, as every reader of a head row names it. */
type HeadUsageColumn = (typeof HEAD_USAGE_COLUMNS)[keyof Usage];

/** The usage half of a head row, as SQLite hands it back: NULL wherever the
 *  provider said nothing. `heads/journal.ts` owns the one decoder. */
export type StoredHeadUsage = { readonly [C in HeadUsageColumn]: number | null };

/** Usage column types. `neurons` is REAL because Cloudflare bills a FRACTIONAL
 *  unit. Every other field counts whole tokens. */

/**
 * One row per head. Every usage column is NULLable and carries NO default on
 * purpose: NULL means this head's provider never reported that count, which is
 * not the same claim as reporting zero. A head aborted before its first model
 * call spent an unknown number of tokens, and `DEFAULT 0` would record it as
 * having spent none.
 *
 * `insertSpawn` names no usage column, so a `DEFAULT 0` here would fabricate
 * measured zero usage before application code could preserve absence — which
 * is why these columns carry no default.
 */
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

/**
 * Cached merge results keyed by root_id — lets the orchestrator avoid
 * re-running synthesis if the user re-asks the same split.
 *
 * `cost_total_tokens` is NULLable for the same reason as the journal's token
 * columns: a split whose heads all died before their first model call has an
 * unknown cost, and `NOT NULL` left the writer no way to say that.
 */
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
  // The run identity: a split groups N heads under one root_id. Without this,
  // top-level splits (synthetic root_id, every head parent_id NULL) had no row
  // to anchor the run, so the UI saw each head as its own empty "root".
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
  // `root_id` trails the status so the live-roster read stays what its measured
  // note in `journal.ts` claims: `listLive` asks for DISTINCT root_id among this
  // actor's RUNNING heads, and with the root column in the index that seek reads
  // only the open rows instead of every head the actor ever spawned.
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

  // Ordered reasoning trace per head — one row per generateText step.
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
