// The head journal announces its own writes, so a running search is live.
//
// Shared rather than cf-only: the listener is injected, and the CLI carries the
// same defect in a stronger form — its nodes always run in process, so nothing
// it journals has ever announced anything.
//
// `head_activity` used to be a side effect on two RPC methods, both reachable
// only from a facet calling back to its parent. So a top-level node's or head's
// COMPLETION announced nothing, and an UNHOSTED node — a workspace with no
// owner gets no facet, and core then wires `reportStep` straight to
// `journal.appendStep` — announced nothing at all, for its whole run. Its rows
// landed correctly and a manual reload showed them, which is the worst shape a
// liveness defect can take.
//
// The property under test is that the announcement rides the WRITE. Every path
// into the journal goes through the one instance this backend hands to core, so
// a test that drives the journal directly is testing every one of them: hosted
// and unhosted, head and node, top-level and recursive.
//
// The last two tests are the ones that stop the others passing vacuously: the
// order (write first, then announce) and the isolation (a socket with no
// listeners must not fail a durable write).

import { describe, expect, test } from 'bun:test';
import { createTestSql } from '@kinu.run/test-utils';
import {
  HeadJournal, initHeadsTables, LiveHeadJournal, type HeadInput, type HeadReport,
} from '../src/index';

function spawn(id: string, rootId: string): HeadInput {
  return {
    id, rootId, parentId: null, depth: 1,
    task: `do ${id}`, mode: 'build', rationale: 'because',
    inheritedContext: [], budget: { maxDepth: 1, spawnedAt: 1_000 },
    mergeStrategy: 'synthesize',
  };
}

function report(id: string): HeadReport {
  return {
    id, status: 'completed', summary: `${id} done`,
    evidence: [], decisions: [], artifactRefs: [], fileChanges: [], childHeadIds: [],
    toolCalls: [], stepCount: 1, usage: {}, wallClockMs: 10,
  };
}

/** The journal over a real store, plus the ids it announced, in order. */
function live() {
  const sql = createTestSql();
  initHeadsTables(sql.execRaw, sql.sql);
  const announced: string[] = [];
  return { sql, announced, journal: new LiveHeadJournal(sql.sql, (id) => { announced.push(id); }) };
}

describe('LiveHeadJournal', () => {
  test('a spawn announces the node that appeared', () => {
    const { journal, announced } = live();
    journal.recordSplit('root-1', 'a swarm', Date.now());
    journal.insertSpawn(spawn('n1', 'root-1'));
    // The run itself is announced under its root: for a swarm that row is what
    // makes the search exist, and it is the first thing a watching client can
    // learn about it.
    expect(announced).toEqual(['root-1', 'n1']);
  });

  test("a node's steps announce it as they land", () => {
    const { journal, announced } = live();
    journal.insertSpawn(spawn('n1', 'root-1'));
    announced.length = 0;
    journal.appendStep('n1', 0, { text: 'first', toolCalls: [] });
    journal.appendStep('n1', 1, { text: 'second', toolCalls: [] });
    expect(announced).toEqual(['n1', 'n1']);
  });

  test('a completion announces, which is the write a reader is waiting for', () => {
    const { journal, announced } = live();
    journal.insertSpawn(spawn('n1', 'root-1'));
    announced.length = 0;
    journal.recordReport(report('n1'));
    expect(announced).toEqual(['n1']);
  });

  test('the announcement follows the durable write, never precedes it', () => {
    const sql = createTestSql();
    initHeadsTables(sql.execRaw, sql.sql);
    // Read the store from INSIDE the announcement. A row that is not there yet
    // would send a client to an empty ledger, and an announcement that
    // overtook its own write is indistinguishable from a dropped one.
    const seen: (string | null)[] = [];
    const journal = new LiveHeadJournal(sql.sql, (id) => {
      seen.push(journal.readHead(id)?.status ?? null);
    });
    journal.insertSpawn(spawn('n1', 'root-1'));
    journal.recordReport(report('n1'));
    expect(seen).toEqual(['running', 'completed']);
  });

  test('a failed announcement does not fail the write it was announcing', () => {
    const sql = createTestSql();
    initHeadsTables(sql.execRaw, sql.sql);
    const journal = new LiveHeadJournal(sql.sql, () => {
      throw new Error('no listeners');
    });
    // The caller is core, mid-search. A socket with nobody on it must not cost
    // the search its journal — the row is the durable fact, the announcement is
    // a courtesy.
    expect(() => journal.insertSpawn(spawn('n1', 'root-1'))).not.toThrow();
    expect(journal.readHead('n1')?.task).toBe('do n1');
  });

  test('the plain journal announces nothing — the wrapper is the only channel', () => {
    // The pre-fix shape, so the tests above cannot pass over a journal that
    // announced by itself all along.
    const sql = createTestSql();
    initHeadsTables(sql.execRaw, sql.sql);
    const plain = new HeadJournal(sql.sql);
    let announcements = 0;
    const counting = new LiveHeadJournal(sql.sql, () => { announcements += 1; });
    plain.insertSpawn(spawn('n1', 'root-1'));
    expect(announcements).toBe(0);
    counting.insertSpawn(spawn('n2', 'root-1'));
    expect(announcements).toBe(1);
  });
});
