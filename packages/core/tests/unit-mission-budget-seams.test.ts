/** The mission governor's two host seams, driven through the real dispatch with scripted strategies:
 *  the stop is mechanical, never asked of LLM-authored code. */

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { scriptedTurnModel, createTestActorsOver, present, unobservedSearchSeams } from '@kinu.run/test-utils';
import { swarmSeats } from './helpers-actor-host';
import * as v from 'valibot';
import { jsonSchema, tool } from 'ai';
import { createTestRuntime, makeExecRaw, makeSql } from './helpers';
import {
  MissionGovernor,
  type MissionBudgetRefusal,
} from '../src/mission-budget';
import {
  createAgentsCodemodeProvider,
  type AgentsToolDeps,
} from '../src/index';
import { ROOT_DELEGATION_BUDGET } from '../src/subordinates/depth';
import { runChat } from '../src/chat';
import { sessionFixture } from './helpers-session';
import type { SubordinateHandoff } from '../src/index';

/** The admission facts every handoff carries back to the sender. */
function handoff(): SubordinateHandoff {
  return { eventId: 'evt-1', delivery: 'starts_now', phase: { busy: false, lastActivityAt: null, workingOn: null } };
}

import { buildDrainBatch } from '../src/events/hub/drain';
import type { KinuEvent } from '../src/events/hub/types';
import { temporaryPortStub } from './helpers-agents';

function newGovernor(onExhausted?: (r: MissionBudgetRefusal) => void) {
  const db = new Database(':memory:');

  return new MissionGovernor({
    storage: { sql: makeSql(db), execRaw: makeExecRaw(db) },
    // A mission cap is one actor's ledger, so the governor binds a real owner over the same database.
    actor: createTestActorsOver(db).main,
    onExhausted,
  });
}

/** One expansion's provider-reported usage: 5 in + 3 out, so a run's total is arithmetic over expansions. */
const PER_EXPANSION_TOKENS = 8;

/** A model that answers once per expansion; `usage: 'silent'` reports nothing, which differs from zero. */
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

/** The smallest real search: two sibling answers, no score, no advance; every ledger token came from an expansion. */
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
  const { rt, db } = createTestRuntime();
  const spawns = opts.spawns ?? [];

  /** Both handoff verbs answer identically; the verb that ran is what a seam test reads back. */
  const recordHandoff = (verb: string) => async (input: { name: string }) => {
    spawns.push(`${verb}:${input.name}`);

    return { ok: true as const, name: input.name, ...handoff() };
  };

  return {
    mode: 'build', swarms: true,
    swarm: {
      rt,
      // One actor per node: spend is charged per node, and a shared handle would bill a wave to one ledger.
      ...swarmSeats({ rt, db }, () => expandingModel(opts.usage)),
      ...unobservedSearchSeams(),
    },
    team: {
      delegation: ROOT_DELEGATION_BUDGET,
      snapshot: () => [],
      list: async () => [],
      create: async (input) => ({
        name: input.name ?? 'helper',
        displayName: 'Helper',
        subordinate: { name: input.name ?? 'helper', displayName: 'Helper', role: input.role ?? 'task', actorReference: null, birth: null, deleteRequested: false, origin: 'user', status: 'idle', currentTask: null, createdAt: 1, dismissedAt: null, lifetime: 'durable', taskEventId: null },
      }),
      rename: async (input) => ({
        ok: true, name: input.name, displayName: input.displayName,
        subordinate: { name: input.name, displayName: input.displayName, role: 'task', actorReference: null, birth: null, deleteRequested: false, origin: 'user', status: 'idle', currentTask: null, createdAt: 1, dismissedAt: null, lifetime: 'durable', taskEventId: null },
      }),
      recordTitle: async (input) => ({ ok: true, name: input.name, displayName: input.displayName, applied: true }),
      spawn: async (input) => {
        spawns.push(`hire:${input.role}`);

        return { name: 'helper', displayName: 'Helper' };
      },
      assign: recordHandoff('ask'),
      knows: async () => true,
      status: async () => ({}),
      message: recordHandoff('send'),
      dismiss: async (input) => ({ ok: true, name: input.name, historyKept: true, stoppedJobs: [] }),
      // A task-lifetime hire is offered only where its port is wired.
      temporary: { ...temporaryPortStub, start: async (request) => {
        spawns.push(`task:${request.role}`);

        return await temporaryPortStub.start();
      } },
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
    const result = v.parse(SearchReportSchema, await sandbox(deps).swarm('explore', TWO_BRANCHES));
    expect(result.report.expansions).toBe(2);
    expect(result.report.tokens).toBe(RUN_TOKENS);

    const [mission] = governor.snapshot('nightly');
    expect(mission?.spent.tokens).toBe(RUN_TOKENS);
    expect(mission?.spawns).toBe(1);
  });

  test('a search that declares its own cap nests under the mission and both are charged', async () => {
    const governor = newGovernor();
    governor.declare('nightly', {});
    governor.activate(['nightly']);

    const deps = searchableDeps({ budget: governor });
    await sandbox(deps).swarm('explore', { ...TWO_BRANCHES, budgetTokens: 5_000, budgetLabel: 'sweep' });

    expect(governor.snapshot('sweep')[0]?.spent.tokens).toBe(RUN_TOKENS);
    expect(governor.snapshot('sweep')[0]?.parent).toBe('nightly');
    expect(governor.snapshot('nightly')[0]?.spent.tokens).toBe(RUN_TOKENS);
  });

  test('the search returns its own ledger position so a script can steer on it', async () => {
    const governor = newGovernor();
    governor.declare('nightly', {});
    governor.activate(['nightly']);
    const deps = searchableDeps({ budget: governor });

    const out = v.parse(
      SearchBudgetSchema,
      await sandbox(deps).swarm('x', { ...TWO_BRANCHES, budgetTokens: 1_000, budgetLabel: 'sweep' }),
    );

    expect(out.mission_budget?.label).toBe('sweep');
    expect(out.mission_budget?.remaining.tokens).toBe(1_000 - RUN_TOKENS);
  });

  test('an exhausted mission refuses every spawn without touching the substrate', async () => {
    const governor = newGovernor();
    governor.declare('nightly', { tokens: 10 });
    governor.activate(['nightly']);
    governor.debit(10);

    const spawns: string[] = [];
    const ns = sandbox(searchableDeps({ budget: governor, spawns }));

    for (const [member, args] of [
      ['swarm', ['x', TWO_BRANCHES]],
      ['hire', ['r', 'm']],
      ['assign', ['helper', 'm']],
      // An exhausted label must not mint a task-lifetime agent either.
      ['hire', ['auditor', 'm', { lifetime: 'task' }]],
      ['message', ['helper', 'm']],
    ] as const) {
      const refusal = v.parse(BudgetRefusalSchema, await present(ns[member], `agents.${member}`)(...args));
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
    expect(await ns.list({})).toMatchObject({ subordinates: [] });
    expect(await ns.dismiss('helper')).toMatchObject({ ok: true });
  });

  test('no governor and no scope leave the search path unbudgeted, and identically so', async () => {
    const governor = newGovernor();
    const withGovernorNoScope = await sandbox(searchableDeps({ budget: governor })).swarm('x', TWO_BRANCHES);
    const withoutGovernor = await sandbox(searchableDeps({})).swarm('x', TWO_BRANCHES);

    // Node ids are minted per run; an unscoped governor must add no key, ledger row or charge.
    expect(v.parse(SearchReportSchema, withGovernorNoScope).report).toEqual({ expansions: 2, tokens: 16 });
    expect(v.parse(SearchReportSchema, withoutGovernor).report).toEqual({ expansions: 2, tokens: 16 });
    expect(withoutGovernor).not.toHaveProperty('mission_budget');
    expect(withGovernorNoScope).not.toHaveProperty('mission_budget');
    expect(governor.snapshot()).toEqual([]);
  });
});

describe('spawn seam — the run charges its own calls and the spawn charges no tokens', () => {
  const SearchReportSchema = v.object({
    report: v.object({ expansions: v.number(), tokens: v.nullable(v.number()) }),
  });

  test("a search's tokens land on the ledger exactly once, not once per accounting path", async () => {
    // The search already debits each call through its own port; a seam that also billed the report would
    // double every search, silently, so the total is checked against the provider's arithmetic.
    const governor = newGovernor();
    governor.declare('nightly', {});
    governor.activate(['nightly']);

    const deps = searchableDeps({ budget: governor });

    const out = v.parse(
      SearchReportSchema,
      await sandbox(deps).swarm('explore', TWO_BRANCHES),
    );

    // Two nodes really ran and reported tokens, so a zero ledger cannot pass.
    expect(out.report.expansions).toBe(2);
    expect(out.report.tokens).toBe(RUN_TOKENS);

    const [mission] = governor.snapshot('nightly');
    expect(mission?.spent.tokens).toBe(RUN_TOKENS);
    expect(mission?.spent.tokens).not.toBe(2 * RUN_TOKENS);
    // One call per step: the ledger holds two calls of eight tokens, not one opaque total.
    expect(mission?.calls).toBe(2);
    expect(mission?.spawns).toBe(1);
  });

  test('a run whose provider reported NO usage is charged none of it, and the spawn still records', async () => {
    // No reported usage charges nothing, but the spawn row is still recorded.
    const governor = newGovernor();
    governor.declare('nightly', {});
    governor.activate(['nightly']);

    const deps = searchableDeps({ budget: governor, usage: 'silent' });
    const out = v.parse(SearchReportSchema, await sandbox(deps).swarm('explore', TWO_BRANCHES));
    expect(out.report.expansions).toBe(2);
    expect(out.report.tokens).toBeNull();

    const [mission] = governor.snapshot('nightly');
    expect(mission?.spent.tokens).toBe(0);
    expect(mission?.spawns).toBe(1);
  });

  test('a TOOLLESS node charges its one call too, so removing the lump under-charges nothing', async () => {
    // A toolless node's whole spend is one `generateText` on the search's own model, not `rt.llm`;
    // leaving it uncharged would make a thought search free.
    const governor = newGovernor();
    governor.declare('nightly', {});
    governor.activate(['nightly']);

    const deps = searchableDeps({ budget: governor });

    const out = v.parse(SearchReportSchema, await sandbox(deps).swarm('explore', {
      preset: 'custom', from: 'ideate', label: 'toolless',
      config: { unit: { kind: 'thought' } }, branches: 2, depth: 1,
    }));

    expect(out.report.expansions).toBe(2);
    expect(out.report.tokens).toBe(RUN_TOKENS);

    const [mission] = governor.snapshot('nightly');
    expect(mission?.spent.tokens).toBe(RUN_TOKENS);
    expect(mission?.calls).toBe(2);
    expect(mission?.spawns).toBe(1);
  });
});

describe('model-call seam — the turn declines the next request', () => {
  async function request(governor?: MissionGovernor, requests: string[] = []): Promise<number> {
    let calls = 0;

    const model = scriptedTurnModel({ doGenerate: () => {
      calls += 1;
      requests.push('request');

      return {
        content: [{ type: 'text', text: 'done' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: {
          inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 3, text: 3, reasoning: undefined },
        }, warnings: [],
      };
    } });

    for await (const _ of runChat({
      model, modelSpec: 'fake/test-model', system: 'Answer.',
      history: [{ role: 'user', content: 'hi' }], tools: {}, budget: governor,
    })) { /* drain */ }

    return calls;
  }

  test('an exhausted mission stops the turn before the request is issued', async () => {
    const governor = newGovernor();
    governor.declare('nightly', { tokens: 5 });
    governor.activate(['nightly']);
    governor.debit(5);
    const requests: string[] = [];

    await expect(request(governor, requests)).rejects.toMatchObject({ code: 'denied' });
    expect(requests).toEqual([]);
  });

  test('a mission with room left runs the pipeline unchanged', async () => {
    const governor = newGovernor();
    governor.declare('nightly', { tokens: 5_000 });
    governor.activate(['nightly']);
    expect(await request(governor)).toBe(1);
    expect(await request()).toBe(1);
  });

  test('the refusal is recorded once in the run event log', async () => {
    const seen: MissionBudgetRefusal[] = [];
    const governor = newGovernor((r) => seen.push(r));
    governor.declare('nightly', { tokens: 1 });
    governor.activate(['nightly']);
    governor.debit(1);

    for (let i = 0; i < 3; i++) {
      await expect(request(governor)).rejects.toMatchObject({ code: 'denied' });
    }

    expect(seen).toHaveLength(1);
    expect(seen[0]?.seam).toBe('model_call');
  });
});

describe('model-call seam — the session ingests provider usage', () => {
  async function meteredTurn(governor: MissionGovernor) {
    let calls = 0;

    const model = scriptedTurnModel({ doGenerate: () => {
      const first = calls++ === 0;

      return {
        content: first
          ? [{ type: 'tool-call', toolName: 'shell', toolCallId: 'meter-1', input: '{}' }]
          : [{ type: 'text', text: 'done' }],
        finishReason: { unified: first ? 'tool-calls' : 'stop', raw: undefined },
        usage: {
          inputTokens: { total: 300, noCache: 50, cacheRead: 250, cacheWrite: undefined },
          outputTokens: { total: 100, text: 100, reasoning: undefined },
        }, warnings: [],
      };
    } });

    const fixture = await sessionFixture({ model, budget: governor, tools: {
      shell: tool({ description: 'probe', inputSchema: jsonSchema({ type: 'object' }), execute: async () => 'ran' }),
    } });

    try {
      await fixture.chat.send('run the probe', { id: 'meter-turn' });
      expect(calls).toBe(2);

      return fixture.actor.session.orchestrator.acc.reportedUsage();
    } finally { fixture.close(); }
  }

  test("a scoped turn's provider-reported usage lands on the ledger", async () => {
    const governor = newGovernor();
    governor.declare('nightly', {});
    governor.activate(['nightly']);
    const usage = await meteredTurn(governor);

    expect(governor.snapshot('nightly')[0]?.spent.tokens).toBe(800);
    expect(governor.snapshot('nightly')[0]?.calls).toBe(2);
    expect(usage).toEqual({ input: 600, output: 200, cacheRead: 500 });
  });

  test('an unscoped turn records usage and no spend', async () => {
    const governor = newGovernor();
    const usage = await meteredTurn(governor);

    expect(governor.snapshot()).toEqual([]);
    expect(usage).toEqual({ input: 600, output: 200, cacheRead: 500 });
  });

  test("the step's usage split is priced at the resolved model's catalog rates", async () => {
    const db = new Database(':memory:');

    const governor = new MissionGovernor({
      storage: { sql: makeSql(db), execRaw: makeExecRaw(db) },
      actor: createTestActorsOver(db).main,
      pricing: () => ({ input: 3, output: 15, cacheRead: 0.3 }),
    });

    governor.declare('nightly', {});
    governor.activate(['nightly']);
    await meteredTurn(governor);

    const [row] = governor.snapshot('nightly');

    expect(row?.spent.usd).toBeCloseTo(0.00345, 12);
    expect(row?.pricing).toEqual({ blendedTokens: 0, source: 'catalog' });
  });
});

describe('mission scope reaches the woken turn', () => {
  type TimerEvent = Extract<KinuEvent, { variant: 'timer' }>;

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
