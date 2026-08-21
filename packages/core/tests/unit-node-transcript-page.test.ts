// The node transcript's step trace, bounded.
//
// `readNodeTranscript` used to answer with EVERY step of the branch in one
// payload — a 400-step search opened its whole trace over the wire on one
// click. The steps are now a cursored page (newest page first, each page
// oldest-first, cursor anchored on `head_steps.id`), with `stepCount` carrying
// the honest total so the Steps metric does not start lying about the page it
// was handed.
//
// These tests walk a transcript longer than one page and hold the contract the
// chat history paging already established: every row reachable exactly once,
// in order, `end` only stated by a query that ran off the data.
import type { SeekCursor } from '../src/read-models/page';
import type { SqlExecutor } from '../src/types/primitives';
import { describe, expect, test } from 'bun:test';
import { createTestSql } from '@kinu.run/test-utils';
import { createTestWorkspace } from './helpers';
import {
  HeadJournal, initHeadsTables, type HeadInput,
} from '../src/index';
import { readNodeTranscript } from '../src/read-models/node-transcript';

const RUN = 'run-page';
const NODE = 'node-page';

function spawn(id: string, rootId: string): HeadInput {
  return {
    id, rootId, parentId: null, depth: 1,
    task: `do ${id}`, mode: 'build', rationale: 'because',
    inheritedContext: [], budget: { maxDepth: 1, spawnedAt: 1_000 },
    mergeStrategy: 'synthesize',
  };
}

/** A head whose trace is `n` steps, s0 oldest. */
function seeded(n: number) {
  const sql = createTestSql();
  initHeadsTables(sql.execRaw, sql.sql);
  const journal = new HeadJournal(sql.sql);
  journal.recordSplit(RUN, 'a swarm', Date.now());
  journal.insertSpawn(spawn(NODE, RUN));
  for (let i = 0; i < n; i++) {
    journal.appendStep(NODE, i, { text: `step ${i}`, toolCalls: [] });
  }
  return { sql: sql.sql, journal };
}
/** Every page, oldest first — the walk a caller performs. */
function walkSteps(sql: SqlExecutor, limit: number): string[] {
  const texts: string[] = [];
  let cursor: SeekCursor | undefined;
  for (;;) {
    const view = readNodeTranscript(sql, RUN, NODE, { limit, cursor });
    expect(view).not.toBeNull();
    texts.unshift(...view!.steps.items.map((s) => s.text));
    if (view!.steps.status === 'end') return texts;
    cursor = view!.steps.next;
  }
}

describe('node transcript paging', () => {
  test('a transcript longer than one page is reachable page by page', () => {
    const n = 7;
    const { sql } = seeded(n);
    expect(walkSteps(sql, 3)).toEqual(Array.from({ length: n }, (_, i) => `step ${i}`));
  });

  test('the first page is the newest work, oldest-first inside the page', () => {
    const { sql } = seeded(7);
    const view = readNodeTranscript(sql, RUN, NODE, { limit: 3 });
    const steps = view!.steps;
    expect(steps.status).toBe('more');
    // Newest PAGE first; within it, reading order.
    expect(steps.items.map((s) => s.text)).toEqual(['step 4', 'step 5', 'step 6']);
    if (steps.status !== 'more') return;
    expect(steps.next.after).toBe(`${NODE}-s4`);
  });

  test('stepCount is the whole trace, not the page', () => {
    const { sql } = seeded(7);
    const view = readNodeTranscript(sql, RUN, NODE, { limit: 3 });
    expect(view!.stepCount).toBe(7);
  });

  test('a short trace answers end, and the count still agrees', () => {
    const { sql } = seeded(2);
    const view = readNodeTranscript(sql, RUN, NODE, { limit: 8 });
    expect(view!.steps.status).toBe('end');
    expect(view!.steps.items.map((s) => s.text)).toEqual(['step 0', 'step 1']);
    expect(view!.stepCount).toBe(2);
  });

  test('a stale cursor is named, not silently answered from nothing', () => {
    const { sql } = seeded(7);
    expect(() => readNodeTranscript(sql, RUN, NODE, { limit: 3, cursor: { after: `${NODE}-s999` } }))
      .toThrow(/no longer in it/);
  });
  test('a rollout — no steps at all — pages as empty', () => {
    const ws = createTestWorkspace();
    void ws.sql`INSERT INTO search_nodes (root_id, id, parent_id, task, action, observation, value, visits, depth, status)
      VALUES ('r', 'roll-1', null, ${'the task'}, ${'proposal one'}, ${'a proposal'}, 0.5, 1, 1, 'open')`;
    const view = readNodeTranscript(ws.sql, 'r', 'roll-1');
    expect(view!.origin).toBe('rollout');
    expect(view!.steps).toEqual({ status: 'end', items: [] });
    expect(view!.stepCount).toBe(0);
    expect(view!.toolCount).toBe(0);
  });
});
