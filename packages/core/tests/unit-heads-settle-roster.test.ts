// The settle closes the roster: a cached merge is a run's settlement, so no head row may
// still claim to execute once it lands. Fixture: five heads, three reported, one stopped,
// one running at merge time.
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { present } from '@kinu.run/test-utils';
import { HeadJournal, UNREPORTED_AT_MERGE_REASON } from '../src/heads/journal';
import { initHeadsTables } from '../src/heads/schema';
import { initSearchTables } from '../src/mcts/schemas';
import { initSwarmNodeRecords } from '../src/strategy/swarm-resume';
import { initMctsSearchTable } from '../src/mcts/search-store';
import { listForkRuns } from '../src/read-models/fork-runs';
import { makeSql, makeExecRaw, createTestActor } from './helpers';
import type { HeadInput, MergeResult } from '../src/heads/index';
import type { SqlExecutor } from '../src/types/primitives';
import { defaultLoopOrigin } from '../src/scaffold/bootstrap';

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
    loop: defaultLoopOrigin('head'),
  };
}

/** The instant before the merge lands. */
function seeded() {
  const db = new Database(':memory:');
  const execRaw = makeExecRaw(db);
  const sql = makeSql(db);
  initHeadsTables(execRaw);
  initSearchTables(execRaw);
  initSwarmNodeRecords(execRaw);
  initMctsSearchTable(execRaw);
  const actor = createTestActor(sql, execRaw, crypto.randomUUID(), 'settle-test');
  const journal = new HeadJournal(sql, actor);
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

  return { db, sql, journal, actor };
}

function statuses(sql: SqlExecutor, actorId: string): Record<string, string> {
  const rows = sql<{ id: string; status: string }>`
    SELECT id, status FROM head_journal
    WHERE actor_id = ${actorId} AND root_id = ${RUN} ORDER BY id`;

  return Object.fromEntries(rows.map((row) => [row.id, row.status]));
}

describe('a run that settles closes every head it did not hear from', () => {
  test('before the merge the roster is honest: one head is still at work', () => {
    // Denominator: the run really had a running head.
    const { sql, journal, actor } = seeded();
    expect(statuses(sql, actor.actorId).h4).toBe('running');
    expect(journal.listLive().items.map((run) => run.running)).toEqual([1]);
    expect(listForkRuns(sql, actor).items[0].status).toBe('running');
  });

  test('the merge terminalizes it, and the run has no running head left', () => {
    const { sql, journal, actor } = seeded();
    journal.cacheMerge(RUN, MERGE, 'synthesize');

    expect(statuses(sql, actor.actorId)).toEqual({
      h0: 'completed', h1: 'completed', h2: 'errored', h3: 'completed', h4: 'aborted',
    });
    // The dynamic-context roster and the list must both stop counting this head.
    expect(journal.listLive().items).toEqual([]);
    expect(listForkRuns(sql, actor).items[0].status).toBe('completed');
  });

  test('the closed head says why, in the settle transition’s own words', () => {
    const { sql, journal, actor } = seeded();
    journal.cacheMerge(RUN, MERGE, 'synthesize');

    const [row] = sql<{ status: string; error_message: string | null; completed_at: number | null }>`
      SELECT status, error_message, completed_at FROM head_journal
      WHERE actor_id = ${actor.actorId} AND id = 'h4'`;

    expect(row?.error_message).toBe(UNREPORTED_AT_MERGE_REASON);
    expect(row?.completed_at).toBeGreaterThan(0);
  });

  test('the counts stay total-consistent: a status moved, no row was added or lost', () => {
    const { sql, journal, actor } = seeded();

    const before = sql<{ n: number }>`SELECT COUNT(*) AS n FROM head_journal
      WHERE actor_id = ${actor.actorId} AND root_id = ${RUN}`[0].n;

    journal.cacheMerge(RUN, MERGE, 'synthesize');
    const view = present(journal.readRun(RUN), 'the settled run');
    expect(sql<{ n: number }>`SELECT COUNT(*) AS n FROM head_journal
      WHERE actor_id = ${actor.actorId} AND root_id = ${RUN}`[0].n)
      .toBe(before);
    expect(view.heads).toHaveLength(before);
    expect(view.heads.filter((head) => head.status === 'running')).toEqual([]);
    expect(listForkRuns(sql, actor).items[0].branches).toBe(before);
  });

  test('settling twice is the same settlement', () => {
    const { sql, journal, actor } = seeded();
    journal.cacheMerge(RUN, MERGE, 'synthesize');
    const first = statuses(sql, actor.actorId);

    const closedAt = sql<{ completed_at: number | null }>`
      SELECT completed_at FROM head_journal
      WHERE actor_id = ${actor.actorId} AND id = 'h0'`[0].completed_at;

    journal.cacheMerge(RUN, MERGE, 'synthesize');

    expect(statuses(sql, actor.actorId)).toEqual(first);
    // Unfinished rows only, so a re-settle cannot rewrite a real report's time.
    expect(sql<{ completed_at: number | null }>`
      SELECT completed_at FROM head_journal
      WHERE actor_id = ${actor.actorId} AND id = 'h0'`[0].completed_at).toBe(closedAt);
    expect(sql<{ n: number }>`SELECT COUNT(*) AS n FROM head_merge_results
      WHERE actor_id = ${actor.actorId} AND root_id = ${RUN}`[0].n)
      .toBe(1);
  });

  test('a recursive split keeps its parent head, which IS the run and is still working', () => {
    // `assembleRun` judges a sub-split by its parent head's row, which keeps working after its
    // children merge; closing it would report a live run as settled.
    const { sql, journal, actor } = seeded();
    journal.insertSpawn({ ...spawn(RUN), depth: 0, parentId: null });
    journal.cacheMerge(RUN, MERGE, 'synthesize');
    expect(statuses(sql, actor.actorId)[RUN]).toBe('running');
    expect(listForkRuns(sql, actor).items[0].status).toBe('running');
  });
});
