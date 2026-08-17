// What the workspace spent, and what it could not account for.
//
// The defect this replaces was not a wrong number, it was a number with an
// undeclared scope: the panel showed the orchestrator's own turns and read as
// the whole workspace. So most of what is asserted here is about the SHAPE OF
// THE ADMISSION — that a silent producer is visible as unmeasured rather than
// free, that an unpriced call keeps the dollar figure a floor, and that a
// truncated window says so.
//
// The production schema, via `createTestWorkspace`: `head_journal` is one of the
// three stores this reads, and a harness that created fewer tables than a real
// workspace would be testing a shape no workspace has.
import { describe, expect, test } from 'bun:test';
import { RunEventRecorder } from '../src/events/recorder.js';
import { WORKSPACE_RUN_ID } from '../src/events/model-call.js';
import { HeadJournal } from '../src/heads/journal.js';
import { workspaceSpend } from '../src/read-models/workspace-spend.js';
import type { Usage } from '../src/usage.js';
import { createTestWorkspace } from './helpers.js';

const WINDOW = 50;

function rig() {
  const ws = createTestWorkspace();
  return { ws, events: new RunEventRecorder(ws.sql) };
}

/** One turn step, as the turn accumulator writes it. A step with no `usage` is a
 *  provider that said nothing, which is the case the totals must survive. */
function step(events: RunEventRecorder, usage: Usage, usd?: number): void {
  events.emit('run-1', usd === undefined
    ? { type: 'step_finish', stepIndex: 0, usage }
    : { type: 'step_finish', stepIndex: 0, usage, usd });
}

describe('workspaceSpend', () => {
  test('an empty workspace has no producers and no coverage to report', () => {
    const { ws, events } = rig();
    const spend = workspaceSpend({ events, sql: ws.sql }, { windowLimit: WINDOW });

    expect(spend.producers).toEqual([]);
    expect(spend.total.usage).toEqual({});
    expect(spend.total.usd).toBeUndefined();
    // Null, not 0: a workspace that has made no calls has no measured SHARE.
    // Rendering that as 0% would claim every call went unreported.
    expect(spend.coverage.reported).toBeNull();
    expect(spend.complete).toBe(true);
  });

  test('the turn loop lands as `agent`, and judges as themselves', () => {
    const { ws, events } = rig();
    step(events, { input: 1000, output: 100, cacheRead: 800 }, 0.01);
    step(events, { input: 1200, output: 90, cacheRead: 1100 }, 0.012);
    events.emit(WORKSPACE_RUN_ID, {
      type: 'model_call', source: 'judge', usage: { input: 400, output: 20 },
    });

    const spend = workspaceSpend({ events, sql: ws.sql }, { windowLimit: WINDOW });
    const bySource = Object.fromEntries(spend.producers.map((p) => [p.source, p]));

    expect(spend.producers.map((p) => p.source)).toEqual(['agent', 'judge']);
    expect(bySource.agent?.usage).toEqual({ input: 2200, output: 190, cacheRead: 1900 });
    expect(bySource.agent?.usd).toBeCloseTo(0.022, 10);
    // The judge's own numbers, never folded into the agent's — "where did $12
    // go" is the question behind the owner's, and it is a group-by over this.
    expect(bySource.judge?.usage).toEqual({ input: 400, output: 20 });
    expect(spend.total.usage).toEqual({ input: 2600, output: 210, cacheRead: 1900 });
    expect(spend.coverage.reported).toBe(1);
  });

  test('a producer the provider never measured is counted, never zeroed', () => {
    const { ws, events } = rig();
    step(events, { input: 1000, output: 100 }, 0.01);
    // The Workers AI embedder: its response carries no usage field of any kind.
    for (let i = 0; i < 3; i++) {
      events.emit(WORKSPACE_RUN_ID, { type: 'model_call', source: 'platform' });
    }

    const spend = workspaceSpend({ events, sql: ws.sql }, { windowLimit: WINDOW });
    const platform = spend.producers.find((p) => p.source === 'platform');

    expect(platform).toMatchObject({ calls: 3, callsWithoutUsage: 3 });
    // `{}` and not `{input: 0, output: 0}`: three calls of unknown cost, which
    // is a different claim from three free calls.
    expect(platform?.usage).toEqual({});
    expect(platform?.usd).toBeUndefined();
    expect(spend.coverage).toMatchObject({ calls: 4, measured: 1, silent: ['platform'] });
    expect(spend.coverage.reported).toBe(0.25);
    // The total still carries what WAS measured — a floor, not a refusal.
    expect(spend.total.usage).toEqual({ input: 1000, output: 100 });
  });

  test('a provider that genuinely reported zeros is not a silent one', () => {
    const { ws, events } = rig();
    events.emit(WORKSPACE_RUN_ID, {
      type: 'model_call', source: 'fast', usage: { input: 0, output: 0 },
    });

    const spend = workspaceSpend({ events, sql: ws.sql }, { windowLimit: WINDOW });

    expect(spend.producers[0]).toMatchObject({ calls: 1, callsWithoutUsage: 0 });
    expect(spend.producers[0]?.usage).toEqual({ input: 0, output: 0 });
    expect(spend.coverage.reported).toBe(1);
    expect(spend.coverage.silent).toEqual([]);
  });

  test('a measured call with no catalog rate keeps the dollar figure a floor', () => {
    const { ws, events } = rig();
    step(events, { input: 1000, output: 100 }, 0.01);
    // A judge runs cross-family on purpose, so the actor's catalog rate cannot
    // price it — reported in tokens, absent in dollars.
    events.emit(WORKSPACE_RUN_ID, {
      type: 'model_call', source: 'judge', usage: { input: 5000, output: 400 },
    });

    const spend = workspaceSpend({ events, sql: ws.sql }, { windowLimit: WINDOW });

    expect(spend.total.usd).toBeCloseTo(0.01, 10);
    expect(spend.total.unpricedCalls).toBe(1);
    // The tokens are NOT a floor — only the dollars are. Both facts, side by side.
    expect(spend.total.usage).toEqual({ input: 6000, output: 500 });
    expect(spend.coverage.reported).toBe(1);
  });

  test('a producer that reported some calls and not others is `partial`', () => {
    const { ws, events } = rig();
    events.emit(WORKSPACE_RUN_ID, {
      type: 'model_call', source: 'fast', usage: { input: 300, output: 30 },
    });
    events.emit(WORKSPACE_RUN_ID, { type: 'model_call', source: 'fast' });

    const spend = workspaceSpend({ events, sql: ws.sql }, { windowLimit: WINDOW });

    expect(spend.coverage.partial).toEqual(['fast']);
    expect(spend.coverage.silent).toEqual([]);
    expect(spend.coverage.reported).toBe(0.5);
  });

  test('heads come from their journal, with cache reads and neurons intact', () => {
    const { ws, events } = rig();
    const journal = new HeadJournal(ws.sql);
    journal.recordSplit('root-1', 'audit the parser', 1);
    for (const id of ['h1', 'h2']) {
      journal.insertSpawn({
        id, rootId: 'root-1', parentId: null, depth: 0, task: `task ${id}`, rationale: 'r',
        mode: 'build', inheritedContext: [], budget: { maxDepth: 3, spawnedAt: 1 },
        mergeStrategy: 'synthesize',
      });
    }
    journal.recordReport({
      id: 'h1', status: 'completed', summary: 's', wallClockMs: 7, stepCount: 1,
      usage: { input: 9000, output: 300, cacheRead: 8704, neurons: 1483.75 },
      evidence: [], decisions: [], artifactRefs: [], fileChanges: [],
      childHeadIds: [], toolCalls: [],
    });
    // A head whose provider said nothing. It did not cost zero.
    journal.recordReport({
      id: 'h2', status: 'completed', summary: 's', wallClockMs: 7, stepCount: 1, usage: {},
      evidence: [], decisions: [], artifactRefs: [], fileChanges: [],
      childHeadIds: [], toolCalls: [],
    });

    const spend = workspaceSpend({ events, sql: ws.sql }, { windowLimit: WINDOW });
    const head = spend.producers.find((p) => p.source === 'head');

    expect(head).toMatchObject({ calls: 2, callsWithoutUsage: 1 });
    // `neurons` is the one cost figure the PROVIDER reports, and it survives the
    // store now. `cacheWrite`/`reasoning` stay absent because nobody said so.
    expect(head?.usage).toEqual({ input: 9000, output: 300, cacheRead: 8704, neurons: 1483.75 });
    expect(spend.coverage.partial).toEqual(['head']);
  });

  test('a full window is reported as partial, and the extra row is not counted', () => {
    const { ws, events } = rig();
    for (let i = 0; i < 6; i++) step(events, { input: 10, output: 1 });

    const full = workspaceSpend({ events, sql: ws.sql }, { windowLimit: 4 });
    // 4 counted, not 5: the probe row exists only to prove more data follows.
    expect(full.producers[0]?.calls).toBe(4);
    expect(full.total.usage).toEqual({ input: 40, output: 4 });
    expect(full.complete).toBe(false);

    // Exactly-at-the-bound is the case a row count cannot distinguish: 6 rows
    // read with a window of 6 asks for 7, gets 6, and is therefore complete.
    expect(workspaceSpend({ events, sql: ws.sql }, { windowLimit: 6 }).complete).toBe(true);
  });

  test('the two row kinds get independent windows', () => {
    const { ws, events } = rig();
    // A busy turn loop must not push a rare judge call out of the total.
    for (let i = 0; i < 10; i++) step(events, { input: 10, output: 1 });
    events.emit(WORKSPACE_RUN_ID, {
      type: 'model_call', source: 'judge', usage: { input: 700, output: 70 },
    });

    const spend = workspaceSpend({ events, sql: ws.sql }, { windowLimit: 3 });

    expect(spend.producers.find((p) => p.source === 'agent')?.calls).toBe(3);
    expect(spend.producers.find((p) => p.source === 'judge')?.calls).toBe(1);
    expect(spend.complete).toBe(false);
  });

  test('producers are ordered by measured tokens, unmeasured ones last', () => {
    const { ws, events } = rig();
    events.emit(WORKSPACE_RUN_ID, { type: 'model_call', source: 'platform' });
    events.emit(WORKSPACE_RUN_ID, {
      type: 'model_call', source: 'fast', usage: { input: 100, output: 10 },
    });
    step(events, { input: 9000, output: 900 });

    const spend = workspaceSpend({ events, sql: ws.sql }, { windowLimit: WINDOW });

    expect(spend.producers.map((p) => p.source)).toEqual(['agent', 'fast', 'platform']);
  });

  test('a call filed with no run open still reaches the total, and is not a run', () => {
    const { ws, events } = rig();
    events.emit(WORKSPACE_RUN_ID, {
      type: 'model_call', source: 'reflection', usage: { input: 800, output: 40 },
    });
    step(events, { input: 9000, output: 900 });

    expect(workspaceSpend({ events, sql: ws.sql }, { windowLimit: WINDOW }).total.usage)
      .toEqual({ input: 9800, output: 940 });
    // …and the owner's run history does not grow a run the agent never had. The
    // real run beside it is what makes this decidable: an empty list would read
    // the same whether the exclusion held or the query failed.
    expect(events.listRunsBefore(null, WINDOW).map((r) => r.runId)).toEqual(['run-1']);
  });
});
