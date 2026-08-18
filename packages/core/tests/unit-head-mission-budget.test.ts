/**
 * The mission governor reaching a head mid-flight.
 *
 * Head execution caps were removed outright: no wall clock, no token pool, no
 * step guard — a fork gets the parent turn's 500-step envelope. The mission
 * budget is therefore the ONLY remaining bound on a head's spend, and until now
 * it could not reach one: the ledger lives with the actor that declared it, a
 * cf head runs as a separate facet resolving its own model, and the governed
 * `LLM` the fork seam wraps never saw the calls the head actually made.
 * Coverage was refuse-to-spawn plus one lump debit after the whole fork
 * returned — which cannot stop anything.
 *
 * The half of this that matters most is the negative: a run that declared no
 * budget must never touch the table, never run a query, and never see a
 * refusal. The first describe below proves that against a real ledger by
 * counting every statement the head's runtime issues.
 */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { LanguageModel } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { DEFAULT_MAX_STEPS } from '../src/config';
import { DEFAULT_HEAD_BUDGET, type HeadInput } from '../src/heads/types';
import { runHeadInference, HeadCapture, buildHeadAccumulatorTools } from '../src/heads/head-inference';
import {
  MissionGovernor, localMissionScope, type MissionBudgetPort, type MissionScope,
} from '../src/mission-budget';
import type { SqlExecutor, SqlValue, RawSqlExec } from '../src/types/primitives';
import { usageTotal } from '../src/usage';
import { makeSql, makeExecRaw } from './helpers';

/** A model that keeps calling a tool so the agentic loop keeps stepping,
 *  reporting a fixed spend per step. */
function steppingModel(perStep: { input: number; output: number; stopAfter?: number }): LanguageModel {
  let step = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      const finishes = perStep.stopAfter !== undefined && step >= perStep.stopAfter;
      step++;
      return {
        content: finishes
          ? [{ type: 'text' as const, text: 'Done.' }]
          : [{
              type: 'tool-call' as const, toolCallId: `tc-${step}`, toolName: 'record_evidence',
              input: JSON.stringify({ kind: 'fact', body: 'working' }),
            }],
        finishReason: { unified: finishes ? 'stop' : 'tool-calls', raw: undefined },
        usage: {
          inputTokens: {
            total: perStep.input,
            noCache: perStep.input,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: perStep.output, text: perStep.output, reasoning: undefined },
        },
        response: { id: 'r', modelId: 'fake-budget', timestamp: new Date(0) },
        warnings: [],
      };
    },
  });
}

function headInput(missionLabels?: readonly string[]): HeadInput {
  const input: HeadInput = {
    id: 'h1', rootId: 'r1', parentId: null, depth: 0,
    task: 'do the work', rationale: 'exercise the ledger',
    mode: 'build',
    inheritedContext: [{ id: 'm1', role: 'user', content: 'go', createdAt: 1 }],
    budget: { ...DEFAULT_HEAD_BUDGET, spawnedAt: Date.now() },
    mergeStrategy: 'synthesize',
  };
  return missionLabels ? { ...input, missionLabels } : input;
}

async function runHead(mission: MissionScope | null, opts: { stopAfter?: number } = {}) {
  const capture = new HeadCapture();
  const deps: Parameters<typeof runHeadInference>[1] = {
    model: steppingModel({ input: 1_000, output: 200, ...opts }),
    tools: buildHeadAccumulatorTools(capture),
    capture,
    workspaceLayout: 'shared-workspace',
    maxSteps: DEFAULT_MAX_STEPS,
    isAborted: () => false,
  };
  if (mission) deps.mission = mission;
  const report = await runHeadInference(headInput(mission?.labels), deps);
  return { report, capture };
}

/** A ledger over real SQLite that counts every statement issued through it. */
function countingLedger() {
  const db = new Database(':memory:');
  const rawSql = makeSql(db);
  const rawExec = makeExecRaw(db);
  const statements: string[] = [];
  const sql: SqlExecutor = function executeSql<T = unknown>(
    strings: TemplateStringsArray,
    ...values: SqlValue[]
  ): T[] {
    statements.push(strings.join('?').replace(/\s+/g, ' ').trim());
    return rawSql<T>(strings, ...values);
  };
  const execRaw: RawSqlExec = (ddl, ...args) => {
    statements.push(ddl.replace(/\s+/g, ' ').trim());
    return rawExec(ddl, ...args);
  };
  return { db, sql, execRaw, statements };
}

describe('an undeclared run is never governed', () => {
  test('a head with no labels issues no ledger statement at all', async () => {
    const ledger = countingLedger();
    const governor = new MissionGovernor({ storage: { sql: ledger.sql, execRaw: ledger.execRaw } });
    // The constructor's own DDL is the only thing that may have run.
    const afterConstruction = ledger.statements.length;

    // This is the production shape: the runtime builds a scope from the head's
    // labels, and an empty set produces no scope, so no port is ever handed in.
    const scope = localMissionScope(governor, []);
    expect(scope).toBeNull();

    const { report } = await runHead(scope, { stopAfter: 4 });
    expect(report.status).toBe('completed');
    expect(usageTotal(report.usage)).toBe(1_200 * 5);
    // Not one query, not one write.
    expect(ledger.statements.slice(afterConstruction)).toEqual([]);
    expect(ledger.sql`SELECT COUNT(*) AS n FROM mission_budget`).toEqual([{ n: 0 }]);
    ledger.db.close();
  });

  test('a port handed an empty label set is inert even if something calls it', async () => {
    const ledger = countingLedger();
    const governor = new MissionGovernor({ storage: { sql: ledger.sql, execRaw: ledger.execRaw } });
    const afterConstruction = ledger.statements.length;

    expect(await governor.guard('model_call', [])).toBeNull();
    governor.debit(50_000, { labels: [], calls: 1 });

    expect(ledger.statements.slice(afterConstruction)).toEqual([]);
    ledger.db.close();
  });

  test('a head under a label with no LIMITS meters but never refuses', async () => {
    // A pure accounting scope: the operator wanted the number, not a cap.
    const ledger = countingLedger();
    const governor = new MissionGovernor({ storage: { sql: ledger.sql, execRaw: ledger.execRaw } });
    governor.declare('audit', {}, {});

    const { report } = await runHead(localMissionScope(governor, ['audit']), { stopAfter: 6 });
    expect(report.status).toBe('completed');
    const snap = governor.snapshot('audit')[0]!;
    expect(snap.spent.tokens).toBe(1_200 * 7);
    expect(snap.exhausted).toBe(false);
    ledger.db.close();
  });
});

describe('a declared budget reaches the head mid-flight', () => {
  test('spend is debited per step, not once at the end', async () => {
    const ledger = countingLedger();
    const governor = new MissionGovernor({ storage: { sql: ledger.sql, execRaw: ledger.execRaw } });
    governor.declare('mission', { tokens: 1_000_000 }, {});

    const seen: number[] = [];
    const port: MissionBudgetPort = {
      async guard(seam, labels) { return governor.guard(seam, labels); },
      async debit(tokens, opts) { seen.push(tokens); governor.debit(tokens, opts); },
    };
    await runHead({ labels: ['mission'], port }, { stopAfter: 3 });

    // One debit per step, each the provider's own report for that step.
    expect(seen).toEqual([1_200, 1_200, 1_200, 1_200]);
    expect(governor.snapshot('mission')[0]!.calls).toBe(4);
    ledger.db.close();
  });

  test('an exhausted budget stops the head mid-flight and says which budget', async () => {
    const ledger = countingLedger();
    const governor = new MissionGovernor({ storage: { sql: ledger.sql, execRaw: ledger.execRaw } });
    // Room for two steps' worth of spend, on a model that would otherwise run
    // for fifty.
    governor.declare('mission', { tokens: 2_500 }, {});

    const { report } = await runHead(localMissionScope(governor, ['mission']), { stopAfter: 50 });

    expect(report.status).toBe('budget_exceeded');
    expect(report.errorMessage).toContain('Mission budget "mission" is spent');
    // Stopped where the ledger ran out, nowhere near the 50 steps the model
    // was willing to take or the 500-step envelope it had.
    expect(report.stepCount).toBeLessThan(5);
    expect(governor.snapshot('mission')[0]!.exhausted).toBe(true);
    ledger.db.close();
  });

  test('a head spawned into an already-spent mission gets no free inference', async () => {
    const ledger = countingLedger();
    const governor = new MissionGovernor({ storage: { sql: ledger.sql, execRaw: ledger.execRaw } });
    governor.declare('mission', { tokens: 100 }, {});
    governor.debit(500, { labels: ['mission'], calls: 1 });

    const { report } = await runHead(localMissionScope(governor, ['mission']), { stopAfter: 50 });
    expect(report.status).toBe('budget_exceeded');
    expect(report.stepCount).toBe(0);
    // Nothing of its own was spent — the guard ran before the first call, so
    // NOTHING was reported. `{}` rather than zeros, and no scalar total: the
    // head may have been about to cost real money and never got the chance,
    // which is not the same claim as a head that ran and cost nothing.
    expect(report.usage).toEqual({});
    expect(usageTotal(report.usage)).toBeUndefined();
    ledger.db.close();
  });

  test('a stopped head reports what it banked, never its mid-flight thought', async () => {
    const ledger = countingLedger();
    const governor = new MissionGovernor({ storage: { sql: ledger.sql, execRaw: ledger.execRaw } });
    governor.declare('mission', { tokens: 2_500 }, {});

    const { report } = await runHead(localMissionScope(governor, ['mission']), { stopAfter: 50 });
    expect(report.summary).toContain('did not complete');
    expect(report.summary).toContain('Mission budget "mission" is spent');
    // The evidence it did record is still reported.
    expect(report.evidence.length).toBeGreaterThan(0);
    ledger.db.close();
  });

  test('exhaustion fires the run-event hook exactly once', async () => {
    const ledger = countingLedger();
    const exhausted: string[] = [];
    const governor = new MissionGovernor({
      storage: { sql: ledger.sql, execRaw: ledger.execRaw },
      onExhausted: (refusal) => { exhausted.push(refusal.label); },
    });
    governor.declare('mission', { tokens: 2_500 }, {});
    await runHead(localMissionScope(governor, ['mission']), { stopAfter: 50 });
    expect(exhausted).toEqual(['mission']);
    ledger.db.close();
  });

  test('a nested label debits its ancestors too, so the outer cap is real', async () => {
    const ledger = countingLedger();
    const governor = new MissionGovernor({ storage: { sql: ledger.sql, execRaw: ledger.execRaw } });
    governor.declare('outer', { tokens: 10_000 }, {});
    governor.declare('inner', { tokens: 1_000_000 }, { parent: 'outer' });

    await runHead(localMissionScope(governor, ['inner']), { stopAfter: 3 });
    expect(governor.snapshot('outer')[0]!.spent.tokens).toBe(1_200 * 4);
    ledger.db.close();
  });
});
