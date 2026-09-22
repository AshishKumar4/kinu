/**
 * The mission governor reaching an MCTS branch: the engine guards before each expansion (a refused
 * rollout would backpropagate 0 into a persisted tree) and debits each rollout's report. An
 * unbudgeted search never touches the table; its rollout usage still reaches the report sink.
 */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createTestRuntime, createMockSession, makeSql, makeExecRaw } from './helpers';
import { createTestActors } from '@kinu.run/test-utils';
import { runMCTS } from '../src/mcts/engine';
import { initSearchTables } from '../src/mcts/schemas';
import { initScaffoldTables } from '../src/scaffold/schemas';
import { initCraftedToolsTables } from '@kinu.run/agent-utils/stores';
import {
  MissionGovernor, localMissionScope, type MissionScope,
} from '../src/mission-budget';
import type { LLM, SqlExecutor, RawSqlExec, SqlValue } from '../src/types/primitives';
import type { AgentRuntime } from '../src/types/agent-runtime';
import type { Usage } from '../src/usage';
import { usageTotal } from '../src/usage';
import type { ModelCallReport, ModelCallSink } from '../src/events/model-call';

/** A ledger over a real database that counts every statement; `mission_budget` is keyed by actor. */
function countingLedger() {
  const db = new Database(':memory:');
  const rawSql = makeSql(db);
  const rawExec = makeExecRaw(db);
  const statements: string[] = [];

  const sql: SqlExecutor = <T = unknown>(strings: TemplateStringsArray, ...values: SqlValue[]): T[] => {
    statements.push(strings.join('?').replace(/\s+/g, ' ').trim());

    return rawSql<T>(strings, ...values);
  };

  const execRaw: RawSqlExec = (ddl) => {
    statements.push(ddl.replace(/\s+/g, ' ').trim());
    rawExec(ddl);
  };

  const actor = createTestActors(sql, execRaw).main;

  return { db, sql, execRaw, statements, actor };
}

// `satisfies`, not an annotation: every `Usage` field is optional.
const PER_ROLLOUT = { input: 800, output: 200 } satisfies Usage;

const PER_REFLECTION = { input: 300, output: 100 } satisfies Usage;

function branchingRuntime() {
  const { rt } = createTestRuntime();

  // Below mcts.reflectionThreshold, so the reflect phase's second call runs.
  const judge: LLM = {
    async *stream() { yield '{"score": 0.1}'; },
    async complete() { return '{"score": 0.1}'; },
  };

  rt.llm = judge;
  rt.judgeModel = judge;
  let rollouts = 0;
  let reflections = 0;
  rt.spawnBranch = async () => ({ explore: async () => {
    rollouts++;

    return { text: 'an approach', usage: PER_ROLLOUT };
  }, generateReflection: async () => {
    reflections++;

    return { text: 'it did not work', usage: PER_REFLECTION };
  }, release: async () => {} });
  initSearchTables(rt.storage.execRaw);
  initScaffoldTables(rt.storage.execRaw);
  initCraftedToolsTables(rt.storage.sql);

  return { rt, rollouts: () => rollouts, reflections: () => reflections };
}

interface SearchOptions {
  budget?: number;
  branches?: number;
  reportModelCall?: ModelCallSink;
}

function countingBranch(explored: () => void): AgentRuntime['spawnBranch'] {
  return async () => ({
    explore: async () => {
      explored();

      return { text: 'an approach', usage: {} };
    },
    generateReflection: async () => ({ text: 'no lesson', usage: {} }),
    release: async () => {},
  });
}

async function search(
  rt: AgentRuntime,
  mission: MissionScope | null,
  { budget = 3, branches = 2, reportModelCall }: SearchOptions = {},
) {
  return runMCTS(rt, createMockSession(), 'choose an approach', {
    budget, branches, judgeSamples: 1, maxEvalLLMCalls: 1,
    mission: mission ?? undefined,
    reportModelCall,
  });
}

describe('an undeclared search is never governed', () => {
  test('a full search issues no ledger statement at all, even beside an exhausted label', async () => {
    const ledger = countingLedger();
    const governor = new MissionGovernor({ storage: { sql: ledger.sql, execRaw: ledger.execRaw }, actor: ledger.actor });
    // An exhausted budget exists; a search that never declared it must be untouched.
    governor.declare('someone-elses-mission', { tokens: 10 }, {});
    governor.debit(5_000, { labels: ['someone-elses-mission'], calls: 1 });
    const afterSetup = ledger.statements.length;

    // No declared labels produce no scope.
    const scope = localMissionScope(governor, []);
    expect(scope).toBeNull();

    const { rt, rollouts, reflections } = branchingRuntime();
    await search(rt, scope);

    // Non-vacuity: the search ran.
    expect(rollouts()).toBe(6);
    expect(reflections()).toBeGreaterThan(0);
    expect(ledger.statements.slice(afterSetup)).toEqual([]);
    expect(governor.snapshot('someone-elses-mission')[0].spent.tokens).toBe(5_000);
    ledger.db.close();
  });

  test('a search under a fresh governor leaves mission_budget empty', async () => {
    const ledger = countingLedger();
    const governor = new MissionGovernor({ storage: { sql: ledger.sql, execRaw: ledger.execRaw }, actor: ledger.actor });
    const afterConstruction = ledger.statements.length;

    const { rt, rollouts } = branchingRuntime();
    await search(rt, localMissionScope(governor, []));

    expect(rollouts()).toBe(6);
    expect(ledger.statements.slice(afterConstruction)).toEqual([]);
    expect(ledger.sql`SELECT COUNT(*) AS n FROM mission_budget`).toEqual([{ n: 0 }]);
    ledger.db.close();
  });

  test('an unbudgeted search explores exactly what a budgeted-but-roomy one does', async () => {
    const ledger = countingLedger();
    const governor = new MissionGovernor({ storage: { sql: ledger.sql, execRaw: ledger.execRaw }, actor: ledger.actor });
    governor.declare('roomy', { tokens: 10_000_000 }, {});

    const bare = branchingRuntime();
    await search(bare.rt, null);
    const governed = branchingRuntime();
    await search(governed.rt, localMissionScope(governor, ['roomy']));

    expect(governed.rollouts()).toBe(bare.rollouts());
    expect(governed.reflections()).toBe(bare.reflections());
    ledger.db.close();
  });
});

describe('a declared budget reaches the search between expansions', () => {
  test('every rollout is debited as it returns, not once at the end', async () => {
    const ledger = countingLedger();
    const governor = new MissionGovernor({ storage: { sql: ledger.sql, execRaw: ledger.execRaw }, actor: ledger.actor });
    governor.declare('mission', { tokens: 10_000_000 }, {});

    const seen: number[] = [];

    const scope: MissionScope = {
      labels: ['mission'],
      port: {
        async guard(seam, labels) { return governor.guard(seam, labels); },
        async debit(tokens, opts) { seen.push(tokens); governor.debit(tokens, opts); },
      },
    };

    const { rt, rollouts, reflections } = branchingRuntime();
    await search(rt, scope);

    const rolloutTokens = PER_ROLLOUT.input + PER_ROLLOUT.output;
    const reflectionTokens = PER_REFLECTION.input + PER_REFLECTION.output;
    expect(seen.filter((t) => t === rolloutTokens).length).toBe(rollouts());
    expect(seen.filter((t) => t === reflectionTokens).length).toBe(reflections());
    expect(governor.snapshot('mission')[0].calls).toBe(rollouts() + reflections());
    expect(governor.snapshot('mission')[0].spent.tokens)
      .toBe(rollouts() * rolloutTokens + reflections() * reflectionTokens);
    ledger.db.close();
  });

  test('an exhausted budget stops the search without recording a refused branch', async () => {
    const ledger = countingLedger();
    const governor = new MissionGovernor({ storage: { sql: ledger.sql, execRaw: ledger.execRaw }, actor: ledger.actor });
    governor.declare('mission', { tokens: 2_000 }, {});

    const { rt, rollouts } = branchingRuntime();
    await search(rt, localMissionScope(governor, ['mission']), { budget: 8, branches: 2 });

    expect(governor.snapshot('mission')[0].exhausted).toBe(true);
    expect(rollouts()).toBeLessThan(6);

    // A stop is an absence of expansions, never empty proposals backpropagating 0.
    const nodes = rt.storage.sql<{ observation: string; parent_id: string | null }>`
      SELECT observation, parent_id FROM search_nodes
      WHERE actor_id = ${rt.actor.actorId} AND parent_id IS NOT NULL`;

    expect(nodes.length).toBe(rollouts());
    expect(nodes.every((n) => n.observation === 'an approach')).toBe(true);
    ledger.db.close();
  });

  test('a search opened under an already-spent mission spawns no branch at all', async () => {
    const ledger = countingLedger();
    const governor = new MissionGovernor({ storage: { sql: ledger.sql, execRaw: ledger.execRaw }, actor: ledger.actor });
    governor.declare('mission', { tokens: 100 }, {});
    governor.debit(500, { labels: ['mission'], calls: 1 });

    const { rt, rollouts, reflections } = branchingRuntime();
    let spawned = 0;
    const spawn = rt.spawnBranch;
    rt.spawnBranch = async (id) => {
      spawned++;

      return spawn(id);
    };

    await search(rt, localMissionScope(governor, ['mission']));

    expect(spawned).toBe(0);
    expect(rollouts()).toBe(0);
    expect(reflections()).toBe(0);
    // The guard ran before the first expansion.
    expect(governor.snapshot('mission')[0].spent.tokens).toBe(500);
    ledger.db.close();
  });

  test('exhaustion fires the run-event hook exactly once', async () => {
    const ledger = countingLedger();
    const exhausted: string[] = [];

    const governor = new MissionGovernor({
      storage: { sql: ledger.sql, execRaw: ledger.execRaw },
      actor: ledger.actor,
      onExhausted: (refusal) => { exhausted.push(refusal.label); },
    });

    governor.declare('mission', { tokens: 2_000 }, {});

    const { rt } = branchingRuntime();
    await search(rt, localMissionScope(governor, ['mission']), { budget: 8, branches: 2 });

    expect(exhausted).toEqual(['mission']);
    ledger.db.close();
  });

  test('a nested label debits its ancestors, so an outer mission caps the search', async () => {
    const ledger = countingLedger();
    const governor = new MissionGovernor({ storage: { sql: ledger.sql, execRaw: ledger.execRaw }, actor: ledger.actor });
    governor.declare('outer', { tokens: 2_000 }, {});
    governor.declare('inner', { tokens: 10_000_000 }, { parent: 'outer' });

    const { rt, rollouts } = branchingRuntime();
    await search(rt, localMissionScope(governor, ['inner']), { budget: 8, branches: 2 });

    expect(governor.snapshot('outer')[0].exhausted).toBe(true);
    expect(rollouts()).toBeLessThan(6);
    ledger.db.close();
  });

  test('a branch that reports no usage meters nothing rather than a guess', async () => {
    const ledger = countingLedger();
    const governor = new MissionGovernor({ storage: { sql: ledger.sql, execRaw: ledger.execRaw }, actor: ledger.actor });
    governor.declare('mission', { tokens: 10_000_000 }, {});

    const { rt } = branchingRuntime();
    rt.spawnBranch = async () => ({ explore: async () => ({ text: 'an approach' }), generateReflection: async () => ({ text: 'no lesson' }), release: async () => {} });

    await search(rt, localMissionScope(governor, ['mission']));

    const snapshot = governor.snapshot('mission')[0];
    expect(snapshot.spent.tokens).toBe(0);
    expect(snapshot.calls).toBe(0);
    ledger.db.close();
  });

  test('a branch whose provider reported an EMPTY usage meters nothing either', async () => {
    // `normalizeUsage` of a silent provider is `{}`: no measurement, so no charge.
    const ledger = countingLedger();
    const governor = new MissionGovernor({ storage: { sql: ledger.sql, execRaw: ledger.execRaw }, actor: ledger.actor });
    governor.declare('mission', { tokens: 10_000_000 }, {});

    const { rt } = branchingRuntime();
    let explores = 0;
    rt.spawnBranch = countingBranch(() => { explores++; });

    await search(rt, localMissionScope(governor, ['mission']));

    // Non-vacuity: rollouts ran.
    expect(explores).toBeGreaterThan(0);
    const snapshot = governor.snapshot('mission')[0];
    expect(snapshot.spent.tokens).toBe(0);
    expect(snapshot.calls).toBe(0);
    ledger.db.close();
  });
});

describe('every rollout is reported, labelled or not', () => {
  const ROLLOUT_TOKENS = PER_ROLLOUT.input + PER_ROLLOUT.output;
  const REFLECTION_TOKENS = PER_REFLECTION.input + PER_REFLECTION.output;

  test('a search under NO mission reports every rollout and reflection as mcts spend', async () => {
    const reports: ModelCallReport[] = [];
    const { rt, rollouts, reflections } = branchingRuntime();

    await search(rt, null, { reportModelCall: (report) => reports.push(report) });

    // No ledger: the spend's only destination is the report sink.
    expect(rollouts()).toBe(6);
    expect(reflections()).toBeGreaterThan(0);
    expect(reports.length).toBe(rollouts() + reflections());
    expect(reports.every((r) => r.source === 'mcts')).toBe(true);
    expect(reports.filter((r) => usageTotal(r.usage) === ROLLOUT_TOKENS).length).toBe(rollouts());
    expect(reports.filter((r) => usageTotal(r.usage) === REFLECTION_TOKENS).length).toBe(reflections());
  });

  test('a branch whose provider reported nothing still reports the CALL, with an empty usage', async () => {
    // The cap declines an absent measurement; the ledger still counts the call, so silent differs from free.
    const ledger = countingLedger();
    const governor = new MissionGovernor({ storage: { sql: ledger.sql, execRaw: ledger.execRaw }, actor: ledger.actor });
    governor.declare('mission', { tokens: 10_000_000 }, {});

    const reports: ModelCallReport[] = [];
    const { rt } = branchingRuntime();
    let explores = 0;
    rt.spawnBranch = countingBranch(() => { explores++; });

    await search(rt, localMissionScope(governor, ['mission']), { reportModelCall: (r) => reports.push(r) });

    expect(explores).toBeGreaterThan(0);
    expect(reports.length).toBeGreaterThanOrEqual(explores);
    expect(reports.every((r) => r.source === 'mcts' && usageTotal(r.usage) === undefined)).toBe(true);
    expect(governor.snapshot('mission')[0].calls).toBe(0);
    ledger.db.close();
  });

  test('a branch that FAILED reports nothing — an absent usage there is a failure, not a silence', async () => {
    const reports: ModelCallReport[] = [];
    const { rt } = branchingRuntime();
    let reflections = 0;
    rt.spawnBranch = async () => ({ explore: async () => { throw new Error('branch down'); }, generateReflection: async () => {
      reflections++;

      return { text: 'it died', usage: PER_REFLECTION };
    }, release: async () => {} });

    await search(rt, null, { reportModelCall: (report) => reports.push(report) });

    // Reflections completed a call and are reported; explorations never happened.
    expect(reflections).toBeGreaterThan(0);
    expect(reports.length).toBe(reflections);
    expect(reports.every((r) => usageTotal(r.usage) === REFLECTION_TOKENS)).toBe(true);
  });
});
