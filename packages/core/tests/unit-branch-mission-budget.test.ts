/**
 * The mission governor reaching an MCTS branch.
 *
 * A branch runs where the ledger is not — its own facet on cf, its own child
 * process on the CLI — and it resolves its own model there, so nothing the fork
 * seam wrapped around `rt.llm` ever saw a rollout. Coverage was one lump debit
 * of `StrategyResult.cost.tokens` at the fork seam, and the MCTS strategy never
 * set that field: a search's rollout spend was charged to no ledger at all.
 *
 * Enforcement lives at the EXPANSION, not inside the branch. A branch that
 * refused its own call would come back empty, score 0, and backpropagate that 0
 * up a tree that is persisted and resumable — a budget stop would permanently
 * distort the search it interrupted. So the engine guards before it opens the
 * next expansion, and debits each rollout from the report that travels back
 * with it.
 *
 * The half that matters most is still the negative: a search that declared no
 * budget must never touch the table, never run a query, and never see a
 * refusal. The first describe proves that by counting every statement the
 * ledger issues while a full search runs unbudgeted.
 *
 * That negative is also why the last describe exists. The mission port is a CAP
 * and it is a no-op without a label, so for an unlabelled search the rollout
 * usage the engine captures off the wire used to be captured and then dropped.
 * The report sink is the LEDGER, and it is asked unconditionally.
 */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createTestRuntime, createMockSession, makeSql, makeExecRaw } from './helpers';
import { runMCTS } from '../src/mcts/engine';
import { initSearchTables } from '../src/mcts/schemas';
import { initScaffoldTables } from '../src/scaffold/schemas';
import { initCraftScoreTables } from '../src/craft/schemas';
import {
  MissionGovernor, localMissionScope, type MissionScope,
} from '../src/mission-budget';
import type { LLM, SqlExecutor, RawSqlExec, SqlValue } from '../src/types/primitives';
import type { AgentRuntime } from '../src/types/agent-runtime';
import type { Usage } from '../src/usage';
import { usageTotal } from '../src/usage';
import type { ModelCallReport, ModelCallSink } from '../src/events/model-call';

/** A ledger over real SQLite that records every statement issued through it. */
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
  return { db, sql, execRaw, statements };
}

// `satisfies` rather than an annotation: every field of `Usage` is optional, so
// an annotated constant would make the arithmetic below reach through
// `number | undefined` and the test would have to assert its own fixtures.
const PER_ROLLOUT = { input: 800, output: 200 } satisfies Usage;
const PER_REFLECTION = { input: 300, output: 100 } satisfies Usage;

/** A search whose branches always propose something and always score low
 *  enough to reflect, each call reporting a fixed spend. */
function branchingRuntime() {
  const { rt } = createTestRuntime();
  // Score every branch below mcts.reflectionThreshold, so the reflect phase —
  // a second far-side model call per branch — actually runs.
  const judge: LLM = {
    async *stream() { yield '{"score": 0.1}'; },
    async complete() { return '{"score": 0.1}'; },
  };
  rt.llm = judge;
  rt.judgeModel = judge;
  let rollouts = 0;
  let reflections = 0;
  rt.spawnBranch = async () => ({
    explore: async () => {
      rollouts++;
      return { text: 'an approach', usage: PER_ROLLOUT };
    },
    generateReflection: async () => {
      reflections++;
      return { text: 'it did not work', usage: PER_REFLECTION };
    },
  });
  initSearchTables(rt.storage.execRaw, rt.storage.sql);
  initScaffoldTables(rt.storage.execRaw, rt.storage.sql);
  initCraftScoreTables(rt.storage.execRaw);
  return { rt, rollouts: () => rollouts, reflections: () => reflections };
}

async function search(
  rt: AgentRuntime,
  mission: MissionScope | null,
  budget = 3,
  branches = 2,
  reportModelCall?: ModelCallSink,
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
    const governor = new MissionGovernor({ storage: { sql: ledger.sql, execRaw: ledger.execRaw } });
    // A budget exists on this governor and is ALREADY spent. A search that
    // never declared it must be untouched by it.
    governor.declare('someone-elses-mission', { tokens: 10 }, {});
    governor.debit(5_000, { labels: ['someone-elses-mission'], calls: 1 });
    const afterSetup = ledger.statements.length;

    // The production shape: the scope is built from the labels the run
    // declared, and an empty set produces no scope, so the engine is handed
    // nothing to ask.
    const scope = localMissionScope(governor, []);
    expect(scope).toBeNull();

    const { rt, rollouts, reflections } = branchingRuntime();
    await search(rt, scope);

    // The search really ran — this is not a vacuous zero.
    expect(rollouts()).toBe(6);
    expect(reflections()).toBeGreaterThan(0);
    // Not one query, not one write.
    expect(ledger.statements.slice(afterSetup)).toEqual([]);
    // And the exhausted label did not move.
    expect(governor.snapshot('someone-elses-mission')[0]!.spent.tokens).toBe(5_000);
    ledger.db.close();
  });

  test('a search under a fresh governor leaves mission_budget empty', async () => {
    const ledger = countingLedger();
    const governor = new MissionGovernor({ storage: { sql: ledger.sql, execRaw: ledger.execRaw } });
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
    const governor = new MissionGovernor({ storage: { sql: ledger.sql, execRaw: ledger.execRaw } });
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
    const governor = new MissionGovernor({ storage: { sql: ledger.sql, execRaw: ledger.execRaw } });
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
    expect(governor.snapshot('mission')[0]!.calls).toBe(rollouts() + reflections());
    expect(governor.snapshot('mission')[0]!.spent.tokens)
      .toBe(rollouts() * rolloutTokens + reflections() * reflectionTokens);
    ledger.db.close();
  });

  test('an exhausted budget stops the search without recording a refused branch', async () => {
    const ledger = countingLedger();
    const governor = new MissionGovernor({ storage: { sql: ledger.sql, execRaw: ledger.execRaw } });
    // Room for roughly one expansion of a search asked for eight.
    governor.declare('mission', { tokens: 2_000 }, {});

    const { rt, rollouts } = branchingRuntime();
    await search(rt, localMissionScope(governor, ['mission']), 8, 2);

    expect(governor.snapshot('mission')[0]!.exhausted).toBe(true);
    // Stopped nowhere near the 16 rollouts the budget of 8 would have taken.
    expect(rollouts()).toBeLessThan(6);
    // Every node the tree kept came from a rollout that actually ran: a stop is
    // an absence of expansions, never an expansion full of empty proposals that
    // would backpropagate 0 through the persisted tree.
    const nodes = rt.storage.sql<{ observation: string; parent_id: string | null }>`
      SELECT observation, parent_id FROM search_nodes WHERE parent_id IS NOT NULL`;
    expect(nodes.length).toBe(rollouts());
    expect(nodes.every((n) => n.observation === 'an approach')).toBe(true);
    ledger.db.close();
  });

  test('a search opened under an already-spent mission spawns no branch at all', async () => {
    const ledger = countingLedger();
    const governor = new MissionGovernor({ storage: { sql: ledger.sql, execRaw: ledger.execRaw } });
    governor.declare('mission', { tokens: 100 }, {});
    governor.debit(500, { labels: ['mission'], calls: 1 });

    const { rt, rollouts, reflections } = branchingRuntime();
    let spawned = 0;
    const spawn = rt.spawnBranch;
    rt.spawnBranch = async (id) => { spawned++; return spawn(id); };

    await search(rt, localMissionScope(governor, ['mission']));

    expect(spawned).toBe(0);
    expect(rollouts()).toBe(0);
    expect(reflections()).toBe(0);
    // Nothing of its own was spent — the guard ran before the first expansion.
    expect(governor.snapshot('mission')[0]!.spent.tokens).toBe(500);
    ledger.db.close();
  });

  test('exhaustion fires the run-event hook exactly once', async () => {
    const ledger = countingLedger();
    const exhausted: string[] = [];
    const governor = new MissionGovernor({
      storage: { sql: ledger.sql, execRaw: ledger.execRaw },
      onExhausted: (refusal) => { exhausted.push(refusal.label); },
    });
    governor.declare('mission', { tokens: 2_000 }, {});

    const { rt } = branchingRuntime();
    await search(rt, localMissionScope(governor, ['mission']), 8, 2);

    expect(exhausted).toEqual(['mission']);
    ledger.db.close();
  });

  test('a nested label debits its ancestors, so an outer mission caps the search', async () => {
    const ledger = countingLedger();
    const governor = new MissionGovernor({ storage: { sql: ledger.sql, execRaw: ledger.execRaw } });
    governor.declare('outer', { tokens: 2_000 }, {});
    governor.declare('inner', { tokens: 10_000_000 }, { parent: 'outer' });

    const { rt, rollouts } = branchingRuntime();
    await search(rt, localMissionScope(governor, ['inner']), 8, 2);

    expect(governor.snapshot('outer')[0]!.exhausted).toBe(true);
    expect(rollouts()).toBeLessThan(6);
    ledger.db.close();
  });

  test('a branch that reports no usage meters nothing rather than a guess', async () => {
    const ledger = countingLedger();
    const governor = new MissionGovernor({ storage: { sql: ledger.sql, execRaw: ledger.execRaw } });
    governor.declare('mission', { tokens: 10_000_000 }, {});

    const { rt } = branchingRuntime();
    rt.spawnBranch = async () => ({
      explore: async () => ({ text: 'an approach' }),
      generateReflection: async () => ({ text: 'no lesson' }),
    });

    await search(rt, localMissionScope(governor, ['mission']));

    const snapshot = governor.snapshot('mission')[0]!;
    expect(snapshot.spent.tokens).toBe(0);
    expect(snapshot.calls).toBe(0);
    ledger.db.close();
  });

  test('a branch whose provider reported an EMPTY usage meters nothing either', async () => {
    // What both backends actually hand back now: `normalizeUsage` of a provider
    // that said nothing is `{}`, not undefined. A report with no field in it is
    // no measurement, so the engine must decline to charge it rather than
    // debiting the zero that `input + output` would have produced.
    const ledger = countingLedger();
    const governor = new MissionGovernor({ storage: { sql: ledger.sql, execRaw: ledger.execRaw } });
    governor.declare('mission', { tokens: 10_000_000 }, {});

    const { rt } = branchingRuntime();
    let explores = 0;
    rt.spawnBranch = async () => ({
      explore: async () => { explores++; return { text: 'an approach', usage: {} }; },
      generateReflection: async () => ({ text: 'no lesson', usage: {} }),
    });

    await search(rt, localMissionScope(governor, ['mission']));

    // Rollouts really ran, so the zero below is a decision and not a vacuum.
    expect(explores).toBeGreaterThan(0);
    const snapshot = governor.snapshot('mission')[0]!;
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

    await search(rt, null, 3, 2, (report) => reports.push(report));

    // The search really ran, and no ledger was involved — this is the exact
    // shape whose spend used to vanish.
    expect(rollouts()).toBe(6);
    expect(reflections()).toBeGreaterThan(0);
    expect(reports.length).toBe(rollouts() + reflections());
    expect(reports.every((r) => r.source === 'mcts')).toBe(true);
    expect(reports.filter((r) => usageTotal(r.usage) === ROLLOUT_TOKENS).length).toBe(rollouts());
    expect(reports.filter((r) => usageTotal(r.usage) === REFLECTION_TOKENS).length).toBe(reflections());
  });

  test('a branch whose provider reported nothing still reports the CALL, with an empty usage', async () => {
    // The distinction the two channels exist for: the cap declines to charge a
    // measurement it does not have, and the ledger still counts the call — so a
    // silent provider stays distinguishable from a free one.
    const ledger = countingLedger();
    const governor = new MissionGovernor({ storage: { sql: ledger.sql, execRaw: ledger.execRaw } });
    governor.declare('mission', { tokens: 10_000_000 }, {});

    const reports: ModelCallReport[] = [];
    const { rt } = branchingRuntime();
    let explores = 0;
    rt.spawnBranch = async () => ({
      explore: async () => { explores++; return { text: 'an approach', usage: {} }; },
      generateReflection: async () => ({ text: 'no lesson', usage: {} }),
    });

    await search(rt, localMissionScope(governor, ['mission']), 3, 2, (r) => reports.push(r));

    expect(explores).toBeGreaterThan(0);
    expect(reports.length).toBeGreaterThanOrEqual(explores);
    expect(reports.every((r) => r.source === 'mcts' && usageTotal(r.usage) === undefined)).toBe(true);
    // Same calls, and the ledger charged none of them.
    expect(governor.snapshot('mission')[0]!.calls).toBe(0);
    ledger.db.close();
  });

  test('a branch that FAILED reports nothing — an absent usage there is a failure, not a silence', async () => {
    const reports: ModelCallReport[] = [];
    const { rt } = branchingRuntime();
    let reflections = 0;
    rt.spawnBranch = async () => ({
      explore: async () => { throw new Error('branch down'); },
      generateReflection: async () => { reflections++; return { text: 'it died', usage: PER_REFLECTION }; },
    });

    await search(rt, null, 3, 2, (report) => reports.push(report));

    // The reflections on those dead branches DID complete a call and are
    // reported; the explorations never happened and are not.
    expect(reflections).toBeGreaterThan(0);
    expect(reports.length).toBe(reflections);
    expect(reports.every((r) => usageTotal(r.usage) === REFLECTION_TOKENS)).toBe(true);
  });
});
