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
import { scriptedTurnModel } from '@proteus/test-utils';
import * as v from 'valibot';
import { createTestRuntime, makeExecRaw, makeSql } from './helpers';
import {
  MissionGovernor,
  MissionBudgetExhausted,
  type MissionBudgetRefusal,
} from '../src/mission-budget';
import {
  createAgentsCodemodeProvider, createStrategyRegistry,
  type AgentsToolDeps,
} from '../src/index';
import { ROOT_DELEGATION_BUDGET } from '../src/subordinates/depth';
import { composePrepareStep } from '../src/prompting/prepare-step';
import type { SubordinateHandoff } from '../src/index';

/** The admission facts every handoff carries back to the sender. */
function handoff(): SubordinateHandoff {
  return { eventId: 'evt-1', delivery: 'starts_now', phase: { busy: false, lastActivityAt: null, workingOn: null } };
}
import { TurnAccumulator } from '../src/orchestrator/turn-accumulator';
import { buildDrainBatch } from '../src/events/hub/drain';
import type { ProteusEvent } from '../src/events/hub/types';

function newGovernor(onExhausted?: (r: MissionBudgetRefusal) => void) {
  const db = new Database(':memory:');
  return new MissionGovernor({
    storage: { sql: makeSql(db), execRaw: makeExecRaw(db) },
    onExhausted,
  });
}

/** One expansion's provider-reported usage: 5 in + 3 out. A run's total is then
 *  arithmetic over the expansion count rather than a number read back off the
 *  thing under test. */
const PER_EXPANSION_TOKENS = 8;

/** A model that answers once per expansion. `usage: 'silent'` is a provider that
 *  reported nothing, which is a different fact from reporting zero. */
function expandingModel(usage: 'reported' | 'silent' = 'reported') {
  return scriptedTurnModel({
    provider: 'fake',
    modelId: 'fake-spawn-seam',
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'one approach' }],
      finishReason: { unified: 'stop' as const, raw: undefined },
      usage: usage === 'reported'
        ? {
          inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 3, text: 3, reasoning: undefined },
        }
        : {
          inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: undefined, text: undefined, reasoning: undefined },
        },
      warnings: [],
    }),
  });
}

/** The smallest real search: two sibling answers at one level, no score and no
 *  advance. Nothing in this file is about the search's shape — every token on the
 *  ledger below came from an expansion, so a movement observed here is the
 *  budget's. */
const TWO_BRANCHES = { preset: 'ideate' as const, branches: 2, depth: 1 };
const RUN_TOKENS = 2 * PER_EXPANSION_TOKENS;
/** The sandbox's view of `agents.*`, over deps that record every spawn. */
function sandbox(deps: AgentsToolDeps) {
  const provider = createAgentsCodemodeProvider(() => deps);
  type ProviderExecute = typeof provider.tools[string]['execute'];
  const ns: Record<string, ProviderExecute> = {};
  for (const [name, entry] of Object.entries(provider.tools)) ns[name] = entry.execute;
  return ns;
}

function searchableDeps(opts: {
  budget?: MissionGovernor;
  usage?: 'reported' | 'silent';
  spawns?: string[];
}): AgentsToolDeps {
  const { rt } = createTestRuntime();
  const spawns = opts.spawns ?? [];
  return {
    mode: 'build',
    fork: {
      registry: createStrategyRegistry(),
      rt,
      model: expandingModel(opts.usage),
    },
    team: {
      delegation: ROOT_DELEGATION_BUDGET,
      list: async () => [],
      create: async (input) => ({
        name: input.name ?? 'helper',
        displayName: 'Helper',
        subordinate: {
          name: input.name ?? 'helper', displayName: 'Helper', role: input.role,
          createdBy: 'user', status: 'idle', currentTask: null, createdAt: 1, dismissedAt: null,
        },
      }),
      spawn: async (input) => { spawns.push(`hire:${input.role}`); return { name: 'helper', displayName: 'Helper' }; },
      assign: async (input) => { spawns.push(`ask:${input.name}`); return { ok: true, name: input.name, ...handoff() }; },
      status: async () => ({}),
      message: async (input) => { spawns.push(`send:${input.name}`); return { ok: true, name: input.name, ...handoff() }; },
      dismiss: async (input) => ({ ok: true, name: input.name, historyKept: true }),
    },
    budget: opts.budget,
  };
}

describe('spawn seam — transitive debit through a search from codemode', () => {
  const SearchReportSchema = v.object({
    report: v.object({ expansions: v.number(), tokens: v.nullable(v.number()) }),
  });
  const SearchBudgetSchema = v.object({
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

  test('a search inside the sandbox debits the mission its run spends against', async () => {
    const governor = newGovernor();
    governor.declare('nightly', {});
    governor.activate(['nightly']);

    const deps = searchableDeps({ budget: governor });
    const result = v.parse(SearchReportSchema, await sandbox(deps).swarm!({ task: 'explore', ...TWO_BRANCHES }));
    expect(result.report.expansions).toBe(2);
    expect(result.report.tokens).toBe(RUN_TOKENS);

    const [mission] = governor.snapshot('nightly');
    expect(mission?.spent.tokens).toBe(RUN_TOKENS);
    expect(mission?.spawns).toBe(1);
  }, 60_000);

  test('a search that declares its own cap nests under the mission and both are charged', async () => {
    const governor = newGovernor();
    governor.declare('nightly', {});
    governor.activate(['nightly']);

    const deps = searchableDeps({ budget: governor });
    await sandbox(deps).swarm!({ task: 'explore', ...TWO_BRANCHES, budget_tokens: 5_000, budget_label: 'sweep' });

    expect(governor.snapshot('sweep')[0]?.spent.tokens).toBe(RUN_TOKENS);
    expect(governor.snapshot('sweep')[0]?.parent).toBe('nightly');
    expect(governor.snapshot('nightly')[0]?.spent.tokens).toBe(RUN_TOKENS);
  }, 60_000);

  test('the search returns its own ledger position so a script can steer on it', async () => {
    const governor = newGovernor();
    governor.declare('nightly', {});
    governor.activate(['nightly']);
    const deps = searchableDeps({ budget: governor });
    const out = v.parse(
      SearchBudgetSchema,
      await sandbox(deps).swarm!({ task: 'x', ...TWO_BRANCHES, budget_tokens: 1_000, budget_label: 'sweep' }),
    );
    expect(out.mission_budget?.label).toBe('sweep');
    expect(out.mission_budget?.remaining.tokens).toBe(1_000 - RUN_TOKENS);
  }, 60_000);

  test('an exhausted mission refuses every spawn without touching the substrate', async () => {
    const governor = newGovernor();
    governor.declare('nightly', { tokens: 10 });
    governor.activate(['nightly']);
    governor.debit(10);

    const spawns: string[] = [];
    const ns = sandbox(searchableDeps({ budget: governor, spawns }));

    for (const [member, input] of [
      ['swarm', { task: 'x', ...TWO_BRANCHES }],
      ['hire', { role: 'r', mission: 'm' }],
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

    const ns = sandbox(searchableDeps({ budget: governor }));
    expect(await ns.list!({})).toMatchObject({ subordinates: [] });
    expect(await ns.dismiss!({ agent: 'helper' })).toMatchObject({ ok: true });
  });

  test('no governor and no scope leave the search path unbudgeted, and identically so', async () => {
    const governor = newGovernor();
    const withGovernorNoScope = await sandbox(searchableDeps({ budget: governor })).swarm!({ task: 'x', ...TWO_BRANCHES });
    const withoutGovernor = await sandbox(searchableDeps({})).swarm!({ task: 'x', ...TWO_BRANCHES });

    // Node ids are minted per run, so the runs are compared on everything else:
    // an unscoped governor must add no key, no ledger row and no charge.
    expect(v.parse(SearchReportSchema, withGovernorNoScope))
      .toEqual(v.parse(SearchReportSchema, withoutGovernor));
    const keys = v.record(v.string(), v.unknown());
    expect(Object.keys(v.parse(keys, withGovernorNoScope)).sort())
      .toEqual(Object.keys(v.parse(keys, withoutGovernor)).sort());
    expect(withoutGovernor).not.toHaveProperty('mission_budget');
    expect(withGovernorNoScope).not.toHaveProperty('mission_budget');
    expect(governor.snapshot()).toEqual([]);
  }, 60_000);
});

describe('spawn seam — spend the ledger sees only once the run returns', () => {
  const SearchReportSchema = v.object({
    report: v.object({ expansions: v.number(), tokens: v.nullable(v.number()) }),
  });

  test("a search's whole reported total is billed here, as one lump", async () => {
    // A search expands through its OWN model rather than the governed `rt.llm`
    // seam, so nothing below this point has debited a token. The lump is not a
    // convenience: it is the only place the spend is visible.
    const governor = newGovernor();
    governor.declare('nightly', {});
    governor.activate(['nightly']);

    const deps = searchableDeps({ budget: governor });
    await sandbox(deps).swarm!({ task: 'explore', ...TWO_BRANCHES });

    const [mission] = governor.snapshot('nightly');
    expect(mission?.spent.tokens).toBe(RUN_TOKENS);
    // Charged as one spawn and no model calls: the calls happened where this
    // ledger could not see them.
    expect(mission?.calls).toBe(0);
    expect(mission?.spawns).toBe(1);
  }, 60_000);

  test('a run whose provider reported NO usage is charged none of it, and the spawn still records', async () => {
    // An unmeasured search is not a free one. No reported usage means the run
    // could not measure what it spent, so this seam charges nothing for it — the
    // alternative readings are both wrong: billing a guess, or dropping the spawn
    // row and pretending the work never happened.
    const governor = newGovernor();
    governor.declare('nightly', {});
    governor.activate(['nightly']);

    const deps = searchableDeps({ budget: governor, usage: 'silent' });
    const out = v.parse(SearchReportSchema, await sandbox(deps).swarm!({ task: 'explore', ...TWO_BRANCHES }));
    expect(out.report.expansions).toBe(2);
    expect(out.report.tokens).toBeNull();

    const [mission] = governor.snapshot('nightly');
    expect(mission?.spent.tokens).toBe(0);
    expect(mission?.spawns).toBe(1);
  }, 60_000);
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
