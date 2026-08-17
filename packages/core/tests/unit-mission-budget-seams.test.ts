/**
 * The two host seams the mission governor enforces at, exercised through the
 * surfaces the agent actually reaches them by.
 *
 * The point of the whole feature is that the stop is MECHANICAL: none of these
 * paths ask LLM-authored code to restrain itself. So the tests drive the real
 * dispatch (`agents.*` in the sandbox, the shared step pipeline, the shared turn
 * accumulator) with scripted strategies and no live model anywhere.
 */

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { MockLanguageModelV3 } from 'ai/test';
import * as v from 'valibot';
import { createTestRuntime, makeExecRaw, makeSql } from './helpers.js';
import {
  MissionGovernor,
  MissionBudgetExhausted,
  type MissionBudgetRefusal,
  type MissionScope,
} from '../src/mission-budget.js';
import {
  createAgentsCodemodeProvider, createStrategyRegistry, FORK_STRATEGY_ID,
  type AgentsToolDeps, type ExplorationStrategy, type StrategyContext,
} from '../src/index.js';
import { composePrepareStep } from '../src/prompting/prepare-step.js';
import type { SubordinateHandoff } from '../src/index.js';

/** The admission facts every handoff carries back to the sender. */
function handoff(): SubordinateHandoff {
  return { eventId: 'evt-1', delivery: 'starts_now', phase: { busy: false, lastActivityAt: null, workingOn: null } };
}
import { TurnAccumulator } from '../src/orchestrator/turn-accumulator.js';
import { buildDrainBatch } from '../src/events/hub/drain.js';
import type { ProteusEvent } from '../src/events/hub/types.js';

function newGovernor(onExhausted?: (r: MissionBudgetRefusal) => void) {
  const db = new Database(':memory:');
  return new MissionGovernor({
    storage: { sql: makeSql(db), execRaw: makeExecRaw(db) },
    onExhausted,
  });
}

/** A fork strategy that spends: one completion through the runtime's LLM (the
 *  governed seam) plus a reported sub-agent token cost (what the heads runtime
 *  hands back). */
function spendingStrategy(id: string, opts: { reportedTokens?: number } = {}): ExplorationStrategy {
  return {
    id,
    async explore(ctx: StrategyContext) {
      const text = await ctx.rt.llm.complete('q'.repeat(40));
      return {
        strategy: id,
        best: { text, score: 1, source: id },
        all: [{ text, score: 1, source: id }],
        cost: { durationMs: 0, iterations: 1, tokens: opts.reportedTokens },
      };
    },
  };
}

/** A fork strategy shaped like heads: it debits its own spend through the
 *  scope it was handed (each head does, per step) and reports the total as
 *  already metered. */
function selfMeteringStrategy(id: string, tokens: number): ExplorationStrategy {
  return {
    id,
    async explore(ctx: StrategyContext) {
      if (ctx.mission) {
        await ctx.mission.port.debit(tokens, { labels: ctx.mission.labels, calls: 1 });
      }
      return {
        strategy: id,
        best: { text: 'done', score: 1, source: id },
        all: [{ text: 'done', score: 1, source: id }],
        cost: ctx.mission
          ? { durationMs: 0, iterations: 1, tokens, selfMetered: true }
          : { durationMs: 0, iterations: 1, tokens },
      };
    },
  };
}

/** The sandbox's view of `agents.*`, over deps that record every spawn. */
function sandbox(deps: AgentsToolDeps) {
  const provider = createAgentsCodemodeProvider(() => deps);
  type ProviderExecute = typeof provider.tools[string]['execute'];
  const ns: Record<string, ProviderExecute> = {};
  for (const [name, entry] of Object.entries(provider.tools)) ns[name] = entry.execute;
  return ns;
}

function forkableDeps(opts: {
  budget?: MissionGovernor;
  reportedTokens?: number;
  /** Register a heads-shaped strategy that charges its own spend instead. */
  selfMetering?: number;
  spawns?: string[];
}): AgentsToolDeps {
  const registry = createStrategyRegistry();
  registry.register(opts.selfMetering !== undefined
    ? selfMeteringStrategy(FORK_STRATEGY_ID, opts.selfMetering)
    : spendingStrategy(FORK_STRATEGY_ID, { reportedTokens: opts.reportedTokens }));
  const { rt } = createTestRuntime({ llmResponses: { qqqq: 'a'.repeat(40) } });
  const spawns = opts.spawns ?? [];
  return {
    mode: 'build',
    fork: { registry, rt, model: new MockLanguageModelV3() },
    team: {
      list: async () => [],
      create: async (input) => ({
        name: input.name ?? 'helper',
        displayName: 'Helper',
        subordinate: {
          name: input.name ?? 'helper', displayName: 'Helper', role: input.role,
          createdBy: 'user', status: 'idle', currentTask: null, createdAt: 1, dismissedAt: null,
        },
      }),
      spawn: async (input) => { spawns.push(`staff:${input.role}`); return { name: 'helper', displayName: 'Helper' }; },
      assign: async (input) => { spawns.push(`ask:${input.name}`); return { ok: true, name: input.name, ...handoff() }; },
      status: async () => ({}),
      message: async (input) => { spawns.push(`send:${input.name}`); return { ok: true, name: input.name, ...handoff() }; },
      dismiss: async (input) => ({ ok: true, name: input.name, historyKept: true }),
    },
    budget: opts.budget,
  };
}

describe('spawn seam — transitive debit through fork-from-codemode', () => {
  const ForkTextSchema = v.object({ text: v.string() });
  const ForkBudgetSchema = v.object({
    mission_budget: v.optional(v.object({
      label: v.string(),
      remaining: v.object({ tokens: v.optional(v.number()) }),
    })),
  });
  const BudgetRefusalSchema = v.object({
    error: v.literal('budget_exhausted'),
    seam: v.picklist(['model_call', 'spawn']),
    label: v.string(),
  });

  test('a fork inside the sandbox debits the mission its run spends against', async () => {
    const governor = newGovernor();
    governor.declare('nightly', {});
    governor.activate(['nightly']);

    const deps = forkableDeps({ budget: governor, reportedTokens: 900 });
    const result = v.parse(ForkTextSchema, await sandbox(deps).fork!({ task: 'explore' }));
    expect(result.text).toBe('a'.repeat(40));

    const [mission] = governor.snapshot('nightly');
    // 900 reported by the strategy for its sub-agents + (40 prompt + 40 reply)
    // chars / 4 for the one completion that crossed the governed LLM seam.
    expect(mission?.spent.tokens).toBe(920);
    expect(mission?.spawns).toBe(1);
    expect(mission?.calls).toBe(1);
  });

  test('a fork that declares its own cap nests under the mission and both are charged', async () => {
    const governor = newGovernor();
    governor.declare('nightly', {});
    governor.activate(['nightly']);

    const deps = forkableDeps({ budget: governor, reportedTokens: 100 });
    await sandbox(deps).fork!({ task: 'explore', budget_tokens: 5_000, budget_label: 'sweep' });

    expect(governor.snapshot('sweep')[0]?.spent.tokens).toBe(120);
    expect(governor.snapshot('sweep')[0]?.parent).toBe('nightly');
    expect(governor.snapshot('nightly')[0]?.spent.tokens).toBe(120);
  });

  test('the fork returns its own ledger position so a script can steer on it', async () => {
    const governor = newGovernor();
    governor.declare('nightly', {});
    governor.activate(['nightly']);
    const deps = forkableDeps({ budget: governor, reportedTokens: 10 });
    const out = v.parse(
      ForkBudgetSchema,
      await sandbox(deps).fork!({ task: 'x', budget_tokens: 1_000, budget_label: 'sweep' }),
    );
    expect(out.mission_budget?.label).toBe('sweep');
    expect(out.mission_budget?.remaining.tokens).toBe(970);
  });

  test('an exhausted mission refuses every spawn without touching the substrate', async () => {
    const governor = newGovernor();
    governor.declare('nightly', { tokens: 10 });
    governor.activate(['nightly']);
    governor.debit(10);

    const spawns: string[] = [];
    const ns = sandbox(forkableDeps({ budget: governor, spawns }));

    for (const [member, input] of [
      ['fork', { task: 'x' }],
      ['staff', { role: 'r', mission: 'm' }],
      ['ask', { agent: 'helper', message: 'm' }],
      ['send', { agent: 'helper', message: 'm' }],
    ] as const) {
      const refusal = v.parse(BudgetRefusalSchema, await ns[member]!(input));
      expect(refusal.error).toBe('budget_exhausted');
      expect(refusal.seam).toBe('spawn');
      expect(refusal.label).toBe('nightly');
    }
    expect(spawns).toEqual([]);
  });

  test('winding the run up stays possible — list and dismiss are never refused', async () => {
    const governor = newGovernor();
    governor.declare('nightly', { tokens: 1 });
    governor.activate(['nightly']);
    governor.debit(1);

    const ns = sandbox(forkableDeps({ budget: governor }));
    expect(await ns.list!({})).toMatchObject({ subordinates: [] });
    expect(await ns.dismiss!({ agent: 'helper' })).toMatchObject({ ok: true });
  });

  test('no governor and no scope leave the fork path byte-for-byte unbudgeted', async () => {
    const governor = newGovernor();
    const withGovernorNoScope = await sandbox(forkableDeps({ budget: governor, reportedTokens: 7 })).fork!({ task: 'x' });
    const withoutGovernor = await sandbox(forkableDeps({ reportedTokens: 7 })).fork!({ task: 'x' });
    expect(withGovernorNoScope).toEqual(withoutGovernor);
    expect(withoutGovernor).not.toHaveProperty('mission_budget');
  });
});

describe('spawn seam — work that runs where the ledger is not reachable', () => {
  test('a fork is handed the scope, so a head in another process can charge it', async () => {
    const governor = newGovernor();
    governor.declare('nightly', {});
    governor.activate(['nightly']);

    let handed: { labels: readonly string[] } | undefined;
    const registry = createStrategyRegistry();
    registry.register({
      id: FORK_STRATEGY_ID,
      async explore(ctx: StrategyContext) {
        handed = ctx.mission ? { labels: ctx.mission.labels } : undefined;
        return {
          strategy: FORK_STRATEGY_ID,
          best: { text: 'x', score: 1, source: 'x' },
          all: [], cost: { durationMs: 0 },
        };
      },
    });
    const { rt } = createTestRuntime();
    await sandbox({
      mode: 'build',
      fork: { registry, rt, model: new MockLanguageModelV3() },
      budget: governor,
    }).fork!({ task: 't' });
    expect(handed).toEqual({ labels: ['nightly'] });
  });

  test('an unbudgeted fork is handed no scope at all', async () => {
    let handed: MissionScope | 'unset' = 'unset';
    const registry = createStrategyRegistry();
    registry.register({
      id: FORK_STRATEGY_ID,
      async explore(ctx: StrategyContext) {
        handed = ctx.mission ?? 'unset';
        return {
          strategy: FORK_STRATEGY_ID,
          best: { text: 'x', score: 1, source: 'x' },
          all: [], cost: { durationMs: 0 },
        };
      },
    });
    const { rt } = createTestRuntime();
    await sandbox({
      mode: 'build',
      fork: { registry, rt, model: new MockLanguageModelV3() },
    }).fork!({ task: 't' });
    expect(handed).toBe('unset');
  });

  test('spend a strategy already charged is not charged again at this seam', async () => {
    // Heads debit every step as they make it — that is what lets an exhausted
    // budget stop one mid-flight. Charging the reported total here too would
    // bill the same tokens twice and halve every budget.
    const governor = newGovernor();
    governor.declare('nightly', {});
    governor.activate(['nightly']);

    const deps = forkableDeps({ budget: governor, selfMetering: 900 });
    await sandbox(deps).fork!({ task: 'explore' });

    const [mission] = governor.snapshot('nightly');
    expect(mission?.spent.tokens).toBe(900);
    // The spawn is still recorded — only the tokens moved.
    expect(mission?.spawns).toBe(1);
  });

  test('a strategy that could NOT charge itself is still billed the lump', async () => {
    // An MCTS rollout runs where the ledger is not reachable, so its total is
    // seen only at this seam.
    const governor = newGovernor();
    governor.declare('nightly', {});
    governor.activate(['nightly']);

    const deps = forkableDeps({ budget: governor, reportedTokens: 900 });
    await sandbox(deps).fork!({ task: 'explore' });
    expect(governor.snapshot('nightly')[0]?.spent.tokens).toBe(920);
  });

  test('a fork that reported NO total is charged none of it, and the spawn still records', async () => {
    // An unmeasured fork is not a free one. `cost.tokens` absent means the
    // strategy could not measure what its sub-agents spent, so this seam charges
    // nothing for it — the alternative readings are both wrong: billing a guess,
    // or dropping the spawn row and pretending the work never happened.
    const governor = newGovernor();
    governor.declare('nightly', {});
    governor.activate(['nightly']);

    const deps = forkableDeps({ budget: governor });
    await sandbox(deps).fork!({ task: 'explore' });

    const [mission] = governor.snapshot('nightly');
    // Only the (40 prompt + 40 reply) / 4 chars the governed LLM seam estimated
    // for the one completion that really crossed it. No lump on top.
    expect(mission?.spent.tokens).toBe(20);
    expect(mission?.calls).toBe(1);
    expect(mission?.spawns).toBe(1);
  });
});

describe('model-call seam — the step pipeline declines the next request', () => {
  const ctx = { stepNumber: 3, messages: [{ role: 'user' as const, content: 'hi' }] };

  test('an exhausted mission stops the turn before the request is issued', () => {
    const governor = newGovernor();
    governor.declare('nightly', { tokens: 5 });
    governor.activate(['nightly']);
    governor.debit(5);
    expect(() => composePrepareStep({ budget: governor }, ctx)).toThrow(MissionBudgetExhausted);
  });

  test('a mission with room left runs the pipeline unchanged', () => {
    const governor = newGovernor();
    governor.declare('nightly', { tokens: 5_000 });
    governor.activate(['nightly']);
    expect(composePrepareStep({ budget: governor }, ctx))
      .toEqual(composePrepareStep({}, ctx));
  });

  test('the refusal is recorded once in the run event log', () => {
    const seen: MissionBudgetRefusal[] = [];
    const governor = newGovernor((r) => seen.push(r));
    governor.declare('nightly', { tokens: 1 });
    governor.activate(['nightly']);
    governor.debit(1);
    for (let i = 0; i < 3; i++) {
      expect(() => composePrepareStep({ budget: governor }, ctx)).toThrow();
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]?.seam).toBe('model_call');
  });
});

describe('model-call seam — the turn accumulator is the meter', () => {
  const step = { usage: { input: 300, output: 100, cacheRead: 250 } };

  test("a scoped turn's provider-reported usage lands on the ledger", () => {
    const governor = newGovernor();
    governor.declare('nightly', {});
    governor.activate(['nightly']);
    const acc = new TurnAccumulator({}, governor);
    acc.recordStep(step);
    acc.recordStep(step);

    // input is the cache-inclusive total, so the cache read is not counted twice.
    expect(governor.snapshot('nightly')[0]?.spent.tokens).toBe(800);
    expect(governor.snapshot('nightly')[0]?.calls).toBe(2);
    // The accumulator's own numbers are untouched by the governor.
    expect(acc.reportedUsage()).toEqual({ input: 600, output: 200, cacheRead: 500 });
  });

  test('an unscoped turn records usage and no spend', () => {
    const governor = newGovernor();
    const acc = new TurnAccumulator({}, governor);
    acc.recordStep(step);
    expect(governor.snapshot()).toEqual([]);
    expect(acc.reportedUsage()).toEqual({ input: 300, output: 100, cacheRead: 250 });
  });

  test("the step's usage split is priced at the resolved model's catalog rates", () => {
    const db = new Database(':memory:');
    const governor = new MissionGovernor({
      storage: { sql: makeSql(db), execRaw: makeExecRaw(db) },
      pricing: () => ({ input: 3, output: 15, cacheRead: 0.3 }),
    });
    governor.declare('nightly', {});
    governor.activate(['nightly']);
    new TurnAccumulator({}, governor).recordStep(step);

    // 50 fresh input @ $3 + 250 cache-read @ $0.30 + 100 output @ $15, per 1M.
    const [row] = governor.snapshot('nightly');
    expect(row?.spent.usd).toBeCloseTo((50 * 3 + 250 * 0.3 + 100 * 15) / 1_000_000, 12);
    expect(row?.pricing).toEqual({ blendedTokens: 0, source: 'catalog' });
  });
});

describe('mission scope reaches the woken turn', () => {
  type TimerEvent = Extract<ProteusEvent, { variant: 'timer' }>;

  function timerEvent(id: string, missionLabel?: string): TimerEvent {
    const event: TimerEvent = {
      id, variant: 'timer', ingress: 'timer_alarm',
      payload: {
        trigger_id: `t-${id}`, scheduled_fire_at: 0, label: 'nightly sweep',
      },
      trust: 'authenticated', priority: 'background', received_at: 0,
      trace_id: id,
      caused_by: null,
      payload_visibility: 'full',
      schema_version: 1,
      reply_channel: null,
      dedupe_key: null,
    };
    return missionLabel
      ? { ...event, payload: { ...event.payload, mission_label: missionLabel } }
      : event;
  }

  test('a schedule that declared a budget hands its label to the drain batch', () => {
    const batch = buildDrainBatch([timerEvent('a', 'nightly'), timerEvent('b', 'nightly'), timerEvent('c')]);
    expect(batch?.missions).toEqual(['nightly']);
  });

  test('an ordinary drain carries no mission at all', () => {
    expect(buildDrainBatch([timerEvent('a')])?.missions).toEqual([]);
  });

  test('activate binds only labels that were really declared', () => {
    const governor = newGovernor();
    governor.declare('nightly', {});
    governor.activate(['nightly', 'invented']);
    expect(governor.scope).toEqual(['nightly']);
  });
});
