// Workspace spend: a silent producer shows as unmeasured, not free; an unpriced call keeps the
// dollar figure a floor; totals are never bounded by a recent-rows window.
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { RunEventRecorder } from '../src/events/recorder';
import { WORKSPACE_RUN_ID } from '../src/events/model-call';
import { buildModelCallEvent } from '../src/events/model-call-event';
import type { ModelPricing } from '../src/providers/types';
import { HeadJournal } from '../src/heads/journal';
import { workspaceSpend } from '../src/read-models/workspace-spend';
import { MissionGovernor } from '../src/mission-budget';
import { usageTotal, USAGE_FIELDS, UsageSchema, type Usage } from '../src/usage';
import { createTestActors } from '@kinu.run/test-utils';
import type { HeadReport } from '../src/heads/types';
import { explorationActorKey } from '../src/index';
import { createTestWorkspace } from './helpers';
import { defaultLoopOrigin } from '../src/scaffold/bootstrap';

/** Not a bound on any spend figure; nothing passes a window to `workspaceSpend`. */
const RUN_LIST_LIMIT = 50;

function rig() {
  const ws = createTestWorkspace();

  const actors = createTestActors(ws.sql, ws.execRaw);
  const actor = actors.main;

  return { ws, actor, actors, events: new RunEventRecorder(ws.sql, actor) };
}

function headRig(subordinate = false) {
  const fixture = rig();
  const parent = subordinate ? fixture.actors.sibling('helper') : fixture.actor;

  const head = fixture.actors.directory.create({
    parent, name: explorationActorKey('head-a'), creationId: 'head-a', kind: 'head', lifetime: 'task',
  });

  const journal = new HeadJournal(fixture.ws.sql, parent);

  const input = {
    id: 'head-a', rootId: 'root-a', parentId: null, depth: 0, task: 'inspect', rationale: 'inspect',
    mode: 'build', inheritedContext: [], budget: { maxDepth: 3, spawnedAt: 1 },
    mergeStrategy: 'synthesize', loop: defaultLoopOrigin('head'),
  } satisfies Parameters<HeadJournal['insertSpawn']>[0];

  journal.recordSplit('root-a', 'inspect', 1);
  journal.insertSpawn(input);

  const report: HeadReport = {
    id: 'head-a', status: 'completed', summary: 'done', wallClockMs: 1, stepCount: 1, usage: { input: 100, output: 7 },
    evidence: [], decisions: [], artifactRefs: [], fileChanges: [], childHeadIds: [], toolCalls: [],
  };

  return { ...fixture, head, journal, input, report, headEvents: new RunEventRecorder(fixture.ws.sql, head) };
}

/** A step with no `usage` is a provider that said nothing; totals must survive it. */
function step(events: RunEventRecorder, usage: Usage, usd?: number): void {
  events.emit('run-1', usd === undefined
    ? { type: 'step_finish', stepIndex: 0, usage }
    : { type: 'step_finish', stepIndex: 0, usage, usd });
}

describe('workspaceSpend', () => {
  test('running head usage becomes reported usage once without losing auxiliary calls', () => {
    const { ws, actor, events, journal, report, headEvents } = headRig();
    step(headEvents, report.usage, 0.01);
    headEvents.emit(WORKSPACE_RUN_ID, { type: 'model_call', source: 'compaction', usage: { input: 5, output: 1 } });
    const running = workspaceSpend({ sql: ws.sql, actor, events });

    expect(running.total.usage).toEqual({ input: 105, output: 8 });
    expect(running.producers.map((row) => row.source)).toEqual(['head', 'compaction']);
    journal.recordReport(report);
    const completed = workspaceSpend({ sql: ws.sql, actor, events });

    expect(completed.total.usage).toEqual(running.total.usage);
    expect(completed.total.usd).toBe(running.total.usd);
    expect(completed.total.calls).toBe(running.total.calls);
  });

  test('an unreported final report does not erase measured steps or duplicate silent steps', () => {
    for (const usage of [{ input: 100, output: 7 }, {}]) {
      const { ws, actor, events, journal, report, headEvents } = headRig();
      step(headEvents, usage);
      journal.recordReport({ ...report, status: 'errored', usage: {} });
      const spend = workspaceSpend({ sql: ws.sql, actor, events });

      expect(spend.total.usage).toEqual(usage);
      expect(spend.total.calls).toBe(1);
      expect(spend.producers.map((row) => row.source)).toEqual(['head']);
    }
  });

  test('a hired actor head report counts even after its trace is removed', () => {
    const { ws, actor, events, head, journal, report, headEvents } = headRig(true);
    step(headEvents, report.usage);
    journal.recordReport(report);
    void ws.sql`DELETE FROM run_events WHERE actor_id = ${head.actorId}`;

    expect(workspaceSpend({ sql: ws.sql, actor, events }).total.usage).toEqual(report.usage);
  });

  test('identical head ids under different parents remain separate executions', () => {
    const { ws, actor, actors, events, journal, input, report, headEvents } = headRig();
    const parent = actors.sibling('helper');

    const siblingHead = actors.directory.create({
      parent, name: explorationActorKey(input.id), creationId: input.id, kind: 'head', lifetime: 'task',
    });

    const siblingJournal = new HeadJournal(ws.sql, parent);
    siblingJournal.recordSplit(input.rootId, 'another parent', 1);
    siblingJournal.insertSpawn(input);
    step(headEvents, report.usage);
    step(new RunEventRecorder(ws.sql, siblingHead), { input: 250, output: 13 });
    journal.recordReport(report);
    siblingJournal.recordReport({ ...report, usage: { input: 250, output: 13 } });
    const spend = workspaceSpend({ sql: ws.sql, actor, events });

    expect(spend.total.usage).toEqual({ input: 350, output: 20 });
    expect(spend.total.calls).toBe(2);
  });

  test('a report replaces only its attempt, retaining earlier interrupted usage', () => {
    const { ws, actor, events, head, journal, input, report, headEvents } = headRig();
    step(headEvents, { input: 40, output: 3 });
    const previous = '2000-01-01T00:00:00.000Z';
    void ws.sql`UPDATE run_events SET ts = ${previous}, payload = json_set(payload, '$.timestamp', ${previous})
      WHERE actor_id = ${head.actorId}`;
    journal.insertSpawn({ ...input, budget: { ...input.budget, spawnedAt: Date.parse('2001-01-01T00:00:00.000Z') } });
    step(headEvents, report.usage);
    journal.recordReport(report);
    const spend = workspaceSpend({ sql: ws.sql, actor, events });

    expect(spend.total.usage).toEqual({ input: 140, output: 10 });
    expect(spend.producers.map((row) => row.source)).toEqual(['head']);
    expect(headEvents.read('run-1')).toHaveLength(2);
  });

  test('an empty workspace has no producers and no coverage to report', () => {
    const { ws, events, actor } = rig();
    const spend = workspaceSpend({ events, sql: ws.sql, actor });

    expect(spend.producers).toEqual([]);
    expect(spend.total.usage).toEqual({});
    expect(spend.total.usd).toBeUndefined();
    // Null, not 0: no calls means no measured share.
    expect(spend.coverage.reported).toBeNull();
    expect(spend.coverage.calls).toBe(0);
  });

  test('the turn loop lands as `agent`, and judges as themselves', () => {
    const { ws, events, actor } = rig();
    step(events, { input: 1000, output: 100, cacheRead: 800 }, 0.01);
    step(events, { input: 1200, output: 90, cacheRead: 1100 }, 0.012);
    events.emit(WORKSPACE_RUN_ID, {
      type: 'model_call', source: 'judge', usage: { input: 400, output: 20 },
    });

    const spend = workspaceSpend({ events, sql: ws.sql, actor });
    const bySource = Object.fromEntries(spend.producers.map((p) => [p.source, p]));

    expect(spend.producers.map((p) => p.source)).toEqual(['agent', 'judge']);
    expect(bySource.agent?.usage).toEqual({ input: 2200, output: 190, cacheRead: 1900 });
    expect(bySource.agent?.usd).toBeCloseTo(0.022, 10);
    expect(bySource.judge?.usage).toEqual({ input: 400, output: 20 });
    expect(spend.total.usage).toEqual({ input: 2600, output: 210, cacheRead: 1900 });
    expect(spend.coverage.reported).toBe(1);
  });

  test('a producer the provider never measured is counted, never zeroed', () => {
    const { ws, events, actor } = rig();
    step(events, { input: 1000, output: 100 }, 0.01);

    // Workers AI embedder: its response carries no usage field.
    for (let i = 0; i < 3; i++) {
      events.emit(WORKSPACE_RUN_ID, { type: 'model_call', source: 'platform' });
    }

    const spend = workspaceSpend({ events, sql: ws.sql, actor });
    const platform = spend.producers.find((p) => p.source === 'platform');

    expect(platform).toMatchObject({ calls: 3, callsWithoutUsage: 3 });
    // `{}`, not zeros: unknown cost differs from free.
    expect(platform?.usage).toEqual({});
    expect(platform?.usd).toBeUndefined();
    expect(spend.coverage).toMatchObject({ calls: 4, measured: 1, silent: ['platform'] });
    expect(spend.coverage.reported).toBe(0.25);
    expect(spend.total.usage).toEqual({ input: 1000, output: 100 });
  });

  test('a provider that genuinely reported zeros is not a silent one', () => {
    const { ws, events, actor } = rig();
    events.emit(WORKSPACE_RUN_ID, {
      type: 'model_call', source: 'fast', usage: { input: 0, output: 0 },
    });

    const spend = workspaceSpend({ events, sql: ws.sql, actor });

    expect(spend.producers[0]).toMatchObject({ calls: 1, callsWithoutUsage: 0 });
    expect(spend.producers[0]?.usage).toEqual({ input: 0, output: 0 });
    expect(spend.coverage.reported).toBe(1);
    expect(spend.coverage.silent).toEqual([]);
  });

  test('a measured call with no catalog rate keeps the dollar figure a floor', () => {
    const { ws, events, actor } = rig();
    step(events, { input: 1000, output: 100 }, 0.01);
    // A cross-family judge cannot be priced at the actor's catalog rate: tokens only.
    events.emit(WORKSPACE_RUN_ID, {
      type: 'model_call', source: 'judge', usage: { input: 5000, output: 400 },
    });

    const spend = workspaceSpend({ events, sql: ws.sql, actor });

    expect(spend.total.usd).toBeCloseTo(0.01, 10);
    expect(spend.total.unpricedCalls).toBe(1);
    // Only the dollars are a floor, not the tokens.
    expect(spend.total.usage).toEqual({ input: 6000, output: 500 });
    expect(spend.coverage.reported).toBe(1);
  });

  test('a producer that reported some calls and not others is `partial`', () => {
    const { ws, events, actor } = rig();
    events.emit(WORKSPACE_RUN_ID, {
      type: 'model_call', source: 'fast', usage: { input: 300, output: 30 },
    });
    events.emit(WORKSPACE_RUN_ID, { type: 'model_call', source: 'fast' });

    const spend = workspaceSpend({ events, sql: ws.sql, actor });

    expect(spend.coverage.partial).toEqual(['fast']);
    expect(spend.coverage.silent).toEqual([]);
    expect(spend.coverage.reported).toBe(0.5);
  });

  test('heads come from their journal, with cache reads and neurons intact', () => {
    const { ws, events, actor } = rig();
    const journal = new HeadJournal(ws.sql, actor);
    journal.recordSplit('root-1', 'audit the parser', 1);

    for (const id of ['h1', 'h2']) {
      journal.insertSpawn({
        id, rootId: 'root-1', parentId: null, depth: 0, task: `task ${id}`, rationale: 'r',
        mode: 'build', inheritedContext: [], budget: { maxDepth: 3, spawnedAt: 1 },
        mergeStrategy: 'synthesize',
        loop: defaultLoopOrigin('head'),
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

    const spend = workspaceSpend({ events, sql: ws.sql, actor });
    const head = spend.producers.find((p) => p.source === 'head');

    expect(head).toMatchObject({ calls: 2, callsWithoutUsage: 1 });
    // `neurons` is provider-reported; `cacheWrite`/`reasoning` stay absent because nobody said so.
    expect(head?.usage).toEqual({ input: 9000, output: 300, cacheRead: 8704, neurons: 1483.75 });
    expect(spend.coverage.partial).toEqual(['head']);
  });

  test('a total is not bounded by any window, however long the log gets', () => {
    const { ws, events, actor } = rig();

    // 450 steps: past `readRecentByType`'s 200-row default and ACTIVITY_STEP_WINDOW, so any windowed
    // fold would make this total a floor.
    for (let i = 0; i < 450; i++) step(events, { input: 10, output: 1 }, 0.001);

    for (let i = 0; i < 300; i++) {
      events.emit(WORKSPACE_RUN_ID, {
        type: 'model_call', source: 'judge', usage: { input: 20, output: 2 },
      });
    }

    const spend = workspaceSpend({ events, sql: ws.sql, actor });
    const agent = spend.producers.find((p) => p.source === 'agent');
    const judge = spend.producers.find((p) => p.source === 'judge');

    // Assert the agent row as well as the total: the under-count was per-producer.
    expect(agent).toMatchObject({ calls: 450, unpricedCalls: 0 });
    expect(agent?.usage).toEqual({ input: 4_500, output: 450 });
    expect(agent?.usd).toBeCloseTo(0.45, 10);
    expect(judge).toMatchObject({ calls: 300, unpricedCalls: 300 });
    expect(judge?.usage).toEqual({ input: 6_000, output: 600 });
    expect(spend.total.usage).toEqual({ input: 10_500, output: 1_050 });
    expect(spend.coverage).toMatchObject({ calls: 750, measured: 750, reported: 1 });
  });

  test('one busy producer cannot crowd another out of the total', () => {
    const { ws, events, actor } = rig();

    // A windowed read drops the rare judge call behind a busy turn loop.
    for (let i = 0; i < 400; i++) step(events, { input: 10, output: 1 });
    events.emit(WORKSPACE_RUN_ID, {
      type: 'model_call', source: 'judge', usage: { input: 700, output: 70 },
    });

    const spend = workspaceSpend({ events, sql: ws.sql, actor });

    expect(spend.producers.find((p) => p.source === 'agent')?.calls).toBe(400);
    expect(spend.producers.find((p) => p.source === 'judge')?.usage)
      .toEqual({ input: 700, output: 70 });
  });

  test('the stored payload really carries the fields the aggregate reads', () => {
    const { ws, actor, events } = rig();

    const every: Required<Usage> = {
      input: 11, output: 7, cacheRead: 5, cacheWrite: 3, cacheWrite1h: 2, reasoning: 1,
      neurons: 0.5,
    };

    step(events, every, 0.02);

    // `json_extract` paths cannot be typechecked, so they are pinned by parsing a real writer's row
    // through `UsageSchema` (which returns only declared keys).
    const [row] = ws.sql<{ payload: string }>`
      SELECT payload FROM run_events
      WHERE actor_id = ${actor.actorId} AND type = 'step_finish'`;

    const payload = v.parse(
      v.object({ usage: UsageSchema, usd: v.number() }),
      JSON.parse(row.payload),
    );

    expect(Object.keys(payload.usage).sort()).toEqual([...USAGE_FIELDS].sort());
    expect(payload.usd).toBeCloseTo(0.02, 10);

    // A column the SQL forgot would read as a field nobody reported.
    const spend = workspaceSpend({ events, sql: ws.sql, actor });
    expect(spend.total.usage).toEqual(every);
    expect(USAGE_FIELDS.filter((f) => spend.total.usage[f] === undefined)).toEqual([]);
    expect(spend.total.usd).toBeCloseTo(0.02, 10);
  });

  test('producers are ordered by measured tokens, unmeasured ones last', () => {
    const { ws, events, actor } = rig();
    events.emit(WORKSPACE_RUN_ID, { type: 'model_call', source: 'platform' });
    events.emit(WORKSPACE_RUN_ID, {
      type: 'model_call', source: 'fast', usage: { input: 100, output: 10 },
    });
    step(events, { input: 9000, output: 900 });

    const spend = workspaceSpend({ events, sql: ws.sql, actor });

    expect(spend.producers.map((p) => p.source)).toEqual(['agent', 'fast', 'platform']);
  });

  test('a call filed with no run open still reaches the total, and is not a run', () => {
    const { ws, events, actor } = rig();
    events.emit(WORKSPACE_RUN_ID, {
      type: 'model_call', source: 'reflection', usage: { input: 800, output: 40 },
    });
    step(events, { input: 9000, output: 900 });

    expect(workspaceSpend({ events, sql: ws.sql, actor }).total.usage)
      .toEqual({ input: 9800, output: 940 });
    // The real run beside it distinguishes "excluded" from "query failed".
    expect(events.listRunsBefore(null, RUN_LIST_LIMIT).map((r) => r.runId)).toEqual(['run-1']);
  });

  test('a 1h-retention write reaches the total as a FLOOR, and an exact call does not', () => {
    const { ws, events, actor } = rig();
    // models.dev rates, verbatim. One cache-write rate, so the 1h call is charged at 5m and is short.
    const pricing: ModelPricing = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
    const SPEC = 'anthropic/claude-sonnet-4-5';

    // Through the real producer, so a dropped marker fails here.
    const call = (cacheWrite1h?: number) => buildModelCallEvent({
      source: 'judge',
      spec: SPEC,
      usage: cacheWrite1h === undefined
        ? { input: 3_084, output: 500, cacheRead: 2_048, cacheWrite: 1_024 }
        : { input: 3_084, output: 500, cacheRead: 2_048, cacheWrite: 1_024, cacheWrite1h },
    }, { effectiveSpec: SPEC, pricing });

    events.emit('run-1', call());
    events.emit('run-1', call(1_000));

    const spend = workspaceSpend({ events, sql: ws.sql, actor });
    const judge = spend.producers.find((p) => p.source === 'judge');
    expect(judge?.unpricedCalls).toBe(0);
    expect(judge?.usd).toBeCloseTo(2 * (12 * 3 + 2_048 * 0.3 + 1_024 * 3.75 + 500 * 15) / 1_000_000, 12);
    // One estimated call is enough to make the sum a floor; the count says how many.
    expect(judge?.floorPricedCalls).toBe(1);
    expect(spend.total.floorPricedCalls).toBe(1);
  });

  test('a workspace whose writes were all short-retention reports no floor at all', () => {
    const { ws, events, actor } = rig();
    // Explicit zero: a presence check could get this wrong.
    step(events, { input: 3_084, output: 500, cacheRead: 2_048, cacheWrite: 1_024, cacheWrite1h: 0 }, 0.02);
    const spend = workspaceSpend({ events, sql: ws.sql, actor });
    expect(spend.total.floorPricedCalls).toBe(0);
    expect(spend.total.usd).toBeCloseTo(0.02, 10);
  });
});

describe('workspaceSpend — the breakdown', () => {
  test('the off-turn share is every measured token no turn of this agent spent', () => {
    const { ws, events, actor } = rig();
    step(events, { input: 700, output: 100 });          // agent: 800
    events.emit(WORKSPACE_RUN_ID, {
      type: 'model_call', source: 'reflection', usage: { input: 150, output: 10 },
    });
    events.emit(WORKSPACE_RUN_ID, {
      type: 'model_call', source: 'judge', usage: { input: 30, output: 10 },
    });

    const spend = workspaceSpend({ events, sql: ws.sql, actor });

    expect(usageTotal(spend.total.usage)).toBe(1000);
    expect(spend.offTurnShare).toBeCloseTo(0.2, 10);
  });

  test('a workspace whose only spend is its own turns has an off-turn share of zero', () => {
    const { ws, events, actor } = rig();
    step(events, { input: 700, output: 100 });

    expect(workspaceSpend({ events, sql: ws.sql, actor }).offTurnShare).toBe(0);
  });

  test('nothing measured has NO share — absent, never 0%', () => {
    const { ws, events, actor } = rig();
    events.emit(WORKSPACE_RUN_ID, { type: 'model_call', source: 'platform' });

    // Spent something, measured none: 0% off-turn would misread as "all agent".
    const spend = workspaceSpend({ events, sql: ws.sql, actor });
    expect(spend.coverage.calls).toBe(1);
    expect(spend.offTurnShare).toBeNull();
  });

  test('missions come from the ledger the caps are enforced against, dearest first', () => {
    const { ws, events, actor } = rig();
    step(events, { input: 700, output: 100 });
    const governor = new MissionGovernor({ storage: { sql: ws.sql, execRaw: ws.execRaw }, actor });
    governor.declare('checkout-fixes', { usd: 25 }, {});
    governor.declare('sweep', { tokens: 5_000 }, { parent: 'checkout-fixes' });
    governor.debit(4_000, { labels: ['sweep'], calls: 2 });
    governor.debit(100, { labels: ['checkout-fixes'], calls: 1 });

    const spend = workspaceSpend({ events, sql: ws.sql, actor });

    // The ledger rolls a debit up the whole chain, so the parent carries the child's.
    expect(spend.missions.map((m) => [m.label, m.parent, m.spent.tokens, m.calls]))
      .toEqual([
        ['checkout-fixes', null, 4_100, 3],
        ['sweep', 'checkout-fixes', 4_000, 2],
      ]);
    expect(spend.missions[1].remaining.tokens).toBe(1_000);
    expect(spend.missions[1].exhausted).toBe(false);
    // Producer rows and mission labels overlap; adding them double-counts.
    expect(usageTotal(spend.total.usage)).toBe(800);
  });

  test('a workspace that declared no budget reports no missions and does not fail', () => {
    const { ws, events, actor } = rig();
    step(events, { input: 700, output: 100 });

    // No `mission_budget` table here; an unbudgeted workspace must not read as broken.
    expect(workspaceSpend({ events, sql: ws.sql, actor }).missions).toEqual([]);
  });
});
