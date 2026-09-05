// C2 — a depth-2 head's journal rows and its step rows must live in ONE store,
// so the surface can read them.
//
// The defect: a recursive split ran its HeadController with a journal built over
// the INTERMEDIATE facet's own SQLite. A depth-1 head therefore wrote its
// children's spawn/report rows into its own Durable Object, while the root held
// the step rows — and `HeadJournal.assembleRun` reads head_journal on the ROOT
// and joins head_steps to it by head_id. With the two halves one DO apart the
// join could never match, so a depth-2 head was unreadable from anywhere: the
// root had steps with no head row, the facet had a head row nobody queried, and
// the run rendered with the child heads missing.
//
// The fix is `HeadJournalPort`: the controller no longer owns a journal, it is
// handed one, and the CF facet hands it an RPC-backed port aimed at the root.
// These tests assert the property that fix exists for, and the last one asserts
// the defect itself so the others cannot pass vacuously.

import { describe, expect, test } from 'bun:test';
import { createTestSql } from '@kinu.run/test-utils';
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

/**
 * A finished head report. The trace is NOT carried here — a head writes each
 * step to the ROOT's journal as it lands (`HeadInferenceDeps.reportStep` →
 * `OrchestratorAgent.recordHeadStep` → `HeadJournal.appendStep`), so the report
 * only states how many there were. `stepSink` below is that path.
 */
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
  initHeadsTables((ddl) => db.exec(ddl), sql);
  return { sql };
}

/**
 * Drive a split whose FIRST child recursively splits again, and let the caller
 * decide where the nested (depth-2) split journals. That single choice is the
 * whole defect: `nestedJournal === rootJournal` is the fixed behaviour, a
 * separate store is what shipped.
 */
async function runSplitWithNestedSplit(opts: {
  rootJournal: HeadJournalPort;
  nestedJournal: HeadJournalPort;
  /** Where a head's steps land. Always the ROOT in production: a facet reports
   *  each step over its parent stub, never into its own storage. Passing it
   *  separately from `nestedJournal` is what lets the third test reproduce the
   *  defect — head rows one store away from the steps that describe them. */
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
            // The intermediate head splits again. Its controller journals
            // wherever `nestedJournal` points — the one variable under test.
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
    parentBudget: { maxDepth: 3, maxWallClockMs: undefined, spawnedAt: Date.now() },
  });

  return { depth1Id, depth2Ids };
}

describe('C2 — a depth-2 head is readable from the root', () => {
  test('a nested synthesis keeps the root live and preserves its original task', async () => {
    const { sql } = freshStore();
    const journal = new HeadJournal(sql);
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
    const { sql } = freshStore();
    const journal = new HeadJournal(sql);

    const { depth2Ids } = await runSplitWithNestedSplit({
      rootJournal: journal,
      nestedJournal: journal, // the fix: one place for the whole tree
      stepSink: (id, seq, step) => journal.appendStep(id, seq, step),
    });

    // Denominator: the recursion actually happened.
    expect(depth2Ids.length).toBe(1);
    const depth2Id = depth2Ids[0]!;

    // The journal row exists on the root...
    const row = journal.readHead(depth2Id);
    expect(row).not.toBeNull();
    expect(row?.depth).toBe(2);

    // ...and so do the step rows, which is what the surface joins to it. This is
    // the assertion that was impossible before: steps and head row one DO apart.
    const steps = journal.readSteps(depth2Id);
    expect(steps.length).toBe(2);
    expect(steps[0]?.text).toContain(depth2Id);
  });

  test('the assembled run contains the depth-2 head, with a live last_step_at', async () => {
    const { sql } = freshStore();
    const journal = new HeadJournal(sql);

    const { depth2Ids } = await runSplitWithNestedSplit({
      rootJournal: journal,
      nestedJournal: journal,
      stepSink: (id, seq, step) => journal.appendStep(id, seq, step),
    });
    // The denominator this whole file turns on: a run that never recursed would
    // satisfy every assertion below vacuously, and "STEPS 0" is exactly what a
    // vacuous pass looks like.
    expect(depth2Ids.length).toBe(1);
    const depth2Id = depth2Ids[0]!;

    // readRun is what the Exploration surface renders — the real reader, not a
    // hand-rolled query, so this asserts the user-visible outcome.
    const run = journal.readRun('root-run');
    expect(run).not.toBeNull();
    const rendered = run!.heads.find((h) => h.id === depth2Id);
    expect(rendered).toBeDefined();
    expect(journal.readSteps(depth2Id).length).toBe(2);
    // `lastStepAt` is `MAX(head_steps.created_at)` over the LEFT JOIN in
    // assembleRun. It is the field that reads null — and renders as "STEPS 0",
    // no progress, a branch that looks dead — whenever the head row and its
    // steps are in different stores. Non-null AND positive: a LEFT JOIN that
    // matched nothing yields null here, never 0.
    expect(rendered!.lastStepAt).not.toBeNull();
    expect(rendered!.lastStepAt!).toBeGreaterThan(0);
  });

  test('journalling the nested split elsewhere is what made a depth-2 head unreadable', async () => {
    // The pre-fix wiring, reproduced exactly: the intermediate head keeps its own
    // journal while its children's steps still go to the root. Without this test
    // the two above could pass for reasons unrelated to where the rows land.
    const root = freshStore();
    const intermediateFacet = freshStore();
    const rootJournal = new HeadJournal(root.sql);

    const { depth2Ids } = await runSplitWithNestedSplit({
      rootJournal,
      nestedJournal: new HeadJournal(intermediateFacet.sql),
      stepSink: (id, seq, step) => rootJournal.appendStep(id, seq, step),
    });
    const depth2Id = depth2Ids[0]!;

    // Same denominator: the depth-2 head really was spawned and really did report.
    expect(depth2Ids.length).toBe(1);

    // The steps DID arrive at the root — and are orphaned there, because the head
    // row they belong to went to the facet. Nothing errored; the LEFT JOIN simply
    // has no row to hang them on, so the head is absent from the rendered run.
    expect(rootJournal.readSteps(depth2Id).length).toBe(2);
    expect(rootJournal.readHead(depth2Id)).toBeNull();
    expect(rootJournal.readRun('root-run')!.heads.map((h) => h.id)).not.toContain(depth2Id);

    // And the head row is not lost either, merely stranded one store away —
    // which is why this never surfaced as an error.
    expect(new HeadJournal(intermediateFacet.sql).readHead(depth2Id)).not.toBeNull();
  });
});
