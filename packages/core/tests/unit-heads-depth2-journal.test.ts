// A depth-2 head's journal rows and step rows must share one store (the root), or assembleRun's join finds
// nothing. `HeadJournalPort` hands the controller a journal aimed at the root.

import { describe, expect, test } from 'bun:test';
import { createTestSql, createTestActorsOver, present } from '@kinu.run/test-utils';
import {
  HeadController,
  HeadJournal,
  initHeadsTables,
  type HeadJournalPort,
  type HeadReport,
  type HeadRuntime,
  type MergeOutput,
} from '@kinu.run/core';

const mergeOutput: MergeOutput = {
  narrative: 'merged',
  selected_decisions: [],
  unresolved_questions: [],
  recommendations: [],
  blind_spots: [],
};

/** A finished head report; steps go to the root journal as they land, so it carries only the count. */
function report(id: string, stepCount: number): HeadReport {
  return {
    id,
    status: 'completed',
    summary: `finding from ${id}`,
    evidence: [],
    decisions: [],
    artifactRefs: [],
    fileChanges: [],
    childHeadIds: [],
    toolCalls: [],
    stepCount,
    usage: { input: 10, output: 20 },
    wallClockMs: 5,
  };
}

function freshStore() {
  const { db, sql } = createTestSql();
  initHeadsTables((ddl) => db.exec(ddl));

  // Separate databases, each with its own actors: a handle validates against the database that issued it.
  return { sql, actor: createTestActorsOver(db).main };
}

/** Drive a split whose first child splits again; the caller picks where the depth-2 split journals. */
async function runSplitWithNestedSplit(opts: {
  rootJournal: HeadJournalPort;
  nestedJournal: HeadJournalPort;
  /**
   * Where head steps land: always the root in production. Separate from `nestedJournal` so a test can split
   * them.
   */
  stepSink: (headId: string, seq: number, step: { text: string; toolCalls: [] }) => void;
  afterNested?: (parentId: string) => void;
}): Promise<{ depth1Id: string; depth2Ids: string[] }> {
  const depth2Ids: string[] = [];
  let depth1Id = '';

  /** What a real head does: two steps reported as they land, then the report. */
  const runHead = (id: string): HeadReport => {
    opts.stepSink(id, 0, { text: `${id} looked at the code`, toolCalls: [] });
    opts.stepSink(id, 1, { text: `${id} concluded something`, toolCalls: [] });

    return report(id, 2);
  };

  const nestedRuntime: HeadRuntime = {
    async spawnHead(input) {
      depth2Ids.push(input.id);

      return { id: input.id, async run() { return runHead(input.id); }, async abort() {} };
    },
    async mergeLLM() { return mergeOutput; },
  };

  const rootRuntime: HeadRuntime = {
    async spawnHead(input) {
      depth1Id ||= input.id;
      const isFirst = input.id === depth1Id;

      return {
        id: input.id,
        async run() {
          if (isFirst) {
            // The intermediate head's controller journals wherever `nestedJournal` points.
            await new HeadController(nestedRuntime, opts.nestedJournal).run({
              parentHeadId: input.id,
              parentDepth: input.depth,
              rootId: input.rootId,
              inheritedContext: [],
              mode: 'build',
              request: { rationale: 'go deeper', heads: [{ task: 'deep dive', rationale: 'depth 2' }] },
              parentBudget: input.budget,
            });
            opts.afterNested?.(input.id);
          }

          return runHead(input.id);
        },
        async abort() {},
      };
    },
    async mergeLLM() { return mergeOutput; },
  };

  await new HeadController(rootRuntime, opts.rootJournal).run({
    parentHeadId: null,
    rootId: 'root-run',
    inheritedContext: [],
    mode: 'build',
    request: {
      rationale: 'split the investigation',
      heads: [
        { task: 'branch one', rationale: 'first angle' },
        { task: 'branch two', rationale: 'second angle' },
      ],
    },
    parentBudget: { maxDepth: 3, spawnedAt: Date.now() },
  });

  return { depth1Id, depth2Ids };
}

describe('C2 — a depth-2 head is readable from the root', () => {
  test('a nested synthesis keeps the root live and preserves its original task', async () => {
    const { sql, actor } = freshStore();
    const journal = new HeadJournal(sql, actor);
    const observed: Array<{ status?: string; rationale?: string; merged: boolean; parentStatus?: string }> = [];
    await runSplitWithNestedSplit({
      rootJournal: journal,
      nestedJournal: journal,
      stepSink: (id, seq, step) => journal.appendStep(id, seq, step),
      afterNested: (parentId) => {
        const run = journal.readRun('root-run');
        observed.push({
          status: run?.status, rationale: run?.rationale, merged: run?.merge != null,
          parentStatus: journal.readHead(parentId)?.status,
        });
      },
    });
    expect(observed).toEqual([{
      status: 'running', rationale: 'split the investigation', merged: false, parentStatus: 'running',
    }]);
    expect(journal.readRun('root-run')?.merge?.narrative).toBe('merged');
  });

  test("a depth-2 head's steps are readable, and sit beside its own journal row", async () => {
    const { sql, actor } = freshStore();
    const journal = new HeadJournal(sql, actor);

    const { depth2Ids } = await runSplitWithNestedSplit({
      rootJournal: journal,
      nestedJournal: journal,
      stepSink: (id, seq, step) => journal.appendStep(id, seq, step),
    });

    // Denominator: the recursion actually happened.
    expect(depth2Ids.length).toBe(1);
    const depth2Id = depth2Ids[0];

    // The journal row exists on the root...
    const row = journal.readHead(depth2Id);
    expect(row).not.toBeNull();
    expect(row?.depth).toBe(2);

    // ...and so do the step rows the surface joins to it.
    const steps = journal.readSteps(depth2Id);
    expect(steps.length).toBe(2);
    expect(steps[0]?.text).toContain(depth2Id);
  });

  test('the assembled run contains the depth-2 head, with a live last_step_at', async () => {
    const { sql, actor } = freshStore();
    const journal = new HeadJournal(sql, actor);

    const { depth2Ids } = await runSplitWithNestedSplit({
      rootJournal: journal,
      nestedJournal: journal,
      stepSink: (id, seq, step) => journal.appendStep(id, seq, step),
    });

    // The recursion happened; otherwise every assertion below passes vacuously.
    expect(depth2Ids.length).toBe(1);
    const depth2Id = depth2Ids[0];

    // readRun is what the Exploration surface renders.
    const run = present(journal.readRun('root-run'), 'the root-run record');
    const rendered = present(run.heads.find((h) => h.id === depth2Id), 'the depth-2 head in the run');

    expect(journal.readSteps(depth2Id).length).toBe(2);
    // `lastStepAt` is MAX(head_steps.created_at) over assembleRun's LEFT JOIN: null when the head row and steps
    // are in different stores.
    expect(rendered.lastStepAt).not.toBeNull();
    expect(present(rendered.lastStepAt, 'the depth-2 head last step time')).toBeGreaterThan(0);
  });

  test('journalling the nested split elsewhere is what made a depth-2 head unreadable', async () => {
    // Split stores: the intermediate head keeps its own journal while its children's steps go to the root.
    const root = freshStore();
    const intermediateFacet = freshStore();
    const rootJournal = new HeadJournal(root.sql, root.actor);

    const { depth2Ids } = await runSplitWithNestedSplit({
      rootJournal,
      nestedJournal: new HeadJournal(intermediateFacet.sql, intermediateFacet.actor),
      stepSink: (id, seq, step) => rootJournal.appendStep(id, seq, step),
    });

    const depth2Id = depth2Ids[0];

    // Same denominator: the depth-2 head really was spawned and really did report.
    expect(depth2Ids.length).toBe(1);

    // The steps reach the root but are orphaned: the head row is on the facet, so the head is missing from the
    // run.
    expect(rootJournal.readSteps(depth2Id).length).toBe(2);
    expect(rootJournal.readHead(depth2Id)).toBeNull();
    expect(present(rootJournal.readRun('root-run'), 'the root-run record').heads.map((h) => h.id)).not.toContain(depth2Id);

    // The head row is stranded one store away, not lost, so nothing errors.
    expect(new HeadJournal(intermediateFacet.sql, intermediateFacet.actor).readHead(depth2Id)).not.toBeNull();
  });
});
