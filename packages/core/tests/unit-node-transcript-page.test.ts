// `readNodeTranscript` pages newest-page-first, each page oldest-first, cursor on `head_steps.id`;
// every row reachable exactly once, `end` only from a query that ran off the data.
import type { SeekCursor } from '../src/session/page';
import type { SqlExecutor } from '../src/types/primitives';
import type { ActorHandle } from '../src/identity/actor-handle';
import { describe, expect, test } from 'bun:test';
import { createTestActors, createTestSql, present } from '@kinu.run/test-utils';
import { createTestWorkspace } from './helpers';
import {
  HeadJournal, initHeadsTables, type HeadInput,
} from '../src/index';
import { readNodeTranscript } from '../src/read-models/node-transcript';
import { defaultLoopOrigin } from '../src/scaffold/bootstrap';

const RUN = 'run-page';

const NODE = 'node-page';

function spawn(id: string, rootId: string): HeadInput {
  return {
    id, rootId, parentId: null, depth: 1,
    task: `do ${id}`, mode: 'build', rationale: 'because',
    inheritedContext: [], budget: { maxDepth: 1, spawnedAt: 1_000 },
    mergeStrategy: 'synthesize',
    loop: defaultLoopOrigin('head'),
  };
}

function seeded(n: number) {
  const sql = createTestSql();
  initHeadsTables(sql.execRaw);
  // The journal is actor-private, so the trace only exists for the actor that wrote it.
  const actor = createTestActors(sql.sql, sql.execRaw).main;
  const journal = new HeadJournal(sql.sql, actor);
  journal.recordSplit(RUN, 'a swarm', Date.now());
  journal.insertSpawn(spawn(NODE, RUN));

  for (let i = 0; i < n; i++) {
    journal.appendStep(NODE, i, { text: `step ${i}`, toolCalls: [] });
  }

  return { sql: sql.sql, actor, journal };
}

function walkSteps(sql: SqlExecutor, actor: ActorHandle, limit: number): string[] {
  const texts: string[] = [];
  let cursor: SeekCursor | undefined;

  for (;;) {
    const view = present(readNodeTranscript(sql, actor, { runId: RUN, nodeId: NODE }, { limit, cursor }), 'the node transcript page');
    texts.unshift(...view.steps.items.map((s) => s.text));

    if (view.steps.status === 'end') return texts;
    cursor = view.steps.next;
  }
}

describe('node transcript paging', () => {
  test('a transcript longer than one page is reachable page by page', () => {
    const n = 7;
    const { sql, actor } = seeded(n);
    expect(walkSteps(sql, actor, 3)).toEqual(Array.from({ length: n }, (_, i) => `step ${i}`));
  });

  test('the first page is the newest work, oldest-first inside the page', () => {
    const { sql, actor } = seeded(7);
    const view = present(readNodeTranscript(sql, actor, { runId: RUN, nodeId: NODE }, { limit: 3 }), 'the first transcript page');
    const steps = view.steps;
    expect(steps.status).toBe('more');
    // Newest PAGE first; within it, reading order.
    expect(steps.items.map((s) => s.text)).toEqual(['step 4', 'step 5', 'step 6']);

    if (steps.status !== 'more') return;
    expect(steps.next.after).toBe(`${NODE}-s4`);
  });

  test('stepCount is the whole trace, not the page', () => {
    const { sql, actor } = seeded(7);
    const view = present(readNodeTranscript(sql, actor, { runId: RUN, nodeId: NODE }, { limit: 3 }), 'the first transcript page');

    expect(view.stepCount).toBe(7);
  });

  test('a short trace answers end, and the count still agrees', () => {
    const { sql, actor } = seeded(2);
    const view = present(readNodeTranscript(sql, actor, { runId: RUN, nodeId: NODE }, { limit: 8 }), 'the short trace page');

    expect(view.steps.status).toBe('end');
    expect(view.steps.items.map((s) => s.text)).toEqual(['step 0', 'step 1']);
    expect(view.stepCount).toBe(2);
  });

  test('a stale cursor is named, not silently answered from nothing', () => {
    const { sql, actor } = seeded(7);
    expect(() => readNodeTranscript(sql, actor, { runId: RUN, nodeId: NODE }, { limit: 3, cursor: { after: `${NODE}-s999` } }))
      .toThrow(/no longer in it/);
  });
  test('a rollout — no steps at all — pages as empty', () => {
    const ws = createTestWorkspace();
    const wsActor = createTestActors(ws.sql, ws.execRaw).main;
    void ws.sql`INSERT INTO search_nodes (actor_id, root_id, id, parent_id, task, action, observation, value, visits, depth, status)
      VALUES (${wsActor.actorId}, 'r', 'roll-1', null, ${'the task'}, ${'proposal one'}, ${'a proposal'}, 0.5, 1, 1, 'open')`;
    const view = present(readNodeTranscript(ws.sql, wsActor, { runId: 'r', nodeId: 'roll-1' }), 'the rollout transcript');

    expect(view.origin).toBe('rollout');
    expect(view.steps).toEqual({ status: 'end', items: [] });
    expect(view.stepCount).toBe(0);
    expect(view.toolCount).toBe(0);
  });
});

/** The first crumb is the run: a root records `action: ''`, so the crumb carries the run's
 *  derived name. */
describe('the search path names the run it belongs to', () => {
  function seedSearch(rootAction: string) {
    const ws = createTestWorkspace();
    const actor = createTestActors(ws.sql, ws.execRaw).main;
    void ws.sql`INSERT INTO search_nodes (actor_id, root_id, id, parent_id, task, action, observation, value, visits, depth, status)
      VALUES (${actor.actorId}, 'r', 'r', null, ${'Audit every reader of coupon.kind — the checkout package'}, ${rootAction}, '', 0, 0, 0, 'open')`;
    void ws.sql`INSERT INTO search_nodes (actor_id, root_id, id, parent_id, task, action, observation, value, visits, depth, status)
      VALUES (${actor.actorId}, 'r', 'n1', 'r', ${'Audit every reader of coupon.kind'}, ${'Walk the cart serializer'}, 'a proposal', 0.7, 2, 1, 'open')`;

    return { sql: ws.sql, actor };
  }

  test('an unlabelled root wears the name the run list shows', () => {
    const { sql, actor } = seedSearch('');
    const view = present(readNodeTranscript(sql, actor, { runId: 'r', nodeId: 'n1' }), 'the branch transcript');

    expect(view.path.map((crumb) => crumb.label))
      .toEqual(['Audit every reader of coupon.kind', 'Walk the cart serializer']);
  });

  test('a root the caller named keeps that name', () => {
    const { sql, actor } = seedSearch('coupon.kind readers');
    const view = present(readNodeTranscript(sql, actor, { runId: 'r', nodeId: 'n1' }), 'the branch transcript');

    expect(view.path[0].label).toBe('coupon.kind readers');
  });
});
