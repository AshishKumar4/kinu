/** Heads journal usage: every `Usage` field has a NULLable, default-free column, and absence reads back as an absent field. */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { HeadJournal } from '../src/heads/journal';
import { HEAD_USAGE_COLUMNS, initHeadsTables } from '../src/heads/schema';
import { USAGE_FIELDS } from '../src/usage';
import type { HeadInput, HeadReport, MergeResult } from '../src/heads/index';
import { makeSql, makeExecRaw, createTestActor } from './helpers';
import { defaultLoopOrigin } from '../src/scaffold/bootstrap';

/** Named through the map, so a new `HEAD_USAGE_COLUMNS` entry is asserted without editing here. */

function storedUsageColumns(db: Database, actorId: string, id: string): Record<string, number | null> {
  const columns = USAGE_FIELDS.map((field) => HEAD_USAGE_COLUMNS[field]);

  return db.prepare<Record<string, number | null>, [string, string]>(
    `SELECT ${columns.join(', ')} FROM head_journal WHERE actor_id = ? AND id = ?`,
  ).all(actorId, id)[0] ?? {};
}

/** Bound to the database's own main actor: the journal is actor-private. */
function newJournal() {
  const db = new Database(':memory:');
  const execRaw = makeExecRaw(db);
  initHeadsTables(execRaw);
  const sql = makeSql(db);
  const actor = createTestActor(sql, execRaw, crypto.randomUUID(), 'usage-test');

  return { db, sql, actor, journal: new HeadJournal(sql, actor) };
}

/** NULL in every usage column, never zeros. */
const NOTHING_REPORTED: Readonly<Record<string, null>> = Object.fromEntries(
  USAGE_FIELDS.map((field) => [HEAD_USAGE_COLUMNS[field], null]),
);

/** Cache-heavy prompt and a fractional neuron count. */
const FULLY_REPORTED = {
  input: 9_140, output: 312, cacheRead: 8_704, cacheWrite: 436,
  cacheWrite1h: 128, reasoning: 96, neurons: 1_483.75,
} as const;

const spawn = (id: string, rootId: string): HeadInput => ({
  id, rootId, parentId: null, depth: 0, task: `task ${id}`, rationale: 'r',
  mode: 'build', inheritedContext: [], budget: { maxDepth: 3, spawnedAt: 1 },
  mergeStrategy: 'synthesize',
  loop: defaultLoopOrigin('head'),
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

    // The list the DDL is generated from is the list every Usage reader walks.
    expect(Object.keys(HEAD_USAGE_COLUMNS).sort()).toEqual([...USAGE_FIELDS].sort());

    for (const field of USAGE_FIELDS) {
      const column = info.find((c) => c.name === HEAD_USAGE_COLUMNS[field]);
      expect(column).toBeDefined();
      // NOT NULL or a default puts the fabricated zero back.
      expect(column?.notnull).toBe(0);
      expect(column?.dflt_value).toBeNull();
    }

    // A neuron count is fractional; token counts are whole.
    expect(info.find((c) => c.name === HEAD_USAGE_COLUMNS.neurons)?.type).toBe('REAL');
    expect(info.find((c) => c.name === HEAD_USAGE_COLUMNS.input)?.type).toBe('INTEGER');
  });

  test('a spawned head that has not reported has NULL in every usage column, not 0', () => {
    const { db, actor, journal } = newJournal();
    journal.insertSpawn(spawn('h-live', 'run-live'));

    // insertSpawn names no usage column, so this is the DDL's own answer.
    expect(storedUsageColumns(db, actor.actorId, 'h-live')).toEqual(NOTHING_REPORTED);
  });

  test('a head whose provider reported cache reads and neurons round-trips both', () => {
    const { journal } = newJournal();
    journal.recordSplit('run-cf', 'why', 1);
    journal.insertSpawn(spawn('h-cf', 'run-cf'));
    journal.recordReport(report('h-cf', FULLY_REPORTED));

    expect(journal.readRun('run-cf')?.heads.find((h) => h.id === 'h-cf')?.usage)
      .toEqual({ ...FULLY_REPORTED });
    // REAL, so the fraction survives the round trip.
    expect(journal.readHead('h-cf')?.neurons).toBe(1_483.75);
    expect(journal.readTree('run-cf')[0]?.token_cache_read).toBe(8_704);
  });

  test('one branch read on its own reports the same usage as the run projection', () => {
    const { journal } = newJournal();
    journal.recordSplit('run-one', 'why', 1);
    journal.insertSpawn(spawn('h-one', 'run-one'));
    journal.recordReport(report('h-one', FULLY_REPORTED));

    // Two scopings of one projection: the single-branch read must name every usage column too.
    const fromRun = journal.readRun('run-one')?.heads.find((h) => h.id === 'h-one')?.usage;
    expect(fromRun).toEqual({ ...FULLY_REPORTED });
    expect(journal.readHeadView('h-one')?.usage).toEqual({ ...FULLY_REPORTED });
    expect(journal.readHeadView('h-one')?.usage).toEqual(fromRun);
  });

  test('an empty usage writes NULL and reads back as an absent field, a reported zero as 0', () => {
    const { db, actor, journal } = newJournal();
    journal.recordSplit('run-1', 'why', 1);
    journal.insertSpawn(spawn('h-silent', 'run-1'));
    journal.insertSpawn(spawn('h-zero', 'run-1'));

    journal.recordReport(report('h-silent', {}));
    journal.recordReport(report('h-zero', { input: 0, output: 0 }));

    expect(storedUsageColumns(db, actor.actorId, 'h-silent')).toEqual(NOTHING_REPORTED);
    expect(storedUsageColumns(db, actor.actorId, 'h-zero'))
      .toEqual({ ...NOTHING_REPORTED, token_input: 0, token_output: 0 });

    // One head said nothing, the other measured itself at zero.
    const heads = journal.readRun('run-1')?.heads ?? [];
    expect(heads.find((h) => h.id === 'h-silent')?.usage).toEqual({});
    expect(heads.find((h) => h.id === 'h-zero')?.usage).toEqual({ input: 0, output: 0 });
  });

  test('an unmeasured merge stores NULL and replays as undefined', () => {
    const { sql, actor, journal } = newJournal();
    journal.insertSpawn(spawn('h', 'run-1'));
    journal.cacheMerge('run-1', merge(undefined), 'synthesize');

    expect(sql<{ cost_total_tokens: number | null }>`
      SELECT cost_total_tokens FROM head_merge_results
      WHERE actor_id = ${actor.actorId} AND root_id = 'run-1'`)
      .toEqual([{ cost_total_tokens: null }]);
    expect(journal.readCachedMerge('run-1')?.costSummary.totalTokens).toBeUndefined();
    expect(journal.readRun('run-1')?.merge?.totalTokens).toBeNull();
  });
});

describe('a journal column reads back as the shape it was written in', () => {
  test('a decision stored without its fields is refused, not read back as strings nobody wrote', () => {
    const { db, actor, journal } = newJournal();
    journal.insertSpawn(spawn('h', 'run-1'));
    db.run('UPDATE head_journal SET decisions_json = ? WHERE actor_id = ? AND id = ?', ['[{"question":"which?"}]', actor.actorId, 'h']);

    expect(() => journal.readHeadView('h')).toThrow('choice');
  });
});

