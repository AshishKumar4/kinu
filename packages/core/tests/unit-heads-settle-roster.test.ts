// The settle closes the roster.
//
// A cached merge IS a run's settlement: `findResumableRun` treats a run with a
// `head_merge_results` row as finished, `assembleRun` reports it `completed`,
// and the fork list reads it as settled. Nothing closed the HEADS in that same
// transition, so a run could settle with a head row still claiming to execute —
// and the Exploration surface then described it as `settled · 1 running · 3
// reported · 1 stopped`, a run that has already answered and is somehow still at
// work. A head in that state also cannot report any more: the synthesis it would
// have reported into is already written.
//
// The shape under test is the one the gallery photographed (root-merge-1): five
// heads, three reported, one stopped, one still running when the merge landed.
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { HeadJournal, UNREPORTED_AT_MERGE_REASON } from '../src/heads/journal';
import { initHeadsTables } from '../src/heads/schema';
import { initSearchTables } from '../src/mcts/schemas';
import { initMctsSearchTable } from '../src/mcts/search-store';
import { listForkRuns } from '../src/read-models/fork-runs';
import { makeSql, makeExecRaw } from './helpers';
import type { HeadInput, MergeResult } from '../src/heads/index';
import type { SqlExecutor } from '../src/types/primitives';

const RUN = 'root-merge-1';

const MERGE: MergeResult = {
  mergedNarrative: 'Three real call sites left, and one guard covers all of them.',
  selectedDecisions: [],
  unresolvedQuestions: [],
  recommendations: [],
  blindSpots: [],
  evidenceAggregate: [],
  headIds: ['h0', 'h1', 'h2', 'h3', 'h4'],
  headScores: [],
  fileChanges: [],
  grounded: false,
  costSummary: {
    headCount: 5, headsWithFindings: 3, totalTokens: 24_820,
    totalWallClockMs: 14_200, maxDepth: 1,
  },
};

function spawn(id: string): HeadInput {
  return {
    id, rootId: RUN, parentId: null, depth: 1,
    task: `walk ${id}`, mode: 'build', rationale: 'one call site each',
    inheritedContext: [], budget: { maxDepth: 1, spawnedAt: 1_000 },
    mergeStrategy: 'synthesize',
  };
}

/** The run as it stands the instant before its merge lands: three heads
 *  reported, one stopped on the provider, one still in flight. */
function seeded() {
  const db = new Database(':memory:');
  const execRaw = makeExecRaw(db);
  const sql = makeSql(db);
  initHeadsTables(execRaw, sql);
  initSearchTables(execRaw, sql);
  initMctsSearchTable(execRaw, sql);
  const journal = new HeadJournal(sql);
  journal.recordSplit(RUN, 'Check every other call site that indexes rules by kind', 1_000);
  for (const id of ['h0', 'h1', 'h2', 'h3', 'h4']) journal.insertSpawn(spawn(id));
  for (const id of ['h0', 'h1', 'h3']) {
    journal.recordReport({
      id, status: 'completed', summary: `${id} reported`, evidence: [],
      decisions: [], artifactRefs: [], fileChanges: [], stepCount: 2,
      usage: { input: 8_420, output: 610 },
      wallClockMs: 14_200, toolCalls: [], childHeadIds: [],
    });
  }
  journal.recordReport({
    id: 'h2', status: 'errored', summary: '', errorMessage: 'the admin package is not checked out',
    evidence: [], decisions: [], artifactRefs: [], fileChanges: [], stepCount: 1,
    usage: { input: 1_020, output: 0 },
    wallClockMs: 2_100, toolCalls: [], childHeadIds: [],
  });
  return { db, sql, journal };
}

function statuses(sql: SqlExecutor): Record<string, string> {
  const rows = sql<{ id: string; status: string }>`
    SELECT id, status FROM head_journal WHERE root_id = ${RUN} ORDER BY id`;
  return Object.fromEntries(rows.map((row) => [row.id, row.status]));
}

describe('a run that settles closes every head it did not hear from', () => {
  test('before the merge the roster is honest: one head is still at work', () => {
    // The denominator. Without this the tests below could pass over a run that
    // never had a running head at all.
    const { sql, journal } = seeded();
    expect(statuses(sql).h4).toBe('running');
    expect(journal.listLive().items.map((run) => run.running)).toEqual([1]);
    expect(listForkRuns(sql).items[0]!.status).toBe('running');
  });

  test('the merge terminalizes it, and the run has no running head left', () => {
    const { sql, journal } = seeded();
    journal.cacheMerge(RUN, MERGE, 'synthesize');

    expect(statuses(sql)).toEqual({
      h0: 'completed', h1: 'completed', h2: 'errored', h3: 'completed', h4: 'aborted',
    });
    // The roster is what the dynamic context carries into every model step, and
    // the list is what the reader sees. Neither may still count this head.
    expect(journal.listLive().items).toEqual([]);
    expect(listForkRuns(sql).items[0]!.status).toBe('completed');
  });

  test('the closed head says why, in the settle transition’s own words', () => {
    const { sql, journal } = seeded();
    journal.cacheMerge(RUN, MERGE, 'synthesize');
    const [row] = sql<{ status: string; error_message: string | null; completed_at: number | null }>`
      SELECT status, error_message, completed_at FROM head_journal WHERE id = 'h4'`;
    expect(row?.error_message).toBe(UNREPORTED_AT_MERGE_REASON);
    expect(row?.completed_at).toBeGreaterThan(0);
  });

  test('the counts stay total-consistent: a status moved, no row was added or lost', () => {
    const { sql, journal } = seeded();
    const before = sql<{ n: number }>`SELECT COUNT(*) AS n FROM head_journal WHERE root_id = ${RUN}`[0]!.n;
    journal.cacheMerge(RUN, MERGE, 'synthesize');
    const view = journal.readRun(RUN)!;
    expect(sql<{ n: number }>`SELECT COUNT(*) AS n FROM head_journal WHERE root_id = ${RUN}`[0]!.n)
      .toBe(before);
    expect(view.heads).toHaveLength(before);
    expect(view.heads.filter((head) => head.status === 'running')).toEqual([]);
    expect(listForkRuns(sql).items[0]!.branches).toBe(before);
  });

  test('settling twice is the same settlement', () => {
    const { sql, journal } = seeded();
    journal.cacheMerge(RUN, MERGE, 'synthesize');
    const first = statuses(sql);
    const closedAt = sql<{ completed_at: number | null }>`
      SELECT completed_at FROM head_journal WHERE id = 'h0'`[0]!.completed_at;

    journal.cacheMerge(RUN, MERGE, 'synthesize');

    expect(statuses(sql)).toEqual(first);
    // A head the first pass closed is not touched again: the predicate matches
    // unfinished rows only, so a re-settle cannot rewrite a real report's time.
    expect(sql<{ completed_at: number | null }>`
      SELECT completed_at FROM head_journal WHERE id = 'h0'`[0]!.completed_at).toBe(closedAt);
    expect(sql<{ n: number }>`SELECT COUNT(*) AS n FROM head_merge_results WHERE root_id = ${RUN}`[0]!.n)
      .toBe(1);
  });

  test('a recursive split keeps its parent head, which IS the run and is still working', () => {
    // The exclusion that has to be there: `assembleRun` judges a sub-split by its
    // parent head's own row, and that head goes on working after its children
    // merge. Closing it here would report a live run as settled — the same lie in
    // the other direction.
    const { sql, journal } = seeded();
    journal.insertSpawn({ ...spawn(RUN), depth: 0, parentId: null });
    journal.cacheMerge(RUN, MERGE, 'synthesize');
    expect(statuses(sql)[RUN]).toBe('running');
    expect(listForkRuns(sql).items[0]!.status).toBe('running');
  });
});
