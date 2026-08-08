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
import { createTestRuntime, makeExecRaw, makeSql } from './helpers.js';
import { MissionGovernor, MissionBudgetExhausted, type MissionBudgetRefusal } from '../src/mission-budget.js';
import {
  createAgentsCodemodeProvider, createStrategyRegistry, FORK_STRATEGY_ID,
  type AgentsToolDeps, type ExplorationStrategy, type StrategyContext,
} from '../src/index.js';
import { composePrepareStep } from '../src/prompting/prepare-step.js';
import { TurnAccumulator } from '../src/orchestrator/turn-accumulator.js';
import { buildDrainBatch } from '../src/events/hub/drain.js';
import type { ProteusEvent } from '../src/events/hub/types.js';

function newGovernor(onExhausted?: (r: MissionBudgetRefusal) => void) {
  const db = new Database(':memory:');
  return new MissionGovernor({
    storage: { sql: makeSql(db), execRaw: makeExecRaw(db) },
    ...(onExhausted ? { onExhausted } : {}),
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
        cost: { durationMs: 0, iterations: 1, ...(opts.reportedTokens !== undefined ? { tokens: opts.reportedTokens } : {}) },
      };
    },
  };
}

/** The sandbox's view of `agents.*`, over deps that record every spawn. */
function sandbox(deps: AgentsToolDeps) {
  const provider = createAgentsCodemodeProvider(() => deps);
  const ns: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const [name, entry] of Object.entries(provider.tools)) ns[name] = entry.execute;
  return ns;
}

function forkableDeps(opts: {
  budget?: MissionGovernor;
  reportedTokens?: number;
  spawns?: string[];
}): AgentsToolDeps {
  const registry = createStrategyRegistry();
  registry.register(spendingStrategy(FORK_STRATEGY_ID, opts.reportedTokens !== undefined ? { reportedTokens: opts.reportedTokens } : {}));
  const { rt } = createTestRuntime({ llmResponses: { qqqq: 'a'.repeat(40) } });
  const spawns = opts.spawns ?? [];
  return {
    fork: { registry, rt, model: rt.llm as never },
    team: {
      list: async () => [],
      spawn: async (input) => { spawns.push(`staff:${input.role}`); return { name: 'helper', displayName: 'Helper' }; },
      assign: async (input) => { spawns.push(`ask:${input.name}`); return { ok: true, name: input.name }; },
      status: async () => ({}),
      message: async (input) => { spawns.push(`send:${input.name}`); return { ok: true, name: input.name }; },
      dismiss: async (input) => ({ ok: true, name: input.name, historyKept: true }),
    },
    ...(opts.budget ? { budget: opts.budget } : {}),
  };
}

describe('spawn seam — transitive debit through fork-from-codemode', () => {
  test('a fork inside the sandbox debits the mission its run spends against', async () => {
    const governor = newGovernor();
    governor.declare('nightly', {});
    governor.activate(['nightly']);

    const deps = forkableDeps({ budget: governor, reportedTokens: 900 });
    const result = await sandbox(deps).fork!({ task: 'explore' }) as { text: string };
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
    const out = await sandbox(deps).fork!({ task: 'x', budget_tokens: 1_000, budget_label: 'sweep' }) as {
      mission_budget?: { label: string; remaining: { tokens?: number } };
    };
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
      const refusal = await ns[member]!(input) as MissionBudgetRefusal;
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

describe('model-call seam — the step pipeline declines the next request', () => {
  const ctx = { stepNumber: 3, messages: [{ role: 'user' as const, content: 'hi' }] };

  test('an exhausted mission stops the turn before the request is issued', () => {
    const governor = newGovernor();
    governor.declare('nightly', { tokens: 5 });
    governor.activate(['nightly']);
    governor.debit(5);
    expect(() => composePrepareStep(undefined, ctx, null, null, governor)).toThrow(MissionBudgetExhausted);
  });

  test('a mission with room left runs the pipeline unchanged', () => {
    const governor = newGovernor();
    governor.declare('nightly', { tokens: 5_000 });
    governor.activate(['nightly']);
    expect(composePrepareStep(undefined, ctx, null, null, governor))
      .toEqual(composePrepareStep(undefined, ctx, null, null));
  });

  test('the refusal is recorded once in the run event log', () => {
    const seen: MissionBudgetRefusal[] = [];
    const governor = newGovernor((r) => seen.push(r));
    governor.declare('nightly', { tokens: 1 });
    governor.activate(['nightly']);
    governor.debit(1);
    for (let i = 0; i < 3; i++) {
      expect(() => composePrepareStep(undefined, ctx, null, null, governor)).toThrow();
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]?.seam).toBe('model_call');
  });
});

describe('model-call seam — the turn accumulator is the meter', () => {
  const step = { usage: { inputTokens: 300, outputTokens: 100, cachedInputTokens: 250 } };

  test("a scoped turn's provider-reported usage lands on the ledger", () => {
    const governor = newGovernor();
    governor.declare('nightly', {});
    governor.activate(['nightly']);
    const acc = new TurnAccumulator({}, governor);
    acc.recordStep(step);
    acc.recordStep(step);

    // input is the cache-inclusive total, so cached is not counted twice.
    expect(governor.snapshot('nightly')[0]?.spent.tokens).toBe(800);
    expect(governor.snapshot('nightly')[0]?.calls).toBe(2);
    // The accumulator's own numbers are untouched by the governor.
    expect(acc.reportedUsage()).toEqual({ input: 600, output: 200, cached: 500 });
  });

  test('an unscoped turn records usage and no spend', () => {
    const governor = newGovernor();
    const acc = new TurnAccumulator({}, governor);
    acc.recordStep(step);
    expect(governor.snapshot()).toEqual([]);
    expect(acc.reportedUsage()).toEqual({ input: 300, output: 100, cached: 250 });
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

    // 50 fresh input @ $3 + 250 cached @ $0.30 + 100 output @ $15, per 1M.
    const [row] = governor.snapshot('nightly');
    expect(row?.spent.usd).toBeCloseTo((50 * 3 + 250 * 0.3 + 100 * 15) / 1_000_000, 12);
    expect(row?.pricing).toEqual({ blendedTokens: 0, source: 'catalog' });
  });
});

describe('mission scope reaches the woken turn', () => {
  function timerEvent(id: string, missionLabel?: string): ProteusEvent {
    return {
      id, variant: 'timer', ingress: 'timer_alarm',
      payload: {
        trigger_id: `t-${id}`, scheduled_fire_at: 0, label: 'nightly sweep',
        ...(missionLabel ? { mission_label: missionLabel } : {}),
      },
      trust: 'authenticated', priority: 'background', received_at: 0,
    } as unknown as ProteusEvent;
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
