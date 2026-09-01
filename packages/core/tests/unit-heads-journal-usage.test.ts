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
 * And those two columns were the ONLY ones, so the other five fields a provider
 * can report — a fork's cache reads and writes, its reasoning tokens, and its
 * Workers AI `neurons`, which is the one cost figure a provider actually bills
 * in — were dropped at persistence. Every field now has a column, derived from
 * `USAGE_FIELDS` so a field added to the type cannot be forgotten here.
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
import { HeadJournal } from '../src/heads/journal';
import { HEAD_USAGE_COLUMNS, initHeadsTables } from '../src/heads/schema';
import { USAGE_FIELDS } from '../src/usage';
import type { HeadInput, HeadReport, MergeResult } from '../src/heads/index';
import { makeSql, makeExecRaw } from './helpers';

/**
 * The pre-change DDL, verbatim — `DEFAULT 0` on the head's token columns,
 * `NOT NULL` on the merge total, the five non-token usage columns absent, and
 * BOTH post-release columns (`file_changes_json`, `blind_spots_json`) absent,
 * exactly as a workspace created before them has it.
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

/** Every usage column of one head, named through the map rather than by hand: a
 *  column added to `HEAD_USAGE_COLUMNS` is asserted below without editing here. */
function storedUsageColumns(db: Database, id: string): Record<string, number | null> {
  const columns = USAGE_FIELDS.map((field) => HEAD_USAGE_COLUMNS[field]);
  return db.prepare<Record<string, number | null>, [string]>(
    `SELECT ${columns.join(', ')} FROM head_journal WHERE id = ?`,
  ).all(id)[0] ?? {};
}

/** What a head whose provider said nothing looks like in storage: NULL in every
 *  usage column, never a row of zeros. */
const NOTHING_REPORTED: Readonly<Record<string, null>> = Object.fromEntries(
  USAGE_FIELDS.map((field) => [HEAD_USAGE_COLUMNS[field], null]),
);

/** One head as a Workers AI fork reports itself: most of the prompt served from
 *  cache, and a FRACTIONAL neuron count that is the provider's own billing
 *  measurement. Both were dropped on the line that received them. */
const FULLY_REPORTED = {
  input: 9_140, output: 312, cacheRead: 8_704, cacheWrite: 436,
  cacheWrite1h: 128, reasoning: 96, neurons: 1_483.75,
} as const;

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
  test('every Usage field has a column, nullable and with no default', () => {
    const db = new Database(':memory:');
    initHeadsTables(makeExecRaw(db), makeSql(db));
    const info = db.prepare<{ name: string; type: string; notnull: number; dflt_value: string | null }, []>(
      `SELECT name, type, "notnull", dflt_value FROM pragma_table_info('head_journal')`,
    ).all();

    // The map is total over `keyof Usage`, which the compiler enforces. This is
    // the other half: that the list the DDL is generated from is the same list
    // every other reader of a Usage walks.
    expect(Object.keys(HEAD_USAGE_COLUMNS).sort()).toEqual([...USAGE_FIELDS].sort());

    for (const field of USAGE_FIELDS) {
      const column = info.find((c) => c.name === HEAD_USAGE_COLUMNS[field]);
      expect(column).toBeDefined();
      // NOT NULL or a default puts the fabricated zero back — and makes the
      // column unreachable by ADD COLUMN on an existing workspace besides,
      // which is how `cost_total_tokens INTEGER NOT NULL` became a defect.
      expect(column?.notnull).toBe(0);
      expect(column?.dflt_value).toBeNull();
    }
    // A neuron count is fractional; INTEGER affinity would round the one figure
    // here that a provider actually bills in. Token counts are whole.
    expect(info.find((c) => c.name === HEAD_USAGE_COLUMNS.neurons)?.type).toBe('REAL');
    expect(info.find((c) => c.name === HEAD_USAGE_COLUMNS.input)?.type).toBe('INTEGER');
  });

  test('a spawned head that has not reported has NULL in every usage column, not 0', () => {
    const db = new Database(':memory:');
    initHeadsTables(makeExecRaw(db), makeSql(db));
    new HeadJournal(makeSql(db)).insertSpawn(spawn('h-live', 'run-live'));

    // insertSpawn names no usage column, so this is the DDL's own answer: with
    // `DEFAULT 0` it claimed the head had spent nothing.
    expect(storedUsageColumns(db, 'h-live')).toEqual(NOTHING_REPORTED);
  });

  test('a head whose provider reported cache reads and neurons round-trips both', () => {
    const db = new Database(':memory:');
    initHeadsTables(makeExecRaw(db), makeSql(db));
    const journal = new HeadJournal(makeSql(db));
    journal.recordSplit('run-cf', 'why', 1);
    journal.insertSpawn(spawn('h-cf', 'run-cf'));
    journal.recordReport(report('h-cf', FULLY_REPORTED));

    expect(journal.readRun('run-cf')?.heads.find((h) => h.id === 'h-cf')?.usage)
      .toEqual({ ...FULLY_REPORTED });
    // REAL, so the fraction survives the round trip rather than being truncated.
    expect(journal.readHead('h-cf')?.neurons).toBe(1_483.75);
    expect(journal.readTree('run-cf')[0]?.token_cache_read).toBe(8_704);
  });

  test('one branch read on its own reports the same usage as the run projection', () => {
    const db = new Database(':memory:');
    initHeadsTables(makeExecRaw(db), makeSql(db));
    const journal = new HeadJournal(makeSql(db));
    journal.recordSplit('run-one', 'why', 1);
    journal.insertSpawn(spawn('h-one', 'run-one'));
    journal.recordReport(report('h-one', FULLY_REPORTED));

    // TWO SCOPINGS OF ONE PROJECTION, held to it here rather than only claimed
    // in the docstring. `readHeadView` named `token_input` and `token_output`
    // alone, so a reader that opened ONE branch was told its provider had
    // reported no cache reads, no reasoning tokens and no `neurons` — while the
    // run projection beside it reported all seven off the same row. A column the
    // query never asked for comes back `undefined`, which is exactly what a
    // provider that reported nothing comes back as, so the surface that renders
    // one branch's spend (`read-models/node-transcript.ts`) could not have told
    // the two apart.
    const fromRun = journal.readRun('run-one')?.heads.find((h) => h.id === 'h-one')?.usage;
    expect(fromRun).toEqual({ ...FULLY_REPORTED });
    expect(journal.readHeadView('h-one')?.usage).toEqual({ ...FULLY_REPORTED });
    expect(journal.readHeadView('h-one')?.usage).toEqual(fromRun);
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

    expect(storedUsageColumns(db, 'h-silent')).toEqual(NOTHING_REPORTED);
    expect(storedUsageColumns(db, 'h-zero'))
      .toEqual({ ...NOTHING_REPORTED, token_input: 0, token_output: 0 });

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
    // The five usage columns the migration ADDED are NULL: this row predates
    // them, and a migration is not a place to invent a count nobody reported.
    expect(journal.readHead('h-old')).toEqual({
      id: 'h-old', parent_id: 'p-old', root_id: 'run-old', depth: 1,
      task: 'the old task', rationale: 'the old why', status: 'completed',
      spawned_at: 11, completed_at: 22, token_input: 4321, token_output: 765,
      token_cache_read: null, token_cache_write: null, token_cache_write_1h: null,
      token_reasoning: null, neurons: null,
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

  test('and a full provider report binds against the columns reconcileColumns added', () => {
    const db = legacyWorkspace();
    initHeadsTables(makeExecRaw(db), makeSql(db));
    const journal = new HeadJournal(makeSql(db));

    // The workspace this has to work on is the one that already exists. Five of
    // these columns did not, and `UPDATE ... SET token_cache_read = ?` against a
    // table that never gained one does not silently drop the field — it throws,
    // and takes the whole head report with it.
    journal.recordReport(report('h-old', FULLY_REPORTED));

    expect(journal.readRun('run-old')?.heads.find((h) => h.id === 'h-old')?.usage)
      .toEqual({ ...FULLY_REPORTED });
    expect(journal.readHead('h-old')?.neurons).toBe(1_483.75);
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

    expect(storedUsageColumns(db, 'h-old')).toEqual(NOTHING_REPORTED);
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
