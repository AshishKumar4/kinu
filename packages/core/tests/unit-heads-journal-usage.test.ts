/**
 * What the heads journal can say about a head's cost — including that it does
 * not know.
 *
 * Every usage column is NULLable with no default, so a head aborted before its
 * first model call and a head that genuinely cost nothing are different rows,
 * and a split nobody measured stays unmeasured. Absence is SQL NULL and comes
 * back as an absent `Usage` field.
 *
 * Every field has a column, derived from `USAGE_FIELDS` so a field added to
 * the type cannot be forgotten here. That includes the five fields beyond
 * input and output — a fork's cache reads and writes, its reasoning tokens,
 * and its Workers AI `neurons`, which is the one cost figure a provider
 * actually bills in.
 */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { HeadJournal } from '../src/heads/journal';
import { HEAD_USAGE_COLUMNS, initHeadsTables } from '../src/heads/schema';
import { USAGE_FIELDS } from '../src/usage';
import type { HeadInput, HeadReport, MergeResult } from '../src/heads/index';
import { makeSql, makeExecRaw } from './helpers';

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
    initHeadsTables(makeExecRaw(db));
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
      // NOT NULL or a default puts the fabricated zero back.
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
    initHeadsTables(makeExecRaw(db));
    new HeadJournal(makeSql(db)).insertSpawn(spawn('h-live', 'run-live'));

    // insertSpawn names no usage column, so this is the DDL's own answer: with
    // `DEFAULT 0` it claimed the head had spent nothing.
    expect(storedUsageColumns(db, 'h-live')).toEqual(NOTHING_REPORTED);
  });

  test('a head whose provider reported cache reads and neurons round-trips both', () => {
    const db = new Database(':memory:');
    initHeadsTables(makeExecRaw(db));
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
    initHeadsTables(makeExecRaw(db));
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
    initHeadsTables(makeExecRaw(db));
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
    initHeadsTables(makeExecRaw(db));
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

