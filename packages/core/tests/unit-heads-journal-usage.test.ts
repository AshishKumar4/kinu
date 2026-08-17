/**
 * What the heads journal can say about a head's cost — including that it does
 * not know.
 *
 * `head_journal.token_input`/`token_output` carried `DEFAULT 0` and
 * `head_merge_results.cost_total_tokens` carried `NOT NULL`, so a head aborted
 * before its first model call and a head that genuinely cost nothing were the
 * same row, and a split nobody measured was recorded as a free one. Absence is
 * now SQL NULL and comes back as an absent `Usage` field.
 *
 * The migration half matters more than the fresh-table half. SQLite bakes
 * defaults and NOT NULL into the stored table definition and offers no ALTER
 * for either, so `CREATE TABLE IF NOT EXISTS` cannot reach a workspace created
 * before this change and `reconcileColumns` only ever ADDS columns — a rebuild
 * has to. These run against tables in the OLD shape, with rows already in them,
 * because a migration verified only against a freshly-created table has not
 * been verified.
 */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { HeadJournal } from '../src/heads/journal.js';
import { initHeadsTables } from '../src/heads/schema.js';
import type { HeadInput, HeadReport, MergeResult } from '../src/heads/index.js';
import { makeSql, makeExecRaw } from './helpers.js';

/**
 * The pre-change DDL, verbatim — `DEFAULT 0` on the head's token columns,
 * `NOT NULL` on the merge total, and BOTH post-release columns
 * (`file_changes_json`, `blind_spots_json`) absent, exactly as a workspace
 * created before them has it.
 *
 * `file_changes_json` being absent here is the point of the fixture and not
 * incidental: `reconcileColumns` appends it at the END of the table, while the
 * current DDL declares it between `child_head_ids_json` and `merge_strategy`.
 * A rebuild that copied positionally would therefore write `merge_strategy`'s
 * value into `file_changes_json`.
 */
const LEGACY_HEAD_JOURNAL = `CREATE TABLE head_journal (
  id TEXT PRIMARY KEY, parent_id TEXT, root_id TEXT NOT NULL, depth INTEGER NOT NULL,
  task TEXT NOT NULL, rationale TEXT, status TEXT NOT NULL, spawned_at INTEGER NOT NULL,
  completed_at INTEGER, token_input INTEGER DEFAULT 0, token_output INTEGER DEFAULT 0,
  wall_clock_ms INTEGER DEFAULT 0, summary TEXT, error_message TEXT,
  decisions_json TEXT, artifacts_json TEXT, tool_calls_json TEXT, child_head_ids_json TEXT,
  merge_strategy TEXT NOT NULL DEFAULT 'synthesize')`;

const LEGACY_HEAD_MERGE_RESULTS = `CREATE TABLE head_merge_results (
  root_id TEXT PRIMARY KEY, merged_narrative TEXT NOT NULL,
  selected_decisions_json TEXT, unresolved_questions_json TEXT, recommendations_json TEXT,
  cost_head_count INTEGER NOT NULL, cost_total_tokens INTEGER NOT NULL,
  cost_total_wall_ms INTEGER NOT NULL, cost_max_depth INTEGER NOT NULL,
  merged_at INTEGER NOT NULL, merge_strategy TEXT NOT NULL)`;

/** A workspace as it stands the moment before this change ships: old tables,
 *  real rows, distinctive values in every column the rebuild has to carry. */
function legacyWorkspace(): Database {
  const db = new Database(':memory:');
  db.exec(LEGACY_HEAD_JOURNAL);
  db.exec(LEGACY_HEAD_MERGE_RESULTS);
  db.exec(`INSERT INTO head_journal
    (id, parent_id, root_id, depth, task, rationale, status, spawned_at, completed_at,
     token_input, token_output, wall_clock_ms, summary, error_message,
     decisions_json, artifacts_json, tool_calls_json, child_head_ids_json, merge_strategy)
    VALUES ('h-old', 'p-old', 'run-old', 1, 'the old task', 'the old why', 'completed',
            11, 22, 4321, 765, 4000, 'what it found', NULL,
            '[{"question":"q","choice":"c","rationale":"r"}]', '[]', '[]', '["kid"]', 'best_of')`);
  db.exec(`INSERT INTO head_merge_results
    (root_id, merged_narrative, selected_decisions_json, unresolved_questions_json,
     recommendations_json, cost_head_count, cost_total_tokens, cost_total_wall_ms,
     cost_max_depth, merged_at, merge_strategy)
    VALUES ('run-old', 'the old synthesis', '[]', '[]', '[]', 2, 5086, 4000, 3, 99, 'best_of')`);
  return db;
}

function storedDefinition(db: Database, table: string): string {
  const rows = db.prepare<{ sql: string }, [string]>(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).all(table);
  return rows[0]?.sql ?? '';
}

const spawn = (id: string, rootId: string): HeadInput => ({
  id, rootId, parentId: null, depth: 0, task: `task ${id}`, rationale: 'r',
  mode: 'build', inheritedContext: [], budget: { maxDepth: 3, spawnedAt: 1 },
  mergeStrategy: 'synthesize',
});

const report = (id: string, usage: HeadReport['usage']): HeadReport => ({
  id, status: 'completed', summary: 's',
  evidence: [], decisions: [], artifactRefs: [], fileChanges: [],
  childHeadIds: [], toolCalls: [], stepCount: 1, usage, wallClockMs: 7,
});

const merge = (totalTokens: number | undefined): MergeResult => ({
  mergedNarrative: 'n', selectedDecisions: [], unresolvedQuestions: [],
  recommendations: [], blindSpots: [], evidenceAggregate: [], headIds: [],
  headScores: [], fileChanges: [], grounded: false,
  costSummary: { headCount: 1, headsWithFindings: 0, totalTokens, totalWallClockMs: 3, maxDepth: 2 },
});

describe('a fresh journal cannot fabricate a cost it was never told', () => {
  test('a spawned head that has not reported has NULL token columns, not 0', () => {
    const db = new Database(':memory:');
    initHeadsTables(makeExecRaw(db), makeSql(db));
    const sql = makeSql(db);
    new HeadJournal(sql).insertSpawn(spawn('h-live', 'run-live'));

    // insertSpawn names neither token column, so this is the DDL's own answer:
    // with `DEFAULT 0` it claimed the head had spent nothing.
    expect(sql<{ token_input: number | null; token_output: number | null }>`
      SELECT token_input, token_output FROM head_journal WHERE id = 'h-live'`)
      .toEqual([{ token_input: null, token_output: null }]);
  });

  test('an empty usage writes NULL and reads back as an absent field, a reported zero as 0', () => {
    const db = new Database(':memory:');
    initHeadsTables(makeExecRaw(db), makeSql(db));
    const sql = makeSql(db);
    const journal = new HeadJournal(sql);
    journal.recordSplit('run-1', 'why', 1);
    journal.insertSpawn(spawn('h-silent', 'run-1'));
    journal.insertSpawn(spawn('h-zero', 'run-1'));

    journal.recordReport(report('h-silent', {}));
    journal.recordReport(report('h-zero', { input: 0, output: 0 }));

    expect(sql<{ id: string; token_input: number | null; token_output: number | null }>`
      SELECT id, token_input, token_output FROM head_journal ORDER BY id`).toEqual([
        { id: 'h-silent', token_input: null, token_output: null },
        { id: 'h-zero', token_input: 0, token_output: 0 },
      ]);

    // The distinction the columns now carry is the distinction the view serves:
    // one head said nothing, the other measured itself at zero.
    const heads = journal.readRun('run-1')?.heads ?? [];
    expect(heads.find((h) => h.id === 'h-silent')?.usage).toEqual({});
    expect(heads.find((h) => h.id === 'h-zero')?.usage).toEqual({ input: 0, output: 0 });
  });

  test('an unmeasured merge stores NULL and replays as undefined', () => {
    const db = new Database(':memory:');
    initHeadsTables(makeExecRaw(db), makeSql(db));
    const sql = makeSql(db);
    const journal = new HeadJournal(sql);
    journal.insertSpawn(spawn('h', 'run-1'));
    journal.cacheMerge('run-1', merge(undefined), 'synthesize');

    expect(sql<{ cost_total_tokens: number | null }>`
      SELECT cost_total_tokens FROM head_merge_results WHERE root_id = 'run-1'`)
      .toEqual([{ cost_total_tokens: null }]);
    expect(journal.readCachedMerge('run-1')?.costSummary.totalTokens).toBeUndefined();
    expect(journal.readRun('run-1')?.merge?.totalTokens).toBeNull();
  });
});

describe('a workspace created under the old DDL is migrated, not left lying', () => {
  test('the baked-in DEFAULT 0 and NOT NULL are actually gone afterwards', () => {
    const db = legacyWorkspace();
    expect(storedDefinition(db, 'head_journal')).toContain('token_input INTEGER DEFAULT 0');
    expect(storedDefinition(db, 'head_merge_results')).toContain('cost_total_tokens INTEGER NOT NULL');

    initHeadsTables(makeExecRaw(db), makeSql(db));

    expect(storedDefinition(db, 'head_journal')).not.toContain('token_input INTEGER DEFAULT 0');
    expect(storedDefinition(db, 'head_journal')).not.toContain('token_output INTEGER DEFAULT 0');
    expect(storedDefinition(db, 'head_merge_results')).not.toContain('cost_total_tokens INTEGER NOT NULL');
    // The rebuild left no scaffolding behind.
    expect(storedDefinition(db, 'head_journal_legacy')).toBe('');
    expect(storedDefinition(db, 'head_merge_results_legacy')).toBe('');
  });

  test('every existing value survives, in the column it started in', () => {
    const db = legacyWorkspace();
    initHeadsTables(makeExecRaw(db), makeSql(db));
    const journal = new HeadJournal(makeSql(db));

    // Named-column copy, not `SELECT *`: `merge_strategy` must NOT have landed
    // in the `file_changes_json` slot that reconcileColumns appended past it.
    expect(journal.readHead('h-old')).toEqual({
      id: 'h-old', parent_id: 'p-old', root_id: 'run-old', depth: 1,
      task: 'the old task', rationale: 'the old why', status: 'completed',
      spawned_at: 11, completed_at: 22, token_input: 4321, token_output: 765,
      wall_clock_ms: 4000, summary: 'what it found', error_message: null,
      merge_strategy: 'best_of',
    });
    // Which the transposed alternative would prove by throwing: `readFileChanges`
    // parses that column as a JSON array, and 'best_of' is not one.
    expect(journal.readFileChanges('run-old')).toEqual([]);
    // `headsWithFindings` is derived from the journal rows rather than a cached
    // column — the migrated head is `completed`, so it counts.
    expect(journal.readCachedMerge('run-old')?.costSummary).toEqual({
      headCount: 2, headsWithFindings: 1, totalTokens: 5086,
      totalWallClockMs: 4000, maxDepth: 3,
    });
  });

  test('and a NULL now binds where the old shape forced a fabricated zero', () => {
    const db = legacyWorkspace();
    initHeadsTables(makeExecRaw(db), makeSql(db));
    const sql = makeSql(db);
    const journal = new HeadJournal(sql);

    // Both of these threw or silently wrote 0 against the old table: the
    // journal's columns had a default, the merge total had NOT NULL.
    journal.recordReport(report('h-old', {}));
    journal.cacheMerge('run-old', merge(undefined), 'best_of');

    expect(sql<{ token_input: number | null; token_output: number | null }>`
      SELECT token_input, token_output FROM head_journal WHERE id = 'h-old'`)
      .toEqual([{ token_input: null, token_output: null }]);
    expect(journal.readCachedMerge('run-old')?.costSummary.totalTokens).toBeUndefined();
  });

  test('a second cold start is a no-op — the rebuild does not run twice', () => {
    const db = legacyWorkspace();
    initHeadsTables(makeExecRaw(db), makeSql(db));
    const first = storedDefinition(db, 'head_journal');
    initHeadsTables(makeExecRaw(db), makeSql(db));

    expect(storedDefinition(db, 'head_journal')).toBe(first);
    expect(new HeadJournal(makeSql(db)).readHead('h-old')?.token_input).toBe(4321);
  });

  test('a rebuild interrupted mid-sequence is finished on the next start', () => {
    // The crash window: RENAME landed, DROP did not, so the rows are stranded in
    // `_legacy` beside a table the plain CREATE IF NOT EXISTS would leave empty.
    // Without the resume branch the history is silently gone.
    const db = legacyWorkspace();
    db.exec(`ALTER TABLE head_journal RENAME TO head_journal_legacy`);
    db.exec(`ALTER TABLE head_merge_results RENAME TO head_merge_results_legacy`);
    db.exec(`ALTER TABLE head_journal_legacy ADD COLUMN file_changes_json TEXT`);
    db.exec(`ALTER TABLE head_merge_results_legacy ADD COLUMN blind_spots_json TEXT`);

    initHeadsTables(makeExecRaw(db), makeSql(db));

    const journal = new HeadJournal(makeSql(db));
    expect(journal.readHead('h-old')?.merge_strategy).toBe('best_of');
    expect(journal.readHead('h-old')?.token_output).toBe(765);
    expect(journal.readCachedMerge('run-old')?.mergedNarrative).toBe('the old synthesis');
    expect(storedDefinition(db, 'head_journal_legacy')).toBe('');
  });

  test('the indexes are back — the rebuild runs before the index pass, not after', () => {
    // `ALTER TABLE ... RENAME` carries a table's indexes onto the renamed table,
    // and `DROP TABLE` then takes them with it. Rebuilding AFTER the
    // CREATE INDEX IF NOT EXISTS pass would leave a migrated workspace with no
    // index on head_journal(root_id) at all — every read of a run degrading to a
    // scan, and nothing failing to say so.
    const db = legacyWorkspace();
    db.exec(`CREATE INDEX idx_head_journal_root ON head_journal(root_id)`);
    initHeadsTables(makeExecRaw(db), makeSql(db));

    const indexes = db.prepare<{ name: string }, []>(
      `SELECT name FROM sqlite_master
       WHERE type = 'index' AND tbl_name = 'head_journal' AND name LIKE 'idx_%'`,
    ).all().map((row) => row.name).sort();
    expect(indexes).toEqual([
      'idx_head_journal_parent', 'idx_head_journal_root', 'idx_head_journal_status',
    ]);
  });
});
