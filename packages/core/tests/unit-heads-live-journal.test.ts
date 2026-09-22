// The head journal announces its own writes, so every path into it (hosted or not, head or node) is live.
// Shared, not cf-only: CLI nodes run in process, so an announcement bolted to an RPC hop never fires there.

import { describe, expect, test } from 'bun:test';
import { createTestSql, createTestActorsOver } from '@kinu.run/test-utils';
import {
  HeadJournal, initHeadsTables, LiveHeadJournal, type HeadInput, type HeadReport,
} from '../src/index';
import { defaultLoopOrigin } from '../src/scaffold/bootstrap';

function spawn(id: string, rootId: string): HeadInput {
  return {
    id, rootId, parentId: null, depth: 1,
    task: `do ${id}`, mode: 'build', rationale: 'because',
    inheritedContext: [], budget: { maxDepth: 1, spawnedAt: 1_000 },
    mergeStrategy: 'synthesize',
    loop: defaultLoopOrigin('head'),
  };
}

function report(id: string): HeadReport {
  return {
    id, status: 'completed', summary: `${id} done`,
    evidence: [], decisions: [], artifactRefs: [], fileChanges: [], childHeadIds: [],
    toolCalls: [], stepCount: 1, usage: {}, wallClockMs: 10,
  };
}

function live() {
  const sql = createTestSql();
  initHeadsTables(sql.execRaw);
  const actor = createTestActorsOver(sql.db).main;
  const announced: string[] = [];

  return {
    sql, announced,
    journal: new LiveHeadJournal(sql.sql, actor, (id) => { announced.push(id); }),
  };
}

describe('LiveHeadJournal', () => {
  test('a spawn announces the node that appeared', () => {
    const { journal, announced } = live();
    journal.recordSplit('root-1', 'a swarm', Date.now());
    journal.insertSpawn(spawn('n1', 'root-1'));
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
    initHeadsTables(sql.execRaw);
    const actor = createTestActorsOver(sql.db).main;
    // Read the store inside the announcement: an announcement that overtook its write reads as a dropped one.
    const seen: (string | null)[] = [];

    const journal = new LiveHeadJournal(sql.sql, actor, (id) => {
      seen.push(journal.readHead(id)?.status ?? null);
    });

    journal.insertSpawn(spawn('n1', 'root-1'));
    journal.recordReport(report('n1'));
    expect(seen).toEqual(['running', 'completed']);
  });

  test('a failed announcement does not fail the write it was announcing', () => {
    const sql = createTestSql();
    initHeadsTables(sql.execRaw);

    const journal = new LiveHeadJournal(sql.sql, createTestActorsOver(sql.db).main, () => {
      throw new Error('no listeners');
    });

    // A socket with no listeners must not fail the durable write.
    expect(() => journal.insertSpawn(spawn('n1', 'root-1'))).not.toThrow();
    expect(journal.readHead('n1')?.task).toBe('do n1');
  });

  test('the plain journal announces nothing — the wrapper is the only channel', () => {
    // The unwrapped journal, so the tests above cannot pass vacuously.
    const sql = createTestSql();
    initHeadsTables(sql.execRaw);
    const actor = createTestActorsOver(sql.db).main;
    const plain = new HeadJournal(sql.sql, actor);
    let announcements = 0;
    const counting = new LiveHeadJournal(sql.sql, actor, () => { announcements += 1; });
    plain.insertSpawn(spawn('n1', 'root-1'));
    expect(announcements).toBe(0);
    counting.insertSpawn(spawn('n2', 'root-1'));
    expect(announcements).toBe(1);
  });
});
