// What the workspace spent, and what it could not account for.
//
// The defect this replaces was not a wrong number, it was a number with an
// undeclared scope: the panel showed the orchestrator's own turns and read as
// the whole workspace. So much of what is asserted here is about the SHAPE OF
// THE ADMISSION — that a silent producer is visible as unmeasured rather than
// free, and that an unpriced call keeps the dollar figure a floor.
//
// The second defect was a CEILING on the answer: the producer totals were folded
// over a bounded recent-rows read, so a workspace whose log outgrew the window
// had its total silently replaced by a floor. `a total is not bounded by any
// window' below is that defect's regression test and it is the point of the
// suite: it seeds more rows than any window this repo ever used.
//
// The production schema, via `createTestWorkspace`: `head_journal` is one of the
// three stores this reads, and a harness that created fewer tables than a real
// workspace would be testing a shape no workspace has.
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { RunEventRecorder } from '../src/events/recorder';
import { WORKSPACE_RUN_ID } from '../src/events/model-call';
import { HeadJournal } from '../src/heads/journal';
import { workspaceSpend } from '../src/read-models/workspace-spend';
import { MissionGovernor } from '../src/mission-budget';
import { usageTotal, USAGE_FIELDS, UsageSchema, type Usage } from '../src/usage';
import { createTestWorkspace } from './helpers';

/** Big enough for the run-list read below, and deliberately NOT a bound on any
 *  spend figure — nothing here passes a window to `workspaceSpend` any more. */
const RUN_LIST_LIMIT = 50;

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
    const spend = workspaceSpend({ events, sql: ws.sql });

    expect(spend.producers).toEqual([]);
    expect(spend.total.usage).toEqual({});
    expect(spend.total.usd).toBeUndefined();
    // Null, not 0: a workspace that has made no calls has no measured SHARE.
    // Rendering that as 0% would claim every call went unreported.
    expect(spend.coverage.reported).toBeNull();
    expect(spend.coverage.calls).toBe(0);
  });

  test('the turn loop lands as `agent`, and judges as themselves', () => {
    const { ws, events } = rig();
    step(events, { input: 1000, output: 100, cacheRead: 800 }, 0.01);
    step(events, { input: 1200, output: 90, cacheRead: 1100 }, 0.012);
    events.emit(WORKSPACE_RUN_ID, {
      type: 'model_call', source: 'judge', usage: { input: 400, output: 20 },
    });

    const spend = workspaceSpend({ events, sql: ws.sql });
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

    const spend = workspaceSpend({ events, sql: ws.sql });
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

    const spend = workspaceSpend({ events, sql: ws.sql });

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

    const spend = workspaceSpend({ events, sql: ws.sql });

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

    const spend = workspaceSpend({ events, sql: ws.sql });

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

    const spend = workspaceSpend({ events, sql: ws.sql });
    const head = spend.producers.find((p) => p.source === 'head');

    expect(head).toMatchObject({ calls: 2, callsWithoutUsage: 1 });
    // `neurons` is the one cost figure the PROVIDER reports, and it survives the
    // store now. `cacheWrite`/`reasoning` stay absent because nobody said so.
    expect(head?.usage).toEqual({ input: 9000, output: 300, cacheRead: 8704, neurons: 1483.75 });
    expect(spend.coverage.partial).toEqual(['head']);
  });

  test('a total is not bounded by any window, however long the log gets', () => {
    const { ws, events } = rig();
    // WHAT THIS DEFENDS, measured rather than reasoned about. On a synthetic log
    // of 8,000 turn steps and 2,000 judge calls, the shipped fold at the CLI's
    // own SPEND_WINDOW of 2000 returned 2,001 of the 8,000 agent steps and
    // printed the result as the workspace total: a 4x under-count on the row the
    // owner reads first. Driven end to end against a real local workspace, a
    // 2,600-step log reported 4,080,000 tokens and $4.20 where the truth was
    // 5,304,000 and $5.46 — 20.8% of the tokens and 23% of the dollars behind a
    // one-line caveat. The aggregate that replaced it costs 62 ms against 55 ms
    // for those two windowed reads, so completeness was never the expensive
    // option; it was only the un-asked-for one.
    //
    // 450 steps here: past `readRecentByType`'s 200-row default, past the cloud
    // eval arm's 400 and the deployed panel's ACTIVITY_STEP_WINDOW. Every one of
    // those numbers used to turn this total into a floor.
    for (let i = 0; i < 450; i++) step(events, { input: 10, output: 1 }, 0.001);
    for (let i = 0; i < 300; i++) {
      events.emit(WORKSPACE_RUN_ID, {
        type: 'model_call', source: 'judge', usage: { input: 20, output: 2 },
      });
    }

    const spend = workspaceSpend({ events, sql: ws.sql });
    const agent = spend.producers.find((p) => p.source === 'agent');
    const judge = spend.producers.find((p) => p.source === 'judge');

    // Every row, not the newest window of them. Under the windowed fold this
    // read 200 agent calls and 200 judge calls at the default, or 50 and 50 at
    // the bound this suite used to pass around.
    //
    // The assertions are on the AGENT row as much as the total: the failure was
    // per-producer, and a total that happened to be right while one row was
    // short would still be the defect.
    expect(agent).toMatchObject({ calls: 450, unpricedCalls: 0 });
    expect(agent?.usage).toEqual({ input: 4_500, output: 450 });
    expect(agent?.usd).toBeCloseTo(0.45, 10);
    expect(judge).toMatchObject({ calls: 300, unpricedCalls: 300 });
    expect(judge?.usage).toEqual({ input: 6_000, output: 600 });
    expect(spend.total.usage).toEqual({ input: 10_500, output: 1_050 });
    expect(spend.coverage).toMatchObject({ calls: 750, measured: 750, reported: 1 });
  });

  test('one busy producer cannot crowd another out of the total', () => {
    const { ws, events } = rig();
    // The window's worst failure was not the size of the under-count, it was
    // which producer disappeared: a rare judge call behind a busy turn loop.
    for (let i = 0; i < 400; i++) step(events, { input: 10, output: 1 });
    events.emit(WORKSPACE_RUN_ID, {
      type: 'model_call', source: 'judge', usage: { input: 700, output: 70 },
    });

    const spend = workspaceSpend({ events, sql: ws.sql });

    expect(spend.producers.find((p) => p.source === 'agent')?.calls).toBe(400);
    expect(spend.producers.find((p) => p.source === 'judge')?.usage)
      .toEqual({ input: 700, output: 70 });
  });

  test('the stored payload really carries the fields the aggregate reads', () => {
    const { ws, events } = rig();
    const every: Required<Usage> = {
      input: 11, output: 7, cacheRead: 5, cacheWrite: 3, cacheWrite1h: 2, reasoning: 1,
      neurons: 0.5,
    };
    step(events, every, 0.02);

    // The aggregate reads the payload with `json_extract`, which cannot be
    // typechecked against the writer. So the paths are pinned against a row the
    // real writer wrote, and pinned by PARSING it rather than asserting a shape
    // onto it: `usage` must be a flat object under the canonical field names,
    // with `usd` as its sibling. `UsageSchema` is the same declaration the JSON
    // paths mirror, and valibot returns only its declared keys — so the key set
    // below is proof that each canonical name was literally at `$.usage.<name>`.
    // Move either and this fails here rather than as a silently absent count on
    // the owner's panel.
    const [row] = ws.sql<{ payload: string }>`
      SELECT payload FROM run_events WHERE type = 'step_finish'`;
    const payload = v.parse(
      v.object({ usage: UsageSchema, usd: v.number() }),
      JSON.parse(row!.payload),
    );
    expect(Object.keys(payload.usage).sort()).toEqual([...USAGE_FIELDS].sort());
    expect(payload.usd).toBeCloseTo(0.02, 10);

    // …and every one of those fields survives the sum. A column the SQL forgot
    // would read as a field nobody reported, which is the absence this whole
    // read model exists to keep honest.
    const spend = workspaceSpend({ events, sql: ws.sql });
    expect(spend.total.usage).toEqual(every);
    expect(USAGE_FIELDS.filter((f) => spend.total.usage[f] === undefined)).toEqual([]);
    expect(spend.total.usd).toBeCloseTo(0.02, 10);
  });

  test('producers are ordered by measured tokens, unmeasured ones last', () => {
    const { ws, events } = rig();
    events.emit(WORKSPACE_RUN_ID, { type: 'model_call', source: 'platform' });
    events.emit(WORKSPACE_RUN_ID, {
      type: 'model_call', source: 'fast', usage: { input: 100, output: 10 },
    });
    step(events, { input: 9000, output: 900 });

    const spend = workspaceSpend({ events, sql: ws.sql });

    expect(spend.producers.map((p) => p.source)).toEqual(['agent', 'fast', 'platform']);
  });

  test('a call filed with no run open still reaches the total, and is not a run', () => {
    const { ws, events } = rig();
    events.emit(WORKSPACE_RUN_ID, {
      type: 'model_call', source: 'reflection', usage: { input: 800, output: 40 },
    });
    step(events, { input: 9000, output: 900 });

    expect(workspaceSpend({ events, sql: ws.sql }).total.usage)
      .toEqual({ input: 9800, output: 940 });
    // …and the owner's run history does not grow a run the agent never had. The
    // real run beside it is what makes this decidable: an empty list would read
    // the same whether the exclusion held or the query failed.
    expect(events.listRunsBefore(null, RUN_LIST_LIMIT).map((r) => r.runId)).toEqual(['run-1']);
  });
});

describe('workspaceSpend — the breakdown', () => {
  test('the off-turn share is every measured token no turn of this agent spent', () => {
    const { ws, events } = rig();
    step(events, { input: 700, output: 100 });          // agent: 800
    events.emit(WORKSPACE_RUN_ID, {
      type: 'model_call', source: 'reflection', usage: { input: 150, output: 10 },
    });
    events.emit(WORKSPACE_RUN_ID, {
      type: 'model_call', source: 'judge', usage: { input: 30, output: 10 },
    });

    const spend = workspaceSpend({ events, sql: ws.sql });

    expect(usageTotal(spend.total.usage)).toBe(1000);
    expect(spend.offTurnShare).toBeCloseTo(0.2, 10);
  });

  test('a workspace whose only spend is its own turns has an off-turn share of zero', () => {
    const { ws, events } = rig();
    step(events, { input: 700, output: 100 });

    expect(workspaceSpend({ events, sql: ws.sql }).offTurnShare).toBe(0);
  });

  test('nothing measured has NO share — absent, never 0%', () => {
    const { ws, events } = rig();
    events.emit(WORKSPACE_RUN_ID, { type: 'model_call', source: 'platform' });

    // The producer is counted, so this is a workspace that spent something and
    // measured none of it: 0% off-turn would read as "all of it was the agent".
    const spend = workspaceSpend({ events, sql: ws.sql });
    expect(spend.coverage.calls).toBe(1);
    expect(spend.offTurnShare).toBeNull();
  });

  test('missions come from the ledger the caps are enforced against, dearest first', () => {
    const { ws, events } = rig();
    step(events, { input: 700, output: 100 });
    const governor = new MissionGovernor({ storage: { sql: ws.sql, execRaw: ws.execRaw } });
    governor.declare('checkout-fixes', { usd: 25 }, {});
    governor.declare('sweep', { tokens: 5_000 }, { parent: 'checkout-fixes' });
    governor.debit(4_000, { labels: ['sweep'], calls: 2 });
    governor.debit(100, { labels: ['checkout-fixes'], calls: 1 });

    const spend = workspaceSpend({ events, sql: ws.sql });

    // The parent carries the child's debit as well as its own — the ledger rolls
    // a debit up the whole chain, which is exactly why it is the one figure a
    // per-mission surface may read.
    expect(spend.missions.map((m) => [m.label, m.parent, m.spent.tokens, m.calls]))
      .toEqual([
        ['checkout-fixes', null, 4_100, 3],
        ['sweep', 'checkout-fixes', 4_000, 2],
      ]);
    expect(spend.missions[1]!.remaining.tokens).toBe(1_000);
    expect(spend.missions[1]!.exhausted).toBe(false);
    // The two axes are NOT the same sum, though both now cover the whole life of
    // the workspace: a call sits in exactly one producer row and in every
    // mission label above it, so adding them double-counts.
    expect(usageTotal(spend.total.usage)).toBe(800);
  });

  test('a workspace that declared no budget reports no missions and does not fail', () => {
    const { ws, events } = rig();
    step(events, { input: 700, output: 100 });

    // No governor was ever built here, so `mission_budget` does not exist. An
    // unbudgeted workspace is the common case and must not read as broken.
    expect(workspaceSpend({ events, sql: ws.sql }).missions).toEqual([]);
  });
});
